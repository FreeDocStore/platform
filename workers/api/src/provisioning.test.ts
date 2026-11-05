import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import app from './index';
import type { Env, Session } from './types';
import { sealRepositorySecret } from './lib/repository-secrets';
import { deploymentKey, dispatchKey, deploymentStatus, dispatchDeployment, type DeploymentSetup } from './deployment';
import { credentialNames } from '../../../templates/publishing/workflow';
import { hostingKey, hostingVersionKey, hostingVersionPrefix, setupConnection } from './hosting';

const REPO = 'ExampleOrg/knowledge';
const ACCOUNT = 'a'.repeat(32);
const HEAD = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(40);
const TOKEN = 'test-cloudflare-credential-value';
const session: Session = { id: 'session-a', user: { id: 'user-a', login: 'owner', provider: 'github', name: 'Owner', avatarUrl: '', githubUrl: '' }, githubAccessToken: 'test-user-github-token', createdAt: '', updatedAt: '' };
const base64 = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));

function fixture(options: { private?: boolean; admin?: boolean; branch?: string; existingSecrets?: boolean; writeFailure?: boolean | number; deleteFailure?: boolean | number; workflowAtRef?: (ref: string) => string | null; branchHeads?: () => string[]; openPrHead?: string; account?: string; onSecretWrite?: (name: string, secrets: Map<string, string>) => void; sourceFailure?: number; cloudflareFailure?: number; projectBranch?: string; sourceFiles?: Record<string, string>; permissionsFailure?: boolean; privateApp?: boolean; publishedCommit?: string; publishedRepo?: string; head?: string; runConclusion?: string } = {}) {
  const values = new Map<string, string>();
  const secrets = new Map<string, string>(options.existingSecrets ? [['CLOUDFLARE_API_TOKEN', 'active-token'], ['CLOUDFLARE_ACCOUNT_ID', 'active-account']] : []);
  let secretWrites = 0;
  let secretDeletes = 0;
  const recipient = nacl.box.keyPair();
  const calls: Array<{ url: URL; method: string; body: any; auth: string | null }> = [];
  const files = new Map<string, { content: string; sha: string }>(Object.entries(options.sourceFiles ?? {
    'zensical.toml': '[project]\nsite_name = "Knowledge"\ndocs_dir = "docs"\nsite_dir = "site"\n',
    'docs/index.md': '# Existing customer content\n',
  }).map(([path, content]) => [path, { content, sha: SOURCE_SHA }]));
  const env = { EDITOR_BASE_URL: 'https://console.freedocstore.online', PUBLIC_BASE_URL: 'https://freedocstore.online', GITHUB_ORG: 'FreeDocStore', GH_APP_ID: '4278932', GH_APP_SLUG: 'freedocstore',
    FDS_API_KV: {
      get: vi.fn(async (key: string, format?: string) => {
        if (key === 'session:session-a') return session;
        if (key === 'session:session-b') return { ...session, id: 'session-b', user: { ...session.user, id: 'user-b' } };
        const value = values.get(key); return value === undefined ? null : format === 'json' ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      list: vi.fn(async ({ prefix, cursor = '' }: { prefix: string; cursor?: string }) => {
        const keys = [...values.keys()].filter(key => key.startsWith(prefix)).sort(); const offset = Number(cursor);
        return { keys: keys.slice(offset, offset + 100).map(name => ({ name })), list_complete: offset + 100 >= keys.length, cursor: String(offset + 100) };
      }),
      delete: vi.fn(async (key: string) => { values.delete(key); }),
    },
  } as unknown as Env;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, auth: new Headers(init?.headers).get('Authorization') });
    const path = url.pathname;
    if (url.hostname === 'api.cloudflare.com') {
      if (options.cloudflareFailure) return json({ success: false }, options.cloudflareFailure);
      if (path.endsWith('/accounts')) return json({ success: true, result: [{ id: options.account ?? ACCOUNT, name: 'Customer hosting' }] });
      if (path.includes('/pages/projects')) return json({ success: true, result: [{ name: 'customer-docs', production_branch: options.projectBranch ?? 'release', domains: [] }] });
    }
    if (url.hostname.endsWith('.pages.dev')) {
      if (method === 'HEAD') return new Response(null, { status: 200 });
      return json({ repo: options.publishedRepo ?? REPO, commit: options.publishedCommit ?? HEAD, project: 'customer-docs' });
    }
    if (url.hostname !== 'api.github.com') throw new Error(`Unexpected host ${url.hostname}`);
    if (path === '/repos/FreeDocStore/platform/contents/site/registry.json') return method === 'PUT' ? json({ content: { sha: 'registry-sha' } }) : json({ content: base64('{"knowledge_bases":[]}'), sha: 'registry-old' });
    if (path === '/apps/freedocstore') return options.privateApp ? json({}, 404) : json({ id: 4278932 });
    if (path === '/user/installations') return json({ installations: [{ id: 7, app_id: 4278932, app_slug: 'freedocstore', account: { login: 'ExampleOrg', type: 'Organization' }, permissions: { contents: 'write', actions: 'write', secrets: 'write', workflows: 'write' } }] });
    if (path === '/user/installations/7/repositories') return json({ repositories: [{ id: 100, full_name: REPO, name: 'knowledge', private: false, default_branch: 'release', permissions: { admin: true, push: true } }] });
    if (path === `/repos/${REPO}`) return json({ id: 100, full_name: REPO, name: 'knowledge', private: options.private ?? false, default_branch: options.branch ?? 'release', permissions: { admin: options.admin ?? true, push: true } });
    if (path.endsWith('/actions/secrets/public-key')) return json({ key: btoa(String.fromCharCode(...recipient.publicKey)), key_id: 'key-id' });
    if (path.endsWith('/actions/secrets')) return options.permissionsFailure ? json({}, 403) : json({ secrets: [...secrets.keys()].map(name => ({ name })) });
    if (path.includes('/actions/secrets/')) {
      const name = path.split('/').at(-1)!;
      if (method === 'DELETE') { secretDeletes++; if (options.deleteFailure === true || options.deleteFailure === secretDeletes) return json({}, 503); secrets.delete(name); return new Response(null, { status: 204 }); }
      secretWrites++;
      options.onSecretWrite?.(name, secrets);
      if (options.writeFailure === true || options.writeFailure === secretWrites) return json({}, 403);
      secrets.set(name, body.encrypted_value); return new Response(null, { status: 201 });
    }
    if (path.endsWith('/branches')) return json((options.branchHeads?.() ?? [HEAD]).map((sha, index) => ({ name: `branch-${index}`, commit: { sha } })));
    if (path.endsWith('/pulls') && method === 'GET') return json(options.openPrHead ? [{ number: 9, head: { sha: options.openPrHead } }] : []);
    if (path.includes('/git/ref/heads/')) return json({ object: { sha: options.head ?? HEAD } });
    if (path.endsWith('/actions/workflows/deploy.yml/enable')) return new Response(null, { status: 204 });
    if (path.includes('/git/commits/')) return json({ tree: { sha: 'base-tree' } });
    if (path.includes('/contents/')) {
      if (options.sourceFailure) return json({}, options.sourceFailure);
      const name = path.split('/contents/')[1];
      const workflow = options.workflowAtRef?.(url.searchParams.get('ref') ?? '');
      if (name === '.github/workflows') return json([...files.keys(), ...(workflow != null ? ['.github/workflows/check.yml'] : [])].filter(path => path.startsWith('.github/workflows/')).map(path => ({ type: 'file', path })));
      const file = name === '.github/workflows/check.yml' && workflow != null ? { content: workflow, sha: SOURCE_SHA } : files.get(name);
      return file ? json({ encoding: 'base64', content: base64(file.content), sha: file.sha, size: file.content.length }) : json({}, 404);
    }
    if (path.endsWith('/git/blobs')) return json({ sha: 'blob-sha' }, 201);
    if (path.endsWith('/git/trees')) return json({ sha: 'new-tree' }, 201);
    if (path.endsWith('/git/commits')) return json({ sha: HEAD, html_url: `https://github.com/${REPO}/commit/${HEAD}` }, 201);
    if (path.includes('/git/refs')) return json({ object: { sha: HEAD } }, 201);
    if (path.endsWith('/pulls')) return json({ number: 42, html_url: `https://github.com/${REPO}/pull/42` }, 201);
    if (path.endsWith('/pulls/42')) return json({ state: 'closed', merged: true, merge_commit_sha: HEAD });
    if (path.endsWith('/dispatches')) return new Response(null, { status: 204 });
    if (path.endsWith('/jobs')) return json({ jobs: [{ name: 'deploy', steps: [{ name: 'Ensure Cloudflare Pages project', conclusion: 'failure' }] }] });
    if (path.endsWith('/runs')) return json({ workflow_runs: [{ id: 100, status: 'completed', conclusion: options.runConclusion ?? 'success', head_sha: HEAD, created_at: new Date().toISOString(), html_url: `https://github.com/${REPO}/actions/runs/100` }] });
    throw new Error(`Unexpected request ${method} ${path}`);
  }));
  const request = (path: string, value?: unknown, cookie = 'session-a') => app.request(`https://api.freedocstore.online/api/provisioning/${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { Origin: 'https://console.freedocstore.online', Cookie: `fds_session=${cookie}`, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }, env);
  const connect = (confirmOverwrite = false) => request('connect', { repo: REPO, token: TOKEN, accountId: ACCOUNT, confirmOverwrite });
  return { values, files, env, calls, recipient, request, connect, secrets };
}

afterEach(() => vi.unstubAllGlobals());

describe('organization-owned setup', () => {
  it('discovers the current app and lists only repositories from an authorized installation', async () => {
    const f = fixture();
    const response = await f.request('installations');
    expect(response.status).toBe(200);
    expect((await response.json() as any).installUrl).toBe('https://github.com/apps/freedocstore/installations/new');
    expect((await f.request('repositories?installation=7')).status).toBe(200);
    expect((await f.request('repositories?installation=999')).status).toBe(403);
    expect(f.calls.some(call => call.url.pathname.includes('/999/'))).toBe(false);
  });
  it('refuses credentials for a private repository before contacting Cloudflare', async () => {
    const f = fixture({ private: true });
    expect((await f.connect()).status).toBe(403);
    expect(f.calls).toHaveLength(1);
  });
  it('allows a writable selected repository without repository administration or repo creation permission', async () => {
    const f = fixture({ admin: false });
    expect((await f.connect()).status).toBe(200);
    expect(f.calls.some(call => call.url.pathname === `/repos/${REPO}/actions/secrets/public-key`)).toBe(true);
  });
  it('seals credentials for the selected repository and stores metadata only', async () => {
    const f = fixture();
    expect((await f.connect()).status).toBe(200);
    const writes = f.calls.filter(call => call.method === 'PUT');
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.url.pathname).toMatch(new RegExp(`/repos/${REPO}/actions/secrets/`));
      expect(JSON.stringify(write.body)).not.toContain(TOKEN);
      const sealed = Uint8Array.from(atob(write.body.encrypted_value), c => c.charCodeAt(0));
      const ephemeral = sealed.subarray(0, 32); const nonceInput = new Uint8Array(64);
      nonceInput.set(ephemeral); nonceInput.set(f.recipient.publicKey, 32);
      const opened = nacl.box.open(sealed.subarray(32), blake2b(nonceInput, undefined, 24), ephemeral, f.recipient.secretKey);
      expect(new TextDecoder().decode(opened!)).toBe( /FDS_CF_TOKEN_[A-F0-9]{32}$/.test(write.url.pathname) ? TOKEN : ACCOUNT);
    }
    expect([...f.values.values()].join('')).not.toContain(TOKEN);
    expect(JSON.parse(f.values.get(hostingKey(REPO))!).status).toBe('ready');
    const versionWrites = (f.env.FDS_API_KV.put as any).mock.calls.filter(([key]: [string]) => key.startsWith(hostingVersionPrefix(REPO)));
    expect(versionWrites).toHaveLength(1);
  });
  it('stages credentials without overwriting the active legacy pair', async () => {
    const f = fixture({ existingSecrets: true });
    expect((await f.connect()).status).toBe(200);
    expect(f.secrets.get('CLOUDFLARE_API_TOKEN')).toBe('active-token');
    expect(f.secrets.get('CLOUDFLARE_ACCOUNT_ID')).toBe('active-account');
    expect(f.calls.filter(call => call.method === 'PUT').every(call => /FDS_CF_(TOKEN|ACCOUNT)_[A-F0-9]{32}$/.test(call.url.pathname))).toBe(true);
  });
  it('records incomplete secret writes as failed and blocks setup', async () => {
    const f = fixture({ writeFailure: true });
    expect((await f.connect()).status).toBe(403);
    expect(f.values.has(hostingKey(REPO))).toBe(false);
    expect([...f.values].filter(([key]) => key.startsWith(hostingVersionPrefix(REPO))).map(([, value]) => JSON.parse(value).status)).toEqual(['failed']);
    expect((await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).status).toBe(409);
  });
  it('distinguishes a Cloudflare outage from invalid credentials', async () => {
    const f = fixture({ cloudflareFailure: 503 });
    const response = await f.connect();
    expect(response.status).toBe(503);
    expect((await response.json() as any).error).toContain('temporarily unavailable');
    expect(f.calls.some(call => call.method === 'PUT')).toBe(false);
  });
  it('reviews the actual default branch and preserves all existing content', async () => {
    const f = fixture(); await f.connect();
    const response = await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true });
    expect(response.status).toBe(200);
    const plan = await response.json() as any;
    expect(plan.branch).toBe('release'); expect(plan.url).toBe('https://customer-docs.pages.dev/');
    expect(plan.files.map((file: any) => file.path)).toEqual(['.github/workflows/deploy.yml']);
    expect(plan.workflow).toContain('branches: ["release"]');
    expect(plan.workflow).not.toContain('freedocstore.online');
    expect((await f.request('apply', { planId: plan.planId, mode: 'pr' })).status).toBe(200);
    const tree = f.calls.find(call => call.url.pathname.endsWith('/git/trees'))!;
    expect(tree.body.tree.map((item: any) => item.path)).toEqual(['.github/workflows/deploy.yml']);
  });
  it.each(['pr', 'direct'] as const)('attaches reviewed draft files with current source SHAs for %s apply', async mode => {
    const f = fixture({ sourceFiles: { 'docs/index.md': '# Existing customer content\n' } }); await f.connect();
    const draft = [{ path: 'docs/index.md', content: '# Reviewed draft\n' }, { path: 'docs/guide.md', content: '# Guide\n' }];
    const response = await f.request('plan', { repo: REPO, project: 'customer-docs', title: 'Customer KB', confirmUseProject: true, draftFiles: draft });
    expect(response.status).toBe(200);
    const plan = await response.json() as any;
    expect(plan.files.map((file: any) => [file.path, file.expectedSha])).toEqual(expect.arrayContaining([['docs/index.md', SOURCE_SHA], ['docs/guide.md', null]]));
    expect(plan.files.find((file: any) => file.path === 'zensical.toml').content).toContain('Customer KB');
    expect((await f.request('apply', { planId: plan.planId, mode, confirmDraftContent: true })).status).toBe(200);
    const tree = f.calls.find(call => call.url.pathname.endsWith('/git/trees'))!;
    expect(tree.body.tree.map((item: any) => item.path)).toEqual(['.github/workflows/deploy.yml', 'zensical.toml', 'docs/index.md', 'docs/guide.md']);
    const contentChecks = f.calls.filter(call => call.url.pathname.includes('/contents/') && call.url.searchParams.get('ref') === HEAD);
    expect(contentChecks.some(call => call.url.pathname.endsWith('/docs/index.md'))).toBe(true);
  });
  it('requires explicit draft content confirmation and validates draft paths', async () => {
    const f = fixture(); await f.connect();
    const plan = await (await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true, draftFiles: [{ path: 'docs/index.md', content: '# Replacement' }] })).json() as any;
    expect((await f.request('apply', { planId: plan.planId, mode: 'pr' })).status).toBe(409);
    expect((await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true, draftFiles: [{ path: '../oops.md', content: 'x' }] })).status).toBe(400);
  });
  it('blocks registration until deployment verification is live, then registers', async () => {
    const before = fixture({ publishedCommit: 'c'.repeat(40) }); await before.connect();
    const plan = await (await before.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).json() as any;
    await before.request('apply', { planId: plan.planId, mode: 'direct' });
    expect((await before.request('register', { repo: REPO })).status).toBe(409);

    const live = fixture(); await live.connect();
    const livePlan = await (await live.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).json() as any;
    await live.request('apply', { planId: livePlan.planId, mode: 'direct' });
    const registered = await live.request('register', { repo: REPO });
    expect(registered.status).toBe(200);
    const result = await registered.json() as any;
    expect(result.state).toBe('live');
    expect(result.registryKbId).toBeTruthy();
  });
  it('scaffolds absent source/configuration only and requires a new-project decision', async () => {
    const f = fixture({ sourceFiles: {} }); await f.connect();
    expect((await f.request('plan', { repo: REPO, project: 'new-docs' })).status).toBe(409);
    const response = await f.request('plan', { repo: REPO, project: 'new-docs', confirmCreateProject: true });
    const plan = await response.json() as any;
    expect(plan.files).toHaveLength(3);
    expect(plan.files.find((file: any) => file.path === 'zensical.toml').content).toContain('[project]');
  });
  it('requires a separate acknowledgement to replace an existing deployment workflow', async () => {
    const f = fixture(); f.files.set('.github/workflows/deploy.yml', { content: 'name: Customer pipeline', sha: SOURCE_SHA }); await f.connect();
    const plan = await (await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).json() as any;
    expect(plan.replacesWorkflow).toBe(true);
    expect((await f.request('apply', { planId: plan.planId, mode: 'direct' })).status).toBe(409);
    expect(f.calls.some(call => call.url.pathname.endsWith('/git/blobs'))).toBe(false);
  });
  it('rejects plans from another session, changed files and changed hosting connections', async () => {
    const f = fixture(); await f.connect();
    const plan = await (await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).json() as any;
    expect((await f.request('apply', { planId: plan.planId, mode: 'pr' }, 'session-b')).status).toBe(409);
    f.files.set('.github/workflows/deploy.yml', { content: 'name: New customer workflow', sha: SOURCE_SHA });
    expect((await f.request('apply', { planId: plan.planId, mode: 'direct' })).status).toBe(409);
    expect(f.calls.some(call => call.url.pathname.endsWith('/git/blobs'))).toBe(false);
    f.values.set(hostingKey(REPO), JSON.stringify({ accountId: 'other-account', status: 'ready' }));
    expect((await f.request('apply', { planId: plan.planId, mode: 'pr' })).status).toBe(409);
  });
  it('refuses a project using a different production branch', async () => {
    const f = fixture({ projectBranch: 'main' }); await f.connect();
    expect((await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).status).toBe(409);
  });
  it.each(['[project]\ndocs_dir="other"', '[project]\nsite_dir="docs"', 'site_name="legacy"', '[project\ninvalid'])('does not overwrite unsupported configuration %s', async content => {
    const f = fixture({ sourceFiles: { 'zensical.toml': content } }); await f.connect();
    expect((await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).status).toBe(422);
  });
  it('requires authentication and rejects malformed request shapes', async () => {
    const f = fixture();
    expect((await f.request('connect', {}, 'missing')).status).toBe(401);
    expect((await f.request('connect', null)).status).toBe(400);
    expect((await f.request('connect', { repo: 42 })).status).toBe(400);
  });
});

it('rejects invalid repository encryption keys', () => {
  expect(() => sealRepositorySecret('test', btoa('short'))).toThrow('invalid repository encryption key');
});

it('verifies the exact public source version after a merged setup PR', async () => {
  const f = fixture();
  const setup: DeploymentSetup = { repo: REPO, branch: 'release', project: 'customer-docs', domain: '', accountId: ACCOUNT, workflow: '', updatedAt: new Date().toISOString(), prNumber: 42, prUrl: `https://github.com/${REPO}/pull/42` };
  const status = await deploymentStatus(f.env, session.githubAccessToken!, setup);
  expect(status.state).toBe('live');
  expect(status.pagesReady).toBe(true);
  expect(f.values.has(deploymentKey(REPO))).toBe(false);
  expect(f.calls.filter(call => call.url.hostname.endsWith('.pages.dev')).every(call => call.auth === null)).toBe(true);
});


const setup = (): DeploymentSetup => ({ repo: REPO, repoFullName: REPO, repoId: 100, installationId: 7, branch: 'release', project: 'customer-docs', domain: '', accountId: ACCOUNT, workflow: 'name: Reviewed deployment', updatedAt: new Date().toISOString(), expectedSha: HEAD, status: 'active' });

it('explains unavailable public app installations while keeping existing configuration links', async () => {
  const f = fixture({ privateApp: true });
  const result = await (await f.request('installations')).json() as any;
  expect(result.installUrl).toBeNull();
  expect(result.installationWarning).toContain('not yet available');
  expect(result.installations[0].configureUrl).toBe('https://github.com/organizations/ExampleOrg/settings/installations/7');
});

it('requires explicit reuse of an existing Pages project and confirmation when moving a previous setup', async () => {
  const f = fixture(); await f.connect();
  expect((await f.request('plan', { repo: REPO, project: 'customer-docs' })).status).toBe(409);
  f.values.set(deploymentKey(REPO), JSON.stringify({ ...setup(), project: 'previous-project' }));
  expect((await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).status).toBe(409);
  expect((await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true, confirmRepoint: true })).status).toBe(200);
});

it.each([{ publishedCommit: 'stale' }, { publishedRepo: 'SomeoneElse/docs' }])('does not accept a successful build serving the wrong public identity %j', async options => {
  const f = fixture(options);
  const status = await deploymentStatus(f.env, session.githubAccessToken!, setup());
  expect(status.state).toBe('verifying');
  expect(status.pagesReady).toBe(false);
});

it('tracks the current default-branch head instead of reporting an old deployment as current', async () => {
  const f = fixture({ head: 'c'.repeat(40) });
  const status = await deploymentStatus(f.env, session.githubAccessToken!, setup());
  expect(status.state).toBe('waiting');
  expect(f.calls.some(call => call.url.hostname.endsWith('.pages.dev'))).toBe(false);
});

it('reports failed job steps without fetching potentially sensitive log bodies', async () => {
  const f = fixture({ runConclusion: 'failure' });
  const status = await deploymentStatus(f.env, session.githubAccessToken!, setup());
  expect(status.state).toBe('failed');
  expect(status.failedSteps).toEqual(['deploy: Ensure Cloudflare Pages project']);
  expect(f.calls.some(call => call.url.pathname.endsWith('/logs'))).toBe(false);
});

it('dispatches only the reviewed workflow on the actual default branch', async () => {
  const f = fixture(); const target = setup();
  await expect(dispatchDeployment(f.env, session.githubAccessToken!, target)).rejects.toThrow('reviewed workflow');
  expect(f.calls.some(call => call.method === 'POST')).toBe(false);
  f.files.set('.github/workflows/deploy.yml', { content: target.workflow, sha: SOURCE_SHA });
  await dispatchDeployment(f.env, session.githubAccessToken!, target);
  expect(f.calls.find(call => call.url.pathname.endsWith('/dispatches'))?.body).toEqual({ ref: 'release' });
  expect(JSON.parse(f.values.get(dispatchKey(target))!).expectedSha).toBe(HEAD);
  expect(f.values.has(deploymentKey(REPO))).toBe(false);
});


it('does not silently migrate an existing source engine when Zensical configuration is absent', async () => {
  const f = fixture({ sourceFiles: { 'mkdocs.yml': 'site_name: Existing knowledge' } }); await f.connect();
  const response = await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true });
  expect(response.status).toBe(422);
  expect((await response.json() as any).error).toContain('existing MkDocs configuration');
  expect(f.calls.some(call => call.url.pathname.endsWith('/git/blobs'))).toBe(false);
});


it('resumes a configured project missing from the older account inventory without reconnecting credentials', async () => {
  const f = fixture(); await f.connect();
  const connection = JSON.parse(f.values.get(hostingKey(REPO))!); connection.projects = [];
  f.values.set(hostingKey(REPO), JSON.stringify(connection));
  f.values.set(deploymentKey(REPO), JSON.stringify(setup()));
  const before = f.calls.filter(call => call.url.hostname === 'api.cloudflare.com').length;
  const result = await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true });
  expect(result.status).toBe(200);
  expect(f.calls.filter(call => call.url.hostname === 'api.cloudflare.com')).toHaveLength(before);
});

it('does not infer that a previous account project exists in another Cloudflare account', async () => {
  const f = fixture(); await f.connect();
  const connection = JSON.parse(f.values.get(hostingKey(REPO))!); connection.projects = [];
  f.values.set(hostingKey(REPO), JSON.stringify(connection));
  f.values.set(deploymentKey(REPO), JSON.stringify({ ...setup(), accountId: 'different-account' }));
  expect((await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true, confirmRepoint: true })).status).toBe(409);
});

it('a merged-PR status read cannot overwrite a newer setup record', async () => {
  const f = fixture();
  const newer = { ...setup(), project: 'new-project', revision: 'newer' };
  f.values.set(deploymentKey(REPO), JSON.stringify(newer));
  await deploymentStatus(f.env, session.githubAccessToken!, { ...setup(), prNumber: 42 });
  expect(JSON.parse(f.values.get(deploymentKey(REPO))!)).toEqual(newer);
});

it('an older deployment retry cannot overwrite a newer setup record', async () => {
  const f = fixture(); const older = { ...setup(), revision: 'older' };
  const newer = { ...setup(), project: 'new-project', revision: 'newer' };
  f.values.set(deploymentKey(REPO), JSON.stringify(newer));
  f.files.set('.github/workflows/deploy.yml', { content: older.workflow, sha: SOURCE_SHA });
  await dispatchDeployment(f.env, session.githubAccessToken!, older);
  expect(JSON.parse(f.values.get(deploymentKey(REPO))!)).toEqual(newer);
  expect(f.values.has(dispatchKey(newer))).toBe(false);
});

it('requires PR merge even if the reviewed workflow is already on the default branch', async () => {
  const f = fixture(); const target = { ...setup(), prNumber: 42 };
  f.files.set('.github/workflows/deploy.yml', { content: target.workflow, sha: SOURCE_SHA });
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => String(input).endsWith('/pulls/42') ? new Response(JSON.stringify({ state: 'open', merged: false })) : original(input, init));
  await expect(dispatchDeployment(f.env, session.githubAccessToken!, target)).rejects.toThrow('Merge the setup pull request');
  expect(f.calls.some(call => call.url.pathname.endsWith('/dispatches'))).toBe(false);
});

it('does not report live if the source advances while the public site is being checked', async () => {
  const options: { head?: string } = {}; const f = fixture(options); const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const response = await original(input, init);
    if (new URL(String(input)).hostname.endsWith('.pages.dev') && init?.method === 'HEAD') options.head = 'c'.repeat(40);
    return response;
  });
  const result = await deploymentStatus(f.env, session.githubAccessToken!, setup());
  expect(result.state).toBe('verifying');
  expect(result.message).toContain('source changed during verification');
});

it('returns a browser-readable cooldown for provider rate limiting', async () => {
  const f = fixture();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'x-ratelimit-remaining': '0', 'Retry-After': '120' } })));
  const response = await f.request('installations');
  expect(response.status).toBe(503); expect(response.headers.get('Retry-After')).toBe('120');
  const data = await response.json() as any;
  expect(data.retryAfterSeconds).toBe(120); expect(data.error).toContain('request limit');
});

it('preserves a Cloudflare cooldown without writing credentials', async () => {
  const f = fixture({ cloudflareFailure: 429 });
  const response = await f.connect();
  expect(response.status).toBe(503);
  expect((await response.json() as any).retryAfterSeconds).toBe(60);
  expect(f.calls.some(call => call.method === 'PUT')).toBe(false);
});

describe('reviewed credential activation', () => {
  it.each([1, 2])('keeps active credentials and metadata intact when write %i fails, including a concurrent source push', async failedWrite => {
    const active = { repo: REPO, accountId: ACCOUNT, accountName: 'Active hosting', status: 'ready', projects: [], updatedAt: 'previous' };
    const options = { existingSecrets: true, writeFailure: failedWrite, onSecretWrite: (_name: string, secrets: Map<string, string>) => {
      // A push-triggered legacy workflow resolves its existing names between writes.
      expect(secrets.get('CLOUDFLARE_API_TOKEN')).toBe('active-token');
      expect(secrets.get('CLOUDFLARE_ACCOUNT_ID')).toBe('active-account');
    } };
    const f = fixture(options); f.values.set(hostingKey(REPO), JSON.stringify(active));
    expect((await f.connect()).status).toBe(403);
    expect(JSON.parse(f.values.get(hostingKey(REPO))!)).toEqual(active);
    expect(await setupConnection(f.env, setup())).toBeNull();
    const result = await (await f.request(`staging?repo=${REPO}`)).json() as any;
    expect(result.versions).toHaveLength(1); expect(result.versions[0].status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('binds an immutable pair to review, rejects a superseded plan and preserves the old account for retry', async () => {
    const options = { account: ACCOUNT }; const f = fixture(options);
    await f.connect();
    const first = JSON.parse(f.values.get(hostingKey(REPO))!);
    const plan = await (await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).json() as any;
    expect(plan.credentialVersion).toBe(first.version);
    expect(plan.workflow).toContain(`secrets.${credentialNames(first.version).token}`);
    expect(plan.workflow).not.toContain('secrets.CLOUDFLARE_');
    const priorSecrets = new Map(f.secrets);
    const target = { ...setup(), workflow: plan.workflow, credentialVersion: first.version };
    f.values.set(deploymentKey(REPO), JSON.stringify(target));
    f.files.set('.github/workflows/deploy.yml', { content: plan.workflow, sha: SOURCE_SHA });
    options.account = 'c'.repeat(32);
    expect((await f.request('connect', { repo: REPO, token: TOKEN, accountId: options.account })).status).toBe(200);
    const second = JSON.parse(f.values.get(hostingKey(REPO))!);
    expect(second.version).not.toBe(first.version);
    for (const [name, encrypted] of priorSecrets) expect(f.secrets.get(name)).toBe(encrypted);
    expect(await setupConnection(f.env, target)).toEqual(first);
    expect((await f.request('deploy', { repo: REPO })).status).toBe(200);
    expect((await f.request('apply', { planId: plan.planId, mode: 'direct', confirmReplaceWorkflow: true })).status).toBe(409);
    const moved = await (await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true, confirmRepoint: true })).json() as any;
    expect(moved.credentialVersion).toBe(second.version);
    expect((await f.request('apply', { planId: moved.planId, mode: 'direct', confirmReplaceWorkflow: true })).status).toBe(200);
    expect(JSON.parse(f.values.get(deploymentKey(REPO))!).credentialVersion).toBe(second.version);
  });

  it('does not reuse name-only legacy credentials for a stable repository identity', async () => {
    const f = fixture({ account: 'c'.repeat(32), existingSecrets: true });
    const legacy = { repo: REPO, accountId: ACCOUNT, accountName: 'Original account', status: 'ready', projects: [], updatedAt: 'previous' };
    f.values.set(hostingKey(REPO), JSON.stringify(legacy));
    f.values.set(deploymentKey(REPO), JSON.stringify(setup()));
    expect((await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).status).toBe(409);
    await f.request('connect', { repo: REPO, token: TOKEN, accountId: 'c'.repeat(32) });
    expect(await setupConnection(f.env, setup())).toBeNull();
    f.files.set('.github/workflows/deploy.yml', { content: setup().workflow, sha: SOURCE_SHA });
    expect((await f.request('deploy', { repo: REPO })).status).toBe(409);
  });
});

describe('failed staging cleanup', () => {
  const version = 'D'.repeat(32);
  function failed(f: ReturnType<typeof fixture>) {
    f.values.set(hostingVersionKey(REPO, version), JSON.stringify({ repo: REPO, version, accountId: ACCOUNT, accountName: 'Failed account', status: 'failed', projects: [], updatedAt: new Date().toISOString() }));
    const names = credentialNames(version);
    f.secrets.set(names.account, 'encrypted-account'); f.secrets.set(names.token, 'encrypted-token');
    return names;
  }
  const cleanup = (f: ReturnType<typeof fixture>) => f.request('cleanup', { repo: REPO, version, confirm: true });

  it('requires confirmation and removes only the selected failed pair; repeated removal is blocked', async () => {
    const f = fixture({ existingSecrets: true }); const names = failed(f);
    expect((await f.request('cleanup', { repo: REPO, version })).status).toBe(409);
    expect((await cleanup(f)).status).toBe(200);
    expect(f.calls.filter(call => call.method === 'DELETE').map(call => call.url.pathname.split('/').at(-1))).toEqual([names.token, names.account]);
    expect(f.secrets.get('CLOUDFLARE_API_TOKEN')).toBe('active-token');
    expect(f.values.has(`hosting-removed:${REPO.toLowerCase()}:${version}`)).toBe(true);
    expect((await (await f.request(`staging?repo=${REPO}`)).json() as any).versions).toEqual([]);
    expect((await cleanup(f)).status).toBe(409);
  });

  it.each(['ready', 'connecting', 'removed'])('never deletes a %s version', async status => {
    const f = fixture(); failed(f);
    const key = hostingVersionKey(REPO, version); f.values.set(key, JSON.stringify({ ...JSON.parse(f.values.get(key)!), status }));
    expect((await cleanup(f)).status).toBe(409);
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
  });

  it.each(['branch', 'fork PR', 'dynamic access', 'inherited secrets', 'lowercase names', 'escaped names', 'invalid YAML'])('refuses cleanup when %s may need credentials', async scenario => {
    const fork = 'f'.repeat(40);
    const workflow = scenario === 'dynamic access' ? 'env: ${{ secrets[inputs.key] }}' : scenario === 'inherited secrets' ? 'secrets: inherit' : 'env: ${{ secrets.' + credentialNames(version).token + ' }}';
    const content = scenario === 'lowercase names' ? workflow.toLowerCase() : scenario === 'escaped names' ? 'env: "' + credentialNames(version).token.replace('FDS', '\\x46DS') + '"' : scenario === 'invalid YAML' ? 'jobs: [invalid' : workflow;
    const f = fixture({ openPrHead: scenario === 'fork PR' ? fork : undefined, workflowAtRef: ref => scenario !== 'fork PR' || ref === fork ? content : null }); failed(f);
    expect((await cleanup(f)).status).toBe(409);
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
  });

  it('stops if refs change or the branch inventory is too large', async () => {
    let checks = 0;
    const f = fixture({ branchHeads: () => [++checks === 1 ? HEAD : 'c'.repeat(40)] }); failed(f);
    expect((await cleanup(f)).status).toBe(409);
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
    const large = fixture({ branchHeads: () => Array(100).fill(HEAD) }); failed(large);
    expect((await cleanup(large)).status).toBe(409);
    expect(large.calls.some(call => call.method === 'DELETE')).toBe(false);
  });

  it('supports retry after deletion fails without marking the version removed', async () => {
    const options: { deleteFailure: boolean | number } = { deleteFailure: 2 }; const f = fixture(options); const names = failed(f);
    expect((await cleanup(f)).status).toBe(503);
    expect(JSON.parse(f.values.get(hostingVersionKey(REPO, version))!).status).toBe('failed');
    expect(f.secrets.has(names.token)).toBe(false); expect(f.secrets.has(names.account)).toBe(true);
    options.deleteFailure = false;
    expect((await cleanup(f)).status).toBe(200);
  });

  it('requires current repository administrator access and a session before inspecting or deleting', async () => {
    const f = fixture({ admin: false }); failed(f);
    expect((await cleanup(f)).status).toBe(403);
    expect((await f.request(`staging?repo=${REPO}`)).status).toBe(403);
    expect((await f.request('cleanup', { repo: REPO, version, confirm: true }, 'missing')).status).toBe(401);
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
  });
});

it('isolates two administrators staging concurrently and rejects the superseded review', async () => {
  const f = fixture({ existingSecrets: true }); const original = globalThis.fetch;
  let release!: () => void; let blocked!: () => void; let paused = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { blocked = resolve; });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const response = await original(input, init);
    if (init?.method === 'PUT' && !paused) { paused = true; blocked(); await barrier; }
    return response;
  });
  const earlier = f.connect(); await entered;
  try {
    expect((await f.connect()).status).toBe(200);
    const reviewed = await (await f.request('plan', { repo: REPO, project: 'customer-docs', confirmUseProject: true })).json() as any;
    release(); expect((await earlier).status).toBe(200);
    expect((await f.request('apply', { planId: reviewed.planId, mode: 'pr' })).status).toBe(409);
    const writes = f.calls.filter(call => call.method === 'PUT');
    expect(new Set(writes.map(call => call.url.pathname)).size).toBe(4);
    expect(f.secrets.get('CLOUDFLARE_API_TOKEN')).toBe('active-token');
    const versions = [...f.values].filter(([key]) => key.startsWith(hostingVersionPrefix(REPO))).map(([, value]) => JSON.parse(value));
    expect(versions).toHaveLength(2); expect(versions.every(version => version.status === 'ready')).toBe(true);
    expect(versions.some(version => version.version === reviewed.credentialVersion)).toBe(true);
  } finally { release(); await earlier; }
});

it('paginates failed attempts without offering ready or removed versions', async () => {
  const f = fixture();
  for (let index = 0; index < 102; index++) {
    const version = index.toString(16).toUpperCase().padStart(32, '0');
    f.values.set(hostingVersionKey(REPO, version), JSON.stringify({ repo: REPO, version, status: index === 0 ? 'ready' : 'failed', updatedAt: '2026-11-05T00:00:00Z' }));
    if (index === 1) f.values.set(`hosting-removed:${REPO.toLowerCase()}:${version}`, 'removed');
  }
  const first = await (await f.request(`staging?repo=${REPO}`)).json() as any;
  expect(first.versions).toHaveLength(98); expect(first.cursor).toBe('100');
  const next = await (await f.request(`staging?repo=${REPO}&cursor=${first.cursor}`)).json() as any;
  expect(next.versions).toHaveLength(2); expect(next.cursor).toBeNull();
});

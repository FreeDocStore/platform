import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import app from './index';
import type { Env, Session } from './types';
import { sealRepositorySecret } from './lib/repository-secrets';
import { deploymentKey, dispatchKey, deploymentStatus, dispatchDeployment, type DeploymentSetup } from './deployment';
import { hostingKey } from './hosting';

const REPO = 'ExampleOrg/knowledge';
const ACCOUNT = 'a'.repeat(32);
const HEAD = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(40);
const TOKEN = 'test-cloudflare-credential-value';
const session: Session = { id: 'session-a', user: { id: 'user-a', login: 'owner', provider: 'github', name: 'Owner', avatarUrl: '', githubUrl: '' }, githubAccessToken: 'test-user-github-token', createdAt: '', updatedAt: '' };
const base64 = (value: string) => btoa(String.fromCharCode(...new TextEncoder().encode(value)));

function fixture(options: { private?: boolean; admin?: boolean; branch?: string; existingSecrets?: boolean; writeFailure?: boolean; sourceFailure?: number; cloudflareFailure?: number; projectBranch?: string; sourceFiles?: Record<string, string>; permissionsFailure?: boolean; privateApp?: boolean; publishedCommit?: string; publishedRepo?: string; head?: string; runConclusion?: string } = {}) {
  const values = new Map<string, string>();
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
      if (path.endsWith('/accounts')) return json({ success: true, result: [{ id: ACCOUNT, name: 'Customer hosting' }] });
      if (path.includes('/pages/projects')) return json({ success: true, result: [{ name: 'customer-docs', production_branch: options.projectBranch ?? 'release', domains: [] }] });
    }
    if (url.hostname.endsWith('.pages.dev')) {
      if (method === 'HEAD') return new Response(null, { status: 200 });
      return json({ repo: options.publishedRepo ?? REPO, commit: options.publishedCommit ?? HEAD, project: 'customer-docs' });
    }
    if (url.hostname !== 'api.github.com') throw new Error(`Unexpected host ${url.hostname}`);
    if (path === '/apps/freedocstore') return options.privateApp ? json({}, 404) : json({ id: 4278932 });
    if (path === '/user/installations') return json({ installations: [{ id: 7, app_id: 4278932, app_slug: 'freedocstore', account: { login: 'ExampleOrg', type: 'Organization' }, permissions: { contents: 'write', actions: 'write', secrets: 'write', workflows: 'write' } }] });
    if (path === '/user/installations/7/repositories') return json({ repositories: [{ full_name: REPO, name: 'knowledge', private: false, default_branch: 'release', permissions: { admin: true, push: true } }] });
    if (path === `/repos/${REPO}`) return json({ full_name: REPO, name: 'knowledge', private: options.private ?? false, default_branch: options.branch ?? 'release', permissions: { admin: options.admin ?? true, push: true } });
    if (path.endsWith('/actions/secrets/public-key')) return json({ key: btoa(String.fromCharCode(...recipient.publicKey)), key_id: 'key-id' });
    if (path.endsWith('/actions/secrets')) return options.permissionsFailure ? json({}, 403) : json({ secrets: options.existingSecrets ? [{ name: 'CLOUDFLARE_API_TOKEN' }] : [] });
    if (path.includes('/actions/secrets/')) return options.writeFailure ? json({}, 403) : new Response(null, { status: 201 });
    if (path.includes('/git/ref/heads/')) return json({ object: { sha: options.head ?? HEAD } });
    if (path.includes('/git/commits/')) return json({ tree: { sha: 'base-tree' } });
    if (path.includes('/contents/')) {
      if (options.sourceFailure) return json({}, options.sourceFailure);
      const name = path.split('/contents/')[1]; const file = files.get(name);
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
  return { values, files, env, calls, recipient, request, connect };
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
  it.each([{ private: true }, { admin: false }])('refuses credentials for an ineligible repository %j before contacting Cloudflare', async options => {
    const f = fixture(options);
    expect((await f.connect()).status).toBe(403);
    expect(f.calls).toHaveLength(1);
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
      expect(new TextDecoder().decode(opened!)).toBe(write.url.pathname.endsWith('CLOUDFLARE_API_TOKEN') ? TOKEN : ACCOUNT);
    }
    expect([...f.values.values()].join('')).not.toContain(TOKEN);
    expect(JSON.parse(f.values.get(hostingKey(REPO))!).status).toBe('ready');
  });
  it('requires explicit confirmation before replacing existing credentials', async () => {
    const f = fixture({ existingSecrets: true });
    expect((await f.connect()).status).toBe(409);
    expect(f.calls.some(call => call.method === 'PUT')).toBe(false);
    expect((await f.connect(true)).status).toBe(200);
  });
  it('records incomplete secret writes as failed and blocks setup', async () => {
    const f = fixture({ writeFailure: true });
    expect((await f.connect()).status).toBe(403);
    expect(JSON.parse(f.values.get(hostingKey(REPO))!).status).toBe('failed');
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


const setup = (): DeploymentSetup => ({ repo: REPO, branch: 'release', project: 'customer-docs', domain: '', accountId: ACCOUNT, workflow: 'name: Reviewed deployment', updatedAt: new Date().toISOString(), expectedSha: HEAD });

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

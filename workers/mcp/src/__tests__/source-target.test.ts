import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerKbTools } from '../tools/kb';
import { registerWriteTools } from '../tools/write';
import { resolveTarget } from '../tools/target';
import { readRegistry } from '../github';
import type { Env } from '../tools/helpers';

const REPO = 'CustomerOrg/handbook';
const HEAD = 'a'.repeat(40), BLOB = 'c'.repeat(40), TREE = 'b'.repeat(40), COMMIT = 'd'.repeat(40);
const REGISTRY = 'https://registry.test/knowledge-bases.json';
const entry = { id: 'customer-guides', title: 'Customer guides', engine: 'zensical', source: { repo: REPO, branch: 'release', docs_dir: 'knowledge', config: 'site.toml' } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const text = (result: any) => result.content.map((item: any) => item.text).join('\n');

function fixture(options: {
  anonymous?: boolean; registry?: unknown; registryStatus?: number; repository?: string; repoStatus?: number; private?: boolean;
  defaultBranch?: string; contentStatus?: number; missingBranch?: boolean; truncated?: boolean; unchanged?: boolean;
  moveAt?: 'tree' | 'commit' | 'branch' | 'patch';
} = {}) {
  const calls: Array<{ url: URL; method: string; body: any; auth: string | null }> = [];
  const files = new Map([
    ['knowledge/index.md', { sha: BLOB, content: '# Reviewed content\n' }],
    ['site.toml', { sha: '1'.repeat(40), content: '[project]\n' }],
    ['knowledge/old.md', { sha: '2'.repeat(40), content: '# Old page\n' }],
  ]);
  let head = HEAD;
  const env = { REGISTRY_URL: REGISTRY, GITHUB_ORG: 'FreeDocStore' } as Env;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET'; const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, auth: new Headers(init?.headers).get('Authorization') });
    if (url.href === REGISTRY) return json(options.registry ?? { knowledge_bases: [entry] }, options.registryStatus ?? 200);
    if (url.hostname !== 'api.github.com' || !path.startsWith(`/repos/${options.repository ?? REPO}`)) throw new Error(`Unexpected target ${url}`);
    if (path === `/repos/${options.repository ?? REPO}`) return json({ full_name: options.repository ?? REPO, private: options.private ?? false, default_branch: options.defaultBranch ?? 'trunk' }, options.repoStatus ?? 200);
    if (path.includes('/git/ref/heads/')) return options.missingBranch ? json({}, 404) : json({ object: { sha: head } });
    if (path.includes('/git/commits/')) return json({ tree: { sha: TREE } });
    if (path.includes('/contents/')) {
      if (options.contentStatus) return json({}, options.contentStatus);
      const file = files.get(decodeURIComponent(path.split('/contents/')[1]));
      return file ? json({ type: 'file', sha: file.sha, size: file.content.length, encoding: 'base64', content: btoa(file.content) }) : json({}, 404);
    }
    if (path.includes('/git/trees/') && method === 'GET') return json({ truncated: options.truncated ?? false, tree: [...files].map(([path, file]) => ({ path, type: 'blob', sha: file.sha })) });
    if (path.endsWith('/git/blobs')) return json({ sha: '3'.repeat(40) }, 201);
    if (path.endsWith('/git/trees')) {
      if (options.moveAt === 'tree') head = 'f'.repeat(40);
      return json({ sha: options.unchanged ? TREE : 'e'.repeat(40) }, 201);
    }
    if (path.endsWith('/git/commits')) {
      if (options.moveAt === 'commit') head = 'f'.repeat(40);
      return json({ sha: COMMIT }, 201);
    }
    if (path.endsWith('/git/refs')) {
      if (options.moveAt === 'branch') head = 'f'.repeat(40);
      return json({ object: { sha: COMMIT } }, 201);
    }
    if (method === 'PATCH') return options.moveAt === 'patch' ? json({ message: 'Update is not a fast forward' }, 422) : json({ object: { sha: COMMIT } });
    if (path.endsWith('/pulls')) return json({ number: 42, html_url: `https://github.com/${REPO}/pull/42` }, 201);
    if (path.endsWith('/actions/runs')) return json({ workflow_runs: [] });
    throw new Error(`Unexpected request ${method} ${url}`);
  }));
  const handlers: Record<string, (input: any) => Promise<any>> = {};
  const agent = { env, props: options.anonymous ? {} : { userId: 'user-42', githubAccessToken: 'test-only-user-token', scopes: ['read', 'write'] }, server: { tool: (name: string, _: unknown, __: unknown, handler: any) => { handlers[name] = handler; } } };
  registerKbTools(agent as any); registerWriteTools(agent as any);
  return { env, tools: handlers, calls, files, advance: () => { head = 'f'.repeat(40); }, mutations: () => calls.filter(call => call.method !== 'GET') };
}
const change = { repo: 'customer-guides', message: 'Reviewed proposal', files: [{ path: 'knowledge/index.md', content: '# Proposed content\n' }], expected_files: { 'knowledge/index.md': BLOB } };
afterEach(() => vi.unstubAllGlobals());

describe('canonical public source targets', () => {
  it.each(['customer-guides', 'handbook', REPO])('resolves %s to registered customer source and branch', async name => {
    const f = fixture(); const target = await resolveTarget(f.env, name);
    expect(target).toMatchObject({ repo: REPO, branch: 'release', commitSha: HEAD, kbId: entry.id, source: entry.source });
    expect(f.calls.some(call => call.url.pathname.includes('/FreeDocStore/'))).toBe(false);
  });
  it('uses the actual default branch for unregistered repositories and supported platform short names', async () => {
    const f = fixture({ registry: { knowledge_bases: [] } });
    expect((await resolveTarget(f.env, REPO)).branch).toBe('trunk');
    const short = fixture({ registry: { knowledge_bases: [] }, repository: 'FreeDocStore/guide', defaultBranch: 'stable' });
    expect(await resolveTarget(short.env, 'guide')).toMatchObject({ repo: 'FreeDocStore/guide', branch: 'stable' });
  });
  it('preserves validated overrides, encoding branch names and paths separately', async () => {
    const f = fixture(); const target = await resolveTarget(f.env, 'customer-guides', 'preview/next');
    expect(target.branch).toBe('preview/next'); expect(target.source.docs_dir).toBe('knowledge');
    expect((await resolveTarget(f.env, REPO, 'preview/next')).source.docs_dir).toBe('knowledge');
    expect(f.calls.at(-1)?.url.pathname).toContain('heads/preview%2Fnext');
  });
  it('rejects ambiguous short names and duplicate ids instead of choosing the first record', async () => {
    const f = fixture({ registry: { knowledge_bases: [entry, { ...entry, id: 'other-guides', source: { repo: 'OtherOrg/handbook' } }] } });
    await expect(resolveTarget(f.env, 'handbook')).rejects.toThrow(/multiple/);
    const duplicate = fixture({ registry: { knowledge_bases: [entry, { ...entry }] } });
    await expect(resolveTarget(duplicate.env, 'customer-guides')).rejects.toThrow(/multiple/);
  });
  it('stops on registry outages; explicit owner/name and branch remains self-contained', async () => {
    const f = fixture({ registryStatus: 503 });
    await expect(resolveTarget(f.env, 'customer-guides')).rejects.toThrow(/registry/);
    await expect(resolveTarget(f.env, REPO)).rejects.toThrow(/registry/);
    expect(f.calls.every(call => call.url.href === REGISTRY)).toBe(true);
    expect(await resolveTarget(f.env, REPO, 'release')).toMatchObject({ repo: REPO, branch: 'release' });
  });
  it.each([{}, { knowledge_bases: {} }, { knowledge_bases: [{ id: 'bad' }] }])('rejects malformed registry data %j', async registry => {
    fixture({ registry }); await expect(readRegistry(REGISTRY)).rejects.toThrow(/registry is invalid/);
  });
  it.each([{ private: true }, { repoStatus: 404 }, { repoStatus: 403 }, { missingBranch: true }])('refuses inaccessible, private or missing source %j', async options => {
    const f = fixture(options); const result = await f.tools.read_file({ repo: 'customer-guides', path: 'knowledge/index.md' });
    expect(result.isError).toBe(true); expect(text(result)).not.toContain('expected_files:'); expect(f.mutations()).toEqual([]);
  });
  it.each(['../trunk', 'release~1', 'refs..bad', 'bad branch', '', '-invalid'])('rejects invalid branch %j before network access', async branch => {
    const f = fixture(); await expect(resolveTarget(f.env, REPO, branch)).rejects.toThrow(/Invalid branch/); expect(f.calls).toEqual([]);
  });
});

describe('source reads and reviewed proposals', () => {
  it('uses one source commit for reads, lists and checks, with source metadata and blob versions', async () => {
    const f = fixture();
    for (const name of ['read_file', 'list_files', 'check_zensical_repo']) {
      const result = await f.tools[name]({ repo: 'customer-guides', path: 'knowledge/index.md' });
      expect(text(result)).toContain(`Repository: ${REPO}`); expect(text(result)).toContain('Branch: release'); expect(text(result)).toContain('Docs dir: knowledge'); expect(text(result)).toContain(HEAD);
      if (name !== 'check_zensical_repo') expect(text(result)).toContain(BLOB);
      else expect(text(result)).toContain('5/5');
    }
    expect(f.calls.filter(call => call.url.pathname.includes('/contents/')).every(call => call.url.searchParams.get('ref') === HEAD)).toBe(true);
    expect(f.calls.filter(call => call.url.pathname.includes('/git/trees/')).every(call => call.url.pathname.endsWith(HEAD))).toBe(true);
  });
  it('returns a missing-file baseline only after validating the source branch and commit', async () => {
    const f = fixture(); const result = await f.tools.read_file({ repo: 'customer-guides', path: 'knowledge/new.md' });
    expect(text(result)).toContain('expected_files: {"knowledge/new.md":null}'); expect(result.isError).not.toBe(true);
  });
  it('does not pass an incomplete listing off as complete', async () => {
    const f = fixture({ truncated: true }); expect((await f.tools.list_files({ repo: 'customer-guides' })).isError).toBe(true);
  });
  it('filters deployment history by the resolved branch', async () => {
    const f = fixture(); await f.tools.deploy_status({ repo: 'customer-guides' });
    expect(f.calls.at(-1)?.url.searchParams.get('branch')).toBe('release');
  });
  it('opens a proposal against the registered branch with the reviewed source baseline', async () => {
    const f = fixture(); const result = await f.tools.update_files(change);
    expect(text(result)).toContain('Opened proposal PR #42'); expect(text(result)).toContain('Branch: release');
    expect(f.calls.find(call => call.url.pathname.endsWith('/pulls'))?.body.base).toBe('release');
    expect(f.calls.filter(call => call.url.pathname.includes('/contents/')).every(call => call.url.searchParams.get('ref') === HEAD)).toBe(true);
    expect(f.calls.filter(call => call.url.hostname === 'api.github.com').every(call => call.auth === 'Bearer test-only-user-token')).toBe(true);
  });
  it('dry run checks the baseline but performs no mutations', async () => {
    const f = fixture(); expect(text(await f.tools.update_files({ ...change, dry_run: true }))).toContain('Dry run'); expect(f.mutations()).toEqual([]);
    f.files.get('knowledge/index.md')!.sha = 'f'.repeat(40);
    const stale = await f.tools.update_files({ ...change, dry_run: true }); expect(stale.isError).toBe(true); expect(text(stale)).toContain('Source changed'); expect(f.mutations()).toEqual([]);
  });
  it.each([undefined, {}, { 'knowledge/index.md': 'invalid' }, { 'knowledge/index.md': BLOB, 'other.md': null }])('rejects missing or invalid preconditions %j before mutations', async expected_files => {
    const f = fixture(); expect((await f.tools.update_files({ ...change, expected_files })).isError).toBe(true); expect(f.calls).toEqual([]);
  });
  it.each(['replacement', 'deletion', 'creation'])('rejects a stale %s before writing Git objects', async kind => {
    const f = fixture();
    const input = { ...change, expected_files: { ...change.expected_files }, ...(kind === 'deletion' ? { files: [], delete_paths: ['knowledge/index.md'] } : {}) };
    if (kind === 'creation') input.expected_files = { 'knowledge/index.md': null } as any;
    else f.files.get('knowledge/index.md')!.sha = 'f'.repeat(40);
    const result = await f.tools.update_files(input); expect(result.isError).toBe(true); expect(text(result)).toContain('Read the current source again'); expect(f.mutations()).toEqual([]);
  });
  it('allows a missing-file creation and deletion-only proposals with correct baselines', async () => {
    const f = fixture();
    expect((await f.tools.update_files({ ...change, files: [{ path: 'knowledge/new.md', content: '# New' }], expected_files: { 'knowledge/new.md': null } })).isError).not.toBe(true);
    expect((await f.tools.update_files({ ...change, files: [], delete_paths: ['knowledge/old.md'], expected_files: { 'knowledge/old.md': '2'.repeat(40) } })).isError).not.toBe(true);
  });
  it.each([403, 429, 503])('does not interpret source inspection HTTP %i as an absent file', async contentStatus => {
    const f = fixture({ contentStatus }); const result = await f.tools.update_files({ ...change, expected_files: { 'knowledge/index.md': null } });
    expect(result.isError).toBe(true); expect(f.mutations()).toEqual([]);
  });
  it.each(['tree', 'commit', 'branch'] as const)('detects source movement after %s creation before opening a PR', async moveAt => {
    const f = fixture({ moveAt }); const result = await f.tools.update_files(change);
    expect(result.isError).toBe(true); expect(text(result)).toContain('Source changed');
    expect(f.calls.some(call => call.url.pathname.endsWith('/pulls'))).toBe(false);
    if (moveAt === 'tree') expect(f.calls.some(call => call.url.pathname.endsWith('/git/commits'))).toBe(false);
  });
  it('keeps direct-commit confirmation and non-forcing ref updates', async () => {
    const f = fixture({ moveAt: 'patch' }); expect((await f.tools.update_files({ ...change, mode: 'direct' })).isError).toBe(true); expect(f.calls).toEqual([]);
    const result = await f.tools.update_files({ ...change, mode: 'direct', confirm: true }); expect(result.isError).toBe(true);
    expect(f.calls.find(call => call.method === 'PATCH')?.body).toEqual({ sha: COMMIT, force: false });
  });
  it('reports unchanged content without a commit, PR or claimed publication', async () => {
    const f = fixture({ unchanged: true }); const result = await f.tools.update_files(change); expect(text(result)).toContain('No changes:');
    expect(f.calls.some(call => call.url.pathname.endsWith('/git/commits') || call.url.pathname.endsWith('/pulls') || call.method === 'PATCH')).toBe(false);
  });
  it.each(['../escape.md', '/absolute.md', 'knowledge/.git/config', 'knowledge//a.md'])('rejects unsafe path %s without network access', async path => {
    const f = fixture(); expect((await f.tools.update_files({ ...change, files: [{ path, content: 'text' }], expected_files: { [path]: null } })).isError).toBe(true); expect(f.calls).toEqual([]);
  });
});

it('supports the actual MCP SDK schema and call protocol for versioned reads and deletion-only dry runs', async () => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const f = fixture();
  const server = new McpServer({ name: 'FreeDocStore test', version: '1.0.0' });
  const client = new Client({ name: 'FreeDocStore test client', version: '1.0.0' });
  const agent = { server, env: f.env, props: { userId: 'user-42', githubAccessToken: 'test-only-token', scopes: ['read', 'write'] } };
  registerKbTools(agent); registerWriteTools(agent);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.find(tool => tool.name === 'update_files')?.inputSchema.properties).toHaveProperty('expected_files');
    const read = await client.callTool({ name: 'read_file', arguments: { repo: 'customer-guides', path: 'knowledge/index.md' } });
    expect(text(read)).toContain(BLOB);
    const deleted = await client.callTool({ name: 'update_files', arguments: { ...change, files: [], delete_paths: ['knowledge/index.md'], dry_run: true } });
    expect(text(deleted)).toContain('Dry run'); expect(deleted.isError).not.toBe(true); expect(f.mutations()).toEqual([]);
    const missing = await client.callTool({ name: 'update_files', arguments: { ...change, expected_files: undefined } });
    expect(missing.isError).toBe(true);
  } finally { await client.close(); await server.close(); }
});

it('accepts unchanged reviewed blobs after unrelated source advances, using the new parent commit', async () => {
  const f = fixture();
  const read = await f.tools.read_file({ repo: 'customer-guides', path: 'knowledge/index.md' });
  expect(text(read)).toContain(HEAD);
  f.advance();
  const result = await f.tools.update_files(change);
  expect(result.isError).not.toBe(true);
  expect(text(result)).toContain(`Source commit: ${'f'.repeat(40)}`);
  expect(f.calls.find(call => call.url.pathname.endsWith('/git/commits'))?.body.parents).toEqual(['f'.repeat(40)]);
});

it('refuses a file deleted since review without creating Git objects', async () => {
  const f = fixture(); f.files.delete('knowledge/index.md');
  const result = await f.tools.update_files({ ...change, files: [], delete_paths: ['knowledge/index.md'] });
  expect(result.isError).toBe(true); expect(text(result)).toContain('Source changed'); expect(f.mutations()).toEqual([]);
});

it('uses connected credentials only for GitHub public-source reads and keeps anonymous reads supported', async () => {
  const connected = fixture(); await connected.tools.read_file({ repo: 'customer-guides', path: 'knowledge/index.md' });
  expect(connected.calls.filter(call => call.url.hostname === 'api.github.com').every(call => call.auth === 'Bearer test-only-user-token')).toBe(true);
  expect(connected.calls.find(call => call.url.href === REGISTRY)?.auth).toBeNull();
  const anonymous = fixture({ anonymous: true }); const result = await anonymous.tools.read_file({ repo: 'customer-guides', path: 'knowledge/index.md' });
  expect(result.isError).not.toBe(true); expect(anonymous.calls.every(call => call.auth === null)).toBe(true);
});

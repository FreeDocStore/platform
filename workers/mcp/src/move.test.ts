import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMoveTools } from './tools/move.js';
import type { Env } from './tools/helpers.js';

const repo = 'CustomerOrg/handbook';
const head = 'a'.repeat(40), sourceSha = 'b'.repeat(40), treeSha = 'c'.repeat(40), commitSha = 'd'.repeat(40);
const registryUrl = 'https://registry.test/registry.json';
const sourceContent = '\uFEFF# Exact bytes\r\nSecond line\n';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const base64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

function fixture(options: { destinationExists?: boolean; sourceStatus?: number; writeStatus?: number; scopes?: string[] } = {}) {
  const calls: Array<{ url: URL; method: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ url, method, body });
    if (url.href === registryUrl) return json({ knowledge_bases: [{ id: 'guides', title: 'Guides', engine: 'zensical', source: { repo, branch: 'release', docs_dir: 'docs', config: 'zensical.toml' } }] });
    if (url.pathname === `/repos/${repo}`) return json({ full_name: repo, private: false, default_branch: 'main' });
    if (url.pathname.includes('/git/ref/heads/')) return json({ object: { sha: head } });
    if (url.pathname === `/repos/${repo}/git/commits/${head}`) return json({ tree: { sha: treeSha } });
    if (url.pathname === `/repos/${repo}/git/trees/${head}`) return json({ truncated: false, tree: [
      { path: 'docs/old.md', type: 'blob', sha: sourceSha },
      { path: 'docs/index.md', type: 'blob', sha: 'e'.repeat(40) },
    ] });
    if (url.pathname.startsWith(`/repos/${repo}/contents/`)) {
      const path = decodeURIComponent(url.pathname.split('/contents/')[1]);
      if (path === 'docs/old.md' && options.sourceStatus) return json({ message: 'source unavailable' }, options.sourceStatus);
      if (path === 'docs/old.md') return json({ type: 'file', sha: sourceSha, size: sourceContent.length, encoding: 'base64', content: base64(sourceContent) });
      if (path === 'docs/index.md') return json({ type: 'file', sha: 'e'.repeat(40), size: 50, encoding: 'base64', content: btoa('[Old](old.md)\n') });
      if (path === 'docs/new.md' && options.destinationExists) return json({ type: 'file', sha: 'f'.repeat(40), size: 4, encoding: 'base64', content: btoa('here') });
      return json({ message: 'Not Found' }, 404);
    }
    if (method === 'POST' && options.writeStatus && url.pathname.includes('/git/blobs')) return json({ message: 'upstream failed' }, options.writeStatus);
    if (method === 'POST' && url.pathname.endsWith('/git/blobs')) return json({ sha: '1'.repeat(40) }, 201);
    if (method === 'POST' && url.pathname.endsWith('/git/trees')) return json({ sha: '2'.repeat(40) }, 201);
    if (method === 'POST' && url.pathname.endsWith('/git/commits')) return json({ sha: commitSha }, 201);
    if (method === 'POST' && url.pathname.endsWith('/git/refs')) return json({ object: { sha: commitSha } }, 201);
    if (method === 'POST' && url.pathname.endsWith('/pulls')) return json({ number: 12, html_url: `https://github.com/${repo}/pull/12` }, 201);
    throw new Error(`Unexpected request ${method} ${url}`);
  }));
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const env = { REGISTRY_URL: registryUrl, GITHUB_ORG: 'FreeDocStore', FDS_API_KV: { put: vi.fn(async () => {}) } } as unknown as Env;
  const agent = { env, props: { userId: 'user-1', login: 'writer', githubAccessToken: 'token', scopes: options.scopes ?? ['read', 'write'] }, server: { tool: (name: string, _schema: unknown, _description: unknown, handler: any) => { handlers[name] = handler; } } };
  registerMoveTools(agent as any);
  return { handlers, calls, env };
}
const text = (result: any) => result.content.map((item: any) => item.text).join('\n');
const input = { repo: 'guides', source_path: 'docs/old.md', destination_path: 'docs/new.md' };
afterEach(() => vi.unstubAllGlobals());

describe('move_document', () => {
  it.each([
    { source_path: '../escape.md', destination_path: 'docs/new.md' },
    { source_path: '/absolute.md', destination_path: 'docs/new.md' },
    { source_path: 'docs/.git/config.md', destination_path: 'docs/new.md' },
    { source_path: 'docs/old.md', destination_path: 'docs//new.md' },
  ])('rejects invalid paths before network access: %j', async paths => {
    const f = fixture(); const result = await f.handlers.move_document({ ...input, ...paths });
    expect(result.isError).toBe(true); expect(text(result)).toContain('Invalid document path'); expect(f.calls).toEqual([]);
  });
  it('rejects a conflicting destination', async () => {
    const result = await fixture({ destinationExists: true }).handlers.move_document(input);
    expect(result.isError).toBe(true); expect(text(result)).toContain('already exists');
  });
  it('dry run returns navigation references and performs no mutation', async () => {
    const f = fixture(); const result = await f.handlers.move_document({ ...input, dry_run: true });
    expect(result.isError).not.toBe(true); expect(text(result)).toContain('Dry run'); expect(text(result)).toContain('docs/index.md: old.md');
    expect(text(result)).toContain('Source bytes: preserved'); expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('requires confirm:true before creating a move proposal', async () => {
    const f = fixture(); const result = await f.handlers.move_document(input);
    expect(result.isError).not.toBe(true); expect(text(result)).toContain('Confirmation required'); expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('creates a reviewable proposal after confirmation and records audit details', async () => {
    const f = fixture(); const result = await f.handlers.move_document({ ...input, confirm: true });
    expect(result.isError, text(result)).not.toBe(true); expect(text(result)).toContain('Opened move proposal PR #12'); expect(text(result)).toContain('Audit: move_document');
    expect(f.calls.find(call => call.url.pathname.endsWith('/git/blobs'))?.body.content).toBe(base64(sourceContent));
    expect(f.calls.find(call => call.url.pathname.endsWith('/git/trees') && call.method === 'POST')?.body.tree).toEqual([
      { path: 'docs/new.md', mode: '100644', type: 'blob', sha: '1'.repeat(40) },
      { path: 'docs/old.md', mode: '100644', type: 'blob', sha: null },
    ]);
    expect((f.env.FDS_API_KV as any).put).toHaveBeenCalledOnce();
  });
  it('surfaces upstream failures without claiming a proposal was created', async () => {
    const failedRead = await fixture({ sourceStatus: 503 }).handlers.move_document(input);
    expect(failedRead.isError).toBe(true); expect(text(failedRead)).toMatch(/503|upstream/i);
    const failedWrite = await fixture({ writeStatus: 502 }).handlers.move_document({ ...input, confirm: true });
    expect(failedWrite.isError).toBe(true); expect(text(failedWrite)).toContain('Move proposal failed');
  });
  it('requires write scope for confirmed moves but permits read-only previews', async () => {
    const f = fixture({ scopes: ['read'] });
    expect((await f.handlers.move_document({ ...input, dry_run: true })).isError).not.toBe(true);
    const result = await f.handlers.move_document({ ...input, confirm: true });
    expect(result.isError).toBe(true); expect(text(result)).toContain('write scope');
  });
});

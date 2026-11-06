import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSearchTools } from './tools/search.js';
import type { Env } from './tools/helpers.js';

const repo = 'CustomerOrg/handbook';
const sha = 'a'.repeat(40);
const registryUrl = 'https://registry.test/registry.json';
const registered = { id: 'guides', title: 'Guides', engine: 'zensical', source: { repo, branch: 'release', docs_dir: 'docs', config: 'zensical.toml' } };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers });

function fixture(options: { searchStatus?: number; results?: unknown; contentLength?: string; scopes?: string[] } = {}) {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.href === registryUrl) return json({ knowledge_bases: [registered] });
    if (url.pathname === `/repos/${repo}`) return json({ full_name: repo, private: false, default_branch: 'main' });
    if (url.pathname.includes('/git/ref/heads/')) return json({ object: { sha } });
    if (url.pathname === '/search/code') {
      if (options.contentLength) return json({ items: [] }, 200, { 'content-length': options.contentLength });
      if (options.searchStatus) return json({ message: 'denied' }, options.searchStatus);
      return json(options.results ?? { total_count: 0, items: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const env = { REGISTRY_URL: registryUrl, GITHUB_ORG: 'FreeDocStore' } as Env;
  const agent = { env, props: { userId: 'user-1', githubAccessToken: 'token', scopes: options.scopes ?? ['read'] }, server: { tool: (name: string, _schema: unknown, _description: unknown, handler: any) => { handlers[name] = handler; } } };
  registerSearchTools(agent as any);
  return { handlers, calls };
}
const text = (result: any) => result.content.map((item: any) => item.text).join('\n');
afterEach(() => vi.unstubAllGlobals());

describe('search_documents', () => {
  it('returns bounded paths and excerpts and marks result truncation', async () => {
    const f = fixture({ results: { total_count: 3, items: [1, 2].map(i => ({ path: `docs/${i}.md`, html_url: `https://github.com/${repo}/blob/main/docs/${i}.md`, text_matches: [{ fragment: 'x'.repeat(240) }] })) } });
    const result = await f.handlers.search_documents({ repo: 'guides', query: 'safety', max_results: 2 });
    expect(text(result)).toContain('2 of 3'); expect(text(result)).toContain('Results were truncated');
    expect(text(result)).toContain('docs/1.md'); expect(text(result)).not.toContain('x'.repeat(201));
    expect(f.calls.find(url => url.pathname === '/search/code')?.searchParams.get('q')).toBe(`safety repo:${repo}`);
    expect(f.calls.find(url => url.pathname === '/search/code')?.searchParams.get('per_page')).toBe('2');
  });
  it('reports inaccessible repository search as a permission error, not no matches', async () => {
    const result = await fixture({ searchStatus: 403 }).handlers.search_documents({ repo: 'guides', query: 'safety' });
    expect(result.isError).toBe(true); expect(text(result)).toMatch(/permission error.*403/i); expect(text(result)).not.toContain('No matches');
  });
  it('handles oversized responses and rejects empty queries before search', async () => {
    const oversized = await fixture({ contentLength: '2000000' }).handlers.search_documents({ repo: 'guides', query: 'safety' });
    expect(oversized.isError).toBe(true); expect(text(oversized)).toContain('1 MiB');
    const f = fixture(); const empty = await f.handlers.search_documents({ repo: 'guides', query: '   ' });
    expect(empty.isError).toBe(true); expect(text(empty)).toContain('cannot be empty'); expect(f.calls).toEqual([]);
  });
  it('requires the read scope for authenticated callers', async () => {
    const f = fixture({ scopes: ['write'] }); const result = await f.handlers.search_documents({ repo: 'guides', query: 'safety' });
    expect(result.isError).toBe(true); expect(text(result)).toContain('read scope'); expect(f.calls).toEqual([]);
  });
});

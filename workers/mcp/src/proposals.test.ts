import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProposalTools } from './tools/proposals.js';
import type { Env } from './tools/helpers.js';

const repo = 'CustomerOrg/handbook';
const sha = 'a'.repeat(40);
const registryUrl = 'https://registry.test/registry.json';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function fixture(options: { pullsStatus?: number; prStatus?: number; filesStatus?: number; pulls?: unknown; pr?: unknown; files?: unknown } = {}) {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.href === registryUrl) return json({ knowledge_bases: [{ id: 'guides', title: 'Guides', engine: 'zensical', source: { repo, branch: 'release', docs_dir: 'docs', config: 'zensical.toml' } }] });
    if (url.pathname === `/repos/${repo}`) return json({ full_name: repo, private: false, default_branch: 'main' });
    if (url.pathname.includes('/git/ref/heads/')) return json({ object: { sha } });
    if (url.pathname === `/repos/${repo}/pulls`) return options.pullsStatus ? json({ message: 'denied' }, options.pullsStatus) : json(options.pulls ?? []);
    if (url.pathname === `/repos/${repo}/pulls/7`) return options.prStatus ? json({ message: 'missing' }, options.prStatus) : json(options.pr ?? { number: 7, title: 'Update guide', state: 'open', body: 'Reviewed change', html_url: `https://github.com/${repo}/pull/7`, user: { login: 'writer' } });
    if (url.pathname === `/repos/${repo}/pulls/7/files`) return options.filesStatus ? json({ message: 'denied' }, options.filesStatus) : json(options.files ?? [{ filename: 'docs/index.md', status: 'modified', additions: 3, deletions: 1, changes: 4 }]);
    throw new Error(`Unexpected request: ${url}`);
  }));
  const handlers: Record<string, (...args: any[]) => Promise<any>> = {};
  const env = { REGISTRY_URL: registryUrl, GITHUB_ORG: 'FreeDocStore' } as Env;
  const agent = { env, props: { userId: 'user-1', githubAccessToken: 'token', scopes: ['read'] }, server: { tool: (name: string, _schema: unknown, _description: unknown, handler: any) => { handlers[name] = handler; } } };
  registerProposalTools(agent as any);
  return { handlers, calls };
}
const text = (result: any) => result.content.map((item: any) => item.text).join('\n');
afterEach(() => vi.unstubAllGlobals());

describe('proposal tools', () => {
  it('reports 403 permission errors and 404 not-found errors instead of an empty PR list', async () => {
    const forbidden = await fixture({ pullsStatus: 403 }).handlers.list_proposals({ repo: 'guides', state: 'open' });
    expect(forbidden.isError).toBe(true); expect(text(forbidden)).toMatch(/permission error.*403/i); expect(text(forbidden)).not.toContain('No open proposals');
    const missing = await fixture({ pullsStatus: 404 }).handlers.list_proposals({ repo: 'guides', state: 'open' });
    expect(missing.isError).toBe(true); expect(text(missing)).toMatch(/not found.*404/i); expect(text(missing)).not.toContain('No open proposals');
  });
  it('distinguishes a successful empty proposal list', async () => {
    const result = await fixture({ pulls: [] }).handlers.list_proposals({ repo: 'guides', state: 'open' });
    expect(result.isError).not.toBe(true); expect(text(result)).toContain('No open proposals');
  });
  it('returns PR summary and changed file paths', async () => {
    const result = await fixture().handlers.inspect_pr({ repo: 'guides', pr_number: 7 });
    expect(result.isError).not.toBe(true); expect(text(result)).toContain('Update guide'); expect(text(result)).toContain('Reviewed change'); expect(text(result)).toContain('docs/index.md');
  });
  it('reports invalid PR numbers without network access and missing PRs as not found', async () => {
    const f = fixture(); const invalid = await f.handlers.inspect_pr({ repo: 'guides', pr_number: 0 });
    expect(invalid.isError).toBe(true); expect(text(invalid)).toContain('positive integer'); expect(f.calls).toEqual([]);
    const missing = await fixture({ prStatus: 404 }).handlers.inspect_pr({ repo: 'guides', pr_number: 7 });
    expect(missing.isError).toBe(true); expect(text(missing)).toMatch(/not found.*404/i);
  });
  it('does not hide errors while reading changed files', async () => {
    const result = await fixture({ filesStatus: 403 }).handlers.inspect_pr({ repo: 'guides', pr_number: 7 });
    expect(result.isError).toBe(true); expect(text(result)).toMatch(/permission error.*403/i);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import app from './index';
import { SESSION_PREFIX, type Env } from './types';

const env = { EDITOR_BASE_URL: 'https://console.freedocstore.online', PUBLIC_BASE_URL: 'https://freedocstore.online', GITHUB_ORG: 'FreeDocStore', FDS_API_KV: { get: async (key: string) => key.startsWith(SESSION_PREFIX) ? { user: { id: 'account', login: 'reader' }, githubAccessToken: 'token' } : null } } as unknown as Env;
const request = (route: string, value: unknown) => app.request(`https://api.freedocstore.online/api/${route}`, { method: 'POST', headers: { Origin: env.EDITOR_BASE_URL, Cookie: 'fds_session=session', 'Content-Type': 'application/json' }, body: JSON.stringify(value) }, env);
afterEach(() => vi.unstubAllGlobals());

describe('publish and edit input validation', () => {
  it.each([null, [], 123, { title: 12 }, { title: 'Title', slug: null }, { title: 'Title', slug: 'slug', owner: [] }])('invalid publish body returns 400 without upstream calls: %j', async body => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await request('publish', body)).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  });
  it.each([null, [], { repo: 1 }, { repo: '../repo', path: 'docs/a.md', content: 'text' }, { repo: 'owner/repo', path: 'docs/../a.md', content: 'text' }, { repo: 'owner/repo', path: 'docs/a.md', content: 'text', branch: '../main' }, { repo: 'owner/repo', path: 'docs/a.md', content: 'text', message: {} }])('invalid edit body returns 400 without upstream calls: %j', async body => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    expect((await request('edit', body)).status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects duplicate paths and generated HTML at the server boundary', async () => {
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    for (const files of [[{ path: 'docs/a.md', content: 'a' }, { path: 'docs/a.md', content: 'b' }], [{ path: 'docs/a.html', content: '<h1>Generated</h1>' }]]) {
      expect((await request('publish', { title: 'Title', slug: 'slug', owner: 'owner', files })).status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import app from './index';
import { openSecret } from './encryption';
import { SESSION_PREFIX, STATE_PREFIX, type Env, type Session } from './types';

const session: Session = { id: 'session', user: { id: 'account-a', provider: 'github', login: 'reader', name: '', avatarUrl: '', githubUrl: '' }, githubAccessToken: 'user-token', createdAt: '', updatedAt: '' };
function environment(state = JSON.stringify({ provider: 'github' })) {
  const put = vi.fn(); const del = vi.fn();
  const env = { EDITOR_BASE_URL: 'https://console.freedocstore.online', PUBLIC_BASE_URL: 'https://freedocstore.online', GITHUB_ORG: 'FreeDocStore',
    GH_APP_CLIENT_ID: 'client', GH_APP_CLIENT_SECRET: 'secret', GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret',
    FDS_KEY_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
    FDS_API_KV: { get: vi.fn(async (key: string) => key.startsWith(SESSION_PREFIX) ? session : key.startsWith(STATE_PREFIX) ? state : null), put, delete: del },
  } as unknown as Env;
  return { env, put, del };
}
afterEach(() => vi.unstubAllGlobals());

describe('browser session boundaries', () => {
  it.each(['https://attacker.example', 'null', 'http://preview.freedocstore-editor.pages.dev', 'https://console.freedocstore.online.attacker.example'])('rejects writes from untrusted origins %s', async origin => {
    const { env, put } = environment(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const res = await app.request('https://api.freedocstore.online/api/kv/draft', { method: 'PUT', headers: { Origin: origin, Cookie: 'fds_session=session', 'Content-Type': 'application/json' }, body: '{"value":"changed"}' }, env);
    expect(res.status).toBe(403); expect(put).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects a simple text/plain POST before routing or upstream work', async () => {
    const { env } = environment(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const res = await app.request('https://api.freedocstore.online/api/edit', { method: 'POST', headers: { Origin: 'https://attacker.example', Cookie: 'fds_session=session', 'Content-Type': 'text/plain' }, body: '{"repo":"owner/repo","path":"docs/page.md","content":"changed"}' }, env);
    expect(res.status).toBe(403); expect(upstream).not.toHaveBeenCalled();
  });
  it.each(['https://console.freedocstore.online', 'https://api.freedocstore.online', 'https://preview.freedocstore-editor.pages.dev'])('allows a trusted browser write from %s', async origin => {
    const { env, put } = environment();
    const res = await app.request('https://api.freedocstore.online/api/kv/draft', { method: 'PUT', headers: { Origin: origin, Cookie: 'fds_session=session', 'Content-Type': 'application/json', 'X-FDS-Account': 'account-a' }, body: '{"value":"draft"}' }, env);
    expect(res.status).toBe(200); expect(put).toHaveBeenCalledTimes(1);
  });
  it('requires an origin for cookie-backed writes while unauthenticated requests still return 401', async () => {
    const { env } = environment();
    const req = (cookie: string) => app.request('https://api.freedocstore.online/api/edit', { method: 'POST', headers: { Cookie: cookie }, body: '{}' }, env);
    expect((await req('fds_session=session')).status).toBe(403);
    expect((await req('')).status).toBe(401);
  });
  it.each(['GET', 'PUT'])('refuses a stale account binding for %s', async method => {
    const { env, put } = environment();
    const res = await app.request('https://api.freedocstore.online/api/kv/draft', { method, headers: { Origin: 'https://console.freedocstore.online', Cookie: 'fds_session=session', 'X-FDS-Account': 'account-b' }, ...(method === 'PUT' ? { body: '{"value":"wrong-account"}' } : {}) }, env);
    expect(res.status).toBe(409); expect(put).not.toHaveBeenCalled();
  });
  it.each(['google', null, [], { provider: 'github', next: 123 }])('rejects invalid or cross-provider OAuth state %j', async state => {
    const { env } = environment(typeof state === 'string' ? JSON.stringify({ provider: state }) : JSON.stringify(state));
    const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const res = await app.request('https://api.freedocstore.online/auth/github/callback?state=state&code=code', { headers: { Cookie: '__Host-fds-oauth-github=state' } }, env);
    expect(res.status).toBe(400); expect(upstream).not.toHaveBeenCalled();
  });
  it.each(['github', 'google'])('binds %s OAuth state to a secure browser cookie', async provider => {
    const { env } = environment();
    const start = await app.request(`https://api.freedocstore.online/auth/${provider}/start`, {}, env);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get('Location')!).searchParams.get('state');
    expect(start.headers.get('Set-Cookie')).toContain(`__Host-fds-oauth-${provider}=${state}`);
    expect(start.headers.get('Set-Cookie')).toMatch(/HttpOnly/);
    expect(start.headers.get('Set-Cookie')).toMatch(/Secure/);
    expect(start.headers.get('Set-Cookie')).toMatch(/SameSite=Lax/);
  });
  it.each(['', '__Host-fds-oauth-github=someone-elses-state'])('rejects a callback without the initiating browser nonce %s', async cookie => {
    const { env, del } = environment(); const upstream = vi.fn(); vi.stubGlobal('fetch', upstream);
    const response = await app.request('https://api.freedocstore.online/auth/github/callback?state=state&code=code', { headers: { Cookie: cookie } }, env);
    expect(response.status).toBe(400);
    expect(del).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });
  it('accepts matching provider and browser state before exchanging the code', async () => {
    const { env, del } = environment();
    const upstream = vi.fn(async () => new Response(JSON.stringify({ error: 'bad_code' }), { status: 400 })); vi.stubGlobal('fetch', upstream);
    const response = await app.request('https://api.freedocstore.online/auth/github/callback?state=state&code=code', { headers: { Cookie: '__Host-fds-oauth-github=state' } }, env);
    expect(response.status).toBe(401);
    expect(del).toHaveBeenCalledWith(`${STATE_PREFIX}state`); expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('stores GitHub token expiry and encrypted refresh credentials only in the server session', async () => {
    const { env, put } = environment();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-private', expires_in: 3600, refresh_token: 'refresh-private', refresh_token_expires_in: 86400 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: 'reader' }))));
    const before = Date.now();
    const response = await app.request('https://api.freedocstore.online/auth/github/callback?state=state&code=code', { headers: { Cookie: '__Host-fds-oauth-github=state' } }, env);
    expect(response.status).toBe(302);
    const sessionWrite = put.mock.calls.find(([key]) => String(key).startsWith(SESSION_PREFIX));
    expect(sessionWrite).toBeDefined();
    const saved = JSON.parse(String(sessionWrite?.[1])) as Session;
    expect(saved.githubAccessToken).toBe('access-private');
    expect(saved.githubTokenExpiresAt).toBeGreaterThanOrEqual(before + 3_599_000);
    expect(saved.githubTokenExpiresAt).toBeLessThanOrEqual(before + 3_601_000);
    expect(saved.githubRefreshToken).not.toBe('refresh-private');
    expect(await openSecret({ ...saved.githubRefreshToken!, label: 'refresh' }, '0123456789abcdef0123456789abcdef')).toBe('refresh-private');
    expect(response.headers.get('Location')).not.toContain('access-private');
    expect(response.headers.get('Set-Cookie')).not.toContain('refresh-private');
  });

});

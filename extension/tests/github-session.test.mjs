import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './_bundle.mjs';
const { refreshGithubSession, patchStoredSettings, resetStoredSettings, loadStoredSettings, SETTINGS_KEY } = await import(await bundle('tests/fixtures/github-session.ts'));
const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
afterEach(() => { globalThis.chrome = originalChrome; globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; });
const ctx = { clientId: 'test-client', accessToken: 'old-access', refreshToken: 'old-refresh', username: 'reader' };
const fresh = () => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800 });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function install() {
  const initial = { adapter: 'openai', claude: { apiKey: 'user-provider-key', model: 'chosen-model', githubApp: { ...ctx, expiresAt: 1 } } };
  const sync = new Map([[SETTINGS_KEY, structuredClone(initial)]]);
  const local = new Map([[SETTINGS_KEY, structuredClone(initial)]]);
  const area = values => ({ get: async key => ({ [key]: structuredClone(values.get(key)) }), set: async object => { for (const [key, value] of Object.entries(object)) values.set(key, structuredClone(value)); }, remove: async key => values.delete(key) });
  globalThis.chrome = { storage: { sync: area(sync), local: area(local) } };
  return { sync, local };
}

test('refresh remains single-flight until persistence has finished', async () => {
  install();
  const started = deferred(); const release = deferred();
  const set = chrome.storage.sync.set;
  chrome.storage.sync.set = async object => { started.resolve(); await release.promise; await set(object); };
  let calls = 0; globalThis.fetch = async () => { calls++; return fresh(); };
  const first = refreshGithubSession({ ...ctx });
  await started.promise;
  const second = refreshGithubSession({ ...ctx });
  assert.equal(first, second);
  release.resolve();
  const tokens = await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(tokens[0].accessToken, 'new-access');
  assert.equal((await loadStoredSettings()).claude.githubApp.refreshToken, 'new-refresh');
});

test('refresh preserves concurrent option updates and a later caller adopts the persisted token', async () => {
  install(); const started = deferred(); const response = deferred();
  let calls = 0; globalThis.fetch = async () => { calls++; started.resolve(); return response.promise; };
  const pending = refreshGithubSession({ ...ctx }); await started.promise;
  await patchStoredSettings({ theme: 'light', claude: { apiKey: 'updated-provider-key', model: 'updated-model' } });
  response.resolve(fresh()); await pending;
  assert.equal((await loadStoredSettings()).claude.apiKey, 'updated-provider-key');
  assert.equal((await loadStoredSettings()).theme, 'light');
  assert.equal((await refreshGithubSession({ ...ctx })).accessToken, 'new-access');
  assert.equal(calls, 1);
});

test('revoked refresh clears only the expired sign-in and retains provider settings', async () => {
  install(); globalThis.fetch = async () => Response.json({ error: 'invalid_grant' });
  await assert.rejects(refreshGithubSession({ ...ctx }), /Sign in with GitHub again/);
  const settings = await loadStoredSettings();
  assert.equal(settings.claude.githubApp.accessToken, '');
  assert.equal(settings.claude.githubApp.refreshToken, '');
  assert.equal(settings.claude.githubApp.username, '');
  assert.equal(settings.claude.apiKey, 'user-provider-key');
});

test('transient failures retain the credential and allow a later retry', async () => {
  install(); globalThis.fetch = async () => new Response('bad_refresh_token', { status: 503 });
  await assert.rejects(refreshGithubSession({ ...ctx }), /HTTP 503/);
  assert.equal((await loadStoredSettings()).claude.githubApp.accessToken, 'old-access');
  globalThis.fetch = async () => fresh();
  assert.equal((await refreshGithubSession({ ...ctx })).accessToken, 'new-access');
});

test('a timed-out refresh releases its shared promise, preserves credentials and can retry', async () => {
  install();
  const controller = new AbortController();
  const started = deferred();
  AbortSignal.timeout = milliseconds => {
    assert.equal(milliseconds, 15_000);
    return controller.signal;
  };
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    assert.equal(init.signal, controller.signal);
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    started.resolve();
  });
  const pending = refreshGithubSession({ ...ctx });
  const shared = refreshGithubSession({ ...ctx });
  assert.equal(pending, shared);
  await started.promise;
  controller.abort(new DOMException('Refresh timed out', 'TimeoutError'));
  await assert.rejects(pending, { name: 'TimeoutError' });
  assert.equal((await loadStoredSettings()).claude.githubApp.refreshToken, ctx.refreshToken);
  AbortSignal.timeout = originalTimeout;
  globalThis.fetch = async () => fresh();
  assert.equal((await refreshGithubSession({ ...ctx })).accessToken, 'new-access');
});

test('late terminal failure adopts another successful rotation without clearing it', async () => {
  install(); const started = deferred(); const response = deferred();
  globalThis.fetch = async () => { started.resolve(); return response.promise; };
  const pending = refreshGithubSession({ ...ctx }); await started.promise;
  await patchStoredSettings(current => ({ claude: { ...current.claude, githubApp: { ...ctx, accessToken: 'winner-access', refreshToken: 'winner-refresh' } } }));
  response.resolve(Response.json({ error: 'bad_refresh_token' }));
  assert.equal((await pending).accessToken, 'winner-access');
  assert.equal((await loadStoredSettings()).claude.githubApp.accessToken, 'winner-access');
});

test('late success cannot resurrect credentials after sign-out or reset', async () => {
  for (const reset of [false, true]) {
    install(); const started = deferred(); const response = deferred();
    globalThis.fetch = async () => { started.resolve(); return response.promise; };
    const pending = refreshGithubSession({ ...ctx }); await started.promise;
    if (reset) await resetStoredSettings();
    else await patchStoredSettings({ claude: { apiKey: 'user-provider-key', model: 'chosen-model', githubApp: { ...ctx, accessToken: '', refreshToken: '', username: '' } } });
    response.resolve(fresh()); await assert.rejects(pending, /Sign in with GitHub again/);
    assert.ok(!(await loadStoredSettings()).claude?.githubApp?.accessToken);
  }
});

test('an old client cannot adopt or overwrite another signed-in account', async () => {
  install(); const started = deferred(); const response = deferred();
  globalThis.fetch = async () => { started.resolve(); return response.promise; };
  const pending = refreshGithubSession({ ...ctx }); await started.promise;
  await patchStoredSettings({ claude: { apiKey: 'new-key', model: 'model', githubApp: { ...ctx, accessToken: 'other-access', refreshToken: 'other-refresh', username: 'another-reader' } } });
  response.resolve(fresh()); await assert.rejects(pending, /Sign in with GitHub again/);
  assert.equal((await loadStoredSettings()).claude.githubApp.accessToken, 'other-access');
  assert.equal((await loadStoredSettings()).claude.apiKey, 'new-key');
});

import { test, expect, chromium } from '@playwright/test';
import { resolve } from 'node:path';

const stubSpeech = () => {
  window.__speech = { calls: [], cancelled: 0, paused: false };
  const voice = { name: 'Device voice', voiceURI: 'device', lang: 'en-US', localService: true };
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  Object.defineProperty(window, 'speechSynthesis', { value: {
    getVoices: () => [voice], addEventListener() {}, removeEventListener() {},
    get paused() { return window.__speech.paused; },
    speak(u) { window.__speech.calls.push(u.text); window.__speech.utterance = u; },
    cancel() { window.__speech.cancelled++; },
    pause() { window.__speech.paused = true; }, resume() { window.__speech.paused = false; },
  } });
};

test('installed extension narrates the page and yields when page playback starts', async () => {
  const extension = resolve('dist');
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const bg = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(bg.url()).host;
    const docs = await context.newPage();
    await docs.addInitScript(stubSpeech);
    await docs.goto('http://127.0.0.1:4319/_fixture');
    const tabId = await bg.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:4319/_fixture' }))[0].id);
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 390, height: 844 });
    await panel.addInitScript(stubSpeech);
    // A panel rendered in a test tab must target the browsing tab rather than
    // itself. Chrome messaging, injection, storage and sender checks stay real.
    await panel.addInitScript(tabId => {
      const nativeQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = query => query.active && query.currentWindow ? chrome.tabs.get(tabId).then(tab => [tab]) : nativeQuery(query);
    }, tabId);
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.locator('#narration summary').click();
    await panel.locator('[data-play]').click();
    await expect(panel.locator('[data-play]')).toHaveText('Pause');
    const spoken = await panel.evaluate(() => window.__speech.calls.join(' '));
    expect(spoken).toContain('Reader guide');
    expect(spoken).not.toContain('Navigation must not be spoken');
    expect(spoken).not.toContain('secret code not spoken');
    // Don't activate the browsing tab: exercise the runtime signal itself.
    await docs.evaluate(() => document.querySelector('#freedocstore-read-aloud > button').click());
    await expect(panel.locator('[data-play]')).toHaveText('Listen');
    expect(await panel.evaluate(() => window.__speech.cancelled)).toBeGreaterThan(0);
    await panel.locator('[data-play]').click();
    await expect(panel.locator('[data-play]')).toHaveText('Pause');
    await expect(docs.locator('#freedocstore-read-aloud > button').first()).not.toHaveAttribute('aria-label', 'Pause reading');
    await panel.locator('[data-play]').click();
    await expect(panel.locator('[data-play]')).toHaveText('Resume');
    await panel.screenshot({ path: '/tmp/fds-panel.png', fullPage: true });
    await panel.locator('[data-stop]').click();
    await expect(panel.locator('[data-play]')).toHaveText('Listen');
  } finally { await context.close(); }
});

test('options preserve a rotated credential on Save and explicitly clear it on Sign out', async () => {
  const extension = resolve('dist');
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const bg = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(bg.url()).host;
    await bg.evaluate(async () => {
      const settings = { adapter: 'openai', claude: { apiKey: 'test-provider-key', model: 'claude-sonnet-4-6', githubApp: { clientId: 'test-client', accessToken: 'old-access', refreshToken: 'old-refresh', username: 'reader', expiresAt: Date.now() + 3600000 } } };
      await chrome.storage.sync.set({ 'freedocstore.settings': settings });
      await chrome.storage.local.set({ 'freedocstore.settings': settings });
    });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.getByRole('tab', { name: 'AI & GitHub' }).click();
    await expect(options.locator('#gh-signout')).toBeVisible();
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { claude: { apiKey: 'test-provider-key', model: 'claude-sonnet-4-6', githubApp: { clientId: 'test-client', accessToken: 'rotated-access', refreshToken: 'rotated-refresh', username: 'reader' } } } }));
    await options.getByRole('tab', { name: 'General', exact: true }).click();
    await options.locator('#font-size').fill('18');
    await options.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => bg.evaluate(async () => (await chrome.storage.sync.get('freedocstore.settings'))['freedocstore.settings'].fontSize)).toBe(18);
    expect(await bg.evaluate(async () => (await chrome.storage.sync.get('freedocstore.settings'))['freedocstore.settings'].claude.githubApp.accessToken)).toBe('rotated-access');
    // A settings lock held by the Options page must also block the real
    // background writer, proving coordination across extension contexts.
    await options.evaluate(() => {
      void navigator.locks.request('freedocstore.settings.write', () => new Promise(resolve => { window.releaseSettingsLock = resolve; }));
    });
    await expect.poll(() => options.evaluate(() => typeof window.releaseSettingsLock)).toBe('function');
    const pendingSave = options.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_SETTINGS', payload: { fontSize: 19 } }));
    await expect.poll(() => bg.evaluate(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'freedocstore.settings.write'))).toBe(true);
    expect(await bg.evaluate(async () => (await chrome.storage.sync.get('freedocstore.settings'))['freedocstore.settings'].fontSize)).toBe(18);
    await options.evaluate(() => window.releaseSettingsLock());
    await pendingSave;
    expect(await bg.evaluate(async () => (await chrome.storage.sync.get('freedocstore.settings'))['freedocstore.settings'].fontSize)).toBe(19);
    await options.getByRole('tab', { name: 'AI & GitHub' }).click();
    await options.locator('#gh-signout').click();
    await options.locator('#gh-signout').click();
    await expect(options.locator('#gh-signout')).toBeHidden();
    const app = await bg.evaluate(async () => (await chrome.storage.sync.get('freedocstore.settings'))['freedocstore.settings'].claude.githubApp);
    expect(app.accessToken).toBe(''); expect(app.refreshToken).toBe('');
  } finally { await context.close(); }
});

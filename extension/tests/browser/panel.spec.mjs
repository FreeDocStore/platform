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

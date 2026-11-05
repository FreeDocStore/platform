import { test, expect } from '@playwright/test';

async function speech(page, local = true) {
  await page.addInitScript(({ local }) => {
    const voices = [{ name: 'Remote voice', voiceURI: 'remote', lang: 'en-US', localService: false }, ...(local ? [{ name: 'Device voice', voiceURI: 'device', lang: 'en-US', localService: true }] : [])];
    window.__speech = { calls: [], cancelled: 0, paused: false, utterance: null };
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => voices,
      addEventListener() {}, removeEventListener() {},
      get paused() { return window.__speech.paused; },
      speak(u) { window.__speech.calls.push({ text: u.text, voice: u.voice.voiceURI, rate: u.rate }); window.__speech.utterance = u; },
      cancel() { window.__speech.cancelled++; },
      pause() { window.__speech.paused = true; },
      resume() { window.__speech.paused = false; },
    } });
  }, { local });
}

test('reader uses only local voices, pauses, resumes and yields to the panel', async ({ page }) => {
  await speech(page);
  await page.goto('/_fixture');
  const play = page.locator('#freedocstore-read-aloud > button').first();
  await expect(play).toBeEnabled();
  await play.click();
  await expect(play).toHaveAttribute('aria-label', 'Pause reading');
  expect(await page.evaluate(() => window.__speech.calls[0])).toEqual({ text: 'Reader guide.', voice: 'device', rate: 1 });
  await play.click();
  await expect(play).toHaveAttribute('aria-label', 'Resume reading');
  await play.click();
  await expect(play).toHaveAttribute('aria-label', 'Pause reading');
  // A wrong-origin message must have no effect.
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { source: window, origin: 'https://wrong.example', data: { type: 'FREEDOCSTORE_READ_ALOUD_STOP' } })));
  await expect(play).toHaveAttribute('aria-label', 'Pause reading');
  await page.evaluate(() => window.postMessage({ type: 'FREEDOCSTORE_READ_ALOUD_STOP' }, location.origin));
  await expect(play).not.toHaveAttribute('aria-label', 'Pause reading');
});

test('reader covers table and note text, skips code and navigation, and completes', async ({ page }) => {
  await speech(page);
  await page.goto('/_fixture');
  await page.locator('#freedocstore-read-aloud > button').first().click();
  const spoken = await page.evaluate(() => {
    for (let i = 0; i < 30; i++) {
      const current = window.__speech.utterance;
      current.onend();
      if (current === window.__speech.utterance) break;
    }
    return window.__speech.calls.map(c => c.text).join(' ');
  });
  expect(spoken).toContain('Public'); expect(spoken).toContain('Free');
  expect(spoken).toContain('Remember this useful note.');
  expect(spoken).not.toContain('Navigation must not be spoken');
  expect(spoken).not.toContain('secret code not spoken');
  await expect(page.locator('#freedocstore-read-aloud > button').first()).not.toHaveAttribute('aria-label', 'Pause reading');
});

test('no local voice disables listening without silently using a network voice', async ({ page }) => {
  await speech(page, false);
  await page.goto('/_fixture');
  await expect(page.locator('#freedocstore-read-aloud > button').first()).toBeDisabled();
  expect(await page.evaluate(() => window.__speech.calls)).toEqual([]);
});

test('repeated reader installation does not duplicate controls', async ({ page }) => {
  await speech(page);
  await page.goto('/_fixture');
  await expect(page.locator('#freedocstore-read-aloud')).toHaveCount(1);
  await page.addScriptTag({ url: '/reader.js' });
  await expect(page.locator('#freedocstore-read-aloud')).toHaveCount(1);
});

test('current recordings are offered and stale recordings use the device voice', async ({ page }) => {
  await speech(page);
  await page.goto('/_fixture?audio=fresh');
  await expect(page.locator('.freedocstore-ra-ai-dot')).toHaveCount(1);
  await expect(page.locator('#freedocstore-read-aloud > button').first()).toHaveAttribute('aria-label', 'Play the AI-generated narration of this page');
  await page.goto('/_fixture?audio=stale');
  await expect(page.locator('.freedocstore-ra-ai-dot')).toHaveCount(0);
  await page.locator('#freedocstore-read-aloud > button').first().click();
  expect(await page.evaluate(() => window.__speech.calls[0].voice)).toBe('device');
});

test('reader resumes the remembered sentence and character after a reload', async ({ page }) => {
  await speech(page);
  await page.goto('/_fixture');
  const play = page.locator('#freedocstore-read-aloud > button').first();
  await play.click();
  await page.evaluate(() => {
    window.__speech.utterance.onend();
    window.__speech.utterance.onboundary({ charIndex: 6 });
  });
  await play.click();
  await page.reload();
  await expect(play).toContainText('Resume');
  await play.click();
  expect(await page.evaluate(() => window.__speech.calls[0].text)).toBe('sentence.');
});

test('opted-in continuation follows the next same-origin navigation page', async ({ page }) => {
  await speech(page);
  await page.addInitScript(() => localStorage.setItem('freedocstore.readaloud.v1', JSON.stringify({ continueToNextPage: true })));
  await page.goto('/_fixture?chain=start');
  await page.locator('#freedocstore-read-aloud > button').first().click();
  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) {
      const current = window.__speech.utterance;
      current.onend();
      if (current === window.__speech.utterance) break;
    }
  });
  await page.waitForURL('**/_fixture?chain=next');
  await expect.poll(() => page.evaluate(() => window.__speech.calls.length)).toBeGreaterThan(0);
});

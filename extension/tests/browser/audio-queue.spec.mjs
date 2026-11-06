import { test, expect } from '@playwright/test';
import { mockConsole } from './console-mock.mjs';

async function deliverChunk(page) {
  await page.evaluate(() => {
    const wav = new ArrayBuffer(2044); const view = new DataView(wav);
    const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
    view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, wav.byteLength - 44, true);
    window.currentQueueWorker.onmessage({ data: { type: 'chunk-complete', wav } });
  });
}
async function completeUntilPublication(page, setup, baseline) {
  let delivered = 0;
  for (let attempt = 0; attempt < 40 && setup.publishCount <= baseline; attempt++) {
    const calls = await page.evaluate(() => window.queueWorkerCalls);
    if (calls > delivered) { delivered = calls; await deliverChunk(page); }
    else await page.waitForTimeout(80);
  }
}

async function setupQueue(page, { quota = false, holdPublish = false } = {}) {
  await page.addInitScript(({ quota }) => {
    if (quota) {
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('fds:audio:checkpoint:')) throw new DOMException('Storage is full', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
    }
    window.queueWorkerCalls = 0;
    window.Worker = class {
      constructor() { this.terminated = false; }
      postMessage() { window.queueWorkerCalls++; window.currentQueueWorker = this; }
      finish() { this.onmessage?.({ data: { type: 'chunk-complete', wav: testWav() } }); }
      terminate() { this.terminated = true; }
    };
    function testWav() {
      const buffer = new ArrayBuffer(2044); const view = new DataView(buffer);
      const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
      text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
      view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, buffer.byteLength - 44, true);
      return buffer;
    }
  }, { quota });
  let sourceRevision = 'a';
  let publishCount = 0;
  let releasePublish;
  const publishWait = holdPublish ? new Promise(resolve => { releasePublish = resolve; }) : Promise.resolve();
  await mockConsole(page, async (route, reply, url) => {
    const target = url.searchParams.get('target') || '';
    if (url.pathname === '/api/audio') {
      publishCount++; await publishWait; await reply({ ok: true, prUrl: 'https://github.com/FreeDocStore/example/pull/77' }); return true;
    }
    if (target.includes('/git/ref/heads/')) { await reply({ object: { sha: 'verified-head' } }); return true; }
    if (target.includes('/git/trees/')) {
      await reply({ tree: [{ path: 'docs/one.md', type: 'blob' }, { path: 'docs/two.md', type: 'blob' }] }); return true;
    }
    if (target.includes('/contents/')) {
      const path = target.includes('two.md') ? 'docs/two.md' : 'docs/one.md';
      const content = path.includes('two') ? '# Second page\n\nSecond page text.' : '# First page\n\nFirst page text.';
      await reply({ encoding: 'base64', content: btoa(content), sha: `${sourceRevision}${path.includes('two') ? '2' : '1'}` }); return true;
    }
    return false;
  });
  return { get publishCount() { return publishCount; }, setSourceRevision(value) { sourceRevision = value; }, releasePublish };
}

test('whole-KB checkpoints survive reload and completed page chunks are reused', async ({ page }) => {
  const setup = await setupQueue(page, { holdPublish: true });
  await page.goto('/edit/example/docs/index.md');
  await page.getByText('Page narration', { exact: true }).click();
  await page.getByRole('button', { name: 'Load KB recording inventory' }).click();
  await expect(page.getByText('First page', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Generate All' }).click();
  await expect.poll(() => page.evaluate(() => window.queueWorkerCalls)).toBe(1);
  await completeUntilPublication(page, setup, 0);
  await expect.poll(() => setup.publishCount).toBe(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  setup.releasePublish();
  await page.reload();
  await page.getByText('Page narration', { exact: true }).click();
  await page.getByRole('button', { name: 'Load KB recording inventory' }).click();
  await expect(page.locator('[data-status="current"]')).toHaveCount(1);
  await expect(page.locator('[data-status="missing"]')).toHaveCount(1);
  const beforeResume = setup.publishCount;
  await page.getByRole('button', { name: 'Generate All' }).click();
  await expect(page.getByText(/2 saved chunks reused/)).toBeVisible();
  await completeUntilPublication(page, setup, beforeResume);
  await expect.poll(() => setup.publishCount).toBeGreaterThan(beforeResume);
});

test('recording inventory marks checkpoint stale when the verified source version changes', async ({ page }) => {
  const setup = await setupQueue(page);
  await page.goto('/edit/example/docs/index.md');
  await page.getByText('Page narration', { exact: true }).click();
  await page.getByRole('button', { name: 'Load KB recording inventory' }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => window.queueWorkerCalls)).toBe(1);
  await completeUntilPublication(page, setup, 0);
  await expect.poll(() => setup.publishCount).toBe(1);
  setup.setSourceRevision('b');
  await page.getByRole('button', { name: 'Load KB recording inventory' }).click();
  await expect(page.locator('[data-status="stale"]')).toHaveCount(1);
});

test('queue pause and resume continue from the next saved chunk', async ({ page }) => {
  const setup = await setupQueue(page);
  await page.goto('/edit/example/docs/index.md');
  await page.getByText('Page narration', { exact: true }).click();
  await page.getByRole('button', { name: 'Load KB recording inventory' }).click();
  await page.getByRole('button', { name: 'Generate All' }).click();
  await expect.poll(() => page.evaluate(() => window.queueWorkerCalls)).toBe(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await deliverChunk(page);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.queueWorkerCalls)).toBe(1);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.queueWorkerCalls)).toBe(2);
  await completeUntilPublication(page, setup, 0);
});

test('checkpoint quota errors appear in the queue instead of being swallowed', async ({ page }) => {
  await setupQueue(page, { quota: true });
  await page.goto('/edit/example/docs/index.md');
  await page.getByText('Page narration', { exact: true }).click();
  await page.getByRole('button', { name: 'Load KB recording inventory' }).click();
  await page.getByRole('button', { name: 'Generate', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => window.queueWorkerCalls)).toBe(1);
  await deliverChunk(page);
  await expect(page.getByRole('alert')).toContainText('Could not save this audio checkpoint');
});

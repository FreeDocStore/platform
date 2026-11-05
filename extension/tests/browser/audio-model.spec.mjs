import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';

test('pinned model generates a decodable recording in a real browser worker', async ({ page }) => {
  test.skip(process.env.AUDIO_MODEL_TEST !== '1', 'Opt-in 93 MB model download and local inference.');
  test.setTimeout(300_000);
  const workerFile = readdirSync('../apps/editor/web/dist/assets').find(f => /^worker-.*\.js$/.test(f));
  const uploads = [];
  page.context().on('request', request => { if (request.method() !== 'GET') uploads.push(request.url()); });
  expect(workerFile).toBeTruthy();
  await page.goto('/_audio');
  const result = await page.evaluate(async workerFile => {
    const worker = new Worker(`/assets/${workerFile}`, { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = async event => {
        if (event.data.type === 'error') { worker.terminate(); reject(new Error(event.data.message)); }
        if (event.data.type !== 'complete') return;
        worker.terminate();
        const context = new AudioContext();
        try {
          const decoded = await context.decodeAudioData(event.data.wav);
          resolve({ duration: decoded.duration, channels: decoded.numberOfChannels, energy: decoded.getChannelData(0).reduce((sum, value) => sum + Math.abs(value), 0) });
        } catch (error) { reject(error); }
        finally { await context.close(); }
      };
      worker.postMessage({ chunks: ['Welcome to FreeDocStore. Your knowledge is ready to read.'] });
    });
  }, workerFile);
  expect(result.duration).toBeGreaterThan(1);
  expect(result.channels).toBe(1);
  expect(result.energy).toBeGreaterThan(1);
  expect(uploads).toEqual([]);
});

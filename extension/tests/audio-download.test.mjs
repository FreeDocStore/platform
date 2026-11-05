import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bundle } from './_bundle.mjs';
const { verifiedDownload } = await import(await bundle('../apps/editor/web/src/audio/download.ts'));
const bytes = new Uint8Array([1, 2, 3, 4]);
const asset = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const url = 'https://example.com/pinned/model';

test('cache read and quota failures do not block verified synthesis assets', async () => {
  let downloaded = 0;
  const cache = { match: async () => { throw Error('denied'); }, put: async () => { throw Error('quota'); } };
  const response = await verifiedDownload(url, asset, { cache, fetch: async (_, init) => {
    downloaded++; assert.equal(init.credentials, 'omit'); return new Response(bytes);
  } });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(downloaded, 1);
});

for (const corrupt of [new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([1]), new Uint8Array([4, 3, 2, 1])]) {
  test(`corrupt cached asset (${corrupt.length} bytes) is evicted and next attempt downloads clean data`, async () => {
    let stored = new Response(corrupt);
    let deleted = 0;
    const cache = { match: async () => stored, delete: async () => { deleted++; stored = undefined; }, put: async () => {} };
    const options = { cache, fetch: async () => new Response(bytes) };
    await assert.rejects(verifiedDownload(url, asset, options), /expected|integrity/);
    assert.equal(deleted, 1);
    assert.deepEqual(new Uint8Array(await (await verifiedDownload(url, asset, options)).arrayBuffer()), bytes);
  });
}

test('an eviction failure preserves the integrity error', async () => {
  const cache = { match: async () => new Response([9]), delete: async () => { throw Error('denied'); } };
  await assert.rejects(verifiedDownload(url, asset, { cache, fetch: async () => { throw Error('unexpected network'); } }), /integrity/);
});

test('a stalled network download times out', async () => {
  await assert.rejects(verifiedDownload(url, asset, { timeoutMs: 10, fetch: (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Error('timed out')));
  }) }), /timed out/);
});

test('progress only emits when the percentage changes', async () => {
  const many = new Uint8Array(1000);
  const progress = [];
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of many) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }));
  await verifiedDownload(url, { bytes: 1000, sha256: createHash('sha256').update(many).digest('hex') }, { fetch: async () => response, progress: p => progress.push(p) });
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.length <= 101);
});

test('a stalled cached stream is cancelled by the same download timeout', async () => {
  let cancelled = false;
  const cache = { match: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), delete: async () => true };
  await assert.rejects(verifiedDownload(url, asset, { cache, timeoutMs: 10, fetch: async () => { throw Error('unexpected'); } }), /abort/i);
  assert.equal(cancelled, true);
});

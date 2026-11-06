import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './_bundle.mjs';

const { isOpusSupported, recordOpus } = await import(await bundle('../templates/read-aloud/src/opus-encoder.js'));

test('unsupported browsers and WebM-only recorders keep the WAV fallback', () => {
  assert.equal(isOpusSupported(undefined), false);
  assert.equal(isOpusSupported({ isTypeSupported: () => false }), false);
  assert.equal(isOpusSupported({ isTypeSupported: type => type.startsWith('audio/webm') }), false);
  assert.equal(isOpusSupported({ isTypeSupported: type => type.startsWith('audio/ogg') }), true);
});

function recorderClass() {
  return class FakeMediaRecorder {
    static isTypeSupported(type) { return type.startsWith('audio/ogg'); }
    static last;
    state = 'inactive';
    constructor(stream, options) { this.stream = stream; this.options = options; FakeMediaRecorder.last = this; }
    start() { this.state = 'recording'; }
    emit(bytes) { this.ondataavailable({ data: new Blob([bytes]) }); }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  };
}

test('recordOpus returns Ogg chunks within configured memory limits', async () => {
  const Recorder = recorderClass();
  const result = recordOpus({}, { MediaRecorder: Recorder, maxChunkBytes: 8, maxBytes: 8 });
  Recorder.last.emit(new Uint8Array([1, 2, 3]));
  result.stop();
  const blob = await result.blob;
  assert.equal(blob.type, 'audio/ogg; codecs=opus');
  assert.equal(blob.size, 3);
});

test('recordOpus cancels and rejects when its bounded output is exceeded', async () => {
  const Recorder = recorderClass();
  const result = recordOpus({}, { MediaRecorder: Recorder, maxChunkBytes: 2, maxBytes: 4 });
  Recorder.last.emit(new Uint8Array([1, 2, 3]));
  await assert.rejects(result.blob, /size limit/);
  await result.cancelled;
});

test('recordOpus responds to cancellation while preserving its completed chunks', async () => {
  const Recorder = recorderClass();
  const abort = new AbortController();
  const result = recordOpus({}, { MediaRecorder: Recorder, signal: abort.signal });
  Recorder.last.emit(new Uint8Array([1, 2]));
  abort.abort(new Error('cancel requested'));
  await assert.rejects(result.blob, /cancel requested/);
  await result.cancelled;
});

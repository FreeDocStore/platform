import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from './_bundle.mjs';
const { startDeploymentPolling } = await import(await bundle('../apps/editor/web/src/services/deployment-polling.ts'));
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(load) {
  let now = 0;
  const timers = [], values = [], errors = [], signals = [];
  const polling = startDeploymentPolling({ load: signal => { signals.push(signal); return load(signal); },
    onValue: value => values.push(value), onError: (error, retry) => errors.push({ error, retry }),
    now: () => now, schedule: (callback, delay) => { const timer = { callback, delay, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; },
  });
  return { polling, timers, values, errors, signals, async next() {
    const timer = timers.find(timer => !timer.cancelled);
    assert.ok(timer, 'a retry must be scheduled'); timer.cancelled = true; now += timer.delay; timer.callback(); await flush();
    return timer.delay;
  }, pending: () => timers.filter(timer => !timer.cancelled) };
}

test('temporary failure recovers and a successful value resets the failure state', async () => {
  let calls = 0;
  const h = harness(async () => { if (++calls === 1) throw Object.assign(new Error('unavailable'), { status: 503 }); return { state: 'live' }; });
  await flush(); assert.equal(h.errors[0].retry.retryInMs, 5000);
  await h.next(); assert.deepEqual(h.values, [{ state: 'live' }]); assert.equal(h.pending().length, 0);
  h.polling.stop();
});

test('manual refresh cannot issue a request before the provider cooldown ends', async () => {
  let calls = 0;
  const h = harness(async () => { if (++calls === 1) throw Object.assign(new Error('limited'), { status: 503, retryAfterSeconds: 120 }); return { state: 'live' }; });
  await flush(); assert.equal(h.errors[0].retry.retryInMs, 120000);
  h.polling.refresh(); h.polling.refresh(); assert.equal(calls, 1);
  assert.equal(h.pending().length, 1); assert.equal(await h.next(), 120000); assert.equal(calls, 2);
  h.polling.stop();
});

test('five consecutive transient failures pause instead of polling indefinitely', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; throw new TypeError('network unavailable'); });
  await flush(); const delays = [];
  while (h.pending().length) delays.push(await h.next());
  assert.deepEqual(delays, [5000, 10000, 20000, 40000]); assert.equal(calls, 5);
  assert.equal(h.errors.at(-1).retry.retryInMs, undefined); assert.equal(h.errors.at(-1).retry.attempts, 5);
  h.polling.stop();
});

test('denied permissions pause for user action rather than retrying as an outage', async () => {
  const h = harness(async () => { throw Object.assign(new Error('permission denied'), { status: 403 }); });
  await flush(); assert.equal(h.pending().length, 0); assert.equal(h.errors[0].retry.retryInMs, undefined);
  h.polling.stop();
});

test('refresh cancels an earlier request and discards its late result', async () => {
  let completeFirst; let calls = 0;
  const h = harness(() => ++calls === 1 ? new Promise(resolve => { completeFirst = resolve; }) : Promise.resolve({ state: 'live' }));
  h.polling.refresh(); await flush(); assert.equal(h.signals[0].aborted, true);
  completeFirst({ state: 'failed' }); await flush();
  assert.deepEqual(h.values, [{ state: 'live' }]); assert.equal(h.pending().length, 0);
  h.polling.stop();
});

test('closing the page cancels outstanding work without starting another request', async () => {
  let complete; const h = harness(() => new Promise(resolve => { complete = resolve; }));
  h.polling.stop(); complete({ state: 'building' }); await flush();
  assert.equal(h.signals[0].aborted, true); assert.equal(h.values.length, 0); assert.equal(h.pending().length, 0);
});

test('waiting for a setup PR polls less frequently than an active build', async () => {
  const h = harness(async () => ({ state: 'awaiting-review' }));
  await flush(); assert.equal(h.pending()[0].delay, 30000); h.polling.stop();
});

test('a raw HTTP 429 without timing information waits at least one minute', async () => {
  const h = harness(async () => { throw Object.assign(new Error('too many requests'), { status: 429 }); });
  await flush(); assert.equal(h.errors[0].retry.retryInMs, 60000); h.polling.stop();
});

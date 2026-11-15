// Tests for lib/poller.mjs: scheduling, backoff and the health record.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../lib/cursor-api.mjs';
import { AUTH_RETRY_MS, MAX_BACKOFF_MS, Poller, RATE_LIMIT_MAX_MS, RATE_LIMIT_MIN_MS } from '../lib/poller.mjs';

function harness(run, intervalMs = 1000) {
  const timers = [];
  let now = 1000;
  const poller = new Poller({
    name: 't',
    intervalMs,
    run,
    now: () => now,
    jitter: () => 0.5, // factor exactly 1
    schedule: (fn, delay) => {
      const t = { fn, delay, cancelled: false, unref() { this.unrefd = true; } };
      timers.push(t);
      return t;
    },
    cancel: (t) => { t.cancelled = true; },
  });
  return { poller, timers, last: () => timers[timers.length - 1], advance: (ms) => { now += ms; } };
}

describe('Poller', () => {
  it('start runs immediately; success reschedules at the interval and records health', async () => {
    let runs = 0;
    const h = harness(async () => { runs += 1; });
    h.poller.start();
    assert.equal(h.last().delay, 0);
    assert.equal(h.last().unrefd, true);
    assert.equal(h.poller.health.status, 'starting');
    await h.poller.tick();
    assert.equal(runs, 1);
    assert.equal(h.last().delay, 1000);
    assert.equal(h.poller.health.status, 'ok');
    assert.equal(h.poller.health.lastOkAt, 1000);
    assert.equal(h.poller.health.nextAt, 2000);
    assert.equal(h.poller.health.lastError, null);
  });

  it('jitter spreads the interval by ±20%', async () => {
    const h = harness(async () => {});
    h.poller.jitter = () => 0;
    h.poller.stopped = false;
    await h.poller.tick();
    assert.equal(h.last().delay, 800);
    h.poller.jitter = () => 0.999;
    await h.poller.tick();
    assert.ok(h.last().delay > 1190 && h.last().delay <= 1200);
  });

  it('failures back off exponentially up to the cap, then recover', async () => {
    let fail = true;
    const h = harness(async () => { if (fail) throw new Error('nope eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl'); });
    h.poller.stopped = false;
    const delays = [];
    for (let i = 0; i < 12; i++) {
      await h.poller.tick();
      delays.push(h.last().delay);
    }
    assert.deepEqual(delays.slice(0, 4), [2000, 4000, 8000, 16000]);
    assert.equal(delays.at(-1), MAX_BACKOFF_MS);
    assert.equal(h.poller.health.status, 'degraded');
    assert.equal(h.poller.health.failures, 12);
    assert.ok(!h.poller.health.lastError.includes('eyJzdWIi'), 'tokens are redacted from the health record');
    fail = false;
    await h.poller.tick();
    assert.equal(h.poller.health.status, 'ok');
    assert.equal(h.poller.health.failures, 0);
    assert.equal(h.last().delay, 1000);
  });

  it('a rejected session waits five minutes and is reported as auth', async () => {
    const h = harness(async () => { throw new ApiError('no', { status: 401 }); });
    h.poller.stopped = false;
    await h.poller.tick();
    assert.equal(h.poller.health.status, 'auth');
    assert.equal(h.last().delay, AUTH_RETRY_MS);
    const h2 = harness(async () => { throw new ApiError('not signed in', { kind: 'auth' }); });
    h2.poller.stopped = false;
    await h2.poller.tick();
    assert.equal(h2.poller.health.status, 'auth');
  });

  it('a rate limit waits at least a minute and honours Retry-After up to an hour', async () => {
    const h = harness(async () => { throw new ApiError('slow', { status: 429 }); });
    h.poller.stopped = false;
    await h.poller.tick();
    assert.equal(h.last().delay, RATE_LIMIT_MIN_MS);
    assert.equal(h.poller.health.backoffReason, 'rate limited');
    const h2 = harness(async () => { throw new ApiError('slow', { status: 429, retryAfterMs: 10 * 60_000 }); });
    h2.poller.stopped = false;
    await h2.poller.tick();
    assert.equal(h2.last().delay, 10 * 60_000);
    const h3 = harness(async () => { throw new ApiError('slow', { status: 429, retryAfterMs: 5 * 60 * 60_000 }); });
    h3.poller.stopped = false;
    await h3.poller.tick();
    assert.equal(h3.last().delay, RATE_LIMIT_MAX_MS);
  });

  it('a tick while one is running is a no-op, and stop cancels the timer', async () => {
    let release;
    let runs = 0;
    const h = harness(() => { runs += 1; return new Promise((r) => { release = r; }); });
    h.poller.stopped = false;
    const first = h.poller.tick();
    await h.poller.tick();
    assert.equal(runs, 1);
    release();
    await first;
    const timer = h.last();
    h.poller.stop();
    assert.equal(timer.cancelled, true);
    assert.equal(h.poller.health.status, 'off');
    const count = h.timers.length;
    const afterStop = h.poller.tick();
    release();
    await afterStop;
    assert.equal(h.timers.length, count, 'a stopped poller does not reschedule');
  });
});

// Repeating work with backoff, jitter and a health record, so one failing source never
// stops the others and the dashboard can say exactly which source is unhappy and why.

import { ApiError } from './cursor-api.mjs';
import { redact } from './config.mjs';

export const MAX_BACKOFF_MS = 5 * 60_000;
export const AUTH_RETRY_MS = 5 * 60_000;
export const RATE_LIMIT_MIN_MS = 60_000;
export const RATE_LIMIT_MAX_MS = 60 * 60_000;

export class Poller {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {number} opts.intervalMs   may be changed at any time; the next delay reads it after each run
   * @param {() => Promise<void>} opts.run
   * @param {(err: Error) => void} [opts.onError]
   * @param {() => number} [opts.jitter]  returns a number in [0, 1); replace in tests
   */
  constructor({ name, intervalMs, run, onError = () => {}, now = Date.now, schedule = setTimeout, cancel = clearTimeout, jitter = Math.random }) {
    this.name = name;
    this.intervalMs = intervalMs;
    this.run = run;
    this.onError = onError;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.jitter = jitter;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.failures = 0;
    this.health = { status: 'off', lastOkAt: null, lastAttemptAt: null, lastError: null, nextAt: null, failures: 0, backoffReason: null };
  }

  start() {
    this.stopped = false;
    this.health.status = 'starting';
    this.queue(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    this.health.status = 'off';
    this.health.nextAt = null;
  }

  /** Run now (unless a run is in flight) and reschedule. */
  async tick() {
    if (this.running) return;
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.running = true;
    this.health.lastAttemptAt = this.now();
    let delay;
    try {
      await this.run();
      this.failures = 0;
      this.health.status = 'ok';
      this.health.lastOkAt = this.now();
      this.health.lastError = null;
      this.health.backoffReason = null;
      delay = this.withJitter(this.intervalMs);
    } catch (err) {
      this.failures += 1;
      this.health.lastError = redact(err && err.message ? err.message : String(err));
      if (err instanceof ApiError && (err.isAuth || err.kind === 'auth')) {
        this.health.status = 'auth';
        this.health.backoffReason = 'session rejected';
        delay = AUTH_RETRY_MS;
      } else if (err instanceof ApiError && err.isRateLimit) {
        this.health.status = 'degraded';
        this.health.backoffReason = 'rate limited';
        const hinted = Number.isFinite(err.retryAfterMs) ? err.retryAfterMs : 0;
        delay = Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, hinted, this.intervalMs * 2 ** Math.min(this.failures, 6)));
      } else {
        this.health.status = 'degraded';
        this.health.backoffReason = err instanceof ApiError && err.isServer ? 'server error' : 'error';
        delay = Math.min(this.intervalMs * 2 ** Math.min(this.failures, 20), MAX_BACKOFF_MS);
      }
      this.onError(err);
    } finally {
      this.health.failures = this.failures;
      this.running = false;
      if (!this.stopped) this.queue(delay);
    }
  }

  withJitter(ms) {
    const factor = 0.8 + 0.4 * this.jitter();
    return Math.round(ms * factor);
  }

  queue(delay) {
    if (this.stopped) return;
    if (this.timer) this.cancel(this.timer);
    this.health.nextAt = this.now() + delay;
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }
}

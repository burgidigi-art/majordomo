// Tests for lib/cursor-api.mjs: the Connect and dashboard calls, token lifecycle, normalizers.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, CursorClient, REFRESH_LEAD_MS, normalizeUsageEvent, parseTimestamp, retryAfterMs } from '../lib/cursor-api.mjs';

const NOW = 1_763_164_800_000;
const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`;
const farExp = Math.floor((NOW + 30 * 86_400_000) / 1000);
const response = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

function makeClient({ auth, routes, saved = [], ended = [] }) {
  const calls = [];
  let current = auth;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const handler = routes.find(([match]) => url.includes(match));
    if (!handler) return response(404, {});
    return handler[1](url, init, calls);
  };
  const client = new CursorClient({
    getAuth: () => current,
    saveAuth: (next) => {
      saved.push(next);
      current = next;
    },
    onSessionEnded: () => ended.push(true),
    fetchImpl,
    apiBase: 'https://api.test',
    dashboardBase: 'https://dash.test',
    machineId: 'ab'.repeat(32),
    now: () => NOW,
  });
  return { client, calls, setAuth: (a) => (current = a) };
}

describe('connect', () => {
  it('posts JSON to /aiserver.v1.<Service>/<Method> with the app headers', async () => {
    const token = jwt({ sub: 'auth0|u1', exp: farExp });
    const { client, calls } = makeClient({ auth: { source: 'login', accessToken: token, refreshToken: 'r' }, routes: [['GetMe', () => response(200, { email: 'a@b.c' })]] });
    assert.deepEqual(await client.getMe(), { email: 'a@b.c' });
    assert.equal(calls[0].url, 'https://api.test/aiserver.v1.DashboardService/GetMe');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
    assert.equal(calls[0].init.body, '{}');
    assert.ok(calls[0].init.signal, 'every request has a timeout');
  });

  it('turns failures into ApiError with status, kind and Retry-After', async () => {
    const token = jwt({ sub: 'u', exp: farExp });
    const { client } = makeClient({
      auth: { source: 'env', accessToken: token },
      routes: [
        ['GetMe', () => response(429, 'slow down', { 'retry-after': '120' })],
        ['GetSandUsageStatus', () => response(503, 'down')],
        ['GetCurrentPeriodUsage', () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); }],
      ],
    });
    await assert.rejects(client.getMe(), (err) => err instanceof ApiError && err.isRateLimit && err.retryAfterMs === 120_000);
    await assert.rejects(client.sandUsageStatus(), (err) => err.isServer && !err.isAuth);
    await assert.rejects(client.currentPeriodUsage(), (err) => err.kind === 'network' && /timed out/.test(err.message));
  });

  it('never puts the token in an error', async () => {
    const token = jwt({ sub: 'u', exp: farExp });
    const { client } = makeClient({ auth: { source: 'env', accessToken: token }, routes: [['GetMe', () => response(401, 'no')]] });
    await assert.rejects(client.getMe(), (err) => !err.message.includes(token) && !String(err.url).includes(token));
  });

  it('on a 401 refreshes our own session once and retries', async () => {
    const oldToken = jwt({ sub: 'u', exp: farExp, v: 1 });
    const newToken = jwt({ sub: 'u', exp: farExp, v: 2 });
    const saved = [];
    let meCalls = 0;
    const { client } = makeClient({
      auth: { source: 'login', accessToken: oldToken, refreshToken: 'refresh-1' },
      saved,
      routes: [
        ['oauth/token', () => response(200, { access_token: newToken, refresh_token: 'refresh-2' })],
        ['GetMe', (url, init) => {
          meCalls += 1;
          return init.headers.authorization === `Bearer ${newToken}` ? response(200, { email: 'ok' }) : response(401, 'expired');
        }],
      ],
    });
    assert.deepEqual(await client.getMe(), { email: 'ok' });
    assert.equal(meCalls, 2);
    assert.equal(saved[0].accessToken, newToken);
    assert.equal(saved[0].refreshToken, 'refresh-2');
  });
});

describe('token lifecycle', () => {
  it('refreshes a login session well before expiry, once, however many callers wait', async () => {
    const soon = jwt({ sub: 'u', exp: Math.floor((NOW + REFRESH_LEAD_MS - 60_000) / 1000) });
    const fresh = jwt({ sub: 'u', exp: farExp });
    let refreshes = 0;
    const { client } = makeClient({
      auth: { source: 'login', accessToken: soon, refreshToken: 'r' },
      routes: [['oauth/token', async () => {
        refreshes += 1;
        await new Promise((r) => setTimeout(r, 5));
        return response(200, { access_token: fresh });
      }]],
    });
    const [a, b] = await Promise.all([client.token(), client.token()]);
    assert.equal(a, fresh);
    assert.equal(b, fresh);
    assert.equal(refreshes, 1);
  });

  it('never refreshes a borrowed app session or an env token', async () => {
    const soon = jwt({ sub: 'u', exp: Math.floor((NOW + 60_000) / 1000) });
    for (const source of ['app', 'env']) {
      const { client, calls } = makeClient({ auth: { source, accessToken: soon, refreshToken: 'should-not-be-used' }, routes: [] });
      assert.equal(await client.token(), soon);
      assert.equal(calls.length, 0);
    }
  });

  it('explains an expired session, differently for the app session', async () => {
    const expired = jwt({ sub: 'u', exp: Math.floor((NOW - 1000) / 1000) });
    const app = makeClient({ auth: { source: 'app', accessToken: expired }, routes: [] });
    await assert.rejects(app.client.token(), (err) => err.kind === 'auth' && /Open Grok Bot/.test(err.message));
    const own = makeClient({ auth: { source: 'login', accessToken: expired, refreshToken: null }, routes: [] });
    await assert.rejects(own.client.token(), /grokbot-model-watch login/);
    const none = makeClient({ auth: null, routes: [] });
    await assert.rejects(none.client.token(), /Not signed in/);
  });

  it('treats shouldLogout as the end of the session', async () => {
    const soon = jwt({ sub: 'u', exp: Math.floor((NOW + 60_000) / 1000) });
    const ended = [];
    const { client } = makeClient({ auth: { source: 'login', accessToken: soon, refreshToken: 'r' }, ended, routes: [['oauth/token', () => response(200, { shouldLogout: true })]] });
    await assert.rejects(client.token(), (err) => err.kind === 'session-ended');
    assert.equal(ended.length, 1);
  });
});

describe('dashboard', () => {
  it('falls back to the other cookie spelling on 401 and remembers which worked', async () => {
    const token = jwt({ sub: 'auth0|user_1', exp: farExp });
    const cookies = [];
    const { client } = makeClient({
      auth: { source: 'env', accessToken: token },
      routes: [['/api/x', (url, init) => {
        cookies.push(init.headers.cookie);
        return init.headers.cookie.includes('auth0%7C') ? response(200, { ok: true }) : response(401, 'no');
      }]],
    });
    assert.deepEqual(await client.dashboard('/api/x', { a: 1 }), { ok: true });
    assert.equal(cookies.length, 2);
    await client.dashboard('/api/x', { a: 1 });
    assert.equal(cookies.length, 3, 'the working spelling is tried first next time');
    assert.ok(cookies[2].includes('auth0%7C'));
  });

  it('POSTs carry Origin and Referer; GETs do not', async () => {
    const token = jwt({ sub: 'u', exp: farExp });
    const seen = [];
    const { client } = makeClient({ auth: { source: 'env', accessToken: token }, routes: [['/api/y', (url, init) => { seen.push(init); return response(200, {}); }]] });
    await client.dashboard('/api/y', { q: 1 });
    await client.dashboard('/api/y');
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].headers.origin, 'https://dash.test');
    assert.ok(seen[0].headers.referer.startsWith('https://dash.test/'));
    assert.equal(seen[1].method, 'GET');
    assert.equal(seen[1].headers.origin, undefined);
  });
});

describe('usageEvents', () => {
  const token = jwt({ sub: 'u', exp: farExp });
  it('sends ms strings, normalizes rows and sorts newest first', async () => {
    let body;
    const { client } = makeClient({
      auth: { source: 'env', accessToken: token },
      routes: [['get-filtered-usage-events', (url, init) => {
        body = JSON.parse(init.body);
        return response(200, { totalUsageEventsCount: '2', usageEventsDisplay: [
          { timestamp: '1763164700000', model: 'grok-bot-default', kind: 'Included', tokenUsage: { inputTokens: 10, outputTokens: '2' } },
          { timestamp: 1763164750, model: 'grok-bot-cua', tokenUsage: {} },
          { model: 'no-timestamp' },
        ] });
      }]],
    });
    const got = await client.usageEvents({ startDate: -5, endDate: NOW, page: 2, pageSize: 50, userId: 7 });
    assert.deepEqual(body, { page: 2, pageSize: 50, startDate: '0', endDate: String(NOW), userId: 7 });
    assert.equal(got.via, 'dashboard');
    assert.equal(got.total, 2);
    assert.deepEqual(got.events.map((e) => e.model), ['grok-bot-cua', 'grok-bot-default']);
    assert.equal(got.events[0].at, 1763164750000);
    assert.deepEqual(got.events[1].tokens, { in: 10, out: 2, cacheWrite: 0, cacheRead: 0 });
  });

  it('reports the dashboard failure when the speculative RPC fallback also fails, and uses it when it works', async () => {
    const failing = makeClient({ auth: { source: 'env', accessToken: token }, routes: [['get-filtered-usage-events', () => response(403, 'csrf')], ['GetFilteredUsageEvents', () => response(404, 'unimplemented')]] });
    await assert.rejects(failing.client.usageEvents({}), (err) => err.status === 403);
    const working = makeClient({ auth: { source: 'env', accessToken: token }, routes: [['get-filtered-usage-events', () => response(403, 'csrf')], ['GetFilteredUsageEvents', () => response(200, { usageEvents: [{ timestamp: '1763164700000', model: 'm' }] })]] });
    const got = await working.client.usageEvents({});
    assert.equal(got.via, 'connect');
    assert.equal(got.events.length, 1);
  });

  it('dailySpendByCategory asks for the per-Bot grouping and normalizes rows', async () => {
    let body;
    const { client } = makeClient({ auth: { source: 'env', accessToken: token }, routes: [['GetDailySpendByCategory', (url, init) => {
      body = JSON.parse(init.body);
      return response(200, { dailySpend: [{ day: '1763078400000', category: 'Research Bot', spendCents: 12, totalTokens: '3400' }], categories: ['Research Bot'] });
    }]] });
    const got = await client.dailySpendByCategory({ periodStartMs: 1, periodEndMs: 2, userId: 5 });
    assert.equal(body.groupBy, 'SPEND_GROUP_BY_CATEGORY_GROK_BOT');
    assert.equal(body.periodStartMs, '1');
    assert.equal(body.userId, 5);
    assert.deepEqual(got.rows, [{ day: 1763078400000, category: 'Research Bot', cents: 12, tokens: 3400 }]);
  });
});

describe('normalizers', () => {
  it('parseTimestamp accepts ms, seconds, strings, ISO and protobuf Timestamp objects', () => {
    assert.equal(parseTimestamp(1763164800000), 1763164800000);
    assert.equal(parseTimestamp('1763164800000'), 1763164800000);
    assert.equal(parseTimestamp(1763164800), 1763164800000);
    assert.equal(parseTimestamp('2026-11-15T00:00:00Z'), Date.parse('2026-11-15T00:00:00Z'));
    assert.equal(parseTimestamp({ seconds: '10', nanos: 5e8 }), 10_500);
    for (const bad of [null, undefined, '', 'soon', {}, NaN]) assert.equal(parseTimestamp(bad), null);
  });

  it('normalizeUsageEvent keeps what attribution needs and builds a full-row key', () => {
    const a = normalizeUsageEvent({ timestamp: '1763164800000', model: 'grok-bot-default', kind: 'K', isHeadless: true, owningUser: 'me@x.y', tokenUsage: { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4, totalCents: 0.5 } });
    assert.equal(a.isHeadless, true);
    assert.equal(a.owningUser, 'me@x.y');
    assert.equal(a.cents, 0.5);
    const b = normalizeUsageEvent({ timestamp: '1763164800000', model: 'grok-bot-default', kind: 'K', tokenUsage: { inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4 } });
    assert.notEqual(a.key, b.key, 'isHeadless is part of the key');
    assert.equal(normalizeUsageEvent({ timestamp: 1 }).model, 'unknown');
    assert.equal(normalizeUsageEvent(null), null);
    assert.equal(normalizeUsageEvent({ model: 'x' }), null);
  });

  it('retryAfterMs reads seconds and HTTP dates', () => {
    assert.equal(retryAfterMs('30'), 30_000);
    assert.equal(retryAfterMs(new Date(NOW + 5000).toUTCString(), NOW), 5000);
    assert.equal(retryAfterMs(null), null);
    assert.equal(retryAfterMs('garbage'), null);
  });
});

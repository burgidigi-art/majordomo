// A small client for the two Cursor backends the companion reads from:
//  - api2.cursor.sh  (Connect RPC, JSON codec)  — the Grok Bot and dashboard services
//  - cursor.com      (dashboard HTTP API, cookie) — the per-request usage ledger
//
// Only read calls are made. Tokens never appear in errors or logs. Everything here is an
// undocumented interface reconstructed from the desktop app by community projects; it can
// change without notice, so unknown fields are ignored and failures are reported per call.

import { API_BASE, DASHBOARD_BASE, connectHeaders, dashboardCookieCandidates, dashboardHeaders, jwtExpMs, refreshTokens } from './cursor-auth.mjs';

/** Refresh our own session this long before it expires, so a laptop that was off for a week still works. */
export const REFRESH_LEAD_MS = 7 * 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 25_000;

export class ApiError extends Error {
  constructor(message, { status = 0, body = '', url = '', kind = 'http', retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
  get isAuth() {
    return this.status === 401 || this.status === 403;
  }
  get isRateLimit() {
    return this.status === 429;
  }
  get isServer() {
    return this.status >= 500;
  }
}

/** `Retry-After` as milliseconds (seconds or an HTTP date), or null. */
export function retryAfterMs(header, nowMs = Date.now()) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - nowMs) : null;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`Unexpected non-JSON response (HTTP ${res.status})`, { status: res.status, body: text.slice(0, 300), kind: 'parse' });
  }
}

export class CursorClient {
  /**
   * @param {object} opts
   * @param {() => (object|null|Promise<object|null>)} opts.getAuth  `{source, accessToken, refreshToken?, reload?}` or null
   * @param {(auth: object) => void} [opts.saveAuth]  persists a refreshed own session
   * @param {() => void} [opts.onSessionEnded]  Cursor told us to log out, or refreshing failed for good
   */
  constructor({
    getAuth,
    saveAuth = () => {},
    onSessionEnded = () => {},
    fetchImpl = fetch,
    apiBase = API_BASE,
    dashboardBase = DASHBOARD_BASE,
    clientVersion = '0.75.0',
    machineId,
    platform = process.platform,
    now = Date.now,
    log = () => {},
  }) {
    if (!machineId) throw new Error('CursorClient needs a machineId');
    this.getAuth = getAuth;
    this.saveAuth = saveAuth;
    this.onSessionEnded = onSessionEnded;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.dashboardBase = dashboardBase.replace(/\/$/, '');
    this.clientVersion = clientVersion;
    this.machineId = machineId;
    this.platform = platform;
    this.now = now;
    this.log = log;
    /** Which cookie spelling the dashboard accepted last time (index into the candidates). */
    this.cookieIndex = 0;
    this.refreshing = null;
    this.sessionEnded = false;
  }

  /** The current access token; our own session is refreshed well before it expires. */
  async token({ forceRefresh = false } = {}) {
    const auth = await this.getAuth();
    if (!auth || !auth.accessToken) throw new ApiError('Not signed in to Cursor. Run `grokbot-model-watch login`.', { status: 0, kind: 'auth' });
    const exp = jwtExpMs(auth.accessToken);
    const needsRefresh = forceRefresh || (exp !== null && exp - this.now() < REFRESH_LEAD_MS);
    if (needsRefresh && auth.refreshToken && auth.source === 'login') {
      try {
        return await this.refresh(auth);
      } catch (err) {
        this.log(`token refresh failed: ${err.message}`);
        if (err instanceof ApiError && err.kind === 'session-ended') throw err;
      }
    }
    if (exp !== null && exp <= this.now()) {
      throw new ApiError(
        auth.source === 'app'
          ? 'The Grok Bot app session has expired. Open Grok Bot so it signs in again; the companion re-reads it automatically.'
          : 'The Cursor session has expired. Run `grokbot-model-watch login`.',
        { status: 401, kind: 'auth' },
      );
    }
    return auth.accessToken;
  }

  /** One refresh at a time, shared by every caller. */
  refresh(auth) {
    if (!this.refreshing) {
      this.refreshing = refreshTokens(auth.refreshToken, { apiBase: this.apiBase, fetchImpl: this.fetchImpl })
        .then(async (fresh) => {
          if (fresh.shouldLogout) {
            this.sessionEnded = true;
            this.onSessionEnded();
            throw new ApiError('Cursor ended this session. Run `grokbot-model-watch login`.', { status: 401, kind: 'session-ended' });
          }
          const next = { ...auth, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken };
          await this.saveAuth(next);
          return next.accessToken;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  /** After a 401: refresh our own session, or re-read a borrowed app session, then let the caller retry once. */
  async recoverFromUnauthorized() {
    const auth = await this.getAuth();
    if (!auth) return false;
    if (auth.source === 'login' && auth.refreshToken) {
      try {
        await this.refresh(auth);
        return true;
      } catch {
        return false;
      }
    }
    if (auth.source === 'app' && typeof auth.reload === 'function') {
      try {
        const next = await auth.reload();
        return Boolean(next && next.accessToken && next.accessToken !== auth.accessToken);
      } catch {
        return false;
      }
    }
    return false;
  }

  async send(url, init, label) {
    let res;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new ApiError(`${label}: ${err && err.name === 'TimeoutError' ? 'timed out' : err && err.message ? err.message : String(err)}`, { url, kind: 'network' });
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 400);
      throw new ApiError(`${label} failed with HTTP ${res.status}`, { status: res.status, body: text, url, retryAfterMs: retryAfterMs(res.headers.get('retry-after'), this.now()) });
    }
    return readBody(res);
  }

  /** One Connect RPC unary call with the JSON codec. int64 fields travel as strings. */
  async connect(service, method, body = {}, { retried = false } = {}) {
    const token = await this.token();
    const url = `${this.apiBase}/aiserver.v1.${service}/${method}`;
    try {
      return await this.send(
        url,
        { method: 'POST', headers: connectHeaders({ token, machineId: this.machineId, clientVersion: this.clientVersion, platform: this.platform, nowMs: this.now() }), body: JSON.stringify(body) },
        `${service}/${method}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && !retried && (await this.recoverFromUnauthorized())) {
        return this.connect(service, method, body, { retried: true });
      }
      throw err;
    }
  }

  /** A cursor.com dashboard call, retrying once with the other cookie spelling on 401/403. */
  async dashboard(pathname, body = null, { retried = false } = {}) {
    const token = await this.token();
    const candidates = dashboardCookieCandidates(token);
    const order = [this.cookieIndex, ...candidates.map((_, i) => i).filter((i) => i !== this.cookieIndex)].filter((i) => i < candidates.length);
    let lastErr = null;
    for (const index of order) {
      const url = `${this.dashboardBase}${pathname}`;
      try {
        const parsed = await this.send(
          url,
          {
            method: body === null ? 'GET' : 'POST',
            headers: dashboardHeaders({ cookie: candidates[index], forPost: body !== null, dashboardBase: this.dashboardBase, clientVersion: this.clientVersion }),
            body: body === null ? undefined : JSON.stringify(body),
          },
          pathname,
        );
        this.cookieIndex = index;
        return parsed;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof ApiError) || !err.isAuth) break;
      }
    }
    if (lastErr instanceof ApiError && lastErr.status === 401 && !retried && (await this.recoverFromUnauthorized())) {
      return this.dashboard(pathname, body, { retried: true });
    }
    throw lastErr;
  }

  // ---------- typed calls ----------

  getMe() {
    return this.connect('DashboardService', 'GetMe', {});
  }

  /** Weekly Grok Bot allowance: usagePercent, nextResetTimestampUtc, grokPlanLabel, billingBrand, ... */
  sandUsageStatus() {
    return this.connect('DashboardService', 'GetSandUsageStatus', {});
  }

  currentPeriodUsage() {
    return this.connect('DashboardService', 'GetCurrentPeriodUsage', {});
  }

  /** Usage grouped by model intent for the period. */
  aggregatedUsage({ teamId = 0, startDate, endDate, userId } = {}) {
    const body = { teamId };
    if (startDate !== undefined) body.startDate = String(Math.floor(startDate));
    if (endDate !== undefined) body.endDate = String(Math.floor(endDate));
    if (userId !== undefined && userId !== null) body.userId = userId;
    return this.connect('DashboardService', 'GetAggregatedUsageEvents', body);
  }

  /**
   * Daily spend grouped by a category. With `groupBy: 'GROK_BOT'` this is the desktop app's
   * own "Grok Bot usage — By Bot" chart: Cursor's per-Bot totals, the one direct per-Bot
   * usage figure that exists.
   */
  async dailySpendByCategory({ periodStartMs, periodEndMs, groupBy = 'GROK_BOT', userId, teamId, spendType = 'ALL' } = {}) {
    const body = { periodStartMs: String(Math.floor(periodStartMs)), periodEndMs: String(Math.floor(periodEndMs)), groupBy: `SPEND_GROUP_BY_CATEGORY_${groupBy}`, spendType: `SPEND_TYPE_${spendType}` };
    if (userId !== undefined && userId !== null) body.userId = userId;
    if (teamId !== undefined && teamId !== null) body.teamId = teamId;
    const raw = await this.connect('DashboardService', 'GetDailySpendByCategory', body);
    const rows = Array.isArray(raw && raw.dailySpend) ? raw.dailySpend : [];
    return {
      rows: rows
        .map((r) => ({ day: parseTimestamp(r.day), category: typeof r.category === 'string' ? r.category : '', cents: num(r.spendCents), tokens: num(r.totalTokens) }))
        .filter((r) => r.day !== null),
      categories: Array.isArray(raw && raw.categories) ? raw.categories.filter((c) => typeof c === 'string') : [],
    };
  }

  /**
   * The per-request usage ledger. Tries the dashboard endpoint first (what the web
   * dashboard uses), then the Connect RPC of the same name, which is speculative. Returns
   * normalized events, newest first, plus the total count when the server reports one.
   */
  async usageEvents({ startDate, endDate, page = 1, pageSize = 100, teamId, userId } = {}) {
    const body = { page, pageSize };
    if (startDate !== undefined) body.startDate = String(Math.max(0, Math.floor(startDate)));
    if (endDate !== undefined) body.endDate = String(Math.floor(endDate));
    if (teamId !== undefined && teamId !== null) body.teamId = teamId;
    if (userId !== undefined && userId !== null) body.userId = userId;

    let raw;
    let via = 'dashboard';
    try {
      raw = await this.dashboard('/api/dashboard/get-filtered-usage-events', body);
    } catch (err) {
      if (!(err instanceof ApiError) || err.kind === 'network') throw err;
      via = 'connect';
      try {
        raw = await this.connect('DashboardService', 'GetFilteredUsageEvents', { teamId: teamId ?? 0, ...body });
      } catch {
        throw err; // report the dashboard failure; the RPC fallback is a guess
      }
    }
    const list = Array.isArray(raw && raw.usageEventsDisplay)
      ? raw.usageEventsDisplay
      : Array.isArray(raw && raw.usageEvents)
        ? raw.usageEvents
        : Array.isArray(raw && raw.events)
          ? raw.events
          : [];
    const events = list.map(normalizeUsageEvent).filter(Boolean).sort((a, b) => b.at - a.at);
    const total = raw && Number.isFinite(Number(raw.totalUsageEventsCount)) ? Number(raw.totalUsageEventsCount) : null;
    return { events, total, via };
  }
}

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** Accept ms-since-epoch (number or string), seconds, an ISO string, or a protobuf Timestamp object. */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') {
    if (value.seconds === undefined && value.nanos === undefined) return null;
    return Number(value.seconds || 0) * 1000 + Math.floor(Number(value.nanos || 0) / 1e6);
  }
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

/** One ledger row in a shape the rest of the companion understands. */
export function normalizeUsageEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = parseTimestamp(raw.timestamp ?? raw.timestampMs ?? raw.createdAt);
  if (at === null) return null;
  const usage = raw.tokenUsage && typeof raw.tokenUsage === 'object' ? raw.tokenUsage : {};
  const tokens = {
    in: num(usage.inputTokens ?? usage.input_tokens),
    out: num(usage.outputTokens ?? usage.output_tokens),
    cacheWrite: num(usage.cacheWriteTokens ?? usage.cache_write_tokens),
    cacheRead: num(usage.cacheReadTokens ?? usage.cache_read_tokens),
  };
  const model = typeof raw.model === 'string' && raw.model ? raw.model : 'unknown';
  const kind = typeof raw.kind === 'string' ? raw.kind : typeof raw.kindLabel === 'string' ? raw.kindLabel : '';
  const cents = num(usage.totalCents ?? raw.chargedCents);
  const owningUser = typeof raw.owningUser === 'string' ? raw.owningUser : typeof raw.userEmail === 'string' ? raw.userEmail : null;
  return {
    at,
    model,
    kind,
    tokens,
    cents,
    isHeadless: raw.isHeadless === true,
    isChargeable: raw.isChargeable === true,
    owningUser,
    key: `${at}|${model}|${tokens.in}|${tokens.out}|${tokens.cacheWrite}|${tokens.cacheRead}|${kind}|${raw.isHeadless === true ? 'h' : ''}`,
  };
}

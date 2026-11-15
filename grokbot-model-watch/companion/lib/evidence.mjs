// What we know about the model behind each Bot, and how sure we are.
//
// Every piece of evidence carries a grade:
//   A  — Cursor's inference hook (Enterprise) sent a signed frame naming the Cursor model
//        identifier about to serve one request. Cursor says to use that field "for
//        reporting, not allowlisting": it is Cursor's label, which may be an alias.
//   H  — experimental: the model slug in a Cursor agent-hook payload, reported by this
//        plugin's hook from inside the Bot's harness, if Grok Bot runs plugin hooks at all.
//   B  — a row of the Cursor usage ledger, matched by timing to the Bot that was working.
//        For Bot work Cursor writes grok-bot-default / -automation / -cua, which name the
//        kind of turn, not the model. A concrete model id in a row that coincides with a
//        Bot's run is most likely the user's own Cursor IDE or CLI traffic, so it is kept
//        apart ("coincident") and never shown as the Bot's model.
//   B2 — a change in the usage-by-model-intent aggregate while Bots were working. The
//        total includes the user's own IDE/CLI use, so it is never attributed to a Bot.
//   C  — what the Bot said about itself: a quote, not evidence.
// The dashboard, the MCP tools and the skill all show the grade next to the claim.

export const GRADES = Object.freeze({
  A: {
    grade: 'A',
    title: 'Signed per-request identifier',
    summary: "A signed frame from Cursor's inference hook naming the Cursor model identifier about to serve one request. Cursor says to use it for reporting, not allowlisting: it is Cursor's label and can itself be an alias.",
    strength: 'signed',
  },
  H: {
    grade: 'H',
    title: 'Plugin hook report (experimental)',
    summary: "The model slug in Cursor's agent-hook payload, reported by this plugin's hook from inside the Bot's harness. Whether Grok Bot runs plugin hooks is undocumented, so this may never fire; Cursor describes the field as the slug configured for the conversation, and it can be a mask or alias.",
    strength: 'hook',
  },
  B: {
    grade: 'B',
    title: 'Usage ledger',
    summary: 'A row of your Cursor usage ledger matched by timing to the Bot that was working. For Bot work Cursor writes grok-bot-* labels that name the kind of turn, not the model.',
    strength: 'ledger',
  },
  B2: {
    grade: 'B2',
    title: 'Aggregate hint (experimental)',
    summary: 'Usage grouped by model intent grew while Bots were working. The total also includes your own Cursor IDE or CLI use, so it is never attributed to one Bot.',
    strength: 'hint',
  },
  C: {
    grade: 'C',
    title: 'What the Bot said about itself',
    summary: "A quote, not evidence. Models cannot reliably identify themselves, and Grok Bot's instructions may tell a Bot to present as Grok.",
    strength: 'quote',
  },
});

/** Where the mask labels come from, in words the UI can show. */
export const MASK_MODES = Object.freeze({
  default: { mode: 'chat', display: 'chat turn' },
  automation: { mode: 'routine', display: 'routine run' },
  cua: { mode: 'computer-use', display: 'computer use' },
});

const FAMILIES = [
  { family: 'Anthropic Claude', test: /claude|opus|sonnet|haiku/i },
  { family: 'xAI Grok', test: /grok/i },
  { family: 'OpenAI', test: /(^|[-_/ ])(gpt|o[1-9](?![0-9a-z])|codex|openai)/i },
  { family: 'Google Gemini', test: /gemini/i },
  { family: 'DeepSeek', test: /deepseek/i },
  { family: 'Kimi', test: /kimi|moonshot/i },
  { family: 'Meta', test: /llama|muse/i },
  { family: 'Cursor', test: /composer|^cursor-small|^cursor-fast/i },
];

/**
 * Explain a usage label or model identifier. `opaque` is true when it hides the model.
 * `kind` is one of `grok-bot-mask`, `opaque-alias`, `model-id`, `unrecognized-label`, `unknown`.
 * For `model-id` the vendor family is inferred from the string and `familyNote` says so.
 */
export function classifyLabel(label) {
  const raw = typeof label === 'string' ? label.trim() : '';
  if (!raw || raw === 'unknown') return { label: raw || 'unknown', kind: 'unknown', mode: null, family: null, familyNote: null, opaque: true, display: 'unknown label' };
  const lower = raw.toLowerCase();
  const mask = /^grok-bot-(.+)$/.exec(lower);
  if (mask) {
    const mode = MASK_MODES[mask[1]] || { mode: 'other', display: mask[1] };
    return { label: raw, kind: 'grok-bot-mask', mode: mode.mode, family: null, familyNote: null, opaque: true, display: `Grok Bot ${mode.display} (model hidden)` };
  }
  if (/^sand-/.test(lower)) {
    const mode = MASK_MODES[lower.slice('sand-'.length)];
    return {
      label: raw,
      kind: 'opaque-alias',
      mode: mode ? mode.mode : 'alias',
      family: null,
      familyNote: null,
      opaque: true,
      display: mode ? `Grok Bot ${mode.display} (model hidden)` : `Cursor alias ${raw} (model hidden)`,
    };
  }
  const family = FAMILIES.find((f) => f.test.test(raw));
  if (family) {
    return { label: raw, kind: 'model-id', mode: null, family: family.family, familyNote: `name suggests ${family.family}`, opaque: false, display: raw };
  }
  return { label: raw, kind: 'unrecognized-label', mode: null, family: null, familyNote: null, opaque: true, display: `${raw} (unrecognized label, could be a Cursor product alias)` };
}

/** Strip control characters, collapse whitespace, cap the length. For anything a Bot or Cursor sent us. */
export function sanitizeText(value, max = 200) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Which Bots were working when. `observe` is fed from the status poll; a window stays
 * open for `graceMs` after a Bot stops, because ledger rows land a little late.
 */
export class RunningWindows {
  constructor({ graceMs = 20_000, maxAgeMs = 12 * 60 * 60_000 } = {}) {
    this.graceMs = graceMs;
    this.maxAgeMs = maxAgeMs;
    /** agentId -> [{ start, end|null }] */
    this.windows = new Map();
  }
  observe(agentId, isRunning, now) {
    const list = this.windows.get(agentId) || [];
    const open = list.length && list[list.length - 1].end === null ? list[list.length - 1] : null;
    if (isRunning && !open) list.push({ start: now, end: null });
    if (!isRunning && open) open.end = now;
    this.windows.set(agentId, list);
    this.prune(now - this.maxAgeMs);
  }
  /** Mark a Bot as busy around a known moment, e.g. a transcript turn seen later. */
  observeSpan(agentId, start, end) {
    const list = this.windows.get(agentId) || [];
    if (!list.some((w) => w.start <= start && (w.end === null || w.end >= end))) list.push({ start, end });
    list.sort((a, b) => a.start - b.start);
    this.windows.set(agentId, list);
  }
  /** Close every open window, e.g. when a Bot's live state goes stale. */
  close(agentId, now) {
    const list = this.windows.get(agentId);
    if (list && list.length && list[list.length - 1].end === null) list[list.length - 1].end = now;
  }
  isRunning(agentId) {
    const list = this.windows.get(agentId);
    return Boolean(list && list.length && list[list.length - 1].end === null);
  }
  /** Agent ids whose window (with grace) covers time `t`. */
  botsActiveAt(t) {
    const out = [];
    for (const [agentId, list] of this.windows) {
      if (list.some((w) => t >= w.start - this.graceMs && (w.end === null || t <= w.end + this.graceMs))) out.push(agentId);
    }
    return out;
  }
  prune(before) {
    for (const [agentId, list] of this.windows) {
      const kept = list.filter((w) => w.end === null || w.end >= before);
      if (kept.length) this.windows.set(agentId, kept);
      else this.windows.delete(agentId);
    }
  }
}

/**
 * When was the companion actually watching? Status polls that arrive on time extend the
 * current interval; a late tick (laptop asleep, backoff, restart) starts a new one, and the
 * gap in between is "not monitored" rather than "no Bot was running".
 */
export class Coverage {
  constructor({ graceMs = 20_000, maxAgeMs = 12 * 60 * 60_000 } = {}) {
    this.graceMs = graceMs;
    this.maxAgeMs = maxAgeMs;
    this.intervals = [];
    this.lastTick = null;
  }
  tick(now, expectedIntervalMs) {
    const allowance = Math.max(10_000, expectedIntervalMs * 2.5);
    const current = this.intervals[this.intervals.length - 1];
    if (current && this.lastTick !== null && now - this.lastTick <= allowance && now >= current.start) current.end = now;
    else this.intervals.push({ start: now, end: now });
    this.lastTick = now;
    this.intervals = this.intervals.filter((i) => i.end >= now - this.maxAgeMs);
  }
  covers(t) {
    return this.intervals.some((i) => t >= i.start - this.graceMs && t <= i.end + this.graceMs);
  }
  /** Gaps longer than a minute inside the retained history, newest first. */
  gaps() {
    const out = [];
    for (let i = 1; i < this.intervals.length; i++) {
      const gap = this.intervals[i].start - this.intervals[i - 1].end;
      if (gap > 60_000) out.push({ from: this.intervals[i - 1].end, to: this.intervals[i].start, ms: gap });
    }
    return out.reverse();
  }
}

/** Decide which Bot something at time `at` belongs to, from running windows alone. */
export function attribute(at, windows) {
  const active = windows.botsActiveAt(at);
  if (active.length === 1) return { agentId: active[0], candidates: active, confidence: 'high' };
  if (active.length > 1) return { agentId: null, candidates: active, confidence: 'ambiguous' };
  return { agentId: null, candidates: [], confidence: 'none' };
}

/**
 * Inference-hook frames carry an opaque per-Bot `session_id`. Exact matches against ids we
 * know from the Bot API (live.sessionId, agentId, viewerSessionId) win outright; otherwise a
 * session is bound by timing only after several consistent frames, and a contradiction
 * unbinds it. `how` is `matched-by-id`, `learned` (3+ consistent frames) or `tentative`.
 */
export class SessionBindings {
  constructor() {
    /** sessionId -> { agentId, how, at, count, contradictions } */
    this.bySession = new Map();
  }
  get(sessionId) {
    return this.bySession.get(sessionId) || null;
  }
  set(sessionId, agentId, how = 'manual', at = 0) {
    const binding = { agentId, how, at, count: 1, contradictions: 0 };
    this.bySession.set(sessionId, binding);
    return binding;
  }
  unbind(sessionId) {
    return this.bySession.delete(sessionId);
  }
  /**
   * @param {string} sessionId
   * @param {{ knownIds: Map<string,string>, resolveByTiming: (at:number) => ({agentId:string|null}|null), at: number }} ctx
   */
  resolve(sessionId, { knownIds, resolveByTiming, at }) {
    if (!sessionId) return null;
    const direct = knownIds && knownIds.get(sessionId);
    if (direct) {
      const known = this.bySession.get(sessionId);
      if (known && known.how === 'matched-by-id' && known.agentId === direct) {
        known.count += 1;
        return known;
      }
      return this.set(sessionId, direct, 'matched-by-id', at);
    }
    const known = this.bySession.get(sessionId);
    if (known && known.how === 'matched-by-id') return known;
    const timing = resolveByTiming ? resolveByTiming(at) : null;
    const timedAgent = timing && timing.agentId ? timing.agentId : null;
    if (known) {
      if (timedAgent && timedAgent !== known.agentId) {
        known.contradictions += 1;
        if (known.contradictions >= 2) {
          this.bySession.delete(sessionId);
          return null;
        }
        return known;
      }
      if (timedAgent) known.count += 1;
      known.how = known.count >= 3 ? 'learned' : 'tentative';
      return known;
    }
    if (timedAgent) return this.set(sessionId, timedAgent, 'tentative', at);
    return null;
  }
  entries() {
    return [...this.bySession.entries()].map(([sessionId, b]) => ({ sessionId, ...b }));
  }
}

let nextId = 1;

/** A ring buffer of evidence with listeners. Items are not written to disk. */
export class EvidenceStore {
  constructor({ max = 500 } = {}) {
    this.max = max;
    this.list = [];
    this.listeners = new Set();
    /** key -> how many copies have been stored (ledger rows have no ids and can repeat legitimately) */
    this.seenCounts = new Map();
  }
  /**
   * @param {object} item  `{ at, grade, source, bot, attribution, label, classified, tokens?, extra?, key?, coincident? }`
   * @param {number} [allowedCopies]  with `key`, how many identical rows the current fetch contains
   * @returns the stored item (with `id`) or null when this key already has as many copies as allowed
   */
  add(item, allowedCopies = 1) {
    if (item.key) {
      const have = this.seenCounts.get(item.key) || 0;
      if (have >= allowedCopies) return null;
      this.seenCounts.set(item.key, have + 1);
      if (this.seenCounts.size > this.max * 8) this.seenCounts = new Map([...this.seenCounts].slice(-this.max * 4));
    }
    const stored = { id: nextId++, ...item };
    this.list.push(stored);
    this.list.sort((a, b) => a.at - b.at);
    while (this.list.length > this.max) this.list.shift();
    for (const fn of this.listeners) {
      try {
        fn(stored);
      } catch {
        // A broken listener must not take the poller down.
      }
    }
    return stored;
  }
  /** How many copies of `key` are stored. */
  count(key) {
    return this.seenCounts.get(key) || 0;
  }
  items() {
    return this.list.slice().reverse();
  }
  recent({ minutes = 15, agentId = null, now = Date.now() } = {}) {
    const since = now - minutes * 60_000;
    return this.items().filter((e) => e.at >= since && (!agentId || (e.bot && e.bot.agentId === agentId)));
  }
  /** Latest evidence per grade for one Bot. Coincident ledger rows are excluded from B. */
  latestByGrade(agentId) {
    const out = { A: null, H: null, B: null, B2: null, C: null };
    for (const e of this.items()) {
      if (!e.bot || e.bot.agentId !== agentId) continue;
      if (e.coincident) continue;
      if (out[e.grade] === null) out[e.grade] = e;
    }
    return out;
  }
  /** The latest concrete-model ledger row that coincided with this Bot's run (kept apart from its evidence). */
  latestCoincident(agentId) {
    return this.items().find((e) => e.coincident && e.bot && e.bot.agentId === agentId) || null;
  }
  /** Token totals and ledger-row count for a Bot over a window (coincident rows excluded). */
  totals(agentId, { minutes = 10, now = Date.now() } = {}) {
    const rows = this.recent({ minutes, agentId, now }).filter((e) => e.grade === 'B' && !e.coincident);
    return rows.reduce(
      (acc, e) => {
        acc.requests += 1;
        acc.inputTokens += e.tokens ? e.tokens.in : 0;
        acc.outputTokens += e.tokens ? e.tokens.out : 0;
        return acc;
      },
      { requests: 0, inputTokens: 0, outputTokens: 0 },
    );
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** An always-true description of what the evidence can and cannot show. */
export function capabilityStatement() {
  return [
    'Grok Bot chooses a model for every request and does not show it.',
    'On a normal plan you can watch when each Bot works, what kind of turn it was (chat, routine, computer use), token counts and your weekly allowance, but not the model: Cursor records Bot work under the product labels grok-bot-default, grok-bot-automation and grok-bot-cua, by design.',
    'Nothing a Bot can call sees the model either: the Bot API has no model field and the desktop app records none. Plugin hooks, whose payload does name a model slug, are not documented to run in Grok Bot; this plugin ships one as an experiment.',
    "The only per-request identifier is Cursor's inference hook, available to Enterprise teams. It names a Cursor model identifier that Cursor says to use for reporting, not allowlisting, and which can itself be an alias.",
    "A Bot's statement about its own model is a quote, not evidence.",
  ].join(' ');
}

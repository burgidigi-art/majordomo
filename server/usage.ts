// Tokens by model: how much each model has read and written, today, this week and in all, kept up to
// date as agents work. Every model call is recorded as a "usage" event; this adds them up once at
// start, then keeps a running tally as new ones arrive and pushes it to the dashboard.
import type { ModelUsage, UsageSummary } from '../shared/types.ts';
import { subscribe, sync } from './bus.ts';
import { db, tasks } from './db.ts';
import { getSettings } from './settings.ts';

interface Rec {
  ts: number;
  key: string;
  runtime: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  included: boolean;
}

const WEEK = 7 * 24 * 3600_000;
let all = new Map<string, ModelUsage>();
let recent: Rec[] = [];
let ready = false;

/** One usage event as a record. Older events lack the runtime and cost, which are filled in as best can be. */
function toRec(agentId: string, ts: number, data: any): Rec {
  const runtime = String(data?.runtime ?? (agentId === 'pm' ? getSettings().pm.runtime : (tasks.get(agentId)?.runtime ?? 'unknown')));
  const raw = String(data?.model ?? '');
  const model = !raw || raw === 'default' ? `${runtime} default` : raw;
  return {
    ts,
    key: `${runtime}\u0000${model}`,
    runtime,
    model,
    input: Number(data?.input) || 0,
    output: Number(data?.output) || 0,
    cacheRead: Number(data?.cacheRead) || 0,
    costUsd: Number(data?.costUsd) || 0,
    included: data?.included ?? !String(runtime).match(/^(anthropic|openai|gemini|muse|openrouter)$/),
  };
}

function add(map: Map<string, ModelUsage>, r: Rec): void {
  const row = map.get(r.key) ?? { runtime: r.runtime, model: r.model, calls: 0, input: 0, output: 0, cacheRead: 0, costUsd: 0, included: r.included, lastAt: 0 };
  row.calls += 1;
  row.input += r.input;
  row.output += r.output;
  row.cacheRead += r.cacheRead;
  row.costUsd += r.costUsd;
  row.included = row.included && r.included;
  row.lastAt = Math.max(row.lastAt, r.ts);
  map.set(r.key, row);
}

function load(): void {
  all = new Map();
  recent = [];
  const since = Date.now() - WEEK;
  const rows = db.prepare("SELECT agent_id, ts, data FROM events WHERE type = 'usage' ORDER BY id").all() as { agent_id: string; ts: number; data: string }[];
  for (const row of rows) {
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    const r = toRec(row.agent_id, row.ts, data);
    add(all, r);
    if (r.ts >= since) recent.push(r);
  }
  ready = true;
}

const sorted = (map: Map<string, ModelUsage>) => [...map.values()].sort((a, b) => b.input + b.output - (a.input + a.output));

export function usageSummary(now = Date.now()): UsageSummary {
  if (!ready) load();
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  recent = recent.filter((r) => r.ts >= now - WEEK);
  const today = new Map<string, ModelUsage>();
  const week = new Map<string, ModelUsage>();
  for (const r of recent) {
    add(week, r);
    if (r.ts >= startOfDay) add(today, r);
  }
  return { today: sorted(today), week: sorted(week), all: sorted(all), updatedAt: now };
}

/** For tests: forget the tally so it is rebuilt from the database. */
export function _resetUsage(): void {
  ready = false;
}

// Keep the tally current and tell the dashboard, at most once a second however busy the crew is.
let pending: NodeJS.Timeout | null = null;
subscribe((msg) => {
  if (msg.kind !== 'event' || msg.event.type !== 'usage') return;
  if (!ready) load();
  else {
    const r = toRec(msg.event.agentId, msg.event.ts, msg.event.data);
    add(all, r);
    recent.push(r);
  }
  pending ??= setTimeout(() => {
    pending = null;
    sync({ usage: usageSummary() });
  }, 1000);
});

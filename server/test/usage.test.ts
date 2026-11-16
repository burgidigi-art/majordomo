import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { StreamMessage } from '../../shared/types.ts';
import { tempHome } from './helpers.ts';

// Tokens by model, kept live: Claude Code counted step by step, everything tallied per model and period.

process.env.MAJORDOMO_DEMO = '1';
const data = tempHome();
process.env.MAJORDOMO_CLAUDE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

let cli: typeof import('../agents/cli.ts');
let usage: typeof import('../usage.ts');
let bus: typeof import('../bus.ts');
let db: typeof import('../db.ts');

before(async () => {
  cli = await import('../agents/cli.ts');
  usage = await import('../usage.ts');
  bus = await import('../bus.ts');
  db = await import('../db.ts');
});

test('Claude Code’s usage is counted step by step as it runs, each token once', async () => {
  const seen: { at: number; usage: { input: number; output: number; cacheRead: number }; model: string }[] = [];
  const started = Date.now();
  const result = await cli.runCliTurn({
    agentId: 'T-1',
    runtime: 'claude-code',
    model: '',
    cwd: path.join(data, 'ws'),
    prompt: 'go',
    manager: false,
    signal: new AbortController().signal,
    onUsage: (u, model) => seen.push({ at: Date.now() - started, usage: { input: u.input, output: u.output, cacheRead: u.cacheRead }, model }),
  });
  assert.deepEqual(
    seen.map((s) => [s.usage, s.model]),
    [
      [{ input: 1000, output: 5, cacheRead: 900 }, 'claude-opus-5-5'],
      [{ input: 0, output: 15, cacheRead: 0 }, 'claude-opus-5-5'],
      [{ input: 300, output: 40, cacheRead: 0 }, 'claude-opus-5-5'],
    ],
    'a message reported twice adds only what it grew by',
  );
  assert.ok(seen[0]!.at < seen[2]!.at - 150, 'counted while running, not all at the end');
  assert.deepEqual([result.reported.input, result.reported.output], [1300, 60]);
  assert.equal(result.model, 'claude-opus-5-5');
  // The end-of-run total has 10 output tokens the steps did not show (a helper); only those remain.
  assert.deepEqual(cli.usageMinus(result.usage, result.reported), { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 });
});

test('usage is tallied per model and account, for today, the week and all time', () => {
  const day = 24 * 3600_000;
  const insert = (agent: string, ts: number, d: object) =>
    db.db.prepare("INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, 'usage', ?)").run(agent, ts, JSON.stringify(d));
  const now = Date.now();
  insert('T-a', now - 60_000, { input: 1000, output: 100, cacheRead: 800, model: 'claude-opus-5-5', runtime: 'claude-code', included: true });
  insert('T-a', now - 30_000, { input: 500, output: 50, cacheRead: 0, model: 'claude-opus-5-5', runtime: 'claude-code', included: true });
  insert('T-b', now - 3 * day, { input: 2000, output: 300, model: 'muse-spark-1.3', runtime: 'muse', costUsd: 0.004, included: false });
  insert('T-c', now - 30 * day, { input: 9000, output: 900, model: 'gpt-5.5', runtime: 'openai', costUsd: 0.05, included: false });
  insert('pm', now - 10_000, { input: 50, output: 5, model: 'default' }, );
  usage._resetUsage();
  const s = usage.usageSummary(now);

  const row = (list: typeof s.all, model: string) => list.find((r) => r.model === model);
  const opus = row(s.today, 'claude-opus-5-5')!;
  assert.deepEqual([opus.calls, opus.input, opus.output, opus.cacheRead, opus.included], [2, 1500, 150, 800, true]);
  assert.equal(row(s.today, 'muse-spark-1.3'), undefined, 'three days ago is not today');
  assert.deepEqual([row(s.week, 'muse-spark-1.3')!.costUsd, row(s.week, 'muse-spark-1.3')!.included], [0.004, false]);
  assert.equal(row(s.week, 'gpt-5.5'), undefined, 'a month ago is not this week');
  assert.equal(row(s.all, 'gpt-5.5')!.input, 9000);
  assert.ok(row(s.today, 'demo default'), 'an older record with no model is named after its account');
  assert.equal(s.all[0]!.model, 'gpt-5.5', 'busiest first');
});

test('new usage reaches the dashboard within about a second, batched however busy it is', async () => {
  const pushes: StreamMessage[] = [];
  const stop = bus.subscribe((m) => {
    if (m.kind === 'sync' && m.patch.usage) pushes.push(m);
  });
  try {
    for (let i = 0; i < 5; i++) bus.emit('T-live', 'usage', { input: 10, output: 2, model: 'muse-spark-1.3', runtime: 'muse', costUsd: 0.0001, included: false });
    await new Promise((r) => setTimeout(r, 1400));
    assert.equal(pushes.length, 1, 'five calls, one update');
    const today = (pushes[0] as Extract<StreamMessage, { kind: 'sync' }>).patch.usage!.today;
    const muse = today.find((r) => r.model === 'muse-spark-1.3')!;
    assert.deepEqual([muse.calls, muse.input, muse.output], [5, 50, 10]);
  } finally {
    stop();
  }
});

import { useEffect, useRef, useState } from 'react';
import type { ModelUsage as Row } from '../../../shared/types.ts';
import { ago, accountName, compact, money, useNow } from '../lib.ts';
import { useStore } from '../store.ts';

type Window = 'today' | 'week' | 'all';
const WINDOWS: [Window, string][] = [
  ['today', 'Today'],
  ['week', '7 days'],
  ['all', 'All time'],
];

const keyOf = (r: Row) => `${r.runtime}/${r.model}`;

/**
 * Tokens by model, live. Each model call is counted as it is reported: API keys after every request,
 * Claude Code after every step, Codex and Gemini CLI when a run ends. Numbers that just changed glow.
 */
export function ModelUsage() {
  const usage = useStore((s) => s.app?.usage);
  const runtimes = useStore((s) => s.app?.runtimes ?? []);
  const [win, setWin] = useState<Window>('today');
  const now = useNow(true, 5000);

  // Remember the last numbers seen, to light up the ones that just went up.
  const last = useRef(new Map<string, number>());
  const [bumped, setBumped] = useState<Set<string>>(new Set());
  const rows = usage?.[win] ?? [];
  useEffect(() => {
    const changed = new Set<string>();
    for (const r of rows) {
      const k = keyOf(r);
      const total = r.input + r.output;
      const before = last.current.get(k);
      if (before !== undefined && total > before) changed.add(k);
      last.current.set(k, total);
    }
    if (!changed.size) return;
    setBumped(changed);
    const t = setTimeout(() => setBumped(new Set()), 1600);
    return () => clearTimeout(t);
  }, [usage]);
  useEffect(() => {
    last.current = new Map();
  }, [win]);

  if (!usage) return null;
  const total = rows.reduce(
    (t, r) => ({ calls: t.calls + r.calls, input: t.input + r.input, output: t.output + r.output, cacheRead: t.cacheRead + r.cacheRead, cost: t.cost + r.costUsd }),
    { calls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 },
  );
  const label = (rt: string) => runtimes.find((r) => r.id === rt)?.label ?? accountName(rt as never);

  return (
    <div className="card model-usage">
      <div className="model-usage-head">
        <div className="grow">
          <h2>Tokens by model</h2>
          <div className="hint">
            <span className="live-dot" /> Live · updated {ago(usage.updatedAt, now)}. API keys count after every request and Claude Code after every
            step; Codex and Gemini CLI report once a run ends.
          </div>
        </div>
        <div className="seg" role="tablist" aria-label="Period">
          {WINDOWS.map(([id, text]) => (
            <button key={id} role="tab" aria-selected={win === id} className={win === id ? 'on' : ''} onClick={() => setWin(id)}>
              {text}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="faint" style={{ padding: '6px 2px 4px', fontSize: 13 }}>
          No model calls {win === 'today' ? 'today' : win === 'week' ? 'in the last 7 days' : 'yet'}.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="usage-table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Calls</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num" title="The part of input served from the provider’s cache: cheaper, or free">
                  Cached
                </th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={keyOf(r)} className={bumped.has(keyOf(r)) ? 'bump' : ''}>
                  <td>
                    <div className="usage-model mono">{r.model}</div>
                    <div className="usage-acct">
                      {label(r.runtime)} · last used {ago(r.lastAt, now)}
                    </div>
                  </td>
                  <td className="num tnum">{compact(r.calls)}</td>
                  <td className="num tnum">{compact(r.input)}</td>
                  <td className="num tnum">{compact(r.output)}</td>
                  <td className="num tnum faint">{r.cacheRead ? compact(r.cacheRead) : '—'}</td>
                  <td className="num tnum">{r.included ? <span className="faint">on your plan</span> : r.costUsd > 0 ? `≈ ${money(r.costUsd)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr>
                  <td>All models</td>
                  <td className="num tnum">{compact(total.calls)}</td>
                  <td className="num tnum">{compact(total.input)}</td>
                  <td className="num tnum">{compact(total.output)}</td>
                  <td className="num tnum faint">{total.cacheRead ? compact(total.cacheRead) : '—'}</td>
                  <td className="num tnum">{total.cost > 0 ? `≈ ${money(total.cost)}` : '—'}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

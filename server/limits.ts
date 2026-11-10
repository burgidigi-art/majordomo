import type { AccountLimits, RuntimeId } from '../shared/types.ts';
import { sync } from './bus.ts';
import { kvGet, kvSet } from './db.ts';

/**
 * Plan usage, as reported by the subscription CLIs themselves. Claude Code includes it in its
 * event stream on every run; nothing is polled or estimated.
 */
type Limits = Partial<Record<RuntimeId, AccountLimits>>;

export function getLimits(): Limits {
  return kvGet<Limits>('limits', {});
}

function clamp(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

/** `info` is the `rate_limit_info` object from a Claude Code `rate_limit_event` line. */
export function recordClaudeLimits(info: any): void {
  const windows = info?.unifiedWindows;
  if (!windows || typeof windows !== 'object') return;
  const read = (w: any) => {
    const used = clamp(w?.utilization);
    return used === null ? undefined : { used, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : 0 };
  };
  const next: AccountLimits = { weekly: read(windows.seven_day), session: read(windows.five_hour), at: Date.now() };
  if (!next.weekly && !next.session) return;
  const all = { ...getLimits(), 'claude-code': next };
  kvSet('limits', all);
  sync({ limits: all });
}

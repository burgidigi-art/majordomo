// Plain helpers with no browser or React in them, so the server's tests can use them too.
import type { Task } from '../../shared/types.ts';

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export const isLive = (t: Task) => t.status === 'running' || t.status === 'waiting';
export const isOpen = (t: Task) => t.status === 'queued' || isLive(t);
export const isTrouble = (t: Task) => t.status === 'failed' || t.status === 'interrupted';

export function taskElapsed(t: Task, now: number): number {
  if (!t.startedAt) return 0;
  return (t.finishedAt ?? now) - t.startedAt;
}

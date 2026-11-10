import { useEffect, useState } from 'react';
import type { RuntimeId, RuntimeInfo, Task, TaskStatus } from '../../shared/types.ts';

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

export function money(n: number): string {
  if (n <= 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(n < 10 ? 2 : 0)}`;
}

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

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** Re-render on an interval while something on screen is counting time. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs]);
  return now;
}

export function useHashRoute(): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#/, '') || '/';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (to) => (window.location.hash = to)];
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Queued',
  running: 'Working',
  waiting: 'Needs an answer',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export const isLive = (t: Task) => t.status === 'running' || t.status === 'waiting';
export const isOpen = (t: Task) => t.status === 'queued' || isLive(t);
export const isTrouble = (t: Task) => t.status === 'failed' || t.status === 'interrupted';

export function taskElapsed(t: Task, now: number): number {
  if (!t.startedAt) return 0;
  return (t.finishedAt ?? now) - t.startedAt;
}

export function familyOf(runtimes: RuntimeInfo[], id: string): RuntimeInfo['family'] {
  return runtimes.find((r) => r.id === id)?.family ?? 'demo';
}

const ACCOUNT_NAMES: Record<RuntimeId, string> = {
  'claude-code': 'Claude',
  anthropic: 'Claude API',
  codex: 'ChatGPT',
  openai: 'OpenAI',
  'gemini-cli': 'Gemini',
  gemini: 'Gemini API',
  muse: 'Muse',
  openrouter: 'OpenRouter',
  demo: 'Demo crew',
};

/** A short name for an account, for places too tight for "Claude · subscription". */
export function accountName(id: RuntimeId): string {
  return ACCOUNT_NAMES[id] ?? id;
}

/** Tool names arrive with transport prefixes when the PM runs through a CLI. */
export function toolName(raw: string): string {
  return raw.replace(/^mcp__majordomo__/, '').replace(/^majordomo\./, '');
}

export function greeting(name?: string): string {
  const h = new Date().getHours();
  const part = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}.` : `${part}.`;
}

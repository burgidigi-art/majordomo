import type { AgentEvent, AgentEventType, AppState, StreamMessage } from '../shared/types.ts';
import { events } from './db.ts';

type Listener = (msg: StreamMessage) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function broadcast(msg: StreamMessage): void {
  for (const fn of listeners) {
    try {
      fn(msg);
    } catch {
      // A broken subscriber must never take the agent loop down with it.
    }
  }
}

/** Persist an agent event and push it to every connected dashboard. */
export function emit(agentId: string, type: AgentEventType, data: unknown): AgentEvent {
  const event = events.insert(agentId, type, data);
  broadcast({ kind: 'event', event });
  return event;
}

/** Streamed text is not persisted per-chunk; the completed block arrives later as an event. */
export function emitDelta(agentId: string, block: string, type: 'text' | 'thinking', text: string): void {
  if (text) broadcast({ kind: 'delta', agentId, block, type, text });
}

export function sync(patch: Partial<AppState> & { removedProjects?: string[] }): void {
  broadcast({ kind: 'sync', patch });
}

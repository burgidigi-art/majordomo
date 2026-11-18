import { create } from 'zustand';
import type { AgentEvent, AppState, StreamMessage } from '../../shared/types.ts';
import { api } from './api.ts';

export interface StreamingBlock {
  type: 'text' | 'thinking';
  text: string;
}

interface Store {
  app: AppState | null;
  /** Why the first load failed, shown instead of waiting forever. */
  loadError: string;
  connected: boolean;
  /** Persisted transcript per agent ('pm' or a task id), loaded on demand. */
  events: Record<string, AgentEvent[]>;
  loaded: Record<string, boolean>;
  /** Text still being generated, keyed by agent then block id. */
  streaming: Record<string, Record<string, StreamingBlock>>;
  /** The agent whose transcript drawer is open. */
  openAgent: string | null;
  theme: 'dark' | 'light';
  railOpen: boolean;
  setOpenAgent(id: string | null): void;
  toggleTheme(): void;
  setRailOpen(open: boolean): void;
  loadEvents(agentId: string, force?: boolean): Promise<void>;
  refresh(): Promise<void>;
}

function upsert<T extends { id: string }>(list: T[], items: T[]): T[] {
  const map = new Map(list.map((x) => [x.id, x]));
  for (const it of items) map.set(it.id, it);
  return [...map.values()];
}

function initialTheme(): 'dark' | 'light' {
  const saved = document.documentElement.dataset.theme;
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const useStore = create<Store>((set, get) => ({
  app: null,
  loadError: '',
  connected: false,
  events: {},
  loaded: {},
  streaming: {},
  openAgent: null,
  theme: initialTheme(),
  railOpen: false,

  setOpenAgent(id) {
    set({ openAgent: id });
    if (id) void get().loadEvents(id);
  },

  toggleTheme() {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('mj-theme', theme);
    } catch {
      /* private mode: the choice just won't persist */
    }
    set({ theme });
  },

  setRailOpen(open) {
    set({ railOpen: open });
  },

  async loadEvents(agentId, force) {
    if (get().loaded[agentId] && !force) return;
    set((s) => ({ loaded: { ...s.loaded, [agentId]: true } }));
    const list = await api.events(agentId);
    set((s) => {
      // Events that streamed in while the request was in flight are newer than the fetched page.
      const live = (s.events[agentId] ?? []).filter((e) => !list.some((x) => x.id === e.id));
      return { events: { ...s.events, [agentId]: [...list, ...live].sort((a, b) => a.id - b.id) } };
    });
  },

  async refresh() {
    try {
      const app = await api.state();
      set({ app, loadError: '' });
    } catch (err) {
      // Once the dashboard is showing, a failed refresh is retried on the next reconnect; before
      // that, say what went wrong rather than leaving "Opening the desk…" up for good.
      if (!get().app) set({ loadError: err instanceof Error ? err.message : String(err) });
    }
  },
}));

function apply(msg: StreamMessage): void {
  const { setState: set, getState: get } = useStore;
  if (msg.kind === 'hello') {
    // (Re)connected: anything could have changed while we were away.
    set({ connected: true });
    void get().refresh();
    for (const id of Object.keys(get().loaded)) void get().loadEvents(id, true);
    return;
  }
  if (msg.kind === 'sync') {
    const app = get().app;
    if (!app) return;
    const { projects, tasks, removedProjects, ...rest } = msg.patch;
    // Keep the same order the server uses: newest project first, tasks in creation order.
    let nextProjects = projects ? upsert(app.projects, projects).sort((a, b) => b.createdAt - a.createdAt) : app.projects;
    let nextTasks = tasks ? upsert(app.tasks, tasks) : app.tasks;
    if (removedProjects?.length) {
      nextProjects = nextProjects.filter((p) => !removedProjects.includes(p.id));
      nextTasks = nextTasks.filter((t) => !removedProjects.includes(t.projectId));
    }
    set({ app: { ...app, ...rest, projects: nextProjects, tasks: nextTasks } });
    return;
  }
  if (msg.kind === 'delta') {
    set((s) => {
      const blocks = { ...(s.streaming[msg.agentId] ?? {}) };
      const cur = blocks[msg.block];
      blocks[msg.block] = { type: msg.type, text: (cur?.text ?? '') + msg.text };
      return { streaming: { ...s.streaming, [msg.agentId]: blocks } };
    });
    return;
  }
  if (msg.kind === 'event') {
    const e = msg.event;
    set((s) => {
      const next: Partial<Store> = {};
      // Only keep transcripts someone is looking at; the rest load when opened.
      if (s.loaded[e.agentId]) {
        const list = s.events[e.agentId] ?? [];
        if (!list.some((x) => x.id === e.id)) next.events = { ...s.events, [e.agentId]: [...list, e] };
      }
      const blocks = s.streaming[e.agentId];
      if (blocks) {
        // The finished block replaces its streamed preview. A turn that ended (usage, error)
        // clears whatever previews are left.
        const done = e.type === 'usage' || e.type === 'error';
        const key = e.data?.block as string | undefined;
        if (done) next.streaming = { ...s.streaming, [e.agentId]: {} };
        else if (key && blocks[key]) {
          const rest = { ...blocks };
          delete rest[key];
          next.streaming = { ...s.streaming, [e.agentId]: rest };
        }
      }
      return next;
    });
  }
}

let started = false;

/** What one window passes to the others: a stream message, or whether the stream is up. */
type Relay = { msg: StreamMessage } | { connected: boolean };

/**
 * Live updates. A browser keeps at most six connections open to one address, and each open stream
 * holds one for good, so with a handful of 00Dojo windows open the next one could never load. So
 * only one window holds the stream (whichever holds the lock) and relays what it receives to the
 * others; when it closes, another takes over. Browsers without locks fall back to a stream per window.
 */
export function connect(): void {
  if (started) return;
  started = true;
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('majordomo-stream') : null;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;

  const openStream = (relay: (r: Relay) => void) => {
    const source = new EventSource('/api/stream');
    source.onmessage = (ev) => {
      let msg: StreamMessage;
      try {
        msg = JSON.parse(ev.data) as StreamMessage;
      } catch {
        return; // a malformed frame
      }
      apply(msg);
      relay({ msg });
    };
    source.onerror = () => {
      useStore.setState({ connected: false });
      relay({ connected: false });
    };
  };

  if (!channel || !locks) {
    openStream(() => {});
    return;
  }

  // Until this window holds the stream itself, it follows the one that does.
  channel.onmessage = (ev: MessageEvent<Relay>) => {
    const r = ev.data;
    if ('msg' in r) apply(r.msg);
    else useStore.setState({ connected: r.connected });
  };
  useStore.setState({ connected: true });

  void locks.request('majordomo-stream', () => {
    // This window leads now: it stops listening to the channel and talks on it instead. The lock is
    // held until the window closes, which hands it to the next one.
    channel.onmessage = null;
    openStream((r) => channel.postMessage(r));
    return new Promise<never>(() => {});
  });
}

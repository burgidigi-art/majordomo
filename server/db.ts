import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentEvent,
  AgentEventType,
  Approval,
  Memory,
  Project,
  Reminder,
  Task,
} from '../shared/types.ts';

export const DATA_DIR = process.env.MAJORDOMO_HOME
  ? path.resolve(process.env.MAJORDOMO_HOME)
  : path.join(os.homedir(), '.majordomo');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

export const db = new Database(path.join(DATA_DIR, 'majordomo.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', notes TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL, hue INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT, title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL,
  crew_id TEXT NOT NULL, crew_name TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL,
  effort TEXT, depends_on TEXT NOT NULL DEFAULT '[]',
  status_line TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 1,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, cost_included INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, ts INTEGER NOT NULL,
  type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, id);
CREATE TABLE IF NOT EXISTS messages (
  agent_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);
CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL,
  detail TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, note TEXT NOT NULL, due_at INTEGER NOT NULL, repeat_minutes INTEGER
);
`);

// ---------- key/value ----------

const kvGetStmt = db.prepare('SELECT value FROM kv WHERE key = ?');
const kvSetStmt = db.prepare(
  'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function kvGet<T>(key: string, fallback: T): T {
  const row = kvGetStmt.get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(key: string, value: unknown): void {
  kvSetStmt.run(key, JSON.stringify(value));
}

export function kvDelete(key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

/** Short, human-friendly sequential ids (P-3, T-17) that models can quote reliably. */
export function nextId(prefix: string): string {
  const n = kvGet<number>(`seq:${prefix}`, 0) + 1;
  kvSet(`seq:${prefix}`, n);
  return `${prefix}-${n}`;
}

// ---------- projects ----------

function toProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    goal: r.goal,
    status: r.status,
    notes: r.notes,
    workspace: r.workspace,
    hue: r.hue,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const projects = {
  all(): Project[] {
    return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all().map(toProject);
  },
  get(id: string): Project | null {
    const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return r ? toProject(r) : null;
  },
  /** Accepts an id or a (case-insensitive) name. */
  find(ref: string): Project | null {
    const byId = projects.get(ref.trim().toUpperCase());
    if (byId) return byId;
    const r = db.prepare('SELECT * FROM projects WHERE lower(name) = lower(?)').get(ref.trim());
    return r ? toProject(r) : null;
  },
  insert(p: Project): void {
    db.prepare(
      `INSERT INTO projects (id, name, goal, status, notes, workspace, hue, created_at, updated_at)
       VALUES (@id, @name, @goal, @status, @notes, @workspace, @hue, @createdAt, @updatedAt)`,
    ).run(p);
  },
  update(id: string, patch: Partial<Project>): Project | null {
    const cur = projects.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id, updatedAt: Date.now() };
    db.prepare(
      `UPDATE projects SET name=@name, goal=@goal, status=@status, notes=@notes,
       workspace=@workspace, hue=@hue, updated_at=@updatedAt WHERE id=@id`,
    ).run(next);
    return next;
  },
  remove(id: string): void {
    const ids = (db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(id) as { id: string }[]).map(
      (r) => r.id,
    );
    const tx = db.transaction(() => {
      for (const t of ids) {
        db.prepare('DELETE FROM events WHERE agent_id = ?').run(t);
        db.prepare('DELETE FROM messages WHERE agent_id = ?').run(t);
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
    tx();
  },
};

// ---------- tasks ----------

function toTask(r: any): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    parentId: r.parent_id,
    title: r.title,
    brief: r.brief,
    status: r.status,
    crewId: r.crew_id,
    crewName: r.crew_name,
    runtime: r.runtime,
    model: r.model,
    effort: r.effort,
    dependsOn: JSON.parse(r.depends_on),
    statusLine: r.status_line,
    result: r.result,
    error: r.error,
    attempt: r.attempt,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
    costIncluded: !!r.cost_included,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export const tasks = {
  all(): Task[] {
    return db.prepare('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC').all().map(toTask);
  },
  byProject(projectId: string): Task[] {
    return db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(projectId)
      .map(toTask);
  },
  get(id: string): Task | null {
    const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id.trim().toUpperCase());
    return r ? toTask(r) : null;
  },
  insert(t: Task): void {
    db.prepare(
      `INSERT INTO tasks (id, project_id, parent_id, title, brief, status, crew_id, crew_name, runtime,
        model, effort, depends_on, status_line, result, error, attempt, tokens_in, tokens_out, cost_usd,
        cost_included, created_at, started_at, finished_at)
       VALUES (@id, @projectId, @parentId, @title, @brief, @status, @crewId, @crewName, @runtime,
        @model, @effort, @dependsOn, @statusLine, @result, @error, @attempt, @tokensIn, @tokensOut,
        @costUsd, @costIncluded, @createdAt, @startedAt, @finishedAt)`,
    ).run({ ...t, dependsOn: JSON.stringify(t.dependsOn), costIncluded: t.costIncluded ? 1 : 0 });
  },
  update(id: string, patch: Partial<Task>): Task | null {
    const cur = tasks.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id };
    db.prepare(
      `UPDATE tasks SET title=@title, brief=@brief, status=@status, crew_id=@crewId, crew_name=@crewName,
        runtime=@runtime, model=@model, effort=@effort, depends_on=@dependsOn, status_line=@statusLine,
        result=@result, error=@error, attempt=@attempt, tokens_in=@tokensIn, tokens_out=@tokensOut,
        cost_usd=@costUsd, cost_included=@costIncluded, started_at=@startedAt, finished_at=@finishedAt
       WHERE id=@id`,
    ).run({ ...next, dependsOn: JSON.stringify(next.dependsOn), costIncluded: next.costIncluded ? 1 : 0 });
    return next;
  },
};

// ---------- events ----------

export const events = {
  insert(agentId: string, type: AgentEventType, data: unknown): AgentEvent {
    const ts = Date.now();
    const info = db
      .prepare('INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)')
      .run(agentId, ts, type, JSON.stringify(data));
    return { id: Number(info.lastInsertRowid), agentId, ts, type, data };
  },
  list(agentId: string, opts: { before?: number; limit?: number } = {}): AgentEvent[] {
    const limit = Math.min(opts.limit ?? 400, 2000);
    const rows = opts.before
      ? db
          .prepare('SELECT * FROM events WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
          .all(agentId, opts.before, limit)
      : db.prepare('SELECT * FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?').all(agentId, limit);
    return (rows as any[])
      .reverse()
      .map((r) => ({ id: r.id, agentId: r.agent_id, ts: r.ts, type: r.type, data: JSON.parse(r.data) }));
  },
  clear(agentId: string): void {
    db.prepare('DELETE FROM events WHERE agent_id = ?').run(agentId);
  },
};

// ---------- LLM conversation state ----------

export const messages = {
  load<T>(agentId: string): T[] {
    return (
      db.prepare('SELECT payload FROM messages WHERE agent_id = ? ORDER BY seq ASC').all(agentId) as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload) as T);
  },
  append(agentId: string, seq: number, msg: unknown): void {
    db.prepare('INSERT OR REPLACE INTO messages (agent_id, seq, payload) VALUES (?, ?, ?)').run(
      agentId,
      seq,
      JSON.stringify(msg),
    );
  },
  replaceAll(agentId: string, msgs: unknown[]): void {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE agent_id = ?').run(agentId);
      const ins = db.prepare('INSERT INTO messages (agent_id, seq, payload) VALUES (?, ?, ?)');
      msgs.forEach((m, i) => ins.run(agentId, i, JSON.stringify(m)));
    });
    tx();
  },
  clear(agentId: string): void {
    db.prepare('DELETE FROM messages WHERE agent_id = ?').run(agentId);
  },
};

// ---------- memory / approvals / reminders ----------

export const memory = {
  all(): Memory[] {
    return (db.prepare('SELECT * FROM memory ORDER BY created_at ASC').all() as any[]).map((r) => ({
      id: r.id,
      text: r.text,
      createdAt: r.created_at,
    }));
  },
  add(text: string): Memory {
    const m = { id: nextId('M'), text, createdAt: Date.now() };
    db.prepare('INSERT INTO memory (id, text, created_at) VALUES (?, ?, ?)').run(m.id, m.text, m.createdAt);
    return m;
  },
  remove(id: string): boolean {
    return db.prepare('DELETE FROM memory WHERE id = ?').run(id.trim().toUpperCase()).changes > 0;
  },
};

export const approvals = {
  pending(): Approval[] {
    return (
      db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC").all() as any[]
    ).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      tool: r.tool,
      summary: r.summary,
      detail: r.detail,
      status: r.status,
      createdAt: r.created_at,
    }));
  },
  insert(a: Approval): void {
    db.prepare(
      'INSERT INTO approvals (id, agent_id, tool, summary, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(a.id, a.agentId, a.tool, a.summary, a.detail, a.status, a.createdAt);
  },
  resolve(id: string, status: 'approved' | 'denied'): void {
    db.prepare('UPDATE approvals SET status = ? WHERE id = ?').run(status, id);
  },
  expireAll(): void {
    db.prepare("UPDATE approvals SET status = 'denied' WHERE status = 'pending'").run();
  },
};

export const reminders = {
  all(): Reminder[] {
    return (db.prepare('SELECT * FROM reminders ORDER BY due_at ASC').all() as any[]).map((r) => ({
      id: r.id,
      note: r.note,
      dueAt: r.due_at,
      repeatMinutes: r.repeat_minutes,
    }));
  },
  add(note: string, dueAt: number, repeatMinutes: number | null): Reminder {
    const r = { id: nextId('R'), note, dueAt, repeatMinutes };
    db.prepare('INSERT INTO reminders (id, note, due_at, repeat_minutes) VALUES (?, ?, ?, ?)').run(
      r.id,
      r.note,
      r.dueAt,
      r.repeatMinutes,
    );
    return r;
  },
  reschedule(id: string, dueAt: number): void {
    db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(dueAt, id);
  },
  remove(id: string): boolean {
    return db.prepare('DELETE FROM reminders WHERE id = ?').run(id.trim().toUpperCase()).changes > 0;
  },
};

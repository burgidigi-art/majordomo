import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppState, PmStatus, Project, Task } from '../shared/types.ts';
import { cliWorkerPreamble, PM_SYSTEM, workerSystem } from './agents/prompts.ts';
import { Runner, type AgentSpec, type InboxItem, type Outcome } from './agents/runner.ts';
import { emit, sync } from './bus.ts';
import { approvals, DATA_DIR, events, kvGet, kvSet, memory, messages, nextId, projects, reminders, tasks } from './db.ts';
import type { Usage } from './llm/types.ts';
import { DEMO, getSettings, resolveCrew, runtimeDef, runtimeStatus } from './settings.ts';
import { pmTools, projectSummary, type Orch } from './tools/pm.ts';
import { clip, ToolError, type Host } from './tools/tool.ts';
import { workerTools } from './tools/worker.ts';

export const VERSION = '0.1.0';
export const MCP_TOKEN = randomBytes(24).toString('hex');

let baseUrl = 'http://127.0.0.1:4317';
export function setBaseUrl(url: string): void {
  baseUrl = url;
}

const PM = 'pm';
const PM_DIR = path.join(DATA_DIR, 'pm');
fs.mkdirSync(PM_DIR, { recursive: true });

// ---------- waiting rooms ----------

/** Workers blocked in ask_manager, keyed by task id. */
const questions = new Map<string, { resolve: (answer: string) => void; reject: (e: Error) => void }>();
/** Parents blocked in delegate, keyed by child task id. */
const childDone = new Map<string, (outcome: Outcome) => void>();
/** Tool calls blocked on a user approval, keyed by approval id. */
const approvalWaiters = new Map<string, (ok: boolean) => void>();

// ---------- helpers ----------

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'project'
  );
}

function patchTask(id: string, patch: Partial<Task>): Task | null {
  const next = tasks.update(id, patch);
  if (next) sync({ tasks: [next] });
  return next;
}

function pmStatus(): PmStatus {
  const u = kvGet('pm:usage', { tokensIn: 0, tokensOut: 0, costUsd: 0 });
  return { busy: runner.isBusy(PM), queued: runner.queued(PM) + pendingEvents.length, ...u };
}

function openTasks(projectId: string): number {
  return tasks
    .byProject(projectId)
    .filter((t) => !t.parentId && (t.status === 'queued' || t.status === 'running' || t.status === 'waiting')).length;
}

// ---------- what the PM is told ----------

function nowLine(): string {
  const d = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${d.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} (${zone})`;
}

function contextBlock(full: boolean): string {
  const s = getSettings();
  const lines = [`Now: ${nowLine()}`];
  if (full) {
    if (s.userName) lines.push(`User: ${s.userName}`);
    lines.push(
      'Crew:',
      ...s.crew.map((c) => `- ${c.id}${c.id === s.defaultCrewId ? ' (default)' : ''}: ${c.name} — ${c.strengths}`),
    );
    const mem = memory.all().slice(-80);
    if (mem.length) lines.push('Memory:', ...mem.map((m) => `- ${m.id}: ${m.text}`));
  }
  const live = projects
    .all()
    .filter((p) => p.status === 'active' || p.status === 'paused')
    .slice(0, 30);
  lines.push('Projects:', ...(live.length ? live.map((p) => `- ${projectSummary(p)}`) : ['- (none yet)']));
  return `<context>\n${lines.join('\n')}\n</context>`;
}

interface PendingEvent {
  /** Rendered when the batch is delivered, so counts reflect the state the PM will actually find. */
  xml: () => string;
  display: string;
}

const pendingEvents: PendingEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;

/** Events are batched briefly so three tasks finishing together wake the PM once, not three times. */
function notifyPm(ev: PendingEvent): void {
  pendingEvents.push(ev);
  sync({ pm: pmStatus() });
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = pendingEvents.splice(0);
    if (!batch.length) return;
    runner.send(PM, {
      from: 'system',
      text: `${contextBlock(false)}\n\n${batch.map((b) => b.xml()).join('\n\n')}`,
      display: batch.map((b) => b.display).join('\n'),
    });
  }, 1200);
}

function taskEvent(type: string, t: Task, body: string, display: string): PendingEvent {
  const p = projects.get(t.projectId);
  return {
    xml: () =>
      `<event type="${type}" task="${t.id}" title="${attr(t.title)}" project="${t.projectId}" project_name="${attr(p?.name ?? '')}" crew="${attr(t.crewName)}" open_tasks="${openTasks(t.projectId)}">\n${body}\n</event>`,
    display,
  };
}

// ---------- scheduling ----------

function firstMessage(t: Task): InboxItem {
  const note = t.attempt > 1 ? kvGet<string>(`retry-note:${t.id}`, '') : '';
  const noteText = note ? `\n\nNote from your manager: ${note}` : '';
  // On a retry the agent resumes its earlier conversation, if it got far enough to have one.
  const hasHistory = messages.load(t.id).length > 0 || !!kvGet<string | null>(`session:${t.id}`, null);
  if (t.attempt > 1 && hasHistory) {
    return {
      from: 'manager',
      text: `Your earlier run of this task did not finish cleanly. Check where things stand, then pick the task up again and finish it.${noteText}`,
    };
  }
  const deps = t.dependsOn
    .map((id) => tasks.get(id))
    .filter((d): d is Task => !!d && !!d.result)
    .map((d) => `## ${d.id}: ${d.title}\n${clip(d.result, 8000)}`);
  const text = `Task ${t.id}: ${t.title}\n\n${t.brief}${deps.length ? `\n\n# Reports from the tasks this one depends on\n\n${deps.join('\n\n')}` : ''}${noteText}`;
  return { from: 'manager', text };
}

function startTask(t: Task): void {
  patchTask(t.id, { status: 'running', startedAt: t.startedAt ?? Date.now(), finishedAt: null, statusLine: 'Starting', error: '' });
  runner.send(t.id, firstMessage(t));
}

export function tick(): void {
  const s = getSettings();
  const all = tasks.all();
  let busy = all.filter((t) => !t.parentId && (t.status === 'running' || t.status === 'waiting')).length;
  for (const t of all) {
    if (t.status !== 'queued' || t.parentId) continue;
    const project = projects.get(t.projectId);
    if (!project || project.status === 'paused' || project.status === 'archived') continue;
    const deps = t.dependsOn.map((id) => tasks.get(id));
    const unmet = deps.filter((d) => !d || d.status !== 'done');
    if (unmet.length) {
      const dead = unmet.filter((d) => !d || ['failed', 'cancelled', 'interrupted'].includes(d.status));
      const line = dead.length
        ? `Blocked: ${dead.map((d) => d?.id ?? '?').join(', ')} did not finish`
        : `Waiting for ${unmet.map((d) => d!.id).join(', ')}`;
      if (t.statusLine !== line) patchTask(t.id, { statusLine: line });
      continue;
    }
    if (busy >= s.maxParallel) {
      if (t.statusLine !== 'Waiting for a free slot') patchTask(t.id, { statusLine: 'Waiting for a free slot' });
      continue;
    }
    busy++;
    startTask(t);
  }
}

// ---------- runner wiring ----------

const host: Host = {
  progress(agentId, note) {
    patchTask(agentId, { statusLine: note });
  },

  askManager(agentId, question, signal) {
    const t = tasks.get(agentId);
    if (!t) return Promise.resolve('No manager is reachable. Use your best judgement and note the assumption.');
    if (t.parentId) {
      return Promise.resolve('Helpers cannot reach the manager. Make a reasonable assumption and state it in your report.');
    }
    patchTask(t.id, { status: 'waiting', statusLine: `Asked: ${question.slice(0, 160)}` });
    notifyPm(taskEvent('task_question', t, question, `${t.id} · ${t.crewName} asks: ${question}`));
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        questions.delete(t.id);
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      questions.set(t.id, {
        resolve: (answer) => {
          signal.removeEventListener('abort', onAbort);
          questions.delete(t.id);
          patchTask(t.id, { status: 'running', statusLine: 'Got an answer, continuing' });
          resolve(`Your manager replied:\n${answer}`);
        },
        reject,
      });
    });
  },

  async delegate(agentId, items, signal) {
    const parent = tasks.get(agentId);
    if (!parent) throw new ToolError('Only task agents can delegate.');
    if (parent.parentId) throw new ToolError('Helpers cannot delegate further. Do this part yourself.');
    const children = items.map((item) => {
      const crew = item.crew ? resolveCrew(item.crew) : resolveCrew(parent.crewId);
      const child: Task = {
        id: nextId('T'),
        projectId: parent.projectId,
        parentId: parent.id,
        title: item.title,
        brief: item.brief,
        status: 'queued',
        crewId: crew.id,
        crewName: crew.name,
        runtime: crew.runtime,
        model: crew.model,
        effort: crew.effort ?? null,
        dependsOn: [],
        statusLine: '',
        result: '',
        error: '',
        attempt: 1,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        costIncluded: runtimeDef(crew.runtime).kind === 'cli',
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      };
      tasks.insert(child);
      return child;
    });
    sync({ tasks: children });
    patchTask(parent.id, { statusLine: `Waiting on ${children.length} helper${children.length > 1 ? 's' : ''}` });
    const onAbort = () => children.forEach((c) => orch.cancelTask(c.id, 'Parent task stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const outcomes = await Promise.all(
        children.map(
          (c) =>
            new Promise<Outcome>((resolve) => {
              childDone.set(c.id, resolve);
              // Helpers start at once: their parent already holds a slot and is only waiting.
              startTask(c);
            }),
        ),
      );
      return outcomes
        .map((o, i) => `## ${children[i].id}: ${children[i].title}\n${o.ok ? clip(o.text, 10_000) : `FAILED: ${o.error ?? 'unknown error'}`}`)
        .join('\n\n');
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  },

  approve(agentId, tool, summary, detail, signal) {
    if (getSettings().approvalMode !== 'ask') return Promise.resolve(true);
    const before = tasks.get(agentId);
    const id = nextId('A');
    approvals.insert({ id, agentId, tool, summary, detail, status: 'pending', createdAt: Date.now() });
    sync({ approvals: approvals.pending() });
    if (before) patchTask(agentId, { status: 'waiting', statusLine: 'Waiting for your approval' });
    return new Promise<boolean>((resolve) => {
      const settle = (ok: boolean) => {
        signal.removeEventListener('abort', onAbort);
        approvalWaiters.delete(id);
        approvals.resolve(id, ok ? 'approved' : 'denied');
        sync({ approvals: approvals.pending() });
        const cur = tasks.get(agentId);
        if (cur && cur.status === 'waiting') patchTask(agentId, { status: 'running', statusLine: ok ? 'Approved, continuing' : 'Declined, rethinking' });
        resolve(ok);
      };
      const onAbort = () => settle(false);
      signal.addEventListener('abort', onAbort, { once: true });
      approvalWaiters.set(id, settle);
    });
  },
};

function specFor(id: string): AgentSpec {
  const s = getSettings();
  if (id === PM) {
    const cli = runtimeDef(s.pm.runtime).kind === 'cli';
    return {
      id: PM,
      manager: true,
      runtime: s.pm.runtime,
      model: s.pm.model,
      effort: s.pm.effort,
      cwd: PM_DIR,
      system: PM_SYSTEM,
      tools: pmTools(orch),
      mcp: cli ? { url: `${baseUrl}/mcp`, token: MCP_TOKEN } : undefined,
    };
  }
  const t = tasks.get(id);
  if (!t) throw new Error(`Unknown agent ${id}`);
  const project = projects.get(t.projectId);
  if (!project) throw new Error(`Task ${id} has no project`);
  fs.mkdirSync(project.workspace, { recursive: true });
  return {
    id: t.id,
    manager: false,
    runtime: t.runtime,
    model: t.model,
    effort: t.effort,
    cwd: project.workspace,
    system: workerSystem({ crewName: t.crewName, cwd: project.workspace, helper: !!t.parentId }),
    tools: workerTools({ canDelegate: !t.parentId }),
    cliPreamble: cliWorkerPreamble({ crewName: t.crewName, cwd: project.workspace }),
  };
}

function onStart(id: string): void {
  if (id === PM) return sync({ pm: pmStatus() });
  const t = tasks.get(id);
  // A finished agent that receives a follow-up message goes back to work.
  if (t && t.status !== 'running') patchTask(id, { status: 'running', finishedAt: null, statusLine: 'Picking up a follow-up' });
}

function onFinish(id: string, outcome: Outcome): void {
  if (id === PM) return sync({ pm: pmStatus() });
  const t = tasks.get(id);
  if (!t) return;
  const now = Date.now();
  let next: Task | null;
  if (outcome.ok) {
    next = patchTask(id, { status: 'done', result: outcome.text, error: '', finishedAt: now, statusLine: 'Finished' });
  } else if (outcome.aborted) {
    // cancelTask already recorded why; anything else that aborted a run is an interruption.
    next = t.status === 'cancelled' ? t : patchTask(id, { status: 'interrupted', finishedAt: now, statusLine: 'Stopped' });
  } else {
    next = patchTask(id, { status: 'failed', error: outcome.error ?? 'Unknown error', finishedAt: now, statusLine: 'Failed' });
  }
  if (!next) return;

  const waiter = childDone.get(id);
  if (waiter) {
    childDone.delete(id);
    waiter(outcome);
  } else if (!next.parentId) {
    if (next.status === 'done') {
      notifyPm(taskEvent('task_done', next, clip(outcome.text || '(the agent returned no report)', 8000), `${next.id} finished · ${next.title}`));
    } else if (next.status === 'failed') {
      notifyPm(taskEvent('task_failed', next, outcome.error ?? 'Unknown error', `${next.id} failed · ${next.title}`));
    }
  }
  tick();
}

function onUsage(id: string, usage: Usage, costUsd: number, included: boolean): void {
  if (id === PM) {
    const u = kvGet('pm:usage', { tokensIn: 0, tokensOut: 0, costUsd: 0 });
    kvSet('pm:usage', {
      tokensIn: u.tokensIn + usage.input,
      tokensOut: u.tokensOut + usage.output,
      costUsd: u.costUsd + (included ? 0 : costUsd),
    });
    return sync({ pm: pmStatus() });
  }
  const t = tasks.get(id);
  if (!t) return;
  patchTask(id, {
    tokensIn: t.tokensIn + usage.input,
    tokensOut: t.tokensOut + usage.output,
    costUsd: t.costUsd + costUsd,
    costIncluded: included,
  });
}

export const runner = new Runner({ spec: specFor, host, onStart, onFinish, onUsage });

// ---------- the orchestrator API (used by PM tools and the HTTP layer) ----------

export const orch: Orch & {
  chat(text: string): void;
  /** The user stopped a task from the dashboard; the PM should know its plan changed. */
  userCancelled(id: string): void;
  stopPm(): void;
  resetPm(): void;
  deleteProject(id: string): void;
  resolveApproval(id: string, ok: boolean): void;
  state(): Promise<AppState>;
  boot(): void;
} = {
  async createProject({ name, goal, workspacePath }) {
    const id = nextId('P');
    let workspace: string;
    if (workspacePath) {
      workspace = path.resolve(workspacePath.replace(/^~(?=$|\/)/, os.homedir()));
      const stat = fs.existsSync(workspace) ? fs.statSync(workspace) : null;
      if (stat && !stat.isDirectory()) throw new ToolError(`${workspace} is a file, not a folder.`);
    } else {
      workspace = path.join(getSettings().workspaceRoot, `${slug(name)}-${id.toLowerCase()}`);
    }
    fs.mkdirSync(workspace, { recursive: true });
    const now = Date.now();
    const project: Project = {
      id,
      name,
      goal,
      status: 'active',
      notes: '',
      workspace,
      hue: (projects.all().length * 67 + 28) % 360,
      createdAt: now,
      updatedAt: now,
    };
    projects.insert(project);
    sync({ projects: [project] });
    return project;
  },

  updateProject(id, patch) {
    const next = projects.update(id, patch);
    if (!next) throw new ToolError(`No project ${id}.`);
    sync({ projects: [next] });
    tick();
    return next;
  },

  createTasks(projectId, items) {
    const created: Task[] = [];
    for (const item of items) {
      const crew = resolveCrew(item.crew);
      const dependsOn = (item.dependsOn ?? []).map((ref) => {
        const m = /^#(\d+)$/.exec(ref.trim());
        if (m) {
          const hit = created[Number(m[1]) - 1];
          if (!hit) throw new ToolError(`depends_on "${ref}" points past the tasks created so far in this call.`);
          return hit.id;
        }
        const t = tasks.get(ref);
        if (!t) throw new ToolError(`depends_on refers to unknown task "${ref}".`);
        return t.id;
      });
      const t: Task = {
        id: nextId('T'),
        projectId,
        parentId: null,
        title: item.title,
        brief: item.brief,
        status: 'queued',
        crewId: crew.id,
        crewName: crew.name,
        runtime: crew.runtime,
        model: crew.model,
        effort: crew.effort ?? null,
        dependsOn,
        statusLine: '',
        result: '',
        error: '',
        attempt: 1,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        costIncluded: runtimeDef(crew.runtime).kind === 'cli',
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
      };
      tasks.insert(t);
      created.push(t);
    }
    sync({ tasks: created });
    tick();
    return created.map((t) => tasks.get(t.id)!);
  },

  messageTask(id, text, from) {
    const t = tasks.get(id);
    if (!t) throw new ToolError(`No task ${id}.`);
    const waiting = questions.get(t.id);
    if (waiting) {
      emit(t.id, 'user', { from, text });
      waiting.resolve(text);
      return;
    }
    if (t.status === 'queued') {
      patchTask(t.id, { brief: `${t.brief}\n\nAdded by your manager: ${text}` });
      return;
    }
    runner.send(t.id, { from, text });
  },

  cancelTask(id, reason) {
    const t = tasks.get(id);
    if (!t) return;
    for (const child of tasks.byProject(t.projectId).filter((c) => c.parentId === t.id)) {
      if (['queued', 'running', 'waiting'].includes(child.status)) orch.cancelTask(child.id, 'Parent task cancelled');
    }
    if (['queued', 'running', 'waiting'].includes(t.status)) {
      patchTask(t.id, { status: 'cancelled', finishedAt: Date.now(), statusLine: reason.slice(0, 160) });
      emit(t.id, 'notice', { text: `Cancelled: ${reason}` });
    }
    runner.stop(t.id);
    const w = childDone.get(t.id);
    if (w && !runner.isBusy(t.id)) {
      childDone.delete(t.id);
      w({ ok: false, text: '', error: 'cancelled', aborted: true });
    }
    tick();
  },

  retryTask(id, note) {
    const t = tasks.get(id);
    if (!t) throw new ToolError(`No task ${id}.`);
    kvSet(`retry-note:${t.id}`, note ?? '');
    emit(t.id, 'notice', { text: `Retry requested${note ? `: ${note}` : ''}` });
    // Pick up the crew member's current runtime and model, in case they were fixed in Settings.
    const crew = resolveCrew(t.crewId);
    const same = crew.id === t.crewId;
    patchTask(t.id, {
      status: 'queued',
      attempt: t.attempt + 1,
      error: '',
      finishedAt: null,
      statusLine: 'Queued for another attempt',
      ...(same ? { runtime: crew.runtime, model: crew.model, effort: crew.effort ?? null } : {}),
    });
    tick();
  },

  memoryChanged() {
    sync({ memory: memory.all() });
  },

  remindersChanged() {
    sync({ reminders: reminders.all() });
  },

  chat(text) {
    runner.send(PM, { from: 'user', text: `${contextBlock(true)}\n\n${text}`, display: text });
    sync({ pm: pmStatus() });
  },

  userCancelled(id) {
    const t = tasks.get(id);
    if (!t || !['queued', 'running', 'waiting'].includes(t.status)) return;
    orch.cancelTask(t.id, 'Cancelled by you');
    const after = tasks.get(t.id);
    if (after && !after.parentId) {
      notifyPm(taskEvent('task_cancelled', after, 'The user cancelled this task from the dashboard.', `${t.id} cancelled by you · ${t.title}`));
    }
  },

  stopPm() {
    pendingEvents.length = 0;
    runner.stop(PM);
    emit(PM, 'notice', { text: 'Stopped.' });
    sync({ pm: pmStatus() });
  },

  resetPm() {
    pendingEvents.length = 0;
    runner.reset(PM);
    events.clear(PM);
    kvSet('pm:usage', { tokensIn: 0, tokensOut: 0, costUsd: 0 });
    sync({ pm: pmStatus() });
  },

  deleteProject(id) {
    for (const t of tasks.byProject(id)) {
      orch.cancelTask(t.id, 'Project deleted');
      runner.reset(t.id);
    }
    // Rows go; the workspace folder stays on disk — it may hold work the user wants.
    projects.remove(id);
    sync({ removedProjects: [id] });
  },

  resolveApproval(id, ok) {
    approvalWaiters.get(id)?.(ok);
  },

  async state() {
    return {
      settings: getSettings(),
      runtimes: await runtimeStatus(),
      projects: projects.all(),
      tasks: tasks.all(),
      approvals: approvals.pending(),
      memory: memory.all(),
      reminders: reminders.all(),
      pm: pmStatus(),
      demo: DEMO || getSettings().pm.runtime === 'demo',
      version: VERSION,
    };
  },

  boot() {
    // Nothing survives a restart mid-run: agents that were working are marked interrupted
    // (the PM or the user can retry them) and approvals that were pending are void.
    for (const t of tasks.all()) {
      if (t.status === 'running' || t.status === 'waiting') {
        tasks.update(t.id, { status: 'interrupted', statusLine: 'Interrupted by a restart', finishedAt: Date.now() });
      }
    }
    approvals.expireAll();
    setInterval(() => {
      const now = Date.now();
      for (const r of reminders.all()) {
        if (r.dueAt > now) continue;
        notifyPm({
          xml: () => `<event type="reminder" id="${r.id}">\n${r.note}\n</event>`,
          display: `Reminder · ${r.note}`,
        });
        if (r.repeatMinutes) reminders.reschedule(r.id, now + r.repeatMinutes * 60_000);
        else reminders.remove(r.id);
        sync({ reminders: reminders.all() });
      }
    }, 20_000).unref();
    tick();
  },
};

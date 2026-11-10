import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Project, Reminder, Task } from '../../shared/types.ts';
import { events, memory, projects, reminders, tasks } from '../db.ts';
import { fileSize, inboxFile } from '../inbox.ts';
import { getSettings } from '../settings.ts';
import { clip, defineTool, ToolError, type Tool } from './tool.ts';
import { walk, webFetch } from './worker.ts';

/** What the PM's tools need from the orchestrator. */
export interface Orch {
  createProject(input: { name: string; goal: string; workspacePath?: string }): Promise<Project>;
  updateProject(id: string, patch: Partial<Project>): Project;
  createTasks(
    projectId: string,
    items: { title: string; brief: string; crew?: string; dependsOn?: string[] }[],
  ): Task[];
  messageTask(id: string, text: string, from: 'manager' | 'user'): void;
  cancelTask(id: string, reason: string): void;
  retryTask(id: string, note?: string): void;
  /** Deliver a file to the user's phone. Resolves to a sentence saying where it went. */
  sendFileToUser(file: string, caption: string): Promise<string>;
  memoryChanged(): void;
  remindersChanged(): void;
}

function needProject(ref: string): Project {
  const p = projects.find(ref);
  if (!p) throw new ToolError(`No project "${ref}". Use list_projects to see ids.`);
  return p;
}

function needTask(ref: string): Task {
  const t = tasks.get(ref);
  if (!t) throw new ToolError(`No task "${ref}".`);
  return t;
}

/** Resolve a path the PM asked for, refusing anything outside the project's workspace. */
function inWorkspace(p: Project, sub: string): string {
  const root = path.resolve(p.workspace);
  const target = path.resolve(root, sub);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError(`"${sub}" is outside the workspace of ${p.id}.`);
  return target;
}

function ago(ts: number | null): string {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 48) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function taskLine(t: Task): string {
  const deps = t.dependsOn.length ? ` after ${t.dependsOn.join(',')}` : '';
  const note = t.status === 'failed' ? t.error : t.statusLine;
  return `${t.id} [${t.status}] ${t.title} — ${t.crewName}${deps}${note ? ` · ${note.slice(0, 120)}` : ''}`;
}

export function projectSummary(p: Project): string {
  const list = tasks.byProject(p.id).filter((t) => !t.parentId);
  const count = (s: string) => list.filter((t) => t.status === s).length;
  const bits = [
    count('running') && `${count('running')} running`,
    count('waiting') && `${count('waiting')} waiting on an answer`,
    count('queued') && `${count('queued')} queued`,
    count('failed') + count('interrupted') && `${count('failed') + count('interrupted')} failed`,
    count('done') && `${count('done')} done`,
  ].filter(Boolean);
  return `${p.id} "${p.name}" (${p.status})${bits.length ? `: ${bits.join(', ')}` : ': no tasks yet'}`;
}

export function pmTools(orch: Orch): Tool[] {
  const listProjects = defineTool({
    name: 'list_projects',
    description: 'List every project with its status and task counts.',
    input: z.object({ include_archived: z.boolean().optional() }),
    async run({ include_archived }) {
      const all = projects.all().filter((p) => include_archived || p.status !== 'archived');
      return all.length ? all.map(projectSummary).join('\n') : 'No projects yet.';
    },
  });

  const getProject = defineTool({
    name: 'get_project',
    description: "Read one project: goal, your notes, workspace path, and every task with its status and latest note.",
    input: z.object({ project: z.string().describe('Project id (P-1) or exact name.') }),
    async run({ project }) {
      const p = needProject(project);
      const list = tasks.byProject(p.id);
      const lines = list.map((t) => `${t.parentId ? '    ↳ ' : '  '}${taskLine(t)}`);
      return [
        `${p.id} "${p.name}" — ${p.status}`,
        `Goal: ${p.goal || '(none recorded)'}`,
        `Workspace: ${p.workspace}`,
        `Notes: ${p.notes || '(none)'}`,
        `Tasks:`,
        lines.length ? lines.join('\n') : '  (none)',
      ].join('\n');
    },
  });

  const createProject = defineTool({
    name: 'create_project',
    description:
      'Start tracking a new project. Each project gets its own workspace folder that its agents work in. ' +
      'Pass workspace_path only when the user wants agents to work in an existing folder (a repo, a documents folder).',
    input: z.object({
      name: z.string().min(1).max(80),
      goal: z.string().describe('What done looks like, in the user’s terms.'),
      workspace_path: z.string().optional(),
    }),
    async run({ name, goal, workspace_path }) {
      const p = await orch.createProject({ name, goal, workspacePath: workspace_path });
      return `Created ${p.id} "${p.name}". Workspace: ${p.workspace}`;
    },
  });

  const updateProject = defineTool({
    name: 'update_project',
    description:
      'Update a project. Use notes as your own running brief for the project: decisions, constraints, where things stand. ' +
      'Notes replace the previous notes, so write the full current version.',
    input: z.object({
      project: z.string(),
      name: z.string().optional(),
      goal: z.string().optional(),
      status: z.enum(['active', 'paused', 'done', 'archived']).optional(),
      notes: z.string().optional(),
    }),
    async run({ project, ...patch }) {
      const p = needProject(project);
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const next = orch.updateProject(p.id, clean);
      return `Updated ${next.id} "${next.name}" (${next.status}).`;
    },
  });

  const createTasks = defineTool({
    name: 'create_tasks',
    description:
      'Create one or more tasks in a project and assign each to a crew member. Tasks start automatically, ' +
      'in parallel up to the concurrency limit; a task with depends_on waits for those tasks to finish and ' +
      'receives their reports. The agent sees only its brief (plus dependency reports), so write briefs that ' +
      'stand alone: the goal and why, relevant context and constraints, what to produce and where, and what to report back.',
    input: z.object({
      project: z.string(),
      tasks: z
        .array(
          z.object({
            title: z.string().max(100),
            brief: z.string(),
            crew: z.string().optional().describe('Crew member id or name. Omit for the default.'),
            depends_on: z
              .array(z.string())
              .optional()
              .describe('Task ids (T-4), or "#1", "#2"… to reference tasks earlier in this same call.'),
          }),
        )
        .min(1)
        .max(12),
    }),
    async run({ project, tasks: items }) {
      const p = needProject(project);
      const created = orch.createTasks(
        p.id,
        items.map((i) => ({ title: i.title, brief: i.brief, crew: i.crew, dependsOn: i.depends_on })),
      );
      return `Created in ${p.id}:\n${created.map(taskLine).join('\n')}`;
    },
  });

  const getTask = defineTool({
    name: 'get_task',
    description: "Read a task's brief, status, final report and its most recent activity.",
    input: z.object({
      task: z.string(),
      activity: z.number().int().min(0).max(60).optional().describe('How many recent activity lines to include. Default 12.'),
    }),
    async run({ task, activity }) {
      const t = needTask(task);
      const recent = events
        .list(t.id, { limit: 200 })
        .filter((e) => e.type !== 'usage' && e.type !== 'thinking')
        .slice(-(activity ?? 12))
        .map((e) => {
          if (e.type === 'tool_call') return `  → ${e.data.name} ${JSON.stringify(e.data.input).slice(0, 160)}`;
          if (e.type === 'tool_result') return `  ← ${String(e.data.output).replace(/\s+/g, ' ').slice(0, 160)}`;
          return `  ${e.type}: ${String(e.data.text ?? e.data.message ?? '').replace(/\s+/g, ' ').slice(0, 220)}`;
        });
      const children = tasks.byProject(t.projectId).filter((c) => c.parentId === t.id);
      return [
        taskLine(t),
        `Started ${ago(t.startedAt) || '—'}${t.finishedAt ? `, finished ${ago(t.finishedAt)}` : ''}. Attempt ${t.attempt}. Model ${t.model || 'default'} via ${t.runtime}.`,
        `Brief: ${clip(t.brief, 3000)}`,
        children.length ? `Helpers:\n${children.map((c) => `  ${taskLine(c)}`).join('\n')}` : '',
        t.error ? `Error: ${t.error}` : '',
        t.result ? `Report:\n${clip(t.result, 12_000)}` : 'Report: (none yet)',
        recent.length ? `Recent activity:\n${recent.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  });

  const messageAgent = defineTool({
    name: 'message_agent',
    description:
      "Send a message to a task's agent: answer its question, redirect it, or ask a finished agent for a follow-up " +
      '(it keeps its context and resumes). The reply arrives later as an event.',
    input: z.object({ task: z.string(), message: z.string() }),
    async run({ task, message }) {
      const t = needTask(task);
      if (t.status === 'cancelled') throw new ToolError(`${t.id} was cancelled. Use retry_task to run it again.`);
      orch.messageTask(t.id, message, 'manager');
      return `Delivered to ${t.id}.`;
    },
  });

  const cancelTask = defineTool({
    name: 'cancel_task',
    description: 'Stop a queued or running task.',
    input: z.object({ task: z.string(), reason: z.string().optional() }),
    async run({ task, reason }) {
      const t = needTask(task);
      orch.cancelTask(t.id, reason ?? 'Cancelled by the project manager');
      return `Cancelled ${t.id}.`;
    },
  });

  const retryTask = defineTool({
    name: 'retry_task',
    description:
      'Run a failed, interrupted or cancelled task again. The agent keeps its earlier context where possible; ' +
      'add a note to tell it what to do differently.',
    input: z.object({ task: z.string(), note: z.string().optional() }),
    async run({ task, note }) {
      const t = needTask(task);
      if (t.status === 'running' || t.status === 'queued') throw new ToolError(`${t.id} is already ${t.status}.`);
      orch.retryTask(t.id, note);
      return `Re-queued ${t.id}.`;
    },
  });

  const listFiles = defineTool({
    name: 'list_files',
    description: "List files in a project's workspace, to see what agents produced.",
    input: z.object({ project: z.string(), path: z.string().optional(), depth: z.number().int().min(1).max(5).optional() }),
    async run({ project, path: sub, depth }) {
      const p = needProject(project);
      const dir = inWorkspace(p, sub ?? '.');
      const out: string[] = [];
      await walk(dir, dir, depth ?? 2, out, 300);
      return out.length ? out.join('\n') : '(empty)';
    },
  });

  const readFile = defineTool({
    name: 'read_file',
    description: "Read a file from a project's workspace, to check an agent's output before reporting on it.",
    input: z.object({ project: z.string(), path: z.string() }),
    async run({ project, path: sub }) {
      const p = needProject(project);
      const file = inWorkspace(p, sub);
      const text = await fs.readFile(file, 'utf8').catch(() => null);
      if (text === null) throw new ToolError(`No such file in ${p.id}: ${sub}`);
      return clip(text, 40_000);
    },
  });

  const addFileToProject = defineTool({
    name: 'add_file_to_project',
    description:
      'Copy a file the user sent (it is in the inbox; its name is given in the <attachments> block of their message) into a ' +
      "project's workspace, so the agents on that project can work with it. Returns the path to quote in task briefs.",
    input: z.object({
      project: z.string(),
      file: z.string().describe('The inbox file name, or its full path, exactly as given in <attachments>.'),
      to: z.string().optional().describe('Where to put it inside the workspace. Default: attachments/<original name>.'),
    }),
    async run({ project, file, to }) {
      const p = needProject(project);
      const source = await inboxFile(path.basename(file));
      if (!source) throw new ToolError(`There is no file "${file}" in the inbox. Use the name from the <attachments> block.`);
      // Inbox copies are named <timestamp>-<original name>; the project gets the original name back.
      const original = path.basename(source).replace(/^\d{8}-\d{6}-/, '');
      const dest = inWorkspace(p, to ?? path.join('attachments', original));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(source, dest);
      const rel = path.relative(p.workspace, dest);
      return `Copied to ${rel} in ${p.id} "${p.name}". Agents on this project can open it at that path.`;
    },
  });

  const sendFile = defineTool({
    name: 'send_file',
    description:
      "Send a file from a project's workspace to the user's phone (over Telegram): a finished report, an image, an export. " +
      'Use it when they ask for a deliverable while away from their computer, or when handing over something they will want to open.',
    input: z.object({
      project: z.string(),
      path: z.string().describe('Path of the file inside the project workspace.'),
      caption: z.string().max(900).optional().describe('A line of text to show with the file.'),
    }),
    async run({ project, path: sub, caption }) {
      const p = needProject(project);
      const file = inWorkspace(p, sub);
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) throw new ToolError(`No such file in ${p.id}: ${sub}`);
      if (stat.size > 50 * 1024 * 1024) throw new ToolError(`${sub} is ${fileSize(stat.size)}; Telegram lets a bot send at most 50 MB.`);
      try {
        return await orch.sendFileToUser(file, caption ?? '');
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
    },
  });

  const remember = defineTool({
    name: 'remember',
    description:
      'Save a durable fact about the user or how they like things done, so it is still known in later conversations. ' +
      'Not for project status — that belongs in project notes.',
    input: z.object({ fact: z.string().max(500) }),
    async run({ fact }) {
      const m = memory.add(fact);
      orch.memoryChanged();
      return `Saved as ${m.id}.`;
    },
  });

  const forget = defineTool({
    name: 'forget',
    description: 'Delete a saved memory by id (M-3) when it is wrong or out of date.',
    input: z.object({ memory_id: z.string() }),
    async run({ memory_id }) {
      if (!memory.remove(memory_id)) throw new ToolError(`No memory ${memory_id}.`);
      orch.memoryChanged();
      return `Forgot ${memory_id}.`;
    },
  });

  const setReminder = defineTool({
    name: 'set_reminder',
    description:
      'Wake yourself up later with a note — to check on something, follow up with the user, or run a recurring review. ' +
      'Give either in_minutes or at.',
    input: z.object({
      note: z.string().describe('What you should do when this fires.'),
      in_minutes: z.number().min(1).optional(),
      at: z.string().optional().describe('ISO 8601 date-time, e.g. 2026-03-02T09:00:00-08:00.'),
      repeat_minutes: z.number().int().min(15).optional().describe('Repeat on this interval after the first firing.'),
    }),
    async run({ note, in_minutes, at, repeat_minutes }) {
      const due = at ? Date.parse(at) : Date.now() + (in_minutes ?? 60) * 60_000;
      if (!Number.isFinite(due)) throw new ToolError(`Could not parse "${at}" as a date-time.`);
      const r: Reminder = reminders.add(note, due, repeat_minutes ?? null);
      orch.remindersChanged();
      return `Reminder ${r.id} set for ${new Date(due).toLocaleString()}${repeat_minutes ? `, repeating every ${repeat_minutes} min` : ''}.`;
    },
  });

  const cancelReminder = defineTool({
    name: 'cancel_reminder',
    description: 'Delete a reminder by id (R-2).',
    input: z.object({ reminder_id: z.string() }),
    async run({ reminder_id }) {
      if (!reminders.remove(reminder_id)) throw new ToolError(`No reminder ${reminder_id}.`);
      orch.remindersChanged();
      return `Cancelled ${reminder_id}.`;
    },
  });

  const listCrew = defineTool({
    name: 'list_crew',
    description: 'List the crew members you can assign tasks to, with what each is good at and its current reminders.',
    input: z.object({}),
    async run() {
      const s = getSettings();
      const crew = s.crew
        .map((c) => `${c.id}${c.id === s.defaultCrewId ? ' (default)' : ''}: ${c.name} — ${c.strengths} [${c.runtime}${c.model ? ` · ${c.model}` : ''}]`)
        .join('\n');
      const rem = reminders.all().map((r) => `${r.id}: ${new Date(r.dueAt).toLocaleString()} — ${r.note}`);
      return `Crew:\n${crew}\n\nReminders:\n${rem.length ? rem.join('\n') : '(none)'}`;
    },
  });

  return [
    listProjects,
    getProject,
    createProject,
    updateProject,
    createTasks,
    getTask,
    messageAgent,
    cancelTask,
    retryTask,
    listFiles,
    readFile,
    addFileToProject,
    sendFile,
    remember,
    forget,
    setReminder,
    cancelReminder,
    listCrew,
    webFetch,
  ];
}

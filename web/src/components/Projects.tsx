import { ArrowLeft, ChevronRight, File, Folder, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FileEntry, Project, ProjectStatus, Task, TaskStatus } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ago, bytes, compact, duration, isLive, isTrouble, money, taskElapsed, useNow } from '../lib.ts';
import { useStore } from '../store.ts';
import { attempt, Empty, Markdown, StatusPill, TaskAvatar } from './ui.tsx';

function counts(tasks: Task[]) {
  const top = tasks.filter((t) => !t.parentId);
  const n = (s: TaskStatus[]) => top.filter((t) => s.includes(t.status)).length;
  return {
    total: top.length,
    done: n(['done']),
    running: n(['running']),
    waiting: n(['waiting']),
    queued: n(['queued']),
    failed: n(['failed', 'interrupted']),
  };
}

function ProgressBar({ c }: { c: ReturnType<typeof counts> }) {
  if (!c.total) return <div className="bar" />;
  return (
    <div className="bar" role="img" aria-label={`${c.done} of ${c.total} tasks done`}>
      {(['done', 'running', 'waiting', 'failed', 'queued'] as const).map((k) =>
        c[k] ? <i key={k} className={k} style={{ flexGrow: c[k] }} /> : null,
      )}
    </div>
  );
}

// ---------- list ----------

export function ProjectCard({ project: p, now }: { project: Project; now: number }) {
  const all = useStore((s) => s.app?.tasks);
  const tasks = useMemo(() => (all ?? []).filter((t) => t.projectId === p.id), [all, p.id]);
  const c = counts(tasks);
  const workers = tasks.filter(isLive).slice(0, 5);
  return (
    <a
      href={`#/projects/${p.id}`}
      className="card proj-card"
      style={{ ['--hue' as string]: p.hue, color: 'inherit', textDecoration: 'none', opacity: p.status === 'archived' ? 0.6 : 1 }}
    >
      <div className="row">
        <span className="chip">{p.id}</span>
        {p.status !== 'active' && <span className="pill">{p.status}</span>}
        <span className="grow" />
        <span className="faint" style={{ fontSize: 12 }}>
          {ago(p.updatedAt, now)}
        </span>
      </div>
      <h3>{p.name}</h3>
      <div className="goal">{p.goal || 'No goal recorded yet.'}</div>
      <ProgressBar c={c} />
      <div className="row">
        <div className="counts grow">
          <span>
            <b>{c.done}</b>/{c.total} done
          </span>
          {c.running > 0 && (
            <span style={{ color: 'var(--accent)' }}>
              <b style={{ color: 'inherit' }}>{c.running}</b> working
            </span>
          )}
          {c.waiting > 0 && (
            <span style={{ color: 'var(--attn)' }}>
              <b style={{ color: 'inherit' }}>{c.waiting}</b> waiting
            </span>
          )}
          {c.failed > 0 && (
            <span style={{ color: 'var(--bad)' }}>
              <b style={{ color: 'inherit' }}>{c.failed}</b> failed
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 4 }}>
          {workers.map((t) => (
            <TaskAvatar key={t.id} task={t} small />
          ))}
        </div>
      </div>
    </a>
  );
}


function NewProject({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [folder, setFolder] = useState('');
  const create = async () => {
    const p = await attempt(() => api.createProject({ name, goal, workspacePath: folder.trim() || undefined }));
    if (p) {
      onDone();
      window.location.hash = `/projects/${p.id}`;
    }
  };
  return (
    <div className="card" style={{ padding: 16, marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="np-name">Name</label>
          <input id="np-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Kitchen renovation" />
        </div>
        <div className="field">
          <label htmlFor="np-folder">Existing folder (optional)</label>
          <input id="np-folder" className="input mono" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="~/code/my-repo" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="np-goal">What does done look like?</label>
        <textarea id="np-goal" className="textarea" value={goal} onChange={(e) => setGoal(e.target.value)} />
      </div>
      <div className="row">
        <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
          Create project
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <span className="hint">Or just tell your manager about it — it creates projects for you.</span>
      </div>
    </div>
  );
}

export function Projects() {
  const app = useStore((s) => s.app)!;
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const now = useNow(false);
  const list = app.projects.filter((p) => showArchived || p.status !== 'archived');
  const archived = app.projects.length - app.projects.filter((p) => p.status !== 'archived').length;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div className="grow">
            <h1 className="page-title">Projects</h1>
            <p className="page-sub">Everything your manager is keeping track of. Open one to see its tasks, files and notes.</p>
          </div>
          {archived > 0 && (
            <button className="btn ghost" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Hide' : 'Show'} archived ({archived})
            </button>
          )}
          <button className="btn" onClick={() => setAdding(true)}>
            <Plus size={15} /> New project
          </button>
        </div>
        {adding && <NewProject onDone={() => setAdding(false)} />}
        {list.length === 0 && !adding ? (
          <Empty title="No projects yet">
            Tell your manager what you are working on and it will set one up. <a href="#/chat">Open the chat</a>
          </Empty>
        ) : (
          <div className="proj-grid">
            {list.map((p) => (
              <ProjectCard key={p.id} project={p} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- detail ----------

function TaskCard({ task, now, child }: { task: Task; now: number; child?: boolean }) {
  const open = useStore((s) => s.setOpenAgent);
  const note = task.status === 'failed' ? task.error : task.status === 'done' ? task.result.replace(/[#*`_>]/g, '').slice(0, 160) : task.statusLine;
  return (
    <button className={`card task-card${child ? ' child' : ''}`} onClick={() => open(task.id)}>
      <span className="t">{task.title}</span>
      {note && (
        <span className="note" style={{ color: isTrouble(task) ? 'var(--bad)' : task.status === 'waiting' ? 'var(--attn)' : undefined }}>
          {note}
        </span>
      )}
      <span className="foot">
        <TaskAvatar task={task} small />
        <span>{task.crewName}</span>
        <span className="chip">{task.id}</span>
        {task.dependsOn.length > 0 && task.status === 'queued' && <span className="chip">after {task.dependsOn.join(', ')}</span>}
        <span className="grow" />
        {task.startedAt && <span className="tnum">{duration(taskElapsed(task, now))}</span>}
      </span>
    </button>
  );
}

const COLUMNS: { title: string; statuses: TaskStatus[]; color: string }[] = [
  { title: 'Queued', statuses: ['queued'], color: 'var(--text-3)' },
  { title: 'Working', statuses: ['running', 'waiting'], color: 'var(--accent)' },
  { title: 'Needs a look', statuses: ['failed', 'interrupted', 'cancelled'], color: 'var(--bad)' },
  { title: 'Done', statuses: ['done'], color: 'var(--ok)' },
];

function Board({ tasks }: { tasks: Task[] }) {
  const now = useNow(tasks.some(isLive));
  const top = tasks.filter((t) => !t.parentId);
  if (!top.length) {
    return (
      <Empty title="No tasks yet">
        Ask your manager to get started on this project. <a href="#/chat">Open the chat</a>
      </Empty>
    );
  }
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const list = top.filter((t) => col.statuses.includes(t.status));
        if (col.title === 'Done') list.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
        return (
          <div key={col.title} className="col">
            <header>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: col.color }} />
              {col.title}
              <span className="n">{list.length}</span>
            </header>
            <div className="col-list">
              {list.map((t) => (
                <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <TaskCard task={t} now={now} />
                  {tasks
                    .filter((c) => c.parentId === t.id)
                    .map((c) => (
                      <TaskCard key={c.id} task={c} now={now} child />
                    ))}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Files({ project }: { project: Project }) {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [open, setOpen] = useState<{ path: string; content: string; note?: string; size: number } | null>(null);
  // Reload the listing when an agent on this project finishes, since that is when files appear.
  const doneCount = useStore((s) => s.app?.tasks.filter((t) => t.projectId === project.id && t.status === 'done').length ?? 0);

  useEffect(() => {
    let live = true;
    api
      .files(project.id, dir)
      .then((list) => live && setEntries(list))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [project.id, dir, doneCount]);

  const show = async (e: FileEntry) => {
    if (e.dir) return setDir(e.path);
    const f = await attempt(() => api.file(project.id, e.path));
    if (f) setOpen({ path: e.path, ...f });
  };
  const crumbs = dir ? dir.split('/') : [];
  const isMd = !!open && /\.(md|markdown)$/i.test(open.path);

  return (
    <div className="files">
      <div className="card file-list">
        <div className="row" style={{ padding: '4px 8px 8px', fontSize: 12.5, flexWrap: 'wrap', gap: 2 }}>
          <button className="more" style={{ margin: 0 }} onClick={() => setDir('')}>
            workspace
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="row" style={{ gap: 2 }}>
              <ChevronRight size={12} className="faint" />
              <button className="more" style={{ margin: 0 }} onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
            </span>
          ))}
        </div>
        {entries === null ? (
          <div className="hint" style={{ padding: 8 }}>
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <div className="hint" style={{ padding: 8 }}>
            Nothing here yet.
          </div>
        ) : (
          entries.map((e) => (
            <button key={e.path} className={`file-row${open?.path === e.path ? ' active' : ''}`} onClick={() => void show(e)}>
              {e.dir ? <Folder size={14} /> : <File size={14} />}
              <span className="grow truncate">{e.name}</span>
              {!e.dir && <span className="faint" style={{ fontSize: 11 }}>{bytes(e.size)}</span>}
            </button>
          ))
        )}
      </div>
      <div className="card file-view">
        {!open ? (
          <div className="faint" style={{ display: 'grid', placeItems: 'center', height: '100%', minHeight: 300, textAlign: 'center' }}>
            <div>
              <FolderOpen size={26} style={{ opacity: 0.6 }} />
              <div style={{ marginTop: 8 }}>Pick a file to preview what the crew produced.</div>
              <div className="mono" style={{ marginTop: 6, fontSize: 11.5 }}>{project.workspace}</div>
            </div>
          </div>
        ) : (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="mono grow truncate">{open.path}</span>
              <span className="faint" style={{ fontSize: 12 }}>{bytes(open.size)}</span>
            </div>
            {open.note ? <div className="hint">{open.note}</div> : isMd ? <Markdown text={open.content} /> : <pre className="code" style={{ maxHeight: 'none' }}>{open.content}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

function Notes({ project }: { project: Project }) {
  const [goal, setGoal] = useState(project.goal);
  const [notes, setNotes] = useState(project.notes);
  useEffect(() => {
    setGoal(project.goal);
    setNotes(project.notes);
  }, [project.id, project.goal, project.notes]);
  const dirty = goal !== project.goal || notes !== project.notes;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      <div className="field">
        <label htmlFor="pg">Goal</label>
        <textarea id="pg" className="textarea" value={goal} onChange={(e) => setGoal(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pn">Manager’s notes</label>
        <textarea id="pn" className="textarea" style={{ minHeight: 220 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Your manager keeps its running brief for the project here. You can edit it." />
        <span className="hint">The manager reads these when it picks the project back up, and rewrites them as things change.</span>
      </div>
      <div className="row">
        <button className="btn primary" disabled={!dirty} onClick={() => void attempt(() => api.updateProject(project.id, { goal, notes }), 'Saved')}>
          Save
        </button>
        <span className="hint mono truncate">{project.workspace}</span>
      </div>
    </div>
  );
}

export function ProjectDetail({ id }: { id: string }) {
  const project = useStore((s) => s.app?.projects.find((p) => p.id === id));
  const allTasks = useStore((s) => s.app?.tasks);
  const tasks = useMemo(() => (allTasks ?? []).filter((t) => t.projectId === id), [allTasks, id]);
  const [tab, setTab] = useState<'tasks' | 'files' | 'notes'>('tasks');

  if (!project) {
    return (
      <div className="page">
        <div className="page-inner">
          <Empty title="That project no longer exists">
            <a href="#/projects">Back to projects</a>
          </Empty>
        </div>
      </div>
    );
  }
  const c = counts(tasks);
  const cost = tasks.filter((t) => !t.costIncluded).reduce((n, t) => n + t.costUsd, 0);
  const tokens = tasks.reduce((n, t) => n + t.tokensIn + t.tokensOut, 0);
  const setStatus = (status: ProjectStatus) => void attempt(() => api.updateProject(project.id, { status }));
  const remove = () => {
    if (!window.confirm(`Delete “${project.name}” and its task history? Files in the workspace folder are left on disk.`)) return;
    void attempt(() => api.deleteProject(project.id)).then(() => (window.location.hash = '/projects'));
  };

  return (
    <div className="page">
      <div className="page-inner" style={{ ['--hue' as string]: project.hue, maxWidth: 1240 }}>
        <a href="#/projects" className="row faint" style={{ fontSize: 12.5, marginBottom: 14, width: 'fit-content', color: 'var(--text-3)' }}>
          <ArrowLeft size={13} /> Projects
        </a>
        <div className="page-head" style={{ alignItems: 'flex-start', marginBottom: 18 }}>
          <div className="grow">
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="proj-dot" />
              <span className="chip">{project.id}</span>
            </div>
            <h1 className="page-title">{project.name}</h1>
            {project.goal && <p className="page-sub">{project.goal}</p>}
          </div>
          <select className="select" style={{ width: 130 }} value={project.status} aria-label="Project status" onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="done">Done</option>
            <option value="archived">Archived</option>
          </select>
          <button className="icon-btn" aria-label="Delete project" title="Delete project" onClick={remove}>
            <Trash2 size={16} />
          </button>
        </div>

        <div className="card" style={{ padding: '14px 16px', marginBottom: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ProgressBar c={c} />
          <div className="counts">
            <span>
              <b>{c.done}</b> of <b>{c.total}</b> tasks done
            </span>
            {c.running > 0 && <span style={{ color: 'var(--accent)' }}>{c.running} working</span>}
            {c.waiting > 0 && <span style={{ color: 'var(--attn)' }}>{c.waiting} waiting on an answer</span>}
            {c.queued > 0 && <span>{c.queued} queued</span>}
            {c.failed > 0 && <span style={{ color: 'var(--bad)' }}>{c.failed} need a look</span>}
            <span className="grow" />
            <span className="tnum">{compact(tokens)} tokens</span>
            {cost > 0 && <span className="tnum">≈ {money(cost)}</span>}
            {project.status === 'paused' && <span style={{ color: 'var(--attn)' }}>Paused — queued tasks will not start</span>}
          </div>
        </div>

        <div className="tabs" role="tablist">
          {(['tasks', 'files', 'notes'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t === 'tasks' ? 'Tasks' : t === 'files' ? 'Files' : 'Goal & notes'}
            </button>
          ))}
        </div>
        {tab === 'tasks' && <Board tasks={tasks} />}
        {tab === 'files' && <Files project={project} />}
        {tab === 'notes' && <Notes project={project} />}
      </div>
    </div>
  );
}

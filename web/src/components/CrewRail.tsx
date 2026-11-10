import { ShieldQuestion, X } from 'lucide-react';
import type { Approval, Task } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ago, compact, duration, isLive, isTrouble, money, taskElapsed, useNow } from '../lib.ts';
import { useStore } from '../store.ts';
import { attempt, Empty, TaskAvatar } from './ui.tsx';

function ApprovalCard({ approval }: { approval: Approval }) {
  const task = useStore((s) => s.app?.tasks.find((t) => t.id === approval.agentId));
  return (
    <div className="approval">
      <div className="row">
        <ShieldQuestion size={15} style={{ color: 'var(--attn)' }} />
        <span className="what grow">{task ? `${task.crewName} wants to run a command` : 'An agent wants to run a command'}</span>
      </div>
      {task && <div className="hint truncate">{task.title}</div>}
      <pre className="code" style={{ maxHeight: 130 }}>
        {approval.detail}
      </pre>
      <div className="row">
        <button className="btn primary sm" onClick={() => void attempt(() => api.approve(approval.id, true))}>
          Allow
        </button>
        <button className="btn sm" onClick={() => void attempt(() => api.approve(approval.id, false))}>
          Decline
        </button>
      </div>
    </div>
  );
}

export function AgentCard({ task, now, showProject = true }: { task: Task; now: number; showProject?: boolean }) {
  const open = useStore((s) => s.setOpenAgent);
  const project = useStore((s) => s.app?.projects.find((p) => p.id === task.projectId));
  const typing = useStore((s) => {
    const blocks = s.streaming[task.id];
    if (!blocks) return '';
    const text = Object.values(blocks).find((b) => b.type === 'text')?.text ?? '';
    return text.slice(-140);
  });
  const line = task.status === 'failed' ? task.error : typing || task.statusLine;
  return (
    <button className={`agent-card ${task.status}`} onClick={() => open(task.id)}>
      <TaskAvatar task={task} />
      <span className="grow">
        <span className="title">{task.title}</span>
        <span className="meta">
          <span>{task.crewName}</span>
          {showProject && project && (
            <>
              <span>·</span>
              <span className="truncate" style={{ maxWidth: 130 }}>
                {project.name}
              </span>
            </>
          )}
          {task.startedAt && (
            <>
              <span>·</span>
              <span className="tnum">{duration(taskElapsed(task, now))}</span>
            </>
          )}
        </span>
        {line && <span className="status-line">{line}</span>}
      </span>
    </button>
  );
}

function CompactCard({ task, now }: { task: Task; now: number }) {
  const open = useStore((s) => s.setOpenAgent);
  return (
    <button className="agent-card compact" onClick={() => open(task.id)}>
      <TaskAvatar task={task} small />
      <span className="grow truncate title">{task.title}</span>
      <span className="faint tnum" style={{ fontSize: 11.5, flex: 'none', color: isTrouble(task) ? 'var(--bad)' : undefined }}>
        {isTrouble(task) ? task.status : task.finishedAt ? ago(task.finishedAt, now) : ''}
      </span>
    </button>
  );
}

export function CrewRail() {
  const app = useStore((s) => s.app)!;
  const railOpen = useStore((s) => s.railOpen);
  const setRailOpen = useStore((s) => s.setRailOpen);
  const live = app.tasks.filter(isLive);
  const now = useNow(live.length > 0);

  const queued = app.tasks.filter((t) => t.status === 'queued');
  const recent = app.tasks
    .filter((t) => t.finishedAt && !isLive(t) && t.status !== 'queued')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, 8);

  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const today = app.tasks.filter((t) => (t.finishedAt ?? 0) >= startOfDay && t.status === 'done').length;
  const metered = app.tasks.filter((t) => !t.costIncluded).reduce((n, t) => n + t.costUsd, 0) + app.pm.costUsd;
  const tokens = app.tasks.reduce((n, t) => n + t.tokensIn + t.tokensOut, 0) + app.pm.tokensIn + app.pm.tokensOut;

  // Waiting agents first: they are the ones that may need something from the user.
  const ordered = [...live].sort(
    (a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );

  return (
    <aside className={`rail${railOpen ? ' open' : ''}`}>
      <div className="rail-head">
        <h2>Crew</h2>
        <span className="faint" style={{ fontSize: 12.5 }}>
          {live.length ? `${live.length} at work` : 'idle'}
        </span>
        <span className="grow" />
        <button className="icon-btn only-narrow" aria-label="Close crew panel" onClick={() => setRailOpen(false)}>
          <X size={16} />
        </button>
      </div>
      <div className="rail-body">
        <div className="stat-strip">
          <div className={`stat${live.length ? ' hot' : ''}`}>
            <b>{live.length}</b>
            <span>working</span>
          </div>
          <div className="stat">
            <b>{queued.length}</b>
            <span>queued</span>
          </div>
          <div className="stat">
            <b>{today}</b>
            <span>done today</span>
          </div>
        </div>

        {app.approvals.length > 0 && (
          <section className="rail-section">
            <header>
              <span>Needs you</span>
              <span>{app.approvals.length}</span>
            </header>
            <div className="rail-list">
              {app.approvals.map((a) => (
                <ApprovalCard key={a.id} approval={a} />
              ))}
            </div>
          </section>
        )}

        <section className="rail-section">
          <header>
            <span>At work now</span>
          </header>
          <div className="rail-list">
            {ordered.length ? (
              ordered.map((t) => <AgentCard key={t.id} task={t} now={now} />)
            ) : (
              <Empty title="Nobody is working">Give your manager something to do and the crew shows up here, live.</Empty>
            )}
          </div>
        </section>

        {queued.length > 0 && (
          <section className="rail-section">
            <header>
              <span>Up next</span>
              <span>{queued.length}</span>
            </header>
            <div>
              {queued.slice(0, 6).map((t) => (
                <CompactCard key={t.id} task={t} now={now} />
              ))}
            </div>
          </section>
        )}

        {recent.length > 0 && (
          <section className="rail-section">
            <header>
              <span>Recently finished</span>
            </header>
            <div>
              {recent.map((t) => (
                <CompactCard key={t.id} task={t} now={now} />
              ))}
            </div>
          </section>
        )}

        <div className="hint" style={{ padding: '0 4px', marginTop: 'auto' }}>
          {compact(tokens)} tokens used all-time
          {metered > 0 ? ` · about ${money(metered)} on metered keys` : ''}
        </div>
      </div>
    </aside>
  );
}

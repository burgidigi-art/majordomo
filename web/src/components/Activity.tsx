import { useMemo, useState } from 'react';
import type { Task } from '../../../shared/types.ts';
import { clock, compact, duration, isLive, isOpen, isTrouble, money, taskElapsed, useNow } from '../lib.ts';
import { useStore } from '../store.ts';
import { Avatar, Empty, StatusPill, TaskAvatar } from './ui.tsx';

function Timeline({ tasks, now }: { tasks: Task[]; now: number }) {
  const open = useStore((s) => s.setOpenAgent);
  const rows = useMemo(
    () =>
      tasks
        .filter((t) => t.startedAt)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
        .slice(0, 14)
        .reverse(),
    [tasks],
  );
  if (!rows.length) return null;
  const start = Math.min(...rows.map((t) => t.startedAt!));
  const anyLive = rows.some(isLive);
  const end = Math.max(anyLive ? now : 0, ...rows.map((t) => t.finishedAt ?? t.startedAt!), start + 10_000);
  const span = end - start;
  const pct = (ts: number) => `${(((ts - start) / span) * 100).toFixed(2)}%`;

  return (
    <div className="card timeline">
      <div className="tl-axis">
        <span>{clock(start)}</span>
        <span>{duration(span)} shown</span>
        <span>{anyLive ? 'now' : clock(end)}</span>
      </div>
      {rows.map((t) => {
        const to = t.finishedAt ?? now;
        return (
          <button key={t.id} className="tl-row" onClick={() => open(t.id)} title={`${t.id} · ${t.title}`}>
            <span className="tl-name truncate">
              <span className="mono faint">{t.id}</span> {t.title}
            </span>
            <span className="tl-track">
              <span
                className={`tl-bar ${t.status}`}
                style={{ left: pct(t.startedAt!), width: `max(4px, ${(((to - t.startedAt!) / span) * 100).toFixed(2)}%)` }}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

type Filter = 'all' | 'open' | 'done' | 'trouble';

export function Activity() {
  const app = useStore((s) => s.app)!;
  const open = useStore((s) => s.setOpenAgent);
  const [filter, setFilter] = useState<Filter>('all');
  const now = useNow(app.tasks.some(isLive));

  const list = useMemo(() => {
    const f = app.tasks.filter((t) =>
      filter === 'all' ? true : filter === 'open' ? isOpen(t) : filter === 'done' ? t.status === 'done' : isTrouble(t) || t.status === 'cancelled',
    );
    return f.sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  }, [app.tasks, filter]);

  // Usage per account, so it is clear which subscription or key the work is landing on.
  const usage = useMemo(() => {
    const map = new Map<string, { tasks: number; tokens: number; cost: number; included: boolean }>();
    for (const t of app.tasks) {
      const u = map.get(t.runtime) ?? { tasks: 0, tokens: 0, cost: 0, included: t.costIncluded };
      u.tasks++;
      u.tokens += t.tokensIn + t.tokensOut;
      u.cost += t.costIncluded ? 0 : t.costUsd;
      map.set(t.runtime, u);
    }
    return [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  }, [app.tasks]);

  const projectName = (id: string) => app.projects.find((p) => p.id === id)?.name ?? '';

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 1240 }}>
        <div className="page-head">
          <div className="grow">
            <h1 className="page-title">Activity</h1>
            <p className="page-sub">Every agent your manager has put to work, across all projects. Click any row to read its full transcript.</p>
          </div>
        </div>

        {app.tasks.length === 0 ? (
          <Empty title="Nothing has run yet">Agents appear here as soon as your manager assigns work.</Empty>
        ) : (
          <>
            <div className="acct-grid" style={{ marginBottom: 22, gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
              <div className="card" style={{ padding: '12px 14px' }}>
                <div className="row">
                  <Avatar name="M" family="demo" small />
                  <span style={{ fontWeight: 550 }}>Project manager</span>
                </div>
                <div className="counts" style={{ marginTop: 8 }}>
                  <span className="tnum">
                    <b>{compact(app.pm.tokensIn + app.pm.tokensOut)}</b> tokens
                  </span>
                  <span className="tnum">{app.pm.costUsd > 0 ? `≈ ${money(app.pm.costUsd)}` : ''}</span>
                </div>
              </div>
              {usage.map(([rt, u]) => {
                const info = app.runtimes.find((r) => r.id === rt);
                return (
                  <div key={rt} className="card" style={{ padding: '12px 14px' }}>
                    <div className="row">
                      <Avatar name={info?.label ?? rt} family={info?.family ?? 'demo'} small />
                      <span className="truncate" style={{ fontWeight: 550 }}>
                        {info?.label ?? rt}
                      </span>
                    </div>
                    <div className="counts" style={{ marginTop: 8 }}>
                      <span>
                        <b>{u.tasks}</b> task{u.tasks === 1 ? '' : 's'}
                      </span>
                      <span className="tnum">
                        <b>{compact(u.tokens)}</b> tokens
                      </span>
                      <span className="tnum">{u.included ? 'on your plan' : u.cost > 0 ? `≈ ${money(u.cost)}` : ''}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <Timeline tasks={app.tasks} now={now} />

            <div className="row" style={{ marginBottom: 12 }}>
              <div className="seg" role="tablist">
                {(
                  [
                    ['all', 'All'],
                    ['open', 'In flight'],
                    ['done', 'Done'],
                    ['trouble', 'Needs a look'],
                  ] as [Filter, string][]
                ).map(([k, label]) => (
                  <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="faint" style={{ fontSize: 12.5 }}>
                {list.length} agent{list.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Crew</th>
                    <th>Status</th>
                    <th className="num">Time</th>
                    <th className="num">Tokens</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((t) => (
                    <tr key={t.id} onClick={() => open(t.id)}>
                      <td style={{ maxWidth: 420 }}>
                        <div className="truncate" style={{ fontWeight: 500 }}>
                          {t.parentId && <span className="faint">↳ </span>}
                          {t.title}
                        </div>
                        <div className="faint truncate" style={{ fontSize: 12 }}>
                          <span className="mono">{t.id}</span> · {projectName(t.projectId)}
                          {isLive(t) && t.statusLine ? ` · ${t.statusLine}` : ''}
                        </div>
                      </td>
                      <td>
                        <div className="row" style={{ whiteSpace: 'nowrap' }}>
                          <TaskAvatar task={t} small />
                          <span>{t.crewName}</span>
                          <span className="faint mono" style={{ fontSize: 11.5 }}>
                            {t.model}
                          </span>
                        </div>
                      </td>
                      <td>
                        <StatusPill status={t.status} />
                      </td>
                      <td className="num">{t.startedAt ? duration(taskElapsed(t, now)) : '—'}</td>
                      <td className="num">{compact(t.tokensIn + t.tokensOut)}</td>
                      <td className="num faint">{t.costIncluded ? 'plan' : t.costUsd > 0 ? money(t.costUsd) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

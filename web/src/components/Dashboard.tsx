import { Activity as ActivityIcon, ArrowUpRight, BellRing, CheckCircle2, MessageSquareText, Settings as SettingsIcon, ShieldCheck, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppState, RuntimeId, RuntimeInfo } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { accountName, compact, isLive, isTrouble, useNow } from '../lib.ts';
import { useStore } from '../store.ts';
import { AgentCard } from './CrewRail.tsx';
import { FlowStage, SparkOrb, type FlowNode } from './Flow.tsx';
import { ProjectCard } from './Projects.tsx';
import { attempt, Avatar, Empty } from './ui.tsx';

const WEEK = 7 * 24 * 60 * 60 * 1000;

interface Gauge {
  id: RuntimeId;
  name: string;
  family: RuntimeInfo['family'];
  percent: number;
  caption: string;
  /** Up to two short lines of supporting detail. */
  notes: string[];
}

/**
 * One gauge per account in use. A subscription that reports its own allowance shows that figure;
 * anything else shows its share of the week's tokens, and says so.
 */
function useGauges(app: AppState): Gauge[] {
  return useMemo(() => {
    const ids = [...new Set<RuntimeId>([app.settings.pm.runtime, ...app.settings.crew.map((c) => c.runtime)])].slice(0, 3);
    const since = Date.now() - WEEK;
    const used = new Map<string, number>();
    for (const t of app.tasks) {
      if ((t.startedAt ?? 0) >= since) used.set(t.runtime, (used.get(t.runtime) ?? 0) + t.tokensIn + t.tokensOut);
    }
    const total = [...used.values()].reduce((a, b) => a + b, 0);
    return ids.map((id) => {
      const info = app.runtimes.find((r) => r.id === id);
      const name = accountName(id);
      const base = { id, name, family: info?.family ?? ('demo' as const) };
      const limits = app.limits[id];
      if (limits?.weekly) {
        const session = limits.session ? `${Math.round(limits.session.used * 100)}% of 5-hour window` : '';
        const resets = limits.weekly.resetsAt ? `Resets ${new Date(limits.weekly.resetsAt).toLocaleDateString([], { weekday: 'long' })}` : '';
        return { ...base, percent: Math.round(limits.weekly.used * 100), caption: `${name}, weekly used`, notes: [session, resets].filter(Boolean) };
      }
      const mine = used.get(id) ?? 0;
      return {
        ...base,
        percent: total ? Math.round((mine / total) * 100) : 0,
        caption: `${name}, share this week`,
        notes: [mine ? `${compact(mine)} tokens in 7 days` : 'No work yet'],
      };
    });
  }, [app.settings, app.tasks, app.runtimes, app.limits]);
}

function Usage({ app }: { app: AppState }) {
  const gauges = useGauges(app);
  const [view, setView] = useState<'orb' | 'bar'>('orb');
  return (
    <section className="panel orbs" data-n={gauges.length} aria-label="Account usage">
      <div className="orbs-tools">
        <div className="mini-seg">
          <button className={view === 'orb' ? 'on' : ''} onClick={() => setView('orb')}>
            Orb
          </button>
          <button className={view === 'bar' ? 'on' : ''} onClick={() => setView('bar')}>
            Bar
          </button>
        </div>
        <a className="top-btn" href="#/activity" style={{ fontSize: 11.5, padding: '4px 8px' }}>
          Details
        </a>
      </div>
      {view === 'orb' ? (
        gauges.map((g) => (
          <div key={g.id} className={`orb-item fam-${g.family}`}>
            <div className="orb" style={{ ['--fill' as string]: `${g.percent}%` }} role="img" aria-label={`${g.caption}: ${g.percent}%`}>
              <div className="orb-liquid" />
              <div className="orb-badge">{g.name[0]}</div>
            </div>
            <div className="orb-read">
              <b>
                {g.percent}
                <small>%</small>
              </b>
              <div className="orb-cap">{g.caption}</div>
              {g.notes.map((n) => (
                <div key={n} className="orb-note">
                  {n}
                </div>
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="usage-bars">
          {gauges.map((g) => (
            <div key={g.id} className={`usage-bar fam-${g.family}`}>
              <Avatar name={g.name} family={g.family} />
              <div>
                <div style={{ fontWeight: 600 }}>{g.caption}</div>
                <div className="track">
                  <i style={{ width: `${Math.max(2, g.percent)}%` }} />
                </div>
                <div className="orb-note">{g.notes.join(' · ')}</div>
              </div>
              <div className="pct">{g.percent}%</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ManagerCard({ app, theme }: { app: AppState; theme: string }) {
  const runtime = app.runtimes.find((r) => r.id === app.settings.pm.runtime);
  const accounts = new Set(app.settings.crew.map((c) => c.runtime)).size;
  return (
    <section className="panel mgr-card" aria-label="Project manager">
      <div className="eyebrow">Manager</div>
      <SparkOrb theme={theme} busy={app.pm.busy} />
      <h3>{accountName(app.settings.pm.runtime)}</h3>
      <div className="facts-col">
        <span className="lead">{app.pm.busy ? 'Working' : 'Standing by'}</span>
        <span>{runtime?.kind === 'cli' ? 'Subscription' : app.settings.pm.runtime === 'demo' ? 'Simulated' : 'API key'}</span>
        <span className="mono truncate">{app.settings.pm.model || 'default model'}</span>
        <span>
          {app.settings.crew.length} crew · {accounts} account{accounts === 1 ? '' : 's'}
        </span>
      </div>
      <div className="crew-chips">
        {app.settings.crew.slice(0, 6).map((c) => (
          <Avatar key={c.id} name={c.name} family={app.runtimes.find((r) => r.id === c.runtime)?.family ?? 'demo'} small />
        ))}
      </div>
      <div className="actions">
        <a className="pill-btn gold" href="#/chat">
          <MessageSquareText size={14} /> Chat
        </a>
        <a className="pill-btn" href="#/settings/crew">
          <SettingsIcon size={14} /> Crew
        </a>
      </div>
    </section>
  );
}

function Flow({ app, theme }: { app: AppState; theme: string }) {
  const live = app.tasks.filter(isLive);
  const ask = app.settings.approvalMode === 'ask';

  const top = useMemo<FlowNode[]>(() => {
    const inUse = new Set<RuntimeId>([app.settings.pm.runtime, ...app.settings.crew.map((c) => c.runtime)]);
    const list = app.runtimes.filter((r) => (r.ready && r.id !== 'demo') || inUse.has(r.id));
    return list.slice(0, 5).map((r) => ({
      id: r.id,
      label: accountName(r.id),
      family: r.family,
      live: live.some((t) => t.runtime === r.id) || (app.pm.busy && app.settings.pm.runtime === r.id),
      href: '#/settings/accounts',
    }));
  }, [app.runtimes, app.settings, app.pm.busy, live.map((t) => t.id + t.runtime).join()]);

  const bottom = useMemo<FlowNode[]>(() => {
    const crew = app.settings.crew;
    const shown = crew.slice(0, crew.length > 5 ? 4 : 5).map<FlowNode>((c) => ({
      id: c.id,
      label: c.name,
      family: app.runtimes.find((r) => r.id === c.runtime)?.family ?? 'demo',
      live: live.some((t) => t.crewId === c.id),
      href: '#/settings/crew',
    }));
    if (crew.length > shown.length) {
      shown.push({ id: 'more', label: 'more', family: 'demo', live: false, href: '#/settings/crew', more: true, glyph: `+${crew.length - shown.length}` });
    }
    return shown;
  }, [app.settings.crew, app.runtimes, live.map((t) => t.id + t.crewId).join()]);

  const save = (patch: Parameters<typeof api.saveSettings>[0]) => void attempt(() => api.saveSettings(patch));
  const n = app.settings.maxParallel;

  return (
    <section className="panel flow" aria-label="Where work is flowing">
      <div className="flow-side">
        <div className="row">
          <div className="eyebrow grow">Work flow</div>
          <a className="pill-btn" style={{ height: 28, padding: '0 11px', fontSize: 11.5 }} href="#/activity">
            <ArrowUpRight size={12} /> Details
          </a>
        </div>
        <div className="flow-controls">
          <div className="flow-row">
            <span>Commands</span>
            <div className="pill-toggle">
              <button className={ask ? '' : 'on'} onClick={() => save({ approvalMode: 'auto' })}>
                <Zap size={12} /> Run freely
              </button>
              <button className={ask ? 'on green' : ''} onClick={() => save({ approvalMode: 'ask' })}>
                <ShieldCheck size={12} /> Ask first
              </button>
            </div>
          </div>
          <div className="flow-row">
            <span>At once</span>
            <div className="stepper">
              <button aria-label="Fewer agents at once" disabled={n <= 1} onClick={() => save({ maxParallel: n - 1 })}>
                −
              </button>
              <b>{n}</b>
              <button aria-label="More agents at once" disabled={n >= 16} onClick={() => save({ maxParallel: n + 1 })}>
                +
              </button>
              <span style={{ marginLeft: 6 }}>agents</span>
            </div>
          </div>
        </div>
        <p className="flow-note">
          Work runs on this computer. Requests go out to {top.length} connected account{top.length === 1 ? '' : 's'}, through {app.settings.crew.length} crew
          member{app.settings.crew.length === 1 ? '' : 's'}.{live.length ? ` ${live.length} stream${live.length === 1 ? ' is' : 's are'} live now.` : ''}
        </p>
      </div>
      <FlowStage top={top} bottom={bottom} hubLabel="Your work" hubCount={app.tasks.length} topTag="Accounts" bottomTag="Crew" theme={theme} />
    </section>
  );
}

type Tab = 'overview' | 'projects' | 'agents';

function Focus({ app }: { app: AppState }) {
  const [tab, setTab] = useState<Tab>('overview');
  const open = useStore((s) => s.setOpenAgent);
  const live = app.tasks.filter(isLive);
  const now = useNow(live.length > 0);
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const doneToday = app.tasks.filter((t) => t.status === 'done' && (t.finishedAt ?? 0) >= startOfDay);
  const doneWeek = app.tasks.filter((t) => t.status === 'done' && (t.finishedAt ?? 0) >= Date.now() - WEEK);
  const waiting = app.tasks.filter((t) => t.status === 'waiting');
  const trouble = app.tasks.filter((t) => isTrouble(t) && !t.parentId);
  const needs = waiting.length + trouble.length;
  const projects = app.projects.filter((p) => p.status === 'active' || p.status === 'paused');
  const recent = [...app.tasks].filter((t) => t.startedAt).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  const title = waiting.length
    ? 'Waiting on you.'
    : live.length
      ? `${live.length} agent${live.length === 1 ? '' : 's'} at work.`
      : trouble.length
        ? 'Something needs a look.'
        : doneToday.length
          ? 'All caught up.'
          : projects.length
            ? 'Quiet for now.'
            : 'Room to start.';
  const firstNeed = waiting[0] ?? trouble[0];

  return (
    <>
      <div className="focus-head">
        <div className="grow">
          <div className="eyebrow plain">Your work, in focus</div>
          <h1 className="focus-title">{title}</h1>
        </div>
        <a className="pill-btn" href="#/chat">
          <MessageSquareText size={14} /> Tell your manager something
        </a>
      </div>
      <div className="focus-bar">
        <div className="tabs-pill" role="tablist">
          {(
            [
              ['overview', 'Overview'],
              ['projects', 'Projects'],
              ['agents', 'Agents'],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="faint" style={{ fontSize: 12 }}>
          {projects.length} project{projects.length === 1 ? '' : 's'} · {app.tasks.length} task{app.tasks.length === 1 ? '' : 's'} all-time
        </span>
      </div>

      {tab === 'overview' && (
        <>
          <div className="kpis">
            <a className="kpi" href="#/activity" style={{ ['--k' as string]: 'var(--accent)' }}>
              <h4>
                <ActivityIcon size={20} /> Working now
              </h4>
              <div className="big" style={{ color: live.length ? 'var(--accent)' : undefined }}>
                {live.length}
              </div>
              <div className="hint truncate">{live[0] ? `${live[0].crewName} · ${live[0].title}` : 'Nobody is working right now'}</div>
            </a>
            <a className="kpi" href="#/activity" style={{ ['--k' as string]: 'var(--ok)' }}>
              <h4>
                <CheckCircle2 size={20} /> Done today
              </h4>
              <div className="big">{doneToday.length}</div>
              <div className="hint">
                {doneWeek.length} this week · {compact(doneWeek.reduce((n, t) => n + t.tokensIn + t.tokensOut, 0))} tokens
              </div>
            </a>
            <button className="kpi" style={{ ['--k' as string]: 'var(--attn)' }} onClick={() => (firstNeed ? open(firstNeed.id) : (window.location.hash = '/chat'))}>
              <h4>
                <BellRing size={20} /> Needs you
              </h4>
              <div className="big" style={{ color: needs ? 'var(--attn)' : undefined }}>
                {needs}
              </div>
              <div className="hint truncate">
                {waiting[0]
                  ? `${waiting[0].crewName} is waiting · ${waiting[0].statusLine || waiting[0].title}`
                  : trouble[0]
                    ? `${trouble[0].title} ${trouble[0].status === 'failed' ? 'failed' : 'was interrupted'}`
                    : 'Nothing is waiting on you'}
              </div>
            </button>
          </div>
          {projects.length > 0 ? (
            <div className="dash-grid">
              {projects.slice(0, 3).map((p) => (
                <ProjectCard key={p.id} project={p} now={now} />
              ))}
            </div>
          ) : (
            <Empty title="No projects yet">
              Tell your manager what you are working on and it will set one up. <a href="#/chat">Open the chat</a>
            </Empty>
          )}
        </>
      )}

      {tab === 'projects' &&
        (projects.length ? (
          <div className="dash-grid">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} now={now} />
            ))}
          </div>
        ) : (
          <Empty title="No projects yet">
            <a href="#/chat">Open the chat</a> and describe something you want done.
          </Empty>
        ))}

      {tab === 'agents' &&
        (recent.length ? (
          <div className="dash-grid">
            {recent.slice(0, 12).map((t) => (
              <AgentCard key={t.id} task={t} now={now} />
            ))}
          </div>
        ) : (
          <Empty title="Nothing has run yet">Agents appear here as soon as your manager assigns work.</Empty>
        ))}
    </>
  );
}

export function Dashboard() {
  const app = useStore((s) => s.app)!;
  const theme = useStore((s) => s.theme);
  return (
    <div className="page">
      <div className="dash">
        <div className="dash-top">
          <Usage app={app} />
          <ManagerCard app={app} theme={theme} />
        </div>
        <Flow app={app} theme={theme} />
        <Focus app={app} />
      </div>
    </div>
  );
}

import { Activity as ActivityIcon, ArrowUpRight, BellRing, CheckCircle2, MessageSquareText, Settings as SettingsIcon, ShieldCheck, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AppState, RuntimeId, RuntimeInfo } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { accountName, compact, isLive, isTrouble, useNow } from '../lib.ts';
import { useStore } from '../store.ts';
import { AgentCard } from './CrewRail.tsx';
import { FlowStage, SparkOrb, type FlowNode } from './Flow.tsx';
import { ProjectCard } from './Projects.tsx';
import { HotInTheStreets } from './Hot.tsx';
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
  return (
    <section className="panel dash-usage" aria-label="Account usage">
      <div className="row">
        <div className="eyebrow grow">Usage</div>
        <a className="pill-btn small" href="#/activity">
          <ArrowUpRight size={12} /> Details
        </a>
      </div>
      <div className="usage-bars">
        {gauges.map((g) => (
          <div key={g.id} className={`usage-bar fam-${g.family}`} title={[g.caption, ...g.notes].join(' · ')}>
            <Avatar name={g.name} family={g.family} small />
            <div style={{ minWidth: 0 }}>
              <div className="usage-cap truncate">{g.caption}</div>
              <div className="track" role="img" aria-label={`${g.caption}: ${g.percent}%`}>
                <i style={{ width: `${Math.max(2, g.percent)}%` }} />
              </div>
              <div className="orb-note truncate">{g.notes.join(' · ')}</div>
            </div>
            <div className="pct">{g.percent}%</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ManagerCard({ app, theme }: { app: AppState; theme: string }) {
  const runtime = app.runtimes.find((r) => r.id === app.settings.pm.runtime);
  const accounts = new Set(app.settings.crew.map((c) => c.runtime)).size;
  return (
    <section className="panel dash-mgr" aria-label="Project manager">
      <SparkOrb theme={theme} busy={app.pm.busy} />
      <div className="dash-mgr-id">
        <div className="eyebrow">Manager</div>
        <h3 className="truncate">{accountName(app.settings.pm.runtime)}</h3>
        <span className={`dash-mgr-state${app.pm.busy ? ' busy' : ''}`}>{app.pm.busy ? 'Working' : 'Standing by'}</span>
      </div>
      <div className="dash-mgr-facts">
        <span>{runtime?.kind === 'cli' ? 'Subscription' : app.settings.pm.runtime === 'demo' ? 'Simulated' : 'API key'}</span>
        <span className="mono truncate">{app.settings.pm.model || 'default model'}</span>
        <span>
          {app.settings.crew.length} crew · {accounts} account{accounts === 1 ? '' : 's'}
        </span>
        <span className="crew-chips">
          {app.settings.crew.slice(0, 6).map((c) => (
            <Avatar key={c.id} name={c.name} family={app.runtimes.find((r) => r.id === c.runtime)?.family ?? 'demo'} small />
          ))}
        </span>
      </div>
      <div className="dash-mgr-actions">
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
    <section className="panel flow dash-flow" aria-label="Where work is flowing">
      <div className="flow-side">
        <div className="row">
          <div className="eyebrow grow">Work flow</div>
          <a className="pill-btn small" href="#/activity">
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
            : '';
  const firstNeed = waiting[0] ?? trouble[0];

  return (
    <>
      <div className="dash-work-head">
        <div className="eyebrow plain">Your work</div>
        {title && <h2 className="dash-work-title truncate">{title}</h2>}
        <span className="grow" />
        <div className="tabs-pill small" role="tablist">
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
        <a className="pill-btn small" href="#/chat" title="Tell your manager something">
          <MessageSquareText size={13} /> Tell your manager
        </a>
      </div>
      <div className="dash-work-body">
      {tab === 'overview' && (
        <>
          <div className="kpis slim">
            <a className="kpi" href="#/activity" style={{ ['--k' as string]: 'var(--accent)' }}>
              <h4>
                <ActivityIcon size={15} /> Working now
              </h4>
              <div className="big" style={{ color: live.length ? 'var(--accent)' : undefined }}>
                {live.length}
              </div>
              <div className="hint truncate">{live[0] ? `${live[0].crewName} · ${live[0].title}` : 'Nobody is working right now'}</div>
            </a>
            <a className="kpi" href="#/activity" style={{ ['--k' as string]: 'var(--ok)' }}>
              <h4>
                <CheckCircle2 size={15} /> Done today
              </h4>
              <div className="big">{doneToday.length}</div>
              <div className="hint">
                {doneWeek.length} this week · {compact(doneWeek.reduce((n, t) => n + t.tokensIn + t.tokensOut, 0))} tokens
              </div>
            </a>
            <button className="kpi" style={{ ['--k' as string]: 'var(--attn)' }} onClick={() => (firstNeed ? open(firstNeed.id) : (window.location.hash = '/chat'))}>
              <h4>
                <BellRing size={15} /> Needs you
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
      </div>
      <div className="dash-work-foot faint">
        {projects.length} project{projects.length === 1 ? '' : 's'} · {app.tasks.length} task{app.tasks.length === 1 ? '' : 's'} all-time
      </div>
    </>
  );
}

export function Dashboard() {
  const app = useStore((s) => s.app)!;
  const theme = useStore((s) => s.theme);
  // A fresh "What's hot" list each time the dashboard is opened (one under a minute old is reused).
  useEffect(() => {
    void api.refreshTrending().catch(() => {});
  }, []);
  return (
    <div className="page dash-page">
      <div className="dash2">
        <Flow app={app} theme={theme} />
        <div className="dash-status">
          <Usage app={app} />
          <ManagerCard app={app} theme={theme} />
        </div>
        <section className="panel dash-work" aria-label="Your work">
          <Focus app={app} />
        </section>
        <HotInTheStreets trending={app.trending} />
      </div>
    </div>
  );
}

import {
  Activity as ActivityIcon,
  Brain,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Mail,
  MessageSquareText,
  PanelRight,
  Settings as SettingsIcon,
  Plug,
  Smartphone,
  Sparkles,
  Square,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { Activity } from './components/Activity.tsx';
import { AgentDrawer } from './components/AgentDrawer.tsx';
import { CrewRail } from './components/CrewRail.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { Desk } from './components/Desk.tsx';
import { Memory } from './components/Memory.tsx';
import { ProjectDetail, Projects } from './components/Projects.tsx';
import { Settings } from './components/Settings.tsx';
import { TeamList } from './components/TeamList.tsx';
import { attempt, toast, Toaster } from './components/ui.tsx';
import { accountName, isLive, useHashRoute } from './lib.ts';
import { onSpeakerError, setOpenAIAvailable } from './speaker.ts';
import { connect, useStore } from './store.ts';

type Section = 'dashboard' | 'chat' | 'projects' | 'activity' | 'memory' | 'settings';

function sectionOf(route: string): Section {
  if (route.startsWith('/chat')) return 'chat';
  if (route.startsWith('/projects')) return 'projects';
  if (route.startsWith('/activity')) return 'activity';
  if (route.startsWith('/memory')) return 'memory';
  if (route.startsWith('/settings')) return 'settings';
  return 'dashboard';
}

function NavLink({ href, icon: Icon, label, active, count, hot }: { href: string; icon: LucideIcon; label: string; active: boolean; count?: string; hot?: boolean }) {
  return (
    <a href={href} className={`nav-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} title={label}>
      <Icon size={16} />
      <span>{label}</span>
      {count ? <span className={`count${hot ? ' hot' : ''}`}>{count}</span> : null}
    </a>
  );
}

/** Shown until the server answers; if it cannot, says why and offers to try again. */
function Opening() {
  const error = useStore((s) => s.loadError);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100dvh', padding: 16 }}>
      <div style={{ maxWidth: 520, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
        {error ? (
          <>
            <b>Chiba could not load.</b>
            <span className="faint mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>
              {error}
            </span>
            <span className="faint" style={{ fontSize: 13 }}>
              Its log is at ~/.majordomo/logs/server.log. If this keeps happening, run npm run install-app again in the Chiba folder.
            </span>
          </>
        ) : (
          <span className="faint">{slow ? 'Still opening the desk… Chiba is taking longer than usual to answer.' : 'Opening the desk…'}</span>
        )}
        {(error || slow) && (
          <button className="btn" onClick={() => void useStore.getState().refresh()}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function App() {
  const app = useStore((s) => s.app);
  const connected = useStore((s) => s.connected);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const railOpen = useStore((s) => s.railOpen);
  const setRailOpen = useStore((s) => s.setRailOpen);
  const [route] = useHashRoute();

  useEffect(() => {
    void useStore.getState().refresh();
    connect();
    onSpeakerError((message) => toast(`Could not use the OpenAI voice, so your computer’s voice read it instead. ${message}`, true));
  }, []);

  const openaiVoice = !!app?.speech?.openai;
  useEffect(() => setOpenAIAvailable(openaiVoice), [openaiVoice]);

  const live = app?.tasks.filter(isLive).length ?? 0;
  useEffect(() => {
    document.title = live ? `(${live}) Chiba` : 'Chiba';
  }, [live]);

  if (!app) {
    return <Opening />;
  }

  const section = sectionOf(route);
  const projectId = /^\/projects\/([^/]+)/.exec(route)?.[1];
  const settingsPart = /^\/settings\/([\w-]+)/.exec(route)?.[1];
  const project = projectId ? app.projects.find((p) => p.id === projectId) : undefined;
  const waiting = app.tasks.filter((t) => t.status === 'waiting').length;
  const projects = app.projects.filter((p) => p.status === 'active' || p.status === 'paused').length;
  const name = app.settings.userName.trim();

  const here =
    section === 'projects' && project
      ? project.name
      : section === 'chat'
        ? `chat · ${accountName(app.settings.pm.runtime)}${app.settings.pm.model ? ` ${app.settings.pm.model}` : ''}`
        : section;
  const managerLine = app.pm.busy ? 'Live · Thinking' : live ? `Live · ${live} at work` : waiting ? 'Waiting on you' : 'Standing by';

  return (
    <div className={`shell${section === 'chat' ? ' with-rail' : ''}`}>
      <nav className="sidebar" aria-label="Main">
        <a href="#/" className="brand">
          <span className="brand-mark">
            <img src="/favicon.svg" alt="" width="34" height="34" />
          </span>
          <span className="brand-text">
            <div className="brand-name">Chiba</div>
            <div className="brand-tag">Your crew, managed</div>
          </span>
        </a>

        <div className="side-label">Workspace</div>
        <div className="nav">
          <NavLink href="#/" icon={LayoutDashboard} label="Dashboard" active={section === 'dashboard'} />
          <NavLink href="#/chat" icon={MessageSquareText} label="Chat" active={section === 'chat'} count={waiting ? `${waiting} waiting` : undefined} hot />
          <NavLink href="#/projects" icon={FolderKanban} label="Projects" active={section === 'projects'} count={projects ? String(projects) : undefined} />
          <NavLink href="#/activity" icon={ActivityIcon} label="Activity" active={section === 'activity'} count={live ? `${live} live` : undefined} hot />
          <NavLink href="#/memory" icon={Brain} label="Memory" active={section === 'memory'} count={app.memory.length ? String(app.memory.length) : undefined} />
        </div>

        <a href="#/chat" className="mgr-widget" aria-label={`Project manager: ${managerLine}. Open chat.`}>
          <span className={`mgr-orb${app.pm.busy ? ' busy' : ''}`} />
          <span className="mgr-status">{managerLine}</span>
          <span className="mgr-sub">Your manager · {accountName(app.settings.pm.runtime)}</span>
          <span className="mgr-actions">
            <span className="icon-btn" title="Open chat">
              <MessageSquareText size={13} />
            </span>
            {app.pm.busy && (
              <button
                className="icon-btn"
                title="Stop the manager"
                aria-label="Stop the manager"
                onClick={(e) => {
                  e.preventDefault();
                  void attempt(() => api.stopPm());
                }}
              >
                <Square size={11} fill="currentColor" />
              </button>
            )}
          </span>
        </a>

        <div className="side-label">Team</div>
        <TeamList />

        <div className="side-label">Tools</div>
        <div className="nav">
          <NavLink href="#/settings/crew" icon={Users} label="Crew" active={section === 'settings' && settingsPart === 'crew'} count={String(app.settings.crew.length)} />
          <NavLink href="#/settings/skills" icon={Sparkles} label="Skills" active={section === 'settings' && settingsPart === 'skills'} />
          <NavLink href="#/settings/plugins" icon={Plug} label="Plugins" active={section === 'settings' && settingsPart === 'plugins'} />
          <NavLink href="#/settings/accounts" icon={KeyRound} label="Accounts" active={section === 'settings' && settingsPart === 'accounts'} />
          <NavLink
            href="#/settings/phone"
            icon={Smartphone}
            label="Phone"
            active={section === 'settings' && settingsPart === 'phone'}
            count={app.telegram.connected && app.telegram.chats.length ? 'on' : undefined}
          />
          <NavLink
            href="#/settings/google"
            icon={Mail}
            label="Email"
            active={section === 'settings' && settingsPart === 'google'}
            count={app.google.connected ? 'on' : undefined}
          />
        </div>

        <div className="side-spacer" />
        <div className="nav">
          <NavLink href="#/settings" icon={SettingsIcon} label="Settings" active={section === 'settings' && !settingsPart} />
        </div>
        <div className="side-foot">
          <span className="profile-avatar">{(name[0] ?? 'Y').toUpperCase()}</span>
          <span className="grow">
            <div className="profile-name truncate">{name || 'You'}</div>
            <div className="profile-tag">Personal · v{app.version}</div>
          </span>
        </div>
      </nav>

      <main className="main">
        <header className="topbar">
          <div className="crumbs">
            <span className="root">Chiba</span>
            <span className="sep">/</span>
            <span className="here truncate">{here}</span>
            <span className={`conn${connected ? '' : ' off'}`} title={connected ? 'Connected' : 'Reconnecting…'} />
          </div>
          <span className="grow" />
          {section !== 'chat' && (
            <a className="top-btn" href="#/chat">
              <MessageSquareText size={15} />
              <span>Chat</span>
            </a>
          )}
          {section === 'chat' ? (
            <button className={`top-btn only-narrow${live ? ' hot' : ''}`} onClick={() => setRailOpen(!railOpen)}>
              <PanelRight size={15} />
              <span>Crew{live ? ` · ${live}` : ''}</span>
            </button>
          ) : (
            <a className={`top-btn${live ? ' hot' : ''}`} href="#/activity">
              <ActivityIcon size={15} />
              <span>{live ? `${live} live` : 'Activity'}</span>
            </a>
          )}
          <button className={`theme-switch ${theme}`} onClick={toggleTheme} role="switch" aria-checked={theme === 'dark'} aria-label="Dark theme" title="Switch theme" />
        </header>

        {section === 'dashboard' && <Dashboard />}
        {section === 'chat' && <Desk />}
        {section === 'projects' && (projectId ? <ProjectDetail id={projectId} /> : <Projects />)}
        {section === 'activity' && <Activity />}
        {section === 'memory' && <Memory />}
        {section === 'settings' && <Settings section={settingsPart} />}
      </main>

      {section === 'chat' && <CrewRail />}
      <AgentDrawer />
      <Toaster />
    </div>
  );
}

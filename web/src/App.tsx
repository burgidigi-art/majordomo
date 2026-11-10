import { Activity as ActivityIcon, BellRing, FolderKanban, MessageSquareText, Moon, Settings as SettingsIcon, Sun } from 'lucide-react';
import { useEffect } from 'react';
import { Activity } from './components/Activity.tsx';
import { AgentDrawer } from './components/AgentDrawer.tsx';
import { CrewRail } from './components/CrewRail.tsx';
import { Desk } from './components/Desk.tsx';
import { ProjectDetail, Projects } from './components/Projects.tsx';
import { Settings } from './components/Settings.tsx';
import { Toaster } from './components/ui.tsx';
import { isLive, useHashRoute } from './lib.ts';
import { connect, useStore } from './store.ts';

export function App() {
  const app = useStore((s) => s.app);
  const connected = useStore((s) => s.connected);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const [route] = useHashRoute();

  useEffect(() => {
    void useStore.getState().refresh();
    connect();
  }, []);

  const live = app?.tasks.filter(isLive).length ?? 0;
  useEffect(() => {
    document.title = live ? `(${live}) Majordomo` : 'Majordomo';
  }, [live]);

  if (!app) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100dvh' }} className="faint">
        Opening the desk…
      </div>
    );
  }

  const projectId = /^\/projects\/([^/]+)/.exec(route)?.[1];
  const section = route === '/' ? 'desk' : route.startsWith('/projects') ? 'projects' : route.startsWith('/activity') ? 'activity' : route.startsWith('/settings') ? 'settings' : 'desk';
  const needsYou = app.tasks.filter((t) => t.status === 'waiting').length;
  const projects = app.projects.filter((p) => p.status === 'active' || p.status === 'paused');

  return (
    <div className={`shell${section === 'desk' ? ' with-rail' : ''}`}>
      <nav className="sidebar" aria-label="Main">
        <a href="#/" className="brand" style={{ color: 'inherit', textDecoration: 'none' }}>
          <span className="brand-mark">
            <BellRing size={16} />
          </span>
          <span className="brand-name">Majordomo</span>
        </a>
        <div className="nav">
          <a href="#/" className={`nav-item${section === 'desk' ? ' active' : ''}`} style={{ textDecoration: 'none' }}>
            <MessageSquareText size={16} />
            <span>Desk</span>
            {needsYou > 0 && <span className="count hot">{needsYou} waiting</span>}
          </a>
          <a href="#/projects" className={`nav-item${section === 'projects' ? ' active' : ''}`} style={{ textDecoration: 'none' }}>
            <FolderKanban size={16} />
            <span>Projects</span>
            <span className="count">{projects.length || ''}</span>
          </a>
          <a href="#/activity" className={`nav-item${section === 'activity' ? ' active' : ''}`} style={{ textDecoration: 'none' }}>
            <ActivityIcon size={16} />
            <span>Activity</span>
            {live > 0 && <span className="count hot">{live} live</span>}
          </a>
          <a href="#/settings" className={`nav-item${section === 'settings' ? ' active' : ''}`} style={{ textDecoration: 'none' }}>
            <SettingsIcon size={16} />
            <span>Settings</span>
          </a>
        </div>

        <div className="side-label">Projects</div>
        <div className="side-projects">
          {projects.length === 0 && <div className="hint" style={{ padding: '2px 10px' }}>None yet</div>}
          {projects.map((p) => {
            const working = app.tasks.filter((t) => t.projectId === p.id && isLive(t)).length;
            return (
              <a
                key={p.id}
                href={`#/projects/${p.id}`}
                className={`side-project${projectId === p.id ? ' active' : ''}`}
                style={{ ['--hue' as string]: p.hue, textDecoration: 'none' }}
              >
                <span className="proj-dot" />
                <span className="grow truncate">{p.name}</span>
                {working > 0 && (
                  <span className="pill running" style={{ height: 18, padding: '0 6px' }}>
                    <span className="dot" />
                    {working}
                  </span>
                )}
              </a>
            );
          })}
        </div>

        <div className="side-foot">
          <span className={`conn${connected ? '' : ' off'}`} title={connected ? 'Connected' : 'Reconnecting…'} />
          <span className="grow">{connected ? `v${app.version}` : 'Reconnecting…'}</span>
          <button className="icon-btn" onClick={toggleTheme} aria-label="Switch theme" title="Switch theme">
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </nav>

      <main className="main">
        {section === 'desk' && <Desk />}
        {section === 'projects' && (projectId ? <ProjectDetail id={projectId} /> : <Projects />)}
        {section === 'activity' && <Activity />}
        {section === 'settings' && <Settings />}
      </main>

      {section === 'desk' && <CrewRail />}
      <AgentDrawer />
      <Toaster />
    </div>
  );
}

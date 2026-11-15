import { familyOf, isLive, useNow } from '../lib.ts';
import { useStore } from '../store.ts';
import { TEAM_STATE_LABEL as STATE_LABEL, teamOf } from '../team.ts';
import { Avatar } from './ui.tsx';

/** The crew in the sidebar, on every page: who is doing what right now. A click opens that agent live. */
export function TeamList() {
  const app = useStore((s) => s.app)!;
  const open = useStore((s) => s.setOpenAgent);
  const anyLive = app.tasks.some(isLive);
  const now = useNow(anyLive);
  const team = teamOf(app.settings.crew, app.tasks, now);
  if (!team.length) return null;

  return (
    <div className="team" role="list" aria-label="Your team">
      {team.map((m) => {
        const label = `${m.name}: ${STATE_LABEL[m.state]}. ${m.line}`;
        const body = (
          <>
            <span className="team-avatar">
              <Avatar name={m.name} family={familyOf(app.runtimes, m.runtime)} small live={m.state === 'working'} />
              <span className={`team-dot is-${m.state}`} />
            </span>
            <span className="team-text">
              <span className="team-name">
                <span className="truncate">{m.name}</span>
                {m.live > 1 && <span className="team-count">{m.live}</span>}
                {m.time && <span className="team-time">{m.time}</span>}
              </span>
              <span className={`team-line is-${m.state}`}>{m.state === 'idle' || m.state === 'working' ? m.line : `${STATE_LABEL[m.state]} · ${m.line}`}</span>
            </span>
          </>
        );
        return m.target ? (
          <button key={m.id} role="listitem" className={`team-row is-${m.state}`} title={label} aria-label={label} onClick={() => open(m.target!.id)}>
            {body}
          </button>
        ) : (
          <a key={m.id} role="listitem" className={`team-row is-${m.state}`} title={`${label}. Open crew settings.`} aria-label={label} href="#/settings/crew">
            {body}
          </a>
        );
      })}
    </div>
  );
}

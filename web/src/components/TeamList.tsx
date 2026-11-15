import { useState } from 'react';
import { familyOf, isLive, useNow } from '../lib.ts';
import { useStore } from '../store.ts';
import { TEAM_STATE_LABEL as STATE_LABEL, teamOf, type Member } from '../team.ts';
import { Avatar } from './ui.tsx';

/** Failed tasks the user has already opened stop flashing. Kept per browser; losing it only re-flashes. */
const SEEN_KEY = 'majordomo:seen-failures';

function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    /* private window or storage blocked: the flash simply returns next time */
  }
}

/** Flashing means "this needs you": a command waiting for approval, or a failure not yet looked at. */
export function needsYou(m: Member, seen: Set<string>): boolean {
  if (m.state === 'approval') return true;
  return m.state === 'trouble' && !!m.target && !seen.has(m.target.id);
}

/** The crew in the sidebar, on every page: who is doing what right now. A click opens that agent live. */
export function TeamList() {
  const app = useStore((s) => s.app)!;
  const open = useStore((s) => s.setOpenAgent);
  const [seen, setSeen] = useState(readSeen);
  const anyLive = app.tasks.some(isLive);
  const now = useNow(anyLive);
  const team = teamOf(app.settings.crew, app.tasks, now, app.approvals);
  if (!team.length) return null;

  const openMember = (m: Member) => {
    if (!m.target) return;
    if (m.state === 'trouble' && !seen.has(m.target.id)) {
      const next = new Set(seen).add(m.target.id);
      saveSeen(next);
      setSeen(next);
    }
    open(m.target.id);
  };

  return (
    <div className="team" role="list" aria-label="Your team">
      {team.map((m) => {
        const alert = needsYou(m, seen);
        const label = `${m.name}: ${STATE_LABEL[m.state]}. ${m.line}`;
        const cls = `team-row is-${m.state}${alert ? ' alert' : ''}`;
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
          <button key={m.id} role="listitem" className={cls} title={label} aria-label={label} onClick={() => openMember(m)}>
            {body}
          </button>
        ) : (
          <a key={m.id} role="listitem" className={cls} title={`${label}. Open crew settings.`} aria-label={label} href="#/settings/crew">
            {body}
          </a>
        );
      })}
    </div>
  );
}

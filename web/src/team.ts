import type { Task } from '../../shared/types.ts';
import { ago, duration, isLive, isTrouble, taskElapsed } from './format.ts';

/** approval: a command waits for the user. asking: the bot asked the manager, which answers it. */
export type TeamState = 'approval' | 'asking' | 'working' | 'trouble' | 'queued' | 'idle';

export interface Member {
  id: string;
  name: string;
  runtime: string;
  state: TeamState;
  /** One line about what it is doing now, or did last. */
  line: string;
  /** The agent to open when the row is clicked; null when it has never had work. */
  target: Task | null;
  /** How many tasks are live, for the badge. */
  live: number;
  /** How long the current task has run, while working. */
  time: string;
}

export const TEAM_STATE_LABEL: Record<TeamState, string> = {
  approval: 'Needs your approval',
  asking: 'Asking manager',
  working: 'Working',
  trouble: 'Last task failed',
  queued: 'Up next',
  idle: 'Idle',
};

/**
 * Where each crew member stands, worked out from the tasks it has been given. A member that was
 * removed from the crew still shows while it has live work, so nothing running drops out of view.
 */
export function teamOf(
  crew: { id: string; name: string; runtime: string }[],
  tasks: Task[],
  now: number,
  approvals: { agentId: string }[] = [],
): Member[] {
  const awaitingUser = new Set(approvals.map((a) => a.agentId));
  const byCrew = new Map<string, Task[]>();
  for (const t of tasks) byCrew.set(t.crewId, [...(byCrew.get(t.crewId) ?? []), t]);

  const people = [...crew];
  for (const [id, list] of byCrew) {
    if (!people.some((c) => c.id === id) && list.some(isLive)) people.push({ id, name: list[0]!.crewName, runtime: list[0]!.runtime });
  }

  return people.map((c) => {
    const mine = byCrew.get(c.id) ?? [];
    const live = mine.filter(isLive).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const approval = live.filter((t) => awaitingUser.has(t.id));
    const asking = live.filter((t) => t.status === 'waiting' && !awaitingUser.has(t.id));
    const queued = mine.filter((t) => t.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    const last = mine.filter((t) => t.finishedAt).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
    const more = live.length > 1 ? ` · +${live.length - 1} more` : '';

    let state: TeamState;
    let line: string;
    let target: Task | null;
    let time = '';
    if (approval.length) {
      state = 'approval';
      target = approval[0]!;
      line = `${target.title}${more}`;
    } else if (asking.length) {
      state = 'asking';
      target = asking[0]!;
      line = `${target.title}${more}`;
    } else if (live.length) {
      state = 'working';
      target = live[0]!;
      line = `${target.title}${more}`;
      time = duration(taskElapsed(target, now));
    } else if (last && isTrouble(last) && !queued.length) {
      state = 'trouble';
      target = last;
      line = `${last.title} · ${last.status}`;
    } else if (queued.length) {
      state = 'queued';
      target = queued[0]!;
      line = `${target.title}${queued.length > 1 ? ` · +${queued.length - 1} more` : ''}`;
    } else {
      state = 'idle';
      target = last ?? null;
      line = last ? `Last done ${ago(last.finishedAt!, now)}` : 'No work yet';
    }
    return { id: c.id, name: c.name, runtime: c.runtime, state, line, target, live: live.length, time };
  });
}

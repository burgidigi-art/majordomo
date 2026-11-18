// Private work: which models may be handed what.
//
// Everything an agent reads is sent to the company that runs its model. Two things the user may
// not want sent just anywhere: the work in a project they have marked private, and what is in their
// email and calendar. Each crew member is either cleared for private work or not (see
// shared/privacy.ts), and the rules here are enforced by the harness, not left to the manager:
//
//   - A task in a private project only ever runs on a cleared crew member, helpers included.
//   - Only cleared crew members are given the email and calendar tools.
//   - Once an agent has opened the mailbox, its task is private from then on, so its helpers must
//     be cleared too.
//   - In a turn where the manager has opened the mailbox, it cannot create a task for, or send a
//     message to, a crew member who is not cleared.
//
// What this cannot do: read the manager's mind. In a later turn the manager could still retell
// something it read earlier in a brief for an uncleared crew member. It is told not to; nothing
// here can check a paraphrase.
import { createHmac } from 'node:crypto';
import { crewCleared } from '../shared/privacy.ts';
import type { CrewProfile, Project, Task } from '../shared/types.ts';
import { getSettings, runtimeDef } from './settings.ts';
import type { Tool } from './tools/tool.ts';

export function cleared(crew: CrewProfile): boolean {
  return crewCleared(crew, getSettings().pm.runtime, (runtime) => runtimeDef(runtime).family);
}

export const clearedCrew = (): CrewProfile[] => getSettings().crew.filter(cleared);

/** The crew member a task is assigned to, as configured now. Null when they have been removed. */
export const crewOf = (t: Pick<Task, 'crewId'>): CrewProfile | null => getSettings().crew.find((c) => c.id === t.crewId) ?? null;

/** A task whose crew member has been removed is treated as not cleared: there is nobody to vouch for. */
export function taskCleared(t: Pick<Task, 'crewId'>): boolean {
  const crew = crewOf(t);
  return !!crew && cleared(crew);
}

export const isPrivate = (t: Pick<Task, 'private'>, project: Pick<Project, 'private'> | null | undefined): boolean => t.private || !!project?.private;

/** For messages to the manager: who it may use instead. */
export function clearedNames(): string {
  const names = clearedCrew().map((c) => `${c.name} (${c.id})`);
  return names.length ? names.join(', ') : 'nobody yet: the user has to allow a crew member under Settings → Crew';
}

// ---------- the manager and the mailbox ----------

let managerOpenedMailbox = false;
/** True from the moment the manager reads email or calendar until its turn ends. */
export const managerHoldsMail = (): boolean => managerOpenedMailbox;
export function setManagerHoldsMail(on: boolean): void {
  managerOpenedMailbox = on;
}

/** Wraps the email and calendar tools so each use is reported before it runs. */
export function watched(tools: Tool[], onUse: (agentId: string) => void): Tool[] {
  return tools.map((tool) => ({
    ...tool,
    async run(input, ctx) {
      onUse(ctx.agentId);
      return tool.run(input, ctx);
    },
  }));
}

// ---------- worker credentials ----------

/**
 * The token a worker on a CLI account uses to reach its own tools. It is tied to that one task, so
 * holding it does not open the manager's tools or another task's.
 */
export function workerToken(master: string, taskId: string): string {
  return createHmac('sha256', master).update(`worker:${taskId}`).digest('hex');
}

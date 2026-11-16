// Telling the user, wherever they are, when something needs them: a command waiting for their
// approval, or a task that failed. A bot asking the manager a question is not one of these; the
// manager answers it. Approvals also reach the phone through the Telegram gateway's own buttons.
import { execFile } from 'node:child_process';
import type { AlertSettings, Task } from '../shared/types.ts';
import { sync } from './bus.ts';
import { kvGet, kvSet } from './db.ts';
import { telegram } from './gateways/telegram.ts';

type Run = (command: string, args: string[]) => void;

const defaultRun: Run = (command, args) => {
  execFile(command, args, { timeout: 10_000 }, (err) => {
    if (err) console.error(`[alerts] ${command} failed:`, err.message);
  });
};

let run: Run = defaultRun;
let platform: NodeJS.Platform = process.platform;

/** For tests: stand-ins for running a command and for the operating system. */
export function _testHooks(hooks: { run?: Run; platform?: NodeJS.Platform }): void {
  run = hooks.run ?? defaultRun;
  platform = hooks.platform ?? process.platform;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const alerts = {
  status(): AlertSettings {
    return {
      macSupported: platform === 'darwin',
      mac: kvGet<boolean>('alerts:mac', true),
      phoneFailures: kvGet<boolean>('alerts:phoneFailures', true),
    };
  },

  set(next: Partial<Pick<AlertSettings, 'mac' | 'phoneFailures'>>): void {
    if (typeof next.mac === 'boolean') kvSet('alerts:mac', next.mac);
    if (typeof next.phoneFailures === 'boolean') kvSet('alerts:phoneFailures', next.phoneFailures);
    sync({ alerts: alerts.status() });
  },

  /** A macOS notification with a sound, posted by the background service, so no window has to be open. */
  mac(title: string, body: string): void {
    if (platform !== 'darwin' || !alerts.status().mac) return;
    run('osascript', [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
      '-e',
      'end run',
      '--',
      title,
      clip(body, 220),
    ]);
  },

  /** An agent's command is waiting for the user's Allow or Decline. */
  needsApproval(task: Task | null | undefined, summary: string): void {
    const who = task ? task.crewName : 'An agent';
    alerts.mac('Chiba · needs your approval', `${who} wants to run a command${summary ? `: ${summary}` : ''}`);
  },

  /** A task the user gave (not a helper inside one) failed. The manager is told too and may retry it. */
  taskFailed(task: Task): void {
    if (task.parentId) return;
    const error = clip(task.error.split('\n')[0] ?? '', 160);
    alerts.mac(`Chiba · ${task.crewName}'s task failed`, `${task.title}${error ? ` — ${error}` : ''}`);
    if (alerts.status().phoneFailures) {
      telegram.alert(`**${task.crewName}'s task failed:** ${task.title}${error ? `\n\n${error}` : ''}\n\n_Your manager has been told and will retry or report back._`);
    }
  },
};

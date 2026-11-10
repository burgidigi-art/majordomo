// Decides whether the built dashboard (web/dist) is out of date with the source it was built from.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Everything that goes into the dashboard build, relative to the project root. */
const INPUTS = ['web/src', 'web/public', 'web/index.html', 'shared', 'vite.config.ts', 'package.json'];

/** The most recent modification time under a file or folder, or 0 if it does not exist. */
function newest(target) {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    latest = Math.max(latest, newest(path.join(target, entry.name)));
  }
  return latest;
}

/**
 * Returns why the dashboard needs building, or null when the built copy is current.
 * A `git pull` rewrites the files it changes, which makes them newer than the build.
 */
export function buildReason(root) {
  const built = path.join(root, 'web', 'dist', 'index.html');
  if (!existsSync(built)) return 'first run';
  const builtAt = statSync(built).mtimeMs;
  const changed = INPUTS.some((input) => newest(path.join(root, input)) > builtAt);
  return changed ? 'the source has changed since the last build' : null;
}

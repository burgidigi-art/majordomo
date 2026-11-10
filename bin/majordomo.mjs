#!/usr/bin/env node
// Launcher: builds the dashboard when it is missing or out of date, then starts the server with tsx.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReason } from './build-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => path.join(root, 'node_modules', '.bin', name);

if (!existsSync(path.join(root, 'node_modules'))) {
  console.error('Dependencies are missing. Run `npm install` in ' + root + ' first.');
  process.exit(1);
}

// The server always runs from source, but the dashboard is served from a built copy. Rebuild it
// whenever the source is newer, so an update never leaves the old pages on screen.
const reason = buildReason(root);
if (reason) {
  console.log(`Building the dashboard (${reason})…`);
  const built = spawnSync(bin('vite'), ['build'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('\nThe dashboard could not be built. If you have just updated Majordomo, run `npm install` and try again.');
    process.exit(built.status ?? 1);
  }
}

const server = spawn(bin('tsx'), [path.join(root, 'server', 'index.ts')], { cwd: root, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
server.on('exit', (code) => process.exit(code ?? 0));

#!/usr/bin/env node
// Launcher: builds the dashboard on first run, then starts the server with tsx.
import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => path.join(root, 'node_modules', '.bin', name);

if (!existsSync(path.join(root, 'node_modules'))) {
  console.error('Dependencies are missing. Run `npm install` in ' + root + ' first.');
  process.exit(1);
}
if (!existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  console.log('Building the dashboard (first run only)…');
  const built = spawnSync(bin('vite'), ['build'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}
const server = spawn(bin('tsx'), [path.join(root, 'server', 'index.ts')], { cwd: root, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
server.on('exit', (code) => process.exit(code ?? 0));

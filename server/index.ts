import { serve } from '@hono/node-server';
import { DATA_DIR } from './db.ts';
import { setRedirectBase } from './google.ts';
import { app } from './http.ts';
import { orch, runner, setBaseUrl } from './orchestrator.ts';
import { telegram } from './gateways/telegram.ts';
import { DEMO, getSettings } from './settings.ts';

const port = Number(process.env.MAJORDOMO_PORT || process.env.PORT || 4317);
const hostname = process.env.MAJORDOMO_HOST || '127.0.0.1';

if (hostname !== '127.0.0.1' && hostname !== 'localhost' && !process.env.MAJORDOMO_TOKEN) {
  console.error(
    'Refusing to listen on a network address without MAJORDOMO_TOKEN set.\n' +
      'Majordomo can run commands on this machine; anyone who can reach it must present the token.',
  );
  process.exit(1);
}

setBaseUrl(`http://127.0.0.1:${port}`);
setRedirectBase(`http://127.0.0.1:${port}`);

// Listen first and boot second. Booting marks unfinished work as interrupted and starts the phone
// gateway, which would disrupt a copy of Majordomo that is already running (the Mac app keeps one
// in the background), so nothing is touched until the port is ours.
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  orch.boot();
  const s = getSettings();
  console.log(`\n  Majordomo is running  →  http://localhost:${port}`);
  console.log(`  Data: ${DATA_DIR}`);
  console.log(`  PM runs on: ${s.pm.runtime}${s.pm.model ? ` (${s.pm.model})` : ''}${DEMO ? '  [demo mode]' : ''}\n`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(
    `\n  Majordomo is already running, or another program is using port ${port}.\n` +
      `  Open http://localhost:${port} to use the copy that is running.\n` +
      '  If you installed the Mac app, it keeps Majordomo running in the background; `npm run uninstall-app` removes it.\n',
  );
  process.exit(1);
});

// Agents run shells and CLIs in their own process groups, so they have to be stopped explicitly.
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('\n  Stopping agents…');
    runner.stopAll();
    telegram.stop();
    setTimeout(() => process.exit(0), 400);
  });
}

// Keep the process alive through a stray rejection in one agent; the runner reports its own failures.
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

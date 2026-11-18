#!/usr/bin/env node
// `npm run install-app` and `npm run uninstall-app`: the Mac app and its background service.
import { spawnSync } from 'node:child_process';
import { setIcon } from './icon.mjs';
import { install, plan, uninstall } from './mac-app.mjs';

const remove = process.argv.includes('--remove');
// `npm run install-app <picture.png>` also sets that picture as the icon.
const picture = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

if (process.platform !== 'darwin') {
  console.error('The app is for macOS. On this system, run 00Dojo with `npm start`.');
  process.exit(1);
}

try {
  if (picture && !remove) {
    const saved = setIcon(picture);
    console.log(`\n  Using your picture as the icon. It is kept in ${saved.folder}, on this computer only.`);
  }
  const p = plan();
  if (remove) {
    await uninstall(p);
  } else {
    console.log('\n  Setting up the 00Dojo app…\n');
    const { app } = await install(p);
    // Show that it works: this opens the dashboard the same way clicking the icon does.
    spawnSync('open', [app]);
  }
} catch (err) {
  console.error(`\n  ${String(err instanceof Error ? err.message : err).replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

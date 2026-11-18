#!/usr/bin/env node
// `npm run set-icon <picture.png>` uses your own picture as the icon; `npm run set-icon -- --default`
// goes back to the built-in one. The picture is copied into the data folder and stays on this computer.
import { clearIcon, setIcon } from './icon.mjs';

const args = process.argv.slice(2);
try {
  if (args.includes('--default')) {
    clearIcon();
    console.log('\n  Back to the built-in icon.');
  } else if (args[0]) {
    const saved = setIcon(args[0]);
    console.log(`\n  Icon saved to ${saved.folder}. It stays on this computer and is not part of the repository.`);
  } else {
    console.error('\n  Give the picture to use, for example: npm run set-icon ~/Downloads/00Dojo-icon.png\n');
    process.exit(1);
  }
  console.log('  The dashboard shows it after a refresh.');
  if (process.platform === 'darwin') console.log('  To put it on the Mac app, run: npm run install-app');
  console.log('');
} catch (err) {
  console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}

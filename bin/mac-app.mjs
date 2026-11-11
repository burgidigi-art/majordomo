// The Mac app: a small launcher in Applications plus a background service that macOS starts at login.
//
// Majordomo.app holds no copy of the program. It asks the service (a launchd agent running this
// checkout with `node bin/majordomo.mjs`) to start if it is not answering, then opens the dashboard
// in a window of its own. Updating is still `git pull`, followed by `npm run install-app`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'app.majordomo.server';
export const APP_NAME = 'Majordomo';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Settings a person may have exported in their shell that the service should keep. Never secrets. */
const KEPT_ENV = ['MAJORDOMO_HOME', 'MAJORDOMO_PORT', 'MAJORDOMO_CLAUDE_BIN', 'MAJORDOMO_CODEX_BIN', 'MAJORDOMO_GEMINI_BIN'];
/** Keys that only exist in the shell; the service cannot see them, so the installer says so. */
const SHELL_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MODEL_API_KEY', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN'];
/** Chromium browsers can show a page in a plain window, without tabs or an address bar. */
const APP_WINDOW_BROWSERS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi'];

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The path to start Node with. `process.execPath` is fully resolved, which for Homebrew is a
 * versioned folder that disappears on the next upgrade, so prefer the entry on PATH that leads to it.
 */
export function stableNodePath(execPath, pathVar) {
  let real;
  try {
    real = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const dir of (pathVar || '').split(':')) {
    if (!dir || dir.includes('node_modules')) continue;
    const candidate = path.join(dir, 'node');
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch {
      /* not in this folder */
    }
  }
  return execPath;
}

/**
 * PATH for the service. launchd starts programs with a bare system PATH, so carry over the one
 * this was installed from: it is where npm, git and the agent CLIs were found.
 */
export function servicePath(pathVar, node, home) {
  const entries = [
    path.dirname(node),
    ...(pathVar || '').split(':').filter((dir) => dir.startsWith('/') && !dir.includes('node_modules')),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set(entries)].join(':');
}

/** Everything the installer decides, worked out from the environment it was run in. */
export function plan({ root = ROOT, env = process.env, home = os.homedir(), execPath = process.execPath, applications } = {}) {
  const port = Number(env.MAJORDOMO_PORT || 4317);
  const node = stableNodePath(execPath, env.PATH);
  const dataDir = env.MAJORDOMO_HOME ? path.resolve(env.MAJORDOMO_HOME) : path.join(home, '.majordomo');
  const serviceEnv = { PATH: servicePath(env.PATH, node, home), LANG: env.LANG || 'en_US.UTF-8' };
  for (const name of KEPT_ENV) if (env[name]) serviceEnv[name] = env[name];
  const appDirs = applications ?? ['/Applications', path.join(home, 'Applications')];
  return {
    root,
    home,
    port,
    node,
    script: path.join(root, 'bin', 'majordomo.mjs'),
    icon: path.join(root, 'assets', 'Majordomo.icns'),
    version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    env: serviceEnv,
    // The address the server prints and the one the dashboard has always been opened at.
    url: `http://localhost:${port}`,
    health: `http://127.0.0.1:${port}/api/health`,
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    log: path.join(dataDir, 'logs', 'server.log'),
    appDirs,
    shellKeys: SHELL_KEYS.filter((name) => env[name]),
  };
}

/** The launchd agent: run at login, and start again if it stops unexpectedly. */
export function agentPlist(p) {
  const envXml = Object.entries(p.env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.node)}</string>
    <string>${xml(p.script)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(p.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(p.log)}</string>
</dict>
</plist>
`;
}

export function infoPlist(p) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>app.majordomo.launcher</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleShortVersionString</key>
  <string>${xml(p.version)}</string>
  <key>CFBundleVersion</key>
  <string>${xml(p.version)}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * What runs when the icon is clicked. It exits as soon as the window is open, so clicking the icon
 * again always opens the dashboard again. It never reads the checkout: only the service does.
 */
export function launcherScript(p) {
  return `#!/bin/bash
# ${APP_NAME}.app, made by \`npm run install-app\`. Change bin/mac-app.mjs, not this file.
URL=${sh(p.url)}
HEALTH=${sh(p.health)}
LABEL=${sh(LABEL)}
PLIST=${sh(p.plist)}
LOG=${sh(p.log)}
WAIT="\${MAJORDOMO_APP_WAIT:-90}"
DOMAIN="gui/$(id -u)"

up() { curl -fsS -m 2 "$HEALTH" 2>/dev/null | grep -q majordomo; }

tell() {
  osascript -e 'on run argv' \\
    -e 'display dialog (item 1 of argv) with title "${APP_NAME}" buttons {"OK"} default button 1 with icon caution' \\
    -e 'end run' -- "$1" >/dev/null 2>&1
}

# The service normally starts at login. If it is not answering, load it (in case it was switched
# off) and start it, then give it time: after an update it rebuilds the dashboard first.
if ! up; then
  launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null
  launchctl kickstart "$DOMAIN/$LABEL" 2>/dev/null
  tries=$((WAIT * 2))
  while [ "$tries" -gt 0 ] && ! up; do
    sleep 0.5
    tries=$((tries - 1))
  done
fi

if ! up; then
  recent="$(tail -n 8 "$LOG" 2>/dev/null)"
  if [ ! -f "$PLIST" ]; then
    why="Its background service is not installed. In Terminal, in the Majordomo folder, run: npm run install-app"
  elif printf '%s' "$recent" | grep -qi 'operation not permitted'; then
    why="macOS is not letting it read its own folder. Open System Settings > Privacy & Security > Files and Folders, find node, and switch on the folder Majordomo is kept in. Then open Majordomo again."
  else
    why="In Terminal, in the Majordomo folder, run: npm run install-app"
  fi
  tell "Majordomo did not start.

$why

The last lines of its log ($LOG):
\${recent:-(the log is empty)}"
  exit 1
fi

for browser in ${APP_WINDOW_BROWSERS.map(sh).join(' ')}; do
  for dir in /Applications "$HOME/Applications"; do
    if [ -d "$dir/$browser.app" ]; then
      open -na "$dir/$browser.app" --args "--app=$URL"
      exit 0
    fi
  done
done
open "$URL"
`;
}

// ---------- installing ----------

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function isHealthy(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.text()).includes('majordomo');
  } catch {
    return false;
  }
}

async function until(check, seconds, step = 500) {
  for (const end = Date.now() + seconds * 1000; ; ) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    await sleep(step);
  }
}

function writable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Folders macOS guards: a background program is asked about, or refused, the first time it reads them. */
export function guardedFolder(root, home) {
  const guarded = ['Documents', 'Desktop', 'Downloads', path.join('Library', 'Mobile Documents'), path.join('Library', 'CloudStorage')];
  return guarded.find((name) => (root + path.sep).startsWith(path.join(home, name) + path.sep)) ?? null;
}

function tail(file, lines) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Stops the service if it is loaded. Safe to call when it is not. */
function stopService(run, uid) {
  run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
}

/**
 * Installs or refreshes the app and its service. `sys` exists so the steps can be tested without a Mac.
 */
export async function install(p, sys = {}) {
  const run = sys.run ?? defaultRun;
  const say = sys.say ?? ((line) => console.log(line));
  const busy = sys.portInUse ?? portInUse;
  const healthy = sys.isHealthy ?? isHealthy;
  const uid = sys.uid ?? process.getuid();
  const waits = { release: 8, load: 6, start: 120, ...sys.waits };

  if (!fs.existsSync(path.join(p.root, 'node_modules'))) {
    throw new Error('Dependencies are missing. Run `npm install` first, then run this again.');
  }

  // A reinstall replaces the running service; anything else on the port is a copy started by hand.
  stopService(run, uid);
  if (!(await until(async () => !(await busy(p.port)), waits.release))) {
    throw new Error(
      `Majordomo is already running here (something is using port ${p.port}).\n` +
        'If it is running in a Terminal window, click that window and press Control + C to stop it.\n' +
        'Then run `npm run install-app` again.',
    );
  }

  // The log is only ever appended to; start a new one once it gets large.
  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  if (fs.existsSync(p.log) && fs.statSync(p.log).size > 5 * 1024 * 1024) fs.renameSync(p.log, `${p.log}.old`);

  // The app goes in the main Applications folder when this account may write there.
  const appDir = p.appDirs.find(writable) ?? p.appDirs[p.appDirs.length - 1];
  fs.mkdirSync(appDir, { recursive: true });
  for (const dir of p.appDirs) fs.rmSync(path.join(dir, `${APP_NAME}.app`), { recursive: true, force: true });
  const app = path.join(appDir, `${APP_NAME}.app`);
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist(p));
  fs.writeFileSync(path.join(contents, 'MacOS', APP_NAME), launcherScript(p), { mode: 0o755 });
  fs.chmodSync(path.join(contents, 'MacOS', APP_NAME), 0o755);
  fs.copyFileSync(p.icon, path.join(contents, 'Resources', `${APP_NAME}.icns`));
  // Finder caches icons by folder date.
  const now = new Date();
  fs.utimesSync(app, now, now);
  say(`  Installed ${app}`);

  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.writeFileSync(p.plist, agentPlist(p));

  // Stopping is not instant, and launchd refuses to load a service that is still on its way out.
  let loaded = { status: 1, output: '' };
  const loadedOk = await until(
    async () => {
      loaded = run('launchctl', ['bootstrap', `gui/${uid}`, p.plist]);
      return loaded.status === 0;
    },
    waits.load,
    1000,
  );
  if (!loadedOk) throw new Error(`macOS would not start the background service.\n${loaded.output}`);
  run('launchctl', ['enable', `gui/${uid}/${LABEL}`]);
  say('  Background service installed. It starts each time you log in.');

  const folder = guardedFolder(p.root, p.home);
  if (folder) {
    say(`\n  Majordomo is kept in your ${folder} folder, which macOS protects.`);
    say(`  If a box appears asking whether “node” may access files in ${folder}, click Allow.`);
  }
  say('\n  Starting Majordomo…');
  if (!(await until(() => healthy(p.health), waits.start))) {
    const recent = tail(p.log, 15);
    const blocked = /operation not permitted/i.test(recent);
    throw new Error(
      'The app is installed, but Majordomo did not start in the background.\n' +
        (blocked
          ? `macOS is not letting it read this folder. Open System Settings → Privacy & Security → Files and Folders,\nfind “node”, and switch on ${folder ?? 'this folder'}. Then run \`npm run install-app\` again.\n`
          : '') +
        `\nThe last lines of its log (${p.log}):\n${recent || '(the log is empty)'}`,
    );
  }

  say(`  Majordomo is running  →  ${p.url}\n`);
  say(`  Open “${APP_NAME}” from your Applications folder, Launchpad or Spotlight.`);
  say('  To keep it in the Dock: open it, right-click its Dock icon, then Options → Keep in Dock.');
  if (p.shellKeys.length) {
    say(`\n  Note: ${p.shellKeys.join(', ')} ${p.shellKeys.length > 1 ? 'are' : 'is'} set in this Terminal, and the background service cannot see`);
    say('  Terminal settings. Paste those keys in the dashboard under Accounts (or Phone) if you have not already.');
  }
  say('\n  After updating Majordomo (`git pull`), run `npm run install-app` again to restart it on the new version.');
  say('  To remove the app and stop the service: `npm run uninstall-app`. Your projects and settings are kept.\n');
  return { app };
}

export async function uninstall(p, sys = {}) {
  const run = sys.run ?? defaultRun;
  const say = sys.say ?? ((line) => console.log(line));
  stopService(run, sys.uid ?? process.getuid());
  fs.rmSync(p.plist, { force: true });
  for (const dir of p.appDirs) fs.rmSync(path.join(dir, `${APP_NAME}.app`), { recursive: true, force: true });
  say('  Removed the Majordomo app and its background service.');
  say('  Your projects, settings and saved keys are untouched. `npm start` still runs Majordomo from Terminal.\n');
}

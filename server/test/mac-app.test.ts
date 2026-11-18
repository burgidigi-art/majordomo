import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The Mac app installer is plain JavaScript, like the launcher; load it by path.
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
type Plan = Record<string, any>;
type Sys = Record<string, any>;
const mac = (await import(path.join(repo, 'bin/mac-app.mjs'))) as {
  LABEL: string;
  plan: (o: Record<string, unknown>) => Plan;
  agentPlist: (p: Plan) => string;
  infoPlist: (p: Plan) => string;
  launcherScript: (p: Plan) => string;
  stableNodePath: (execPath: string, pathVar: string) => string;
  guardedFolder: (root: string, home: string) => string | null;
  cloudOnly: (log: string) => boolean;
  install: (p: Plan, sys: Sys) => Promise<{ app: string }>;
  uninstall: (p: Plan, sys: Sys) => Promise<void>;
};

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `majordomo-${name}-`));

/** A home folder and a plan pointing into it, with the real checkout as the program. */
function sandbox(env: Record<string, string> = {}) {
  const home = tmp('mac home');
  const p = mac.plan({
    root: repo,
    home,
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', ...env },
    execPath: process.execPath,
    applications: [path.join(home, 'Applications')],
  });
  return { home, p };
}

test('the background service is described without secrets and survives odd paths', () => {
  const { home, p } = sandbox({
    MAJORDOMO_PORT: '5123',
    MAJORDOMO_CLAUDE_BIN: '/opt/tools & things/claude',
    MAJORDOMO_TOKEN: 'remote-access-secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    TELEGRAM_BOT_TOKEN: '123:secret',
    PATH: `/opt/homebrew/bin:${repo}/node_modules/.bin:/usr/bin`,
  });
  const plist = mac.agentPlist(p);

  assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${mac.LABEL}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/, 'it starts at login');
  assert.ok(plist.includes(`<string>${path.join(repo, 'bin', 'majordomo.mjs')}</string>`), 'it runs this checkout');
  assert.ok(plist.includes('<string>5123</string>'), 'a chosen port is kept');
  assert.ok(plist.includes('/opt/tools &amp; things/claude'), 'special characters are escaped');
  assert.ok(!plist.includes('secret'), 'no key or token is written into the service file');
  assert.ok(!/<string>[^<]*node_modules\/\.bin/.test(plist.split('EnvironmentVariables')[1]!), 'npm’s temporary PATH entries are left out');
  assert.deepEqual(p.shellKeys, ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN'], 'the installer knows which keys to warn about');

  // The log sits with the data, outside the folders macOS guards.
  assert.equal(p.log, path.join(home, '.majordomo', 'logs', 'server.log'));
  assert.equal(p.url, 'http://localhost:5123');
  assert.match(mac.infoPlist(p), /<key>CFBundleExecutable<\/key>\s*<string>00Dojo<\/string>/);
});

test('node is started through the path that survives an upgrade', () => {
  const dir = tmp('node');
  const versioned = path.join(dir, 'Cellar', 'node', '24.1.0', 'bin');
  const stable = path.join(dir, 'bin');
  fs.mkdirSync(versioned, { recursive: true });
  fs.mkdirSync(stable);
  fs.writeFileSync(path.join(versioned, 'node'), '');
  fs.symlinkSync(path.join(versioned, 'node'), path.join(stable, 'node'));

  const real = fs.realpathSync(path.join(versioned, 'node'));
  assert.equal(mac.stableNodePath(real, `/nowhere:${stable}`), path.join(stable, 'node'));
  assert.equal(mac.stableNodePath(real, '/nowhere'), real, 'with nothing better, the resolved path is used');
});

test('a checkout inside a folder macOS guards is recognised', () => {
  assert.equal(mac.guardedFolder('/Users/a/Documents/GitHub/majordomo', '/Users/a'), 'Documents');
  assert.equal(mac.guardedFolder('/Users/a/code/majordomo', '/Users/a'), null);
  assert.equal(mac.guardedFolder('/Users/a/Documents-old/majordomo', '/Users/a'), null);
});

// ----- the launcher inside the app, run for real against stand-ins for the macOS commands -----

function stubs(dir: string, healthyWhen: string, onKickstart = '') {
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls.log');
  fs.mkdirSync(bin);
  const write = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const record = (name: string) => `printf '%s' ${name} >> "${calls}"; for a in "$@"; do printf ' [%s]' "$a" >> "${calls}"; done; echo >> "${calls}"`;
  write('curl', `if ${healthyWhen}; then echo '{"ok":true,"app":"majordomo"}'; else exit 7; fi`);
  write('launchctl', `${record('launchctl')}\nif [ "$1" = kickstart ]; then touch "${dir}/started"; ${onKickstart} fi`);
  write('open', record('open'));
  write('osascript', record('osascript'));
  return { bin, read: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '') };
}

function runLauncher(p: Plan, home: string, bin: string, wait = '5') {
  const script = path.join(home, 'launcher');
  fs.writeFileSync(script, mac.launcherScript(p), { mode: 0o755 });
  assert.equal(spawnSync('bash', ['-n', script]).status, 0, 'the launcher is valid bash');
  return spawnSync('bash', [script], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, MAJORDOMO_APP_WAIT: wait }, encoding: 'utf8' });
}

test('clicking the app opens the dashboard in its own window when 00Dojo is running', () => {
  const { home, p } = sandbox();
  const s = stubs(home, 'true');
  fs.mkdirSync(path.join(home, 'Applications', 'Google Chrome.app'), { recursive: true });

  assert.equal(runLauncher(p, home, s.bin).status, 0);
  const calls = s.read();
  assert.ok(!calls.includes('launchctl'), 'a running service is left alone');
  assert.ok(calls.includes(`open [-na] [${home}/Applications/Google Chrome.app] [--args] [--app=http://localhost:4317]`), calls);
});

test('without a Chromium browser the dashboard opens in the default browser', () => {
  const { home, p } = sandbox();
  const s = stubs(home, 'true');
  assert.equal(runLauncher(p, home, s.bin).status, 0);
  assert.equal(s.read().trim(), 'open [http://localhost:4317]');
});

test('clicking the app starts the service when it is not answering, then opens the dashboard', () => {
  const { home, p } = sandbox();
  const s = stubs(home, `[ -f "${home}/started" ]`);
  assert.equal(runLauncher(p, home, s.bin).status, 0);
  const calls = s.read();
  const uid = process.getuid!();
  assert.ok(calls.includes(`launchctl [bootstrap] [gui/${uid}] [${p.plist}]`), calls);
  assert.ok(calls.includes(`launchctl [kickstart] [gui/${uid}/${mac.LABEL}]`), calls);
  assert.ok(calls.trim().endsWith('open [http://localhost:4317]'), 'the window opens once it answers');
});

test('if 00Dojo cannot start, the app says why instead of opening a dead page', () => {
  const { home, p } = sandbox();
  const s = stubs(home, 'false');
  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.writeFileSync(p.plist, mac.agentPlist(p));
  fs.writeFileSync(p.log, "Error: EPERM: operation not permitted, open '/Users/a/Documents/majordomo/package.json'\n");

  assert.equal(runLauncher(p, home, s.bin, '1').status, 1);
  const calls = s.read();
  assert.ok(!calls.includes('open ['), 'no window is opened');
  assert.ok(calls.includes('osascript'), 'a message is shown');
  assert.ok(calls.includes('Files and Folders'), 'a blocked folder gets the fix for a blocked folder');
  assert.ok(calls.includes('EPERM: operation not permitted'), 'the log is quoted so it can be passed on');
});

// The crash from a checkout in iCloud-synced Documents, as Node prints it under launchd.
const CLOUD_CRASH = `node:fs:978
  return binding.read(fd, buffer, offset, length, position);
                 ^

Error: Unknown system error -11: Unknown system error -11, read
    at Object.readSync (node:fs:978:18)
    at ModuleLoader.load (node:internal/modules/esm/loader:790:26) {
  errno: -11,
  code: 'Unknown system error -11',
  syscall: 'read'
}

Node.js v26.9.0
`;

test('clicking the app says it is starting rather than bouncing in silence', () => {
  const { home, p } = sandbox();
  const s = stubs(home, `[ -f "${home}/started" ]`);
  assert.equal(runLauncher(p, home, s.bin).status, 0);
  const calls = s.read();
  assert.ok(calls.indexOf('display notification') < calls.indexOf('launchctl [kickstart]'), 'the banner comes first');
  assert.ok(calls.includes('[Starting 00Dojo…]'), calls);
});

test('a service that crashes is reported at once, not after the whole wait', () => {
  const sb = sandbox();
  const home = sb.home;
  const p: Plan = { ...sb.p, root: path.join(home, 'Documents', 'majordomo') };
  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.writeFileSync(p.plist, mac.agentPlist(p));
  // An old, unrelated error from an earlier day is not taken for this start's crash.
  fs.writeFileSync(p.log, 'Error: EADDRINUSE: address already in use\n');
  const crashFile = path.join(home, 'crash.txt');
  fs.writeFileSync(crashFile, CLOUD_CRASH);
  const s = stubs(home, 'false', `cat "${crashFile}" >> "${p.log}";`);

  const started = Date.now();
  assert.equal(runLauncher(p, home, s.bin, '30').status, 1);
  assert.ok(Date.now() - started < 10_000, 'it does not sit out the 30-second wait');
  const calls = s.read();
  assert.ok(!calls.includes('open ['), 'no window is opened');
  assert.ok(calls.includes('[activate]'), 'the message is brought to the front');
  assert.ok(calls.includes('iCloud'), 'an iCloud crash gets the fix for iCloud');
  assert.ok(calls.includes(`The folder is: ${p.root}`), 'the folder is named, so it can be found');
  assert.ok(calls.includes('Unknown system error -11'), 'the error is quoted');
  assert.ok(!calls.includes('at Object.readSync'), 'without the stack trace');
  assert.ok(!calls.includes('EADDRINUSE'), 'and without older errors');
});

test('the iCloud read error is recognised however Node words it', () => {
  assert.ok(mac.cloudOnly(CLOUD_CRASH));
  assert.ok(mac.cloudOnly('Error: EDEADLK: resource deadlock avoided, read'));
  assert.ok(!mac.cloudOnly("Error: EPERM: operation not permitted, open 'x'"));
});

// ----- installing -----

function fakeMac(overrides: Sys = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const sys: Sys = {
    uid: 501,
    run: (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 0, output: '' };
    },
    say: (line: string) => said.push(line),
    portInUse: async () => false,
    isHealthy: async () => true,
    waits: { release: 0, load: 0, start: 0 },
    ...overrides,
  };
  return { sys, calls, said };
}

test('installing creates the app and the login service, and removing takes both away', async () => {
  const { home, p } = sandbox({ OPENROUTER_API_KEY: 'sk-or-secret' });
  const { sys, calls, said } = fakeMac();

  const { app } = await mac.install(p, sys);
  assert.equal(app, path.join(home, 'Applications', '00Dojo.app'));
  const launcher = path.join(app, 'Contents', 'MacOS', '00Dojo');
  assert.ok(fs.statSync(launcher).mode & 0o100, 'the launcher can be run');
  assert.equal(fs.readFileSync(launcher, 'utf8'), mac.launcherScript(p));
  assert.ok(fs.existsSync(path.join(app, 'Contents', 'Info.plist')));
  assert.equal(fs.readFileSync(path.join(app, 'Contents', 'Resources', '00Dojo.icns')).subarray(0, 4).toString(), 'icns');
  assert.equal(fs.readFileSync(p.plist, 'utf8'), mac.agentPlist(p));

  // An earlier copy is stopped before the new one is loaded.
  assert.deepEqual(calls, [`launchctl bootout gui/501/${mac.LABEL}`, `launchctl bootstrap gui/501 ${p.plist}`, `launchctl enable gui/501/${mac.LABEL}`]);
  const out = said.join('\n');
  assert.ok(out.includes('OPENROUTER_API_KEY'), 'keys that only live in the shell are pointed out');
  assert.ok(!out.includes('sk-or-secret'));

  // Installing again replaces what is there rather than failing.
  await mac.install(p, fakeMac().sys);

  await mac.uninstall(p, fakeMac().sys);
  assert.ok(!fs.existsSync(app));
  assert.ok(!fs.existsSync(p.plist));
});

test('installing replaces the apps from before each rename', async () => {
  const { home, p } = sandbox();
  const earlier = ['Majordomo.app', 'Chiba.app'].map((name) => path.join(home, 'Applications', name));
  for (const old of earlier) fs.mkdirSync(path.join(old, 'Contents'), { recursive: true });
  const { app } = await mac.install(p, fakeMac().sys);
  assert.equal(path.basename(app), '00Dojo.app');
  assert.ok(fs.existsSync(app));
  for (const old of earlier) assert.ok(!fs.existsSync(old), `${path.basename(old)} is gone, so there is one icon and not three`);
});

test('installing refuses while a copy started by hand holds the port, and changes nothing', async () => {
  const { home, p } = sandbox();
  const { sys } = fakeMac({ portInUse: async () => true });
  await assert.rejects(mac.install(p, sys), /already running[\s\S]*Control \+ C/);
  assert.ok(!fs.existsSync(path.join(home, 'Applications', '00Dojo.app')));
  assert.ok(!fs.existsSync(p.plist));
});

test('a service that cannot read its iCloud files is reported with the way out', async () => {
  const { home, p } = sandbox();
  const synced = { ...p, root: path.join(home, 'Documents', 'majordomo') };
  fs.mkdirSync(path.join(synced.root, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  fs.writeFileSync(p.log, CLOUD_CRASH);
  const { sys, said } = fakeMac({ isHealthy: async () => false });

  await assert.rejects(mac.install(synced, sys), /did not start[\s\S]*kept in iCloud[\s\S]*home folder[\s\S]*npm install/);
  assert.ok(said.join('\n').includes('If iCloud syncs this folder'), 'the risk is mentioned before starting');
});

test('a service that never answers is reported with its log', async () => {
  const { home, p } = sandbox();
  const guarded = { ...p, root: path.join(home, 'Documents', 'GitHub', 'majordomo') };
  fs.mkdirSync(path.join(guarded.root, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.dirname(p.log), { recursive: true });
  fs.writeFileSync(p.log, 'Error: EPERM: operation not permitted, scandir\n');
  const { sys, said } = fakeMac({ isHealthy: async () => false });

  await assert.rejects(mac.install(guarded, sys), /did not start[\s\S]*Files and Folders[\s\S]*EPERM/);
  assert.ok(said.join('\n').includes('“node” may access files in Documents'), 'the permission box is announced beforehand');
});

test('the app icon is a well-formed icns with a full-size image', () => {
  const icns = fs.readFileSync(path.join(repo, 'assets', '00Dojo.icns'));
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length, 'the declared length matches the file');
  const types: string[] = [];
  for (let at = 8; at < icns.length; at += icns.readUInt32BE(at + 4)) {
    types.push(icns.subarray(at, at + 4).toString());
    assert.equal(icns.subarray(at + 8, at + 12).toString('latin1'), '\x89PNG', 'each entry is a PNG');
  }
  assert.ok(types.includes('ic10') && types.includes('ic07'), types.join(' '));
});

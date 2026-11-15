#!/usr/bin/env node
// grokbot-model-watch — the command line.
//
//   grokbot-model-watch                 start the dashboard (same as `serve`)
//   grokbot-model-watch login           sign in to Cursor in your browser
//   grokbot-model-watch import-app-token  borrow the Grok Bot desktop app's session (macOS)
//   grokbot-model-watch demo            start with synthetic data
//   grokbot-model-watch token           print (or --rotate) the bearer token for the plugin
//   grokbot-model-watch hook-secret ... manage inference-hook signing secrets
//   grokbot-model-watch probe           print one JSON snapshot of every source
//   grokbot-model-watch logout

import { spawn } from 'node:child_process';
import { clearAuth, homeDir, loadAuth, loadSettings, randomToken, saveAuth, saveSettings } from '../lib/config.mjs';
import { CursorClient } from '../lib/cursor-api.mjs';
import { createAppSessionProvider, importAppToken, jwtExpMs, pkceLogin } from '../lib/cursor-auth.mjs';
import { DemoClient, demoHookSummary } from '../lib/demo.mjs';
import { isPlausibleSecret } from '../lib/inference-hooks.mjs';
import { createServer, listen } from '../lib/server.mjs';
import { VERSION, Watch } from '../lib/watch.mjs';

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const [key, inline] = a.slice(2).split('=');
    if (inline !== undefined) flags[key] = inline;
    else if (i + 1 < args.length && !args[i + 1].startsWith('--') && !['open', 'rotate', 'yes', 'json', 'report', 'no-transcripts', 'team-bots', 'version', 'help'].includes(key)) flags[key] = args[++i];
    else flags[key] = true;
  } else positional.push(a);
}
const command = flags.version ? 'version' : flags.help || flags.h ? 'help' : positional[0] || 'serve';
const log = (msg) => console.error(`[model-watch] ${msg}`);

function openBrowser(url) {
  const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.on('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function help() {
  console.log(`grokbot-model-watch ${VERSION}

  serve [--host H] [--port P] [--public-url URL] [--open]   run the dashboard, API, MCP endpoint and hook receiver (default)
        [--no-transcripts] [--team-bots]                     skip transcript polling / include Bots teammates own
  demo [--port P] [--open]                                   same, with synthetic Bots and usage
  login                                                      sign in to Cursor in your browser (our own session)
  import-app-token [--yes]                                   borrow the Grok Bot desktop app's session (macOS only)
  logout                                                     forget the saved session
  token [--rotate]                                           print the bearer token the plugin and remote clients use
  token --report [--rotate]                                  print the write-only token for the plugin's reporting hook
  hook-secret add <whsec_...> | list | remove <n>            inference-hook signing secrets (Enterprise)
  probe [--json]                                             fetch every source once and print the snapshot
  help

Files live in ${homeDir()} (override with MODEL_WATCH_HOME).`);
}

function buildClient(settings) {
  const auth = loadAuth();
  if (!auth) return null;
  // A borrowed app session is decrypted on demand and held in memory only.
  const appSession = auth.source === 'app' ? createAppSessionProvider() : null;
  if (appSession) {
    try {
      appSession.get();
    } catch (err) {
      log(`Could not read the Grok Bot app session: ${err.message}`);
      return null;
    }
  }
  return new CursorClient({
    // Re-read auth.json on every call, so a `login` in another terminal is picked up without a restart.
    getAuth: () => (appSession ? appSession.get() : loadAuth() || auth),
    saveAuth: (next) => saveAuth(next),
    machineId: settings.machineId,
    clientVersion: process.env.MODEL_WATCH_CLIENT_VERSION || settings.clientVersion,
    log,
  });
}

function watchOptions() {
  return { transcripts: !flags['no-transcripts'], includeTeamAgents: Boolean(flags['team-bots']) };
}

async function serve({ demo = false } = {}) {
  const settings = loadSettings();
  if (flags.host) settings.host = String(flags.host);
  if (flags.port) settings.port = Number(flags.port);
  if (flags['public-url']) {
    let parsed;
    try {
      parsed = new URL(String(flags['public-url']));
    } catch {
      throw new Error('--public-url must be a full URL such as https://watch.example.com');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.search || parsed.hash) throw new Error('--public-url must be an https:// URL without credentials, query or fragment');
    settings.publicUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
    saveSettings(settings);
  }
  const client = demo ? new DemoClient() : buildClient(settings);
  const watch = new Watch({ settings, client, mode: demo ? 'demo' : 'live', log, options: watchOptions(), ...(demo ? { localDir: '/nonexistent-grokbot-demo' } : {}) });
  if (!demo && !client) log('Not signed in to Cursor. Showing local app data only; run `grokbot-model-watch login` for the usage ledger and live status.');
  await watch.start();
  if (demo) {
    const feed = setInterval(() => {
      const summary = demoHookSummary(client, Date.now());
      if (watch.windows.isRunning(client.agents[0].agentId)) watch.recordHookFrame(summary);
    }, 12_000);
    feed.unref();
  }
  const server = createServer({ watch, settings, log });
  const nonLoopback = !['127.0.0.1', 'localhost', '::1'].includes(settings.host);
  if (nonLoopback) log(`Binding to ${settings.host}: the page, API and stream need the bearer token (grokbot-model-watch token). Put TLS in front of it before exposing it to the internet.`);
  const address = await listen(server, { host: settings.host, port: settings.port });
  const shownHost = settings.host === '0.0.0.0' || settings.host === '::' ? 'localhost' : settings.host;
  const localUrl = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${address.port}`;
  const base = settings.publicUrl || localUrl;
  console.log(`Grok Bot Model Watch ${VERSION}${demo ? ' (demo data)' : ''}`);
  console.log(`  Dashboard   ${localUrl}`);
  console.log(`  MCP         ${base}/mcp   (bearer token: grokbot-model-watch token)`);
  if (!settings.publicUrl) console.log('              Bots run in the cloud and cannot reach this address. For the MCP tools, put a public HTTPS URL in front and pass --public-url.');
  console.log(`  Hooks       ${base}/hooks/inference   (${settings.hookSecrets.length} signing secret${settings.hookSecrets.length === 1 ? '' : 's'})`);
  if (flags.open) openBrowser(localUrl).catch(() => {});
  const shutdown = () => {
    watch.stop();
    server.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function login() {
  const auth = await pkceLogin({ open: openBrowser, log: (m) => console.log(m) });
  saveAuth(auth);
  const exp = jwtExpMs(auth.accessToken);
  console.log(`Signed in${auth.email ? ` as ${auth.email}` : ''}. Session valid until ${exp ? new Date(exp).toLocaleString() : 'unknown'}; it refreshes itself.`);
}

async function importApp() {
  if (!flags.yes) {
    console.log('This reads the Grok Bot desktop app\'s saved Cursor session from ~/Library/Application Support/Grok Bot/sand-secrets.json.');
    console.log('macOS will ask for Keychain access to "Grok Bot Safe Storage" now and each time the companion starts. That session has full access to your account,');
    console.log('and running a second client on it is undocumented behaviour. `login` (a session of its own) is the recommended way.');
    console.log('Re-run with --yes to continue.');
    process.exitCode = 2;
    return;
  }
  const auth = importAppToken();
  // Only a marker is saved; the token itself is re-read from the app each time the companion starts.
  saveAuth({ source: 'app', email: auth.email });
  const exp = jwtExpMs(auth.accessToken);
  console.log(`Using the Grok Bot app's session${auth.email ? ` for ${auth.email}` : ''} (valid until ${exp ? new Date(exp).toLocaleString() : 'unknown'}). The token stays in the app's own store; nothing was copied to disk.`);
}

function token() {
  const settings = loadSettings();
  const which = flags.report ? 'reportToken' : 'mcpToken';
  if (flags.rotate) {
    settings[which] = randomToken();
    saveSettings(settings);
    console.error(flags.report ? 'Rotated. Update hook.json on the Bot computer.' : 'Rotated. Update MODEL_WATCH_TOKEN wherever the plugin or connector is configured.');
  }
  console.log(settings[which]);
}

function hookSecret() {
  const settings = loadSettings();
  const sub = positional[1];
  if (sub === 'add') {
    const secret = String(positional[2] || '').trim();
    if (!isPlausibleSecret(secret)) {
      console.error('Expected a signing secret like whsec_... from the Cursor dashboard (Grok Bot → Inference Hooks).');
      process.exitCode = 2;
      return;
    }
    if (!settings.hookSecrets.includes(secret)) settings.hookSecrets.push(secret);
    saveSettings(settings);
    console.log(`Saved. ${settings.hookSecrets.length} secret(s) are accepted. Keep the previous one for a minute after a rotation, then remove it.`);
  } else if (sub === 'list') {
    settings.hookSecrets.forEach((s, i) => console.log(`${i + 1}. whsec_…${s.slice(-6)}`));
    if (!settings.hookSecrets.length) console.log('(none)');
  } else if (sub === 'remove') {
    const index = Number(positional[2]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= settings.hookSecrets.length) {
      console.error('Give the number shown by `hook-secret list`.');
      process.exitCode = 2;
      return;
    }
    settings.hookSecrets.splice(index, 1);
    saveSettings(settings);
    console.log('Removed.');
  } else {
    console.error('Usage: hook-secret add <whsec_...> | list | remove <n>');
    process.exitCode = 2;
  }
}

async function probe() {
  const settings = loadSettings();
  const client = buildClient(settings);
  const watch = new Watch({ settings, client, log, options: watchOptions() });
  if (client) for (const name of ['agents', 'status', 'transcript', 'usage', 'aggregate', 'allowance', 'spend']) if (watch.pollers[name]) await watch.pollers[name].tick().catch(() => {});
  await watch.pollers.local.tick().catch(() => {});
  const state = watch.state();
  watch.stop();
  console.log(JSON.stringify(state, null, flags.json ? 0 : 2));
}

try {
  switch (command) {
    case 'serve':
      await serve();
      break;
    case 'demo':
      await serve({ demo: true });
      break;
    case 'login':
      await login();
      break;
    case 'import-app-token':
      await importApp();
      break;
    case 'logout':
      clearAuth();
      console.log('Forgot the saved session.');
      break;
    case 'token':
      token();
      break;
    case 'hook-secret':
      hookSecret();
      break;
    case 'probe':
      await probe();
      break;
    case 'help':
    case '-h':
    case '--help':
      help();
      break;
    case 'version':
    case '--version':
      console.log(VERSION);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      help();
      process.exitCode = 2;
  }
} catch (err) {
  console.error(`Error: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}

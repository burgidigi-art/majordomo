// Where the companion keeps its settings, its Cursor session and its evidence log.
//
// Everything lives in one directory (default ~/.grokbot-model-watch, override with
// MODEL_WATCH_HOME). The directory is 0700 and every file is 0600, because auth.json
// holds a Cursor session token that grants access to the user's account.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_PORT = 4319;

/** The desktop app version the backend expects to hear from. Bump when Grok Bot updates. */
export const DEFAULT_CLIENT_VERSION = '0.75.0';

export const DEFAULT_SETTINGS = Object.freeze({
  host: '127.0.0.1',
  port: DEFAULT_PORT,
  /** The URL Bots and Cursor reach this server at (empty until the user exposes it). */
  publicUrl: '',
  /** Bearer token for the MCP endpoint and for non-loopback access to the API. Generated on first run. */
  mcpToken: '',
  /** Write-only token for the plugin's experimental reporting hook; it can post reports and nothing else. */
  reportToken: '',
  /** Inference-hook signing secrets (whsec_...). Several, so a rotation keeps verifying. */
  hookSecrets: [],
  /** A stable per-install id sent in the x-cursor-checksum header. */
  machineId: '',
  clientVersion: DEFAULT_CLIENT_VERSION,
  pollMs: Object.freeze({
    agents: 60_000,
    status: 3_000,
    transcript: 10_000,
    usage: 15_000,
    aggregate: 60_000,
    allowance: 60_000,
    spend: 300_000,
    local: 10_000,
  }),
});

export function homeDir(env = process.env) {
  return env.MODEL_WATCH_HOME || path.join(os.homedir(), '.grokbot-model-watch');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows has no POSIX modes; the directory is still private to the user profile.
  }
  return dir;
}

/** Parse a JSON file. A missing or unreadable file yields `fallback`; other errors propagate. */
export function readJson(file, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Write JSON atomically with private permissions. */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // see ensureDir
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function newMachineId() {
  return randomBytes(32).toString('hex');
}

/** Load settings, filling defaults and generating the per-install secrets the first time. */
export function loadSettings(dir = homeDir()) {
  const file = path.join(dir, 'settings.json');
  const saved = readJson(file, null);
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(saved && typeof saved === 'object' ? saved : {}),
    pollMs: { ...DEFAULT_SETTINGS.pollMs, ...((saved && saved.pollMs) || {}) },
  };
  let changed = saved === null;
  if (!merged.mcpToken) {
    merged.mcpToken = randomToken();
    changed = true;
  }
  if (!merged.reportToken) {
    merged.reportToken = randomToken();
    changed = true;
  }
  if (!merged.machineId || !/^[0-9a-f]{64}$/.test(merged.machineId)) {
    merged.machineId = newMachineId();
    changed = true;
  }
  if (!Array.isArray(merged.hookSecrets)) {
    merged.hookSecrets = [];
    changed = true;
  }
  if (changed) writeJson(file, merged);
  return merged;
}

export function saveSettings(settings, dir = homeDir()) {
  writeJson(path.join(dir, 'settings.json'), settings);
}

/**
 * The Cursor session. `source` says where it came from: `login` (our own PKCE session,
 * may be refreshed), `app` (borrowed from the desktop app at run time; only the marker is
 * stored, never the token) or `env`.
 */
export function loadAuth(dir = homeDir(), env = process.env) {
  if (env.MODEL_WATCH_CURSOR_TOKEN) {
    return { source: 'env', accessToken: env.MODEL_WATCH_CURSOR_TOKEN.trim(), refreshToken: null, email: null };
  }
  const auth = readJson(path.join(dir, 'auth.json'), null);
  if (!auth || typeof auth !== 'object') return null;
  if (auth.source === 'app') return { source: 'app', accessToken: null, refreshToken: null, email: typeof auth.email === 'string' ? auth.email : null };
  if (typeof auth.accessToken !== 'string' || !auth.accessToken) return null;
  return auth;
}

/** Persist a session. For the borrowed app session only the marker and email are written. */
export function saveAuth(auth, dir = homeDir()) {
  const record = auth.source === 'app' ? { source: 'app', email: auth.email || null } : auth;
  writeJson(path.join(dir, 'auth.json'), { ...record, savedAt: new Date().toISOString() });
}

export function clearAuth(dir = homeDir()) {
  try {
    fs.unlinkSync(path.join(dir, 'auth.json'));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
}

export function evidenceLogPath(dir = homeDir()) {
  return path.join(dir, 'evidence.jsonl');
}

/** Hide anything that looks like a bearer token, cookie or signing secret in a log line. */
export function redact(text) {
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]')
    .replace(/whsec_[A-Za-z0-9+/=_-]+/g, 'whsec_[redacted]')
    .replace(/(authorization|cookie)(["']?\s*[:=]\s*["']?)([^"'\s,;]+)/gi, '$1$2[redacted]');
}

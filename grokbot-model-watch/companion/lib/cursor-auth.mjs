// Signing in to Cursor the way the Grok Bot desktop app does, and the request headers
// its backend expects.
//
// Two ways to get a session:
//  - `pkceLogin`: Cursor's "deep control" browser sign-in. This is our own session,
//    independent of the app, so refreshing it never signs the app out.
//  - `importAppToken` (macOS only): decrypt the access token the desktop app saved. The
//    app's refresh token is deliberately not used; refreshing it could sign the app out.
//
// Nothing here is documented by Cursor. The flows were reconstructed by community CLIs
// from the app itself (see facts.md F7 in the research notes) and may change.

import { createDecipheriv, createHash, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const API_BASE = 'https://api2.cursor.sh';
export const DASHBOARD_BASE = 'https://cursor.com';
/** The OAuth client id the desktop app refreshes with. */
export const OAUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ---------- PKCE login ----------

export function pkceStart({ dashboardBase = DASHBOARD_BASE, random = randomBytes, uuid = randomUUID } = {}) {
  const verifier = b64url(random(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const id = uuid();
  const url = `${dashboardBase}/loginDeepControl?challenge=${challenge}&uuid=${id}&mode=login&redirectTarget=cli`;
  return { verifier, challenge, uuid: id, url };
}

/** One poll of the sign-in. 404 means the user has not finished yet; 403 means they refused. */
export async function pkcePoll({ uuid, verifier, apiBase = API_BASE, fetchImpl = fetch }) {
  const url = `${apiBase}/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`;
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (res.status === 404) return { status: 'pending' };
  if (res.status === 403) return { status: 'refused' };
  if (!res.ok) throw new Error(`auth/poll returned HTTP ${res.status}`);
  const body = await res.json();
  if (!body || typeof body.accessToken !== 'string') return { status: 'pending' };
  return {
    status: 'ok',
    accessToken: body.accessToken,
    refreshToken: typeof body.refreshToken === 'string' ? body.refreshToken : null,
    authId: typeof body.authId === 'string' ? body.authId : null,
  };
}

/**
 * Run the whole browser sign-in: open the URL, poll until the user finishes.
 * Resolves to `{ source: 'login', accessToken, refreshToken, email }`.
 */
export async function pkceLogin({
  open,
  log = () => {},
  apiBase = API_BASE,
  dashboardBase = DASHBOARD_BASE,
  fetchImpl = fetch,
  timeoutMs = 10 * 60_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const start = pkceStart({ dashboardBase });
  log(`Open this page to sign in to Cursor:\n  ${start.url}`);
  if (open) {
    try {
      await open(start.url);
    } catch {
      log('Could not open a browser automatically; open the link above yourself.');
    }
  }
  const deadline = now() + timeoutMs;
  let wait = 1000;
  while (now() < deadline) {
    const poll = await pkcePoll({ uuid: start.uuid, verifier: start.verifier, apiBase, fetchImpl });
    if (poll.status === 'ok') {
      const payload = decodeJwt(poll.accessToken) || {};
      return { source: 'login', accessToken: poll.accessToken, refreshToken: poll.refreshToken, email: payload.email || null };
    }
    if (poll.status === 'refused') throw new Error('Sign-in was refused in the browser.');
    await sleep(wait);
    wait = Math.min(wait * 1.2, 5000);
  }
  throw new Error('Sign-in timed out. Run `login` again.');
}

export async function refreshTokens(refreshToken, { apiBase = API_BASE, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${apiBase}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`oauth/token returned HTTP ${res.status}`);
  const body = await res.json();
  if (body && body.shouldLogout === true) return { accessToken: null, refreshToken: null, shouldLogout: true };
  if (!body || typeof body.access_token !== 'string') throw new Error('oauth/token returned no access_token');
  return { accessToken: body.access_token, refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken, shouldLogout: false };
}

// ---------- JWT helpers ----------

export function decodeJwt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function jwtSub(token) {
  const payload = decodeJwt(token);
  return payload && typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
}

/** Expiry in milliseconds since the epoch, or null when the token has no `exp`. */
export function jwtExpMs(token) {
  const payload = decodeJwt(token);
  return payload && typeof payload.exp === 'number' ? payload.exp * 1000 : null;
}

export function looksLikeJwt(text) {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(text).trim());
}

// ---------- request headers ----------

/** The app's checksum obfuscation: a running XOR-and-add over the bytes. */
export function obfuscate(bytes) {
  let prev = 165;
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = ((bytes[i] ^ prev) + (i % 256)) & 255;
    prev = bytes[i];
  }
  return bytes;
}

/**
 * `x-cursor-checksum`: the current time in units of 1000 s as 6 big-endian bytes,
 * obfuscated and base64url-encoded without padding, followed by the machine id.
 */
export function checksum(machineId, nowMs = Date.now()) {
  const t = Math.floor(nowMs / 1e6);
  const bytes = new Uint8Array(6);
  bytes[0] = Math.floor(t / 2 ** 40) & 255;
  bytes[1] = Math.floor(t / 2 ** 32) & 255;
  bytes[2] = (t >>> 24) & 255;
  bytes[3] = (t >>> 16) & 255;
  bytes[4] = (t >>> 8) & 255;
  bytes[5] = t & 255;
  return Buffer.from(obfuscate(bytes)).toString('base64url') + machineId;
}

export function clientOs(platform = process.platform) {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'win32';
  return 'linux';
}

export function userAgent(clientVersion) {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Sand/${clientVersion} Safari/537.36`;
}

/** Headers for a Connect RPC call to api2.cursor.sh, as the desktop app sends them. */
export function connectHeaders({ token, machineId, clientVersion, platform = process.platform, nowMs = Date.now(), requestId = randomUUID() }) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'connect-protocol-version': '1',
    authorization: `Bearer ${token}`,
    'user-agent': userAgent(clientVersion),
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': clientVersion,
    'x-cursor-client-os': clientOs(platform),
    'x-cursor-client-source': 'sand-desktop',
    'x-sand-box-namespace': 'prod',
    'x-ghost-mode': 'true',
    'x-cursor-checksum': checksum(machineId, nowMs),
    'x-request-id': requestId,
  };
}

/**
 * The cursor.com dashboard authenticates with a cookie built from the token's `sub`
 * claim and the token itself. The subject is `auth0|user_...` on current tokens; the
 * cookie carries the part after the bar. Both spellings are returned so a caller can
 * fall back if one is rejected.
 */
export function dashboardCookieCandidates(token) {
  const sub = jwtSub(token);
  if (!sub) throw new Error('The access token is not a JWT with a sub claim.');
  const candidates = [];
  const afterBar = sub.includes('|') ? sub.slice(sub.lastIndexOf('|') + 1) : sub;
  candidates.push(afterBar);
  if (afterBar !== sub) candidates.push(sub);
  return candidates.map((id) => `WorkosCursorSessionToken=${encodeURIComponent(id)}%3A%3A${token}`);
}

export function dashboardHeaders({ cookie, forPost = false, dashboardBase = DASHBOARD_BASE, clientVersion = '0.75.0' }) {
  const headers = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': userAgent(clientVersion),
    cookie,
  };
  if (forPost) {
    headers['content-type'] = 'application/json';
    headers.origin = dashboardBase;
    headers.referer = `${dashboardBase}/dashboard?tab=usage`;
  }
  return headers;
}

// ---------- desktop app session (macOS) ----------

const SAFE_STORAGE_PREFIX = 'v10';

/** Decrypt an Electron safeStorage value as the Grok Bot app stores it on macOS. */
export function decryptSafeStorage(value, key) {
  const text = String(value);
  if (text.startsWith('plaintext:v1:')) return text.slice('plaintext:v1:'.length);
  const encoded = text.startsWith('scoped:v1:') ? text.slice('scoped:v1:'.length) : text;
  const buf = Buffer.from(encoded, 'base64');
  if (buf.subarray(0, 3).toString('latin1') !== SAFE_STORAGE_PREFIX) {
    throw new Error('Unsupported Grok Bot safeStorage format.');
  }
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString('utf8');
}

export function safeStorageKey(keychainPassword) {
  return pbkdf2Sync(keychainPassword, 'saltysalt', 1003, 16, 'sha1');
}

export function appSecretsPath(home = os.homedir()) {
  return path.join(home, 'Library', 'Application Support', 'Grok Bot', 'sand-secrets.json');
}

function readKeychainPassword(exec) {
  return exec('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Grok Bot Safe Storage', '-a', 'Grok Bot Key'], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

/**
 * Read the desktop app's current Cursor access token (macOS only). Only that one value is
 * decrypted: the app's refresh token, profile and other secrets are never touched, and the
 * result is meant to stay in memory, not on disk. macOS asks for Keychain permission the
 * first time.
 */
export function importAppToken({ home = os.homedir(), platform = process.platform, exec = execFileSync, readFile = fs.readFileSync } = {}) {
  if (platform !== 'darwin') {
    throw new Error('Importing the desktop app session works on macOS only. Use `login` instead.');
  }
  const file = appSecretsPath(home);
  let raw;
  try {
    raw = JSON.parse(readFile(file, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(`Grok Bot has not saved a session yet (${file} is missing). Open the app and sign in first.`);
    throw err;
  }
  const accountsText = raw['cursor-accounts'];
  if (typeof accountsText !== 'string') throw new Error('sand-secrets.json has no cursor-accounts entry (the format changed?).');
  const accounts = JSON.parse(accountsText);
  const active = accounts && accounts.accounts ? accounts.accounts[accounts.active] : null;
  if (!active || typeof active['cursor-access-token'] !== 'string') throw new Error('No active Grok Bot account in sand-secrets.json.');

  const key = safeStorageKey(readKeychainPassword(exec));
  let decrypted;
  try {
    decrypted = decryptSafeStorage(active['cursor-access-token'], key);
  } finally {
    key.fill(0);
  }
  const match = decrypted.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  if (!match) throw new Error('The decrypted access token is not a JWT (wrong Keychain key?).');
  const payload = decodeJwt(match[0]) || {};
  return { source: 'app', accessToken: match[0], refreshToken: null, email: typeof payload.email === 'string' ? payload.email : null };
}

/**
 * The borrowed app session as a live provider: the token is decrypted on demand, kept in
 * memory only, and re-read from the app's file when it is about to expire or after a 401
 * (`reload`). Nothing is written anywhere.
 */
export function createAppSessionProvider({ home = os.homedir(), platform = process.platform, exec = execFileSync, readFile = fs.readFileSync, now = Date.now } = {}) {
  let cached = null;
  let lastError = null;
  const read = () => {
    try {
      const fresh = importAppToken({ home, platform, exec, readFile });
      cached = { ...fresh, reload };
      lastError = null;
    } catch (err) {
      lastError = err;
      if (!cached) throw err;
    }
    return cached;
  };
  function reload() {
    const before = cached ? cached.accessToken : null;
    const next = read();
    return next && next.accessToken !== before ? next : null;
  }
  return {
    get() {
      if (!cached) return read();
      const exp = jwtExpMs(cached.accessToken);
      if (exp !== null && exp - now() < 60_000) return read();
      return cached;
    },
    reload,
    get lastError() {
      return lastError;
    },
  };
}

// What the Grok Bot desktop app keeps on this machine, read without any network or sign-in.
//
// The app mirrors a window of each Bot's transcript into its Electron userData folder as
// `sand-client-persistence/<base32 slice key>.blob`. There is no model, token or cost
// information in there (the research notes, F9), so this is only a fallback for Bot
// names and recent activity when the companion is not signed in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PERSISTENCE_DIR = 'sand-client-persistence';
const ROSTER_SLICE = /^sand\.client\.slice\.account\.(.+)\.roster\.last-roster$/;
const TRANSCRIPT_SLICE = /^sand\.client\.slice\.account\.(.+)\.transcript\.replicas\.(.+)$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** The app rewrites its session marker every few seconds; older than this means it is closed. */
export const MARKER_STALE_MS = 45_000;

export function userDataDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (env.MODEL_WATCH_GROKBOT_DIR) return env.MODEL_WATCH_GROKBOT_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Grok Bot');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Grok Bot');
  return path.join(home, '.config', 'Grok Bot');
}

/** RFC 4648 base32, lowercase and unpadded, as the app names its slice files. */
export function decodeBase32(name) {
  let value = 0;
  let bits = 0;
  const bytes = [];
  for (const ch of String(name)) {
    const index = BASE32.indexOf(ch);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

export function encodeBase32(text) {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function readSliceValue(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.value && typeof parsed.value === 'object' ? parsed.value : null;
  } catch {
    return null;
  }
}

export function listSlices(dir) {
  const folder = path.join(dir, PERSISTENCE_DIR);
  let files;
  try {
    files = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const slices = [];
  for (const file of files) {
    if (!file.endsWith('.blob')) continue;
    const key = decodeBase32(file.slice(0, -'.blob'.length));
    if (key) slices.push({ file: path.join(folder, file), key });
  }
  return slices;
}

const str = (v) => (typeof v === 'string' && v ? v : null);
const ms = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
};

/** agentId → { name, lastActivityAt, awaitingUserResponse } from the roster slice(s). */
export function readRoster(dir) {
  const roster = new Map();
  for (const slice of listSlices(dir)) {
    if (!ROSTER_SLICE.test(slice.key)) continue;
    const value = readSliceValue(slice.file);
    const rows = value && Array.isArray(value.rows) ? value.rows : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const id = str(row.id);
      if (!id) continue;
      roster.set(id, {
        name: str(row.name) || id,
        lastActivityAt: ms(row.lastActivityAt ?? row.lastActivityAtMs),
        awaitingUserResponse: row.awaitingUserResponse === true,
      });
    }
  }
  return roster;
}

/** A compact, text-light view of one transcript entry (only an 80-char preview of Bot replies). */
export function summarizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const at = ms(entry.timestampMs);
  const kind = str(entry.kind) || 'unknown';
  const summary = { kind, id: str(entry.id), at, requestId: str(entry.requestId), role: null, type: null, preview: null, fromAgent: null, toAgent: null, wake: null };
  if (kind === 'message') {
    summary.role = str(entry.role);
    summary.fromAgent = entry.fromAgent && typeof entry.fromAgent === 'object' ? str(entry.fromAgent.name) || str(entry.fromAgent.id) : null;
    summary.toAgent = entry.toAgent && typeof entry.toAgent === 'object' ? str(entry.toAgent.name) || str(entry.toAgent.id) : null;
  } else if (kind === 'send-message') {
    const message = entry.message && typeof entry.message === 'object' ? entry.message : {};
    summary.type = str(message.type);
    summary.wake = str(entry.wake);
    if (summary.type === 'text' && typeof message.content === 'string') summary.preview = message.content.replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  return summary;
}

export function readTranscriptReplicas(dir) {
  const replicas = [];
  for (const slice of listSlices(dir)) {
    const match = TRANSCRIPT_SLICE.exec(slice.key);
    if (!match) continue;
    const value = readSliceValue(slice.file);
    const entries = value && Array.isArray(value.entries) ? value.entries.map(summarizeEntry).filter(Boolean) : [];
    replicas.push({ agentId: match[2], entries });
  }
  return replicas;
}

export function appAlive(dir, nowMs = Date.now()) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, 'sand-session-marker.json'), 'utf8'));
    const aliveAt = ms(marker.aliveAtMs);
    return {
      present: true,
      alive: aliveAt !== null && nowMs - aliveAt < MARKER_STALE_MS,
      appVersion: str(marker.appVersion),
      aliveAtMs: aliveAt,
    };
  } catch {
    return { present: false, alive: false, appVersion: null, aliveAtMs: null };
  }
}

/** Everything the local files can tell us, in one object. */
export function snapshotLocal(dir = userDataDir(), nowMs = Date.now()) {
  if (!fs.existsSync(dir)) return { present: false, dir, app: { present: false, alive: false }, bots: [] };
  const roster = readRoster(dir);
  const replicas = readTranscriptReplicas(dir);
  const bots = new Map();
  for (const [agentId, row] of roster) bots.set(agentId, { agentId, name: row.name, lastEntryAt: row.lastActivityAt, lastEntryKind: null, lastReplyPreview: null, awaitingUserResponse: row.awaitingUserResponse });
  for (const replica of replicas) {
    const bot = bots.get(replica.agentId) || { agentId: replica.agentId, name: replica.agentId, lastEntryAt: null, lastEntryKind: null, lastReplyPreview: null, awaitingUserResponse: false };
    for (const entry of replica.entries) {
      if (entry.at !== null && (bot.lastEntryAt === null || entry.at > bot.lastEntryAt)) {
        bot.lastEntryAt = entry.at;
        bot.lastEntryKind = entry.kind;
      }
      if (entry.preview) bot.lastReplyPreview = entry.preview;
    }
    bots.set(replica.agentId, bot);
  }
  return { present: true, dir, app: appAlive(dir, nowMs), bots: [...bots.values()].sort((a, b) => (b.lastEntryAt || 0) - (a.lastEntryAt || 0)) };
}

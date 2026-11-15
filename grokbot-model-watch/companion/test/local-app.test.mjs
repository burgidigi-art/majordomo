// Tests for lib/local-app.mjs: reading what the Grok Bot desktop app keeps on disk.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKER_STALE_MS, appAlive, decodeBase32, encodeBase32, listSlices, readRoster, readTranscriptReplicas, snapshotLocal, summarizeEntry, userDataDir } from '../lib/local-app.mjs';

const T0 = 1_763_164_800_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-local-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const slices = path.join(dir, 'sand-client-persistence');
fs.mkdirSync(slices);
const writeSlice = (key, value) => fs.writeFileSync(path.join(slices, `${encodeBase32(key)}.blob`), JSON.stringify({ schemaVersion: 3, value }));

writeSlice('sand.client.slice.account.acct-1.roster.last-roster', { rows: [{ id: 'agent-a', name: 'Research Bot', lastActivityAt: T0 - 5000 }, { id: 'agent-b', name: 'Inbox Bot', awaitingUserResponse: true }, { name: 'no id' }] });
writeSlice('sand.client.slice.account.acct-1.transcript.replicas.agent-a', {
  entries: [
    { kind: 'message', id: 'm1', role: 'user', content: 'SECRET user text', timestampMs: T0 - 4000, requestId: 't1', clientNonce: 'n1' },
    { kind: 'send-message', id: 's1', message: { type: 'text', content: `Reply   with\nspaces ${'z'.repeat(200)}` }, timestampMs: T0 - 1000, requestId: 't1' },
    { kind: 'send-message', id: 's2', message: { type: 'widget', widget: { prompt: 'Pick' } }, timestampMs: T0 - 500, requestId: 't1', wake: 'agent' },
  ],
});
writeSlice('sand.client.slice.account.acct-1.transcript.replicas.agent-c', { entries: [{ kind: 'event', timestampMs: T0 - 100 }] });
fs.writeFileSync(path.join(slices, 'README.txt'), 'not a slice');
fs.writeFileSync(path.join(slices, '!!!.blob'), '{}');
fs.writeFileSync(path.join(slices, `${encodeBase32('sand.client.slice.account.acct-1.transcript.replicas.agent-broken')}.blob`), '{half written');

describe('paths and names', () => {
  it('userDataDir follows the platform and honours the override', () => {
    assert.equal(userDataDir({ platform: 'darwin', home: '/Users/x', env: {} }), '/Users/x/Library/Application Support/Grok Bot');
    assert.equal(userDataDir({ platform: 'linux', home: '/home/x', env: {} }), '/home/x/.config/Grok Bot');
    assert.equal(userDataDir({ platform: 'win32', home: 'C:\\Users\\x', env: { APPDATA: 'C:\\Roaming' } }), path.join('C:\\Roaming', 'Grok Bot'));
    assert.equal(userDataDir({ platform: 'linux', home: '/h', env: { MODEL_WATCH_GROKBOT_DIR: '/custom' } }), '/custom');
  });

  it('base32 round-trips slice keys (lowercase, unpadded)', () => {
    for (const key of ['a', 'ab', 'abc', 'sand.client.slice.account.x-1.transcript.replicas.3f2c9a71-58e4']) {
      const enc = encodeBase32(key);
      assert.match(enc, /^[a-z2-7]+$/);
      assert.equal(decodeBase32(enc), key);
    }
    assert.equal(encodeBase32('foobar'), 'mzxw6ytboi');
    assert.equal(decodeBase32('NOT-BASE32'), null);
  });
});

describe('reading slices', () => {
  it('listSlices ignores non-blob and undecodable names', () => {
    const keys = listSlices(dir).map((s) => s.key);
    assert.equal(keys.length, 4);
    assert.ok(keys.every((k) => k.startsWith('sand.client.slice.account.')));
    assert.deepEqual(listSlices(path.join(dir, 'missing')), []);
  });

  it('readRoster maps agent ids to names and flags', () => {
    const roster = readRoster(dir);
    assert.deepEqual([...roster.keys()], ['agent-a', 'agent-b']);
    assert.deepEqual(roster.get('agent-a'), { name: 'Research Bot', lastActivityAt: T0 - 5000, awaitingUserResponse: false });
    assert.equal(roster.get('agent-b').awaitingUserResponse, true);
  });

  it('summarizeEntry never keeps user text and caps the reply preview at 80 characters', () => {
    const user = summarizeEntry({ kind: 'message', role: 'user', content: 'SECRET', timestampMs: T0, requestId: 't', fromAgent: { name: 'Ops Bot' } });
    assert.ok(!JSON.stringify(user).includes('SECRET'));
    assert.equal(user.fromAgent, 'Ops Bot');
    const reply = summarizeEntry({ kind: 'send-message', message: { type: 'text', content: `a  b\n${'c'.repeat(200)}` }, timestampMs: T0 / 1000 });
    assert.equal(reply.preview.length, 80);
    assert.ok(reply.preview.startsWith('a b c'));
    assert.equal(reply.at, T0, 'seconds are promoted to milliseconds');
    assert.equal(summarizeEntry({ kind: 'send-message', message: { type: 'widget' }, wake: 'agent' }).wake, 'agent');
    assert.equal(summarizeEntry({}).kind, 'unknown');
    assert.equal(summarizeEntry(null), null);
  });

  it('readTranscriptReplicas tolerates a half-written file', () => {
    const replicas = readTranscriptReplicas(dir);
    const byId = Object.fromEntries(replicas.map((r) => [r.agentId, r.entries.length]));
    assert.deepEqual(byId, { 'agent-a': 3, 'agent-c': 1, 'agent-broken': 0 });
  });

  it('appAlive reads the session marker and goes stale', () => {
    assert.deepEqual(appAlive(dir, T0), { present: false, alive: false, appVersion: null, aliveAtMs: null });
    fs.writeFileSync(path.join(dir, 'sand-session-marker.json'), JSON.stringify({ pid: 1, appVersion: '0.75.0', aliveAtMs: T0 - 1000 }));
    assert.deepEqual(appAlive(dir, T0), { present: true, alive: true, appVersion: '0.75.0', aliveAtMs: T0 - 1000 });
    assert.equal(appAlive(dir, T0 + MARKER_STALE_MS).alive, false);
  });

  it('snapshotLocal merges roster and replicas, newest activity first', () => {
    const snap = snapshotLocal(dir, T0);
    assert.equal(snap.present, true);
    assert.deepEqual(snap.bots.map((b) => b.agentId), ['agent-c', 'agent-a', 'agent-b', 'agent-broken']);
    const a = snap.bots.find((b) => b.agentId === 'agent-a');
    assert.equal(a.name, 'Research Bot');
    assert.equal(a.lastEntryAt, T0 - 500);
    assert.ok(a.lastReplyPreview.startsWith('Reply with spaces'));
    assert.ok(!JSON.stringify(snap).includes('SECRET'));
    assert.deepEqual(snapshotLocal(path.join(dir, 'nope'), T0), { present: false, dir: path.join(dir, 'nope'), app: { present: false, alive: false }, bots: [] });
  });
});

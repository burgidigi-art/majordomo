// Tests for lib/inference-hooks.mjs: Standard Webhooks verification and the streaming receiver.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  ALLOW_VERDICT,
  ReplayCache,
  createInferenceHookHandler,
  decodeSecret,
  extractSummary,
  isPlausibleSecret,
  scanEnvelope,
  signFrame,
  summarizeFrame,
  verifySignature,
} from '../lib/inference-hooks.mjs';

const SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const OTHER = `whsec_${Buffer.from('fedcba9876543210fedcba9876543210').toString('base64')}`;
const NOW_SEC = 1_763_164_800;

const frame = (over = {}) => ({
  type: 'prompt',
  request_id: 'req_1',
  tenant_id: 'team_1',
  actor: { type: 'user', id: 'user_1', email_address: null },
  source: { application: 'grok-bot' },
  session_id: '3f2c9a71-58e4-4b0d-9c6a-0d1e7b25a4f8',
  model: 'sand-78zum5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'CANARY private conversation text' }] }],
  metadata: {},
  ...over,
});

describe('secrets and signatures', () => {
  it('decodes whsec_ secrets and bare base64, and rejects implausible ones', () => {
    assert.equal(decodeSecret(SECRET).toString(), '0123456789abcdef0123456789abcdef');
    assert.equal(decodeSecret(SECRET.slice(6)).toString(), '0123456789abcdef0123456789abcdef');
    assert.ok(isPlausibleSecret(SECRET));
    assert.equal(isPlausibleSecret('whsec_'), false);
    assert.equal(isPlausibleSecret('whsec_YWJj'), false);
    assert.equal(isPlausibleSecret(''), false);
  });

  it('verifies v1 signatures over id.timestamp.body, including non-ASCII bytes', () => {
    const body = Buffer.from('{"text":"héllo ✓"}', 'utf8');
    const signature = signFrame(SECRET, 'id1', String(NOW_SEC), body);
    assert.match(signature, /^v1,[A-Za-z0-9+/]+=*$/);
    assert.deepEqual(verifySignature({ id: 'id1', timestamp: String(NOW_SEC), signature, rawBody: body, secrets: [SECRET], nowSec: NOW_SEC }), { ok: true, reason: 'ok' });
  });

  it('rejects tampering, wrong secrets, missing headers and stale timestamps, with a reason', () => {
    const body = Buffer.from('{}');
    const ts = String(NOW_SEC);
    const signature = signFrame(SECRET, 'id1', ts, body);
    const check = (over) => verifySignature({ id: 'id1', timestamp: ts, signature, rawBody: body, secrets: [SECRET], nowSec: NOW_SEC, ...over }).reason;
    assert.equal(check({ rawBody: Buffer.from('{ }') }), 'signature-mismatch');
    assert.equal(check({ id: 'id2' }), 'signature-mismatch');
    assert.equal(check({ secrets: [OTHER] }), 'signature-mismatch');
    assert.equal(check({ secrets: [] }), 'no-secrets-configured');
    assert.equal(check({ signature: '' }), 'missing-headers');
    assert.equal(check({ signature: 'v2,abc' }), 'no-v1-signature');
    assert.equal(check({ timestamp: 'soon' }), 'bad-timestamp');
    assert.equal(check({ nowSec: NOW_SEC + 301 }), 'timestamp-out-of-tolerance');
    assert.equal(check({ nowSec: NOW_SEC - 301 }), 'timestamp-out-of-tolerance');
    assert.equal(check({ nowSec: NOW_SEC + 299 }), 'ok');
  });

  it('accepts any configured secret, so a rotation keeps verifying', () => {
    const body = Buffer.from('{}');
    const signature = signFrame(OTHER, 'id1', String(NOW_SEC), body);
    assert.equal(verifySignature({ id: 'id1', timestamp: String(NOW_SEC), signature, rawBody: body, secrets: [SECRET, 'junk', OTHER], nowSec: NOW_SEC }).ok, true);
  });

  it('ReplayCache remembers ids up to its size', () => {
    const cache = new ReplayCache(2);
    assert.equal(cache.add('a'), true);
    assert.equal(cache.add('a'), false);
    cache.add('b');
    cache.add('c');
    assert.equal(cache.has('a'), false);
    assert.equal(cache.has('c'), true);
  });
});

describe('frame summaries', () => {
  it('summarizeFrame keeps identifiers only', () => {
    const s = summarizeFrame(frame(), 5, 123);
    assert.deepEqual(s, { at: 5, requestId: 'req_1', type: 'prompt', sessionId: '3f2c9a71-58e4-4b0d-9c6a-0d1e7b25a4f8', model: 'sand-78zum5', actorId: 'user_1', tenantId: 'team_1', application: 'grok-bot', messageCount: 1, bytes: 123, isTest: false });
    assert.ok(!JSON.stringify(s).includes('CANARY'));
    assert.equal(summarizeFrame(frame({ source: { application: 'config-test' }, model: undefined, session_id: undefined })).isTest, true);
    assert.equal(summarizeFrame(null), null);
  });

  it('scanEnvelope finds the identifiers in the head of a frame without parsing it', () => {
    const text = JSON.stringify(frame({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }] }));
    const s = scanEnvelope(Buffer.from(text.slice(0, 2000)), 9, 10_000_000);
    assert.equal(s.requestId, 'req_1');
    assert.equal(s.model, 'sand-78zum5');
    assert.equal(s.sessionId, '3f2c9a71-58e4-4b0d-9c6a-0d1e7b25a4f8');
    assert.equal(s.actorId, 'user_1');
    assert.equal(s.application, 'grok-bot');
    assert.equal(s.bytes, 10_000_000);
    assert.equal(scanEnvelope(Buffer.from('not json at all')), null);
  });

  it('extractSummary parses whole frames and scans truncated ones', () => {
    const whole = Buffer.from(JSON.stringify(frame()));
    assert.equal(extractSummary(whole, whole.length, 1).messageCount, 1);
    const cut = whole.subarray(0, whole.length - 20);
    const scanned = extractSummary(cut, whole.length, 1);
    assert.equal(scanned.model, 'sand-78zum5');
    assert.equal(scanned.messageCount, null);
  });
});

describe('the receiver', () => {
  const frames = [];
  const rejected = [];
  let nowMs = NOW_SEC * 1000;
  const handler = createInferenceHookHandler({ secrets: () => [SECRET], onFrame: (s) => frames.push(s), onRejected: (r) => rejected.push(r), now: () => nowMs });
  const server = http.createServer((req, res) => handler(req, res));
  const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());

  async function post(body, { id = 'req_1', ts = String(NOW_SEC), signature } = {}) {
    await ready;
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signature ?? signFrame(SECRET, id, ts, raw) },
      body: raw,
    });
    const text = await res.text();
    await new Promise((r) => setTimeout(r, 10));
    return { status: res.status, text };
  }

  it('always answers allow, records a genuine frame once, and never keeps the conversation', async () => {
    const first = await post(frame(), { id: 'req_a' });
    assert.deepEqual(first, { status: 200, text: ALLOW_VERDICT });
    assert.equal(frames.length, 1);
    assert.equal(frames[0].model, 'sand-78zum5');
    assert.equal(frames[0].skewSec, 0);
    assert.ok(!JSON.stringify(frames).includes('CANARY'));
    await post(frame(), { id: 'req_a' }); // Cursor's single retry
    assert.equal(frames.length, 1, 'a repeated webhook-id is not counted twice');
  });

  it('answers allow to a forged frame but drops it, and a forgery cannot block the real id later', async () => {
    const forged = await post(frame({ model: 'fake-model' }), { id: 'req_b', signature: 'v1,AAAA' });
    assert.deepEqual(forged, { status: 200, text: ALLOW_VERDICT });
    assert.equal(rejected.at(-1), 'signature-mismatch');
    assert.equal(frames.length, 1);
    await post(frame({ request_id: 'req_b' }), { id: 'req_b' });
    assert.equal(frames.length, 2, 'the replay cache only learns ids from verified frames');
  });

  it('verifies frames larger than the parse buffer by streaming the HMAC, and still finds the model', async () => {
    const big = frame({ request_id: 'req_big', messages: [{ role: 'user', content: [{ type: 'text', text: 'y'.repeat(9 * 1024 * 1024) }] }] });
    const got = await post(big, { id: 'req_big' });
    assert.equal(got.status, 200);
    const summary = frames.at(-1);
    assert.equal(summary.requestId, 'req_big');
    assert.equal(summary.model, 'sand-78zum5');
    assert.ok(summary.bytes > 9 * 1024 * 1024);
  });

  it('counts config-test frames as tests and tolerates junk bodies', async () => {
    await post(frame({ request_id: 'req_t', source: { application: 'config-test' } }), { id: 'req_t' });
    assert.equal(frames.at(-1).isTest, true);
    const before = frames.length;
    const junk = await post('this is not json', { id: 'req_j' });
    assert.equal(junk.status, 200);
    assert.equal(frames.length, before);
    assert.equal(rejected.at(-1), 'unparseable-frame');
  });

  it('rejects stale timestamps', async () => {
    const ts = String(NOW_SEC - 1000);
    await post(frame(), { id: 'req_old', ts });
    assert.equal(rejected.at(-1), 'timestamp-out-of-tolerance');
  });
});

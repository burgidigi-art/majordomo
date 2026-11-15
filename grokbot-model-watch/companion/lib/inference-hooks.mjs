// Receiving Cursor's Grok Bot inference-hook frames (Enterprise teams).
//
// Cursor POSTs one signed frame per governed model request. The frame carries the Cursor
// model identifier that is about to serve the request, an opaque id for the Bot, and the
// whole conversation so far. We verify the Standard Webhooks signature while the body
// streams past (frames can be tens of megabytes, and the HMAC covers all of it), answer
// `allow` as soon as the body has been read, keep only identifiers, and discard the
// conversation. Run Cursor's hook with Enforce Verdicts on, Mode = Shadow Mode and
// "Validate Tool Calls" off for pure observation.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_SEC = 300;
/** The receiver keeps at most this much of a frame for parsing; the HMAC still covers everything. */
export const MAX_PARSE_BYTES = 8 * 1024 * 1024;
/** Frames above this size are drained and acknowledged without verification. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** The envelope fields precede `messages`, so this much is enough for the fast path. */
const ENVELOPE_SCAN_BYTES = 64 * 1024;

/** The raw key bytes of a `whsec_...` secret (a bare base64 string is accepted too). */
export function decodeSecret(secret) {
  const text = String(secret || '').trim();
  const encoded = text.startsWith('whsec_') ? text.slice('whsec_'.length) : text;
  if (!encoded) throw new Error('Empty signing secret');
  return Buffer.from(encoded, 'base64');
}

export function isPlausibleSecret(secret) {
  try {
    return decodeSecret(secret).length >= 16;
  } catch {
    return false;
  }
}

function signedPrefix(id, timestamp) {
  return Buffer.from(`${id}.${timestamp}.`, 'utf8');
}

/** Produce the header value Cursor would send; used by tests and the hook-test command. */
export function signFrame(secret, id, timestamp, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return `v1,${createHmac('sha256', decodeSecret(secret)).update(signedPrefix(id, timestamp)).update(body).digest('base64')}`;
}

function parseSignatureHeader(signature) {
  return String(signature || '')
    .split(/\s+/)
    .filter((part) => part.startsWith('v1,'))
    .map((part) => Buffer.from(part.slice(3), 'utf8'));
}

function timestampOk(timestamp, nowSec, toleranceSec) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return 'bad-timestamp';
  if (Math.abs(nowSec - ts) > toleranceSec) return 'timestamp-out-of-tolerance';
  return null;
}

/** Compare the provided `v1,` signatures against already-computed base64 digests. */
export function verifyDigests({ id, timestamp, signature, digests, nowSec = Math.floor(Date.now() / 1000), toleranceSec = SIGNATURE_TOLERANCE_SEC }) {
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing-headers' };
  const tsProblem = timestampOk(timestamp, nowSec, toleranceSec);
  if (tsProblem) return { ok: false, reason: tsProblem };
  const provided = parseSignatureHeader(signature);
  if (!provided.length) return { ok: false, reason: 'no-v1-signature' };
  if (!digests.length) return { ok: false, reason: 'no-secrets-configured' };
  for (const digest of digests) {
    const expected = Buffer.from(digest, 'utf8');
    for (const candidate of provided) {
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return { ok: true, reason: 'ok' };
    }
  }
  return { ok: false, reason: 'signature-mismatch' };
}

/**
 * Verify `webhook-signature` for a body held in memory, against every configured secret
 * (so a rotation keeps working). Returns `{ ok, reason }`.
 */
export function verifySignature({ id, timestamp, signature, rawBody, secrets, nowSec = Math.floor(Date.now() / 1000), toleranceSec = SIGNATURE_TOLERANCE_SEC }) {
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing-headers' };
  const tsProblem = timestampOk(timestamp, nowSec, toleranceSec);
  if (tsProblem) return { ok: false, reason: tsProblem };
  const usable = (secrets || []).filter(isPlausibleSecret);
  if (!usable.length) return { ok: false, reason: 'no-secrets-configured' };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const digests = usable.map((secret) => createHmac('sha256', decodeSecret(secret)).update(signedPrefix(id, timestamp)).update(body).digest('base64'));
  return verifyDigests({ id, timestamp, signature, digests, nowSec, toleranceSec });
}

/** Remember recent webhook ids so Cursor's single retry is not counted twice. */
export class ReplayCache {
  constructor(max = 10_000) {
    this.max = max;
    this.ids = new Set();
    this.order = [];
  }
  has(id) {
    return this.ids.has(id);
  }
  add(id) {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > this.max) this.ids.delete(this.order.shift());
    return true;
  }
}

const str = (v) => (typeof v === 'string' && v ? v : null);

/** The identifiers we keep from a parsed frame. Conversation content is dropped here and never stored. */
export function summarizeFrame(frame, at = Date.now(), bytes = 0) {
  if (!frame || typeof frame !== 'object') return null;
  const source = frame.source && typeof frame.source === 'object' ? frame.source : {};
  const actor = frame.actor && typeof frame.actor === 'object' ? frame.actor : {};
  const messages = Array.isArray(frame.messages) ? frame.messages : [];
  return {
    at,
    requestId: str(frame.request_id),
    type: str(frame.type) || 'prompt',
    sessionId: str(frame.session_id),
    model: str(frame.model),
    actorId: str(actor.id),
    tenantId: str(frame.tenant_id),
    application: str(source.application) || 'unknown',
    messageCount: messages.length,
    bytes,
    isTest: source.application === 'config-test',
  };
}

/**
 * Pull the envelope out of the first part of a frame without parsing the whole document.
 * Cursor writes the envelope fields before `messages`, so a bounded scan finds them.
 */
export function scanEnvelope(buffer, at = Date.now(), bytes = buffer.length) {
  const head = buffer.subarray(0, ENVELOPE_SCAN_BYTES).toString('utf8');
  const pick = (re) => {
    const m = re.exec(head);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  };
  const requestId = pick(/"request_id"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const type = pick(/"type"\s*:\s*"(prompt|tool_call)"/);
  const sessionId = pick(/"session_id"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const model = pick(/"model"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const application = pick(/"source"\s*:\s*\{\s*"application"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const actorId = pick(/"actor"\s*:\s*\{[^{}]*?"id"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const tenantId = pick(/"tenant_id"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!requestId && !sessionId && !model) return null;
  return { at, requestId, type: type || 'prompt', sessionId, model, actorId, tenantId, application: application || 'unknown', messageCount: null, bytes, isTest: application === 'config-test' };
}

/** Summary from the retained part of a frame: full parse when it fits, envelope scan otherwise. */
export function extractSummary(buffer, totalBytes, at = Date.now()) {
  if (buffer.length === totalBytes) {
    try {
      const summary = summarizeFrame(JSON.parse(buffer.toString('utf8')), at, totalBytes);
      if (summary) return summary;
    } catch {
      // fall through to the envelope scan
    }
  }
  return scanEnvelope(buffer, at, totalBytes);
}

export const ALLOW_VERDICT = JSON.stringify({ action: 'allow' });

function respondAllow(res) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(ALLOW_VERDICT)) });
  res.end(ALLOW_VERDICT);
}

/**
 * Build the request handler for `POST /hooks/inference`. It reads the request stream itself.
 *
 * The HMAC is computed chunk by chunk for every configured secret, so verification does not
 * depend on buffering the frame; only the first MAX_PARSE_BYTES are kept for parsing. The
 * verdict is `allow` in every case, so the hook can never slow down or block a team's Bots;
 * frames that fail verification are reported through `onRejected(reason)` and dropped.
 */
export function createInferenceHookHandler({ secrets, onFrame, onRejected = () => {}, replay = new ReplayCache(), now = Date.now, maxInFlight = 8, maxFrameBytes = MAX_FRAME_BYTES }) {
  let inFlight = 0;
  return function handle(req, res) {
    const id = req.headers['webhook-id'];
    const timestamp = req.headers['webhook-timestamp'];
    const signature = req.headers['webhook-signature'];
    const configured = (typeof secrets === 'function' ? secrets() : secrets || []).filter(isPlausibleSecret);
    if (inFlight >= maxInFlight) {
      req.resume();
      req.on('end', () => respondAllow(res));
      req.on('error', () => respondAllow(res));
      onRejected('dropped-overload');
      return;
    }
    inFlight += 1;
    const prefix = signedPrefix(String(id || ''), String(timestamp || ''));
    const hmacs = configured.map((secret) => createHmac('sha256', decodeSecret(secret)).update(prefix));
    const kept = [];
    let keptBytes = 0;
    let total = 0;
    let oversized = false;
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      inFlight -= 1;
      fn();
    };
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxFrameBytes) {
        oversized = true;
        return;
      }
      for (const h of hmacs) h.update(chunk);
      if (keptBytes < MAX_PARSE_BYTES) {
        kept.push(chunk);
        keptBytes += chunk.length;
      }
    });
    req.on('error', () =>
      finish(() => {
        respondAllow(res);
        onRejected('request-error');
      }),
    );
    req.on('end', () =>
      finish(() => {
        respondAllow(res);
        if (oversized) {
          onRejected('frame-too-large');
          return;
        }
        const nowMs = now();
        const verdict = verifyDigests({ id, timestamp, signature, digests: hmacs.map((h) => h.digest('base64')), nowSec: Math.floor(nowMs / 1000) });
        if (!verdict.ok) {
          onRejected(verdict.reason);
          return;
        }
        if (id && !replay.add(String(id))) return;
        const summary = extractSummary(Buffer.concat(kept), total, nowMs);
        if (!summary) {
          onRejected('unparseable-frame');
          return;
        }
        summary.skewSec = Number(timestamp) - Math.floor(nowMs / 1000);
        onFrame(summary);
      }),
    );
  };
}

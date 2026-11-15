// The HTTP face of the companion: the dashboard page, a JSON snapshot, a live event
// stream, the inference-hook receiver and the MCP endpoint.
//
// Access rules:
//  - A request is "local" only when it arrives from a loopback address AND names a loopback
//    host in its Host header (that second check defeats DNS rebinding). Local GET requests
//    for the page, the snapshot and the stream need no token.
//  - Everything else needs the bearer token: every POST (including the self-report, even
//    locally), every /mcp call, and all remote reads. Remote GETs may carry the token as
//    `?token=` because a browser cannot add headers to a page load or an EventSource.
//  - A browser Origin that is neither local nor the configured public URL is refused.
//  - The hook endpoint authenticates frames by signature and always answers "allow".

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInferenceHookHandler } from './inference-hooks.mjs';
import { bearerOk, constantTimeEqual, createMcpHandler } from './mcp.mjs';
import { VERSION } from './watch.mjs';

const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const BODY_LIMIT = 1024 * 1024;
const SELF_REPORT_LIMIT = 16 * 1024;
const STATE_PUSH_MS = 5_000;
const HEARTBEAT_MS = 25_000;
const MAX_SSE_CLIENTS = 20;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function hostOf(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
}

export function isLoopbackRequest(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (!addr || !LOOPBACK_ADDRESSES.has(addr)) return false;
  return LOCAL_HOSTS.has(hostOf(req.headers.host));
}

/** A browser Origin is acceptable when it is local or the configured public URL. */
export function originAllowed(req, publicUrl) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (LOCAL_HOSTS.has(host)) return true;
  if (publicUrl) {
    try {
      if (new URL(publicUrl).hostname.toLowerCase() === host) return true;
    } catch {
      // an unparsable public URL allows nothing extra
    }
  }
  return false;
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(Object.assign(new Error('Payload too large'), { status: 413 }));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Keep draining (and discarding) so the 413 can be delivered; the caller closes the socket.
        chunks.length = 0;
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
  res.end(text);
}

/** Hash the page's inline scripts so the CSP can allow exactly them and nothing else. */
export function pageSecurityHeaders(html) {
  const hashes = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) hashes.push(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  const scriptSrc = hashes.length ? hashes.join(' ') : "'none'";
  return {
    'content-security-policy': `default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cache-control': 'no-store',
  };
}

/**
 * @param {object} opts
 * @param {import('./watch.mjs').Watch} opts.watch
 * @param {object} opts.settings
 */
export function createServer({ watch, settings, log = () => {}, uiFile = UI_FILE, now = Date.now }) {
  const token = () => settings.mcpToken;
  const mcp = createMcpHandler({
    tools: watch.mcpTools(),
    token,
    serverInfo: { name: 'grokbot-model-watch', version: VERSION },
    instructions: 'Tools that report what is known about the model behind each Grok Bot, with an evidence grade. Pass your own Bot name as `bot`; with no name the one Bot working right now is assumed.',
  });
  const hooks = createInferenceHookHandler({
    secrets: () => settings.hookSecrets,
    onFrame: (summary) => watch.recordHookFrame(summary),
    onRejected: (reason) => watch.recordHookRejected(reason),
    now,
  });

  let page = { mtimeMs: -1, html: null, headers: null };
  const loadPage = () => {
    const stat = fs.statSync(uiFile);
    if (stat.mtimeMs !== page.mtimeMs) {
      const html = fs.readFileSync(uiFile);
      page = { mtimeMs: stat.mtimeMs, html, headers: pageSecurityHeaders(html.toString('utf8')) };
    }
    return page;
  };

  const clients = new Set();
  const sendEvent = (res, event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const unsubscribe = watch.store.subscribe((item) => {
    for (const res of clients) sendEvent(res, 'evidence', item);
  });
  const pushTimer = setInterval(() => {
    if (!clients.size) return;
    const state = watch.state();
    for (const res of clients) sendEvent(res, 'state', state);
  }, STATE_PUSH_MS);
  pushTimer.unref();
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const queryToken = (url) => {
    const t = url.searchParams.get('token');
    return Boolean(t && settings.mcpToken && constantTimeEqual(t, settings.mcpToken));
  };
  /** Read access: local, or the token in a header, or (GET only) the token in the query string. */
  const canRead = (req, url) => isLoopbackRequest(req) || bearerOk(req, token()) || (req.method === 'GET' && queryToken(url));
  /** Write access: always the token in the Authorization header. */
  const canWrite = (req) => bearerOk(req, token());

  const server = http.createServer(async (req, res) => {
    // A base URL with a trailing slash yields '//mcp'; collapse it before parsing, or it reads as a host.
    const url = new URL(String(req.url).replace(/^\/{2,}/, '/'), 'http://x');
    const route = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    try {
      if (route === '/hooks/inference') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' }, { allow: 'POST' });
        return hooks(req, res);
      }
      if (route === '/healthz') {
        return json(res, 200, { ok: true, version: VERSION, mode: watch.mode });
      }
      if (!originAllowed(req, settings.publicUrl)) {
        return json(res, 403, { error: 'Origin not allowed' });
      }
      if (route === '/mcp') {
        const body = req.method === 'POST' ? await readBody(req, BODY_LIMIT) : Buffer.alloc(0);
        return mcp(req, res, body);
      }
      if (route === '/api/hook-report') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' }, { allow: 'POST' });
        // The plugin's reporting hook holds a write-only token; the main token works too.
        if (!bearerOk(req, settings.reportToken) && !canWrite(req)) return json(res, 401, { error: 'A report token is required.' }, { 'www-authenticate': 'Bearer' });
        const body = await readBody(req, SELF_REPORT_LIMIT);
        let payload;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          return json(res, 400, { error: 'Invalid JSON' });
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(res, 400, { error: 'Expected a JSON object' });
        try {
          watch.recordPluginHook(payload);
          return json(res, 200, { ok: true });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (route === '/api/self-report') {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' }, { allow: 'POST' });
        if (!canWrite(req)) return json(res, 401, { error: 'A bearer token is required (grokbot-model-watch token).' }, { 'www-authenticate': 'Bearer' });
        const body = await readBody(req, SELF_REPORT_LIMIT);
        let payload;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          return json(res, 400, { error: 'Invalid JSON' });
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(res, 400, { error: 'Expected a JSON object' });
        try {
          const item = watch.recordSelfReport({ ...payload, via: 'api' });
          return json(res, 200, { ok: true, item: watch.publicItem(item) });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (!canRead(req, url)) {
        return json(res, 401, { error: 'Unauthorized. Off localhost, use the bearer token (grokbot-model-watch token).' }, { 'www-authenticate': 'Bearer' });
      }
      if (route === '/' || route === '/index.html') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' });
        let current;
        try {
          current = loadPage();
        } catch {
          return json(res, 500, { error: 'ui/index.html is missing' });
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(current.html.length), ...current.headers });
        return res.end(req.method === 'HEAD' ? undefined : current.html);
      }
      if (route === '/api/state') {
        if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
        return json(res, 200, watch.state());
      }
      if (route === '/events') {
        if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
        if (clients.size >= MAX_SSE_CLIENTS) return json(res, 503, { error: 'Too many live viewers' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
        res.write(': connected\nretry: 3000\n\n');
        sendEvent(res, 'state', watch.state());
        clients.add(res);
        watch.setClientsConnected(clients.size);
        req.on('close', () => {
          clients.delete(res);
          watch.setClientsConnected(clients.size);
        });
        return undefined;
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err && err.status === 413 ? 413 : 500;
      log(`request error on ${route}: ${err && err.message ? err.message : err}`);
      if (!res.headersSent) {
        res.once('finish', () => {
          if (status === 413 && req.socket) req.socket.destroy();
        });
        json(res, status, { error: status === 413 ? 'Payload too large' : 'Internal error' }, status === 413 ? { connection: 'close' } : {});
      } else res.end();
      return undefined;
    }
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 180_000;

  server.on('close', () => {
    unsubscribe();
    clearInterval(pushTimer);
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
  });
  return server;
}

export function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

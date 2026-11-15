// Tests for lib/server.mjs: routes and, above all, who may reach what.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadSettings } from '../lib/config.mjs';
import { DemoClient } from '../lib/demo.mjs';
import { signFrame } from '../lib/inference-hooks.mjs';
import { createServer, isLoopbackRequest, listen, originAllowed, pageSecurityHeaders } from '../lib/server.mjs';
import { Watch } from '../lib/watch.mjs';

const SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-server-'));
let server;
let port;
let watch;
let settings;

before(async () => {
  settings = loadSettings(home);
  settings.hookSecrets = [SECRET];
  settings.publicUrl = 'https://watch.example.com';
  watch = new Watch({ settings, client: new DemoClient(), mode: 'demo', localDir: path.join(home, 'no-app'), schedule: () => ({ unref() {} }), cancel: () => {} });
  await watch.pollAgents();
  await watch.pollStatuses();
  server = createServer({ watch, settings });
  port = (await listen(server, { host: '127.0.0.1', port: 0 })).port;
});
after(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A raw request, so the Host and Origin headers can be set freely. */
function request(pathname, { method = 'GET', headers = {}, body = null, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
const bearer = () => ({ authorization: `Bearer ${settings.mcpToken}` });

describe('helpers', () => {
  it('a request is local only from a loopback address naming a loopback host', () => {
    const req = (addr, host) => ({ socket: { remoteAddress: addr }, headers: { host } });
    assert.ok(isLoopbackRequest(req('127.0.0.1', 'localhost:4319')));
    assert.ok(isLoopbackRequest(req('::1', '[::1]:4319')));
    assert.ok(isLoopbackRequest(req('::ffff:127.0.0.1', '127.0.0.1')));
    assert.equal(isLoopbackRequest(req('127.0.0.1', 'attacker.example:4319')), false, 'DNS rebinding');
    assert.equal(isLoopbackRequest(req('127.0.0.1', 'watch.example.com')), false, 'a reverse proxy on the same machine');
    assert.equal(isLoopbackRequest(req('203.0.113.9', 'localhost')), false);
  });

  it('browser origins must be local or the public URL', () => {
    const req = (origin) => ({ headers: origin === undefined ? {} : { origin } });
    assert.ok(originAllowed(req(undefined), ''));
    assert.ok(originAllowed(req('http://localhost:4319'), ''));
    assert.ok(originAllowed(req('https://watch.example.com'), 'https://watch.example.com'));
    assert.equal(originAllowed(req('https://evil.example'), 'https://watch.example.com'), false);
    assert.equal(originAllowed(req('not a url'), ''), false);
  });

  it('the page CSP allows exactly the inline scripts by hash, with no unsafe-inline for scripts', () => {
    const headers = pageSecurityHeaders('<script>a()</script><p></p><script src="x.js"></script><script>b()</script>');
    const csp = headers['content-security-policy'];
    assert.equal((csp.match(/'sha256-/g) || []).length, 2);
    assert.doesNotMatch(csp.split(';').find((d) => d.trim().startsWith('script-src')), /unsafe-inline/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(pageSecurityHeaders('<p>no scripts</p>')['content-security-policy'], /script-src 'none'/);
  });
});

describe('local reads', () => {
  it('healthz is open and says nothing sensitive', async () => {
    const res = await request('/healthz', { host: 'anything.example' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['mode', 'ok', 'version']);
  });

  it('serves the dashboard with a hash-based CSP and the state snapshot', async () => {
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.headers['content-security-policy'], /script-src 'sha256-/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.match(page.text, /Grok Bot Model Watch/);
    const state = await request('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.json.mode, 'demo');
    assert.equal(state.json.bots.length, 3);
    assert.equal(state.headers['cache-control'], 'no-store');
    assert.equal((await request('/nope')).status, 404);
    assert.equal((await request('/api/state', { method: 'POST' })).status, 405);
  });

  it('the dashboard source never uses HTML-injection sinks', () => {
    const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
    const code = html.replace(/\/\/[^\n]*/g, '');
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(']) assert.ok(!code.includes(sink), sink);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=["']https?:|@import/);
  });

  it('streams state first and evidence as it is recorded', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (needle) => {
      while (!buffer.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    };
    await readUntil('event: state');
    watch.store.add({ at: Date.now(), grade: 'B', source: 'test', bot: null, attribution: 'none', candidates: [], label: 'grok-bot-default', classified: { opaque: true } });
    await readUntil('event: evidence');
    assert.match(buffer, /event: evidence\ndata: \{"id":\d+/);
    await reader.cancel();
  });
});

describe('remote access needs the token', () => {
  it('a foreign Host is refused without the token and accepted with it', async () => {
    for (const route of ['/', '/api/state', '/events']) {
      assert.equal((await request(route, { host: 'watch.example.com' })).status, 401, route);
    }
    assert.equal((await request('/api/state', { host: 'watch.example.com', headers: bearer() })).status, 200);
    assert.equal((await request(`/api/state?token=${settings.mcpToken}`, { host: 'watch.example.com' })).status, 200);
    assert.equal((await request('/?token=wrong', { host: 'watch.example.com' })).status, 401);
  });

  it('a foreign browser Origin is refused even on localhost', async () => {
    assert.equal((await request('/api/state', { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/mcp', { method: 'POST', headers: { origin: 'https://evil.example', ...bearer(), 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await request('/api/state', { headers: { origin: `http://localhost:${port}` } })).status, 200);
  });

  it('writes always need the bearer header, even locally, and never accept the query token', async () => {
    const body = JSON.stringify({ bot: 'Inbox Bot', claimedFamily: 'xAI Grok', raw: '<img src=x onerror=alert(1)>' });
    assert.equal((await request('/api/self-report', { method: 'POST', body })).status, 401);
    assert.equal((await request(`/api/self-report?token=${settings.mcpToken}`, { method: 'POST', body })).status, 401);
    assert.equal((await request('/api/self-report', { method: 'POST', body, headers: { authorization: `Bearer ${settings.reportToken}` } })).status, 401, 'the report token cannot self-report');
    const ok = await request('/api/self-report', { method: 'POST', body, headers: bearer() });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.item.grade, 'C');
    assert.equal(ok.json.item.extra.raw, undefined);
    assert.equal((await request('/api/self-report', { method: 'POST', body: JSON.stringify({ bot: 'nobody', claimedFamily: 'x' }), headers: bearer() })).status, 400);
    assert.equal((await request('/api/self-report', { method: 'POST', body: 'not json', headers: bearer() })).status, 400);
    assert.equal((await request('/api/self-report', { method: 'POST', body: 'x'.repeat(20 * 1024), headers: bearer() })).status, 413);
  });

  it('the plugin hook report accepts the write-only report token, which opens nothing else', async () => {
    const report = JSON.stringify({ event: 'stop', model: 'grok-bot-default', conversationId: 'c1', generationId: 'g1' });
    assert.equal((await request('/api/hook-report', { method: 'POST', body: report })).status, 401);
    const ok = await request('/api/hook-report', { method: 'POST', body: report, headers: { authorization: `Bearer ${settings.reportToken}` } });
    assert.deepEqual(ok.json, { ok: true });
    assert.equal(watch.store.items().filter((e) => e.grade === 'H').length, 1);
    assert.equal((await request('/api/hook-report', { method: 'POST', body: '{}', headers: bearer() })).status, 400);
    assert.equal((await request('/api/state', { host: 'watch.example.com', headers: { authorization: `Bearer ${settings.reportToken}` } })).status, 401);
    assert.equal((await request('/mcp', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${settings.reportToken}` } })).status, 401);
  });

  it('MCP works with the token and collapses doubled slashes from a trailing-slash URL', async () => {
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal((await request('/mcp', { method: 'POST', body: init })).status, 401);
    const res = await request('//mcp', { method: 'POST', body: init, headers: { ...bearer(), 'content-type': 'application/json' }, host: 'watch.example.com' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.result.tools.map((t) => t.name), ['model_watch_status', 'model_watch_recent', 'model_watch_report_self_identification', 'model_watch_explain']);
  });
});

describe('the hook endpoint', () => {
  it('answers allow to anyone, records only signed frames, and is POST-only', async () => {
    const frame = JSON.stringify({ type: 'prompt', request_id: 'req_srv', session_id: 's-1', model: 'sand-abc', source: { application: 'grok-bot' }, actor: { id: 'u' }, messages: [] });
    const ts = String(Math.floor(Date.now() / 1000));
    const before = watch.hookStats.frames;
    const forged = await request('/hooks/inference', { method: 'POST', body: frame, host: 'watch.example.com', headers: { 'webhook-id': 'req_srv', 'webhook-timestamp': ts, 'webhook-signature': 'v1,Zm9v' } });
    assert.deepEqual(forged.json, { action: 'allow' });
    const signed = await request('/hooks/inference', { method: 'POST', body: frame, host: 'watch.example.com', headers: { 'webhook-id': 'req_srv', 'webhook-timestamp': ts, 'webhook-signature': signFrame(SECRET, 'req_srv', ts, frame) } });
    assert.deepEqual(signed.json, { action: 'allow' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(watch.hookStats.frames, before + 1);
    assert.equal(watch.hookStats.rejected['signature-mismatch'], 1);
    assert.equal((await request('/hooks/inference')).status, 405);
  });
});

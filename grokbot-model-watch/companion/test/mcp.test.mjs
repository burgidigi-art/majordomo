// Tests for lib/mcp.mjs: the minimal Streamable HTTP MCP server.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bearerOk, constantTimeEqual, createMcpHandler, textResult } from '../lib/mcp.mjs';

const TOKEN = 'secret-token';
const tools = [
  { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, run: (args) => textResult(`you said ${args.text}`, { text: args.text }) },
  { name: 'boom', description: 'Throws', inputSchema: { type: 'object', properties: {} }, run: () => { throw new Error('kaput'); } },
];
const handler = createMcpHandler({ tools, token: () => TOKEN, serverInfo: { name: 'test', version: '1' }, instructions: 'hi' });
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  await handler(req, res, Buffer.concat(chunks));
});
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());

async function call(body, { method = 'POST', token = TOKEN, raw = false } = {}) {
  await ready;
  const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

describe('auth helpers', () => {
  it('compare in constant time and need a Bearer header', () => {
    assert.ok(constantTimeEqual('abc', 'abc'));
    assert.equal(constantTimeEqual('abc', 'abd'), false);
    assert.equal(constantTimeEqual('abc', 'abcd'), false);
    assert.ok(bearerOk({ headers: { authorization: 'Bearer t' } }, 't'));
    assert.ok(bearerOk({ headers: { authorization: 'bearer   t ' } }, 't'));
    assert.equal(bearerOk({ headers: { authorization: 'Basic t' } }, 't'), false);
    assert.equal(bearerOk({ headers: {} }, 't'), false);
    assert.equal(bearerOk({ headers: { authorization: 'Bearer ' } }, ''), false);
  });
});

describe('the MCP endpoint', () => {
  it('refuses requests without the token, for every method', async () => {
    for (const method of ['POST', 'GET', 'DELETE']) {
      const res = await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { method, token: null });
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate'), /^Bearer/);
    }
    assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: 'wrong' })).status, 401);
  });

  it('GET is 405 and DELETE is 200 with the token', async () => {
    const get = await call(null, { method: 'GET' });
    assert.equal(get.status, 405);
    assert.match(get.headers.get('allow'), /POST/);
    assert.equal((await call(null, { method: 'DELETE' })).status, 200);
  });

  it('initialize echoes a supported protocol version, falls back to the newest, and issues a session id', async () => {
    const a = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.equal(a.body.result.protocolVersion, '2024-11-05');
    assert.deepEqual(a.body.result.serverInfo, { name: 'test', version: '1' });
    assert.ok(a.body.result.capabilities.tools);
    assert.ok(a.headers.get('mcp-session-id'));
    const b = await call({ jsonrpc: '2.0', id: 'x', method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    assert.equal(b.body.result.protocolVersion, '2025-06-18');
    assert.equal(b.body.id, 'x');
  });

  it('a notification-only POST gets 202 with no body', async () => {
    const res = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(res.body, null);
  });

  it('lists and calls tools without a prior initialize (stateless)', async () => {
    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.body.result.tools.map((t) => t.name), ['echo', 'boom']);
    assert.equal(list.body.result.tools[0].inputSchema.type, 'object');
    assert.equal(list.body.result.tools[0].run, undefined);
    const echo = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } });
    assert.equal(echo.body.result.content[0].text, 'you said hi');
    assert.deepEqual(echo.body.result.structuredContent, { text: 'hi' });
  });

  it('a throwing tool is an isError result; an unknown tool or method is a JSON-RPC error', async () => {
    const boom = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom' } });
    assert.equal(boom.body.result.isError, true);
    assert.match(boom.body.result.content[0].text, /kaput/);
    assert.equal((await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } })).body.error.code, -32602);
    assert.equal((await call({ jsonrpc: '2.0', id: 6, method: 'resources/list' })).body.error.code, -32601);
    assert.deepEqual((await call({ jsonrpc: '2.0', id: 7, method: 'ping' })).body.result, {});
  });

  it('answers a batch with an array and bad input with parse or request errors', async () => {
    const batch = await call([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    assert.equal(batch.body.length, 2);
    assert.equal((await call('{not json', { raw: true })).body.error.code, -32700);
    assert.equal((await call({ id: 1, method: 'ping' })).body.error.code, -32600);
    assert.equal((await call([])).status, 400);
  });
});

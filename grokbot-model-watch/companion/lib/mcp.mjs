// A minimal Model Context Protocol server over Streamable HTTP, enough for a Bot (or any
// MCP client) to list and call tools. JSON-RPC 2.0 in a POST body, JSON out. No
// server-initiated streams, no resources, no prompts.

import { randomUUID, timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL = -32603;

export function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `Authorization: Bearer <token>` check. */
export function bearerOk(req, token) {
  if (!token) return false;
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return Boolean(match && constantTimeEqual(match[1].trim(), token));
}

function send(res, status, body, extraHeaders = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...extraHeaders });
  res.end(text);
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** A tool result in MCP shape, from plain text and an optional structured object. */
export function textResult(text, structured, isError = false) {
  const result = { content: [{ type: 'text', text }] };
  if (structured !== undefined) result.structuredContent = structured;
  if (isError) result.isError = true;
  return result;
}

/**
 * @param {object} opts
 * @param {Array<{name:string, description:string, inputSchema:object, run:(args:object)=>Promise<object>|object}>} opts.tools
 * @param {() => string} opts.token   current bearer token
 * @param {{name:string, version:string}} opts.serverInfo
 * @param {string} [opts.instructions]
 */
export function createMcpHandler({ tools, token, serverInfo, instructions = '' }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return rpcError(message && message.id, INVALID_REQUEST, 'Expected a JSON-RPC 2.0 message');
    }
    if (typeof message.method !== 'string') return null; // a response from the client; nothing to do
    const isNotification = message.id === undefined;
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    switch (message.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSIONS[0];
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        return rpcResult(message.id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo, instructions });
      }
      case 'ping':
        return isNotification ? null : rpcResult(message.id, {});
      case 'tools/list':
        return isNotification ? null : rpcResult(message.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        if (isNotification) return null;
        const tool = byName.get(params.name);
        if (!tool) return rpcError(message.id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        try {
          return rpcResult(message.id, await tool.run(args));
        } catch (err) {
          return rpcResult(message.id, textResult(`The tool failed: ${err && err.message ? err.message : String(err)}`, undefined, true));
        }
      }
      default:
        if (isNotification || message.method.startsWith('notifications/')) return null;
        return rpcError(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  }

  return async function handle(req, res, rawBody) {
    if (!bearerOk(req, token())) {
      send(res, 401, rpcError(null, INVALID_REQUEST, 'Unauthorized'), { 'www-authenticate': 'Bearer realm="grokbot-model-watch"' });
      return;
    }
    if (req.method === 'DELETE') {
      send(res, 200, {});
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, rpcError(null, INVALID_REQUEST, 'Use POST'), { allow: 'POST, DELETE' });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      send(res, 400, rpcError(null, PARSE_ERROR, 'Invalid JSON'));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (!messages.length) {
      send(res, 400, rpcError(null, INVALID_REQUEST, 'Empty batch'));
      return;
    }
    const responses = [];
    let sawInitialize = false;
    for (const message of messages) {
      if (message && message.method === 'initialize') sawInitialize = true;
      let reply;
      try {
        reply = await handleMessage(message);
      } catch (err) {
        reply = rpcError(message && message.id, INTERNAL, err && err.message ? err.message : 'Internal error');
      }
      if (reply) responses.push(reply);
    }
    const headers = sawInitialize ? { 'mcp-session-id': randomUUID() } : {};
    if (!responses.length) {
      res.writeHead(202, headers);
      res.end();
      return;
    }
    send(res, 200, Array.isArray(parsed) ? responses : responses[0], headers);
  };
}

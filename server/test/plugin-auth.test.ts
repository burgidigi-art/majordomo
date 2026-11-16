import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Host, ToolCtx } from '../tools/tool.ts';
import { tempHome } from './helpers.ts';

// Browser sign-in for plugins: discovery, app registration, the sign-in itself, renewal and sign-out,
// against a stand-in for a hosted plugin and its sign-in service.

process.env.MAJORDOMO_DEMO = '1';
const data = tempHome();
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'majordomo-auth-home-'));

// ----- the stand-in: a plugin at /mcp, and its sign-in service under /auth -----

const svc = {
  base: '',
  registered: [] as any[],
  codes: new Map<string, { challenge: string; redirect: string; client: string; resource: string }>(),
  valid: new Set<string>(),
  refreshWorks: true,
  issued: 0,
  tokenCalls: [] as URLSearchParams[],
  seenTokens: [] as string[],
};

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url!, svc.base);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/mcp') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      svc.seenTokens.push(token);
      if (!svc.valid.has(token)) {
        return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${svc.base}/.well-known/oauth-protected-resource/mcp", scope="read write"` });
      }
      const msg = JSON.parse(raw);
      if (msg.id === undefined) return res.writeHead(202).end();
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
          : msg.method === 'tools/list'
            ? { tools: [{ name: 'search_pages', description: 'Search pages', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
            : { content: [{ type: 'text', text: `pages about ${msg.params.arguments.query} (token ${token})` }] };
      return json(200, { jsonrpc: '2.0', id: msg.id, result });
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json(200, { resource: `${svc.base}/mcp`, authorization_servers: [`${svc.base}/auth`] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server/auth') {
      return json(200, {
        issuer: `${svc.base}/auth`,
        authorization_endpoint: `${svc.base}/auth/authorize`,
        token_endpoint: `${svc.base}/auth/token`,
        registration_endpoint: `${svc.base}/auth/register`,
      });
    }
    if (url.pathname === '/auth/register') {
      const body = JSON.parse(raw);
      svc.registered.push(body);
      return json(201, { client_id: `client-${svc.registered.length}` });
    }
    if (url.pathname === '/auth/authorize') {
      // The user approves; the service sends the browser back with a code.
      const p = url.searchParams;
      const code = `code-${svc.codes.size + 1}`;
      svc.codes.set(code, { challenge: p.get('code_challenge')!, redirect: p.get('redirect_uri')!, client: p.get('client_id')!, resource: p.get('resource')! });
      res.writeHead(302, { location: `${p.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(p.get('state')!)}` });
      return res.end();
    }
    if (url.pathname === '/auth/token') {
      const p = new URLSearchParams(raw);
      svc.tokenCalls.push(p);
      if (p.get('grant_type') === 'authorization_code') {
        const c = svc.codes.get(p.get('code')!);
        const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (!c || c.challenge !== challenge || c.redirect !== p.get('redirect_uri') || c.client !== p.get('client_id')) return json(400, { error: 'invalid_grant' });
        svc.codes.delete(p.get('code')!);
      } else if (p.get('grant_type') === 'refresh_token') {
        if (!svc.refreshWorks || p.get('refresh_token') !== 'refresh-1') return json(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
      }
      const token = `access-${++svc.issued}`;
      svc.valid.add(token);
      return json(200, { access_token: token, token_type: 'Bearer', refresh_token: 'refresh-1', expires_in: 3600 });
    }
    res.writeHead(404).end();
  });
});

let plugins: typeof import('../plugins.ts');
let auth: typeof import('../plugin-auth.ts');
let app: typeof import('../http.ts')['app'];
const local = { host: 'localhost:4317', origin: 'http://localhost:4317' };
const host: Host = { progress() {}, askManager: async () => '', delegate: async () => '', approve: async () => true };
const ctx = (): ToolCtx => ({ agentId: 'T-x', cwd: data, signal: new AbortController().signal, host });
let id = '';
const use = () => plugins.pluginTools().find((t) => t.name === 'use_plugin_tool')!.run({ plugin: 'docs', tool: 'search_pages', arguments: { query: 'launch' } }, ctx());

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  svc.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  plugins = await import('../plugins.ts');
  auth = await import('../plugin-auth.ts');
  app = (await import('../http.ts')).app;
  plugins.addOwnServer({ name: 'Docs', url: `${svc.base}/mcp` });
  id = plugins.pluginList(true).find((p) => p.name === 'Docs')!.id;
});
after(() => {
  plugins.closeAllPlugins();
  server.close();
});

test('a hosted plugin with no key is offered a browser sign-in, and says so until it has one', async () => {
  const p = plugins.pluginList().find((x) => x.id === id)!;
  assert.deepEqual([p.canSignIn, p.signedIn], [true, false]);
  await assert.rejects(use(), /needs the user to sign in.*Settings → Plugin tools.*Sign in/);
});

test('signing in: Chiba registers itself, sends the browser to the service, and takes back the code', async () => {
  const start = await app.request(`/api/plugins/${encodeURIComponent(id)}/sign-in`, { method: 'POST', headers: local });
  assert.equal(start.status, 200);
  const { url } = (await start.json()) as { url: string };
  const sent = new URL(url);
  assert.equal(sent.origin + sent.pathname, `${svc.base}/auth/authorize`, 'found through the plugin’s 401 and the two metadata documents');
  assert.equal(sent.searchParams.get('client_id'), 'client-1');
  assert.equal(sent.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(sent.searchParams.get('resource'), `${svc.base}/mcp`);
  assert.equal(sent.searchParams.get('scope'), 'read write', 'the scope the plugin asked for');
  assert.equal(sent.searchParams.get('redirect_uri'), 'http://localhost:4317/api/plugins/oauth/callback');
  assert.deepEqual(svc.registered[0].redirect_uris, ['http://localhost:4317/api/plugins/oauth/callback']);
  assert.equal(svc.registered[0].token_endpoint_auth_method, 'none');

  // The user approves in the browser, which comes back to Chiba with a code.
  const approved = await fetch(url, { redirect: 'manual' });
  const back = new URL(approved.headers.get('location')!);
  const done = await app.request(back.pathname + back.search, { headers: { host: 'localhost:4317' } });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Signed in to Docs/);

  const p = plugins.pluginList().find((x) => x.id === id)!;
  assert.equal(p.signedIn, true);
  const call = svc.tokenCalls.at(-1)!;
  assert.equal(call.get('grant_type'), 'authorization_code');
  assert.equal(call.get('resource'), `${svc.base}/mcp`);
});

test('once signed in, every agent’s calls carry the sign-in', async () => {
  assert.equal(await use(), 'pages about launch (token access-1)');
});

test('the sign-in is kept in the secrets file, readable only by the user', () => {
  const file = path.join(data, 'secrets.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).plugins[id];
  assert.equal(saved.accessToken, 'access-1');
  assert.equal(saved.refreshToken, 'refresh-1');
  assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test('when the service stops accepting the token, it is renewed and the call goes through', async () => {
  svc.valid.delete('access-1');
  plugins.afterSignIn(id);
  assert.equal(await use(), 'pages about launch (token access-2)');
  assert.equal(svc.tokenCalls.at(-1)!.get('grant_type'), 'refresh_token');
});

test('when it cannot be renewed, the agent is told the user must sign in again', async () => {
  svc.valid.clear();
  svc.refreshWorks = false;
  plugins.afterSignIn(id);
  await assert.rejects(use(), /needs the user to sign in/);
  assert.equal(plugins.pluginList().find((x) => x.id === id)!.signedIn, false);
  svc.refreshWorks = true;
});

test('signing in again reuses the app registration', async () => {
  const before = svc.registered.length;
  const { url } = (await (await app.request(`/api/plugins/${encodeURIComponent(id)}/sign-in`, { method: 'POST', headers: local })).json()) as { url: string };
  assert.equal(svc.registered.length, before);
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location')!);
  assert.equal((await app.request(back.pathname + back.search, { headers: { host: 'localhost:4317' } })).status, 200);
  assert.match(String(await use()), /token access-\d/);
});

test('a return that did not start here, or was refused, is turned away', async () => {
  const forged = await app.request('/api/plugins/oauth/callback?code=x&state=made-up', { headers: { host: 'localhost:4317' } });
  assert.equal(forged.status, 400);
  assert.match(await forged.text(), /expired or did not start here/);

  const { url } = (await (await app.request(`/api/plugins/${encodeURIComponent(id)}/sign-in`, { method: 'POST', headers: local })).json()) as { url: string };
  const state = new URL(url).searchParams.get('state')!;
  const refused = await app.request(`/api/plugins/oauth/callback?error=access_denied&state=${state}`, { headers: { host: 'localhost:4317' } });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /Docs did not sign in: access_denied/);
});

test('signing out forgets the sign-in', async () => {
  const res = await app.request(`/api/plugins/${encodeURIComponent(id)}/sign-in`, { method: 'DELETE', headers: local });
  assert.equal(res.status, 200);
  assert.equal(plugins.pluginList().find((x) => x.id === id)!.signedIn, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'secrets.json'), 'utf8')).plugins[id], undefined);
});

test('a plugin that already has a key of its own is not offered a sign-in', () => {
  plugins.addOwnServer({ name: 'Keyed', url: `${svc.base}/other`, headers: { Authorization: 'Bearer my-key' } });
  const p = plugins.pluginList(true).find((x) => x.name === 'Keyed')!;
  assert.equal(p.canSignIn, false);
});

test('the WWW-Authenticate header is read in its usual forms', () => {
  assert.deepEqual(auth.parseAuthenticate('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource", scope="a b"'), {
    resource_metadata: 'https://x/.well-known/oauth-protected-resource',
    scope: 'a b',
  });
  assert.deepEqual(auth.parseAuthenticate('Bearer error=invalid_token, realm="mcp"'), { error: 'invalid_token', realm: 'mcp' });
  assert.deepEqual(auth.parseAuthenticate(null), {});
});

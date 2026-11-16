import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Host, ToolCtx } from '../tools/tool.ts';
import { tempHome } from './helpers.ts';

// Plugin tools for the whole crew: found in other tools' settings, run by Majordomo, used by any agent.

process.env.MAJORDOMO_DEMO = '1';
tempHome();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majordomo-plugins-home-'));
process.env.HOME = home;
const echo = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-mcp.mjs');
const node = process.execPath;

const write = (rel: string, text: string) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// Claude Code: a server of the user's own, and two installed plugins, one switched off in Claude Code.
write('.claude.json', JSON.stringify({ mcpServers: { notes: { type: 'stdio', command: node, args: [echo], env: { GREETING: 'Hello' } } } }));
const pluginDir = path.join(home, '.claude/plugins/cache/market/marketing/1.0.0');
write('.claude/plugins/cache/market/marketing/1.0.0/.mcp.json', JSON.stringify({ mcpServers: { crm: { command: node, args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } } }));
write('.claude/plugins/cache/market/design/2.0.0/.mcp.json', JSON.stringify({ figma: { url: 'https://figma.example/mcp' } }));
write(
  '.claude/plugins/installed_plugins.json',
  JSON.stringify({
    version: 2,
    plugins: {
      'marketing@market': [{ scope: 'user', installPath: pluginDir }],
      'design@market': [{ scope: 'user', installPath: path.join(home, '.claude/plugins/cache/market/design/2.0.0') }],
    },
  }),
);
write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'marketing@market': true, 'design@market': false } }));
// Codex: an address, and an old-style SSE server that cannot be run yet.
write('.codex/config.toml', '[mcp_servers.linear]\nurl = "https://linear.example/mcp"\n\n[mcp_servers.legacy]\nurl = "https://old.example/sse"\ntype = "sse"\n');
// Hermes: the same notes server again (listed once), and one switched off in Hermes.
write(
  '.hermes/config.yaml',
  `model: x\nmcp_servers:\n  notes-again:\n    command: ${node}\n    args: ["${echo}"]\n  off-one:\n    command: uvx\n    args:\n      - mcp-server-time\n    enabled: false\n`,
);

let plugins: typeof import('../plugins.ts');
let client: typeof import('../mcp-client.ts');
let app: typeof import('../http.ts')['app'];
let orch: typeof import('../orchestrator.ts');

const approvals: { tool: string; detail: string }[] = [];
let allow = true;
const host: Host = {
  progress() {},
  askManager: async () => '',
  delegate: async () => '',
  approve: async (_agent, tool, _summary, detail) => {
    approvals.push({ tool, detail });
    return allow;
  },
};
const ctx = (): ToolCtx => ({ agentId: 'T-x', cwd: home, signal: new AbortController().signal, host });

before(async () => {
  plugins = await import('../plugins.ts');
  client = await import('../mcp-client.ts');
  app = (await import('../http.ts')).app;
  orch = await import('../orchestrator.ts');
});
after(() => plugins.closeAllPlugins());

const byName = () => Object.fromEntries(plugins.pluginList(true).map((p) => [p.name, p]));

// ----- finding them -----

test('plugins set up in Claude Code, its installed plugins, Codex and Hermes are found', () => {
  const found = byName();
  assert.deepEqual(Object.keys(found).sort(), ['legacy', 'linear', 'marketing · crm', 'notes', 'off-one']);
  assert.equal(found.notes!.source, 'claude');
  assert.equal(found['marketing · crm']!.source, 'claude-plugin');
  assert.match(found['marketing · crm']!.summary, new RegExp(`${pluginDir}/server\\.js`), '${CLAUDE_PLUGIN_ROOT} is filled in');
  assert.equal(found.linear!.source, 'codex');
  assert.equal(found['off-one']!.source, 'hermes');
  assert.ok(!('figma' in found), 'a plugin switched off in Claude Code is left out');
  assert.ok(!('notes-again' in found), 'the same server set up in two tools is listed once');
});

test('what each one is and whether it is on is reported, with secrets shortened', () => {
  const found = byName();
  assert.equal(found.notes!.enabled, true);
  assert.equal(found['off-one']!.enabled, false, 'switched off where it came from');
  assert.equal(found.legacy!.status, 'unsupported');
  assert.match(found.legacy!.summary, /older SSE connection/);
  assert.equal(found.legacy!.enabled, false);
  assert.match(found.notes!.summary, /GREETING=…$/, 'a short secret is hidden entirely');
  assert.ok(!found.notes!.summary.includes('Hello'));
});

// ----- talking to them -----

test('a plugin started on this computer is connected to, and its tools listed and called', async () => {
  const c = new client.McpClient({ transport: 'stdio', command: node, args: [echo], env: { GREETING: 'Hi' } });
  await c.start();
  const tools = await c.listTools();
  assert.deepEqual(
    tools.map((t) => [t.name, t.readOnly]),
    [
      ['search_notes', true],
      ['post_message', false],
      ['broken', true],
    ],
  );
  assert.deepEqual(await c.callTool('search_notes', { query: 'launch' }), { text: 'Hi: 2 notes about launch', isError: false });
  assert.equal((await c.callTool('broken', {})).isError, true);
  c.close();
  assert.equal(c.alive, false);
});

test('a plugin that will not start says why', async () => {
  const c = new client.McpClient({ transport: 'stdio', command: '/nonexistent/plugin', args: [], env: {} });
  await assert.rejects(c.start(5000), /Could not start \/nonexistent\/plugin/);
});

test('a plugin at an address is reached over HTTP, including answers sent as an event stream', async () => {
  let session = '';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer good') return res.writeHead(401).end();
      const msg = JSON.parse(raw);
      session ||= String(req.headers['mcp-session-id'] ?? '');
      if (msg.id === undefined) return res.writeHead(202).end();
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
          : msg.method === 'tools/list'
            ? { tools: [{ name: 'list_issues', description: 'List issues', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: `issues for ${msg.params.arguments.team}` }] };
      if (msg.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  try {
    const c = new client.McpClient({ transport: 'http', url, headers: { Authorization: 'Bearer good' } });
    await c.start();
    assert.deepEqual((await c.listTools()).map((t) => t.name), ['list_issues']);
    assert.equal((await c.callTool('list_issues', { team: 'Growth' })).text, 'issues for Growth');
    assert.equal(session, 'sess-1', 'the session the server gave is sent back');

    const locked = new client.McpClient({ transport: 'http', url, headers: {} });
    await assert.rejects(locked.start(), client.NeedsSignIn);
  } finally {
    server.close();
  }
});

// ----- what agents use -----

const tool = (name: string) => plugins.pluginTools().find((t) => t.name === name)!;

test('agents list the plugins and, for one, its tools and arguments', async () => {
  plugins.setPluginsEnabled(['claude-plugin:marketing · crm', 'codex:linear'], false);
  const all = String(await tool('plugin_tools').run({}, ctx()));
  assert.match(all, /^- notes: search_notes, post_message, broken$/m);
  const detail = String(await tool('plugin_tools').run({ plugin: 'notes' }, ctx()));
  assert.match(detail, /## search_notes \(read-only\)\nSearch the notes\.\nArguments \(JSON Schema\): \{"type":"object"/);
  assert.match(detail, /## post_message\n/);
});

test('a read-only tool runs straight away; one that changes things is approved first', async () => {
  approvals.length = 0;
  assert.equal(await tool('use_plugin_tool').run({ plugin: 'notes', tool: 'search_notes', arguments: { query: 'Q3' } }, ctx()), 'Hello: 2 notes about Q3');
  assert.equal(approvals.length, 0);

  assert.equal(await tool('use_plugin_tool').run({ plugin: 'notes', tool: 'post_message', arguments: { text: 'Shipped!' } }, ctx()), 'Posted: Shipped!');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.tool, 'notes.post_message');
  assert.match(approvals[0]!.detail, /"text": "Shipped!"/);

  allow = false;
  await assert.rejects(tool('use_plugin_tool').run({ plugin: 'notes', tool: 'post_message', arguments: { text: 'No' } }, ctx()), /declined/);
  allow = true;
});

test('mistakes and failures come back as messages the agent can act on', async () => {
  await assert.rejects(tool('use_plugin_tool').run({ plugin: 'nope', tool: 'x' }, ctx()), /no plugin called "nope".*Switched on: notes/);
  await assert.rejects(tool('use_plugin_tool').run({ plugin: 'notes', tool: 'x' }, ctx()), /has no tool called "x".*search_notes/);
  await assert.rejects(tool('use_plugin_tool').run({ plugin: 'notes', tool: 'broken' }, ctx()), /reported an error: the backend is down/);
});

test('a switched-off plugin cannot be used and is not offered', async () => {
  plugins.setPluginsEnabled(['claude:notes'], false);
  try {
    await assert.rejects(tool('use_plugin_tool').run({ plugin: 'notes', tool: 'search_notes', arguments: { query: 'x' } }, ctx()), /no plugin called/);
    assert.equal(plugins.pluginCatalog(), '', 'with every plugin off, the brief says nothing about them');
  } finally {
    plugins.setPluginsEnabled(['claude:notes'], true);
  }
});

test('each task’s brief names the plugins and the tools they offered last time', () => {
  const catalog = plugins.pluginCatalog();
  assert.match(catalog, /# Plugin tools you can use/);
  assert.match(catalog, /^- notes: search_notes, post_message, broken$/m);
});

test('a plugin can be added by hand, tested, and removed', async () => {
  const add = await app.request('/api/plugins', {
    method: 'POST',
    headers: { host: 'localhost:4317', origin: 'http://localhost:4317', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'My Notes', command: `"${node}" ${echo}` }),
  });
  assert.equal(add.status, 200);
  const mine = plugins.pluginList().find((p) => p.name === 'My Notes');
  assert.ok(!mine, 'the same server as one already found is listed once');

  plugins.addOwnServer({ name: 'Time', command: 'uvx mcp-server-time --local-timezone "America/New York"' });
  const time = plugins.pluginList(true).find((p) => p.name === 'Time')!;
  assert.equal(time.source, 'majordomo');
  assert.equal(time.summary, 'uvx mcp-server-time --local-timezone America/New York');
  assert.ok(time.removable);

  const test = await app.request(`/api/plugins/${encodeURIComponent('claude:notes')}/test`, { method: 'POST', headers: { host: 'localhost:4317', origin: 'http://localhost:4317' } });
  const body = (await test.json()) as { ok: boolean; tools: { name: string }[] };
  assert.equal(body.ok, true);
  assert.equal(body.tools.length, 3);

  plugins.removeOwnServer(time.id);
  assert.ok(!plugins.pluginList(true).some((p) => p.name === 'Time'));
  assert.throws(() => plugins.removeOwnServer('claude:notes'), /Only plugins added here/);
  assert.throws(() => plugins.addOwnServer({ name: 'bad', url: 'http://example.com/mcp' }), /https/);
});

// ----- agents on a CLI account -----

test('a CLI agent reaches the plugin tools through its own Majordomo endpoint, as itself', async () => {
  const project = await orch.orch.createProject({ name: 'Launch', goal: 'Ship it' });
  const [task] = orch.orch.createTasks(project.id, [{ title: 'Post the news', brief: 'Post it' }]);
  const call = (body: object, token = orch.MCP_TOKEN, id = task!.id) =>
    app.request(`/mcp/worker/${id}`, { method: 'POST', headers: { host: '127.0.0.1:4317', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const list = (await (await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['plugin_tools', 'use_plugin_tool']);

  const res = (await (
    await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'use_plugin_tool', arguments: { plugin: 'notes', tool: 'search_notes', arguments: { query: 'press' } } } })
  ).json()) as { result: { content: { text: string }[]; isError: boolean } };
  assert.deepEqual([res.result.content[0]!.text, res.result.isError], ['Hello: 2 notes about press', false]);

  assert.equal((await call({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'wrong')).status, 401);
  assert.equal((await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, orch.MCP_TOKEN, 'T-999')).status, 404);
});

test('Claude Code workers use plugins only through Majordomo; Gemini workers get the connection outside the project', async () => {
  const cli = await import('../agents/cli.ts');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'majordomo-ws-'));
  const base = { agentId: 'T-7', model: '', cwd: ws, prompt: 'x', manager: false, signal: new AbortController().signal, mcp: { url: 'http://127.0.0.1:4317/mcp/worker/T-7', token: 'tok' } };

  const claude = cli.cliArgs({ ...base, runtime: 'claude-code' });
  assert.ok(claude.includes('--strict-mcp-config'), 'its own copies of the plugins are not loaded beside Majordomo’s');
  assert.match(claude[claude.indexOf('--allowedTools') + 1]!, /mcp__majordomo/);
  assert.match(claude[claude.indexOf('--mcp-config') + 1]!, /mcp\/worker\/T-7/);

  const gem = cli.cliCommand({ ...base, runtime: 'gemini-cli' });
  assert.equal(gem.args[gem.args.indexOf('--allowed-mcp-server-names') + 1], 'majordomo');
  const settings = JSON.parse(fs.readFileSync(gem.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, 'utf8'));
  assert.equal(settings.mcpServers.majordomo.httpUrl, base.mcp.url);
  assert.equal(fs.statSync(gem.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!).mode & 0o077, 0, 'only the user can read it');
  assert.ok(!fs.existsSync(path.join(ws, '.gemini')), 'nothing is written into the project');
});

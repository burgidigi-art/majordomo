import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { tempHome, until } from './helpers.ts';

process.env.MAJORDOMO_DEMO = '1';
process.env.MAJORDOMO_DEMO_SPEED = '60';
const home = tempHome();

let orch: typeof import('../orchestrator.ts');
let db: typeof import('../db.ts');
let app: typeof import('../http.ts')['app'];

before(async () => {
  db = await import('../db.ts');
  orch = await import('../orchestrator.ts');
  app = (await import('../http.ts')).app;
  orch.orch.boot();
});

const local = { host: 'localhost:4317' };
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...local, ...headers },
  body: JSON.stringify(body),
});

test('one message to the PM becomes a project, parallel tasks, and a final report', async () => {
  orch.orch.chat('Plan the launch of my woodworking newsletter and draft the first issue');
  await until(() => db.tasks.all().length === 4 && db.tasks.all().every((t) => t.status === 'done') && !orch.runner.isBusy('pm') && !orch.runner.queued('pm'));
  // The last completion wakes the PM once more for its closing report.
  await until(() => db.events.list('pm').some((e) => e.type === 'text' && /is finished/.test(e.data.text)));

  const [project] = db.projects.all();
  assert.equal(project.name, 'Plan the launch of my woodworking newsletter');
  for (const file of ['SUMMARY.md', 'build/first-version.md', 'notes/gather-context-and-constraints.md']) {
    assert.ok(fs.existsSync(path.join(project.workspace, file)), `${file} was written to the workspace`);
  }
  assert.ok(project.workspace.startsWith(home));

  const tasks = db.tasks.all();
  const byTitle = (re: RegExp) => tasks.find((t) => re.test(t.title))!;
  assert.deepEqual(byTitle(/first version/).dependsOn, [byTitle(/Gather/).id], '"#1" resolved to the first task of the batch');
  assert.ok(byTitle(/first version/).startedAt! >= byTitle(/Gather/).finishedAt!, 'a dependent task waits for its prerequisite');
  assert.ok(tasks.every((t) => t.tokensIn > 0), 'usage is recorded per task');

  // The worker that asked a question got the PM's answer and carried on.
  const asked = db.events.list(byTitle(/risks/).id);
  assert.ok(asked.some((e) => e.type === 'tool_call' && e.data.name === 'ask_manager'));
  assert.ok(asked.some((e) => e.type === 'user' && /thoroughness/.test(e.data.text)));

  // A dependent task is handed the reports of what it depends on.
  const brief = db.events.list(byTitle(/summary/).id).find((e) => e.type === 'user')!;
  assert.match(brief.data.text, /Reports from the tasks this one depends on/);
});

test('a finished agent can be asked for a follow-up and keeps its context', async () => {
  const t = db.tasks.all()[0];
  orch.orch.messageTask(t.id, 'One more thing: note the deadline.', 'user');
  await until(() => db.events.list(t.id).some((e) => e.type === 'text' && /Understood/.test(e.data.text)) && db.tasks.get(t.id)!.status === 'done');
  assert.ok(db.messages.load(t.id).length > 8, 'the follow-up was appended to the same conversation');
});

test('cancelling stops a task, holds back what depends on it, and tells the PM', async () => {
  const [project] = db.projects.all();
  const [a, b] = orch.orch.createTasks(project.id, [
    { title: 'Long job', brief: 'x' },
    { title: 'After the long job', brief: 'y', dependsOn: ['#1'] },
  ]);
  assert.equal(db.tasks.get(a.id)!.status, 'running');
  assert.equal(db.tasks.get(b.id)!.status, 'queued');
  orch.orch.userCancelled(a.id);
  await until(() => !orch.runner.isBusy(a.id));
  assert.equal(db.tasks.get(a.id)!.status, 'cancelled');
  assert.equal(db.tasks.get(b.id)!.status, 'queued');
  assert.match(db.tasks.get(b.id)!.statusLine, /Blocked/);
  await until(() => db.events.list('pm').some((e) => e.type === 'user' && /cancelled by you/.test(e.data.text)));
  orch.orch.cancelTask(b.id, 'test cleanup');
});

test('workers cannot write outside their workspace', async () => {
  const { workerTools } = await import('../tools/worker.ts');
  const write = workerTools({ canDelegate: false }).find((t) => t.name === 'write_file')!;
  const ctx = { agentId: 'T-x', cwd: db.projects.all()[0].workspace, signal: new AbortController().signal, host: {} as never };
  await assert.rejects(() => write.run({ path: '../escape.txt', content: 'x' }, ctx), /outside the project workspace/);
  await assert.rejects(() => write.run({ path: '/tmp/escape.txt', content: 'x' }, ctx), /outside the project workspace/);
  assert.match(String(await write.run({ path: 'nested/ok.txt', content: 'x' }, ctx)), /Wrote nested\/ok.txt/);
});

test('the HTTP API only answers its own dashboard', async () => {
  assert.equal((await app.request('/api/state', { headers: local })).status, 200);
  assert.equal((await app.request('/api/state', { headers: { host: 'evil.example' } })).status, 403, 'DNS-rebinding style Host is refused');
  assert.equal((await app.request('/api/chat', json({ text: 'hi' }, { origin: 'https://evil.example' }))).status, 403, 'cross-site POST is refused');
  const state = await (await app.request('/api/state', { headers: local })).json();
  assert.ok(!JSON.stringify(state).includes('test-key'));
  assert.equal((await app.request('/api/projects/P-1/file?path=../../../etc/passwd', { headers: local })).status, 400, 'file preview stays inside the workspace');
});

test('the MCP endpoint exposes the PM tools to a CLI-hosted manager', async () => {
  const rpc = (method: string, params?: unknown, token = orch.MCP_TOKEN) =>
    app.request('/mcp', json({ jsonrpc: '2.0', id: 1, method, params }, { authorization: `Bearer ${token}` }));
  assert.equal((await rpc('tools/list', undefined, 'wrong')).status, 401);
  const init: any = await (await rpc('initialize', { protocolVersion: '2025-06-18' })).json();
  assert.equal(init.result.serverInfo.name, 'majordomo');
  const list: any = await (await rpc('tools/list')).json();
  const names = list.result.tools.map((t: any) => t.name);
  assert.ok(names.includes('create_tasks') && names.includes('message_agent'));
  assert.ok(list.result.tools.every((t: any) => t.inputSchema.type === 'object'));
  const call: any = await (await rpc('tools/call', { name: 'list_projects', arguments: {} })).json();
  assert.match(call.result.content[0].text, /P-1 "Plan the launch/);
  const bad: any = await (await rpc('tools/call', { name: 'create_tasks', arguments: { project: 'P-1' } })).json();
  assert.equal(bad.result.isError, true, 'invalid input is reported to the model, not thrown');
  const notification = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${orch.MCP_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notification.status, 202);
});

test('the dashboard is told the manager is idle once it finishes', async () => {
  const { subscribe } = await import('../bus.ts');
  const seen: boolean[] = [];
  const stop = subscribe((m) => {
    if (m.kind === 'sync' && m.patch.pm) seen.push(m.patch.pm.busy);
  });
  orch.orch.chat('hi');
  await until(() => seen.includes(true) && !orch.runner.isBusy('pm'));
  await new Promise((r) => setTimeout(r, 50));
  stop();
  assert.equal(seen.at(-1), false, 'the last status pushed to clients says not busy');
});

test('plan usage reported by Claude Code is recorded and pushed to the dashboard', async () => {
  const { recordClaudeLimits, getLimits } = await import('../limits.ts');
  const { subscribe } = await import('../bus.ts');
  let pushed: any = null;
  const stop = subscribe((m) => {
    if (m.kind === 'sync' && m.patch.limits) pushed = m.patch.limits;
  });
  recordClaudeLimits({
    status: 'allowed',
    rateLimitType: 'five_hour',
    unifiedWindows: {
      five_hour: { utilization: 0.45, resetsAt: 1794339600, status: 'allowed' },
      seven_day: { utilization: 0.05, resetsAt: 1794927600, status: 'allowed' },
    },
  });
  recordClaudeLimits({ status: 'allowed' });
  recordClaudeLimits(undefined);
  stop();
  const saved = getLimits()['claude-code']!;
  assert.deepEqual(saved.weekly, { used: 0.05, resetsAt: 1794927600000 });
  assert.deepEqual(saved.session, { used: 0.45, resetsAt: 1794339600000 });
  assert.deepEqual(pushed['claude-code'].weekly, saved.weekly);
  const state: any = await (await app.request('/api/state', { headers: local })).json();
  assert.equal(state.limits['claude-code'].weekly.used, 0.05);
});

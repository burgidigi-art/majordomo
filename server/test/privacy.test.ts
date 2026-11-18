import assert from 'node:assert/strict';
import path from 'node:path';
import { before, test } from 'node:test';
import Database from 'better-sqlite3';
import { crewCleared } from '../../shared/privacy.ts';
import type { CrewProfile, RuntimeId, Settings } from '../../shared/types.ts';
import { tempHome, until } from './helpers.ts';

process.env.MAJORDOMO_DEMO = '1';
process.env.MAJORDOMO_DEMO_SPEED = '60';
const home = tempHome();

// A database from before private work existed, with a project and a task already in it.
{
  const old = new Database(path.join(home, 'majordomo.db'));
  old.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', notes TEXT NOT NULL DEFAULT '',
      workspace TEXT NOT NULL, hue INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parent_id TEXT, title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL,
      crew_id TEXT NOT NULL, crew_name TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT NOT NULL,
      effort TEXT, depends_on TEXT NOT NULL DEFAULT '[]',
      status_line TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      attempt INTEGER NOT NULL DEFAULT 1,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, cost_included INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
    );
    INSERT INTO projects (id, name, workspace, status, created_at, updated_at) VALUES ('P-900', 'From before', '${path.join(home, 'old')}', 'archived', 1, 1);
    INSERT INTO tasks (id, project_id, title, brief, status, crew_id, crew_name, runtime, model, created_at)
      VALUES ('T-900', 'P-900', 'Old task', 'Old brief', 'done', 'builder', 'Builder', 'demo', 'demo-1', 1);
  `);
  old.close();
}

let orch: typeof import('../orchestrator.ts');
let db: typeof import('../db.ts');
let app: typeof import('../http.ts')['app'];
let settings: typeof import('../settings.ts');
let privacy: typeof import('../privacy.ts');
let pm: typeof import('../tools/pm.ts');

const flash: CrewProfile = { id: 'flash', name: 'Flash', strengths: 'Fast legwork', runtime: 'openrouter', model: 'some/flash' };
let base: Settings;
/** The demo crew (same account as the manager) plus Flash on another company's models. */
const crew = (patch: Partial<Settings> = {}, extra: CrewProfile[] = [flash]) => settings.saveSettings({ ...base, crew: [...base.crew, ...extra], ...patch });

const local = { host: 'localhost:4317', 'content-type': 'application/json' };
const signal = new AbortController().signal;
const ctx = { agentId: 'pm', cwd: home, signal, host: {} as never };
const tool = (name: string) => pm.pmTools(orch.orch).find((t) => t.name === name)!;
/** A project that will not start its tasks, so what was decided at creation can be inspected. */
async function parked(name: string, confidential = false) {
  const p = await orch.orch.createProject({ name, goal: '', private: confidential });
  return orch.orch.updateProject(p.id, { status: 'paused' });
}

before(async () => {
  db = await import('../db.ts');
  settings = await import('../settings.ts');
  orch = await import('../orchestrator.ts');
  privacy = await import('../privacy.ts');
  pm = await import('../tools/pm.ts');
  app = (await import('../http.ts')).app;
  base = settings.getSettings();
  crew();
});

test('an existing database gains the new columns, and what was in it is not private', () => {
  assert.equal(db.projects.get('P-900')!.private, false);
  assert.equal(db.tasks.get('T-900')!.private, false);
  assert.equal(db.projects.update('P-900', { private: true })!.private, true);
  assert.equal(db.projects.get('P-900')!.private, true, 'and the new column can be written');
});

test('a crew member is cleared by default only on the manager’s own company', () => {
  const family = (r: RuntimeId) => settings.runtimeDef(r).family;
  const on = (runtime: RuntimeId, trusted?: boolean) => crewCleared({ runtime, trusted }, 'claude-code', family);
  assert.equal(on('claude-code'), true);
  assert.equal(on('anthropic'), true, 'the same company through an API key counts');
  assert.equal(on('openrouter'), false, 'another company is a new recipient');
  assert.equal(on('openrouter', true), true, 'the user can clear anyone');
  assert.equal(on('claude-code', false), false, 'and withdraw it from anyone');

  assert.equal(privacy.cleared(base.crew[0]!), true);
  assert.equal(privacy.cleared(flash), false);
  assert.match(privacy.clearedNames(), /Builder \(builder\)/);
});

test('a private project only accepts cleared crew', async () => {
  const p = await parked('Tax return', true);
  assert.throws(() => orch.orch.createTasks(p.id, [{ title: 'Sort receipts', brief: 'x', crew: 'flash' }]), /private project and Flash is not cleared[\s\S]*Builder \(builder\)/);
  assert.throws(() => orch.orch.createTasks(p.id, [{ title: 'ok', brief: 'x', crew: 'builder' }, { title: 'no', brief: 'x', crew: 'Flash' }]), /not cleared/);
  assert.equal(db.tasks.byProject(p.id).length, 0, 'a refused batch creates nothing, not even the tasks that were fine');

  // When nobody is named and the default crew member is not cleared, someone who is takes it.
  crew({ defaultCrewId: 'flash' });
  const [t] = orch.orch.createTasks(p.id, [{ title: 'Sort receipts', brief: 'x' }]);
  assert.equal(privacy.cleared(settings.resolveCrew(t!.crewId)), true);
  assert.equal(t!.private, true);
  crew();

  // An open project takes anyone, and its tasks are not marked.
  const open = await parked('Trip ideas');
  const [free] = orch.orch.createTasks(open.id, [{ title: 'Find flights', brief: 'x', crew: 'flash' }]);
  assert.deepEqual([free!.crewId, free!.private], ['flash', false]);
});

test('the manager can close a project but only the dashboard can open it again', async () => {
  const made = await tool('create_project').run({ name: 'Medical', goal: 'Sort the bills', private: true }, ctx);
  assert.match(String(made), /\(private\)/);
  const p = db.projects.all().find((x) => x.name === 'Medical')!;
  assert.equal(p.private, true);

  assert.equal(tool('update_project').input.safeParse({ project: p.id, private: false }).success, false, 'the manager’s tool has no way to say "not private"');
  assert.equal(tool('update_project').input.safeParse({ project: p.id, private: true }).success, true);
  assert.match(String(await tool('get_project').run({ project: p.id }, ctx)), /private: only crew cleared/);
  assert.match(String(await tool('list_crew').run({}, ctx)), /Flash — Fast legwork \[openrouter · some\/flash\] \[not cleared for private work\]/);

  const res = await app.request(`/api/projects/${p.id}`, { method: 'PATCH', headers: local, body: JSON.stringify({ private: false }) });
  assert.equal(((await res.json()) as { private: boolean }).private, false);
});

test('making a project private stops work that is with crew who are not cleared', async () => {
  const p = await parked('Offer letter');
  const [mine, theirs] = orch.orch.createTasks(p.id, [
    { title: 'Draft it', brief: 'x', crew: 'builder' },
    { title: 'Check the market rate', brief: 'x', crew: 'flash' },
  ]);
  orch.orch.updateProject(p.id, { private: true });

  const after = db.tasks.get(theirs!.id)!;
  assert.equal(after.status, 'cancelled');
  assert.match(after.statusLine, /made private and Flash is not cleared/);
  assert.deepEqual([db.tasks.get(mine!.id)!.status, db.tasks.get(mine!.id)!.private], ['queued', true], 'cleared work carries on, now marked private');
  // Retrying does not get it past the door either.
  orch.orch.retryTask(theirs!.id);
  orch.orch.updateProject(p.id, { status: 'active' });
  await until(() => db.tasks.get(theirs!.id)!.status === 'failed');
  assert.match(db.tasks.get(theirs!.id)!.error, /private work and Flash is not cleared/);
  assert.equal(db.events.list(theirs!.id).some((e) => e.type === 'user'), false, 'nothing was sent to the model');
  await until(() => db.tasks.get(mine!.id)!.status === 'done');
});

test('clearance is checked again at the moment a task starts', async () => {
  // Withdrawn after the task was written.
  const p = await parked('Will', true);
  const [t] = orch.orch.createTasks(p.id, [{ title: 'List the assets', brief: 'x', crew: 'builder' }]);
  settings.saveSettings({ ...settings.getSettings(), crew: settings.getSettings().crew.map((c) => (c.id === 'builder' ? { ...c, trusted: false } : c)) });
  orch.orch.updateProject(p.id, { status: 'active' });
  await until(() => db.tasks.get(t!.id)!.status === 'failed');
  assert.match(db.tasks.get(t!.id)!.error, /Builder is not cleared/);
  assert.equal(db.events.list(t!.id).some((e) => e.type === 'user'), false);
  crew();

  // The crew member was removed altogether: there is nobody to vouch for the account on record.
  const q = await parked('Custody', true);
  const [gone] = orch.orch.createTasks(q.id, [{ title: 'Summarise', brief: 'x', crew: 'scout' }]);
  settings.saveSettings({ ...settings.getSettings(), crew: settings.getSettings().crew.filter((c) => c.id !== 'scout') });
  orch.orch.updateProject(q.id, { status: 'active' });
  await until(() => db.tasks.get(gone!.id)!.status === 'failed');
  crew();

  // The crew member now runs on a different model: a private task runs on what is cleared today.
  const r = await parked('Payroll', true);
  const [moved] = orch.orch.createTasks(r.id, [{ title: 'Total it', brief: 'x', crew: 'builder' }]);
  settings.saveSettings({ ...settings.getSettings(), crew: settings.getSettings().crew.map((c) => (c.id === 'builder' ? { ...c, model: 'demo-2' } : c)) });
  orch.orch.updateProject(r.id, { status: 'active' });
  await until(() => db.tasks.get(moved!.id)!.status === 'done');
  assert.equal(db.tasks.get(moved!.id)!.model, 'demo-2');
  crew();
});

test('helpers on private work must be cleared too', async () => {
  const p = await parked('Lawsuit', true);
  const [t] = orch.orch.createTasks(p.id, [{ title: 'Research precedent', brief: 'x', crew: 'builder' }]);
  await assert.rejects(orch.agentHost.delegate(t!.id, [{ title: 'Skim cases', brief: 'x', crew: 'flash' }], signal), /private work, and Flash is not cleared[\s\S]*or do them yourself/);
  assert.equal(db.tasks.byProject(p.id).length, 1, 'no helper was created');
});

test('while the manager has the mailbox open, nothing goes to crew who are not cleared', async () => {
  const p = await parked('Errands');
  const [theirs] = orch.orch.createTasks(p.id, [{ title: 'Compare prices', brief: 'x', crew: 'flash' }]);

  privacy.setManagerHoldsMail(true);
  assert.throws(() => orch.orch.createTasks(p.id, [{ title: 'Summarise this thread', brief: 'x', crew: 'flash' }]), /opened the user’s email or calendar in this turn[\s\S]*Assign this to: .*Builder/);
  assert.throws(() => orch.orch.messageTask(theirs!.id, 'Here is what the email said', 'manager'), /no message can go to them right now/);
  orch.orch.messageTask(theirs!.id, 'A note from the user themself', 'user');
  const [kept] = orch.orch.createTasks(p.id, [{ title: 'Summarise this thread', brief: 'x', crew: 'builder' }]);
  assert.equal(kept!.private, true, 'work handed out with the mailbox open stays private, so its helpers are held to it as well');

  // The manager's turn ending is what closes the mailbox again.
  orch.orch.chat('hello');
  await until(() => !orch.runner.isBusy('pm') && !orch.runner.queued('pm') && !privacy.managerHoldsMail());
  const [later] = orch.orch.createTasks(p.id, [{ title: 'Find a plumber', brief: 'x', crew: 'flash' }]);
  assert.equal(later!.private, false);
});

test('the manager is told who is cleared and which projects are private', async () => {
  await parked('Divorce papers', true);
  const before = db.events.list('pm').length;
  orch.orch.chat('where do things stand?');
  await until(() => db.events.list('pm').length > before && !orch.runner.isBusy('pm') && !orch.runner.queued('pm'));
  const sent = db.messages
    .load('pm')
    .flatMap((m) => (m as { parts: { text?: string }[] }).parts)
    .map((part) => part.text ?? '')
    .join('\n');
  assert.match(sent, /flash: Flash — Fast legwork \[not cleared for private work\]/);
  assert.match(sent, /"Divorce papers" \(paused, private\)/);
  assert.doesNotMatch(sent, /builder[^\n]*not cleared/);
});

test('each worker’s token opens only its own tools', async () => {
  const p = await parked('Tokens');
  const [a, b] = orch.orch.createTasks(p.id, [{ title: 'A', brief: 'x', crew: 'builder' }, { title: 'B', brief: 'x', crew: 'flash' }]);
  const token = privacy.workerToken(orch.MCP_TOKEN, a!.id);
  const call = (route: string, bearer: string) =>
    app.request(route, { method: 'POST', headers: { ...local, authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });

  assert.notEqual(token, orch.MCP_TOKEN);
  assert.equal((await call(`/mcp/worker/${a!.id}`, token)).status, 200);
  assert.equal((await call(`/mcp/worker/${b!.id}`, token)).status, 401, 'not another task’s');
  assert.equal((await call('/mcp', token)).status, 401, 'not the manager’s');
  assert.equal((await call(`/mcp/worker/${a!.id}`, orch.MCP_TOKEN)).status, 401);
  assert.equal((await call('/mcp', orch.MCP_TOKEN)).status, 200);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import type { ToolCtx } from '../tools/tool.ts';
import { until } from './helpers.ts';

// This file is about the sandbox, so it is on here; everywhere else the tests switch it off.
process.env.MAJORDOMO_SANDBOX = 'on';
process.env.MAJORDOMO_DEMO = '1';
process.env.MAJORDOMO_DEMO_SPEED = '60';
// Kept in a folder of its own beside the code, away from the real home folder.
const home = fs.mkdtempSync(path.join(fs.realpathSync(process.cwd()), '.sandbox-test-'));
process.env.MAJORDOMO_HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

let sandbox: typeof import('../sandbox.ts');
let orch: typeof import('../orchestrator.ts');
let db: typeof import('../db.ts');
let settings: typeof import('../settings.ts');
let worker: typeof import('../tools/worker.ts');
let app: typeof import('../http.ts')['app'];
/** Whether this computer can run the sandbox at all. The tests that run real commands need it. */
let cannot: string | false = false;

before(async () => {
  db = await import('../db.ts');
  settings = await import('../settings.ts');
  sandbox = await import('../sandbox.ts');
  worker = await import('../tools/worker.ts');
  orch = await import('../orchestrator.ts');
  app = (await import('../http.ts')).app;
  cannot = sandbox.unavailableReason() ?? false;
  if (!cannot) {
    // bubblewrap can be installed and still be unable to start, for instance inside some containers.
    const probe = await sandbox.checkSandbox();
    if (!probe.probes[0]?.ok) cannot = `the sandbox does not start here: ${probe.probes[0]?.detail || probe.problem}`;
  }
});

const signal = new AbortController().signal;
const tool = (name: string) => worker.workerTools({ canDelegate: false }).find((t) => t.name === name)!;
/** A project folder with a secret beside it, and the rules an agent in that project works under. */
function project(name: string) {
  const dir = path.join(home, name);
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, `KEY-${name}`);
  const policy = sandbox.policyFor({ id: name, workspace });
  const ctx: ToolCtx = { agentId: 'T-1', cwd: workspace, signal, host: { approve: async () => true } as never, sandbox: policy };
  return { workspace, secret, policy, ctx, outside: path.join(dir, 'escaped.txt') };
}

test('the rules hide the home folder and everything of 00Dojo’s but the project itself', () => {
  assert.equal(sandbox.homeRoot('/Users/sam'), '/Users', 'on a Mac every account’s folder is hidden');
  assert.equal(sandbox.homeRoot('/home/sam'), '/home');
  assert.equal(sandbox.homeRoot('/root'), '/root');

  const { policy, workspace, secret } = project('rules');
  assert.ok(policy.denied.includes(sandbox.homeRoot()));
  assert.ok(sandbox.mayRead(policy, path.join(workspace, 'notes.md')));
  assert.ok(sandbox.mayRead(policy, path.join(policy.tmp, 'scratch')));
  assert.ok(sandbox.mayRead(policy, '/etc/hosts'), 'the system’s own files stay readable, or nothing would run');
  assert.ok(!sandbox.mayRead(policy, secret), 'a file beside the project is not part of it');
  assert.ok(!sandbox.mayRead(policy, path.join(home, 'secrets.json')), '00Dojo’s saved keys');
  assert.ok(!sandbox.mayRead(policy, path.join(os.homedir(), '.ssh', 'id_ed25519')));

  // A link inside the project that points out of it does not carry the reader out with it.
  fs.symlinkSync(secret, path.join(workspace, 'innocent.txt'));
  assert.ok(!sandbox.mayRead(policy, path.join(workspace, 'innocent.txt')));
});

test('programs under the home folder can be run, without opening the folders around them', () => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'majordomo-fakehome-'));
  const make = (rel: string) => fs.mkdirSync(path.join(fake, rel), { recursive: true });
  for (const rel of ['.nvm/versions/node/v22/bin', '.nvm/versions/node/v22/lib', '.local/bin', '.local/share/keyrings', 'Documents/tools/bin', '.ssh', '.cargo/bin', 'certs']) make(rel);
  fs.writeFileSync(path.join(fake, 'certs', 'company.pem'), 'x');
  const base = fs.realpathSync(fake);
  const dirs = sandbox
    .toolchainDirs({ PATH: ['.nvm/versions/node/v22/bin', '.local/bin', 'Documents/tools/bin', '.ssh'].map((rel) => path.join(fake, rel)).join(':') + ':/usr/bin', SSL_CERT_FILE: path.join(fake, 'certs', 'company.pem') }, fake)
    .map((dir) => path.relative(base, dir));

  assert.ok(dirs.includes('.nvm/versions/node/v22'), 'node’s own files, beside its bin folder');
  assert.ok(dirs.includes('.local/bin') && !dirs.includes('.local'), 'only the programs, not the app data kept next to them');
  assert.ok(dirs.includes('.cargo'), 'a version manager that is installed is included even when PATH does not mention it');
  assert.ok(dirs.includes('certs/company.pem'), 'the certificates programs are told to trust');
  assert.ok(dirs.includes('Documents/tools'), 'a tool someone keeps in Documents and put on PATH comes with its own files');
  assert.ok(!dirs.includes('.ssh') && !dirs.includes('Documents') && !dirs.includes('.local/share'), `but never the private folders themselves: ${dirs.join(' ')}`);
});

test('Claude Code workers are given the same rules as settings for the session', async () => {
  const { policy, workspace } = project('claude');
  const skills = path.join(home, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  const withSkills = { ...policy, skills: [skills] };
  const s = sandbox.claudeCodeSettings(withSkills) as any;
  assert.deepEqual([s.sandbox.enabled, s.sandbox.failIfUnavailable, s.sandbox.allowUnsandboxedCommands], [true, true, false], 'on, and refusing to run without it');
  assert.deepEqual(s.sandbox.filesystem.denyRead, policy.denied);
  assert.ok(s.sandbox.filesystem.allowRead.includes(workspace) && s.sandbox.filesystem.allowRead.includes(skills));
  assert.ok(s.sandbox.filesystem.denyWrite.includes(skills), 'skills can be read, not rewritten');
  assert.deepEqual(s.permissions.deny, [`Edit(/${skills}/**)`]);
  assert.ok(s.permissions.blockReadsOutsideWorkingDirectories && s.permissions.blockWritesOutsideWorkingDirectories && s.permissions.denyInsteadOfPrompting);
  assert.ok(s.sandbox.network.allowedDomains.includes('registry.npmjs.org'));

  const cli = await import('../agents/cli.ts');
  const turn = { agentId: 'T-7', runtime: 'claude-code' as const, model: '', cwd: workspace, prompt: 'x', manager: false, signal };
  const args = cli.cliArgs({ ...turn, sandbox: withSkills });
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]!), s);
  assert.ok(!cli.cliArgs(turn).includes('--settings'), 'with the sandbox off nothing is added');
  assert.ok(!cli.cliArgs({ ...turn, manager: true, sandbox: withSkills }).includes('--settings'), 'the manager has no shell to hold in');
});

test('a sandboxed agent’s commands work inside its project and nowhere else', async (t) => {
  if (cannot) return t.skip(cannot);
  const p = project('commands');
  const bash = (command: string) => tool('bash').run({ command }, p.ctx).then(String);

  assert.match(await bash('echo made > report.md && cat report.md && pwd'), /made/);
  assert.equal(fs.readFileSync(path.join(p.workspace, 'report.md'), 'utf8').trim(), 'made');
  assert.doesNotMatch(await bash(`cat ${p.secret}`), /KEY-commands/, 'a file outside the project cannot be read');
  await bash(`echo x > ${p.outside}; echo y > ${path.join(home, 'planted.txt')}`);
  assert.ok(!fs.existsSync(p.outside) && !fs.existsSync(path.join(home, 'planted.txt')), 'nothing can be written outside it');
  assert.doesNotMatch(await bash(`cat ${path.join(home, 'majordomo.db')} | head -c 20`), /SQLite/, '00Dojo’s own database is closed to it');
  assert.match(await bash('f=$(mktemp) && echo ok > "$f" && cat "$f"'), /ok/, 'temporary files have somewhere to go');
  assert.match(await bash('git init -q . && git config user.email a@b.c && echo fine'), /fine/, 'a project can be a git repository');

  // The other tools keep to the same line.
  await assert.rejects(tool('read_file').run({ path: p.secret }, p.ctx), /outside this project/);
  await assert.rejects(tool('list_files').run({ path: home }, p.ctx), /outside this project/);
  assert.match(String(await tool('read_file').run({ path: 'report.md' }, p.ctx)), /made/);
  assert.match(String(await tool('search_files').run({ pattern: 'made' }, p.ctx)), /report\.md/);
  assert.doesNotMatch(String(await tool('search_files').run({ pattern: 'KEY-', path: path.dirname(p.secret) }, p.ctx)), /KEY-commands/);

  // Unsandboxed, the same agent would have reached all of it: this is what the sandbox is for.
  const free = { ...p.ctx, sandbox: undefined };
  assert.match(String(await tool('bash').run({ command: `cat ${p.secret}` }, free)), /KEY-commands/);
});

test('one project’s agent cannot see into another project', async (t) => {
  if (cannot) return t.skip(cannot);
  const mine = await orch.orch.createProject({ name: 'Mine', goal: '' });
  const theirs = await orch.orch.createProject({ name: 'Theirs', goal: '' });
  fs.writeFileSync(path.join(theirs.workspace, 'plans.md'), 'THEIR-PLANS');
  const policy = sandbox.policyFor(mine);
  const ctx: ToolCtx = { agentId: 'T-1', cwd: mine.workspace, signal, host: { approve: async () => true } as never, sandbox: policy };
  const out = String(await tool('bash').run({ command: `cat ${path.join(theirs.workspace, 'plans.md')}; ls ${theirs.workspace} | wc -l` }, ctx));
  assert.doesNotMatch(out, /THEIR-PLANS/, 'its files cannot be read');
  assert.match(out, /\n0\n|cannot access|not permitted/, 'or even listed');
  await assert.rejects(tool('read_file').run({ path: path.join(theirs.workspace, 'plans.md') }, ctx), /outside this project/);
});

test('if the sandbox cannot start, the command is refused and does not run', async () => {
  const p = project('refused');
  sandbox._pretendUnavailable('It needs bubblewrap, which is not installed.');
  try {
    await assert.rejects(tool('bash').run({ command: 'echo ran > proof.txt' }, p.ctx), /was not run\. The sandbox is switched on and could not start: It needs bubblewrap[\s\S]*never run outside it/);
    await assert.rejects(tool('search_files').run({ pattern: 'x' }, p.ctx), /was not run/);
    assert.ok(!fs.existsSync(path.join(p.workspace, 'proof.txt')));
    const check = await sandbox.checkSandbox();
    assert.deepEqual([check.ok, check.problem], [false, 'It needs bubblewrap, which is not installed.']);
  } finally {
    sandbox._pretendUnavailable(null);
  }
});

test('the check tries the sandbox for real and says what it found', async (t) => {
  if (cannot) return t.skip(cannot);
  const check = await sandbox.checkSandbox();
  assert.equal(check.ok, true, JSON.stringify(check.probes.filter((p) => !p.ok)));
  assert.deepEqual(
    check.probes.filter((p) => p.required).map((p) => [p.name, p.ok]),
    [
      ['Runs a command', true],
      ['Can write in its own project folder', true],
      ['Cannot read a file outside it', true],
      ['Cannot write outside it', true],
      ['Cannot list your home folder', true],
    ],
  );
  assert.ok(!fs.existsSync(path.join(home, 'sandbox-check')), 'it clears up after itself');
  const seen = (await (await app.request('/api/sandbox', { headers: { host: 'localhost:4317' } })).json()) as { on: boolean; check: { ok: boolean } };
  assert.deepEqual([seen.on, seen.check.ok], [true, true]);
});

test('a whole project runs to the end with every agent sandboxed', async (t) => {
  if (cannot) return t.skip(cannot);
  orch.orch.chat('Plan the launch of my woodworking newsletter and draft the first issue');
  await until(() => db.tasks.all().filter((x) => !['Mine', 'Theirs'].includes(db.projects.get(x.projectId)?.name ?? '')).length === 4 && db.tasks.all().every((x) => x.status === 'done') && !orch.runner.isBusy('pm') && !orch.runner.queued('pm'));
  const p = db.projects.all().find((x) => /woodworking/.test(x.name))!;
  assert.ok(fs.existsSync(path.join(p.workspace, 'SUMMARY.md')));
  // The demo agents check their work with a shell command; sandboxed, it still ran.
  const ran = db.tasks.byProject(p.id).flatMap((x) => db.events.list(x.id)).filter((e) => e.type === 'tool_result' && /build\/first-version\.md|total/.test(String(e.data.output)));
  assert.ok(ran.length > 0);
  assert.ok(!db.tasks.byProject(p.id).flatMap((x) => db.events.list(x.id)).some((e) => /was not run\. The sandbox/.test(JSON.stringify(e.data))));
});

test('switching it off in Settings, or with MAJORDOMO_SANDBOX, takes agents out of it', () => {
  assert.equal(sandbox.sandboxOn(), true, 'on unless someone says otherwise');
  settings.saveSettings({ ...settings.getSettings(), sandbox: false });
  assert.equal(sandbox.sandboxOn(), false);
  settings.saveSettings({ ...settings.getSettings(), sandbox: true });
  process.env.MAJORDOMO_SANDBOX = 'off';
  assert.equal(sandbox.sandboxOn(), false);
  process.env.MAJORDOMO_SANDBOX = 'on';
  assert.equal(spawnSync('true').status, 0);
});

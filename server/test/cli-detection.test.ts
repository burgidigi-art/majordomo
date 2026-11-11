import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { tempHome } from './helpers.ts';

// A pretend home folder and PATH, so the test controls exactly which programs exist.
tempHome();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majordomo-clihome-'));
const bin = path.join(home, 'elsewhere', 'bin');
process.env.HOME = home;
process.env.PATH = `${bin}:/usr/bin:/bin`;
delete process.env.MAJORDOMO_CLAUDE_BIN;

function program(file: string, versionLine: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${versionLine}"; exit 0; fi\necho "hermes: '$3' is not a \\\`hermes\\\` command." >&2\nexit 2\n`, { mode: 0o755 });
}

let settings: typeof import('../settings.ts');
let app: typeof import('../http.ts')['app'];
const claude = async () => (await settings.runtimeStatus()).find((r) => r.id === 'claude-code')!;
const check = async () =>
  (await (await app.request('/api/runtimes/claude-code/test', { method: 'POST', headers: { host: 'localhost:4317' } })).json()) as { ok: boolean; message: string };

before(async () => {
  settings = await import('../settings.ts');
  app = (await import('../http.ts')).app;
});

test('another program that answers to `claude` is not mistaken for Claude Code', async () => {
  // What a machine with Hermes Agent installed looks like: `claude` exists, but it is Hermes.
  program(path.join(bin, 'claude'), 'Hermes Agent v0.22.5+2469.g74195d3 (2026.9.24) · stable');
  const status = await claude();
  assert.equal(status.ready, false);
  assert.equal(status.detail, 'The `claude` command on this computer is a different program (Hermes Agent v0.22.5+2469.g74195d3 (2026.9.24) · stable), not Claude Code.');

  // Checking the sign-in explains the problem instead of running the wrong program.
  const result = await check();
  assert.equal(result.ok, false);
  assert.match(result.message, /is a different program \(Hermes Agent .+\), not Claude Code\. Install Claude Code/);
  assert.ok(!result.message.includes('exited with code'));
});

test('the real Claude Code is found where its installer puts it, even with the name taken', async () => {
  const real = path.join(home, '.local', 'bin', 'claude');
  program(real, '2.1.322 (Claude Code)');
  settings.forgetCliProbe();
  const status = await claude();
  assert.equal(status.ready, true);
  assert.equal(status.detail, 'Found 2.1.322 (Claude Code) at ~/.local/bin/claude');
  assert.equal(settings.cliBinary('claude-code'), real, 'agents are launched with the verified program, not whatever the name resolves to');
});

test('a path given explicitly wins, and is still checked', async () => {
  const custom = path.join(home, 'tools', 'claude-custom');
  program(custom, '2.0.0 (Claude Code)');
  process.env.MAJORDOMO_CLAUDE_BIN = custom;
  settings.forgetCliProbe();
  assert.equal((await claude()).detail, `Found 2.0.0 (Claude Code) at ~/tools/claude-custom`);
  assert.equal(settings.cliBinary('claude-code'), custom);

  process.env.MAJORDOMO_CLAUDE_BIN = path.join(bin, 'claude');
  settings.forgetCliProbe();
  assert.equal((await claude()).ready, false, 'pointing it at the wrong program does not make that program Claude Code');
  delete process.env.MAJORDOMO_CLAUDE_BIN;
});

test('with nothing installed it simply says so', async () => {
  fs.rmSync(path.join(bin, 'claude'));
  fs.rmSync(path.join(home, '.local'), { recursive: true });
  settings.forgetCliProbe();
  const status = await claude();
  assert.deepEqual([status.ready, status.detail], [false, 'Not installed, or not where Majordomo looks for it']);
});

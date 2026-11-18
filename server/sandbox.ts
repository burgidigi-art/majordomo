// The sandbox: keeps each agent to its own project folder.
//
// With it on, the commands an agent runs, and the files it opens, are limited by the operating
// system rather than by asking the model to behave:
//
//   - It can read and write its own project's workspace, and a scratch folder for temporary files.
//   - It can read, but not change, its skills and the programs it needs to run (node, python, git…).
//   - It cannot read anything else in the user's home folder: other projects, 00Dojo's own data and
//     saved keys, documents, SSH and cloud keys, browser profiles.
//   - It cannot write anywhere else at all.
//
// Network access is left alone; this is about files.
//
// Two mechanisms do the work. Agents on API accounts run their commands through Anthropic's sandbox
// runtime (Seatbelt on macOS, bubblewrap on Linux), the same one Claude Code uses. Agents that are
// Claude Code are told to switch on Claude Code's own sandbox with the same rules.
//
// If the sandbox is on but cannot start, commands are refused. Nothing quietly runs outside it.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SandboxCheck, SandboxProbe } from '../shared/types.ts';
import { DATA_DIR, projects } from './db.ts';
import { getSettings } from './settings.ts';

export interface SandboxPolicy {
  /** The project's own folder: read and write. */
  workspace: string;
  /** Scratch space for temporary files and package caches: read and write. */
  tmp: string;
  /** Where the agent's skills live: read only. */
  skills: string[];
  /** Programs under the home folder that commands need in order to run: read only. */
  toolchains: string[];
  /** Hidden entirely, apart from the folders above when they sit inside one of these. */
  denied: string[];
}

export class SandboxError extends Error {}

/** On unless switched off in Settings. MAJORDOMO_SANDBOX=off overrides that, for tests and for a machine that cannot run it. */
export const sandboxOn = (): boolean => !/^(off|0|false|no)$/i.test(process.env.MAJORDOMO_SANDBOX ?? '') && getSettings().sandbox !== false;

/** A path with symlinks resolved; for one that does not exist yet, as far up as it does. */
export function real(p: string): string {
  let probe = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...rest);
    } catch {
      const up = path.dirname(probe);
      if (up === probe) return path.resolve(p);
      rest.unshift(path.basename(probe));
      probe = up;
    }
  }
}

const within = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * What to hide. Normally every user's home folder: on a Mac that is /Users, which also covers
 * other accounts and the shared folder.
 */
export function homeRoot(home = os.homedir()): string {
  const resolved = real(home);
  const parent = path.dirname(resolved);
  return ['Users', 'home'].includes(path.basename(parent)) && path.dirname(parent) === path.parse(parent).root ? parent : resolved;
}

/** Folders directly inside the home folder that are never opened up, whatever PATH says. */
const NEVER = new Set(['Documents', 'Desktop', 'Downloads', 'Library', 'Pictures', 'Movies', 'Music', '.ssh', '.aws', '.gnupg', '.config', '.majordomo', '.claude', '.kube', '.docker']);
/** Version managers and the like, readable when present so the programs they install can run. */
const KNOWN_TOOLCHAINS = ['.nvm', '.volta', '.asdf', '.pyenv', '.rbenv', '.rustup', '.cargo', '.bun', '.deno', '.sdkman', '.local/share/mise', '.local/share/uv', '.local/pipx', '.local/share/pipx', '.gitconfig', '.config/git'];

/** Settings that point programs at the certificates they trust; some setups keep those in the home folder. */
const CERTIFICATE_VARS = ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO', 'PIP_CERT', 'AWS_CA_BUNDLE'];

/**
 * The programs under the home folder that a command may need: whatever PATH points at there, and
 * the usual version managers. Readable, never writable.
 */
export function toolchainDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const base = real(home);
  const found = new Set<string>();
  for (const entry of (env.PATH ?? '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const dir = real(entry);
    if (!within(base, dir) || dir === base) continue;
    found.add(dir);
    // The folder above a bin/ usually holds what the programs in it load (lib, node_modules, versions).
    const parent = path.dirname(dir);
    const top = path.relative(base, parent).split(path.sep)[0] ?? '';
    const sensitive = parent === base || (path.dirname(parent) === base && (NEVER.has(top) || top === '.local'));
    if (['bin', 'shims'].includes(path.basename(dir)) && !sensitive) found.add(parent);
  }
  for (const rel of KNOWN_TOOLCHAINS) found.add(path.join(base, rel));
  // Certificate bundles are public, and without them nothing inside can make a secure connection.
  for (const name of CERTIFICATE_VARS) {
    const file = env[name];
    if (file && path.isAbsolute(file) && within(base, real(file))) found.add(real(file));
  }
  return [...found].filter((dir) => fs.existsSync(dir) && !NEVER.has(path.relative(base, dir)));
}

/** The rules for one project's agents. */
export function policyFor(project: { id: string; workspace: string }, skillDirs: string[] = []): SandboxPolicy {
  const workspace = real(project.workspace);
  const root = homeRoot();
  const tmp = path.join(real(os.tmpdir()), '00dojo', project.id.replace(/[^\w.-]/g, '_'));
  fs.mkdirSync(tmp, { recursive: true });
  // Places that hold private things but may sit outside the home folder: 00Dojo's own data, and
  // other projects' folders.
  const elsewhere = [real(DATA_DIR), ...projects.all().filter((p) => p.id !== project.id).map((p) => real(p.workspace))].filter(
    (dir) => !within(root, dir) && !within(workspace, dir),
  );
  return {
    workspace,
    tmp,
    skills: skillDirs.filter((dir) => fs.existsSync(dir)).map(real),
    toolchains: toolchainDirs().map(real),
    denied: [...new Set([root, ...elsewhere])],
  };
}

const openDirs = (policy: SandboxPolicy): string[] => [policy.workspace, policy.tmp, ...policy.skills, ...policy.toolchains];

/** Whether an agent under this policy may read a file. The same answer the operating system gives its commands. */
export function mayRead(policy: SandboxPolicy, file: string): boolean {
  const target = real(file);
  if (openDirs(policy).some((dir) => within(dir, target))) return true;
  return !policy.denied.some((dir) => within(dir, target));
}

// ---------- commands run by agents on API accounts ----------

export function sandboxKind(): 'seatbelt' | 'bubblewrap' | null {
  return process.platform === 'darwin' ? 'seatbelt' : process.platform === 'linux' ? 'bubblewrap' : null;
}

let forced: string | null = null;
/** For tests: behave as if the sandbox could not start, for the given reason. Null undoes it. */
export function _pretendUnavailable(reason: string | null): void {
  forced = reason;
}

/** Why the sandbox cannot run commands here, or null when it can. */
export function unavailableReason(): string | null {
  if (forced) return forced;
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    return `It needs Node 22.12 or newer, and 00Dojo is running on Node ${process.versions.node}. Update Node, then run 00Dojo again.`;
  }
  if (process.platform === 'darwin') {
    return fs.existsSync('/usr/bin/sandbox-exec') ? null : 'macOS’s sandbox tool (/usr/bin/sandbox-exec) is missing.';
  }
  if (process.platform === 'linux') {
    const has = (tool: string) => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0;
    return has('bwrap') ? null : 'It needs bubblewrap, which is not installed (on Ubuntu or Debian: sudo apt-get install bubblewrap).';
  }
  return 'It is only available on macOS and Linux.';
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Turns a shell command into one that runs inside the sandbox. Throws a SandboxError when the
 * sandbox cannot be used, so the caller can refuse to run the command at all.
 */
export async function wrap(command: string, policy: SandboxPolicy): Promise<string> {
  const reason = unavailableReason();
  if (reason) throw new SandboxError(reason);
  // Temporary files and package caches would otherwise go to places the sandbox does not allow.
  const cache = path.join(policy.tmp, 'cache');
  const inner =
    `export TMPDIR=${q(policy.tmp)} XDG_CACHE_HOME=${q(cache)} npm_config_cache=${q(path.join(cache, 'npm'))} ` +
    `PIP_CACHE_DIR=${q(path.join(cache, 'pip'))} UV_CACHE_DIR=${q(path.join(cache, 'uv'))} GOCACHE=${q(path.join(cache, 'go'))} YARN_CACHE_FOLDER=${q(path.join(cache, 'yarn'))}\n${command}`;
  const readConfig = { denyOnly: policy.denied, allowWithinDeny: openDirs(policy) };
  try {
    // Loaded here, not at the top: the runtime is large, and is not needed until an agent runs a command.
    const { getDefaultWritePaths } = await import('@anthropic-ai/sandbox-runtime');
    const own = getDefaultWritePaths({ denyRead: policy.denied, allowRead: openDirs(policy) });
    const writeConfig = { allowOnly: [policy.workspace, policy.tmp, ...own], denyWithinAllow: [] as string[] };
    const params = { command: inner, needsNetworkRestriction: false, readConfig, writeConfig, allowGitConfig: true, binShell: '/bin/bash' };
    if (process.platform === 'darwin') {
      const mac = await import('@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js');
      return mac.wrapCommandWithSandboxMacOS(params);
    }
    const linux = await import('@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js');
    return await linux.wrapCommandWithSandboxLinux(params);
  } catch (err) {
    throw new SandboxError(`The sandbox could not be set up: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** What an agent is told when its command was refused because the sandbox could not start. */
export const refusal = (err: SandboxError): string =>
  `This command was not run. The sandbox is switched on and could not start: ${err.message} ` +
  'Commands are never run outside it. Tell your manager; the user can fix the cause, or switch the sandbox off under Settings → How agents work.';

// ---------- agents that are Claude Code ----------

/**
 * Sites a sandboxed Claude Code command may reach. Claude Code's sandbox always limits the network
 * to a list; these are the package registries and code hosts that building software needs. Its
 * own web tools are not affected.
 */
const COMMAND_HOSTS = [
  'registry.npmjs.org', '*.npmjs.org', 'npmjs.com', '*.npmjs.com', 'registry.yarnpkg.com', 'nodejs.org', '*.nodejs.org', 'jsr.io', '*.jsr.io', 'deno.land', 'bun.sh',
  'pypi.org', '*.pypi.org', 'files.pythonhosted.org', 'astral.sh', '*.astral.sh',
  'github.com', '*.github.com', '*.githubusercontent.com', 'gitlab.com', '*.gitlab.com', 'bitbucket.org', '*.bitbucket.org',
  'crates.io', '*.crates.io', 'static.rust-lang.org', 'proxy.golang.org', 'sum.golang.org', 'go.dev', 'rubygems.org', '*.rubygems.org', 'repo.maven.apache.org',
  'formulae.brew.sh', 'ghcr.io', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'huggingface.co', '*.huggingface.co',
];

/**
 * Settings that make a Claude Code worker keep to the same rules, for one session. Its shell runs
 * in Claude Code's own sandbox, and its file tools are held to the workspace and its skills.
 */
export function claudeCodeSettings(policy: SandboxPolicy): object {
  return {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      // There is nobody to ask in a headless run; without this a blocked action waits for an answer.
      denyInsteadOfPrompting: true,
      // Skills are passed as extra working directories so they can be read. They are not to be edited.
      deny: policy.skills.map((dir) => `Edit(/${dir}/**)`),
    },
    sandbox: {
      enabled: true,
      // Refuse to run rather than run without it.
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: policy.denied,
        allowRead: [policy.workspace, ...policy.skills, ...policy.toolchains],
        denyWrite: [...policy.skills, ...policy.toolchains],
      },
      network: { allowedDomains: COMMAND_HOSTS },
    },
  };
}

// ---------- checking that it works on this computer ----------

let lastCheck: SandboxCheck | null = null;
export const lastSandboxCheck = (): SandboxCheck | null => lastCheck;

function run(command: string, cwd: string): { output: string; code: number | null } {
  const res = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', timeout: 30_000 });
  return { output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim(), code: res.status };
}

/**
 * Tries the sandbox for real: runs commands through it that should work, and ones that must not.
 * This is how 00Dojo finds out, on the computer it is running on, whether agents are held in.
 */
export async function checkSandbox(): Promise<SandboxCheck> {
  const base = path.join(DATA_DIR, 'sandbox-check');
  const kind = sandboxKind();
  const done = (probes: SandboxProbe[], problem = ''): SandboxCheck => {
    const required = probes.filter((p) => p.required);
    lastCheck = { at: Date.now(), kind, ok: !problem && required.length > 0 && required.every((p) => p.ok), problem, probes };
    return lastCheck;
  };
  const reason = unavailableReason();
  if (reason) return done([], reason);

  fs.rmSync(base, { recursive: true, force: true });
  const workspace = path.join(base, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const token = randomBytes(8).toString('hex');
  const secret = path.join(base, 'secret.txt');
  const outside = path.join(base, 'written-from-inside.txt');
  fs.writeFileSync(secret, token);
  // The check folder stands in for "everything else": it is hidden even when 00Dojo's data is kept outside the home folder.
  const policy = policyFor({ id: 'sandbox-check', workspace });
  policy.denied = [...new Set([...policy.denied, real(base)])];

  const probes: SandboxProbe[] = [];
  const attempt = async (name: string, command: string, required: boolean, passed: (r: { output: string; code: number | null }) => boolean) => {
    try {
      const result = run(await wrap(command, policy), workspace);
      probes.push({ name, required, ok: passed(result), detail: result.output.replaceAll(token, '[the secret]').split('\n').slice(-3).join(' ').slice(0, 240) });
    } catch (err) {
      probes.push({ name, required, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  try {
    await attempt('Runs a command', 'echo sandbox-works', true, (r) => r.output.includes('sandbox-works'));
    await attempt('Can write in its own project folder', 'echo kept > note.txt && cat note.txt', true, (r) => r.output.includes('kept') && fs.existsSync(path.join(workspace, 'note.txt')));
    await attempt('Cannot read a file outside it', `cat ${q(secret)}`, true, (r) => !r.output.includes(token));
    await attempt('Cannot write outside it', `echo escaped > ${q(outside)}`, true, () => !fs.existsSync(outside));
    await attempt('Cannot list your home folder', `ls -A ${q(real(os.homedir()))} | head -5`, true, (r) => {
      const names = new Set(fs.readdirSync(os.homedir()).slice(0, 200));
      const seen = r.output.split('\n').filter((line) => names.has(line.trim()));
      // Folders that are opened up on purpose (a toolchain, the workspace's own parent) may show; the rest must not.
      return seen.every((name) => openDirs(policy).some((dir) => within(path.join(real(os.homedir()), name.trim()), dir)));
    });
    await attempt('Can run git', 'git --version', false, (r) => r.code === 0);
    await attempt('Can run node', 'node --version', false, (r) => r.code === 0);
    await attempt('Can reach the internet', 'curl -s -m 8 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/', false, (r) => /^[23]\d\d$/.test(r.output.slice(-3)));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  return done(probes);
}

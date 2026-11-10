import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { clip, defineTool, ToolError, type Tool } from './tool.ts';

// ---------- path handling ----------

function resolvePath(cwd: string, p: string): string {
  return path.resolve(cwd, p.startsWith('~/') ? path.join(process.env.HOME ?? '', p.slice(2)) : p);
}

/** Writes stay inside the workspace. Symlinked parents are resolved before the check. */
async function resolveForWrite(cwd: string, p: string): Promise<string> {
  const root = await fs.realpath(cwd);
  const target = path.resolve(root, p);
  let probe = path.dirname(target);
  for (;;) {
    try {
      probe = await fs.realpath(probe);
      break;
    } catch {
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
  }
  const rel = path.relative(root, probe);
  const lexical = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel) || lexical.startsWith('..') || path.isAbsolute(lexical)) {
    throw new ToolError(`"${p}" is outside the project workspace (${root}). File writes are limited to the workspace.`);
  }
  return target;
}

// ---------- shell ----------

export function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal },
): Promise<{ output: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1' },
    });
    const chunks: string[] = [];
    let size = 0;
    let timedOut = false;
    const collect = (b: Buffer) => {
      if (size > 400_000) return;
      const s = b.toString('utf8');
      size += s.length;
      chunks.push(s);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    opts.signal.addEventListener('abort', kill, { once: true });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', kill);
      resolve({ output: chunks.join(''), code, timedOut });
    };
    child.on('error', (err) => {
      chunks.push(`Failed to start shell: ${err.message}`);
      finish(127);
    });
    child.on('close', finish);
  });
}

const bash = defineTool({
  name: 'bash',
  description:
    'Run a shell command in the project workspace and return its combined stdout and stderr. ' +
    'Use it for anything a terminal can do: running code, git, installing packages, inspecting files.',
  input: z.object({
    command: z.string().describe('The command to run with bash -c.'),
    timeout_seconds: z.number().int().min(1).max(1800).optional().describe('Default 120.'),
  }),
  async run({ command, timeout_seconds }, ctx) {
    const ok = await ctx.host.approve(ctx.agentId, 'bash', command.split('\n')[0].slice(0, 140), command, ctx.signal);
    if (!ok) return 'The user declined this command. Do not retry it; find another way or explain what you need.';
    const res = await runShell(command, {
      cwd: ctx.cwd,
      timeoutMs: (timeout_seconds ?? 120) * 1000,
      signal: ctx.signal,
    });
    const tail = res.timedOut
      ? `\n[timed out after ${timeout_seconds ?? 120}s and was killed]`
      : res.code === 0
        ? ''
        : `\n[exit code ${res.code}]`;
    return clip(res.output.trimEnd() || '(no output)') + tail;
  },
});

// ---------- files ----------

const readFile = defineTool({
  name: 'read_file',
  description: 'Read a text file. Paths are relative to the project workspace; absolute paths also work.',
  input: z.object({
    path: z.string(),
    offset: z.number().int().min(1).optional().describe('First line to return, 1-based.'),
    limit: z.number().int().min(1).optional().describe('Maximum number of lines. Default 800.'),
  }),
  async run({ path: p, offset, limit }, ctx) {
    const file = resolvePath(ctx.cwd, p);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) throw new ToolError(`No such file: ${p}`);
    if (stat.isDirectory()) throw new ToolError(`${p} is a directory. Use list_files.`);
    if (stat.size > 8_000_000) throw new ToolError(`${p} is ${stat.size} bytes — too large to read whole. Use bash (head, rg).`);
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 4096).includes(0)) return `${p} looks like a binary file (${stat.size} bytes).`;
    const lines = buf.toString('utf8').split('\n');
    const start = (offset ?? 1) - 1;
    const slice = lines.slice(start, start + (limit ?? 800));
    const more = start + slice.length < lines.length ? `\n… [${lines.length - start - slice.length} more lines]` : '';
    return clip(slice.join('\n'), 60_000) + more;
  },
});

const writeFile = defineTool({
  name: 'write_file',
  description: 'Create or overwrite a file inside the project workspace. Parent folders are created as needed.',
  input: z.object({ path: z.string(), content: z.string() }),
  async run({ path: p, content }, ctx) {
    const file = await resolveForWrite(ctx.cwd, p);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    return `Wrote ${path.relative(ctx.cwd, file) || p} (${content.length} characters).`;
  },
});

const editFile = defineTool({
  name: 'edit_file',
  description:
    'Replace an exact string in a workspace file. old_text must match exactly and be unique unless replace_all is set.',
  input: z.object({
    path: z.string(),
    old_text: z.string().min(1),
    new_text: z.string(),
    replace_all: z.boolean().optional(),
  }),
  async run({ path: p, old_text, new_text, replace_all }, ctx) {
    const file = await resolveForWrite(ctx.cwd, p);
    const before = await fs.readFile(file, 'utf8').catch(() => null);
    if (before === null) throw new ToolError(`No such file: ${p}`);
    const count = before.split(old_text).length - 1;
    if (count === 0) throw new ToolError('old_text was not found in the file. Read the file and match it exactly.');
    if (count > 1 && !replace_all)
      throw new ToolError(`old_text occurs ${count} times. Add surrounding context to make it unique, or set replace_all.`);
    const after = replace_all ? before.split(old_text).join(new_text) : before.replace(old_text, () => new_text);
    await fs.writeFile(file, after, 'utf8');
    return `Edited ${p} (${replace_all ? count : 1} replacement${replace_all && count > 1 ? 's' : ''}).`;
  },
});

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target']);

export async function walk(root: string, dir: string, depth: number, out: string[], max: number): Promise<void> {
  if (out.length >= max) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= max) return;
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    if (e.isDirectory()) {
      out.push(`${rel}/`);
      if (depth > 1 && !SKIP_DIRS.has(e.name)) await walk(root, full, depth - 1, out, max);
    } else {
      out.push(rel);
    }
  }
}

const listFiles = defineTool({
  name: 'list_files',
  description: 'List files and folders under a path in the workspace.',
  input: z.object({
    path: z.string().optional().describe('Default: the workspace root.'),
    depth: z.number().int().min(1).max(6).optional().describe('How many levels deep. Default 2.'),
  }),
  async run({ path: p, depth }, ctx) {
    const dir = resolvePath(ctx.cwd, p ?? '.');
    const out: string[] = [];
    await walk(dir, dir, depth ?? 2, out, 400);
    if (!out.length) return '(empty)';
    return out.join('\n') + (out.length >= 400 ? '\n… [listing truncated at 400 entries]' : '');
  },
});

const searchFiles = defineTool({
  name: 'search_files',
  description: 'Search file contents with a regular expression (ripgrep when installed, grep otherwise).',
  input: z.object({
    pattern: z.string(),
    path: z.string().optional().describe('File or folder to search. Default: the workspace root.'),
    glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts".'),
  }),
  async run({ pattern, path: p, glob }, ctx) {
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const where = q(p ?? '.');
    const cmd =
      `if command -v rg >/dev/null 2>&1; then rg -n --no-heading -S --max-columns 300 ${glob ? `-g ${q(glob)}` : ''} -e ${q(pattern)} ${where} | head -200; ` +
      `else grep -rnIE ${glob ? `--include=${q(glob)}` : ''} --exclude-dir=node_modules --exclude-dir=.git -e ${q(pattern)} ${where} | head -200; fi`;
    const res = await runShell(cmd, { cwd: ctx.cwd, timeoutMs: 30_000, signal: ctx.signal });
    return clip(res.output.trimEnd() || 'No matches.');
  },
});

// ---------- web ----------

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(h)) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

export const webFetch = defineTool({
  name: 'web_fetch',
  description: 'Fetch a public web page or API URL and return its text content.',
  input: z.object({ url: z.string() }),
  async run({ url }, ctx) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolError(`Not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ToolError('Only http and https URLs can be fetched.');
    if (isPrivateHost(parsed.hostname)) throw new ToolError('web_fetch does not reach local or private-network addresses.');
    const res = await fetch(parsed, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; agent-fetch)', Accept: 'text/html,application/json,text/plain,*/*' },
      redirect: 'follow',
    });
    const type = res.headers.get('content-type') ?? '';
    if (!/text|json|xml|javascript/.test(type)) return `HTTP ${res.status}. Content type ${type || 'unknown'} is not text.`;
    const body = await res.text();
    const text = /html/.test(type) ? htmlToText(body) : body;
    return `HTTP ${res.status} ${parsed.href}\n\n${clip(text, 40_000)}`;
  },
});

// ---------- talking to the manager ----------

const reportProgress = defineTool({
  name: 'report_progress',
  description:
    'Post a one-line status note to the dashboard so your manager and the user can see where you are. ' +
    'Call it when you start a new phase of the work.',
  input: z.object({ note: z.string().max(200) }),
  async run({ note }, ctx) {
    ctx.host.progress(ctx.agentId, note);
    return 'Noted.';
  },
});

const askManager = defineTool({
  name: 'ask_manager',
  description:
    'Ask your manager a question and wait for the answer. Use it only when you are blocked on a decision or ' +
    'information you cannot find or reasonably assume yourself. State what you tried and what you need.',
  input: z.object({ question: z.string() }),
  async run({ question }, ctx) {
    return ctx.host.askManager(ctx.agentId, question, ctx.signal);
  },
});

const delegate = defineTool({
  name: 'delegate',
  description:
    'Hand independent pieces of your task to helper agents that run in parallel, and wait for their reports. ' +
    'Each helper starts with no context, so every brief must be complete on its own. Worth it for work that ' +
    'splits cleanly (several sources to read, several files to produce); not for small steps.',
  input: z.object({
    tasks: z
      .array(
        z.object({
          title: z.string(),
          brief: z.string().describe('Everything the helper needs: goal, context, constraints, what to return.'),
          crew: z.string().optional().describe('Crew member to use. Defaults to your own.'),
        }),
      )
      .min(1)
      .max(6),
  }),
  async run({ tasks }, ctx) {
    return ctx.host.delegate(ctx.agentId, tasks, ctx.signal);
  },
});

export function workerTools(opts: { canDelegate: boolean }): Tool[] {
  const tools: Tool[] = [bash, readFile, writeFile, editFile, listFiles, searchFiles, webFetch, reportProgress, askManager];
  if (opts.canDelegate) tools.push(delegate);
  return tools;
}

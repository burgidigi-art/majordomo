import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrewProfile, FileEntry, ModelOption, RuntimeId, Settings, StreamMessage, VoiceSettings } from '../shared/types.ts';
import { runCliTurn } from './agents/cli.ts';
import { emit, subscribe, sync } from './bus.ts';
import { events, memory, projects, reminders, tasks } from './db.ts';
import { inboxFile, mimeOf } from './inbox.ts';
import { describeError, listModels } from './llm/index.ts';
import { telegram } from './gateways/telegram.ts';
import { mcpEndpoint } from './mcp.ts';
import { orch, runner, tick } from './orchestrator.ts';
import {
  forgetCliProbe,
  getSettings,
  isKeyedRuntime,
  runtimeDef,
  runtimeStatus,
  saveSettings,
  setSecret,
} from './settings.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const TOKEN = process.env.MAJORDOMO_TOKEN || '';

export const app = new Hono();

// ---------- access control ----------
// The server can run shell commands, so it must only ever answer its own dashboard:
// reject requests whose Host is not loopback (DNS rebinding) or whose Origin is another site (CSRF).

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname === '/mcp') return next();
  const hostname = (c.req.header('host') ?? '').replace(/:\d+$/, '');
  if (!LOOPBACK.has(hostname)) {
    // Reached over the network: only with an access token.
    if (!TOKEN) return c.text('Majordomo only accepts connections from this computer. Set MAJORDOMO_TOKEN to allow remote access.', 403);
    const given = url.searchParams.get('token') ?? c.req.header('authorization')?.replace(/^Bearer /, '') ?? cookie(c.req.header('cookie'), 'mj_token');
    if (given !== TOKEN) return c.text('Access token required.', 401);
    if (url.searchParams.has('token')) c.header('Set-Cookie', `mj_token=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  }
  const origin = c.req.header('origin');
  if (origin && c.req.method !== 'GET') {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      /* malformed origin is treated as foreign */
    }
    // In development the dashboard is served by Vite on another loopback port.
    const sameSite = originHost === c.req.header('host') || LOOPBACK.has(originHost.replace(/:\d+$/, ''));
    if (!sameSite) return c.text('Cross-site request refused.', 403);
  }
  return next();
});

function cookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((p) => p.trim().split('='))
    .find(([k]) => k === name)?.[1];
}

app.onError((err, c) => c.json({ error: describeError(err) }, 400));

// ---------- state + live stream ----------

app.get('/api/state', async (c) => c.json(await orch.state()));

app.get('/api/stream', (c) =>
  streamSSE(c, async (stream) => {
    const queue: StreamMessage[] = [{ kind: 'hello' }];
    let wake: (() => void) | null = null;
    const unsubscribe = subscribe((msg) => {
      queue.push(msg);
      wake?.();
    });
    let open = true;
    stream.onAbort(() => {
      open = false;
      unsubscribe();
      wake?.();
    });
    while (open) {
      while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 20_000);
      });
      wake = null;
      if (open && !queue.length) await stream.writeSSE({ event: 'ping', data: '' });
    }
  }),
);

app.get('/api/agents/:id/events', (c) => {
  const before = Number(c.req.query('before')) || undefined;
  return c.json(events.list(c.req.param('id'), { before, limit: Number(c.req.query('limit')) || 400 }));
});

// ---------- talking to the PM ----------

app.post('/api/chat', async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: 'Say something first.' }, 400);
  orch.chat(text.trim());
  return c.json({ ok: true });
});

app.post('/api/pm/stop', (c) => {
  orch.stopPm();
  return c.json({ ok: true });
});

app.post('/api/pm/reset', (c) => {
  orch.resetPm();
  return c.json({ ok: true });
});

// ---------- projects and tasks ----------

app.post('/api/projects', async (c) => {
  const body = await c.req.json<{ name: string; goal?: string; workspacePath?: string }>();
  if (!body.name?.trim()) return c.json({ error: 'A project needs a name.' }, 400);
  return c.json(await orch.createProject({ name: body.name.trim(), goal: body.goal ?? '', workspacePath: body.workspacePath || undefined }));
});

app.patch('/api/projects/:id', async (c) => {
  const patch = await c.req.json();
  const allowed = Object.fromEntries(Object.entries(patch).filter(([k]) => ['name', 'goal', 'status', 'notes'].includes(k)));
  return c.json(orch.updateProject(c.req.param('id'), allowed));
});

app.delete('/api/projects/:id', (c) => {
  orch.deleteProject(c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/api/tasks/:id/cancel', (c) => {
  orch.userCancelled(c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/api/tasks/:id/retry', (c) => {
  orch.retryTask(c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/api/tasks/:id/message', async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: 'Empty message.' }, 400);
  orch.messageTask(c.req.param('id'), text.trim(), 'user');
  return c.json({ ok: true });
});

app.post('/api/approvals/:id', async (c) => {
  const { approve } = await c.req.json<{ approve: boolean }>();
  orch.resolveApproval(c.req.param('id'), !!approve);
  return c.json({ ok: true });
});

app.delete('/api/memory/:id', (c) => {
  memory.remove(c.req.param('id'));
  orch.memoryChanged();
  return c.json({ ok: true });
});

app.delete('/api/reminders/:id', (c) => {
  reminders.remove(c.req.param('id'));
  orch.remindersChanged();
  return c.json({ ok: true });
});

// ---------- workspace files ----------

async function inWorkspace(projectId: string, rel: string): Promise<string> {
  const project = projects.get(projectId);
  if (!project) throw new Error('No such project.');
  const root = await fs.realpath(project.workspace);
  const target = await fs.realpath(path.resolve(root, rel || '.'));
  const within = path.relative(root, target);
  if (within.startsWith('..') || path.isAbsolute(within)) throw new Error('That path is outside the project workspace.');
  return target;
}

app.get('/api/projects/:id/files', async (c) => {
  const rel = c.req.query('path') ?? '';
  const dir = await inWorkspace(c.req.param('id'), rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const stat = await fs.stat(path.join(dir, e.name)).catch(() => null);
    if (!stat) continue;
    out.push({ name: e.name, path: path.join(rel, e.name), dir: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs });
  }
  out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return c.json(out);
});

app.get('/api/projects/:id/file', async (c) => {
  const file = await inWorkspace(c.req.param('id'), c.req.query('path') ?? '');
  const stat = await fs.stat(file);
  if (stat.size > 2_000_000) return c.json({ content: '', size: stat.size, note: 'File is too large to preview.' });
  const buf = await fs.readFile(file);
  if (buf.subarray(0, 4096).includes(0)) return c.json({ content: '', size: stat.size, note: 'Binary file — no preview.' });
  return c.json({ content: buf.toString('utf8'), size: stat.size });
});

// ---------- files the user sent in ----------

app.get('/api/inbox/:name', async (c) => {
  const file = await inboxFile(c.req.param('name'));
  if (!file) return c.json({ error: 'No such file.' }, 404);
  const mime = mimeOf(file);
  const body = await fs.readFile(file);
  // Only plain images are shown in the page; anything else is offered as a download, never rendered,
  // so a file sent in from outside can't run as script on the dashboard's origin.
  const inline = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime);
  return c.body(body, 200, {
    'Content-Type': inline ? mime : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${path.basename(file).replace(/[^\w.-]/g, '_')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
  });
});

// ---------- settings, accounts, models ----------

async function pushSettings(): Promise<void> {
  const state = await orch.state();
  // Telegram's status rides along: saving or removing a key changes what can transcribe voice notes.
  sync({ settings: state.settings, runtimes: state.runtimes, demo: state.demo, telegram: state.telegram });
}

app.put('/api/settings', async (c) => {
  const next = saveSettings({ ...getSettings(), ...(await c.req.json<Partial<Settings>>()) });
  await pushSettings();
  tick();
  return c.json(next);
});

app.put('/api/runtimes/:id/key', async (c) => {
  const id = c.req.param('id');
  if (!isKeyedRuntime(id)) return c.json({ error: 'That runtime does not use an API key.' }, 400);
  const { key } = await c.req.json<{ key: string }>();
  if (!key?.trim()) return c.json({ error: 'Paste a key first.' }, 400);
  setSecret(id, key);
  await pushSettings();
  return c.json({ ok: true });
});

app.delete('/api/runtimes/:id/key', async (c) => {
  const id = c.req.param('id');
  if (isKeyedRuntime(id)) setSecret(id, null);
  await pushSettings();
  return c.json({ ok: true });
});

const CLI_MODEL_HINTS: Partial<Record<RuntimeId, ModelOption[]>> = {
  'claude-code': [
    { id: '', label: 'CLI default' },
    { id: 'opus', label: 'opus (latest Opus)' },
    { id: 'sonnet', label: 'sonnet (latest Sonnet)' },
    { id: 'haiku', label: 'haiku (latest Haiku)' },
    { id: 'fable', label: 'fable (latest Fable)' },
  ],
  codex: [{ id: '', label: 'CLI default' }],
  'gemini-cli': [{ id: '', label: 'CLI default' }],
};

app.get('/api/runtimes/:id/models', async (c) => {
  const id = c.req.param('id') as RuntimeId;
  if (runtimeDef(id).kind === 'cli') return c.json(CLI_MODEL_HINTS[id] ?? []);
  return c.json(await listModels(id));
});

/** Check that an account actually works: list models for an API key, run a one-word prompt for a CLI login. */
app.post('/api/runtimes/:id/test', async (c) => {
  const id = c.req.param('id') as RuntimeId;
  const def = runtimeDef(id);
  try {
    if (def.kind === 'api') {
      const models = await listModels(id);
      return c.json({ ok: true, message: `Connected — ${models.length} models available.` });
    }
    forgetCliProbe();
    const agentId = `probe:${Date.now()}`;
    try {
      const res = await runCliTurn({
        agentId,
        runtime: id,
        model: '',
        cwd: (await orch.state()).settings.workspaceRoot,
        prompt: 'Reply with the single word READY and nothing else.',
        manager: true,
        signal: AbortSignal.timeout(90_000),
      });
      return c.json({ ok: true, message: `Signed in — the CLI answered “${res.text.slice(0, 40)}”.` });
    } finally {
      events.clear(agentId);
    }
  } catch (err) {
    return c.json({ ok: false, message: describeError(err) });
  }
});

/** One-step setup: make this account the PM and replace the demo crew with a real generalist. */
app.post('/api/setup/adopt', async (c) => {
  const { runtime, model } = await c.req.json<{ runtime: RuntimeId; model: string }>();
  const def = runtimeDef(runtime);
  if (def.kind === 'api' && !model && !def.defaultModel) return c.json({ error: 'Choose a model first.' }, 400);
  const chosen = model || def.defaultModel;
  const s = getSettings();
  const effort = def.family === 'claude' ? ('high' as const) : null;
  const generalist: CrewProfile = {
    id: 'generalist',
    name: 'Generalist',
    strengths: 'Capable all-rounder: research, code, writing, analysis.',
    runtime,
    model: chosen,
    effort,
  };
  const realCrew = s.crew.filter((m) => m.runtime !== 'demo' && m.id !== 'generalist');
  saveSettings({
    ...s,
    pm: { runtime, model: chosen, effort },
    crew: [generalist, ...realCrew],
    defaultCrewId: 'generalist',
  });
  // The PM's conversation belongs to the runtime that held it; start clean on the new one.
  if (s.pm.runtime !== runtime) {
    runner.reset('pm');
    emit('pm', 'notice', { text: `Your manager now runs on ${def.label}. This is a fresh conversation; projects and memory carry over.` });
  }
  await pushSettings();
  return c.json({ ok: true });
});

// ---------- phone (Telegram) ----------

app.put('/api/telegram', async (c) => {
  const body = await c.req.json<{ token?: string; notify?: boolean; voice?: Partial<VoiceSettings> }>();
  if (typeof body.notify === 'boolean') telegram.setNotify(body.notify);
  if (body.voice && typeof body.voice === 'object') telegram.setVoice(body.voice);
  if (typeof body.token === 'string') {
    const token = body.token.trim();
    // A bot token looks like 123456789:AA…; catch a mis-paste before it becomes a confusing error.
    if (!/^\d+:[\w-]{20,}$/.test(token)) return c.json({ error: 'That does not look like a bot token. BotFather gives you one shaped like 123456789:AAE…' }, 400);
    telegram.setToken(token);
  }
  return c.json(telegram.status());
});

app.delete('/api/telegram', (c) => {
  telegram.setToken(null);
  return c.json(telegram.status());
});

app.post('/api/telegram/pair-code', (c) => {
  telegram.newPairCode();
  return c.json(telegram.status());
});

app.delete('/api/telegram/chats/:id', (c) => {
  telegram.unpair(Number(c.req.param('id')));
  return c.json(telegram.status());
});

app.all('/mcp', mcpEndpoint);

// ---------- the built dashboard ----------

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
};

app.get('*', async (c) => {
  const pathname = decodeURIComponent(new URL(c.req.url).pathname);
  const candidate = path.join(DIST, pathname);
  const safe = candidate.startsWith(DIST) ? candidate : DIST;
  for (const file of [safe, path.join(DIST, 'index.html')]) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      const body = await fs.readFile(file);
      const immutable = file.includes(`${path.sep}assets${path.sep}`);
      return c.body(body, 200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    } catch {
      /* try the next candidate */
    }
  }
  return c.text('The dashboard has not been built yet. Run `npm run build`, or use `npm run dev`.', 503);
});

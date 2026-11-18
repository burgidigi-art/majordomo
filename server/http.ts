import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrewProfile, FileEntry, ModelOption, RuntimeId, Settings, StreamMessage, VoiceSettings } from '../shared/types.ts';
import { runCliTurn } from './agents/cli.ts';
import { emit, subscribe, sync } from './bus.ts';
import { DATA_DIR, events, memory, projects, reminders, tasks } from './db.ts';
import { disconnect as disconnectGoogle, finishSignIn, googleStatus, saveClient, startSignIn } from './google.ts';
import { inboxFile, mimeOf } from './inbox.ts';
import { describeError, listModels } from './llm/index.ts';
import { alerts } from './alerts.ts';
import { finishPluginSignIn } from './plugin-auth.ts';
import { addOwnServer, afterSignIn, pluginList, removeOwnServer, setPluginsEnabled, signInToPlugin, signOutOfPlugin, testPlugin } from './plugins.ts';
import { addRepo, listRepos, listSkills, removeRepo, searchSkillRepos, setSkillsEnabled, SKILLS_DIR, updateRepo } from './skills.ts';
import { speak } from './speech.ts';
import { refreshTrending } from './trending.ts';
import { resolveVoice, transcribe, uploadedAudio } from './gateways/transcribe.ts';
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
  // The MCP endpoints check their own token; CLI agents call them without a browser origin.
  if (url.pathname === '/mcp' || url.pathname === '/mcp/google' || url.pathname.startsWith('/mcp/worker/')) return next();
  const hostname = (c.req.header('host') ?? '').replace(/:\d+$/, '');
  if (!LOOPBACK.has(hostname)) {
    // Reached over the network: only with an access token.
    if (!TOKEN) return c.text('00Dojo only accepts connections from this computer. Set MAJORDOMO_TOKEN to allow remote access.', 403);
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

// A cheap check that this is 00Dojo and that it is answering; the Mac app polls it while starting up.
app.get('/api/health', (c) => c.json({ ok: true, app: 'majordomo' }));

// The mark in the sidebar and the browser tab. A personal icon set with `npm run set-icon` lives in
// the data folder and wins over the built-in drawing. A personal icon is a PNG with the margin macOS
// wants around an app icon (the tile is 824 of 1024 across), so it is wrapped in an SVG that crops to the tile.
const BUILT_IN_MARK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public/favicon.svg');
app.get('/api/brand.svg', async (c) => {
  const headers = { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' };
  const personal = path.join(DATA_DIR, 'icon');
  for (const file of [path.join(personal, 'icon-256.png'), path.join(personal, 'icon.png')]) {
    const png = await fs.readFile(file).catch(() => null);
    if (!png) continue;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 100 824 824">' +
      `<image width="1024" height="1024" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
    return c.body(svg, 200, headers);
  }
  const builtIn = await fs.readFile(BUILT_IN_MARK, 'utf8').catch(() => null);
  return builtIn ? c.body(builtIn, 200, headers) : c.text('No icon.', 404);
});

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
  sync({ settings: state.settings, runtimes: state.runtimes, demo: state.demo, telegram: state.telegram, speech: state.speech });
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
    const status = (await runtimeStatus()).find((r) => r.id === id);
    if (!status?.ready) return c.json({ ok: false, message: `${status?.detail ?? 'Not found.'} ${def.setupHint}` });
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

// ---------- dictation ----------

/** Speech typed into the dashboard: the browser records, the voice-note transcriber turns it into text. */
app.post('/api/transcribe', async (c) => {
  const kind = uploadedAudio(c.req.header('content-type') ?? '');
  if (!kind) return c.json({ error: 'That recording is in a format 00Dojo does not know.' }, 415);
  const bytes = Buffer.from(await c.req.arrayBuffer());
  if (!bytes.length) return c.json({ error: 'The recording was empty. Check that the microphone is allowed.' }, 400);
  if (bytes.length > 25 * 1024 * 1024) return c.json({ error: 'That recording is too long to transcribe. Keep it under about 20 minutes.' }, 413);
  const { backend, problem } = resolveVoice();
  if (!backend) return c.json({ error: problem }, 400);
  return c.json({ text: await transcribe({ bytes, ...kind }) });
});

// ---------- skills ----------

const skillsPayload = (force = false) => {
  const skills = listSkills(force);
  return { skills, repos: listRepos(), ownFolder: `${SKILLS_DIR}/own` };
};

app.get('/api/skills', (c) => c.json(skillsPayload(c.req.query('rescan') === '1')));

app.put('/api/skills', async (c) => {
  const body = await c.req.json<{ ids?: string[]; enabled?: boolean }>();
  if (!Array.isArray(body.ids) || typeof body.enabled !== 'boolean') return c.json({ error: 'Send ids and enabled.' }, 400);
  const known = new Set(listSkills().map((s) => s.id));
  setSkillsEnabled(body.ids.filter((id) => typeof id === 'string' && known.has(id)), body.enabled);
  return c.json(skillsPayload());
});

app.get('/api/skills/search', async (c) => {
  const sort = c.req.query('sort') === 'best' ? 'best' : 'stars';
  return c.json({ repos: await searchSkillRepos(c.req.query('q') ?? '', sort) });
});

app.post('/api/skills/repos', async (c) => {
  const body = await c.req.json<{ url?: string }>();
  await addRepo(String(body.url ?? ''));
  return c.json(skillsPayload(true));
});

app.post('/api/skills/repos/:id/update', async (c) => {
  await updateRepo(c.req.param('id'));
  return c.json(skillsPayload(true));
});

app.delete('/api/skills/repos/:id', (c) => {
  removeRepo(c.req.param('id'));
  return c.json(skillsPayload(true));
});

// ---------- plugin tools ----------

app.get('/api/plugins', (c) => c.json({ plugins: pluginList(c.req.query('rescan') === '1') }));

app.put('/api/plugins', async (c) => {
  const body = await c.req.json<{ ids?: string[]; enabled?: boolean }>();
  if (!Array.isArray(body.ids) || typeof body.enabled !== 'boolean') return c.json({ error: 'Send ids and enabled.' }, 400);
  const known = new Set(pluginList().map((p) => p.id));
  setPluginsEnabled(body.ids.filter((id) => known.has(id)), body.enabled);
  return c.json({ plugins: pluginList() });
});

app.post('/api/plugins', async (c) => {
  addOwnServer(await c.req.json());
  return c.json({ plugins: pluginList(true) });
});

app.delete('/api/plugins/:id', (c) => {
  removeOwnServer(c.req.param('id'));
  return c.json({ plugins: pluginList(true) });
});

app.post('/api/plugins/:id/sign-in', async (c) => c.json({ url: await signInToPlugin(c.req.param('id')) }));

app.delete('/api/plugins/:id/sign-in', (c) => {
  signOutOfPlugin(c.req.param('id'));
  return c.json({ plugins: pluginList() });
});

/** Where the browser comes back after signing in to a plugin. */
app.get('/api/plugins/oauth/callback', async (c) => {
  const escape = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const page = (title: string, body: string, ok: boolean) =>
    c.html(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>` +
        '<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0b0b0f;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}' +
        'main{max-width:420px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#aaa}a{color:#f3b65f}</style>' +
        `<main><h1>${ok ? '✓ ' : ''}${escape(title)}</h1><p>${escape(body)}</p><p><a href="/#/settings/plugins">Back to 00Dojo</a></p></main>` +
        (ok ? '<script>setTimeout(()=>window.close(),1500)</script>' : ''),
      ok ? 200 : 400,
    );
  try {
    const q = c.req.query();
    const done = await finishPluginSignIn({ code: q.code, state: q.state, error: q.error, error_description: q.error_description });
    afterSignIn(done.id);
    return page(`Signed in to ${done.name}`, 'Your agents can use it now. You can close this tab.', true);
  } catch (err) {
    return page('Sign-in did not finish', describeError(err), false);
  }
});

app.post('/api/plugins/:id/test', async (c) => {
  try {
    const result = await testPlugin(c.req.param('id'));
    return c.json({ ok: true, tools: result.tools, plugins: pluginList() });
  } catch (err) {
    return c.json({ ok: false, error: describeError(err), plugins: pluginList() });
  }
});

// ---------- what's hot ----------

/** The dashboard asks for a fresh list each time it is opened; a list under a minute old is reused. */
app.post('/api/trending/refresh', async (c) => c.json(await refreshTrending(c.req.query('force') === '1' ? 0 : 60_000)));

// ---------- voice mode ----------

/** A reply read aloud with OpenAI's voices. Without an OpenAI key the dashboard uses the computer's own. */
app.post('/api/speak', async (c) => {
  const body = await c.req.json<{ text?: string; voice?: string; speed?: number }>();
  const audio = await speak(String(body.text ?? ''), { voice: body.voice, speed: body.speed }, c.req.raw.signal);
  return c.body(new Uint8Array(audio), 200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
});

// ---------- alerts ----------

app.put('/api/alerts', async (c) => {
  const body = await c.req.json<{ mac?: boolean; phoneFailures?: boolean }>();
  alerts.set({ mac: body.mac, phoneFailures: body.phoneFailures });
  return c.json(alerts.status());
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

// ---------- email and calendar (Google) ----------

app.put('/api/google', async (c) => {
  const { clientId, clientSecret } = await c.req.json<{ clientId?: string; clientSecret?: string }>();
  saveClient(clientId ?? '', clientSecret ?? '');
  return c.json(googleStatus());
});

/** Send the browser to Google to sign in. */
app.get('/api/google/connect', (c) => c.redirect(startSignIn()));

/** Google sends the browser back here with a one-time code. */
app.get('/api/google/callback', async (c) => {
  await finishSignIn({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') });
  return c.redirect('/#/settings/google');
});

app.delete('/api/google', async (c) => {
  await disconnectGoogle(c.req.query('forget') === '1');
  return c.json(googleStatus());
});

app.all('/mcp', mcpEndpoint);
app.all('/mcp/google', mcpEndpoint);
app.all('/mcp/worker/:id', mcpEndpoint);

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

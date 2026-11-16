// Plugin tools for the whole crew. Plugins (MCP servers) the user already set up for Claude Code (its
// own settings and installed plugins), Claude Desktop, Codex or Hermes are found where those tools keep
// them, more can be added by hand, and Majordomo runs them itself. Every agent, on any account, reaches
// them through two tools: plugin_tools (what is there, and what each tool takes) and use_plugin_tool.
// Going through Majordomo means one place to switch them on and off, and that actions are approved
// the same way shell commands are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { PluginServer, PluginSource } from '../shared/types.ts';
import { parseToml, parseYaml } from './config-readers.ts';
import { kvGet, kvSet } from './db.ts';
import { McpClient, NeedsSignIn, type ClientOptions, type McpTool, type ServerDef } from './mcp-client.ts';
import { pluginAccessToken, pluginSignedIn, signOutPlugin, startPluginSignIn } from './plugin-auth.ts';
import { clip, defineTool, ToolError, type Tool } from './tools/tool.ts';

interface Found {
  /** Short handle agents use, unique across all plugins. */
  key: string;
  id: string;
  name: string;
  source: PluginSource;
  sourceLabel: string;
  def: ServerDef | null;
  /** Why it cannot be run, when def is null. */
  unsupported?: string;
  defaultOn: boolean;
}

const SOURCE_LABEL: Record<PluginSource, string> = {
  majordomo: 'Added here',
  claude: 'Claude Code',
  'claude-plugin': 'Claude Code plugins',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  hermes: 'Hermes',
};

// ---------- reading other tools' settings ----------

const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** ${VAR}, ${VAR:-default} and ${CLAUDE_PLUGIN_ROOT}, as Claude Code expands them. */
export function expand(value: string, vars: Record<string, string | undefined>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, dflt?: string) => vars[name] ?? process.env[name] ?? dflt ?? '');
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const stringMap = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : {};

/** One server entry, in the shape Claude Code, Claude Desktop, Codex and Hermes all roughly share. */
export function toDef(raw: any, vars: Record<string, string | undefined> = {}): { def: ServerDef | null; unsupported?: string } {
  if (!raw || typeof raw !== 'object') return { def: null, unsupported: 'Its settings could not be read.' };
  const x = (s: string) => expand(s, vars);
  const type = String(raw.type ?? raw.transport ?? '').toLowerCase();
  if (raw.url || raw.httpUrl || raw.serverUrl) {
    if (type === 'sse') return { def: null, unsupported: 'It uses the older SSE connection, which Majordomo does not support yet.' };
    const headers = Object.fromEntries(Object.entries({ ...stringMap(raw.headers), ...stringMap(raw.http_headers) }).map(([k, v]) => [k, x(v)]));
    // Codex names an environment variable that holds the bearer token.
    if (raw.bearer_token_env_var && process.env[String(raw.bearer_token_env_var)]) headers.Authorization = `Bearer ${process.env[String(raw.bearer_token_env_var)]}`;
    return { def: { transport: 'http', url: x(String(raw.url ?? raw.httpUrl ?? raw.serverUrl)), headers } };
  }
  if (raw.command) {
    return {
      def: {
        transport: 'stdio',
        command: x(String(raw.command)),
        args: strings(raw.args).map(x),
        env: Object.fromEntries(Object.entries(stringMap(raw.env)).map(([k, v]) => [k, x(v)])),
        cwd: raw.cwd ? x(String(raw.cwd)) : undefined,
      },
    };
  }
  return { def: null, unsupported: 'It has neither a command to run nor an address.' };
}

type Raw = { name: string; raw: any; vars?: Record<string, string>; off?: boolean };

/** Plugins installed into Claude Code that Claude Code has switched on, with where each lives. */
function claudePlugins(home: string): { name: string; dir: string }[] {
  const enabled = (readJson(path.join(home, '.claude', 'settings.json'))?.enabledPlugins ?? {}) as Record<string, boolean>;
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'))?.plugins;
  const out: { name: string; dir: string }[] = [];
  if (installed && typeof installed === 'object') {
    for (const [full, entry] of Object.entries<any>(installed)) {
      if (enabled[full] === false) continue;
      const list = Array.isArray(entry) ? entry : [entry];
      const dir = list.map((e) => e?.installPath).find((p) => typeof p === 'string' && fs.existsSync(p));
      if (dir) out.push({ name: full.split('@')[0]!, dir });
    }
    return out;
  }
  // No record of what is installed: take the newest copy of each plugin in Claude Code's cache.
  const cache = path.join(home, '.claude', 'plugins', 'cache');
  for (const market of safeDir(cache)) {
    for (const plugin of safeDir(path.join(cache, market))) {
      const versions = safeDir(path.join(cache, market, plugin))
        .map((v) => path.join(cache, market, plugin, v))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (versions[0] && enabled[`${plugin}@${market}`] !== false) out.push({ name: plugin, dir: versions[0] });
    }
  }
  return out;
}

function safeDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const serversIn = (json: any): Record<string, any> => (json?.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : json && typeof json === 'object' ? json : {});

function discover(home: string): { source: PluginSource; items: Raw[] }[] {
  const out: { source: PluginSource; items: Raw[] }[] = [];

  const claudeUser = readJson(path.join(home, '.claude.json'))?.mcpServers ?? {};
  out.push({ source: 'claude', items: Object.entries<any>(claudeUser).map(([name, raw]) => ({ name, raw })) });

  const fromPlugins: Raw[] = [];
  for (const p of claudePlugins(home)) {
    const vars = { CLAUDE_PLUGIN_ROOT: p.dir };
    const files: Record<string, any> = { ...serversIn(readJson(path.join(p.dir, '.mcp.json'))) };
    const manifest = readJson(path.join(p.dir, '.claude-plugin', 'plugin.json'));
    if (typeof manifest?.mcpServers === 'string') Object.assign(files, serversIn(readJson(path.resolve(p.dir, expand(manifest.mcpServers, vars)))));
    else if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') Object.assign(files, manifest.mcpServers);
    for (const [name, raw] of Object.entries<any>(files)) fromPlugins.push({ name: `${p.name} · ${name}`, raw, vars });
  }
  out.push({ source: 'claude-plugin', items: fromPlugins });

  const desktopFile =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  out.push({ source: 'claude-desktop', items: Object.entries<any>(readJson(desktopFile)?.mcpServers ?? {}).map(([name, raw]) => ({ name, raw })) });

  const codex = readText(path.join(home, '.codex', 'config.toml'));
  const codexServers = codex ? (parseToml(codex).mcp_servers ?? {}) : {};
  out.push({ source: 'codex', items: Object.entries<any>(codexServers).map(([name, raw]) => ({ name, raw, off: raw?.enabled === false })) });

  const hermes = readText(path.join(home, '.hermes', 'config.yaml'));
  let hermesServers: Record<string, any> = {};
  try {
    hermesServers = hermes ? (parseYaml(hermes)?.mcp_servers ?? {}) : {};
  } catch {
    hermesServers = {};
  }
  out.push({ source: 'hermes', items: Object.entries<any>(hermesServers ?? {}).map(([name, raw]) => ({ name, raw, off: raw?.enabled === false })) });

  out.push({ source: 'majordomo', items: ownServers().map((s) => ({ name: s.name, raw: s.raw })) });
  return out;
}

// ---------- servers added by hand ----------

interface Own {
  name: string;
  raw: { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
}

const ownServers = (): Own[] => kvGet<Own[]>('plugins:own', []);

/** Add a plugin by hand: a command to run (with its arguments) or an https address. */
export function addOwnServer(input: { name?: string; command?: string; url?: string; headers?: Record<string, string>; env?: Record<string, string> }): void {
  const name = String(input.name ?? '').trim();
  if (!/^[\w .-]{1,40}$/.test(name)) throw new Error('Give it a short name: letters, numbers, spaces, dots or dashes.');
  if (ownServers().some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a plugin called ${name}.`);
  let raw: Own['raw'];
  if (input.url?.trim()) {
    let u: URL;
    try {
      u = new URL(input.url.trim());
    } catch {
      throw new Error('That address is not a valid URL.');
    }
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('Use an https:// address.');
    raw = { url: u.toString(), headers: stringMap(input.headers) };
  } else if (input.command?.trim()) {
    const parts = splitCommand(input.command.trim());
    raw = { command: parts[0], args: parts.slice(1), env: stringMap(input.env) };
  } else {
    throw new Error('Enter the command that starts the plugin, or its address.');
  }
  kvSet('plugins:own', [...ownServers(), { name, raw }]);
  found = null;
}

export function removeOwnServer(id: string): void {
  const name = id.replace(/^majordomo:/, '');
  const list = ownServers();
  if (!list.some((s) => s.name === name)) throw new Error('Only plugins added here can be removed here.');
  kvSet('plugins:own', list.filter((s) => s.name !== name));
  disconnect(id);
  found = null;
}

/** Split a command line into words, honouring quotes. No shell is involved when it runs. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]!));
  return out;
}

// ---------- the list ----------

let found: { at: number; list: Found[] } | null = null;

const sameTarget = (a: ServerDef, b: ServerDef) =>
  a.transport === 'http' && b.transport === 'http'
    ? a.url === b.url
    : a.transport === 'stdio' && b.transport === 'stdio' && a.command === b.command && a.args.join('\0') === b.args.join('\0');

/** Every plugin found, once each: the same server set up in two tools is listed under the first. */
export function foundServers(force = false, home = os.homedir()): Found[] {
  if (!force && found && Date.now() - found.at < 30_000) return found.list;
  const list: Found[] = [];
  const keys = new Set<string>();
  for (const { source, items } of discover(home)) {
    for (const item of items) {
      const { def, unsupported } = toDef(item.raw, item.vars);
      if (def && list.some((f) => f.def && sameTarget(f.def, def))) continue;
      let key = item.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'plugin';
      for (let n = 2; keys.has(key); n++) key = `${key.replace(/-\d+$/, '')}-${n}`;
      keys.add(key);
      list.push({ key, id: `${source}:${item.name}`, name: item.name, source, sourceLabel: SOURCE_LABEL[source], def, unsupported, defaultOn: !item.off });
    }
  }
  found = { at: Date.now(), list };
  return list;
}

const enabledMap = () => kvGet<Record<string, boolean>>('plugins:enabled', {});
const isOn = (f: Found) => !!f.def && (enabledMap()[f.id] ?? f.defaultOn);

export function setPluginsEnabled(ids: string[], on: boolean): void {
  const map = enabledMap();
  for (const id of ids) {
    map[id] = on;
    if (!on) disconnect(id);
  }
  kvSet('plugins:enabled', map);
}

export function enabledPlugins(): Found[] {
  return foundServers().filter(isOn);
}

// ---------- running them ----------

interface Live {
  client: McpClient;
  tools: McpTool[];
  lastUsed: number;
}

const live = new Map<string, Live>();
const starting = new Map<string, Promise<Live>>();
const problems = new Map<string, { state: 'error' | 'needs-sign-in'; message: string }>();
const IDLE_MS = 10 * 60_000;

let makeClient = (def: ServerDef, opts: ClientOptions) => new McpClient(def, opts);
/** For tests: a stand-in for connecting to a server. */
export function _setClientFactory(fn: ((def: ServerDef, opts: ClientOptions) => McpClient) | null): void {
  makeClient = fn ?? ((def, opts) => new McpClient(def, opts));
}

/** A plugin at an address with no key of its own can be signed in to through the browser. */
const canSignIn = (f: Found) => f.def?.transport === 'http' && !Object.keys(f.def.headers).some((h) => h.toLowerCase() === 'authorization');

function cachedTools(id: string): { name: string; description: string }[] {
  // Cleared (stored as null) when the user signs out.
  return kvGet<{ name: string; description: string }[] | null>(`plugins:tools:${id}`, null) ?? [];
}

async function connect(f: Found): Promise<Live> {
  const have = live.get(f.id);
  if (have?.client.alive) {
    have.lastUsed = Date.now();
    return have;
  }
  const pending = starting.get(f.id);
  if (pending) return pending;
  if (!f.def) throw new Error(f.unsupported ?? 'This plugin cannot be run.');
  const attempt = (async () => {
    const client = makeClient(f.def!, canSignIn(f) ? { token: (force) => pluginAccessToken(f.id, force) } : {});
    try {
      await client.start();
      const tools = await client.listTools();
      const entry = { client, tools, lastUsed: Date.now() };
      live.set(f.id, entry);
      problems.delete(f.id);
      kvSet(
        `plugins:tools:${f.id}`,
        tools.map((t) => ({ name: t.name, description: t.description.slice(0, 200) })),
      );
      return entry;
    } catch (err) {
      client.close();
      const message = err instanceof Error ? err.message : String(err);
      problems.set(f.id, err instanceof NeedsSignIn ? { state: 'needs-sign-in', message } : { state: 'error', message });
      throw err instanceof NeedsSignIn
        ? new Error(
            canSignIn(f)
              ? `${f.name} needs the user to sign in to it: they can do that under Settings → Plugin tools, with the Sign in button.`
              : `${f.name} refused the key it was given. Check its settings in ${f.sourceLabel}.`,
          )
        : new Error(`${f.name} could not start: ${message}`);
    } finally {
      starting.delete(f.id);
    }
  })();
  starting.set(f.id, attempt);
  return attempt;
}

function disconnect(id: string): void {
  live.get(id)?.client.close();
  live.delete(id);
}

export function closeAllPlugins(): void {
  for (const id of [...live.keys()]) disconnect(id);
}

// Plugins nobody has used for a while are stopped; the next call starts them again.
setInterval(() => {
  for (const [id, entry] of live) if (Date.now() - entry.lastUsed > IDLE_MS) disconnect(id);
}, 60_000).unref();

/** Start a browser sign-in to a plugin; returns the page to open. */
export async function signInToPlugin(id: string): Promise<string> {
  const f = foundServers().find((x) => x.id === id);
  if (!f || !canSignIn(f) || f.def?.transport !== 'http') throw new Error('This plugin does not sign in through the browser.');
  return startPluginSignIn(f.id, f.name, f.def.url);
}

/** After signing in (or out), the next use connects afresh with the new sign-in. */
export function afterSignIn(id: string): void {
  disconnect(id);
  problems.delete(id);
}

export function signOutOfPlugin(id: string): void {
  signOutPlugin(id);
  disconnect(id);
  problems.delete(id);
  kvSet(`plugins:tools:${id}`, null);
}

/** Connect now and report what it offers: the Test button in Settings. */
export async function testPlugin(id: string): Promise<{ tools: { name: string; description: string }[] }> {
  const f = foundServers().find((x) => x.id === id);
  if (!f) throw new Error('Unknown plugin.');
  disconnect(id);
  const entry = await connect(f);
  return { tools: entry.tools.map((t) => ({ name: t.name, description: t.description })) };
}

// ---------- what the dashboard sees ----------

const mask = (s: string) => (s.length > 6 ? `${s.slice(0, 3)}…` : '…');

export function pluginList(force = false): PluginServer[] {
  return foundServers(force).map((f) => {
    const problem = problems.get(f.id);
    const running = live.get(f.id);
    const def = f.def;
    return {
      id: f.id,
      key: f.key,
      name: f.name,
      source: f.source,
      sourceLabel: f.sourceLabel,
      enabled: isOn(f),
      // What it runs, with anything secret-looking shortened.
      summary: !def
        ? (f.unsupported ?? '')
        : def.transport === 'http'
          ? `${def.url}${Object.keys(def.headers).length ? ` (with ${Object.keys(def.headers).join(', ')} header)` : ''}`
          : `${def.command} ${def.args.join(' ')}${Object.keys(def.env).length ? `  ·  ${Object.entries(def.env).map(([k, v]) => `${k}=${mask(v)}`).join(' ')}` : ''}`,
      status: !def ? 'unsupported' : running?.client.alive ? 'running' : (problem?.state ?? 'idle'),
      error: problem?.message ?? f.unsupported ?? '',
      tools: (running?.tools.map((t) => ({ name: t.name, description: t.description })) ?? cachedTools(f.id)).slice(0, 200),
      removable: f.source === 'majordomo',
      canSignIn: canSignIn(f),
      signedIn: canSignIn(f) && pluginSignedIn(f.id),
    };
  });
}

// ---------- what agents are told, and the tools they use ----------

/** The part of a task's opening message about plugin tools. '' when none are switched on. */
export function pluginCatalog(): string {
  const on = enabledPlugins();
  if (!on.length) return '';
  const lines = on.map((f) => {
    const tools = cachedTools(f.id).map((t) => t.name);
    const shown = tools.slice(0, 12).join(', ');
    return `- ${f.key}${f.key !== f.name.toLowerCase() ? ` (${f.name})` : ''}${tools.length ? `: ${shown}${tools.length > 12 ? `, and ${tools.length - 12} more` : ''}` : ''}`;
  });
  return (
    '# Plugin tools you can use\n' +
    "These connect to the user's other apps and services. Call plugin_tools with a plugin's name to see its tools and what each " +
    'takes, then use_plugin_tool to run one. Anything that changes something outside this computer (sending, posting, buying, ' +
    'deleting) still needs the user’s approval in the brief.\n' +
    lines.join('\n')
  );
}

export function enabledPluginNames(): string[] {
  return enabledPlugins().map((f) => f.key);
}

function pick(name: string): Found {
  const want = name.trim().toLowerCase();
  const on = enabledPlugins();
  const f = on.find((x) => x.key === want) ?? on.find((x) => x.name.toLowerCase() === want);
  if (!f) throw new ToolError(`There is no plugin called "${name}" switched on. Switched on: ${on.map((x) => x.key).join(', ') || 'none'}.`);
  return f;
}

export function pluginTools(): Tool[] {
  return [
    defineTool({
      name: 'plugin_tools',
      description:
        "List the plugin tools that connect to the user's other apps and services. With no plugin named, lists each plugin and its tools; " +
        'with a plugin named, also gives each tool’s description and the arguments it takes.',
      input: z.object({ plugin: z.string().optional().describe('A plugin name from the list, to see its tools in detail.') }),
      async run({ plugin }) {
        if (plugin) {
          const f = pick(plugin);
          const entry = await connect(f).catch((err) => {
            throw new ToolError(err instanceof Error ? err.message : String(err));
          });
          return clip(
            `${f.key}: ${entry.tools.length} tools\n\n` +
              entry.tools
                .map((t) => `## ${t.name}${t.readOnly ? ' (read-only)' : ''}\n${t.description || '(no description)'}\nArguments (JSON Schema): ${JSON.stringify(t.inputSchema)}`)
                .join('\n\n'),
            40_000,
          );
        }
        const on = enabledPlugins();
        if (!on.length) return 'No plugins are switched on.';
        const parts = await Promise.all(
          on.map(async (f) => {
            const tools = live.get(f.id)?.tools ?? cachedTools(f.id);
            if (tools.length) return `- ${f.key}: ${tools.map((t) => t.name).join(', ')}`;
            try {
              const entry = await connect(f);
              return `- ${f.key}: ${entry.tools.map((t) => t.name).join(', ')}`;
            } catch (err) {
              return `- ${f.key}: not available right now (${err instanceof Error ? err.message : String(err)})`;
            }
          }),
        );
        return `${parts.join('\n')}\n\nCall plugin_tools with a plugin’s name for the arguments each tool takes.`;
      },
    }),
    defineTool({
      name: 'use_plugin_tool',
      description: 'Run one tool from a plugin. Look it up with plugin_tools first so the arguments match what it expects.',
      input: z.object({
        plugin: z.string().describe('The plugin’s name, as plugin_tools lists it.'),
        tool: z.string().describe('The tool’s name.'),
        arguments: z.record(z.string(), z.unknown()).optional().describe('The tool’s arguments, as an object.'),
      }),
      async run({ plugin, tool, arguments: args }, ctx) {
        const f = pick(plugin);
        let entry: Live;
        try {
          entry = await connect(f);
        } catch (err) {
          throw new ToolError(err instanceof Error ? err.message : String(err));
        }
        const t = entry.tools.find((x) => x.name === tool);
        if (!t) throw new ToolError(`${f.key} has no tool called "${tool}". It has: ${entry.tools.map((x) => x.name).join(', ')}.`);
        // Anything the plugin does not promise is read-only is approved like a shell command.
        if (!t.readOnly) {
          const detail = JSON.stringify(args ?? {}, null, 2).slice(0, 2500);
          const ok = await ctx.host.approve(ctx.agentId, `${f.key}.${t.name}`, `${f.name}: ${t.name}`, `${f.name} → ${t.name}\n${detail}`, ctx.signal);
          if (!ok) throw new ToolError('The user declined this action. Do not try it again another way; say in your report that it was declined.');
        }
        entry.lastUsed = Date.now();
        const result = await entry.client.callTool(t.name, args ?? {}).catch((err) => {
          throw new ToolError(`${f.key}.${t.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        if (result.isError) throw new ToolError(`${f.key}.${t.name} reported an error: ${clip(result.text, 4000)}`);
        return clip(result.text, 40_000);
      },
    }),
  ];
}

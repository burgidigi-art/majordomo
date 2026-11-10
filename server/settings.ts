import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CrewProfile, RuntimeId, RuntimeInfo, Settings } from '../shared/types.ts';
import { DATA_DIR, kvGet, kvSet } from './db.ts';

export const DEMO = process.env.MAJORDOMO_DEMO === '1';

// ---------- secrets (API keys) ----------

type KeyedRuntime = 'anthropic' | 'openai' | 'gemini' | 'muse' | 'openrouter';

const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

const ENV_KEYS: Record<KeyedRuntime, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  muse: ['MODEL_API_KEY', 'META_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

function readSecrets(): Partial<Record<KeyedRuntime | 'telegram', string>> {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function setSecret(runtime: KeyedRuntime, key: string | null): void {
  const all = readSecrets();
  if (key) all[runtime] = key.trim();
  else delete all[runtime];
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
}

export function getSecret(runtime: KeyedRuntime): { key: string; source: 'saved' | 'env' } | null {
  const saved = readSecrets()[runtime];
  if (saved) return { key: saved, source: 'saved' };
  for (const name of ENV_KEYS[runtime]) {
    const v = process.env[name];
    if (v) return { key: v, source: 'env' };
  }
  return null;
}

/** The Telegram bot token lives beside the API keys: same file, same permissions. */
export function getTelegramToken(): string | null {
  return readSecrets().telegram || process.env.TELEGRAM_BOT_TOKEN || null;
}

export function setTelegramToken(token: string | null): void {
  const all = readSecrets();
  if (token) all.telegram = token.trim();
  else delete all.telegram;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
}

export function isKeyedRuntime(id: string): id is KeyedRuntime {
  return id in ENV_KEYS;
}

function mask(key: string): string {
  return key.length <= 10 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// ---------- CLI detection (subscription logins) ----------

export const CLI_BIN: Record<'claude-code' | 'codex' | 'gemini-cli', string> = {
  'claude-code': process.env.MAJORDOMO_CLAUDE_BIN || 'claude',
  codex: process.env.MAJORDOMO_CODEX_BIN || 'codex',
  'gemini-cli': process.env.MAJORDOMO_GEMINI_BIN || 'gemini',
};

const cliCache = new Map<string, { at: number; version: string | null }>();

function probeCli(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).trim().split('\n')[0] || 'installed');
    });
  });
}

async function cliVersion(id: keyof typeof CLI_BIN): Promise<string | null> {
  const hit = cliCache.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.version;
  const version = await probeCli(CLI_BIN[id]);
  cliCache.set(id, { at: Date.now(), version });
  return version;
}

export function forgetCliProbe(): void {
  cliCache.clear();
}

// ---------- runtime catalogue ----------

interface RuntimeDef {
  id: RuntimeId;
  kind: 'api' | 'cli';
  family: RuntimeInfo['family'];
  label: string;
  auth: string;
  canManage: boolean;
  experimental?: string;
  setupHint: string;
  defaultModel: string;
}

export const RUNTIMES: RuntimeDef[] = [
  {
    id: 'claude-code',
    kind: 'cli',
    family: 'claude',
    label: 'Claude · subscription',
    auth: 'Your Claude plan, through the Claude Code CLI',
    canManage: true,
    setupHint: 'Install Claude Code, then run `claude` once in a terminal and sign in with your Claude account.',
    defaultModel: '',
  },
  {
    id: 'anthropic',
    kind: 'api',
    family: 'claude',
    label: 'Claude · API key',
    auth: 'Claude Developer Platform key, billed per token',
    canManage: true,
    setupHint: 'Create a key at platform.claude.com and paste it here (or set ANTHROPIC_API_KEY).',
    defaultModel: 'claude-opus-5-5',
  },
  {
    id: 'codex',
    kind: 'cli',
    family: 'openai',
    label: 'ChatGPT · subscription',
    auth: 'Your ChatGPT plan, through the Codex CLI',
    canManage: true,
    experimental: 'Works as a worker. Running the PM on it is experimental.',
    setupHint: 'Install with `npm i -g @openai/codex`, then run `codex login` and sign in with ChatGPT.',
    defaultModel: '',
  },
  {
    id: 'openai',
    kind: 'api',
    family: 'openai',
    label: 'OpenAI · API key',
    auth: 'OpenAI Platform key, billed per token',
    canManage: true,
    setupHint: 'Create a key at platform.openai.com and paste it here (or set OPENAI_API_KEY).',
    defaultModel: '',
  },
  {
    id: 'gemini-cli',
    kind: 'cli',
    family: 'gemini',
    label: 'Gemini · Google account',
    auth: 'Your Google account / Gemini plan, through the Gemini CLI',
    canManage: true,
    experimental: 'Works as a worker. Running the PM on it is experimental.',
    setupHint: 'Install with `npm i -g @google/gemini-cli`, then run `gemini` once and sign in with Google.',
    defaultModel: '',
  },
  {
    id: 'gemini',
    kind: 'api',
    family: 'gemini',
    label: 'Gemini · API key',
    auth: 'Google AI Studio key, billed per token',
    canManage: true,
    setupHint: 'Create a key at aistudio.google.com and paste it here (or set GEMINI_API_KEY).',
    defaultModel: '',
  },
  {
    id: 'muse',
    kind: 'api',
    family: 'muse',
    label: 'Meta Muse · API key',
    auth: 'Meta Model API key, billed per token',
    canManage: true,
    setupHint: 'Create a key in the Meta Model API console and paste it here (or set MODEL_API_KEY).',
    defaultModel: 'muse-spark-1.1',
  },
  {
    id: 'openrouter',
    kind: 'api',
    family: 'openrouter',
    label: 'OpenRouter · API key',
    auth: 'OpenRouter credits — any model on their catalogue',
    canManage: true,
    setupHint: 'Create a key at openrouter.ai/keys and paste it here (or set OPENROUTER_API_KEY).',
    defaultModel: '',
  },
  {
    id: 'demo',
    kind: 'api',
    family: 'demo',
    label: 'Demo crew',
    auth: 'Simulated agents — no account needed, nothing leaves your machine',
    canManage: true,
    setupHint: 'Always available. Useful for exploring the dashboard before connecting an account.',
    defaultModel: 'demo-1',
  },
];

export function runtimeDef(id: RuntimeId): RuntimeDef {
  const def = RUNTIMES.find((r) => r.id === id);
  if (!def) throw new Error(`Unknown runtime "${id}"`);
  return def;
}

export async function runtimeStatus(): Promise<RuntimeInfo[]> {
  return Promise.all(
    RUNTIMES.map(async (def): Promise<RuntimeInfo> => {
      const base = {
        id: def.id,
        kind: def.kind,
        family: def.family,
        label: def.label,
        auth: def.auth,
        canManage: def.canManage,
        experimental: def.experimental,
        setupHint: def.setupHint,
      };
      if (def.id === 'demo') return { ...base, ready: true, detail: 'Built in', keySource: null };
      if (def.kind === 'cli') {
        const version = await cliVersion(def.id as keyof typeof CLI_BIN);
        return {
          ...base,
          ready: !!version,
          detail: version ? `Found ${version}` : 'CLI not found on PATH',
          keySource: null,
        };
      }
      const secret = getSecret(def.id as KeyedRuntime);
      return {
        ...base,
        ready: !!secret,
        detail: secret
          ? `${mask(secret.key)} · ${secret.source === 'env' ? 'from environment' : 'saved'}`
          : 'No key yet',
        keySource: secret?.source ?? null,
      };
    }),
  );
}

// ---------- settings ----------

const DEMO_CREW: CrewProfile[] = [
  {
    id: 'scout',
    name: 'Scout',
    strengths: 'Research, reading, comparing options, summarising sources.',
    runtime: 'demo',
    model: 'demo-1',
  },
  {
    id: 'builder',
    name: 'Builder',
    strengths: 'Writing and running code, files, scripts, anything hands-on.',
    runtime: 'demo',
    model: 'demo-1',
  },
  {
    id: 'scribe',
    name: 'Scribe',
    strengths: 'Drafting, editing, turning rough notes into finished documents.',
    runtime: 'demo',
    model: 'demo-1',
  },
];

function initialSettings(): Settings {
  // Prefer whatever real account is already usable from the environment; fall back to the demo crew.
  const order: KeyedRuntime[] = ['anthropic', 'openai', 'gemini', 'openrouter', 'muse'];
  const first = DEMO ? undefined : order.find((r) => getSecret(r) && runtimeDef(r).defaultModel);
  const base = {
    userName: '',
    maxParallel: 4,
    approvalMode: 'auto' as const,
    compactAtTokens: 150_000,
    workspaceRoot: path.join(DATA_DIR, 'workspaces'),
    codexSandbox: 'workspace-write' as const,
  };
  if (!first) {
    return {
      ...base,
      pm: { runtime: 'demo', model: 'demo-1', effort: null },
      crew: DEMO_CREW,
      defaultCrewId: 'builder',
    };
  }
  const model = runtimeDef(first).defaultModel;
  return {
    ...base,
    pm: { runtime: first, model, effort: 'high' },
    crew: [
      {
        id: 'generalist',
        name: 'Generalist',
        strengths: 'Capable all-rounder: research, code, writing, analysis.',
        runtime: first,
        model,
        effort: 'high',
      },
    ],
    defaultCrewId: 'generalist',
  };
}

export function getSettings(): Settings {
  const stored = kvGet<Settings | null>('settings', null);
  if (stored) return stored;
  const fresh = initialSettings();
  kvSet('settings', fresh);
  return fresh;
}

export function saveSettings(next: Settings): Settings {
  const clean: Settings = {
    ...next,
    maxParallel: Math.max(1, Math.min(16, Math.round(next.maxParallel) || 4)),
    compactAtTokens: Math.max(20_000, Math.round(next.compactAtTokens) || 150_000),
    crew: next.crew.filter((c) => c.id && c.name),
  };
  if (!clean.crew.length) throw new Error('Keep at least one crew member.');
  if (!clean.crew.some((c) => c.id === clean.defaultCrewId)) clean.defaultCrewId = clean.crew[0].id;
  kvSet('settings', clean);
  return clean;
}

export function resolveCrew(ref: string | undefined | null): CrewProfile {
  const s = getSettings();
  if (ref) {
    const needle = ref.trim().toLowerCase();
    const hit = s.crew.find((c) => c.id.toLowerCase() === needle || c.name.toLowerCase() === needle);
    if (hit) return hit;
  }
  return s.crew.find((c) => c.id === s.defaultCrewId) ?? s.crew[0];
}

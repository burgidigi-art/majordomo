import type { ModelOption, RuntimeId } from '../../shared/types.ts';
import { kvGet, kvSet } from '../db.ts';
import { anthropicProvider, describeAnthropicError } from './anthropic.ts';
import { demoProvider } from './demo.ts';
import {
  describeOpenAIError,
  geminiProvider,
  museProvider,
  openaiProvider,
  openrouterProvider,
} from './openai.ts';
import type { Provider, Usage } from './types.ts';

const PROVIDERS: Partial<Record<RuntimeId, Provider>> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  muse: museProvider,
  openrouter: openrouterProvider,
  demo: demoProvider,
};

export function getProvider(runtime: RuntimeId): Provider {
  const p = PROVIDERS[runtime];
  if (!p) throw new Error(`${runtime} is a CLI runtime and has no API provider.`);
  return p;
}

export function describeError(err: unknown): string {
  return (
    describeAnthropicError(err) ??
    describeOpenAIError(err) ??
    (err instanceof Error ? err.message : String(err))
  );
}

// ---------- pricing (USD per million tokens) ----------

interface Price {
  in: number;
  out: number;
  cacheRead?: number;
}

const CLAUDE_PRICES: [RegExp, Price][] = [
  [/claude-(fable|mythos)-5-2/, { in: 8, out: 40, cacheRead: 0.2 }],
  [/claude-(fable|mythos)-5-1/, { in: 10, out: 50, cacheRead: 0.25 }],
  [/claude-(fable|mythos)-5/, { in: 10, out: 50 }],
  [/claude-opus-5-5/, { in: 4, out: 20, cacheRead: 0.2 }],
  [/claude-opus-(5|4-[5-8])/, { in: 5, out: 25 }],
  [/claude-sonnet-5-5/, { in: 2, out: 10, cacheRead: 0.1 }],
  [/claude-sonnet-5/, { in: 2, out: 10 }],
  [/claude-sonnet-4/, { in: 3, out: 15 }],
  [/claude-haiku-5-5/, { in: 0.1, out: 0.5 }],
  [/claude-haiku-4-5/, { in: 1, out: 5 }],
];

const OTHER_PRICES: [RegExp, Price][] = [[/^muse-spark-1\.1/, { in: 1.25, out: 4.25 }]];

type Catalogue = Record<string, [number, number]>;

/** OpenRouter publishes prices for most vendors' models; use it as a best-effort price list. */
export function rememberCatalogue(models: ModelOption[]): void {
  const map: Catalogue = {};
  for (const m of models) {
    if (m.inputPerM !== undefined && m.outputPerM !== undefined) map[m.id] = [m.inputPerM, m.outputPerM];
  }
  if (Object.keys(map).length) kvSet('prices:openrouter', map);
}

function priceFor(runtime: RuntimeId, model: string): Price | null {
  if (runtime === 'anthropic') return CLAUDE_PRICES.find(([re]) => re.test(model))?.[1] ?? null;
  const fixed = OTHER_PRICES.find(([re]) => re.test(model))?.[1];
  if (fixed) return fixed;
  const cat = kvGet<Catalogue>('prices:openrouter', {});
  const key =
    runtime === 'openrouter' ? model : runtime === 'openai' ? `openai/${model}` : runtime === 'gemini' ? `google/${model}` : '';
  const hit = cat[key];
  return hit ? { in: hit[0], out: hit[1] } : null;
}

/** Estimated cost of one request. Returns 0 when the price is unknown. */
export function costOf(runtime: RuntimeId, model: string, usage: Usage): number {
  if (usage.costUsd !== undefined) return usage.costUsd;
  const price = priceFor(runtime, model);
  if (!price) return 0;
  const fresh = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
  const cacheRead = price.cacheRead ?? price.in * 0.1;
  return (fresh * price.in + usage.cacheRead * cacheRead + usage.cacheWrite * price.in * 1.25 + usage.output * price.out) / 1e6;
}

export async function listModels(runtime: RuntimeId): Promise<ModelOption[]> {
  const models = await getProvider(runtime).listModels();
  if (runtime === 'openrouter') rememberCatalogue(models);
  return models;
}

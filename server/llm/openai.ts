import OpenAI from 'openai';
import type { ModelOption, RuntimeId } from '../../shared/types.ts';
import { getSecret } from '../settings.ts';
import { missingImage, readImage, type ChatRequest, type ChatResponse, type ImageRef, type Msg, type Part, type Provider, type StopKind } from './types.ts';

type CompatRuntime = 'openai' | 'gemini' | 'muse' | 'openrouter';

/** Each of these speaks the OpenAI Chat Completions protocol at its own base URL. */
const ENDPOINTS: Record<CompatRuntime, { baseURL: string; headers?: Record<string, string> }> = {
  openai: { baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' },
  gemini: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
  muse: { baseURL: process.env.MUSE_BASE_URL || 'https://api.meta.ai/v1' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', headers: { 'X-Title': 'Majordomo' } },
};

function client(runtime: CompatRuntime): OpenAI {
  const secret = getSecret(runtime);
  if (!secret) throw new Error(`No API key saved for ${runtime}. Add one in Settings.`);
  const ep = ENDPOINTS[runtime];
  return new OpenAI({ apiKey: secret.key, baseURL: ep.baseURL, defaultHeaders: ep.headers });
}

function cleanSchema(schema: unknown, runtime: CompatRuntime): unknown {
  if (Array.isArray(schema)) return schema.map((s) => cleanSchema(s, runtime));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema') continue;
    if (k === 'additionalProperties' && runtime === 'gemini') continue;
    out[k] = cleanSchema(v, runtime);
  }
  return out;
}

type ChatMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toMessages(req: ChatRequest, runtime: CompatRuntime): ChatMsg[] {
  const out: ChatMsg[] = [{ role: 'system', content: req.system }];
  for (const msg of req.messages) {
    if (msg.role === 'user') {
      for (const p of msg.parts) {
        if (p.type === 'tool_result' && !p.server)
          out.push({ role: 'tool', tool_call_id: p.id, content: p.output || '(no output)' });
      }
      const text = msg.parts
        .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n\n');
      // Images the user attached, plus any a tool returned: a tool message can only carry text
      // in this protocol, so tool images ride in the user message that follows it.
      const images: ImageRef[] = [];
      let fromTools = false;
      for (const p of msg.parts) {
        if (p.type === 'image') images.push(p);
        if (p.type === 'tool_result' && !p.server && p.images?.length) {
          images.push(...p.images);
          fromTools = true;
        }
      }
      if (images.length) {
        const lead = [fromTools ? 'The image(s) returned by the tool call above:' : '', text].filter(Boolean).join('\n\n');
        const content: any[] = lead ? [{ type: 'text', text: lead }] : [];
        for (const ref of images) {
          const data = readImage(ref);
          content.push(data ? { type: 'image_url', image_url: { url: `data:${ref.mime};base64,${data}` } } : { type: 'text', text: missingImage(ref) });
        }
        out.push({ role: 'user', content });
      } else if (text) {
        out.push({ role: 'user', content: text });
      }
      continue;
    }
    if (msg.raw?.runtime === runtime && msg.raw.content) {
      // Same provider: replay its own message object so reasoning details and
      // Gemini thought signatures on tool calls are passed back untouched.
      out.push(msg.raw.content as ChatMsg);
      continue;
    }
    const text = msg.parts
      .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const calls = msg.parts.filter(
      (p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call' && !p.server,
    );
    if (!text && !calls.length) continue;
    out.push({
      role: 'assistant',
      content: text || null,
      ...(calls.length
        ? {
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
            })),
          }
        : {}),
    });
  }
  return out;
}

interface CallSlot {
  id: string;
  name: string;
  args: string;
  extra?: unknown;
}

function makeProvider(runtime: CompatRuntime): Provider {
  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const api = client(runtime);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toMessages(req, runtime),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: cleanSchema(t.schema, runtime) },
      }));
    }
    if (req.effort) {
      const level = req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort;
      if (runtime === 'openrouter') body.reasoning = { effort: level };
      else if (runtime !== 'muse') body.reasoning_effort = level;
    }

    const stream = (await api.chat.completions.create(body as never, {
      signal: req.signal,
      headers: { Accept: 'text/event-stream' },
    })) as unknown as AsyncIterable<any>;

    let text = '';
    let thinking = '';
    const slots: CallSlot[] = [];
    const reasoningDetails: unknown[] = [];
    let finish = '';
    let usage: any = null;
    let served = req.model;

    for await (const chunk of stream) {
      if (chunk.model) served = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const d = choice.delta ?? {};
      if (typeof d.content === 'string' && d.content) {
        text += d.content;
        req.onDelta('text', d.content);
      }
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) {
        thinking += r;
        req.onDelta('thinking', r);
      }
      if (Array.isArray(d.reasoning_details)) reasoningDetails.push(...d.reasoning_details);
      for (const tc of d.tool_calls ?? []) {
        let slot: CallSlot | undefined = slots[tc.index ?? 0];
        // Some providers reuse index 0 for every call and distinguish them only by id.
        if (slot && tc.id && slot.id && tc.id !== slot.id) {
          slot = slots.find((s) => s.id === tc.id);
          if (!slot) slots.push((slot = { id: tc.id, name: '', args: '' }));
        } else if (!slot) {
          slot = slots[tc.index ?? 0] = { id: '', name: '', args: '' };
        }
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name && !slot.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        if (tc.extra_content) slot.extra = tc.extra_content;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const calls = slots.filter(Boolean).map((s, i) => ({ ...s, id: s.id || `call_${Date.now()}_${i}` }));
    const parts: Part[] = [];
    if (thinking) parts.push({ type: 'thinking', text: thinking });
    if (text) parts.push({ type: 'text', text });
    for (const c of calls) {
      let input: Record<string, unknown> = {};
      let invalid: string | undefined;
      try {
        const parsed = JSON.parse(c.args || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
        else invalid = c.args;
      } catch {
        invalid = c.args;
      }
      parts.push({ type: 'tool_call', id: c.id, name: c.name, input, invalid });
    }

    const rawMessage: Record<string, unknown> = { role: 'assistant', content: text || null };
    if (calls.length) {
      rawMessage.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
        ...(c.extra ? { extra_content: c.extra } : {}),
      }));
    }
    if (reasoningDetails.length) rawMessage.reasoning_details = reasoningDetails;

    let stop: StopKind = 'end';
    if (calls.length) stop = finish === 'length' ? 'max_tokens' : 'tool';
    else if (finish === 'length') stop = 'max_tokens';
    else if (finish === 'content_filter') stop = 'refusal';

    const message: Msg = {
      role: 'assistant',
      parts,
      raw: { runtime: runtime as RuntimeId, model: served, content: rawMessage },
    };
    return {
      message,
      stop,
      model: served,
      usage: {
        input: usage?.prompt_tokens ?? 0,
        output: usage?.completion_tokens ?? 0,
        cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
        costUsd: typeof usage?.cost === 'number' ? usage.cost : undefined,
      },
    };
  }

  async function listModels(): Promise<ModelOption[]> {
    if (runtime === 'openrouter') {
      // OpenRouter's catalogue carries prices, which the SDK's typed model list would drop.
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) throw new Error(`OpenRouter model list failed (${res.status})`);
      const json = (await res.json()) as { data: any[] };
      return json.data.map((m) => ({
        id: m.id,
        label: m.name,
        inputPerM: m.pricing?.prompt ? Number(m.pricing.prompt) * 1e6 : undefined,
        outputPerM: m.pricing?.completion ? Number(m.pricing.completion) * 1e6 : undefined,
      }));
    }
    const out: ModelOption[] = [];
    for await (const m of client(runtime).models.list()) {
      const id = m.id.replace(/^models\//, '');
      // Hide models that cannot hold a tool-calling conversation.
      if (/embed|whisper|tts|dall-e|image|audio|moderation|realtime|transcribe|aqa|veo|imagen/i.test(id)) continue;
      out.push({ id });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  return { chat, listModels };
}

export const openaiProvider = makeProvider('openai');
export const geminiProvider = makeProvider('gemini');
export const museProvider = makeProvider('muse');
export const openrouterProvider = makeProvider('openrouter');

export function describeOpenAIError(err: unknown): string | null {
  if (err instanceof OpenAI.AuthenticationError) return 'The provider rejected the API key. Check it in Settings.';
  if (err instanceof OpenAI.NotFoundError) return `The provider does not know that model: ${err.message}`;
  if (err instanceof OpenAI.RateLimitError) return `Rate limit or quota reached: ${err.message}`;
  if (err instanceof OpenAI.APIError) return `Provider API error ${err.status ?? ''}: ${err.message}`;
  return null;
}

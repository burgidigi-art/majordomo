import Anthropic from '@anthropic-ai/sdk';
import type { ModelOption } from '../../shared/types.ts';
import { getSecret } from '../settings.ts';
import type { ChatRequest, ChatResponse, Msg, Part, Provider, StopKind } from './types.ts';

import Beta = Anthropic.Beta;

/** Models that take adaptive thinking + effort and have the 128K output ceiling. */
const MODERN = /claude-(fable|mythos|opus-(4-[6-9]|[5-9])|sonnet-(4-[6-9]|[5-9])|haiku-[5-9])/;
/** Models whose safety classifiers can decline a request; these get a server-side fallback. */
const HAS_FALLBACK = /claude-(fable-5-[1-9]|opus-5(-5)?$|sonnet-5-5)/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function client(): Anthropic {
  const secret = getSecret('anthropic');
  // With no saved key the SDK resolves credentials itself (env vars or an `ant auth login` profile).
  return secret ? new Anthropic({ apiKey: secret.key }) : new Anthropic();
}

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');

function toParams(messages: Msg[], runtimeIsAnthropic: (m: Msg) => boolean, floor: number): Beta.BetaMessageParam[] {
  const out: Beta.BetaMessageParam[] = [];
  messages.forEach((msg, index) => {
    if (msg.role === 'user') {
      const content: Beta.BetaContentBlockParam[] = [];
      for (const p of msg.parts) {
        if (p.type === 'tool_result' && !p.server) {
          content.push({
            type: 'tool_result',
            tool_use_id: safeId(p.id),
            content: p.output || '(no output)',
            is_error: p.isError || undefined,
          });
        }
      }
      for (const p of msg.parts) if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
      if (content.length) out.push({ role: 'user', content });
      return;
    }
    if (runtimeIsAnthropic(msg)) {
      let content = msg.raw!.content as Beta.BetaContentBlockParam[];
      if (index < floor) content = content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
      if (content.length) out.push({ role: 'assistant', content });
      return;
    }
    // A turn produced by another provider: rebuild it from the neutral parts.
    const content: Beta.BetaContentBlockParam[] = [];
    for (const p of msg.parts) {
      if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
      if (p.type === 'tool_call' && !p.server)
        content.push({ type: 'tool_use', id: safeId(p.id), name: p.name, input: p.input });
    }
    if (content.length) out.push({ role: 'assistant', content });
  });
  return out;
}

function toParts(content: Beta.BetaContentBlock[]): Part[] {
  const parts: Part[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text) parts.push({ type: 'text', text: block.text });
        break;
      case 'thinking':
        if (block.thinking) parts.push({ type: 'thinking', text: block.thinking });
        break;
      case 'tool_use':
        parts.push({
          type: 'tool_call',
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
        break;
      case 'server_tool_use':
        parts.push({
          type: 'tool_call',
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
          server: true,
        });
        break;
      case 'web_search_tool_result': {
        // A successful search returns a list; an error returns a single object.
        const output = Array.isArray(block.content)
          ? block.content.map((r: { title: string; url: string }) => `${r.title} — ${r.url}`).join('\n')
          : `Search failed: ${block.content.error_code}`;
        parts.push({
          type: 'tool_result',
          id: block.tool_use_id,
          name: 'web_search',
          output,
          isError: !Array.isArray(block.content),
          server: true,
        });
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

const STOP: Record<string, StopKind> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'refusal',
  pause_turn: 'pause',
};

async function chat(req: ChatRequest): Promise<ChatResponse> {
  const api = client();
  const modern = MODERN.test(req.model);
  const fromAnthropic = (m: Msg) => m.raw?.runtime === 'anthropic' && Array.isArray(m.raw.content);

  const tools: Beta.BetaToolUnion[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema as Beta.BetaTool.InputSchema,
    // Stream large inputs (file bodies) as they are generated. The harness validates every
    // tool input against its schema before running it, which is the client's job once this is on.
    eager_input_streaming: true,
  }));
  if (req.webSearch && modern) tools.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 8 });

  let floor = req.thinkingFloor ?? 0;
  let badJson = 0;

  for (;;) {
    const params: Beta.Messages.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: modern ? 64_000 : 8_192,
      // The system prompt and tool list never change during a conversation, so the cached
      // prefix (and Claude's thinking blocks, which are bound to it) stay valid.
      system: req.system,
      cache_control: { type: 'ephemeral' },
      messages: toParams(req.messages, fromAnthropic, floor),
      tools,
      stream: true,
    };
    if (modern) {
      params.thinking = { type: 'adaptive', display: 'summarized' };
      if (req.effort) params.output_config = { effort: req.effort };
    }
    if (HAS_FALLBACK.test(req.model)) {
      // If a safety classifier declines, the API re-runs the request on a fallback model
      // inside the same call instead of failing the agent's turn.
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }

    try {
      const stream = api.beta.messages.stream(params, { signal: req.signal });
      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type === 'text_delta') req.onDelta('text', event.delta.text);
        else if (event.delta.type === 'thinking_delta') req.onDelta('thinking', event.delta.thinking);
      }
      const message = await stream.finalMessage();
      const u = message.usage;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      return {
        message: {
          role: 'assistant',
          parts: toParts(message.content),
          raw: { runtime: 'anthropic', model: message.model, content: message.content },
        },
        stop: STOP[message.stop_reason ?? 'end_turn'] ?? 'end',
        usage: { input: u.input_tokens + cacheRead + cacheWrite, output: u.output_tokens, cacheRead, cacheWrite },
        model: message.model,
        thinkingFloor: floor > (req.thinkingFloor ?? 0) ? floor : undefined,
      };
    } catch (err) {
      if (req.signal.aborted) throw err;
      if (err instanceof Anthropic.BadRequestError) {
        // Replayed thinking blocks are only valid while everything before them is unchanged
        // (and only for models that can read them). If the request is rejected and there are
        // still thinking blocks in the history, drop them all — always a valid edit — and retry once.
        const hasThinking = req.messages.some(
          (m, i) =>
            i >= floor &&
            fromAnthropic(m) &&
            (m.raw!.content as { type: string }[]).some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
        );
        if (hasThinking) {
          floor = req.messages.length;
          continue;
        }
        throw err;
      }
      if (err instanceof Anthropic.APIError) throw err;
      // Not an API error: with eager input streaming, a tool input that is not parseable JSON
      // rejects the stream. Re-issue the turn a couple of times before giving up.
      if (badJson++ < 2) continue;
      throw err;
    }
  }
}

async function listModels(): Promise<ModelOption[]> {
  const out: ModelOption[] = [];
  for await (const m of client().models.list()) out.push({ id: m.id, label: m.display_name });
  return out;
}

export const anthropicProvider: Provider = { chat, listModels };

/** Turn SDK errors into something a person can act on. */
export function describeAnthropicError(err: unknown): string | null {
  if (err instanceof Anthropic.AuthenticationError) return 'Claude rejected the API key. Check it in Settings.';
  if (err instanceof Anthropic.PermissionDeniedError) return `Claude denied the request: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Claude does not know that model: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return 'Claude rate limit reached. The request was retried and still limited.';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ''}: ${err.message}`;
  return null;
}

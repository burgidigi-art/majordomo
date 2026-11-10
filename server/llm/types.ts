import fs from 'node:fs';
import path from 'node:path';
import type { Effort, ModelOption, RuntimeId } from '../../shared/types.ts';

/** An image on disk. Only the path is stored; the bytes are read when a request is built. */
export interface ImageRef {
  path: string;
  mime: string;
}

/**
 * Provider-neutral conversation format. Every adapter converts to and from this, so an agent's
 * history survives a switch between Claude, OpenAI, Gemini, Muse and OpenRouter.
 */
export type Part =
  | { type: 'text'; text: string }
  /** An image for the model to look at (user turns only). */
  | { type: 'image'; path: string; mime: string }
  /** Shown in the transcript only; never replayed to another provider. */
  | { type: 'thinking'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Executed by the provider (e.g. Claude's web search); the harness must not run it. */
      server?: boolean;
      /** Set when the model produced arguments that are not valid JSON. */
      invalid?: string;
    }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      output: string;
      isError?: boolean;
      server?: boolean;
      /** Images the tool returned for the model to look at. */
      images?: ImageRef[];
    };

export interface Msg {
  role: 'user' | 'assistant';
  parts: Part[];
  /**
   * The provider's own representation of an assistant turn, replayed verbatim when the same
   * provider is called again (Claude thinking blocks and Gemini thought signatures need this).
   */
  raw?: { runtime: RuntimeId; model: string; content: unknown };
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for an object. */
  schema: Record<string, unknown>;
}

export interface Usage {
  /** Total prompt tokens for the request, cached or not. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Provider-reported cost, when the provider returns one. */
  costUsd?: number;
}

export type StopKind = 'end' | 'tool' | 'max_tokens' | 'refusal' | 'pause';

export interface ChatRequest {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  effort?: Effort | null;
  /** Let the provider search the web itself, where it can. */
  webSearch?: boolean;
  /** Drop provider thinking blocks from messages before this index (see anthropic.ts). */
  thinkingFloor?: number;
  signal: AbortSignal;
  onDelta: (kind: 'text' | 'thinking', text: string) => void;
}

export interface ChatResponse {
  message: Msg;
  stop: StopKind;
  usage: Usage;
  /** The model that actually served the request. */
  model: string;
  /** Present when the request only succeeded after thinking blocks were dropped from history. */
  thinkingFloor?: number;
}

export interface Provider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<ModelOption[]>;
}

export function textOf(msg: Msg): string {
  return msg.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .trim();
}

/** Read an image for sending to a provider. Null when the file has gone or cannot be read. */
export function readImage(ref: ImageRef): string | null {
  try {
    return fs.readFileSync(ref.path).toString('base64');
  } catch {
    return null;
  }
}

export const missingImage = (ref: ImageRef) => `[An image was attached here (${path.basename(ref.path)}) but the file is no longer on disk.]`;

export const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

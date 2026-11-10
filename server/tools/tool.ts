import { z } from 'zod';
import type { ToolDef } from '../llm/types.ts';

/** Services the harness offers to a running agent's tools. */
export interface Host {
  progress(agentId: string, note: string): void;
  askManager(agentId: string, question: string, signal: AbortSignal): Promise<string>;
  delegate(
    agentId: string,
    items: { title: string; brief: string; crew?: string }[],
    signal: AbortSignal,
  ): Promise<string>;
  /** Resolves true when the action may proceed (always true in auto mode). */
  approve(agentId: string, tool: string, summary: string, detail: string, signal: AbortSignal): Promise<boolean>;
}

export interface ToolCtx {
  agentId: string;
  cwd: string;
  signal: AbortSignal;
  host: Host;
}

export interface Tool<T = any> {
  name: string;
  description: string;
  input: z.ZodType<T>;
  run(input: T, ctx: ToolCtx): Promise<string>;
}

export function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: ToolCtx): Promise<string>;
}): Tool<z.infer<S>> {
  return tool as Tool<z.infer<S>>;
}

export function toolDef(tool: Tool): ToolDef {
  const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, schema };
}

export class ToolError extends Error {}

/** Keep the head and the tail of long output; the middle is rarely what matters. */
export function clip(text: string, max = 24_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… [${text.length - max} characters omitted] …\n\n${text.slice(-half)}`;
}

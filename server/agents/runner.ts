import type { Effort, RuntimeId } from '../../shared/types.ts';
import { emit, emitDelta } from '../bus.ts';
import { kvDelete, kvGet, kvSet, messages } from '../db.ts';
import { costOf, describeError, getProvider } from '../llm/index.ts';
import { textOf, type Msg, type Part, type Usage } from '../llm/types.ts';
import { getSettings, runtimeDef } from '../settings.ts';
import { ToolError, toolDef, type Host, type Tool } from '../tools/tool.ts';
import { runCliTurn } from './cli.ts';
import { COMPACT_PROMPT } from './prompts.ts';

export interface InboxItem {
  from: 'user' | 'manager' | 'system';
  /** What the model reads. */
  text: string;
  /** What the transcript shows, when that should differ (e.g. without the context block). */
  display?: string;
  /** The channel a user message arrived on, when it was not the dashboard. */
  via?: 'telegram';
  /** The text is a transcription of something the user said aloud. */
  voice?: boolean;
}

export interface AgentSpec {
  id: string;
  manager: boolean;
  runtime: RuntimeId;
  model: string;
  effort?: Effort | null;
  cwd: string;
  system: string;
  tools: Tool[];
  /** Prepended to the first prompt of a CLI session (workers). */
  cliPreamble?: string;
  mcp?: { url: string; token: string };
}

export interface Outcome {
  ok: boolean;
  text: string;
  error?: string;
  aborted?: boolean;
}

export interface RunnerHooks {
  spec(id: string): AgentSpec;
  host: Host;
  onStart(id: string): void;
  onFinish(id: string, outcome: Outcome): void;
  /** Called with the final text of each turn and the messages that prompted it. */
  onReply?(id: string, text: string, items: InboxItem[]): void;
  onUsage(id: string, usage: Usage, costUsd: number, included: boolean): void;
}

const MAX_ROUNDS = 150;

/**
 * Runs agents. Every agent — the PM and each worker — is the same thing here: an inbox, a
 * persisted conversation, and a loop that runs while the inbox has something in it. Messages
 * that arrive mid-run are folded in at the next step rather than waiting for the run to end.
 */
export class Runner {
  private inbox = new Map<string, InboxItem[]>();
  private active = new Map<string, AbortController>();

  constructor(private hooks: RunnerHooks) {}

  isBusy(id: string): boolean {
    return this.active.has(id);
  }

  queued(id: string): number {
    return this.inbox.get(id)?.length ?? 0;
  }

  send(id: string, item: InboxItem): void {
    const q = this.inbox.get(id) ?? [];
    q.push(item);
    this.inbox.set(id, q);
    this.kick(id);
  }

  /** Abort the current run and drop anything still queued for the agent. */
  stop(id: string): void {
    this.inbox.delete(id);
    this.active.get(id)?.abort();
  }

  /** Abort everything in flight; used when the server shuts down so no agent process is orphaned. */
  stopAll(): void {
    this.inbox.clear();
    for (const abort of this.active.values()) abort.abort();
  }

  /** Forget an agent's conversation so its next run starts fresh. */
  reset(id: string): void {
    this.stop(id);
    messages.clear(id);
    for (const k of ['ctx', 'floor', 'session', 'session-rt']) kvDelete(`${k}:${id}`);
  }

  private take(id: string): InboxItem[] {
    const q = this.inbox.get(id) ?? [];
    this.inbox.delete(id);
    return q;
  }

  private kick(id: string): void {
    if (this.active.has(id)) return;
    const abort = new AbortController();
    this.active.set(id, abort);
    this.hooks.onStart(id);
    void this.run(id, abort.signal).then((outcome) => {
      // Mark the agent idle before announcing the outcome, so anything that reads
      // isBusy() from the finish hook (the dashboard status, for one) sees the truth.
      this.active.delete(id);
      this.hooks.onFinish(id, outcome);
      if (this.queued(id)) this.kick(id);
    });
  }

  private async run(id: string, signal: AbortSignal): Promise<Outcome> {
    let text = '';
    try {
      while (this.queued(id)) {
        const spec = this.hooks.spec(id);
        const items = this.take(id);
        for (const it of items) emit(id, 'user', { from: it.from, text: it.display ?? it.text, via: it.via, voice: it.voice });
        text =
          runtimeDef(spec.runtime).kind === 'cli'
            ? await this.cliTurn(spec, items, signal)
            : await this.nativeTurn(spec, items, signal);
        this.hooks.onReply?.(id, text, items);
      }
      return { ok: true, text };
    } catch (err) {
      if (signal.aborted) return { ok: false, text, aborted: true, error: 'Stopped' };
      const message = describeError(err);
      emit(id, 'error', { message });
      return { ok: false, text, error: message };
    }
  }

  // ---------- CLI runtimes ----------

  private async cliTurn(spec: AgentSpec, items: InboxItem[], signal: AbortSignal): Promise<string> {
    const sameRuntime = kvGet<string | null>(`session-rt:${spec.id}`, null) === spec.runtime;
    const session = sameRuntime ? kvGet<string | null>(`session:${spec.id}`, null) : null;
    const body = items.map((i) => i.text).join('\n\n');
    const result = await runCliTurn({
      agentId: spec.id,
      runtime: spec.runtime,
      model: spec.model,
      effort: spec.effort,
      cwd: spec.cwd,
      prompt: !session && spec.cliPreamble ? spec.cliPreamble + body : body,
      system: spec.manager ? spec.system : undefined,
      session,
      mcp: spec.mcp,
      manager: spec.manager,
      signal,
    });
    if (result.session) {
      kvSet(`session:${spec.id}`, result.session);
      kvSet(`session-rt:${spec.id}`, spec.runtime);
    }
    // Usage on a CLI login is covered by the plan; any dollar figure the CLI reports is notional.
    this.hooks.onUsage(spec.id, result.usage, result.costUsd ?? 0, true);
    emit(spec.id, 'usage', { ...result.usage, model: spec.model || 'default' });
    return result.text;
  }

  // ---------- API runtimes ----------

  private async nativeTurn(spec: AgentSpec, items: InboxItem[], signal: AbortSignal): Promise<string> {
    if (!spec.model) {
      throw new Error(`No model chosen for ${runtimeDef(spec.runtime).label}. Pick one in Settings.`);
    }
    const provider = getProvider(spec.runtime);
    const defs = spec.tools.map(toolDef);
    let msgs = messages.load<Msg>(spec.id);

    const push = (msg: Msg) => {
      messages.append(spec.id, msgs.length, msg);
      msgs.push(msg);
    };

    // If a previous run died between a tool call and its result, close the loop so the
    // history is valid again.
    const tail = msgs.at(-1);
    if (tail?.role === 'assistant') {
      const open = tail.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call' && !p.server);
      if (open.length) {
        push({
          role: 'user',
          parts: open.map((c) => ({
            type: 'tool_result' as const,
            id: c.id,
            name: c.name,
            output: 'This call was interrupted before it finished (the harness stopped). Check the current state before repeating it.',
            isError: true,
          })),
        });
      }
    }

    if (kvGet<number>(`ctx:${spec.id}`, 0) > getSettings().compactAtTokens && msgs.length > 2) {
      msgs = await this.compact(spec, msgs, signal);
    }

    push({ role: 'user', parts: items.map((i) => ({ type: 'text' as const, text: i.text })) });

    let continuations = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal.aborted) throw new Error('aborted');
      const block = `${spec.id}:${Date.now()}:${round}`;
      const res = await provider.chat({
        model: spec.model,
        system: spec.system,
        messages: msgs,
        tools: defs,
        effort: spec.effort,
        webSearch: true,
        thinkingFloor: kvGet<number>(`floor:${spec.id}`, 0),
        signal,
        onDelta: (kind, text) => emitDelta(spec.id, `${block}:${kind}`, kind, text),
      });
      if (res.thinkingFloor !== undefined) kvSet(`floor:${spec.id}`, res.thinkingFloor);
      kvSet(`ctx:${spec.id}`, res.usage.input);
      this.hooks.onUsage(spec.id, res.usage, costOf(spec.runtime, res.model, res.usage), false);
      push(res.message);

      for (const p of res.message.parts) {
        if (p.type === 'thinking') emit(spec.id, 'thinking', { text: p.text, block: `${block}:thinking` });
        else if (p.type === 'text') emit(spec.id, 'text', { text: p.text, block: `${block}:text` });
        else if (p.type === 'tool_call') emit(spec.id, 'tool_call', { id: p.id, name: p.name, input: p.input, server: p.server });
        else if (p.type === 'tool_result') emit(spec.id, 'tool_result', { id: p.id, output: p.output, isError: p.isError });
      }
      emit(spec.id, 'usage', { ...res.usage, model: res.model });

      if (res.stop === 'pause') continue;
      if (res.stop === 'refusal') {
        emit(spec.id, 'notice', { text: 'The model declined to continue with this request.' });
        return textOf(res.message) || 'The model declined this request.';
      }

      const calls = res.message.parts.filter(
        (p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call' && !p.server,
      );
      if (!calls.length) {
        if (res.stop === 'max_tokens' && continuations++ < 3) {
          push({ role: 'user', parts: [{ type: 'text', text: 'Your reply was cut off by the output limit. Continue from exactly where you stopped.' }] });
          continue;
        }
        return textOf(res.message);
      }

      // A reply cut off mid tool call usually still parses as a valid, truncated input. Never run it.
      const outputs: Part[] =
        res.stop === 'max_tokens'
          ? calls.map((c) => ({
              type: 'tool_result' as const,
              id: c.id,
              name: c.name,
              output: 'This call was cut off by the output limit before its input was complete, so it was not run. Retry with a smaller input (write large files in several parts).',
              isError: true,
            }))
          : await Promise.all(calls.map((c) => this.runTool(spec, c, signal)));
      for (const o of outputs) {
        if (o.type === 'tool_result') emit(spec.id, 'tool_result', { id: o.id, output: o.output, isError: o.isError });
      }
      if (signal.aborted) throw new Error('aborted');

      // Anything that arrived while the agent was working joins the conversation here,
      // after the tool results, so the history stays append-only.
      const late = this.take(spec.id);
      for (const it of late) {
        emit(spec.id, 'user', { from: it.from, text: it.display ?? it.text, via: it.via, voice: it.voice });
        // A message folded in mid-turn is answered by this turn's reply, so it counts as a prompt for it.
        items.push(it);
      }
      push({ role: 'user', parts: [...outputs, ...late.map((i) => ({ type: 'text' as const, text: i.text }))] });

      if (res.usage.input > getSettings().compactAtTokens) msgs = await this.compact(spec, msgs, signal);
    }
    emit(spec.id, 'notice', { text: `Stopped after ${MAX_ROUNDS} steps without finishing.` });
    return `Stopped after ${MAX_ROUNDS} steps without reaching a final answer. The work so far is in the workspace.`;
  }

  private async runTool(spec: AgentSpec, call: Extract<Part, { type: 'tool_call' }>, signal: AbortSignal): Promise<Part> {
    const fail = (output: string): Part => ({ type: 'tool_result', id: call.id, name: call.name, output, isError: true });
    const tool = spec.tools.find((t) => t.name === call.name);
    if (!tool) return fail(`There is no tool named "${call.name}". Available: ${spec.tools.map((t) => t.name).join(', ')}.`);
    if (call.invalid !== undefined) return fail(`The arguments were not valid JSON, so the tool was not run. Received: ${call.invalid.slice(0, 400)}`);
    // Inputs are validated here, not by the provider: streamed tool input can arrive truncated.
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return fail(`Invalid input for ${call.name} — ${issues}. The tool was not run.`);
    }
    try {
      const output = await tool.run(parsed.data, { agentId: spec.id, cwd: spec.cwd, signal, host: this.hooks.host });
      return { type: 'tool_result', id: call.id, name: call.name, output };
    } catch (err) {
      if (signal.aborted) return fail('Stopped.');
      return fail(err instanceof ToolError ? err.message : `${call.name} failed: ${describeError(err)}`);
    }
  }

  /**
   * Replace the whole history with a summary the model writes for itself. Nothing older is
   * replayed afterwards, which is the one client-side trim that never invalidates provider state.
   */
  private async compact(spec: AgentSpec, msgs: Msg[], signal: AbortSignal): Promise<Msg[]> {
    emit(spec.id, 'notice', { text: 'Context is getting long — summarising earlier conversation to make room.' });
    const provider = getProvider(spec.runtime);
    const res = await provider.chat({
      model: spec.model,
      system: spec.system,
      messages: [...msgs, { role: 'user', parts: [{ type: 'text', text: COMPACT_PROMPT }] }],
      // Same tools and settings as the main loop, so the request shares its cached prefix.
      tools: spec.tools.map(toolDef),
      effort: spec.effort,
      webSearch: true,
      thinkingFloor: kvGet<number>(`floor:${spec.id}`, 0),
      signal,
      onDelta: () => {},
    });
    this.hooks.onUsage(spec.id, res.usage, costOf(spec.runtime, res.model, res.usage), false);
    const summary = textOf(res.message) || '(The summary came back empty. Use your tools to look at the current state before continuing.)';
    const fresh: Msg[] = [
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text: `<summary>\nEarlier conversation was trimmed. This is the handoff note you wrote:\n\n${summary}\n</summary>\n\nContinue from here.`,
          },
        ],
      },
    ];
    messages.replaceAll(spec.id, fresh);
    kvSet(`floor:${spec.id}`, 0);
    kvSet(`ctx:${spec.id}`, 0);
    return fresh;
  }
}

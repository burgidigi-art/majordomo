import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Effort, RuntimeId } from '../../shared/types.ts';
import { emit, emitDelta } from '../bus.ts';
import { recordClaudeLimits } from '../limits.ts';
import { EMPTY_USAGE, type Usage } from '../llm/types.ts';
import { cliBinary, getSettings } from '../settings.ts';

/**
 * Drivers for the vendors' own agent CLIs in headless mode. This is how subscription logins
 * (a Claude plan, a ChatGPT plan, a Google account) are used: the CLI holds the login, the
 * harness starts it with a prompt and translates its event stream into dashboard events.
 */

export interface CliTurn {
  agentId: string;
  runtime: RuntimeId;
  model: string;
  effort?: Effort | null;
  cwd: string;
  prompt: string;
  /** System prompt for the PM. Workers keep the CLI's own. */
  system?: string;
  /** Session to resume, from a previous turn's result. */
  session?: string | null;
  /** When set, the CLI is connected to the harness's MCP endpoint (the PM's tools). */
  mcp?: { url: string; token: string };
  /** PM turns get no shell or file-editing tools. */
  manager: boolean;
  signal: AbortSignal;
}

export interface CliResult {
  text: string;
  session: string | null;
  usage: Usage;
  costUsd?: number;
}

interface Driver {
  args(turn: CliTurn): { args: string[]; stdin?: string; env?: Record<string, string>; session?: string };
  /** Handles one JSON line. Returns nothing; mutates state and emits events. */
  onLine(line: any, state: RunState): void;
}

interface RunState {
  turn: CliTurn;
  text: string;
  session: string | null;
  usage: Usage;
  costUsd?: number;
  error?: string;
  block: number;
  /** Tool-call ids already shown, so started/completed pairs are not duplicated. */
  seen: Set<string>;
}

const stringify = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '');

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : stringify(c))).join('\n');
  }
  return stringify(content);
}

// ---------- Claude Code ----------

const claude: Driver = {
  args(turn) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (turn.model) args.push('--model', turn.model);
    if (turn.effort) args.push('--effort', turn.effort);
    if (turn.session) args.push('--resume', turn.session);
    if (turn.manager) {
      if (turn.system) args.push('--system-prompt', turn.system);
      // The PM manages; it gets read-only built-ins plus the harness's own tools over MCP.
      args.push('--tools', 'Read,Glob,Grep,WebFetch,WebSearch');
      args.push('--allowedTools', 'mcp__majordomo,Read,Glob,Grep,WebFetch,WebSearch');
    } else {
      const ask = getSettings().approvalMode === 'ask';
      args.push('--permission-mode', 'acceptEdits');
      const own = ask ? 'Read,Glob,Grep,WebFetch,WebSearch' : 'Bash,Read,Glob,Grep,WebFetch,WebSearch';
      args.push('--allowedTools', turn.mcp ? `${own},mcp__majordomo` : own);
    }
    if (turn.mcp) {
      const config = {
        mcpServers: {
          majordomo: { type: 'http', url: turn.mcp.url, headers: { Authorization: `Bearer ${turn.mcp.token}` } },
        },
      };
      args.push('--mcp-config', JSON.stringify(config));
      // The manager works only through the harness. A worker keeps whatever else the user has set up.
      if (turn.manager) args.push('--strict-mcp-config');
    }
    return { args, stdin: turn.prompt };
  },
  onLine(line, s) {
    const id = s.turn.agentId;
    switch (line.type) {
      case 'system':
        if (line.subtype === 'init' && line.session_id) s.session = line.session_id;
        break;
      case 'rate_limit_event':
        recordClaudeLimits(line.rate_limit_info);
        break;
      case 'stream_event': {
        if (line.parent_tool_use_id) break;
        const ev = line.event;
        if (ev?.type === 'message_start') s.block++;
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') emitDelta(id, `cli:${s.block}:text`, 'text', ev.delta.text);
          if (ev.delta?.type === 'thinking_delta') emitDelta(id, `cli:${s.block}:thinking`, 'thinking', ev.delta.thinking);
        }
        break;
      }
      case 'assistant': {
        const sub = !!line.parent_tool_use_id;
        for (const b of line.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) {
            if (!sub) s.text = b.text;
            emit(id, 'text', { text: b.text, block: `cli:${s.block}:text`, sub });
          } else if (b.type === 'thinking' && b.thinking?.trim()) {
            emit(id, 'thinking', { text: b.thinking, block: `cli:${s.block}:thinking`, sub });
          } else if (b.type === 'tool_use') {
            emit(id, 'tool_call', { id: b.id, name: b.name, input: b.input ?? {}, sub });
          }
        }
        break;
      }
      case 'user':
        for (const b of Array.isArray(line.message?.content) ? line.message.content : []) {
          if (b.type === 'tool_result') {
            emit(id, 'tool_result', { id: b.tool_use_id, output: resultText(b.content).slice(0, 20_000), isError: !!b.is_error });
          }
        }
        break;
      case 'result': {
        if (line.session_id) s.session = line.session_id;
        const u = line.usage ?? {};
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheWrite = u.cache_creation_input_tokens ?? 0;
        s.usage = { input: (u.input_tokens ?? 0) + cacheRead + cacheWrite, output: u.output_tokens ?? 0, cacheRead, cacheWrite };
        if (typeof line.total_cost_usd === 'number') s.costUsd = line.total_cost_usd;
        if (typeof line.result === 'string' && line.result.trim()) s.text = line.result;
        if (line.is_error || (line.subtype && line.subtype !== 'success')) {
          s.error = typeof line.result === 'string' && line.result ? line.result : `Claude Code stopped: ${line.subtype}`;
        }
        break;
      }
    }
  },
};

// ---------- Codex CLI ----------

const codex: Driver = {
  args(turn) {
    const s = getSettings();
    const args = ['exec'];
    if (turn.session) args.push('resume', turn.session);
    args.push('--json', '--skip-git-repo-check');
    if (!turn.session) args.push('-C', turn.cwd);
    if (turn.model) args.push('-m', turn.model);
    if (turn.effort) args.push('-c', `model_reasoning_effort="${turn.effort === 'max' ? 'xhigh' : turn.effort}"`);
    if (turn.manager) {
      args.push('-s', 'read-only');
    } else if (s.codexSandbox === 'danger-full-access') {
      args.push('-s', 'danger-full-access');
    } else {
      args.push('-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true');
    }
    const env: Record<string, string> = {};
    if (turn.mcp) {
      args.push('-c', `mcp_servers.majordomo.url="${turn.mcp.url}"`);
      args.push('-c', 'mcp_servers.majordomo.bearer_token_env_var="MAJORDOMO_MCP_TOKEN"');
      env.MAJORDOMO_MCP_TOKEN = turn.mcp.token;
    }
    args.push('-');
    // Codex has no system-prompt flag; the PM's instructions lead the first prompt of the session.
    const stdin = turn.system && !turn.session ? `${turn.system}\n\n---\n\n${turn.prompt}` : turn.prompt;
    return { args, stdin, env };
  },
  onLine(line, s) {
    const id = s.turn.agentId;
    switch (line.type) {
      case 'thread.started':
        if (line.thread_id) s.session = line.thread_id;
        break;
      case 'item.started':
      case 'item.completed': {
        const item = line.item ?? {};
        const done = line.type === 'item.completed';
        const callId = `codex_${item.id}`;
        const open = (name: string, input: unknown) => {
          if (s.seen.has(callId)) return;
          s.seen.add(callId);
          emit(id, 'tool_call', { id: callId, name, input });
        };
        if (item.type === 'agent_message' && done && item.text?.trim()) {
          s.text = item.text;
          emit(id, 'text', { text: item.text });
        } else if (item.type === 'reasoning' && done && item.text?.trim()) {
          emit(id, 'thinking', { text: item.text });
        } else if (item.type === 'command_execution') {
          open('shell', { command: item.command });
          if (done) {
            emit(id, 'tool_result', {
              id: callId,
              output: String(item.aggregated_output ?? '').slice(0, 20_000) || '(no output)',
              isError: item.exit_code !== 0 && item.exit_code != null,
            });
          }
        } else if (item.type === 'file_change' && done) {
          open('edit_files', { changes: item.changes });
          emit(id, 'tool_result', { id: callId, output: item.status ?? 'applied', isError: item.status === 'failed' });
        } else if (item.type === 'mcp_tool_call') {
          open(`${item.server}.${item.tool}`, item.arguments ?? {});
          if (done) {
            emit(id, 'tool_result', {
              id: callId,
              output: item.error ? stringify(item.error.message ?? item.error) : resultText(item.result?.content ?? item.result ?? ''),
              isError: !!item.error || item.status === 'failed',
            });
          }
        } else if (item.type === 'web_search' && done) {
          open('web_search', { query: item.query });
          emit(id, 'tool_result', { id: callId, output: 'searched', isError: false });
        } else if (item.type === 'error' && done) {
          emit(id, 'notice', { text: item.message });
        }
        break;
      }
      case 'turn.completed': {
        const u = line.usage ?? {};
        s.usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cached_input_tokens ?? 0,
          cacheWrite: 0,
        };
        break;
      }
      case 'turn.failed':
        s.error = line.error?.message ?? 'Codex turn failed';
        break;
      case 'error':
        s.error = line.message ?? 'Codex error';
        break;
    }
  },
};

// ---------- Gemini CLI ----------

const gemini: Driver = {
  args(turn) {
    const args = ['-o', 'stream-json', '--skip-trust'];
    if (turn.model) args.push('-m', turn.model);
    let session = turn.session ?? undefined;
    if (session) args.push('--resume', session);
    else args.push('--session-id', (session = randomUUID()));
    args.push('--approval-mode', turn.manager ? 'default' : getSettings().approvalMode === 'ask' ? 'auto_edit' : 'yolo');
    if (turn.mcp && turn.manager) {
      // Gemini CLI reads MCP servers from the project's .gemini/settings.json. Only the manager's own
      // folder gets one: writing a token into a project workspace is not worth it for a worker.
      const dir = path.join(turn.cwd, '.gemini');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify(
          {
            mcpServers: {
              majordomo: { httpUrl: turn.mcp.url, headers: { Authorization: `Bearer ${turn.mcp.token}` }, trust: true },
            },
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      args.push('--allowed-mcp-server-names', 'majordomo');
    }
    const prompt = turn.system && !turn.session ? `${turn.system}\n\n---\n\n${turn.prompt}` : turn.prompt;
    // -p switches the CLI to headless mode; the prompt itself goes in on stdin, which has no length limit.
    args.push('-p', 'Carry out the request above.');
    return { args, stdin: prompt, session };
  },
  onLine(line, s) {
    const id = s.turn.agentId;
    switch (line.type) {
      case 'init':
        if (line.session_id) s.session = line.session_id;
        break;
      case 'message':
        if (line.role === 'assistant' && typeof line.content === 'string') {
          if (line.delta) {
            s.text += line.content;
            emitDelta(id, `cli:${s.block}:text`, 'text', line.content);
          } else {
            s.text = line.content;
          }
        }
        break;
      case 'tool_use':
        // Text streamed before a tool call is commentary, not the final report.
        if (s.text.trim()) emit(id, 'text', { text: s.text, block: `cli:${s.block}:text` });
        s.text = '';
        s.block++;
        emit(id, 'tool_call', { id: line.tool_id, name: line.tool_name, input: line.parameters ?? {} });
        break;
      case 'tool_result':
        emit(id, 'tool_result', {
          id: line.tool_id,
          output: (line.output ?? line.error?.message ?? '').toString().slice(0, 20_000) || '(no output)',
          isError: line.status === 'error',
        });
        break;
      case 'error':
        emit(id, 'notice', { text: line.message ?? stringify(line) });
        break;
      case 'result': {
        const st = line.stats ?? {};
        s.usage = { input: st.input_tokens ?? 0, output: st.output_tokens ?? 0, cacheRead: st.cached ?? 0, cacheWrite: 0 };
        if (line.status === 'error') s.error = line.error?.message ?? 'Gemini CLI failed';
        if (s.text.trim()) emit(id, 'text', { text: s.text, block: `cli:${s.block}:text` });
        break;
      }
    }
  },
};

const DRIVERS: Partial<Record<RuntimeId, Driver>> = { 'claude-code': claude, codex, 'gemini-cli': gemini };

export function runCliTurn(turn: CliTurn): Promise<CliResult> {
  const driver = DRIVERS[turn.runtime];
  if (!driver) throw new Error(`No CLI driver for ${turn.runtime}`);
  const bin = cliBinary(turn.runtime as 'claude-code' | 'codex' | 'gemini-cli');
  const built = driver.args(turn);
  fs.mkdirSync(turn.cwd, { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(bin, built.args, {
      cwd: turn.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...built.env, NO_COLOR: '1' },
    });
    const state: RunState = {
      turn,
      text: '',
      session: built.session ?? turn.session ?? null,
      usage: { ...EMPTY_USAGE },
      block: 0,
      seen: new Set(),
    };
    let stderr = '';
    let stray = '';

    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    turn.signal.addEventListener('abort', kill, { once: true });

    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < 8000) stderr += b.toString('utf8');
    });
    child.stdin.on('error', () => {});
    child.stdin.end(built.stdin ?? '');

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (raw) => {
      const line = raw.trim();
      if (!line) return;
      if (!line.startsWith('{')) {
        if (stray.length < 4000) stray += `${line}\n`;
        return;
      }
      try {
        driver.onLine(JSON.parse(line), state);
      } catch {
        // A line we cannot parse is not worth failing the agent's turn over.
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      turn.signal.removeEventListener('abort', kill);
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `Could not start \`${bin}\`. Is the CLI installed and on your PATH?`
            : `Could not start \`${bin}\`: ${err.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      turn.signal.removeEventListener('abort', kill);
      if (turn.signal.aborted) return reject(new Error('aborted'));
      if (state.error) return reject(new Error(state.error));
      if (code !== 0 && !state.text) {
        const detail = (stderr || stray).trim().split('\n').slice(-6).join('\n');
        return reject(new Error(`\`${bin}\` exited with code ${code}.${detail ? `\n${detail}` : ''}`));
      }
      resolve({ text: state.text.trim(), session: state.session, usage: state.usage, costUsd: state.costUsd });
    });
  });
}

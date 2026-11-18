import type { Context } from 'hono';
import { describeError } from './llm/index.ts';
import { projects, tasks } from './db.ts';
import { googleConnected } from './google.ts';
import { agentHost, mailboxTools, MCP_TOKEN, orch, VERSION } from './orchestrator.ts';
import { taskCleared, workerToken } from './privacy.ts';
import { enabledPluginNames, pluginTools } from './plugins.ts';
import { pmTools } from './tools/pm.ts';
import { ToolError, toolDef, type Host, type Tool } from './tools/tool.ts';

/**
 * A minimal Model Context Protocol server (Streamable HTTP, stateless, JSON responses).
 * When the PM runs on a subscription CLI — Claude Code, Codex, Gemini CLI — the CLI owns the
 * model loop, and this endpoint is how it reaches the PM's tools.
 */

const noHost: Host = {
  progress() {},
  askManager: async () => '',
  delegate: async () => '',
  approve: async () => true,
};

/** Everything the manager can use over MCP. web_fetch is left out: every CLI already has its own. */
const managerTools = (): Tool[] => [...pmTools(orch).filter((t) => t.name !== 'web_fetch'), ...mailboxTools()];

interface Caller {
  agentId: string;
  cwd: string;
  host: Host;
}

const managerCaller: Caller = { agentId: 'pm', cwd: process.cwd(), host: noHost };

async function handle(msg: any, tools: Tool[], caller: Caller = managerCaller): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  // Notifications carry no id and get no response.
  if (msg.id === undefined || msg.id === null) return null;

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'majordomo', version: VERSION },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(toolDef).map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
      const parsed = tool.input.safeParse(msg.params?.arguments ?? {});
      const text = (t: string, isError = false) => reply({ content: [{ type: 'text', text: t }], isError });
      if (!parsed.success) {
        return text(`Invalid input — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, true);
      }
      try {
        const out = await tool.run(parsed.data, { agentId: caller.agentId, cwd: caller.cwd, signal: new AbortController().signal, host: caller.host });
        return text(typeof out === 'string' ? out : out.text);
      } catch (err) {
        return text(err instanceof ToolError ? err.message : describeError(err), true);
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/**
 * The tools a worker on a CLI account gets from 00Dojo: email and calendar when connected and the
 * crew member is cleared for private work, and the plugin tools. Calls run as that task, so
 * approvals show which agent is asking.
 */
function workerEndpointFor(agentId: string): { tools: Tool[]; caller: Caller } | null {
  const t = tasks.get(agentId);
  if (!t) return null;
  const cwd = projects.get(t.projectId)?.workspace ?? process.cwd();
  return {
    tools: [...(googleConnected() && taskCleared(t) ? mailboxTools() : []), ...(enabledPluginNames().length ? pluginTools() : [])],
    caller: { agentId, cwd, host: agentHost },
  };
}

/**
 * `/mcp` serves the manager, and takes the manager's token. `/mcp/worker/<task>` serves one worker
 * its email, calendar and plugin tools, and takes a token made for that task alone: a worker's
 * token opens neither the manager's tools nor another task's.
 */
export async function mcpEndpoint(c: Context): Promise<Response> {
  const pathname = new URL(c.req.url).pathname;
  const worker = /^\/mcp\/worker\/([^/]+)$/.exec(pathname);
  const expected = worker ? workerToken(MCP_TOKEN, decodeURIComponent(worker[1]!)) : MCP_TOKEN;
  if (c.req.header('authorization') !== `Bearer ${expected}`) return c.json({ error: 'unauthorized' }, 401);
  if (c.req.method !== 'POST') return c.body(null, 405, { Allow: 'POST' });
  let caller = managerCaller;
  let tools: Tool[];
  if (worker) {
    const found = workerEndpointFor(decodeURIComponent(worker[1]!));
    if (!found) return c.json({ error: 'unknown agent' }, 404);
    tools = found.tools;
    caller = found.caller;
  } else {
    tools = managerTools();
  }
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, tools, caller)))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await handle(body, tools, caller);
  return out ? c.json(out) : c.body(null, 202);
}

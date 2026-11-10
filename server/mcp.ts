import type { Context } from 'hono';
import { describeError } from './llm/index.ts';
import { MCP_TOKEN, orch, VERSION } from './orchestrator.ts';
import { googleTools } from './tools/google.ts';
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
const managerTools = (): Tool[] => [...pmTools(orch).filter((t) => t.name !== 'web_fetch'), ...googleTools()];

async function handle(msg: any, tools: Tool[]): Promise<object | null> {
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
        const out = await tool.run(parsed.data, { agentId: 'pm', cwd: process.cwd(), signal: new AbortController().signal, host: noHost });
        return text(typeof out === 'string' ? out : out.text);
      } catch (err) {
        return text(err instanceof ToolError ? err.message : describeError(err), true);
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** `/mcp` serves the manager; `/mcp/google` serves worker agents the email and calendar tools only. */
export async function mcpEndpoint(c: Context): Promise<Response> {
  if (c.req.header('authorization') !== `Bearer ${MCP_TOKEN}`) return c.json({ error: 'unauthorized' }, 401);
  if (c.req.method !== 'POST') return c.body(null, 405, { Allow: 'POST' });
  const tools = new URL(c.req.url).pathname === '/mcp/google' ? googleTools() : managerTools();
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m, tools)))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await handle(body, tools);
  return out ? c.json(out) : c.body(null, 202);
}

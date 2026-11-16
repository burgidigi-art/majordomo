// A minimal Model Context Protocol client, the counterpart of mcp.ts. Plugin tools (Notion, GitHub,
// a database, a design tool…) are MCP servers: either a program started on this computer that talks
// over stdin/stdout, or an address on the web. This connects to one, lists its tools and calls them.
import { spawn, type ChildProcess } from 'node:child_process';

export type ServerDef =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { transport: 'http'; url: string; headers: Record<string, string> };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The server says the tool only reads: it changes nothing. */
  readOnly: boolean;
}

export interface CallResult {
  text: string;
  isError: boolean;
}

/** The server wants the user to sign in (OAuth) before it will talk. */
export class NeedsSignIn extends Error {}

const PROTOCOL = '2025-06-18';
const clientInfo = { name: 'majordomo', version: '1' };

/** Turn an MCP tool result into text a model can read. */
export function resultText(result: any): CallResult {
  const parts: string[] = [];
  for (const c of result?.content ?? []) {
    if (c?.type === 'text') parts.push(String(c.text ?? ''));
    else if (c?.type === 'image') parts.push(`[an image (${c.mimeType ?? 'image'}) was returned]`);
    else if (c?.type === 'resource') parts.push(String(c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`));
    else if (c?.type === 'resource_link') parts.push(`[${c.name ?? 'link'}: ${c.uri ?? ''}]`);
  }
  if (!parts.length && result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return { text: parts.join('\n\n') || '(the tool returned nothing)', isError: !!result?.isError };
}

const toTool = (t: any): McpTool => ({
  name: String(t?.name ?? ''),
  description: String(t?.description ?? t?.title ?? ''),
  inputSchema: t?.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
  readOnly: t?.annotations?.readOnlyHint === true,
});

export class McpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private child: ChildProcess | null = null;
  private session = '';
  private stderr = '';
  private closed = false;

  constructor(private readonly def: ServerDef) {}

  /** Connect and introduce ourselves. A slow first start (npx downloading a package) is allowed for. */
  async start(timeoutMs = 90_000): Promise<void> {
    if (this.def.transport === 'stdio') this.spawn();
    await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo }, timeoutMs);
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(res?.tools ?? []).map(toTool).filter((t: McpTool) => t.name));
      cursor = res?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: unknown, timeoutMs = 120_000): Promise<CallResult> {
    return resultText(await this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs));
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('The plugin was closed.'));
    this.pending.clear();
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }

  get alive(): boolean {
    return !this.closed && (this.def.transport === 'http' || (!!this.child && this.child.exitCode === null));
  }

  // ---------- stdio ----------

  private spawn(): void {
    const def = this.def as Extract<ServerDef, { transport: 'stdio' }>;
    const child = spawn(def.command, def.args, {
      cwd: def.cwd,
      env: { ...process.env, ...def.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          /* a server printing something that is not a message: ignore it */
        }
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    const fail = (why: string) => {
      const last = this.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      for (const p of this.pending.values()) p.reject(new Error(`${why}${last ? `: ${last}` : ''}`));
      this.pending.clear();
    };
    child.on('error', (err) => fail(`Could not start ${def.command} (${err.message})`));
    child.on('exit', (code) => {
      if (!this.closed) fail(`The plugin stopped (exit ${code})`);
    });
    child.stdin!.on('error', () => {});
  }

  private receive(msg: any): void {
    if (msg?.id === undefined || msg.id === null) return;
    // A request from the server (sampling, roots…): say we do not support it.
    if (msg.method) {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported by this client' } });
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(String(msg.error.message ?? 'The plugin returned an error')));
    else p.resolve(msg.result);
  }

  private send(msg: object): void {
    this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  // ---------- requests ----------

  private async request(method: string, params: object, timeoutMs = 60_000): Promise<any> {
    if (this.closed) throw new Error('The plugin is closed.');
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    if (this.def.transport === 'http') return this.httpRequest(msg, timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The plugin did not answer ${method} within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send(msg);
    });
  }

  private async notify(method: string): Promise<void> {
    const msg = { jsonrpc: '2.0', method };
    if (this.def.transport === 'http') await this.httpRequest(msg, 30_000).catch(() => {});
    else this.send(msg);
  }

  private async post(def: Extract<ServerDef, { transport: 'http' }>, msg: object, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(def.url, {
        method: 'POST',
        headers: {
          ...def.headers,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL,
          ...(this.session ? { 'Mcp-Session-Id': this.session } : {}),
        },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // fetch says only "fetch failed"; the reason is underneath.
      const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
      const why = err instanceof Error && err.name === 'TimeoutError' ? 'it did not answer in time' : (cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err)));
      throw new Error(`Could not reach ${new URL(def.url).host} (${why}).`);
    }
  }

  /** Streamable HTTP: POST the message; the answer comes back as JSON or as a short event stream. */
  private async httpRequest(msg: { id?: number; method: string }, timeoutMs: number): Promise<any> {
    const def = this.def as Extract<ServerDef, { transport: 'http' }>;
    const res = await this.post(def, msg, timeoutMs);
    const session = res.headers.get('mcp-session-id');
    if (session) this.session = session;
    if (res.status === 401 || res.status === 403) throw new NeedsSignIn('This plugin needs you to sign in to it.');
    if (msg.id === undefined) return null;
    if (!res.ok) throw new Error(`The plugin answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
    const type = res.headers.get('content-type') ?? '';
    const text = await res.text();
    let reply: any = null;
    if (type.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const m = JSON.parse(data);
          if (m?.id === msg.id) reply = m;
        } catch {
          /* not JSON */
        }
      }
    } else {
      reply = text ? JSON.parse(text) : null;
      if (Array.isArray(reply)) reply = reply.find((m) => m?.id === msg.id);
    }
    if (!reply) throw new Error('The plugin sent no answer.');
    if (reply.error) throw new Error(String(reply.error.message ?? 'The plugin returned an error'));
    return reply.result;
  }
}

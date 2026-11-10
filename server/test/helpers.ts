import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** Point the harness at a throwaway data directory. Call before importing any server module. */
export function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'majordomo-test-'));
  process.env.MAJORDOMO_HOME = dir;
  return dir;
}

export interface Recorded {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** A local stand-in for a model API: records each request and lets the test script the reply. */
export async function mockApi(
  reply: (req: Recorded, n: number) => { status?: number; json?: unknown; sse?: string[] },
): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const rec: Recorded = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null };
      requests.push(rec);
      const out = reply(rec, requests.length);
      if (out.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const frame of out.sse) res.write(frame);
        res.end();
      } else {
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json ?? {}));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

#!/usr/bin/env node
// Experimental: report the model fields of a Cursor agent-hook payload to the Model Watch
// companion.
//
// Cursor's hooks pass every hook a JSON payload on stdin that includes `model`, `model_id`
// and `model_params` for the conversation. Whether Grok Bot runs plugin hooks at all is
// undocumented and reports conflict, so this script is built to be harmless: it never
// blocks, never fails the hook, sends only identifiers (no prompt or reply text, no email),
// and does nothing unless a destination is configured in MODEL_WATCH_URL /
// MODEL_WATCH_REPORT_TOKEN or in ~/.grokbot-model-watch/hook.json ({"url": "...", "token": "..."}).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const done = () => {
  process.stdout.write('{}\n');
  process.exit(0);
};

function destination() {
  let url = process.env.MODEL_WATCH_URL || '';
  let token = process.env.MODEL_WATCH_REPORT_TOKEN || '';
  if (!url || !token) {
    try {
      const file = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.grokbot-model-watch', 'hook.json'), 'utf8'));
      url = url || (typeof file.url === 'string' ? file.url : '');
      token = token || (typeof file.token === 'string' ? file.token : '');
    } catch {
      // not configured
    }
  }
  if (!/^https?:\/\//.test(url) || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : null);

async function main() {
  const dest = destination();
  if (!dest) return;
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 8 * 1024 * 1024) break;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== 'object') return;
  const report = {
    event: str(payload.hook_event_name),
    model: str(payload.model),
    modelId: str(payload.model_id),
    modelParams: Array.isArray(payload.model_params)
      ? payload.model_params.slice(0, 12).map((p) => ({ id: str(p && p.id), value: str(p && p.value) })).filter((p) => p.id)
      : [],
    conversationId: str(payload.conversation_id),
    generationId: str(payload.generation_id),
    clientVersion: str(payload.cursor_version),
  };
  if (!report.model && !report.modelId) return;
  await fetch(`${dest.url}/api/hook-report`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${dest.token}` },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(2500),
  }).catch(() => {});
}

const guard = setTimeout(done, 4000);
guard.unref();
main().catch(() => {}).finally(done);

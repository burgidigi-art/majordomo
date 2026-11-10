import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Msg, Provider, ToolDef } from '../llm/types.ts';
import { mockApi, tempHome, type Recorded } from './helpers.ts';

const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function stream(blocks: object[][], stop: string): string[] {
  const out = [
    ev('message_start', {
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null,
        stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
      },
    }),
  ];
  blocks.forEach(([start, ...deltas], index) => {
    out.push(ev('content_block_start', { index, content_block: start }));
    for (const delta of deltas) out.push(ev('content_block_delta', { index, delta }));
    out.push(ev('content_block_stop', { index }));
  });
  out.push(ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }));
  out.push(ev('message_stop', {}));
  return out;
}

const hasThinking = (req: Recorded) =>
  req.body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'thinking'));

let api: Awaited<ReturnType<typeof mockApi>>;
let provider: Provider;
const tools: ToolDef[] = [{ name: 'echo', description: 'Echo text', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let home = '';

before(async () => {
  home = tempHome();
  api = await mockApi((req, n) => {
    if (n === 1) {
      return {
        sse: stream(
          [
            [{ type: 'thinking', thinking: '', signature: '' }, { type: 'thinking_delta', thinking: 'plan' }, { type: 'signature_delta', signature: 'sig' }],
            [{ type: 'text', text: '' }, { type: 'text_delta', text: 'Looking.' }],
            [{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: {} }, { type: 'input_json_delta', partial_json: '{"text":' }, { type: 'input_json_delta', partial_json: '"hi"}' }],
          ],
          'tool_use',
        ),
      };
    }
    // Simulate a rejected replay of thinking blocks; the adapter should drop them and retry.
    if (hasThinking(req)) {
      return { status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'thinking block no longer valid' } } };
    }
    return { sse: stream([[{ type: 'text', text: '' }, { type: 'text_delta', text: 'Done.' }]], 'end_turn') };
  });
  process.env.ANTHROPIC_BASE_URL = api.url;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  provider = (await import('../llm/anthropic.ts')).anthropicProvider;
});

after(() => api.close());

test('streams thinking, text and a tool call, and sends the expected request', async () => {
  const deltas: string[] = [];
  const res = await provider.chat({
    model: 'claude-opus-5-5',
    system: 'You are a test.',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    tools,
    effort: 'high',
    webSearch: true,
    signal: new AbortController().signal,
    onDelta: (kind, text) => deltas.push(`${kind}:${text}`),
  });
  assert.equal(res.stop, 'tool');
  assert.deepEqual(res.message.parts, [
    { type: 'thinking', text: 'plan' },
    { type: 'text', text: 'Looking.' },
    { type: 'tool_call', id: 'toolu_1', name: 'echo', input: { text: 'hi' } },
  ]);
  assert.deepEqual(deltas, ['thinking:plan', 'text:Looking.']);
  assert.equal(res.usage.input, 15, 'cached tokens count toward the context size');
  assert.equal(res.usage.cacheRead, 5);

  const req = api.requests[0];
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.deepEqual(req.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(req.body.output_config, { effort: 'high' });
  assert.deepEqual(req.body.cache_control, { type: 'ephemeral' });
  assert.equal(req.body.fallbacks, 'default');
  assert.match(String(req.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.equal(req.body.tools[0].eager_input_streaming, true);
  assert.equal(req.body.tools[1].type, 'web_search_20260209');
  assert.equal(req.body.temperature, undefined);

  // Second round: the tool result goes back with the assistant turn replayed verbatim.
  const history: Msg[] = [
    { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    res.message,
    { role: 'user', parts: [{ type: 'tool_result', id: 'toolu_1', name: 'echo', output: 'hi' }] },
  ];
  const res2 = await provider.chat({ model: 'claude-opus-5-5', system: 'You are a test.', messages: history, tools, signal: new AbortController().signal, onDelta: () => {} });
  assert.equal(res2.stop, 'end');
  assert.equal(api.requests.length, 3, 'one rejected attempt, then a retry');
  assert.ok(hasThinking(api.requests[1]), 'first attempt replays the thinking block unchanged');
  assert.ok(!hasThinking(api.requests[2]), 'retry drops thinking blocks');
  assert.equal(res2.thinkingFloor, history.length, 'the floor is reported so later requests stay consistent');
  const sent = api.requests[2].body.messages;
  assert.deepEqual(sent[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hi' });
  assert.equal(sent[1].content.find((b: any) => b.type === 'tool_use').id, 'toolu_1');
});

test('rebuilds turns that came from another provider', async () => {
  const before = api.requests.length;
  await provider.chat({
    model: 'claude-opus-5-5',
    system: 's',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call:1/x', name: 'echo', input: { text: 'a' } }], raw: { runtime: 'openai', model: 'm', content: {} } },
      { role: 'user', parts: [{ type: 'tool_result', id: 'call:1/x', name: 'echo', output: 'a' }] },
    ],
    tools,
    signal: new AbortController().signal,
    onDelta: () => {},
  });
  const sent = api.requests[before].body.messages;
  assert.deepEqual(sent[1].content, [{ type: 'tool_use', id: 'call_1_x', name: 'echo', input: { text: 'a' } }]);
  assert.equal(sent[2].content[0].tool_use_id, 'call_1_x', 'ids are sanitised the same way on both sides');
});

test('sends images as image blocks, in user turns and in tool results', async () => {
  const file = path.join(home, 'photo.png');
  fs.writeFileSync(file, Buffer.from(PNG, 'base64'));
  const before = api.requests.length;
  await provider.chat({
    model: 'claude-opus-5-5',
    system: 's',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'What is on the whiteboard?' }, { type: 'image', path: file, mime: 'image/png' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'toolu_5', name: 'echo', input: { text: 'x' } }] },
      {
        role: 'user',
        parts: [
          { type: 'tool_result', id: 'toolu_5', name: 'echo', output: 'Showing chart.png', images: [{ path: file, mime: 'image/png' }] },
          { type: 'image', path: path.join(home, 'gone.png'), mime: 'image/png' },
        ],
      },
    ],
    tools,
    signal: new AbortController().signal,
    onDelta: () => {},
  });
  const sent = api.requests[before].body.messages;
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
  assert.deepEqual(sent[0].content, [image, { type: 'text', text: 'What is on the whiteboard?' }], 'the image leads, the question follows');
  assert.deepEqual(sent[2].content[0], { type: 'tool_result', tool_use_id: 'toolu_5', content: [{ type: 'text', text: 'Showing chart.png' }, image] });
  assert.match(sent[2].content[1].text, /gone\.png\) but the file is no longer on disk/, 'a deleted image degrades to a note, not a failed request');
});

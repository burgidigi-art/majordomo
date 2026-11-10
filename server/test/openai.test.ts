import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Provider, ToolDef } from '../llm/types.ts';
import { mockApi, tempHome } from './helpers.ts';

const sse = (chunks: object[]) => [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'];
const delta = (d: object, finish: string | null = null) => ({ id: 'c1', model: 'test-model', choices: [{ index: 0, delta: d, finish_reason: finish }] });

let api: Awaited<ReturnType<typeof mockApi>>;
let provider: Provider;
let script: object[][] = [];
const tools: ToolDef[] = [
  { name: 'echo', description: 'Echo text', schema: { $schema: 'x', type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
];

before(async () => {
  tempHome();
  api = await mockApi(() => ({ sse: sse(script.shift() ?? []) }));
  process.env.OPENAI_BASE_URL = api.url;
  process.env.OPENAI_API_KEY = 'test-key';
  provider = (await import('../llm/openai.ts')).openaiProvider;
});

after(() => api.close());

const run = (messages: any[], effort?: 'high') =>
  provider.chat({ model: 'test-model', system: 'sys', messages, tools, effort, signal: new AbortController().signal, onDelta: () => {} });

test('assembles a tool call streamed in fragments, then continues the conversation', async () => {
  script = [
    [
      delta({ role: 'assistant', content: '' }),
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"te' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'xt":"hi"}' } }] }),
      delta({}, 'tool_calls'),
      { id: 'c1', model: 'test-model', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } },
    ],
    [delta({ content: 'All ' }), delta({ content: 'done.' }), delta({}, 'stop')],
  ];
  const first = await run([{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }], 'high');
  assert.equal(first.stop, 'tool');
  assert.deepEqual(first.message.parts, [{ type: 'tool_call', id: 'call_1', name: 'echo', input: { text: 'hi' }, invalid: undefined }]);
  assert.deepEqual(first.usage, { input: 12, output: 7, cacheRead: 4, cacheWrite: 0, costUsd: undefined });

  const req = api.requests[0].body;
  assert.equal(req.stream, true);
  assert.equal(req.reasoning_effort, 'high');
  assert.deepEqual(req.messages[0], { role: 'system', content: 'sys' });
  assert.equal(req.tools[0].function.parameters.$schema, undefined, 'the $schema key is stripped');

  const second = await run([
    { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    first.message,
    { role: 'user', parts: [{ type: 'tool_result', id: 'call_1', name: 'echo', output: 'hi' }, { type: 'text', text: 'also this' }] },
  ]);
  assert.equal(second.stop, 'end');
  assert.deepEqual(second.message.parts, [{ type: 'text', text: 'All done.' }]);
  const sent = api.requests[1].body.messages;
  assert.deepEqual(sent.map((m: any) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal(sent[2].tool_calls[0].function.arguments, '{"text":"hi"}');
  assert.deepEqual(sent[3], { role: 'tool', tool_call_id: 'call_1', content: 'hi' });
});

test('flags arguments that are not valid JSON instead of running the tool', async () => {
  script = [[delta({ tool_calls: [{ index: 0, id: 'call_2', function: { name: 'echo', arguments: '{"text": "unterminated' } }] }), delta({}, 'tool_calls')]];
  const res = await run([{ role: 'user', parts: [{ type: 'text', text: 'x' }] }]);
  const call = res.message.parts[0];
  assert.equal(call.type, 'tool_call');
  assert.equal(call.type === 'tool_call' && call.invalid, '{"text": "unterminated');
});

test('keeps parallel tool calls apart and rebuilds turns from another provider', async () => {
  script = [
    [
      delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'echo', arguments: '{"text":"1"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'echo', arguments: '{"text":"2"}' } }] }),
      delta({}, 'tool_calls'),
    ],
  ];
  const res = await run([
    { role: 'user', parts: [{ type: 'text', text: 'go' }] },
    {
      role: 'assistant',
      parts: [{ type: 'thinking', text: 'private' }, { type: 'text', text: 'ok' }, { type: 'tool_call', id: 'toolu_9', name: 'echo', input: { text: 'z' } }],
      raw: { runtime: 'anthropic', model: 'claude', content: [{ type: 'thinking', thinking: 'private', signature: 's' }] },
    },
    { role: 'user', parts: [{ type: 'tool_result', id: 'toolu_9', name: 'echo', output: 'z' }] },
  ]);
  assert.deepEqual(res.message.parts.map((p) => p.type === 'tool_call' && [p.id, p.input.text]), [['a', '1'], ['b', '2']]);
  const sent = api.requests.at(-1)!.body.messages;
  assert.deepEqual(sent[2], { role: 'assistant', content: 'ok', tool_calls: [{ id: 'toolu_9', type: 'function', function: { name: 'echo', arguments: '{"text":"z"}' } }] });
  assert.ok(!JSON.stringify(sent).includes('private'), 'another provider’s thinking is never forwarded');
});

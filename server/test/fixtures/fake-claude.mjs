#!/usr/bin/env node
// Stands in for Claude Code in headless stream-json mode: two model calls, the first reported twice as
// its content blocks arrive, then the run's total, which includes 10 more output tokens from a helper.
if (process.argv.includes('--version')) {
  console.log('2.1.400 (Claude Code)');
  process.exit(0);
}
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const msg = (id, content, usage) => ({ type: 'assistant', message: { id, model: 'claude-opus-5-5', content, usage } });
process.stdin.resume();
process.stdin.on('end', async () => {
  const wait = () => new Promise((r) => setTimeout(r, 120));
  out({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-5-5' });
  await wait();
  out(msg('m1', [{ type: 'thinking', thinking: 'Planning' }], { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 5 }));
  await wait();
  out(msg('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 }));
  await wait();
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  await wait();
  out(msg('m2', [{ type: 'text', text: 'Done.' }], { input_tokens: 300, output_tokens: 40 }));
  await wait();
  out({ type: 'result', subtype: 'success', session_id: 'sess-1', result: 'Done.', usage: { input_tokens: 400, cache_read_input_tokens: 900, output_tokens: 70 } });
});

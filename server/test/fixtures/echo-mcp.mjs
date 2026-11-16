#!/usr/bin/env node
// A tiny MCP server over stdio for the tests: one read-only tool, one that "posts", one that fails.
import readline from 'node:readline';

const tools = [
  { name: 'search_notes', description: 'Search the notes.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
  { name: 'post_message', description: 'Post a message to the team channel.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'broken', description: 'Always fails.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
process.stderr.write(`echo-mcp starting, greeting=${process.env.GREETING ?? ''}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } });
    case 'tools/list':
      return reply({ tools });
    case 'tools/call': {
      const { name, arguments: args } = msg.params;
      if (name === 'search_notes') return reply({ content: [{ type: 'text', text: `${process.env.GREETING ?? 'Found'}: 2 notes about ${args.query}` }] });
      if (name === 'post_message') return reply({ content: [{ type: 'text', text: `Posted: ${args.text}` }] });
      return reply({ content: [{ type: 'text', text: 'the backend is down' }], isError: true });
    }
    default:
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  }
});

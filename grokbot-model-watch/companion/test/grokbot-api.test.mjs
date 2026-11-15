// Tests for lib/grokbot-api.mjs: normalizing the Grok Bot RPC shapes (agents, statuses,
// transcript entries) and grouping transcript entries into turns. The RPCs are exercised
// through an in-process fake client, so nothing here touches the network or the clock.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeEntry, groupTurns, listAgents, listStatuses, normalizeAgent, normalizeStatus, transcriptTail } from '../lib/grokbot-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', `grokbot-api.${name}.json`), 'utf8'));
const agentsFixture = fixture('agents');
const statusesFixture = fixture('statuses');
const transcriptFixture = fixture('transcript');

const T0 = 1_731_600_000_000; // the fixture's reference time, 2024-11-14T16:00:00.000Z
const SEC = 1000;
const MIN = 60 * SEC;
const RESEARCH = '0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b';
const OPS = '1c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c';
const ROOM = '2d3e4f50-6172-4839-abcd-2e3f4a5b6c7d';
const SQUAD = '3e4f5061-7283-494a-bcde-3f4a5b6c7d8e';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

/** A transcript entry as the RPC returns it, from a body object. */
function rpcEntry(seq, body, extra = {}) {
  return { seq: String(seq), entryKind: body.kind, entryId: body.id, body: b64(body), ...extra };
}

/**
 * A stand-in for CursorClient: `responses` maps "Service/Method" to a value, a function of
 * the request body, or an Error to throw. Every call is recorded in `calls`.
 */
function fakeClient(responses = {}) {
  const calls = [];
  return {
    calls,
    async connect(service, method, body) {
      calls.push({ service, method, body });
      const r = responses[`${service}/${method}`];
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(body);
      return r === undefined ? {} : r;
    },
  };
}

describe('normalizeAgent', () => {
  it('uses agentId, keeps the row id separately and copies the descriptive fields', () => {
    const got = normalizeAgent(agentsFixture.agents[0]);
    assert.deepEqual(got, {
      agentId: RESEARCH,
      rowId: '101',
      name: 'Research Bot',
      description: 'Reads papers and news, writes briefs.',
      kind: 'GROK_BOT_AGENT_KIND_AGENT',
      isGroup: false,
      harness: 'temporal',
      role: 'GROK_BOT_AGENT_ROLE_OWNER',
      ownerDisplayName: 'You',
      viewerIsOwner: true,
      viewerSessionId: null,
      updatedAtMs: T0,
    });
  });

  it('falls back to id when agentId is missing', () => {
    const got = normalizeAgent(agentsFixture.agents[3]);
    assert.equal(got.agentId, '104');
    assert.equal(got.rowId, '104');
    assert.equal(got.name, 'Legacy row without agentId');
  });

  it('returns null for rows without any id and for non-objects', () => {
    assert.equal(normalizeAgent({ name: 'no ids at all' }), null);
    assert.equal(normalizeAgent({ agentId: '', id: '' }), null);
    assert.equal(normalizeAgent(null), null);
    assert.equal(normalizeAgent(undefined), null);
    assert.equal(normalizeAgent('not an object'), null);
    assert.equal(normalizeAgent(42), null);
  });

  it('names fall back from name to title to the agent id; optional fields default', () => {
    const titled = normalizeAgent({ agentId: 'x-1', title: 'Titled only' });
    assert.equal(titled.name, 'Titled only');
    const bare = normalizeAgent({ agentId: 'x-2' });
    assert.equal(bare.name, 'x-2');
    assert.equal(bare.description, '');
    assert.equal(bare.kind, '');
    assert.equal(bare.rowId, null);
    assert.equal(bare.harness, null);
    assert.equal(bare.role, null);
    assert.equal(bare.ownerDisplayName, null);
    assert.equal(bare.viewerIsOwner, null);
    assert.equal(bare.updatedAtMs, null);
    assert.equal(bare.isGroup, false);
  });

  it('isGroup comes from a group or room kind', () => {
    const room = normalizeAgent(agentsFixture.agents[2]);
    assert.equal(room.isGroup, true);
    assert.equal(room.name, 'Team Room');
    assert.equal(normalizeAgent({ agentId: 'r', kind: 'GROK_BOT_AGENT_KIND_ROOM' }).isGroup, true);
    assert.equal(normalizeAgent({ agentId: 'g', kind: 'grok_bot_agent_kind_group' }).isGroup, true);
    assert.equal(normalizeAgent({ agentId: 'a', kind: 'GROK_BOT_AGENT_KIND_AGENT' }).isGroup, false);
  });

  it('isGroup also comes from a non-empty memberAgentIds list when the kind is missing', () => {
    assert.equal(normalizeAgent(agentsFixture.agents[4]).isGroup, true);
    assert.equal(normalizeAgent({ agentId: 'e', memberAgentIds: [] }).isGroup, false);
    assert.equal(normalizeAgent({ agentId: 'n', memberAgentIds: 'not-a-list' }).isGroup, false);
  });

  it('viewerIsOwner is true or false only for a real boolean, and null when the server omits it', () => {
    assert.equal(normalizeAgent({ agentId: 'v', viewerIsOwner: 'true' }).viewerIsOwner, null);
    assert.equal(normalizeAgent({ agentId: 'v', viewerIsOwner: 1 }).viewerIsOwner, null);
    assert.equal(normalizeAgent({ agentId: 'v', viewerIsOwner: false }).viewerIsOwner, false);
    assert.equal(normalizeAgent({ agentId: 'v', viewerIsOwner: true }).viewerIsOwner, true);
  });

  it('updatedAtMs accepts int64 strings and seconds', () => {
    assert.equal(normalizeAgent({ agentId: 'u', updatedAtMs: '1731600000000' }).updatedAtMs, T0);
    assert.equal(normalizeAgent({ agentId: 'u', updatedAtMs: 1731600000000 }).updatedAtMs, T0);
    assert.equal(normalizeAgent({ agentId: 'u', updatedAtMs: '1731600000' }).updatedAtMs, T0, 'seconds become ms');
    assert.equal(normalizeAgent({ agentId: 'u', updatedAtMs: 'soon' }).updatedAtMs, null);
    assert.equal(normalizeAgent({ agentId: 'u', updatedAtMs: '' }).updatedAtMs, null);
  });
});

describe('listAgents', () => {
  it('asks for team agents by default and returns the normalized, filtered list', async () => {
    const client = fakeClient({ 'GrokBotService/ListGrokBotAgents': agentsFixture });
    const agents = await listAgents(client);
    assert.deepEqual(client.calls, [{ service: 'GrokBotService', method: 'ListGrokBotAgents', body: { includeTeamAgents: true } }]);
    assert.deepEqual(agents.map((a) => a.agentId), [RESEARCH, OPS, ROOM, '104', SQUAD]);
    assert.deepEqual(agents.map((a) => a.isGroup), [false, false, true, false, true]);
  });

  it('sends an empty body when team agents are not wanted', async () => {
    const client = fakeClient({ 'GrokBotService/ListGrokBotAgents': { agents: [] } });
    assert.deepEqual(await listAgents(client, { includeTeamAgents: false }), []);
    assert.deepEqual(client.calls[0].body, {});
  });

  it('tolerates a response without an agents list', async () => {
    assert.deepEqual(await listAgents(fakeClient({ 'GrokBotService/ListGrokBotAgents': {} })), []);
    assert.deepEqual(await listAgents(fakeClient({ 'GrokBotService/ListGrokBotAgents': { agents: 'nope' } })), []);
  });

  it('propagates client errors', async () => {
    const client = fakeClient({ 'GrokBotService/ListGrokBotAgents': new Error('HTTP 401') });
    await assert.rejects(listAgents(client), /HTTP 401/);
  });
});

describe('normalizeStatus', () => {
  const byId = Object.fromEntries(statusesFixture.statuses.filter((s) => s && typeof s === 'object').map((s) => [s.agentId, s]));

  it('reads a running Bot with its activity, settlement and client fields, converting int64 strings', () => {
    const got = normalizeStatus(byId[RESEARCH]);
    assert.equal(got.agentId, RESEARCH);
    assert.equal(got.isRunning, true);
    assert.equal(got.state, 'running');
    assert.equal(got.awaitingReason, null);
    assert.equal(got.isComposing, true);
    assert.equal(got.isRetrying, false);
    assert.equal(got.hasRunningSubagents, true);
    assert.deepEqual(got.workingTaskIds, ['task-1', 'task-2'], 'only strings survive');
    assert.deepEqual(got.activity, { kind: 'tool', tool: 'browser', detail: 'Reading arxiv.org' });
    assert.deepEqual(got.lastTurn, { turnId: 'turn-user-0', outcome: 'GROK_BOT_TURN_OUTCOME_SUCCESS', settledAtMs: T0 - 60 * SEC });
    assert.equal(got.liveUpdatedAtMs, T0 + SEC);
    assert.equal(got.lastActivityAtMs, T0 + 500);
    assert.equal(got.unreadCount, 3);
  });

  it('awaiting wins over running, and a reason-less awaiting means input', () => {
    const ops = normalizeStatus(byId[OPS]);
    assert.equal(ops.isRunning, true, 'the Bot is still marked running');
    assert.equal(ops.state, 'awaiting');
    assert.equal(ops.awaitingReason, 'approval');
    assert.deepEqual(ops.activity, { kind: 'tool', tool: null, detail: null }, 'empty strings become null');
    const inbox = normalizeStatus(byId['inbox-bot']);
    assert.equal(inbox.state, 'awaiting');
    assert.equal(inbox.awaitingReason, 'input');
    assert.equal(inbox.isRunning, false);
  });

  it('running wins over idle, from either the top-level or the live flag', () => {
    assert.equal(normalizeStatus(byId['top-level-running']).state, 'running');
    assert.equal(normalizeStatus({ agentId: 'l', live: { isRunning: true } }).state, 'running');
    assert.equal(normalizeStatus({ agentId: 'l', isRunning: false, live: { isRunning: true } }).state, 'running');
    assert.equal(normalizeStatus({ agentId: 'l', isRunning: 'true' }).state, 'idle', 'a string is not true');
  });

  it('a Bot with nothing going on is idle with null activity and defaults', () => {
    const idle = normalizeStatus(byId['idle-bot']);
    assert.equal(idle.state, 'idle');
    assert.equal(idle.isRunning, false);
    assert.equal(idle.awaitingReason, null);
    assert.equal(idle.activity, null);
    assert.equal(idle.isComposing, false);
    assert.equal(idle.isRetrying, false);
    assert.equal(idle.hasRunningSubagents, false);
    assert.deepEqual(idle.workingTaskIds, []);
    assert.equal(idle.lastTurn.settledAtMs, 1731590000000);
    assert.equal(idle.lastActivityAtMs, 1731590000000);
    assert.equal(idle.unreadCount, 0);
    assert.equal(idle.lastMessagePreview, 'Done, summary attached.');
    const minimal = normalizeStatus({ agentId: 'm' });
    assert.equal(minimal.state, 'idle');
    assert.equal(minimal.lastTurn, null);
    assert.equal(minimal.liveUpdatedAtMs, null);
    assert.equal(minimal.lastActivityAtMs, null);
    assert.equal(minimal.lastMessagePreview, null);
    assert.equal(minimal.unreadCount, 0);
  });

  it('the message preview is whitespace-collapsed, trimmed and cut at 80 characters', () => {
    const got = normalizeStatus(byId[RESEARCH]);
    assert.equal(got.lastMessagePreview.length, 80);
    assert.ok(got.lastMessagePreview.startsWith('Working on it, this will take a moment'));
    assert.doesNotMatch(got.lastMessagePreview, /\s\s|\n/);
    const long = normalizeStatus({ agentId: 'p', client: { lastMessagePreview: 'x'.repeat(200) } });
    assert.equal(long.lastMessagePreview, 'x'.repeat(80));
    const short = normalizeStatus({ agentId: 'p', client: { lastMessagePreview: '  short\tone  ' } });
    assert.equal(short.lastMessagePreview, 'short one');
  });

  it('returns null without an agentId or for non-objects', () => {
    assert.equal(normalizeStatus({ live: { isRunning: true } }), null);
    assert.equal(normalizeStatus({ agentId: '' }), null);
    assert.equal(normalizeStatus(null), null);
    assert.equal(normalizeStatus('not an object'), null);
  });

  it('timestamps in seconds are promoted to milliseconds', () => {
    const got = normalizeStatus({ agentId: 's', live: { updatedAtMs: '1731600000', lastTurnSettlement: { settledAtMs: 1731599940 } }, client: { lastActivityAtMs: '1731600000.5' } });
    assert.equal(got.liveUpdatedAtMs, T0);
    assert.equal(got.lastTurn.settledAtMs, T0 - 60 * SEC);
    assert.equal(got.lastActivityAtMs, T0 + 500);
  });
});

describe('listStatuses', () => {
  it('does not call the backend for an empty id list', async () => {
    const client = fakeClient();
    assert.deepEqual(await listStatuses(client, []), []);
    assert.deepEqual(client.calls, []);
  });

  it('sends the agent ids and returns normalized statuses, dropping unusable rows', async () => {
    const client = fakeClient({ 'GrokBotService/ListGrokBotAgentStatuses': statusesFixture });
    const statuses = await listStatuses(client, [RESEARCH, OPS]);
    assert.deepEqual(client.calls, [{ service: 'GrokBotService', method: 'ListGrokBotAgentStatuses', body: { agentIds: [RESEARCH, OPS] } }]);
    assert.deepEqual(statuses.map((s) => [s.agentId, s.state]), [
      [RESEARCH, 'running'],
      [OPS, 'awaiting'],
      ['inbox-bot', 'awaiting'],
      ['idle-bot', 'idle'],
      ['top-level-running', 'running'],
    ]);
  });

  it('tolerates a response without statuses', async () => {
    assert.deepEqual(await listStatuses(fakeClient({ 'GrokBotService/ListGrokBotAgentStatuses': {} }), ['x']), []);
  });
});

describe('decodeEntry', () => {
  const byId = Object.fromEntries(transcriptFixture.entries.map((e) => [e.entryId, e]));

  it('decodes a user message and keeps only its metadata (no text, no client nonce)', () => {
    const got = decodeEntry(byId['msg-4']);
    assert.deepEqual(got, {
      seq: 4,
      kind: 'message',
      id: 'msg-4',
      at: T0,
      requestId: 'turn-user-1',
      role: 'user',
      type: null,
      preview: null,
      fromAgent: null,
      toAgent: null,
      wake: null,
      bodyOmitted: false,
    });
    assert.ok(!('content' in got));
    assert.ok(!('clientNonce' in got));
    assert.ok(!JSON.stringify(got).includes('Please get on with it'));
  });

  it('decodes a text reply with a whitespace-collapsed preview and no other text', () => {
    const got = decodeEntry(byId['sm-7']);
    assert.equal(got.seq, 7);
    assert.equal(got.kind, 'send-message');
    assert.equal(got.type, 'text');
    assert.equal(got.requestId, 'turn-user-1');
    assert.equal(got.at, T0 + 60 * SEC);
    assert.equal(got.preview, 'Done. The brief is attached: three papers, two news items.');
    assert.equal(got.wake, null);
    assert.equal(got.role, null);
  });

  it('cuts the reply preview at 80 characters', () => {
    const content = `${'Lorem ipsum dolor sit amet, '.repeat(6)}end`;
    const got = decodeEntry(rpcEntry(1, { kind: 'send-message', id: 'long', timestampMs: T0, requestId: 'r', message: { type: 'text', content } }));
    assert.equal(got.preview.length, 80);
    assert.equal(got.preview, content.replace(/\s+/g, ' ').trim().slice(0, 80));
  });

  it('decodes a widget without a preview', () => {
    const got = decodeEntry(byId['sm-6']);
    assert.equal(got.kind, 'send-message');
    assert.equal(got.type, 'widget');
    assert.equal(got.preview, null);
    assert.equal(got.at, T0 + 30 * SEC);
    assert.equal(got.requestId, 'turn-user-1');
  });

  it('decodes a wake (routine) reply', () => {
    const got = decodeEntry(byId['sm-2']);
    assert.equal(got.kind, 'send-message');
    assert.equal(got.wake, 'background-revival');
    assert.equal(got.type, 'text');
    assert.equal(got.preview, 'Starting the scheduled checks.');
    assert.equal(got.at, T0 - 10 * MIN);
    assert.equal(got.requestId, 'turn-routine-1');
  });

  it('decodes a bot-to-bot message with the sender and recipient names', () => {
    const got = decodeEntry(byId['msg-1']);
    assert.equal(got.kind, 'message');
    assert.equal(got.role, 'user');
    assert.equal(got.fromAgent, 'Ops Bot', 'name preferred');
    assert.equal(got.toAgent, 'agent-research', 'id when there is no name');
    assert.ok(!JSON.stringify(got).includes('overnight alerts'));
  });

  it('other kinds keep kind, id, time and requestId with the rest null; string timestamps work', () => {
    const got = decodeEntry(byId['ev-5']);
    assert.deepEqual(got, { seq: 5, kind: 'event', id: 'ev-5', at: T0 + 10 * SEC, requestId: 'turn-user-1', role: null, type: null, preview: null, fromAgent: null, toAgent: null, wake: null, bodyOmitted: false });
  });

  it('an omitted body falls back to the entry kind and id with no time', () => {
    const got = decodeEntry(byId['att-1']);
    assert.deepEqual(got, { seq: 8, kind: 'user-attachment', id: 'att-1', at: null, requestId: null, role: null, type: null, preview: null, fromAgent: null, toAgent: null, wake: null, bodyOmitted: true });
  });

  it('an undecodable body falls back to the entry kind and id', () => {
    const got = decodeEntry(byId['notice-1']);
    assert.equal(got.kind, 'notice');
    assert.equal(got.id, 'notice-1');
    assert.equal(got.at, null);
    assert.equal(got.bodyOmitted, false);
    const garbage = decodeEntry({ seq: '3', entryKind: 'notice', entryId: 'n-3', body: '%%%not base64 at all%%%' });
    assert.equal(garbage.kind, 'notice');
    assert.equal(garbage.id, 'n-3');
    const nonObjectBody = decodeEntry({ seq: '4', entryKind: 'notice', entryId: 'n-4', body: b64('just a string') });
    assert.equal(nonObjectBody.kind, 'notice');
    assert.equal(nonObjectBody.id, 'n-4');
  });

  // BUG (lib/grokbot-api.mjs decodeEntry, line ~103): summarizeEntry() already defaults a missing
  // body `kind` to the truthy 'unknown', so `summary.kind || str(raw.entryKind)` never reaches the
  // envelope's entryKind when the body parsed but lacks `kind`. Expected: the entryKind.
  it('a decoded body without a kind falls back to the entry kind', () => {
    const got = decodeEntry({ seq: '5', entryKind: 'voice-call', entryId: 'vc-5', body: b64({ id: 'vc-5', timestampMs: T0 }) });
    assert.equal(got.kind, 'voice-call');
    assert.equal(got.id, 'vc-5');
    assert.equal(got.at, T0);
  });

  it('body fields win over the envelope when both are present', () => {
    const got = decodeEntry({ seq: '6', entryKind: 'envelope-kind', entryId: 'envelope-id', body: b64({ kind: 'message', id: 'body-id', timestampMs: T0, role: 'user' }) });
    assert.equal(got.kind, 'message');
    assert.equal(got.id, 'body-id');
  });

  it('body timestamps in seconds are promoted to ms', () => {
    const got = decodeEntry(rpcEntry(1, { kind: 'event', id: 'e', timestampMs: 1731600000 }));
    assert.equal(got.at, T0);
  });

  it('an empty envelope gives an unknown entry; non-objects give null', () => {
    assert.deepEqual(decodeEntry({}), { seq: 0, kind: 'unknown', id: null, at: null, requestId: null, role: null, type: null, preview: null, fromAgent: null, toAgent: null, wake: null, bodyOmitted: false });
    assert.equal(decodeEntry(null), null);
    assert.equal(decodeEntry('x'), null);
    assert.equal(decodeEntry(undefined), null);
  });
});

describe('transcriptTail', () => {
  it('asks for the newest entries of the main session and decodes them in order', async () => {
    const client = fakeClient({ 'GrokBotService/ListGrokBotTranscriptEntries': transcriptFixture });
    const entries = await transcriptTail(client, RESEARCH);
    assert.deepEqual(client.calls, [{ service: 'GrokBotService', method: 'ListGrokBotTranscriptEntries', body: { agentId: RESEARCH, limit: 50, sessionId: '' } }]);
    assert.equal(entries.length, 9);
    assert.deepEqual(entries.map((e) => e.seq), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
    assert.deepEqual(entries.map((e) => e.kind), ['notice', 'user-attachment', 'send-message', 'send-message', 'event', 'message', 'send-message', 'send-message', 'message']);
    assert.equal(entries[5].role, 'user');
    assert.equal(entries[1].bodyOmitted, true);
  });

  it('passes limit, a string beforeSeq (int64) and sessionId through', async () => {
    const client = fakeClient({ 'GrokBotService/ListGrokBotTranscriptEntries': { entries: [] } });
    await transcriptTail(client, OPS, { limit: 200, beforeSeq: 42, sessionId: 'sess-9' });
    assert.deepEqual(client.calls[0].body, { agentId: OPS, limit: 200, sessionId: 'sess-9', beforeSeq: '42' });
    await transcriptTail(client, OPS, { beforeSeq: '7' });
    assert.equal(client.calls[1].body.beforeSeq, '7');
    await transcriptTail(client, OPS, { limit: 10 });
    assert.ok(!('beforeSeq' in client.calls[2].body));
  });

  it('drops entries that are not objects and copes with missing lists', async () => {
    const client = fakeClient({
      'GrokBotService/ListGrokBotTranscriptEntries': (body) => (body.agentId === 'empty' ? {} : { entries: [null, 'junk', transcriptFixture.entries[5]] }),
    });
    assert.deepEqual(await transcriptTail(client, 'empty'), []);
    const entries = await transcriptTail(client, 'one');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'msg-4');
  });

  it('propagates client errors', async () => {
    const client = fakeClient({ 'GrokBotService/ListGrokBotTranscriptEntries': new Error('ListGrokBotTranscriptEntries failed with HTTP 500') });
    await assert.rejects(transcriptTail(client, RESEARCH), /HTTP 500/);
  });
});

describe('groupTurns', () => {
  const decoded = transcriptFixture.entries.map(decodeEntry);

  it('groups the fixture into three turns, newest first, with start and end from the entries', () => {
    const turns = groupTurns(decoded);
    assert.deepEqual(turns.map((t) => t.requestId), ['turn-user-1', 'turn-routine-1', 'turn-bot-1']);
    const [user, routine, bot] = turns;
    assert.equal(user.startAt, T0);
    assert.equal(user.endAt, T0 + 60 * SEC);
    assert.equal(routine.startAt, T0 - 10 * MIN);
    assert.equal(routine.endAt, T0 - 10 * MIN + 10 * SEC);
    assert.equal(bot.startAt, T0 - 20 * MIN);
    assert.equal(bot.endAt, T0 - 20 * MIN);
    for (const turn of turns) assert.ok(Array.isArray(turn.kinds), 'kinds is a plain array');
    assert.deepEqual(user.kinds.sort(), ['event', 'message', 'send-message']);
  });

  it('a turn a person wrote into is user-initiated; widgets are not counted as replies', () => {
    const user = groupTurns(decoded).find((t) => t.requestId === 'turn-user-1');
    assert.equal(user.origin, 'user');
    assert.equal(user.replies, 1);
    assert.equal(user.lastPreview, 'Done. The brief is attached: three papers, two news items.');
  });

  it('a turn the Bot woke up for on its own is a routine', () => {
    const routine = groupTurns(decoded).find((t) => t.requestId === 'turn-routine-1');
    assert.equal(routine.origin, 'routine');
    assert.equal(routine.replies, 2);
    assert.deepEqual(routine.kinds, ['send-message']);
  });

  it('a turn another Bot wrote into is bot-initiated', () => {
    const bot = groupTurns(decoded).find((t) => t.requestId === 'turn-bot-1');
    assert.equal(bot.origin, 'bot');
    assert.equal(bot.replies, 0);
    assert.equal(bot.lastPreview, null);
  });

  // BUG (lib/grokbot-api.mjs groupTurns, line ~136): origin is only derived from `message` entries
  // in the user role, but research notes F6 say bot-to-bot messages arrive in the assistant role, so
  // a turn another Bot started is reported as 'unknown'. Expected: 'bot'.
  it('a message another Bot sent in (fromAgent) makes the turn bot-initiated whatever its role', () => {
    // Research notes F6: `message` role user = the person's message; role assistant = bot-to-bot.
    const entries = [
      decodeEntry(rpcEntry(2, { kind: 'send-message', id: 'r-2', timestampMs: T0 + 5 * SEC, requestId: 'turn-x', message: { type: 'text', content: 'On it.' } })),
      decodeEntry(rpcEntry(1, { kind: 'message', id: 'r-1', timestampMs: T0, requestId: 'turn-x', role: 'assistant', fromAgent: { id: 'agent-ops', name: 'Ops Bot' }, content: 'Please summarise the alerts.' })),
    ];
    const [turn] = groupTurns(entries);
    assert.equal(turn.origin, 'bot');
  });

  it('a turn with neither a message nor a wake has an unknown origin', () => {
    const entries = [decodeEntry(rpcEntry(1, { kind: 'send-message', id: 'w-1', timestampMs: T0, requestId: 'turn-w', message: { type: 'widget' } }))];
    const [turn] = groupTurns(entries);
    assert.equal(turn.origin, 'unknown');
    assert.equal(turn.replies, 0);
    assert.equal(turn.startAt, T0);
    assert.equal(turn.endAt, T0);
  });

  it('a person\'s message makes the turn user-initiated whatever the entry order and even with a wake', () => {
    const userMsg = decodeEntry(rpcEntry(1, { kind: 'message', id: 'u-1', timestampMs: T0, requestId: 'turn-u', role: 'user', clientNonce: 'n', content: 'hi' }));
    const wake = decodeEntry(rpcEntry(2, { kind: 'send-message', id: 'u-2', timestampMs: T0 + SEC, requestId: 'turn-u', wake: 'background-revival', message: { type: 'text', content: 'Resuming.' } }));
    assert.equal(groupTurns([wake, userMsg])[0].origin, 'user', 'newest first');
    assert.equal(groupTurns([userMsg, wake])[0].origin, 'user', 'oldest first');
  });

  it('a bot-initiated turn stays bot-initiated when a wake follows', () => {
    const botMsg = decodeEntry(rpcEntry(1, { kind: 'message', id: 'b-1', timestampMs: T0, requestId: 'turn-b', role: 'user', fromAgent: { id: 'agent-ops' }, content: 'go' }));
    const wake = decodeEntry(rpcEntry(2, { kind: 'send-message', id: 'b-2', timestampMs: T0 + SEC, requestId: 'turn-b', wake: 'background-revival', message: { type: 'text', content: 'Resuming.' } }));
    assert.equal(groupTurns([wake, botMsg])[0].origin, 'bot');
    assert.equal(groupTurns([botMsg, wake])[0].origin, 'bot');
  });

  // BUG (lib/grokbot-api.mjs groupTurns, line ~140): lastPreview is overwritten by every text reply in
  // iteration order, but ListGrokBotTranscriptEntries returns entries newest first, so the OLDEST
  // reply of a turn wins and the dashboard shows a stale preview. Expected: the newest reply by time.
  it('lastPreview is the newest text reply whatever the entry order', () => {
    const older = decodeEntry(rpcEntry(1, { kind: 'send-message', id: 'p-1', timestampMs: T0, requestId: 'turn-p', message: { type: 'text', content: 'Starting the scheduled checks.' } }));
    const newer = decodeEntry(rpcEntry(2, { kind: 'send-message', id: 'p-2', timestampMs: T0 + 30 * SEC, requestId: 'turn-p', message: { type: 'text', content: 'Checks done, two warnings filed.' } }));
    assert.equal(groupTurns([older, newer])[0].lastPreview, 'Checks done, two warnings filed.', 'oldest first');
    assert.equal(groupTurns([newer, older])[0].lastPreview, 'Checks done, two warnings filed.', 'newest first, as the RPC returns them');
  });

  it('entries without a time are skipped; entries without a requestId form their own turn by id', () => {
    const entries = [
      decodeEntry({ seq: '3', entryKind: 'user-attachment', entryId: 'att', bodyOmitted: true }),
      decodeEntry(rpcEntry(2, { kind: 'notice', id: 'solo', timestampMs: T0 + SEC })),
      decodeEntry(rpcEntry(1, { kind: 'event', id: 'no-time', requestId: 'turn-t' })),
      null,
    ];
    const turns = groupTurns(entries);
    assert.deepEqual(turns.map((t) => t.requestId), ['solo']);
    assert.deepEqual(turns[0].kinds, ['notice']);
  });

  it('turns are sorted by their end time, newest first', () => {
    const entries = [
      decodeEntry(rpcEntry(1, { kind: 'event', id: 'a-1', timestampMs: T0, requestId: 'turn-a' })),
      decodeEntry(rpcEntry(2, { kind: 'event', id: 'b-1', timestampMs: T0 + MIN, requestId: 'turn-b' })),
      decodeEntry(rpcEntry(3, { kind: 'event', id: 'a-2', timestampMs: T0 + 2 * MIN, requestId: 'turn-a' })),
    ];
    const turns = groupTurns(entries);
    assert.deepEqual(turns.map((t) => t.requestId), ['turn-a', 'turn-b']);
    assert.equal(turns[0].startAt, T0);
    assert.equal(turns[0].endAt, T0 + 2 * MIN);
  });

  it('returns an empty list for no entries', () => {
    assert.deepEqual(groupTurns([]), []);
  });
});

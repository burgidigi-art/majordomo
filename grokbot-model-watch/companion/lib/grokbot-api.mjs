// The Grok Bot RPCs the companion reads: which Bots exist, what each is doing right now,
// and the recent transcript (for attributing ledger rows to turns).
//
// These are the same `aiserver.v1.GrokBotService` calls the desktop app makes. They are
// undocumented; field names come from the app's own protobuf descriptors (research notes
// F6). Unknown fields are ignored and missing ones default, so additive changes are harmless.

import { summarizeEntry } from './local-app.mjs';

const SVC = 'GrokBotService';

const str = (v) => (typeof v === 'string' && v ? v : null);
const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};
const ms = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
};

export function normalizeAgent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const agentId = str(raw.agentId) || str(raw.id);
  if (!agentId) return null;
  const kind = str(raw.kind) || '';
  return {
    agentId,
    rowId: str(raw.id),
    name: str(raw.name) || str(raw.title) || agentId,
    description: str(raw.description) || '',
    kind,
    isGroup: /GROUP|ROOM/i.test(kind) || (Array.isArray(raw.memberAgentIds) && raw.memberAgentIds.length > 0),
    harness: str(raw.harness),
    role: str(raw.role),
    ownerDisplayName: str(raw.ownerDisplayName),
    /** true / false when the server says; null when the field is absent (older builds). */
    viewerIsOwner: typeof raw.viewerIsOwner === 'boolean' ? raw.viewerIsOwner : null,
    viewerSessionId: str(raw.viewerSessionId),
    updatedAtMs: ms(raw.updatedAtMs),
  };
}

export async function listAgents(client, { includeTeamAgents = true } = {}) {
  const res = await client.connect(SVC, 'ListGrokBotAgents', includeTeamAgents ? { includeTeamAgents: true } : {});
  const agents = Array.isArray(res && res.agents) ? res.agents : [];
  return agents.map(normalizeAgent).filter(Boolean);
}

/** One Bot's live state in plain terms: running / awaiting / idle, plus what it is doing. */
export function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const agentId = str(raw.agentId);
  if (!agentId) return null;
  const live = raw.live && typeof raw.live === 'object' ? raw.live : {};
  const client = raw.client && typeof raw.client === 'object' ? raw.client : {};
  const isRunning = raw.isRunning === true || live.isRunning === true;
  const awaitingReason = live.awaiting && typeof live.awaiting === 'object' ? str(live.awaiting.reason) || 'input' : null;
  const activity = live.activity && typeof live.activity === 'object' ? { kind: str(live.activity.kind), tool: str(live.activity.tool), detail: str(live.activity.detail) } : null;
  const settlement = live.lastTurnSettlement && typeof live.lastTurnSettlement === 'object'
    ? { turnId: str(live.lastTurnSettlement.turnId), outcome: str(live.lastTurnSettlement.outcome), settledAtMs: ms(live.lastTurnSettlement.settledAtMs) }
    : null;
  return {
    agentId,
    isRunning,
    state: awaitingReason ? 'awaiting' : isRunning ? 'running' : 'idle',
    awaitingReason,
    isComposing: live.isComposingMessage === true,
    isRetrying: live.isRetrying === true,
    hasRunningSubagents: live.hasRunningSubagents === true,
    workingTaskIds: Array.isArray(live.workingTaskIds) ? live.workingTaskIds.filter((x) => typeof x === 'string') : [],
    activity,
    lastTurn: settlement,
    liveUpdatedAtMs: ms(live.updatedAtMs),
    /** How long the live state stays trustworthy after updatedAtMs; null when the server omits it. */
    staleAfterMs: live.staleAfterMs === undefined || live.staleAfterMs === null ? null : num(live.staleAfterMs) || null,
    sessionId: str(live.sessionId),
    lastActivityAtMs: ms(client.lastActivityAtMs),
    lastMessagePreview: str(client.lastMessagePreview) ? client.lastMessagePreview.replace(/\s+/g, ' ').trim().slice(0, 80) : null,
    unreadCount: num(client.unreadCount),
  };
}

export async function listStatuses(client, agentIds) {
  if (!agentIds.length) return [];
  const res = await client.connect(SVC, 'ListGrokBotAgentStatuses', { agentIds });
  const statuses = Array.isArray(res && res.statuses) ? res.statuses : [];
  return statuses.map(normalizeStatus).filter(Boolean);
}

/** A transcript entry as the RPC returns it: the body is base64 of a JSON document. */
export function decodeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let body = null;
  if (typeof raw.body === 'string' && raw.body) {
    try {
      body = JSON.parse(Buffer.from(raw.body, 'base64').toString('utf8'));
    } catch {
      body = null;
    }
  }
  const summary = summarizeEntry(body) || { kind: null, id: null, at: null, requestId: null, role: null, type: null, preview: null, fromAgent: null, toAgent: null, wake: null };
  return {
    seq: num(raw.seq),
    ...summary,
    kind: (body && typeof body === 'object' && str(body.kind)) || str(raw.entryKind) || 'unknown',
    id: summary.id || str(raw.entryId),
    bodyOmitted: raw.bodyOmitted === true,
  };
}

/** The newest `limit` entries of a Bot's main session, newest first. */
export async function transcriptTail(client, agentId, { limit = 50, beforeSeq, sessionId = '' } = {}) {
  const body = { agentId, limit, sessionId };
  if (beforeSeq !== undefined) body.beforeSeq = String(beforeSeq);
  const res = await client.connect(SVC, 'ListGrokBotTranscriptEntries', body);
  const entries = Array.isArray(res && res.entries) ? res.entries : [];
  return entries.map(decodeEntry).filter(Boolean);
}

/**
 * Group entries into turns by `requestId`. A turn's origin is `user` when a person wrote
 * into it, `bot` when another Bot did, `routine` when the Bot woke on its own, else `unknown`.
 */
export function groupTurns(entries) {
  const turns = new Map();
  for (const entry of entries) {
    if (!entry || entry.at === null) continue;
    const key = entry.requestId || entry.id;
    if (!key) continue;
    let turn = turns.get(key);
    if (!turn) {
      turn = { requestId: key, startAt: entry.at, endAt: entry.at, origin: 'unknown', replies: 0, lastPreview: null, lastPreviewAt: null, kinds: new Set() };
      turns.set(key, turn);
    }
    turn.startAt = Math.min(turn.startAt, entry.at);
    turn.endAt = Math.max(turn.endAt, entry.at);
    turn.kinds.add(entry.kind);
    if (entry.kind === 'message') {
      // A person's message wins whatever the entry order. `fromAgent` marks a message another
      // Bot sent in; an assistant-role message without it is this Bot's own outgoing text.
      if (entry.role === 'user' && !entry.fromAgent) turn.origin = 'user';
      else if (entry.fromAgent && turn.origin !== 'user') turn.origin = 'bot';
    }
    if (entry.kind === 'send-message') {
      if (entry.type === 'text') {
        turn.replies += 1;
        if (entry.preview && (turn.lastPreviewAt === null || entry.at >= turn.lastPreviewAt)) {
          turn.lastPreview = entry.preview;
          turn.lastPreviewAt = entry.at;
        }
      }
      if (entry.wake && turn.origin === 'unknown') turn.origin = 'routine';
    }
  }
  return [...turns.values()]
    .map(({ lastPreviewAt, ...turn }) => ({ ...turn, kinds: [...turn.kinds] }))
    .sort((a, b) => b.endAt - a.endAt);
}

// Synthetic Bots, statuses, transcripts and usage rows, so the dashboard can be seen
// without a Cursor account. Everything here is made up and the UI says so.

import { randomUUID } from 'node:crypto';

const BOTS = [
  { name: 'Research Bot', description: 'Reads papers and news, writes briefs.' },
  { name: 'Inbox Bot', description: 'Sorts mail and drafts replies.' },
  { name: 'Ops Bot', description: 'Runs the Monday checks and files tickets.' },
];

/** A stand-in for CursorClient with the same methods, driven by a simple clock. */
export class DemoClient {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.start = now();
    this.agents = BOTS.map((b, i) => ({ ...b, agentId: `demo-${i + 1}-${randomUUID().slice(0, 8)}`, id: String(100 + i) }));
    this.events = [];
    this.lastEventAt = this.start - 60_000;
  }

  /**
   * Each Bot works in its own rhythm, mostly one at a time so attribution has something to
   * show, with a short overlap once a minute so the ambiguous case shows up too.
   */
  phase(agentIndex, t) {
    const sec = Math.floor((t - this.start) / 1000) % 120;
    if (agentIndex === 0) return sec < 28 || (sec >= 60 && sec < 70) ? 'running' : 'idle';
    if (agentIndex === 1) return sec >= 30 && sec < 42 ? 'running' : sec >= 42 && sec < 50 ? 'awaiting' : 'idle';
    return sec >= 66 && sec < 100 ? 'running' : 'idle';
  }

  materializeEvents(until) {
    for (let t = this.lastEventAt + 4000; t <= until; t += 4000) {
      this.agents.forEach((agent, i) => {
        if (this.phase(i, t) !== 'running') return;
        const roll = ((t / 4000) * 7 + i * 13) % 10;
        const model = i === 2 ? 'grok-bot-automation' : roll < 3 ? 'grok-bot-cua' : 'grok-bot-default';
        this.events.push({
          timestamp: String(t - 3000),
          model,
          kind: 'Included in Pro',
          isTokenBasedCall: true,
          tokenUsage: { inputTokens: 1800 + (Math.floor(t / 1000) % 900), outputTokens: 120 + (Math.floor(t / 1000) % 300), cacheWriteTokens: 0, cacheReadTokens: 900, totalCents: 0 },
        });
      });
      this.lastEventAt = t;
    }
    this.events = this.events.filter((e) => Number(e.timestamp) > until - 6 * 60 * 60_000);
  }

  async connect(service, method, body) {
    const t = this.now();
    switch (`${service}/${method}`) {
      case 'DashboardService/GetMe':
        return { email: 'you@example.com', userId: 1, teamId: 0 };
      case 'DashboardService/GetSandUsageStatus':
        return { usagePercent: 37.5, nextResetTimestampUtc: new Date(t + 3 * 86_400_000).toISOString(), currentPeriodStart: new Date(t - 4 * 86_400_000).toISOString(), hasAvailableUsage: true, hasNonZeroIncludedLimit: true, grokPlanLabel: 'Demo plan' };
      case 'DashboardService/GetAggregatedUsageEvents': {
        this.materializeEvents(t);
        const byIntent = new Map();
        for (const e of this.events) {
          const row = byIntent.get(e.model) || { modelIntent: e.model, inputTokens: 0, outputTokens: 0, totalCents: 0 };
          row.inputTokens += e.tokenUsage.inputTokens;
          row.outputTokens += e.tokenUsage.outputTokens;
          byIntent.set(e.model, row);
        }
        return { aggregations: [...byIntent.values()].map((r) => ({ ...r, inputTokens: String(r.inputTokens), outputTokens: String(r.outputTokens) })) };
      }
      case 'GrokBotService/ListGrokBotAgents':
        return { agents: this.agents.map((a) => ({ id: a.id, agentId: a.agentId, name: a.name, description: a.description, kind: 'GROK_BOT_AGENT_KIND_AGENT', harness: 'temporal', updatedAtMs: String(t) })) };
      case 'GrokBotService/ListGrokBotAgentStatuses':
        return {
          statuses: this.agents.map((a, i) => {
            const phase = this.phase(i, t);
            return {
              agentId: a.agentId,
              isRunning: phase === 'running',
              live: {
                isRunning: phase === 'running',
                activity: phase === 'running' ? { kind: i === 1 ? 'tool' : 'thinking', tool: i === 1 ? 'browser' : '', detail: '' } : undefined,
                awaiting: phase === 'awaiting' ? { reason: 'approval' } : undefined,
                lastTurnSettlement: { turnId: `turn-${i}-${Math.floor((t - this.start) / 60_000)}`, outcome: 'success', settledAtMs: String(t - 30_000) },
              },
              client: { unreadCount: 0, lastActivityAtMs: String(t - (phase === 'idle' ? 90_000 : 2_000)), lastMessagePreview: 'Done, summary attached.' },
            };
          }),
        };
      case 'GrokBotService/ListGrokBotTranscriptEntries': {
        // One turn per running span in the last ten minutes, consistent with phase().
        const index = this.agents.findIndex((a) => a.agentId === body.agentId);
        if (index < 0) return { entries: [] };
        const entries = [];
        const from = Math.max(this.start, t - 10 * 60_000);
        let spanStart = null;
        let seq = 1;
        const push = (at, requestId, payload) => {
          const id = `${requestId}-${seq}`;
          entries.push({ seq: String(seq++), entryKind: payload.kind, entryId: id, body: Buffer.from(JSON.stringify({ id, timestampMs: at, requestId, ...payload })).toString('base64') });
        };
        for (let at = from; at <= t + 1000; at += 1000) {
          const running = at <= t && this.phase(index, at) === 'running';
          if (running && spanStart === null) spanStart = at;
          if (!running && spanStart !== null) {
            const requestId = `turn-${index}-${Math.floor((spanStart - this.start) / 1000)}`;
            push(spanStart + 1000, requestId, index === 2 ? { kind: 'send-message', message: { type: 'text', content: 'Starting the scheduled checks.' }, wake: 'background-revival' } : { kind: 'message', role: 'user', content: 'Please get on with it.' });
            push(Math.max(spanStart + 2000, at - 2000), requestId, { kind: 'send-message', message: { type: 'text', content: 'Working on it, this will take a moment.' } });
            spanStart = null;
          }
        }
        return { entries: entries.reverse() };
      }
      default:
        return {};
    }
  }

  async dashboard(pathname, body) {
    if (pathname !== '/api/dashboard/get-filtered-usage-events') return {};
    const t = this.now();
    this.materializeEvents(t);
    const start = Number(body.startDate || 0);
    const end = Number(body.endDate || t);
    const rows = this.events.filter((e) => Number(e.timestamp) >= start && Number(e.timestamp) <= end).sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    const page = Math.max(1, Number(body.page || 1));
    const size = Math.max(1, Number(body.pageSize || 100));
    return { totalUsageEventsCount: rows.length, usageEventsDisplay: rows.slice((page - 1) * size, page * size) };
  }

  // The CursorClient methods Watch calls, delegating to the two generic entry points.
  getMe() {
    return this.connect('DashboardService', 'GetMe', {});
  }
  sandUsageStatus() {
    return this.connect('DashboardService', 'GetSandUsageStatus', {});
  }
  aggregatedUsage(args) {
    return this.connect('DashboardService', 'GetAggregatedUsageEvents', args);
  }
  async dailySpendByCategory() {
    const t = this.now();
    this.materializeEvents(t);
    const day = new Date(t);
    day.setHours(0, 0, 0, 0);
    // Synthetic per-Bot totals, in step with the synthetic ledger.
    const share = [0.55, 0.15, 0.3];
    const total = this.events.reduce((n, e) => n + e.tokenUsage.inputTokens + e.tokenUsage.outputTokens, 0);
    return { rows: this.agents.map((a, i) => ({ day: day.getTime(), category: a.name, cents: 0, tokens: Math.round(total * share[i]) })), categories: this.agents.map((a) => a.name) };
  }
  async usageEvents(args) {
    const raw = await this.dashboard('/api/dashboard/get-filtered-usage-events', { ...args, startDate: String(args.startDate ?? 0), endDate: String(args.endDate ?? this.now()) });
    const { normalizeUsageEvent } = await import('./cursor-api.mjs');
    return { events: raw.usageEventsDisplay.map(normalizeUsageEvent), total: raw.totalUsageEventsCount, via: 'demo' };
  }
}

/** A plausible inference-hook frame for the demo (so grade A has something to show). */
export function demoHookSummary(client, nowMs) {
  const agent = client.agents[0];
  return { at: nowMs, requestId: `req_${randomUUID()}`, type: 'prompt', sessionId: `demo-session-${agent.agentId}`, model: 'sand-78zum5', actorId: 'user_demo', application: 'grok-bot', messageCount: 12, isTest: false };
}

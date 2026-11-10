import { randomBytes } from 'node:crypto';
import type { Approval, TelegramChat, TelegramStatus } from '../../shared/types.ts';
import { subscribe, sync } from '../bus.ts';
import { kvGet, kvSet } from '../db.ts';
import { getTelegramToken, setTelegramToken } from '../settings.ts';

/**
 * Telegram gateway: message the project manager from a phone.
 *
 * The bot long-polls Telegram, so it works from a laptop behind a home router with no public
 * address. Only chats that were linked with the one-time pairing code can talk to it; everyone
 * else gets a short refusal. Replies, finished-work updates and approval requests go back out.
 */

export interface TelegramDeps {
  /** Hand a message from the phone to the project manager. */
  chat(text: string): void;
  stopPm(): void;
  isPmBusy(): boolean;
  /** A short Markdown summary of what is running, for /status. */
  statusText(): string;
  resolveApproval(id: string, ok: boolean): void;
  /** One line saying who is asking and for which task. */
  approvalHeading(a: Approval): string;
}

const API = () => (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const QUIET = /^<quiet\s*\/>$/;

class TelegramError extends Error {
  constructor(
    message: string,
    public code: number,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

// ---------- Markdown → the small HTML subset Telegram accepts ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toTelegramHtml(md: string): string {
  return md
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      const fence = /^```[^\n`]*\n?([\s\S]*?)```$/.exec(part);
      if (fence) return `<pre>${esc(fence[1].replace(/\n$/, ''))}</pre>`;
      // Inline code is lifted out first so nothing inside it is treated as formatting.
      const codes: string[] = [];
      let t = part.replace(/`([^`\n]+)`/g, (_, c: string) => {
        codes.push(`<code>${esc(c)}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
      });
      t = esc(t);
      t = t.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
      t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`);
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
      t = t.replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,!?:;]|$)/gm, '$1<i>$2</i>');
      t = t.replace(/(^|[\s(])_([^_\s][^_\n]*)_(?=[\s).,!?:;]|$)/gm, '$1<i>$2</i>');
      t = t.replace(/^(\s*)[-*]\s+/gm, '$1• ');
      return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
    })
    .join('');
}

/** Telegram caps a message at 4096 characters; split on paragraph, then line, boundaries. */
export function chunk(text: string, max = 3500): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

// ---------- the gateway ----------

const HELP = [
  '**Majordomo** — your project manager, on your phone.',
  '',
  'Just write to me like you would at the desk: describe a project, ask where something stands, change your mind.',
  '',
  '/status — what the crew is doing right now',
  '/stop — stop the manager mid-reply',
  '/unlink — disconnect this chat',
].join('\n');

class TelegramGateway {
  private deps: TelegramDeps | null = null;
  private abort: AbortController | null = null;
  private connected = false;
  private botUsername = '';
  private error = '';
  /** Chats we have already told "this bot is private", so strangers cannot make it chatter. */
  private refused = new Map<number, number>();
  private typing = new Map<number, NodeJS.Timeout>();
  /** Approval requests shown on the phone: approval id → the messages carrying its buttons. */
  private approvalMessages = new Map<string, { chatId: number; messageId: number; text: string }[]>();
  private approvalOutcome = new Map<string, string>();
  private lastInbound = 0;

  constructor() {
    subscribe((msg) => {
      if (msg.kind === 'sync' && msg.patch.approvals) void this.syncApprovals(msg.patch.approvals);
      if (msg.kind === 'event' && msg.event.agentId === 'pm' && msg.event.type === 'error') {
        // Tell the phone about a failure if the user is plausibly waiting on it there.
        if (this.notify || Date.now() - this.lastInbound < 10 * 60_000) {
          void this.broadcast(`The manager hit a problem and stopped:\n\n${String(msg.event.data.message ?? '')}`);
        }
      }
    });
  }

  configure(deps: TelegramDeps): void {
    this.deps = deps;
  }

  // ----- persisted state -----

  private get chats(): TelegramChat[] {
    return kvGet<TelegramChat[]>('telegram:chats', []);
  }
  private set chats(list: TelegramChat[]) {
    kvSet('telegram:chats', list);
  }
  private get notify(): boolean {
    return kvGet<boolean>('telegram:notify', true);
  }
  private get pairCode(): string {
    let code = kvGet<string>('telegram:pair', '');
    if (!code) {
      code = randomBytes(6).toString('hex');
      kvSet('telegram:pair', code);
    }
    return code;
  }

  status(): TelegramStatus {
    return {
      configured: !!getTelegramToken(),
      connected: this.connected,
      botUsername: this.botUsername,
      error: this.error,
      pairCode: this.pairCode,
      chats: this.chats,
      notify: this.notify,
    };
  }

  private push(): void {
    sync({ telegram: this.status() });
  }

  // ----- settings actions -----

  setToken(token: string | null): void {
    setTelegramToken(token);
    if (!token) this.chats = [];
    this.restart();
  }

  setNotify(on: boolean): void {
    kvSet('telegram:notify', on);
    this.push();
  }

  newPairCode(): void {
    kvSet('telegram:pair', randomBytes(6).toString('hex'));
    this.push();
  }

  unpair(chatId: number): void {
    this.chats = this.chats.filter((c) => c.id !== chatId);
    this.push();
  }

  // ----- lifecycle -----

  start(): void {
    if (this.abort || !getTelegramToken()) return;
    const abort = new AbortController();
    this.abort = abort;
    void this.loop(abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.connected = false;
    for (const t of this.typing.values()) clearInterval(t);
    this.typing.clear();
  }

  restart(): void {
    this.stop();
    this.botUsername = '';
    this.error = '';
    this.start();
    this.push();
  }

  private async call<T = any>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const token = getTelegramToken();
    if (!token) throw new TelegramError('No bot token', 401);
    let res: Response;
    try {
      res = await fetch(`${API()}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
    } catch (err) {
      // Never let the request URL (which contains the token) into an error message.
      const cause = (err as { cause?: { code?: string } })?.cause?.code;
      throw new TelegramError(cause ? `network error (${cause})` : 'network error', 0);
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (!json?.ok) {
      throw new TelegramError(json?.description ?? `HTTP ${res.status}`, json?.error_code ?? res.status, json?.parameters?.retry_after);
    }
    return json.result as T;
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    let backoff = 1500;
    const fail = async (err: unknown): Promise<boolean> => {
      if (signal.aborted) return false;
      const e = err instanceof TelegramError ? err : new TelegramError(String(err), 0);
      this.connected = false;
      if (e.code === 401 || e.code === 404) {
        this.error = 'Telegram rejected the bot token. Check it and save again.';
        this.push();
        return false;
      }
      this.error =
        e.code === 409
          ? 'Another program is already receiving this bot’s messages. Only one can at a time — stop the other one, or make a new bot.'
          : `Cannot reach Telegram (${e.message}). Retrying.`;
      this.push();
      await sleep(e.retryAfter ? e.retryAfter * 1000 : backoff);
      backoff = Math.min(backoff * 2, 30_000);
      return !signal.aborted;
    };

    for (;;) {
      try {
        const me = await this.call<{ username: string }>('getMe', {}, signal);
        this.botUsername = me.username;
        this.connected = true;
        this.error = '';
        this.push();
        break;
      } catch (err) {
        if (!(await fail(err))) return;
      }
    }

    while (!signal.aborted) {
      try {
        const updates = await this.call<any[]>(
          'getUpdates',
          { offset: kvGet<number>('telegram:offset', 0), timeout: 25, allowed_updates: ['message', 'callback_query'] },
          signal,
        );
        if (!this.connected || this.error) {
          this.connected = true;
          this.error = '';
          this.push();
        }
        backoff = 1500;
        for (const u of updates) {
          // Confirm the update before handling it: a message that crashes the handler must not be redelivered forever.
          kvSet('telegram:offset', u.update_id + 1);
          await this.handle(u).catch((err) => console.error('[telegram] could not handle an update:', err instanceof Error ? err.message : err));
        }
      } catch (err) {
        if (!(await fail(err))) return;
      }
    }
  }

  // ----- inbound -----

  private async handle(update: any): Promise<void> {
    if (update.callback_query) return this.handleButton(update.callback_query);
    const m = update.message;
    if (!m || m.chat?.type !== 'private') return;
    const chatId: number = m.chat.id;
    const text: string = (m.text ?? '').trim();
    const paired = this.chats.some((c) => c.id === chatId);

    if (!paired) {
      const offered = /^\/(?:start|pair)(?:@\w+)?\s+(\S+)/.exec(text)?.[1] ?? text;
      if (offered && offered === this.pairCode) {
        const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || `Chat ${chatId}`;
        this.chats = [...this.chats, { id: chatId, name, pairedAt: Date.now() }];
        // The code is single-use: linking a chat spends it.
        this.newPairCode();
        await this.send(chatId, `Linked. ${HELP}`);
        return;
      }
      const last = this.refused.get(chatId) ?? 0;
      if (Date.now() - last > 10 * 60_000) {
        this.refused.set(chatId, Date.now());
        await this.send(chatId, 'This bot is private. To link this chat, open Majordomo on your computer, go to Settings → Phone, and use the pairing link shown there.');
      }
      return;
    }

    if (!text) {
      await this.send(chatId, 'I can only read text messages for now.');
      return;
    }
    const command = /^\/(\w+)(?:@\w+)?/.exec(text)?.[1]?.toLowerCase();
    switch (command) {
      case 'start':
      case 'help':
        await this.send(chatId, HELP);
        return;
      case 'status':
        await this.send(chatId, this.deps?.statusText() ?? 'Not ready yet.');
        return;
      case 'stop':
        this.deps?.stopPm();
        await this.send(chatId, 'Stopped. Agents already working carry on; tell me if you want any of them cancelled.');
        return;
      case 'unlink':
        await this.send(chatId, 'Unlinked. This chat can no longer reach your Majordomo.');
        this.unpair(chatId);
        return;
      default:
        this.lastInbound = Date.now();
        this.deps?.chat(text);
        this.showTyping(chatId);
    }
  }

  private async handleButton(q: any): Promise<void> {
    const chatId: number | undefined = q.message?.chat?.id;
    const match = /^ap:([\w-]+):([01])$/.exec(q.data ?? '');
    if (!chatId || !this.chats.some((c) => c.id === chatId) || !match) {
      await this.call('answerCallbackQuery', { callback_query_id: q.id, text: 'Not available.' }).catch(() => {});
      return;
    }
    const ok = match[2] === '1';
    const known = this.approvalMessages.has(match[1]);
    if (known) {
      this.approvalOutcome.set(match[1], ok ? 'Allowed from your phone' : 'Declined from your phone');
      this.deps?.resolveApproval(match[1], ok);
    }
    await this.call('answerCallbackQuery', {
      callback_query_id: q.id,
      text: known ? (ok ? 'Allowed' : 'Declined') : 'That request was already handled.',
    }).catch(() => {});
  }

  /** Keep "typing…" showing while the manager works on a message that came from this chat. */
  private showTyping(chatId: number): void {
    const existing = this.typing.get(chatId);
    if (existing) clearInterval(existing);
    const started = Date.now();
    const tick = () => void this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    tick();
    const timer = setInterval(() => {
      // Give the manager a moment to pick the message up before concluding it is idle.
      const idle = !this.deps?.isPmBusy() && Date.now() - started > 3000;
      if (idle || Date.now() - started > 5 * 60_000) {
        clearInterval(timer);
        this.typing.delete(chatId);
        return;
      }
      tick();
    }, 4500);
    timer.unref();
    this.typing.set(chatId, timer);
  }

  // ----- outbound -----

  private async send(chatId: number, markdown: string, extra: Record<string, unknown> = {}): Promise<number | null> {
    let lastId: number | null = null;
    const parts = chunk(markdown);
    for (let i = 0; i < parts.length; i++) {
      // Buttons, if any, go on the last part.
      const opts = i === parts.length - 1 ? extra : {};
      const base = { chat_id: chatId, link_preview_options: { is_disabled: true }, ...opts };
      try {
        const sent = await this.call<{ message_id: number }>('sendMessage', { ...base, text: toTelegramHtml(parts[i]), parse_mode: 'HTML' });
        lastId = sent.message_id;
      } catch (err) {
        if (!(err instanceof TelegramError) || err.code !== 400) throw err;
        // Telegram could not parse our formatting; the words matter more than the bold.
        const sent = await this.call<{ message_id: number }>('sendMessage', { ...base, text: parts[i] });
        lastId = sent.message_id;
      }
    }
    return lastId;
  }

  private async broadcast(markdown: string): Promise<void> {
    if (!this.abort) return;
    for (const chat of this.chats) {
      await this.send(chat.id, markdown).catch((err) => console.error('[telegram] could not send:', err instanceof Error ? err.message : err));
    }
  }

  /**
   * A manager turn ended. Replies to phone messages always go to the phone. Updates the manager
   * volunteers (work finished, a question for the user) go there when notifications are on.
   * Replies to something typed at the dashboard stay at the dashboard.
   */
  deliverReply(text: string, origin: { viaTelegram: boolean; fromDashboard: boolean }): void {
    const clean = text.trim();
    if (!clean || QUIET.test(clean)) return;
    if (origin.viaTelegram || (this.notify && !origin.fromDashboard)) void this.broadcast(clean);
  }

  private async syncApprovals(pending: Approval[]): Promise<void> {
    if (!this.abort) return;
    for (const a of pending) {
      if (this.approvalMessages.has(a.id) || !this.notify) continue;
      const text = `**${this.deps?.approvalHeading(a) ?? 'An agent wants to run a command'}**\n\n\`\`\`\n${a.detail.slice(0, 2500)}\n\`\`\``;
      const sent: { chatId: number; messageId: number; text: string }[] = [];
      this.approvalMessages.set(a.id, sent);
      for (const chat of this.chats) {
        const id = await this.send(chat.id, text, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'Allow', callback_data: `ap:${a.id}:1` },
                { text: 'Decline', callback_data: `ap:${a.id}:0` },
              ],
            ],
          },
        }).catch(() => null);
        if (id) sent.push({ chatId: chat.id, messageId: id, text });
      }
    }
    // Requests that are no longer pending lose their buttons and say how they were settled.
    for (const [id, messages] of this.approvalMessages) {
      if (pending.some((a) => a.id === id)) continue;
      this.approvalMessages.delete(id);
      const outcome = this.approvalOutcome.get(id) ?? 'Handled at the dashboard';
      this.approvalOutcome.delete(id);
      for (const m of messages) {
        await this.call('editMessageText', {
          chat_id: m.chatId,
          message_id: m.messageId,
          text: `${toTelegramHtml(m.text)}\n\n<i>${outcome}.</i>`,
          parse_mode: 'HTML',
        }).catch(() => {});
      }
    }
  }
}

export const telegram = new TelegramGateway();

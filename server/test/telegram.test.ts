import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { tempHome, until } from './helpers.ts';

process.env.MAJORDOMO_DEMO = '1';
process.env.MAJORDOMO_DEMO_SPEED = '60';
tempHome();

const TOKEN = '123456789:AAE-test_token_for_the_mock_server_0123';

/** A stand-in for the Telegram Bot API: scripted incoming updates, recorded outgoing calls. */
const tg = {
  updates: [] as any[],
  nextUpdate: 1,
  nextMessage: 100,
  calls: [] as { method: string; body: any }[],
  server: null as http.Server | null,
  url: '',
  message(chatId: number, text: string | undefined, extra: object = {}) {
    this.updates.push({
      update_id: this.nextUpdate++,
      message: { message_id: this.nextMessage++, chat: { id: chatId, type: 'private' }, from: { first_name: 'Ada', last_name: 'L' }, text, ...extra },
    });
  },
  press(chatId: number, data: string) {
    this.updates.push({ update_id: this.nextUpdate++, callback_query: { id: `cb${this.nextUpdate}`, data, message: { chat: { id: chatId } } } });
  },
  sent(chatId?: number) {
    return this.calls.filter((c) => c.method === 'sendMessage' && (chatId === undefined || c.body.chat_id === chatId)).map((c) => c.body);
  },
  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  },
};

let orch: typeof import('../orchestrator.ts');
let db: typeof import('../db.ts');
let app: typeof import('../http.ts')['app'];
let telegram: typeof import('../gateways/telegram.ts')['telegram'];
let lib: typeof import('../gateways/telegram.ts');

const local = { host: 'localhost:4317' };
const put = (path: string, body: unknown) =>
  app.request(path, { method: 'PUT', headers: { 'content-type': 'application/json', ...local }, body: JSON.stringify(body) });
const pmIdle = () => !orch.runner.isBusy('pm') && !orch.runner.queued('pm');

before(async () => {
  tg.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      const body = raw ? JSON.parse(raw) : {};
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (!m || m[1] !== TOKEN) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
      }
      const method = m[2];
      if (method === 'getUpdates') {
        const due = tg.updates.filter((u) => u.update_id >= (body.offset ?? 0));
        tg.updates = [];
        return setTimeout(() => reply(due), due.length ? 0 : 25);
      }
      tg.calls.push({ method, body });
      if (method === 'getMe') return reply({ id: 1, is_bot: true, username: 'majordomo_test_bot' });
      if (method === 'sendMessage') {
        // Stand in for Telegram refusing our markup, so the plain-text fallback is exercised.
        if (body.parse_mode === 'HTML' && body.text.includes('unparseable')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }));
        }
        return reply({ message_id: tg.nextMessage++ });
      }
      return reply(true);
    });
  });
  await new Promise<void>((r) => tg.server!.listen(0, '127.0.0.1', r));
  tg.url = `http://127.0.0.1:${(tg.server.address() as { port: number }).port}`;
  process.env.TELEGRAM_API_BASE = tg.url;

  db = await import('../db.ts');
  orch = await import('../orchestrator.ts');
  app = (await import('../http.ts')).app;
  lib = await import('../gateways/telegram.ts');
  telegram = lib.telegram;
  orch.orch.boot();
});

after(async () => {
  telegram.stop();
  await new Promise<void>((r) => tg.server!.close(() => r()));
});

test('formats Markdown for Telegram and splits long messages', () => {
  assert.equal(lib.toTelegramHtml('**Done.** See `a<b>.md` & _notes_'), '<b>Done.</b> See <code>a&lt;b&gt;.md</code> &amp; <i>notes</i>');
  assert.equal(lib.toTelegramHtml('## Plan\n- one\n- two'), '<b>Plan</b>\n• one\n• two');
  assert.equal(lib.toTelegramHtml('```js\nif (a < b) {}\n```'), '<pre>if (a &lt; b) {}</pre>');
  assert.equal(lib.toTelegramHtml('[docs](https://x.dev/a?b=1&c=2)'), '<a href="https://x.dev/a?b=1&amp;c=2">docs</a>');
  assert.equal(lib.toTelegramHtml('snake_case_name and 2 * 3 * 4'), 'snake_case_name and 2 * 3 * 4', 'stray markers are left alone');
  const parts = lib.chunk(`${'word '.repeat(900)}\n\n${'tail '.repeat(300)}`, 3500);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 3500));
});

test('a saved token connects the bot; a mis-pasted one is refused', async () => {
  assert.equal((await put('/api/telegram', { token: 'not-a-token' })).status, 400);
  assert.equal(telegram.status().configured, false);
  const res = await put('/api/telegram', { token: TOKEN });
  assert.equal(res.status, 200);
  await until(() => telegram.status().connected);
  assert.equal(telegram.status().botUsername, 'majordomo_test_bot');
  const state = await (await app.request('/api/state', { headers: local })).text();
  assert.ok(!state.includes(TOKEN), 'the token is never sent to the dashboard');
});

test('strangers are refused, once, and never reach the manager', async () => {
  tg.message(999, 'hello bot');
  await until(() => tg.sent(999).length === 1);
  assert.match(tg.sent(999)[0].text, /This bot is private/);
  tg.message(999, '/start wrong-code');
  tg.message(999, 'let me in');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(tg.sent(999).length, 1, 'no second reply inside the quiet window');
  assert.equal(telegram.status().chats.length, 0);
  assert.equal(db.events.list('pm').length, 0, 'nothing was passed to the manager');
});

test('the pairing code links a chat and is spent by doing so', async () => {
  const code = telegram.status().pairCode;
  tg.message(42, `/start ${code}`);
  await until(() => telegram.status().chats.length === 1);
  assert.deepEqual(telegram.status().chats.map((c) => [c.id, c.name]), [[42, 'Ada L']]);
  assert.notEqual(telegram.status().pairCode, code);
  await until(() => tg.sent(42).length === 1);
  assert.match(tg.sent(42)[0].text, /^Linked\./);
  tg.message(43, `/start ${code}`);
  await until(() => tg.sent(43).length === 1);
  assert.equal(telegram.status().chats.length, 1, 'the old code no longer works');
});

test('a phone message runs a project and the replies come back to the phone', async () => {
  tg.message(42, 'Plan the launch of my woodworking newsletter and draft the first issue');
  await until(() => tg.sent(42).some((m) => /^On it\./.test(m.text)));
  const first = tg.sent(42).find((m) => /^On it\./.test(m.text))!;
  assert.equal(first.parse_mode, 'HTML');
  assert.match(first.text, /<i>This is the demo crew/, 'Markdown was converted');
  assert.ok(tg.count('sendChatAction') >= 1, 'the chat showed "typing…"');

  const asked = db.events.list('pm').find((e) => e.type === 'user')!;
  assert.equal(asked.data.via, 'telegram');
  assert.match(JSON.stringify(db.messages.load('pm')[0]), /Channel: this message came from the user’s phone/);

  // Work finishing later is reported to the phone without being asked.
  await until(() => tg.sent(42).some((m) => /is finished/.test(m.text)), 30_000);
  assert.ok(!tg.sent().some((m) => /quiet/.test(m.text)), 'routine "nothing to report" turns stay silent');
  assert.equal(tg.sent(999).length, 1, 'the stranger heard nothing more');
});

test('replies to dashboard messages stay at the dashboard', async () => {
  await until(pmIdle);
  const before = tg.sent(42).length;
  orch.orch.chat('hi');
  await until(() => db.events.list('pm').some((e) => e.type === 'text' && /I am your project manager/.test(e.data.text)) && pmIdle());
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(tg.sent(42).length, before);
});

test('/status answers without involving the manager', async () => {
  const turns = db.events.list('pm').filter((e) => e.type === 'user').length;
  tg.message(42, '/status');
  await until(() => tg.sent(42).some((m) => /Nobody is working right now/.test(m.text)));
  assert.match(tg.sent(42).at(-1)!.text, /<b>Projects<\/b>\n• Plan the launch of my woodworking newsletter: 4\/4 done/);
  assert.equal(db.events.list('pm').filter((e) => e.type === 'user').length, turns);
});

test('approval requests arrive with buttons, and a tap resolves them', async () => {
  const settings = await import('../settings.ts');
  settings.saveSettings({ ...settings.getSettings(), approvalMode: 'ask' });
  tg.message(42, 'Build a CLI that renames my photos by date');
  await until(() => tg.sent(42).some((m) => m.reply_markup), 30_000);
  const request = tg.sent(42).find((m) => m.reply_markup)!;
  assert.match(request.text, /<b>Scout wants to run a command — .+<\/b>/);
  assert.match(request.text, /<pre>wc -l notes\//);
  const [allow, decline] = request.reply_markup.inline_keyboard[0];
  assert.deepEqual([allow.text, decline.text], ['Allow', 'Decline']);
  const id = /^ap:(.+):1$/.exec(allow.callback_data)![1];
  assert.ok(db.approvals.pending().some((a) => a.id === id));

  tg.press(999, allow.callback_data);
  await until(() => tg.count('answerCallbackQuery') === 1);
  assert.ok(db.approvals.pending().some((a) => a.id === id), 'a tap from an unlinked chat does nothing');

  tg.press(42, allow.callback_data);
  await until(() => !db.approvals.pending().some((a) => a.id === id));
  await until(() => tg.calls.some((c) => c.method === 'editMessageText' && /Allowed from your phone/.test(c.body.text)));

  // Let the rest of the project run out without further prompts.
  settings.saveSettings({ ...settings.getSettings(), approvalMode: 'auto' });
  for (let i = 0; i < 40 && db.tasks.all().some((t) => t.status !== 'done'); i++) {
    for (const a of db.approvals.pending()) orch.orch.resolveApproval(a.id, true);
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(db.tasks.all().every((t) => t.status === 'done'));
});

test('with notifications off, only replies to phone messages are sent', async () => {
  await until(pmIdle);
  await put('/api/telegram', { notify: false });
  const before = tg.sent(42).length;
  telegram.deliverReply('Background update', { viaTelegram: false, fromDashboard: false });
  telegram.deliverReply('<quiet/>', { viaTelegram: true, fromDashboard: false });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tg.sent(42).length, before);
  telegram.deliverReply('Answer to your phone message', { viaTelegram: true, fromDashboard: false });
  await until(() => tg.sent(42).length === before + 1);
});

test('formatting Telegram cannot parse falls back to plain text', async () => {
  const before = tg.sent(42).length;
  telegram.deliverReply('An **unparseable** reply', { viaTelegram: true, fromDashboard: false });
  await until(() => tg.sent(42).length === before + 2);
  const [html, plain] = tg.sent(42).slice(-2);
  assert.equal(html.parse_mode, 'HTML');
  assert.equal(plain.parse_mode, undefined);
  assert.equal(plain.text, 'An **unparseable** reply', 'the words still arrive, unformatted');
});

test('/unlink disconnects the chat', async () => {
  tg.message(42, '/unlink');
  await until(() => telegram.status().chats.length === 0);
  const turns = db.events.list('pm').filter((e) => e.type === 'user').length;
  tg.message(42, 'are you there?');
  await until(() => tg.sent(42).some((m) => /This bot is private/.test(m.text)));
  assert.equal(db.events.list('pm').filter((e) => e.type === 'user').length, turns);
});

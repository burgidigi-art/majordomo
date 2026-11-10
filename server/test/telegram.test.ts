import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  /** Requests the harness made to the speech-to-text services (served by the same mock). */
  stt: [] as { url: string; headers: http.IncomingHttpHeaders; raw: Buffer }[],
  /** What the mock speech-to-text services answer with next. */
  heard: 'hi there' as string | { status: number },
  audio: Buffer.from('not-real-audio'),
  server: null as http.Server | null,
  url: '',
  message(chatId: number, text: string | undefined, extra: object = {}) {
    this.updates.push({
      update_id: this.nextUpdate++,
      message: { message_id: this.nextMessage++, chat: { id: chatId, type: 'private' }, from: { first_name: 'Ada', last_name: 'L' }, text, ...extra },
    });
  },
  voice(chatId: number, extra: object = {}) {
    this.updates.push({
      update_id: this.nextUpdate++,
      message: {
        message_id: this.nextMessage++,
        chat: { id: chatId, type: 'private' },
        from: { first_name: 'Ada', last_name: 'L' },
        voice: { file_id: 'voice-file-1', duration: 3, mime_type: 'audio/ogg', file_size: this.audio.length, ...extra },
      },
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

let hasFfmpeg = false;
const local = { host: 'localhost:4317' };
const put = (path: string, body: unknown) =>
  app.request(path, { method: 'PUT', headers: { 'content-type': 'application/json', ...local }, body: JSON.stringify(body) });
const pmIdle = () => !orch.runner.isBusy('pm') && !orch.runner.queued('pm');

before(async () => {
  // A real Ogg/Opus clip when ffmpeg is around, so the conversion path handles genuine audio.
  try {
    tg.audio = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], { maxBuffer: 1 << 22 });
    hasFfmpeg = true;
  } catch {
    /* no ffmpeg here: the placeholder bytes still exercise everything but the re-encode */
  }

  tg.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const url = req.url ?? '';
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Speech-to-text stand-ins: OpenAI's transcription endpoint and Gemini's generateContent.
      if (url === '/audio/transcriptions' || url.startsWith('/v1beta/models/')) {
        tg.stt.push({ url, headers: req.headers, raw: rawBody });
        if (typeof tg.heard !== 'string') return send(tg.heard.status, { error: { message: 'The service is having a bad day.' } });
        return url === '/audio/transcriptions'
          ? send(200, { text: tg.heard })
          : send(200, { candidates: [{ content: { parts: [{ text: tg.heard }] } }] });
      }
      // Telegram's file download endpoint.
      if (url === `/file/bot${TOKEN}/voice/file_7.oga`) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(tg.audio);
      }

      const m = /^\/bot([^/]+)\/(\w+)$/.exec(url);
      const body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
      const reply = (result: unknown) => send(200, { ok: true, result });
      if (!m || m[1] !== TOKEN) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const method = m[2];
      if (method === 'getUpdates') {
        const due = tg.updates.filter((u) => u.update_id >= (body.offset ?? 0));
        tg.updates = [];
        return setTimeout(() => reply(due), due.length ? 0 : 25);
      }
      tg.calls.push({ method, body });
      if (method === 'getMe') return reply({ id: 1, is_bot: true, username: 'majordomo_test_bot' });
      if (method === 'getFile') return reply({ file_id: body.file_id, file_path: 'voice/file_7.oga' });
      if (method === 'sendMessage') {
        // Stand in for Telegram refusing our markup, so the plain-text fallback is exercised.
        if (body.parse_mode === 'HTML' && body.text.includes('unparseable')) {
          return send(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
        }
        return reply({ message_id: tg.nextMessage++ });
      }
      return reply(true);
    });
  });
  await new Promise<void>((r) => tg.server!.listen(0, '127.0.0.1', r));
  tg.url = `http://127.0.0.1:${(tg.server.address() as { port: number }).port}`;
  process.env.TELEGRAM_API_BASE = tg.url;
  process.env.OPENAI_BASE_URL = tg.url;
  process.env.GEMINI_BASE_URL = tg.url;

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

// ---------- voice notes ----------

const pmTurns = () => db.events.list('pm').filter((e) => e.type === 'user' && e.data.from === 'user');
const lastSent = () => tg.sent(42).at(-1)!.text as string;

test('a voice note with nothing to transcribe it explains what to set up', async () => {
  await until(pmIdle);
  const turns = pmTurns().length;
  assert.equal(telegram.status().voice.using, '');
  tg.voice(42);
  await until(() => /can't listen to voice notes yet/.test(lastSent()));
  assert.match(lastSent(), /OpenAI or Gemini API key, or a local transcription command/);
  assert.equal(tg.count('getFile'), 0, 'nothing is downloaded when it cannot be transcribed');
  assert.equal(pmTurns().length, turns);
});

test('a voice note is transcribed with an OpenAI key, echoed back, and given to the manager', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-openai';
  assert.equal(telegram.status().voice.using, 'OpenAI · gpt-4o-mini-transcribe');
  tg.heard = 'hi there';
  tg.voice(42);
  await until(() => tg.sent(42).some((m) => m.text === '<i>Heard:</i> hi there'));
  await until(() => pmTurns().at(-1)?.data.voice === true && pmIdle());

  const req = tg.stt.at(-1)!;
  assert.equal(req.url, '/audio/transcriptions');
  assert.equal(req.headers.authorization, 'Bearer sk-test-openai');
  const form = req.raw.toString('latin1');
  assert.match(form, /name="model"\r\n\r\ngpt-4o-mini-transcribe/);
  assert.match(form, /filename="voice\.ogg"/, 'Telegram’s .oga is sent under a name the API recognises');
  assert.ok(req.raw.includes(tg.audio), 'the recording itself was uploaded');

  const turn = pmTurns().at(-1)!;
  assert.deepEqual([turn.data.text, turn.data.via, turn.data.voice], ['hi there', 'telegram', true]);
  assert.match(JSON.stringify(db.messages.load('pm').at(-2)), /Voice: the message is a machine transcription of a voice note/);
  await until(() => /I am your project manager/.test(lastSent()), 10_000);
});

test('Gemini can transcribe instead, and gets MP3 when ffmpeg can make one', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  assert.equal((await put('/api/telegram', { voice: { provider: 'gemini', model: 'gemini-test' } })).status, 200);
  assert.equal(telegram.status().voice.using, 'Gemini · gemini-test');
  tg.heard = 'thanks';
  tg.voice(42);
  await until(() => tg.sent(42).some((m) => m.text === '<i>Heard:</i> thanks'));
  const req = tg.stt.at(-1)!;
  assert.equal(req.url, '/v1beta/models/gemini-test:generateContent');
  assert.equal(req.headers['x-goog-api-key'], 'test-gemini-key');
  const part = JSON.parse(req.raw.toString('utf8')).contents[0].parts[1].inline_data;
  const sent = Buffer.from(part.data, 'base64');
  if (hasFfmpeg) {
    assert.equal(part.mime_type, 'audio/mp3');
    assert.ok(sent.subarray(0, 3).toString() === 'ID3' || (sent[0] === 0xff && (sent[1] & 0xe0) === 0xe0), 'the bytes really are MP3');
  } else {
    assert.equal(part.mime_type, 'audio/ogg');
    assert.ok(sent.equals(tg.audio));
  }
  await until(pmIdle);
});

test('a local command can transcribe, with no account at all', async () => {
  // The command gets the recording as a file and prints the words on stdout; stderr chatter is ignored.
  const command = 'test -s {file} && echo "loading model..." >&2 && echo "  hello   there "';
  await put('/api/telegram', { voice: { provider: 'command', command } });
  assert.equal(telegram.status().voice.using, 'A command on this computer');
  tg.voice(42);
  await until(() => tg.sent(42).some((m) => m.text === '<i>Heard:</i> hello there'));
  await until(pmIdle);

  await put('/api/telegram', { voice: { provider: 'command', command: 'whisper-cli -m base.en' } });
  assert.match(telegram.status().voice.problem, /needs \{file\}/, 'a command with nowhere to put the recording is caught in Settings');

  await put('/api/telegram', { voice: { provider: 'command', command: 'test -s {file}; echo "model file missing" >&2; exit 3' } });
  const turns = pmTurns().length;
  tg.voice(42);
  await until(() => /couldn't transcribe that voice note/.test(lastSent()));
  assert.match(lastSent(), /exit 3\): model file missing/);
  assert.equal(pmTurns().length, turns, 'a failed transcription sends nothing to the manager');
});

test('silence, service errors and oversized recordings are reported, not passed on', async () => {
  await put('/api/telegram', { voice: { provider: 'openai', model: '' } });
  const turns = pmTurns().length;

  tg.heard = '   ';
  tg.voice(42);
  await until(() => /make out any words/.test(lastSent()));

  tg.heard = { status: 400 };
  tg.voice(42);
  await until(() => /couldn't transcribe that voice note \(OpenAI · gpt-4o-mini-transcribe\)/.test(lastSent()));
  assert.ok(!lastSent().includes(TOKEN) && !lastSent().includes('sk-test-openai'), 'no credential leaks into the error');

  const downloads = tg.count('getFile');
  tg.voice(42, { file_size: 25 * 1024 * 1024 });
  await until(() => /too large/.test(lastSent()));
  assert.equal(tg.count('getFile'), downloads);

  await put('/api/telegram', { voice: { provider: 'off' } });
  tg.voice(42);
  await until(() => /Voice notes are turned off/.test(lastSent()));
  assert.equal(pmTurns().length, turns);
  tg.heard = 'hi there';
});

test('a stranger’s voice note is never fetched or transcribed', async () => {
  await put('/api/telegram', { voice: { provider: 'auto' } });
  const [downloads, requests] = [tg.count('getFile'), tg.stt.length];
  tg.voice(777);
  await until(() => tg.sent(777).length === 1);
  assert.match(tg.sent(777)[0].text, /This bot is private/);
  assert.deepEqual([tg.count('getFile'), tg.stt.length], [downloads, requests]);
});

test('/unlink disconnects the chat', async () => {
  tg.message(42, '/unlink');
  await until(() => telegram.status().chats.length === 0);
  const turns = db.events.list('pm').filter((e) => e.type === 'user').length;
  tg.message(42, 'are you there?');
  await until(() => tg.sent(42).some((m) => /This bot is private/.test(m.text)));
  assert.equal(db.events.list('pm').filter((e) => e.type === 'user').length, turns);
});

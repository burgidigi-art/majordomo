import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chunks, isStopPhrase, pickVoice, speakable, TurnDetector } from '../../web/src/voice.ts';
import { mockApi, tempHome } from './helpers.ts';

// Voice mode: replies read aloud, and noticing when the speaker has finished a turn.

process.env.MAJORDOMO_DEMO = '1';
tempHome();

let app: typeof import('../http.ts')['app'];
let openai: Awaited<ReturnType<typeof mockApi>>;
const local = { host: 'localhost:4317', origin: 'http://localhost:4317', 'content-type': 'application/json' };
const speakReq = (body: unknown) => app.request('/api/speak', { method: 'POST', headers: local, body: JSON.stringify(body) });

before(async () => {
  openai = await mockApi(() => ({ json: { audio: 'mp3-bytes' } }));
  process.env.OPENAI_BASE_URL = openai.url;
  app = (await import('../http.ts')).app;
});
after(() => openai.close());

// ----- the speech endpoint -----

test('without an OpenAI key, reading aloud is left to the computer’s own voices', async () => {
  delete process.env.OPENAI_API_KEY;
  const state = (await (await app.request('/api/state', { headers: { host: 'localhost:4317' } })).json()) as { speech: { openai: boolean } };
  assert.equal(state.speech.openai, false);
  const res = await speakReq({ text: 'Hello' });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /needs an OpenAI API key/);
  assert.equal(openai.requests.length, 0);
});

test('with an OpenAI key, a reply is spoken by an OpenAI voice and returned as MP3', async () => {
  process.env.OPENAI_API_KEY = 'sk-test-voice';
  const state = (await (await app.request('/api/state', { headers: { host: 'localhost:4317' } })).json()) as { speech: { openai: boolean; voices: string[] } };
  assert.equal(state.speech.openai, true);
  assert.ok(state.speech.voices.includes('marin'));

  const res = await speakReq({ text: 'Three tasks are underway.', voice: 'coral', speed: 1.25 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.ok((await res.arrayBuffer()).byteLength > 0);

  const req = openai.requests.at(-1)!;
  assert.equal(req.url, '/audio/speech');
  assert.equal(req.headers.authorization, 'Bearer sk-test-voice');
  assert.equal(req.body.model, 'gpt-4o-mini-tts');
  assert.equal(req.body.voice, 'coral');
  assert.equal(req.body.speed, 1.25);
  assert.equal(req.body.input, 'Three tasks are underway.');
  assert.equal(req.body.response_format, 'mp3');
  assert.match(req.body.instructions, /naturally/);
});

test('an unknown voice falls back to the default, and the speed stays in a sane range', async () => {
  await speakReq({ text: 'Hi', voice: 'not-a-voice', speed: 9 });
  const req = openai.requests.at(-1)!;
  assert.equal(req.body.voice, 'marin');
  assert.equal(req.body.speed, 2);
});

test('nothing to say is refused before calling OpenAI, and another site cannot use it', async () => {
  const before = openai.requests.length;
  assert.equal((await speakReq({ text: '   ' })).status, 400);
  const foreign = await app.request('/api/speak', { method: 'POST', headers: { ...local, origin: 'https://evil.example' }, body: '{"text":"hi"}' });
  assert.equal(foreign.status, 403);
  assert.equal(openai.requests.length, before);
});

// ----- what is read out -----

test('a reply is read as sentences, with formatting, code and links left to the screen', () => {
  const md = [
    '## Done',
    '',
    'I set up **three** tasks:',
    '',
    '- Scout gathers [context](https://example.com/a)',
    '- Builder writes `notes.md`',
    '',
    '```bash',
    'npm test',
    '```',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    'Details at https://example.com/report. Want me to start?',
  ].join('\n');
  assert.equal(
    speakable(md),
    'Done. I set up three tasks: Scout gathers context. Builder writes notes.md. (Code is shown on screen.) (A table is shown on screen.) Details at a link. Want me to start?',
  );
});

test('long text is cut into pieces at sentence ends', () => {
  assert.deepEqual(chunks('One. Two two. Three three three.', 20), ['One. Two two.', 'Three three three.']);
  const long = chunks(`${'word '.repeat(100)}end.`, 60);
  assert.ok(long.every((c) => c.length <= 60));
  assert.equal(long.join(' ').replace(/\s+/g, ' '), `${'word '.repeat(100)}end.`.trim());
  assert.deepEqual(chunks('', 50), []);
});

test('the best installed voice for the language is chosen, and novelty voices are not', () => {
  const voices = [
    { name: 'Albert', lang: 'en-US', localService: true },
    { name: 'Samantha', lang: 'en-US', localService: true, default: true },
    { name: 'Ava (Premium)', lang: 'en-US', localService: true },
    { name: 'Thomas', lang: 'fr-FR', localService: true },
    { name: 'Daniel', lang: 'en-GB', localService: true },
  ];
  assert.equal(pickVoice(voices, 'en-US')?.name, 'Ava (Premium)');
  assert.equal(pickVoice(voices.slice(0, 2), 'en-US')?.name, 'Samantha', 'over a novelty voice');
  assert.equal(pickVoice(voices, 'fr-FR')?.name, 'Thomas');
  assert.equal(pickVoice(voices, 'en-US', 'Daniel')?.name, 'Daniel', 'a voice the user picked wins');
  assert.equal(pickVoice([], 'en-US'), null);
});

test('saying stop on its own ends voice mode; using the word in a request does not', () => {
  for (const s of ['stop', 'Stop.', "That's all", 'end voice mode', 'Goodbye!', "I'm done"]) assert.ok(isStopPhrase(s), s);
  for (const s of ['Stop the social bot', 'Is the back office done?', 'bye the way, check my inbox']) assert.ok(!isStopPhrase(s), s);
});

// ----- noticing the end of a turn -----

/** Feed the detector a level for a stretch of time, 50 ms at a time; return the first outcome. */
function feed(d: TurnDetector, level: number, from: number, to: number): { at: number; result: string } | null {
  for (let t = from; t < to; t += 50) {
    const result = d.update(level, t);
    if (result) return { at: t, result };
  }
  return null;
}

test('a turn ends after a pause that follows speech', () => {
  const d = new TurnDetector(0, { pauseMs: 1300 });
  assert.equal(feed(d, 0.004, 0, 800), null, 'room noise alone is not speech');
  assert.equal(feed(d, 0.12, 800, 3000), null, 'still talking');
  assert.equal(feed(d, 0.004, 3000, 3800), null, 'a short breath is not the end');
  assert.equal(feed(d, 0.12, 3800, 5000), null);
  const end = feed(d, 0.005, 5000, 9000);
  assert.deepEqual(end && { result: end.result, after: end.at - 5000 >= 1300 && end.at - 5000 < 1500 }, { result: 'done', after: true });
});

test('someone who starts talking the moment listening begins is still heard', () => {
  const d = new TurnDetector(0, { pauseMs: 1300, waitMs: 9000 });
  assert.equal(feed(d, 0.15, 0, 2500), null, 'talking from the first instant');
  assert.equal(feed(d, 0.004, 2500, 6000)?.result, 'done', 'and the pause after it ends the turn');
});

test('if nothing is said, the turn ends as nothing said', () => {
  const d = new TurnDetector(0, { waitMs: 4000 });
  const end = feed(d, 0.004, 0, 10_000);
  assert.equal(end?.result, 'nothing-said');
  assert.ok(end!.at >= 4000 && end!.at < 4200);
});

test('a steady hum in a noisy room does not count as speech', () => {
  const d = new TurnDetector(0, { waitMs: 3000 });
  assert.equal(feed(d, 0.03, 0, 3500)?.result, 'nothing-said');
});

test('one very long turn is cut off at the limit', () => {
  const d = new TurnDetector(0, { maxMs: 5000 });
  assert.equal(feed(d, 0.2, 0, 6000)?.result, 'done');
});

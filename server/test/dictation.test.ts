import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { clock, joinDictation, pickEngine, punctuate, recordingType, speechError } from '../../web/src/dictation.ts';
import { tempHome } from './helpers.ts';

// Dictation in the dashboard: the browser records, the voice-note transcriber writes it down.

process.env.MAJORDOMO_DEMO = '1';
tempHome();

let app: typeof import('../http.ts')['app'];
let uploadedAudio: typeof import('../gateways/transcribe.ts')['uploadedAudio'];
const local = { host: 'localhost:4317', origin: 'http://localhost:4317' };

before(async () => {
  app = (await import('../http.ts')).app;
  uploadedAudio = (await import('../gateways/transcribe.ts')).uploadedAudio;
});

const voice = (body: unknown) =>
  app.request('/api/telegram', { method: 'PUT', headers: { 'content-type': 'application/json', ...local }, body: JSON.stringify(body) });

const upload = (bytes: Uint8Array, type: string, headers: Record<string, string> = local) =>
  app.request('/api/transcribe', { method: 'POST', headers: { 'content-type': type, ...headers }, body: bytes });

const CLIP = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);

// ----- the transcription endpoint -----

test('a recording from the dashboard is transcribed by the voice-note transcriber', async () => {
  // The command sees the recording as a file with the right extension, and prints the words.
  await voice({ voice: { provider: 'command', command: 'case {file} in *.webm) test -s {file} && echo "  plan next   week ";; *) echo wrong-type;; esac' } });
  const res = await upload(CLIP, 'audio/webm;codecs=opus');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: 'plan next week' });
});

test('with nothing set up to transcribe, it says what is missing', async () => {
  await voice({ voice: { provider: 'command', command: '' } });
  const res = await upload(CLIP, 'audio/webm');
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /needs .*local command|none is entered/);
});

test('a transcriber that fails passes its reason on', async () => {
  await voice({ voice: { provider: 'command', command: 'test -s {file}; echo "model file missing" >&2; exit 3' } });
  const res = await upload(CLIP, 'audio/mp4');
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /exit 3.*model file missing/);
});

test('empty recordings and unknown formats are refused before anything runs', async () => {
  await voice({ voice: { provider: 'command', command: 'echo should-not-run {file}' } });
  const empty = await upload(new Uint8Array(), 'audio/webm');
  assert.equal(empty.status, 400);
  assert.match(((await empty.json()) as { error: string }).error, /empty/);
  const odd = await upload(CLIP, 'application/pdf');
  assert.equal(odd.status, 415);
});

test('another website cannot send recordings to it', async () => {
  const res = await upload(CLIP, 'audio/webm', { host: 'localhost:4317', origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('each browser’s recording format is recognised', () => {
  assert.deepEqual(uploadedAudio('audio/webm;codecs=opus'), { mime: 'audio/webm', ext: 'webm' }, 'Chrome and Edge');
  assert.deepEqual(uploadedAudio('audio/mp4'), { mime: 'audio/mp4', ext: 'mp4' }, 'Safari');
  assert.deepEqual(uploadedAudio('audio/ogg; codecs=opus'), { mime: 'audio/ogg', ext: 'ogg' }, 'Firefox');
  assert.deepEqual(uploadedAudio('video/webm'), { mime: 'audio/webm', ext: 'webm' }, 'a recording labelled as video');
  assert.equal(uploadedAudio('text/plain'), null);
});

// ----- the button's decisions -----

test('the transcriber the user set up is used when there is one, else the browser’s own', () => {
  assert.equal(pickEngine(true, true, true), 'server');
  assert.equal(pickEngine(false, true, true), 'browser');
  assert.equal(pickEngine(true, true, false), 'browser', 'a browser that cannot record falls back to its recogniser');
  assert.equal(pickEngine(true, false, true), 'server');
  assert.equal(pickEngine(false, false, true), null, 'nothing to turn speech into text');
});

test('spoken words go after what was typed, with one space', () => {
  assert.equal(joinDictation('', '  hello there '), 'hello there');
  assert.equal(joinDictation('Draft three posts', 'about the launch'), 'Draft three posts about the launch');
  assert.equal(joinDictation('Line one\n', 'line two'), 'Line one\nline two');
  assert.equal(joinDictation('Keep this', '   '), 'Keep this', 'silence changes nothing');
});

test('a phrase from the browser gets a capital and a period, or a question mark when it asks', () => {
  assert.equal(punctuate('hey just testing out the dictation'), 'Hey just testing out the dictation.');
  assert.equal(punctuate('can you check my inbox'), 'Can you check my inbox?');
  assert.equal(punctuate('hey so what did the social bot finish today'), 'Hey so what did the social bot finish today?');
  assert.equal(punctuate("didn't we post that already"), "Didn't we post that already?");
  assert.equal(punctuate('I wonder if it works'), 'I wonder if it works.', 'a statement about a question is a statement');
  assert.equal(punctuate('whatever works best'), 'Whatever works best.', 'whole words only');
  assert.equal(punctuate('Is it done?'), 'Is it done?', 'punctuation already there is kept');
  assert.equal(punctuate('  draft   three posts '), 'Draft three posts.');
  assert.equal(punctuate('   '), '');
});

test('the recording format is the first the browser can make', () => {
  assert.equal(recordingType((t) => t.startsWith('audio/webm')), 'audio/webm;codecs=opus');
  assert.equal(recordingType((t) => t === 'audio/mp4'), 'audio/mp4');
  assert.equal(recordingType(() => false), '');
});

test('microphone problems are explained, and ordinary stops are not', () => {
  assert.match(speechError('not-allowed'), /Privacy & Security → Microphone/);
  assert.match(speechError('audio-capture'), /No microphone/);
  assert.equal(speechError('no-speech'), '');
  assert.equal(speechError('aborted'), '');
  assert.equal(clock(75), '1:15');
});

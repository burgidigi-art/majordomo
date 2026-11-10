import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import OpenAI, { toFile } from 'openai';
import type { VoiceSettings, VoiceStatus } from '../../shared/types.ts';
import { kvGet, kvSet } from '../db.ts';
import { describeOpenAIError } from '../llm/openai.ts';
import { getSecret } from '../settings.ts';

/**
 * Speech-to-text for voice notes. Three ways to do it, because not every account can:
 * an OpenAI key (the transcription API), a Gemini key (audio in a normal request), or any
 * local command that takes an audio file and prints the words — which keeps voice notes
 * working, and private, for someone who only has a Claude subscription.
 */

const DEFAULTS: VoiceSettings = { provider: 'auto', model: '', command: '' };
const OPENAI_MODEL = 'gpt-4o-mini-transcribe';
const GEMINI_MODEL = 'gemini-flash-latest';

export interface Audio {
  bytes: Buffer;
  /** e.g. audio/ogg — Telegram voice notes are Opus in an Ogg container. */
  mime: string;
  /** File extension without the dot. */
  ext: string;
}

interface Backend {
  kind: 'openai' | 'gemini' | 'command';
  model: string;
  label: string;
}

export function getVoiceSettings(): VoiceSettings {
  return { ...DEFAULTS, ...kvGet<Partial<VoiceSettings>>('telegram:voice', {}) };
}

export function saveVoiceSettings(next: Partial<VoiceSettings>): void {
  const cur = getVoiceSettings();
  const provider = ['auto', 'openai', 'gemini', 'command', 'off'].includes(next.provider as string) ? next.provider! : cur.provider;
  kvSet('telegram:voice', {
    provider,
    model: typeof next.model === 'string' ? next.model.trim() : cur.model,
    command: typeof next.command === 'string' ? next.command.trim() : cur.command,
  });
}

/** Decide what will transcribe, or say what is missing. */
export function resolveVoice(): { backend: Backend | null; problem: string } {
  const s = getVoiceSettings();
  const openai = (model: string): Backend => ({ kind: 'openai', model, label: `OpenAI · ${model}` });
  const gemini = (model: string): Backend => ({ kind: 'gemini', model, label: `Gemini · ${model}` });
  const command: Backend = { kind: 'command', model: '', label: 'A command on this computer' };

  switch (s.provider) {
    case 'off':
      return { backend: null, problem: 'Voice notes are turned off.' };
    case 'openai':
      return getSecret('openai')
        ? { backend: openai(s.model || OPENAI_MODEL), problem: '' }
        : { backend: null, problem: 'Voice notes are set to use OpenAI, but no OpenAI API key is saved.' };
    case 'gemini':
      return getSecret('gemini')
        ? { backend: gemini(s.model || GEMINI_MODEL), problem: '' }
        : { backend: null, problem: 'Voice notes are set to use Gemini, but no Gemini API key is saved.' };
    case 'command':
      if (!s.command) return { backend: null, problem: 'Voice notes are set to use a local command, but none is entered.' };
      if (!s.command.includes('{file}')) {
        return { backend: null, problem: 'The local transcription command needs {file} where the path of the recording should go.' };
      }
      return { backend: command, problem: '' };
    default:
      if (getSecret('openai')) return { backend: openai(OPENAI_MODEL), problem: '' };
      if (getSecret('gemini')) return { backend: gemini(GEMINI_MODEL), problem: '' };
      if (s.command.includes('{file}')) return { backend: command, problem: '' };
      return {
        backend: null,
        problem: 'Voice notes need something to turn speech into text: an OpenAI or Gemini API key, or a local transcription command.',
      };
  }
}

export function voiceStatus(): VoiceStatus {
  const { backend, problem } = resolveVoice();
  return { ...getVoiceSettings(), using: backend?.label ?? '', problem };
}

// ---------- backends ----------

async function viaOpenAI(audio: Audio, model: string, signal: AbortSignal): Promise<string> {
  const client = new OpenAI({ apiKey: getSecret('openai')!.key, baseURL: process.env.OPENAI_BASE_URL || undefined });
  // The API picks the decoder from the filename, and it knows ".ogg" but not Telegram's ".oga".
  const ext = audio.ext === 'oga' ? 'ogg' : audio.ext;
  try {
    const file = await toFile(audio.bytes, `voice.${ext}`, { type: audio.mime });
    const res = await client.audio.transcriptions.create({ file, model }, { signal });
    return res.text ?? '';
  } catch (err) {
    throw new Error(describeOpenAIError(err) ?? (err instanceof Error ? err.message : String(err)));
  }
}

/** Re-encode to MP3 when ffmpeg is installed. Resolves null when it is not, or the conversion fails. */
function toMp3(bytes: Buffer, signal: AbortSignal): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-b:a', '48k', '-f', 'mp3', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      signal,
    });
    const out: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 && out.length ? Buffer.concat(out) : null));
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

async function viaGemini(audio: Audio, model: string, signal: AbortSignal): Promise<string> {
  // Google documents MP3 and WAV everywhere and Ogg only in places, so send MP3 when we can make one.
  const mp3 = /ogg|opus/.test(audio.mime) ? await toMp3(audio.bytes, signal) : null;
  const base = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': getSecret('gemini')!.key },
    signal,
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text:
                'Transcribe this voice note exactly as spoken, in the language it is spoken in. ' +
                'Reply with the transcript only: no commentary, no quotation marks, no timestamps. ' +
                'If there is no intelligible speech, reply with nothing at all.',
            },
            { inline_data: { mime_type: mp3 ? 'audio/mp3' : audio.mime, data: (mp3 ?? audio.bytes).toString('base64') } },
          ],
        },
      ],
    }),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new Error(`Gemini could not transcribe it: ${json?.error?.message ?? `HTTP ${res.status}`}`);
  const parts: { text?: string }[] = json?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Run the user's own transcriber. `{file}` in the command is replaced by the audio file's path. */
async function viaCommand(audio: Audio, template: string, signal: AbortSignal): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'majordomo-voice-'));
  const file = path.join(dir, `voice.${audio.ext === 'oga' ? 'ogg' : audio.ext}`);
  try {
    await fs.writeFile(file, audio.bytes, { mode: 0o600 });
    const command = template.replaceAll('{file}', shellQuote(file));
    return await new Promise<string>((resolve, reject) => {
      const child = spawn('bash', ['-c', command], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], signal });
      let out = '';
      let errText = '';
      // Only stdout is the transcript: these tools log their progress to stderr.
      child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.stderr.on('data', (b: Buffer) => {
        if (errText.length < 4000) errText += b.toString('utf8');
      });
      child.on('error', (err) => reject(new Error(`The transcription command could not start: ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) return resolve(out);
        const last = errText.trim().split('\n').at(-1) ?? '';
        reject(new Error(`The transcription command failed (exit ${code})${last ? `: ${last.slice(0, 300)}` : ''}`));
      });
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function transcribe(audio: Audio, signal: AbortSignal = AbortSignal.timeout(180_000)): Promise<string> {
  const { backend, problem } = resolveVoice();
  if (!backend) throw new Error(problem);
  const text =
    backend.kind === 'openai'
      ? await viaOpenAI(audio, backend.model, signal)
      : backend.kind === 'gemini'
        ? await viaGemini(audio, backend.model, signal)
        : await viaCommand(audio, getVoiceSettings().command, signal);
  return text.replace(/\s+/g, ' ').trim();
}

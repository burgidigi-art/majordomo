// Text to speech for voice mode: the manager's replies read aloud. With an OpenAI key the words are
// spoken by OpenAI's voices; without one the dashboard uses the voices built into the computer, so
// this module only has to cover the first case.
import OpenAI from 'openai';
import { describeOpenAIError } from './llm/openai.ts';
import { getSecret } from './settings.ts';

export const OPENAI_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const MODEL = 'gpt-4o-mini-tts';
/** The API's limit per request; the dashboard sends longer replies in pieces. */
export const MAX_SPEECH_CHARS = 4096;

export function speechStatus(): { openai: boolean; voices: string[] } {
  return { openai: !!getSecret('openai'), voices: OPENAI_VOICES };
}

export async function speak(text: string, opts: { voice?: string; speed?: number } = {}, signal?: AbortSignal): Promise<Buffer> {
  const secret = getSecret('openai');
  if (!secret) throw new Error('Reading aloud with OpenAI voices needs an OpenAI API key under Settings → Accounts.');
  const input = text.trim().slice(0, MAX_SPEECH_CHARS);
  if (!input) throw new Error('There is nothing to read aloud.');
  const voice = OPENAI_VOICES.includes(opts.voice ?? '') ? opts.voice! : OPENAI_VOICES[0]!;
  const speed = Math.min(2, Math.max(0.5, Number(opts.speed) || 1));
  const client = new OpenAI({ apiKey: secret.key, baseURL: process.env.OPENAI_BASE_URL || undefined });
  try {
    const res = await client.audio.speech.create(
      {
        model: MODEL,
        voice,
        input,
        speed,
        response_format: 'mp3',
        instructions: 'Speak naturally and warmly, like a capable assistant giving a quick update. Keep a brisk, conversational pace.',
      },
      { signal },
    );
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(describeOpenAIError(err) ?? (err instanceof Error ? err.message : String(err)));
  }
}

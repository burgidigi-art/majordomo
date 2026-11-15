// Reading text aloud in the dashboard. One speaker for the whole page: a queue of things to say,
// played through OpenAI's voices when a key is saved and the computer's own voices otherwise.
import { useSyncExternalStore } from 'react';
import { chunks, pickVoice } from './voice.ts';

export interface VoicePrefs {
  /** auto: OpenAI's voices when a key is saved, else this computer's. */
  engine: 'auto' | 'browser' | 'openai';
  browserVoice: string;
  openaiVoice: string;
  speed: number;
  /** Read each new reply from the manager aloud as it arrives. */
  autoRead: boolean;
}

const PREFS_KEY = 'majordomo:voice';
const DEFAULT_PREFS: VoicePrefs = { engine: 'auto', browserVoice: '', openaiVoice: 'marin', speed: 1, autoRead: false };

function loadPrefs(): VoicePrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<VoicePrefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

interface SpeakerState {
  prefs: VoicePrefs;
  /** What is being read now: the key of the message, or null when quiet. */
  current: string | null;
}

let state: SpeakerState = { prefs: loadPrefs(), current: null };
const listeners = new Set<() => void>();
const emit = (next: Partial<SpeakerState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useSpeaker(): SpeakerState {
  return useSyncExternalStore(subscribe, () => state);
}

export function setVoicePrefs(next: Partial<VoicePrefs>): void {
  emit({ prefs: { ...state.prefs, ...next } });
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    /* storage blocked: the choice lasts until the page is reloaded */
  }
}

// ---------- playing ----------

interface Job {
  key: string;
  text: string;
  done: () => void;
}

const queue: Job[] = [];
let stopCurrent: (() => void) | null = null;
let openaiAvailable = false;

/** Told by the app whether an OpenAI key is saved. */
export function setOpenAIAvailable(on: boolean): void {
  openaiAvailable = on;
}

function useOpenAI(): boolean {
  const { engine } = state.prefs;
  return engine === 'openai' || (engine === 'auto' && openaiAvailable);
}

/** The computer's voices. Chrome fills the list in a moment after the page loads. */
export function browserVoices(): SpeechSynthesisVoice[] {
  return typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
}

function sayWithBrowser(text: string): { finished: Promise<void>; stop: () => void } {
  if (typeof speechSynthesis === 'undefined') return { finished: Promise.resolve(), stop: () => {} };
  const voice = pickVoice(browserVoices(), navigator.language || 'en-US', state.prefs.browserVoice);
  const pieces = chunks(text, 220);
  let stopped = false;
  const finished = new Promise<void>((resolve) => {
    let left = pieces.length;
    if (!left) return resolve();
    for (const piece of pieces) {
      const u = new SpeechSynthesisUtterance(piece);
      if (voice) u.voice = voice;
      u.rate = state.prefs.speed;
      u.onend = u.onerror = () => {
        left -= 1;
        if (left <= 0 || stopped) resolve();
      };
      speechSynthesis.speak(u);
    }
  });
  return {
    finished,
    stop: () => {
      stopped = true;
      speechSynthesis.cancel();
    },
  };
}

async function fetchSpeech(text: string, signal: AbortSignal): Promise<string> {
  const res = await fetch('/api/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: state.prefs.openaiVoice, speed: state.prefs.speed }),
    signal,
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `Reading aloud failed (${res.status})`);
  }
  return URL.createObjectURL(await res.blob());
}

function sayWithOpenAI(text: string): { finished: Promise<void>; stop: () => void } {
  const abort = new AbortController();
  let audio: HTMLAudioElement | null = null;
  const finished = (async () => {
    const pieces = chunks(text, 3800);
    // Fetch the next piece while the current one plays, so long replies run on without a gap.
    let next = pieces.length ? fetchSpeech(pieces[0]!, abort.signal) : null;
    for (let i = 0; i < pieces.length && next; i++) {
      const url = await next;
      next = i + 1 < pieces.length ? fetchSpeech(pieces[i + 1]!, abort.signal) : null;
      if (abort.signal.aborted) return URL.revokeObjectURL(url);
      audio = new Audio(url);
      await new Promise<void>((resolve) => {
        audio!.onended = audio!.onerror = () => resolve();
        abort.signal.addEventListener('abort', () => resolve(), { once: true });
        void audio!.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    }
  })();
  return {
    finished,
    stop: () => {
      abort.abort();
      audio?.pause();
    },
  };
}

async function pump(): Promise<void> {
  if (state.current !== null) return;
  const job = queue.shift();
  if (!job) return;
  emit({ current: job.key });
  let playing = useOpenAI() ? sayWithOpenAI(job.text) : sayWithBrowser(job.text);
  stopCurrent = () => playing.stop();
  try {
    await playing.finished;
  } catch (err) {
    // OpenAI could not do it (no key, no network, out of credit): say it with the computer's voice.
    onError?.(err instanceof Error ? err.message : String(err));
    playing = sayWithBrowser(job.text);
    stopCurrent = () => playing.stop();
    await playing.finished;
  }
  stopCurrent = null;
  job.done();
  emit({ current: null });
  void pump();
}

let onError: ((message: string) => void) | null = null;
export function onSpeakerError(fn: (message: string) => void): void {
  onError = fn;
}

/** Add something to read. Resolves when it has been read, or skipped by stop(). */
export function say(text: string, key = `say-${Date.now()}`): Promise<void> {
  const clean = text.trim();
  if (!clean) return Promise.resolve();
  return new Promise((done) => {
    queue.push({ key, text: clean, done });
    void pump();
  });
}

/** Stop reading, and drop anything waiting to be read. */
export function stopSpeaking(): void {
  for (const job of queue.splice(0)) job.done();
  stopCurrent?.();
}

export function isSpeaking(): boolean {
  return state.current !== null;
}

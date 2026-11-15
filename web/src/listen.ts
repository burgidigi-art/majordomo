// One turn of listening for hands-free voice mode: start, notice when the speaker has finished, and
// return what they said. Uses the same two engines as the dictation button.
import { punctuate, recordingType, speechError, type DictationEngine } from './dictation.ts';
import { TurnDetector } from './voice.ts';

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export function recogniserClass(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

export interface Turn {
  /** What was said, punctuated; empty when nothing was. */
  text: Promise<string>;
  /** Stop listening now and keep what was heard so far. */
  finish(): void;
  /** Stop listening and throw it away. */
  cancel(): void;
}

/**
 * Listen for one turn. `onHeard` gets the words as they come in (browser engine) and `onPhase` says
 * when the recording is being turned into text (server engine).
 */
export function listenOnce(engine: DictationEngine, hooks: { onHeard?: (text: string) => void; onPhase?: (p: 'transcribing') => void } = {}): Turn {
  return engine === 'browser' ? viaBrowser(hooks.onHeard) : viaRecording(hooks.onPhase);
}

function viaBrowser(onHeard?: (text: string) => void): Turn {
  const Rec = recogniserClass()!;
  const rec = new Rec();
  rec.lang = navigator.language || 'en-US';
  // Not continuous: the recogniser ends the turn by itself after a pause, which is what we want.
  rec.continuous = false;
  rec.interimResults = true;
  let heard = '';
  let failure = '';
  let discard = false;
  const text = new Promise<string>((resolve, reject) => {
    rec.onresult = (e) => {
      heard = Array.from({ length: e.results.length }, (_, i) => e.results[i]![0]!.transcript).join(' ');
      onHeard?.(heard);
    };
    rec.onerror = (e) => {
      failure = speechError(e.error);
    };
    rec.onend = () => {
      if (failure) return reject(new Error(failure));
      resolve(discard ? '' : punctuate(heard));
    };
  });
  rec.start();
  return {
    text,
    finish: () => rec.stop(),
    cancel: () => {
      discard = true;
      rec.abort();
    },
  };
}

function viaRecording(onPhase?: (p: 'transcribing') => void): Turn {
  let finishNow: (() => void) | null = null;
  let discard = false;
  const text = (async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      throw new Error(speechError('not-allowed'));
    }
    const type = recordingType((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    // Measure loudness to tell when the speaker has finished.
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const frame = new Float32Array(analyser.fftSize);
    const detector = new TurnDetector(performance.now());

    const outcome = await new Promise<'done' | 'nothing-said'>((resolve) => {
      finishNow = () => resolve(detector.heardSpeech ? 'done' : 'nothing-said');
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(frame);
        let sum = 0;
        for (const v of frame) sum += v * v;
        const result = detector.update(Math.sqrt(sum / frame.length), performance.now());
        if (result) {
          clearInterval(timer);
          resolve(result);
        }
      }, 50);
      recorder.start(500);
      const prev = finishNow;
      finishNow = () => {
        clearInterval(timer);
        prev();
      };
    });

    const stopped = new Promise<void>((r) => (recorder.onstop = () => r()));
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    if (discard || outcome === 'nothing-said') return '';

    onPhase?.('transcribing');
    const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
    const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
    const json = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) throw new Error(json.error ?? `Transcription failed (${res.status})`);
    return (json.text ?? '').trim();
  })();
  return {
    text,
    finish: () => finishNow?.(),
    cancel: () => {
      discard = true;
      finishNow?.();
    },
  };
}

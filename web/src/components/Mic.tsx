import { LoaderCircle, Mic as MicIcon, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { clock, joinDictation, pickEngine, recordingType, speechError } from '../dictation.ts';
import { useStore } from '../store.ts';
import { toast } from './ui.tsx';

// The browser's speech recogniser is not in TypeScript's DOM types; this is the part used here.
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

function recogniserClass(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
const MAX_SECONDS = 10 * 60;

type Phase = 'idle' | 'listening' | 'transcribing';

/**
 * A microphone button for a message box. Click to talk, click again to stop; Escape throws the take
 * away. The words land in the box after what is already typed, to be read over and sent as usual.
 */
export function Mic({ value, onChange, focus }: { value: string; onChange: (text: string) => void; focus?: () => void }) {
  const serverReady = useStore((s) => !!s.app?.telegram.voice.using);
  const engine = pickEngine(serverReady, !!recogniserClass(), canRecord());
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);

  const base = useRef('');
  const last = useRef('');
  const recognition = useRef<Recognition | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const discard = useRef(false);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  const put = (spoken: string) => {
    last.current = joinDictation(base.current, spoken);
    latest.current.onChange(last.current);
  };

  // Count the seconds while listening, and stop at the limit.
  useEffect(() => {
    if (phase !== 'listening') return;
    const started = Date.now();
    setSeconds(0);
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) stop();
    }, 250);
    return () => clearInterval(t);
  }, [phase]);

  // The message was sent (the box emptied) while still listening: stop, and keep the box empty.
  useEffect(() => {
    if (phase === 'listening' && value === '' && last.current !== '') cancel();
  }, [value, phase]);

  // Escape abandons the take and puts back what was typed before it.
  useEffect(() => {
    if (phase !== 'listening') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      cancel();
      latest.current.onChange(base.current);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase]);

  // Leaving the page mid-sentence releases the microphone.
  useEffect(() => () => cancel(), []);

  function startBrowser() {
    const Rec = recogniserClass()!;
    const rec = new Rec();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i]![0]!.transcript;
      if (!discard.current) put(text);
    };
    rec.onerror = (e) => {
      const msg = speechError(e.error);
      if (msg) toast(msg, true);
    };
    rec.onend = () => {
      recognition.current = null;
      setPhase('idle');
      focus?.();
    };
    recognition.current = rec;
    rec.start();
    setPhase('listening');
  }

  async function startRecording() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast(speechError('not-allowed'), true);
      return;
    }
    const type = recordingType((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      if (discard.current) return setPhase('idle');
      const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
      setPhase('transcribing');
      try {
        const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        const json = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok) throw new Error(json.error ?? `Transcription failed (${res.status})`);
        if (json.text?.trim()) put(json.text);
        else toast('No speech was heard in that recording.', true);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), true);
      } finally {
        setPhase('idle');
        focus?.();
      }
    };
    recorder.current = rec;
    rec.start(1000);
    setPhase('listening');
  }

  function start() {
    discard.current = false;
    base.current = latest.current.value;
    last.current = '';
    if (engine === 'server') void startRecording();
    else if (engine === 'browser') startBrowser();
  }

  function stop() {
    recognition.current?.stop();
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }

  function cancel() {
    discard.current = true;
    recognition.current?.abort();
    if (recorder.current?.state === 'recording') recorder.current.stop();
  }

  if (!engine) {
    return (
      <button
        type="button"
        className="mic"
        disabled
        aria-label="Dictation is not available"
        title="Dictation needs Chrome, Edge or Safari, or a transcriber set up under Settings → Phone & alerts → Voice notes."
      >
        <MicIcon size={16} />
      </button>
    );
  }

  if (phase === 'transcribing') {
    return (
      <span className="mic busy" role="status" aria-label="Turning your recording into text">
        <LoaderCircle size={16} className="spin" />
        <span className="mic-label">Transcribing…</span>
      </span>
    );
  }

  if (phase === 'listening') {
    return (
      <button type="button" className="mic live" onClick={stop} aria-label="Stop dictation" title="Stop (Escape discards it)">
        <Square size={11} fill="currentColor" />
        <span className="mic-label tnum">{clock(seconds)}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="mic"
      onClick={start}
      aria-label="Dictate"
      title={engine === 'server' ? 'Dictate: speak, then click again to stop' : 'Dictate: the words appear as you speak'}
    >
      <MicIcon size={16} />
    </button>
  );
}

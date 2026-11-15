import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { pickEngine } from '../dictation.ts';
import { canRecord, listenOnce, recogniserClass, type Turn } from '../listen.ts';
import { say, stopSpeaking } from '../speaker.ts';
import { useStore } from '../store.ts';
import { isStopPhrase, speakable } from '../voice.ts';
import { toast } from './ui.tsx';

type Phase = 'starting' | 'listening' | 'transcribing' | 'sending' | 'thinking' | 'speaking';

const LABEL: Record<Phase, string> = {
  starting: 'Starting…',
  listening: 'Listening',
  transcribing: 'Writing down what you said…',
  sending: 'Sending…',
  thinking: 'Your manager is on it…',
  speaking: 'Speaking',
};

const QUIET = /^<quiet\s*\/>$/;

/** The newest event id in the manager's log, to tell its reply apart from what came before. */
function lastEventId(): number {
  const list = useStore.getState().events.pm ?? [];
  return list.reduce((n, e) => Math.max(n, e.id), 0);
}

/**
 * Wait for the manager to finish answering, then return what it said. It may take a moment to
 * start, so a turn is only over once it has been busy and gone quiet again (or never started).
 */
function waitForReply(sinceId: number, alive: () => boolean): Promise<string> {
  return new Promise((resolve) => {
    const started = Date.now();
    let sawBusy = false;
    const check = () => {
      if (!alive()) return finish('');
      const s = useStore.getState();
      const busy = !!s.app?.pm.busy;
      if (busy) sawBusy = true;
      if (busy || (!sawBusy && Date.now() - started < 5000)) return;
      const said = (s.events.pm ?? [])
        .filter((e) => e.id > sinceId && (e.type === 'text' || e.type === 'error'))
        .map((e) => (e.type === 'error' ? `Something went wrong: ${String(e.data.message ?? '')}` : String(e.data.text ?? '').trim()))
        .filter((t) => t && !QUIET.test(t));
      finish(said.join('\n\n'));
    };
    const unsubscribe = useStore.subscribe(check);
    const timer = setInterval(check, 400);
    function finish(text: string) {
      unsubscribe();
      clearInterval(timer);
      resolve(text);
    }
  });
}

/**
 * Hands-free conversation with the manager: listen, send what was said when the speaker pauses,
 * read the reply aloud, listen again. Saying "stop", pressing Escape or End finishes it.
 */
export function VoiceMode({ onEnd }: { onEnd: () => void }) {
  const serverReady = useStore((s) => !!s.app?.telegram.voice.using);
  const engine = pickEngine(serverReady, !!recogniserClass(), canRecord());
  const [phase, setPhase] = useState<Phase>('starting');
  const [heard, setHeard] = useState('');
  const turn = useRef<Turn | null>(null);
  const ended = useRef(false);
  const end = useRef(onEnd);
  end.current = onEnd;

  const finish = () => {
    if (ended.current) return;
    ended.current = true;
    turn.current?.cancel();
    stopSpeaking();
    end.current();
  };

  useEffect(() => {
    if (!engine) {
      toast('Voice mode needs Chrome, Edge or Safari, or a transcriber under Settings → Phone & alerts.', true);
      finish();
      return;
    }
    const alive = () => !ended.current;
    let misses = 0;
    void (async () => {
      while (alive()) {
        setPhase('listening');
        setHeard('');
        const t = listenOnce(engine, { onHeard: setHeard, onPhase: () => setPhase('transcribing') });
        turn.current = t;
        let text = '';
        try {
          text = await t.text;
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), true);
          return finish();
        }
        turn.current = null;
        if (!alive()) return;
        if (!text) {
          misses += 1;
          if (misses >= 2) {
            setPhase('speaking');
            await say('I will stop listening for now.', 'voice-mode');
            return finish();
          }
          continue;
        }
        misses = 0;
        if (isStopPhrase(text)) return finish();

        setHeard(text);
        setPhase('sending');
        const since = lastEventId();
        try {
          await api.chat(text);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), true);
          return finish();
        }
        setPhase('thinking');
        const reply = await waitForReply(since, alive);
        if (!alive()) return;
        if (reply) {
          setPhase('speaking');
          await say(speakable(reply), 'voice-mode');
        }
      }
    })();
    return () => {
      ended.current = true;
      turn.current?.cancel();
      stopSpeaking();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // The orb ends your turn early while listening, and cuts the reply short while speaking.
  const orb = () => {
    if (phase === 'listening') turn.current?.finish();
    else if (phase === 'speaking') stopSpeaking();
  };
  const orbLabel = phase === 'listening' ? 'Done talking' : phase === 'speaking' ? 'Interrupt' : LABEL[phase];

  return (
    <div className="voice-mode" role="region" aria-label="Voice conversation">
      <button type="button" className={`voice-orb is-${phase}`} onClick={orb} aria-label={orbLabel} title={orbLabel}>
        <span className="voice-ring" />
        <span className="voice-core" />
      </button>
      <div className="voice-text">
        <div className="voice-status" aria-live="polite">
          {LABEL[phase]}
        </div>
        <div className="voice-heard">{heard || (phase === 'listening' ? 'Go ahead — I send it when you pause.' : '')}</div>
        <div className="voice-hint">
          {phase === 'speaking' ? 'Click the circle to interrupt' : phase === 'listening' ? 'Click the circle when you are done' : ' '} · Say
          “stop” or press Escape to end
        </div>
      </div>
      <button type="button" className="btn sm voice-end" onClick={finish}>
        <X size={14} /> End
      </button>
    </div>
  );
}

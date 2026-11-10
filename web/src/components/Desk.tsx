import { ArrowUp, FlaskConical, PanelRight, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AgentEvent } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { greeting, isLive } from '../lib.ts';
import { useStore, type StreamingBlock } from '../store.ts';
import { Transcript } from './Transcript.tsx';
import { attempt } from './ui.tsx';

const NO_EVENTS: AgentEvent[] = [];
const NO_STREAM: Record<string, StreamingBlock> = {};

/** Keep a scrolling log pinned to the bottom unless the reader has scrolled up to look at something. */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, signal: unknown): void {
  const stuck = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [ref, signal]);
}

const STARTERS = [
  { title: 'Ship something', text: 'Build a small CLI that renames my photos by the date they were taken, with tests.' },
  { title: 'Plan something', text: 'Plan a four-day trip to Lisbon in May for two people who like food and walking. Compare three neighbourhoods to stay in.' },
  { title: 'Research something', text: 'Compare the three most popular open-source vector databases and recommend one for a side project.' },
  { title: 'Tidy something', text: 'Go through the notes folder in my project workspace and turn it into one organised document.' },
];

export function Desk() {
  const app = useStore((s) => s.app)!;
  const events = useStore((s) => s.events.pm ?? NO_EVENTS);
  const loaded = useStore((s) => !!s.loaded.pm);
  const streaming = useStore((s) => s.streaming.pm ?? NO_STREAM);
  const loadEvents = useStore((s) => s.loadEvents);
  const setRailOpen = useStore((s) => s.setRailOpen);
  const railOpen = useStore((s) => s.railOpen);

  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void loadEvents('pm');
  }, [loadEvents]);

  const streamLen = Object.values(streaming).reduce((n, b) => n + b.text.length, 0);
  useStickToBottom(scroller, `${events.length}:${streamLen}:${app.pm.busy}`);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  const send = async (text = draft) => {
    const clean = text.trim();
    if (!clean) return;
    setDraft('');
    const ok = await attempt(() => api.chat(clean));
    if (!ok) setDraft(clean);
  };

  const live = app.tasks.filter(isLive).length;
  const pmRuntime = app.runtimes.find((r) => r.id === app.settings.pm.runtime);
  const empty = loaded && events.length === 0 && !app.pm.busy;
  const hasLiveText = Object.keys(streaming).length > 0;

  return (
    <div className="desk">
      <div className="desk-top">
        <h1>Your project manager</h1>
        <span className="faint truncate" style={{ fontSize: 12.5 }}>
          {pmRuntime?.label}
          {app.settings.pm.model ? ` · ${app.settings.pm.model}` : ''}
        </span>
        <span className="grow" />
        <button className="btn ghost sm only-narrow" onClick={() => setRailOpen(!railOpen)}>
          <PanelRight size={14} />
          Crew{live ? ` · ${live}` : ''}
        </button>
      </div>

      {app.demo && (
        <div className="banner">
          <FlaskConical size={15} />
          <span className="grow">
            You are on the <b>demo crew</b>: the agents are simulated so you can look around. Nothing real gets done yet.
          </span>
          <a href="#/settings" className="btn sm">
            Connect an account
          </a>
        </div>
      )}

      <div className="desk-scroll" ref={scroller}>
        {empty ? (
          <div className="hero">
            <h2>
              {greeting(app.settings.userName)} <em>What are we working on?</em>
            </h2>
            <p>
              Tell me about anything on your plate. I will break it into tasks, hand them to the crew, keep track of every
              thread, and come back to you when there is something worth your attention.
            </p>
            <div className="starters">
              {STARTERS.map((s) => (
                <button key={s.title} className="starter" onClick={() => void send(s.text)}>
                  <b>{s.title}</b>
                  {s.text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="thread">
            <Transcript events={events} streaming={streaming} variant="pm" busy={app.pm.busy} />
            {app.pm.busy && !hasLiveText && (
              <div className="working">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                Working on it
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            autoFocus
            placeholder={empty ? 'Describe a project, a task, or a question…' : 'Message your project manager…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-foot">
            <span className="grow">
              {app.pm.busy
                ? 'You can keep typing — new messages are folded in as the manager works.'
                : 'Enter to send · Shift + Enter for a new line'}
            </span>
            {app.pm.busy && !draft.trim() ? (
              <button className="send stop" title="Stop" aria-label="Stop" onClick={() => void attempt(() => api.stopPm())}>
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button className="send" title="Send" aria-label="Send" disabled={!draft.trim()} onClick={() => void send()}>
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

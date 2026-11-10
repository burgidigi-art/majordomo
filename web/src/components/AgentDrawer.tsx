import { ArrowUp, RotateCcw, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { compact, duration, isLive, money, taskElapsed, useNow } from '../lib.ts';
import { useStore, type StreamingBlock } from '../store.ts';
import { useStickToBottom } from './Desk.tsx';
import { Transcript } from './Transcript.tsx';
import { attempt, StatusPill, TaskAvatar } from './ui.tsx';

const NO_EVENTS: AgentEvent[] = [];
const NO_STREAM: Record<string, StreamingBlock> = {};

/** Slide-over showing one agent's full transcript, live. */
export function AgentDrawer() {
  const id = useStore((s) => s.openAgent);
  const close = () => useStore.getState().setOpenAgent(null);
  const task = useStore((s) => s.app?.tasks.find((t) => t.id === id));
  const project = useStore((s) => s.app?.projects.find((p) => p.id === task?.projectId));
  const parent = useStore((s) => s.app?.tasks.find((t) => t.id === task?.parentId));
  const allTasks = useStore((s) => s.app?.tasks);
  const helpers = useMemo(() => (allTasks ?? []).filter((t) => t.parentId === id), [allTasks, id]);
  const runtime = useStore((s) => s.app?.runtimes.find((r) => r.id === task?.runtime));
  const events = useStore((s) => (id ? s.events[id] : undefined) ?? NO_EVENTS);
  const streaming = useStore((s) => (id ? s.streaming[id] : undefined) ?? NO_STREAM);

  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const live = !!task && isLive(task);
  const now = useNow(live);
  const streamLen = Object.values(streaming).reduce((n, b) => n + b.text.length, 0);
  useStickToBottom(scroller, `${id}:${events.length}:${streamLen}`);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  if (!id || !task) return null;

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await attempt(() => api.messageTask(task.id, text));
  };
  const canMessage = task.status !== 'cancelled';
  const canRetry = ['failed', 'interrupted', 'cancelled'].includes(task.status);
  const canCancel = isLive(task) || task.status === 'queued';

  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-label={task.title}>
        <div className="drawer-head">
          <div className="row">
            <TaskAvatar task={task} />
            <div className="grow">
              <div className="faint" style={{ fontSize: 12 }}>
                <span className="mono">{task.id}</span>
                {project && (
                  <>
                    {' · '}
                    <a href={`#/projects/${project.id}`} onClick={close}>
                      {project.name}
                    </a>
                  </>
                )}
                {parent && (
                  <>
                    {' · helper for '}
                    <button className="more" onClick={() => useStore.getState().setOpenAgent(parent.id)}>
                      {parent.id}
                    </button>
                  </>
                )}
              </div>
            </div>
            <StatusPill status={task.status} />
            {canCancel && (
              <button className="btn sm" onClick={() => void attempt(() => api.cancelTask(task.id))}>
                <Square size={11} fill="currentColor" /> Stop
              </button>
            )}
            {canRetry && (
              <button className="btn sm" onClick={() => void attempt(() => api.retryTask(task.id))}>
                <RotateCcw size={13} /> Retry
              </button>
            )}
            <button className="icon-btn" aria-label="Close" onClick={close}>
              <X size={17} />
            </button>
          </div>
          <h2 className="drawer-title">{task.title}</h2>
          <div className="facts">
            <span>
              <b>Crew</b>
              {task.crewName}
            </span>
            <span>
              <b>Runs on</b>
              {runtime?.label ?? task.runtime}
              {task.model ? ` · ${task.model}` : ''}
            </span>
            {task.startedAt && (
              <span className="tnum">
                <b>Time</b>
                {duration(taskElapsed(task, now))}
              </span>
            )}
            <span className="tnum">
              <b>Tokens</b>
              {compact(task.tokensIn)} in · {compact(task.tokensOut)} out
            </span>
            <span className="tnum">
              <b>Cost</b>
              {task.costIncluded ? 'included in plan' : task.costUsd > 0 ? `≈ ${money(task.costUsd)}` : '—'}
            </span>
            {task.attempt > 1 && (
              <span>
                <b>Attempt</b>
                {task.attempt}
              </span>
            )}
          </div>
          {helpers.length > 0 && (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className="label">Helpers</span>
              {helpers.map((h) => (
                <button key={h.id} className="pill" onClick={() => useStore.getState().setOpenAgent(h.id)}>
                  <span className={`dot`} style={{ color: `var(--${h.status === 'done' ? 'ok' : h.status === 'running' ? 'accent' : 'text-3'})` }} />
                  {h.id} · {h.title.slice(0, 32)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="drawer-scroll" ref={scroller}>
          <div className="drawer-thread">
            {events.length === 0 && task.status === 'queued' ? (
              <>
                <div className="msg-brief">
                  <div className="who">Brief</div>
                  <div className="body">{task.brief}</div>
                </div>
                <div className="sys-line">{task.statusLine || 'Waiting to start'}</div>
              </>
            ) : (
              <Transcript events={events} streaming={streaming} variant="agent" busy={live} />
            )}
            {task.status === 'running' && Object.keys(streaming).length === 0 && (
              <div className="working">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                {task.statusLine || 'Working'}
              </div>
            )}
          </div>
        </div>

        {canMessage && (
          <div className="drawer-foot">
            <textarea
              className="textarea"
              style={{ minHeight: 38, height: 38, resize: 'none' }}
              placeholder={
                task.status === 'waiting'
                  ? 'Answer this agent’s question directly…'
                  : live
                    ? 'Steer this agent — it reads your note at its next step…'
                    : 'Ask this agent for a follow-up — it still has its context…'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="send" aria-label="Send to agent" disabled={!draft.trim()} onClick={() => void send()}>
              <ArrowUp size={17} />
            </button>
          </div>
        )}
      </aside>
    </>
  );
}

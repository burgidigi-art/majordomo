import {
  AlertTriangle,
  Bell,
  Check,
  ChevronRight,
  FileText,
  FolderPlus,
  Globe,
  HelpCircle,
  ListChecks,
  Loader2,
  MessageSquare,
  NotebookPen,
  PencilLine,
  RotateCcw,
  Search,
  Sparkles,
  SquareTerminal,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { AgentEvent } from '../../../shared/types.ts';
import { toolName } from '../lib.ts';
import type { StreamingBlock } from '../store.ts';
import { Markdown } from './ui.tsx';

interface Step {
  id: string;
  name: string;
  input: any;
  output?: string;
  isError?: boolean;
  done: boolean;
}

type Item =
  | { kind: 'user'; key: string; from: string; text: string }
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'steps'; key: string; steps: Step[] }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'error'; key: string; text: string };

/** Fold the flat event log into what a reader wants to see: messages, and runs of tool steps. */
function group(events: AgentEvent[], closed: boolean): Item[] {
  const items: Item[] = [];
  const byId = new Map<string, Step>();
  for (const e of events) {
    const key = `e${e.id}`;
    switch (e.type) {
      case 'user':
        items.push({ kind: 'user', key, from: e.data.from ?? 'user', text: String(e.data.text ?? '') });
        break;
      case 'text': {
        const text = String(e.data.text ?? '').trim();
        // The PM answers routine events with a marker meaning "nothing to tell the user".
        if (!text || /^<quiet\s*\/>$/.test(text)) break;
        items.push({ kind: 'text', key, text });
        break;
      }
      case 'thinking':
        if (String(e.data.text ?? '').trim()) items.push({ kind: 'thinking', key, text: e.data.text });
        break;
      case 'tool_call': {
        const step: Step = { id: e.data.id, name: toolName(String(e.data.name ?? 'tool')), input: e.data.input ?? {}, done: false };
        byId.set(step.id, step);
        const last = items.at(-1);
        if (last?.kind === 'steps') last.steps.push(step);
        else items.push({ kind: 'steps', key, steps: [step] });
        break;
      }
      case 'tool_result': {
        const step = byId.get(e.data.id);
        if (step) {
          step.output = String(e.data.output ?? '');
          step.isError = !!e.data.isError;
          step.done = true;
        }
        break;
      }
      case 'notice':
        items.push({ kind: 'notice', key, text: String(e.data.text ?? '') });
        break;
      case 'error':
        items.push({ kind: 'error', key, text: String(e.data.message ?? 'Something went wrong') });
        break;
      default:
        break;
    }
  }
  // Once the agent has stopped, a step with no result will never get one.
  if (closed) for (const s of byId.values()) s.done = true;
  return items;
}

// ---------- tool steps ----------

const short = (v: unknown, n = 90) => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};

function describe(step: Step): { icon: LucideIcon; label: string; arg: string } {
  const i = step.input ?? {};
  switch (step.name) {
    // what the PM does
    case 'create_project':
      return { icon: FolderPlus, label: 'Started project', arg: i.name ?? '' };
    case 'update_project':
      return { icon: NotebookPen, label: i.status ? `Marked project ${i.status}` : 'Updated project notes', arg: i.project ?? '' };
    case 'create_tasks':
      return {
        icon: ListChecks,
        label: `Assigned ${i.tasks?.length ?? 0} task${i.tasks?.length === 1 ? '' : 's'}`,
        arg: (i.tasks ?? []).map((t: any) => t.title).join(' · '),
      };
    case 'get_task':
      return { icon: Search, label: 'Checked on', arg: i.task ?? '' };
    case 'get_project':
    case 'list_projects':
      return { icon: Search, label: 'Reviewed projects', arg: i.project ?? '' };
    case 'message_agent':
      return { icon: MessageSquare, label: `Messaged ${i.task ?? 'agent'}`, arg: i.message ?? '' };
    case 'cancel_task':
      return { icon: X, label: `Cancelled ${i.task ?? ''}`, arg: i.reason ?? '' };
    case 'retry_task':
      return { icon: RotateCcw, label: `Retried ${i.task ?? ''}`, arg: i.note ?? '' };
    case 'remember':
      return { icon: Sparkles, label: 'Remembered', arg: i.fact ?? '' };
    case 'forget':
      return { icon: Sparkles, label: 'Forgot', arg: i.memory_id ?? '' };
    case 'set_reminder':
      return { icon: Bell, label: 'Set a reminder', arg: i.note ?? '' };
    case 'cancel_reminder':
      return { icon: Bell, label: 'Cancelled reminder', arg: i.reminder_id ?? '' };
    case 'list_crew':
      return { icon: Users, label: 'Looked at the crew', arg: '' };
    // what workers do
    case 'bash':
    case 'Bash':
    case 'shell':
    case 'run_shell_command':
      return { icon: SquareTerminal, label: 'Ran', arg: i.command ?? '' };
    case 'read_file':
    case 'Read':
      return { icon: FileText, label: 'Read', arg: i.path ?? i.file_path ?? '' };
    case 'write_file':
    case 'Write':
      return { icon: PencilLine, label: 'Wrote', arg: i.path ?? i.file_path ?? '' };
    case 'edit_file':
    case 'Edit':
    case 'replace':
    case 'edit_files':
      return { icon: PencilLine, label: 'Edited', arg: i.path ?? i.file_path ?? short(i.changes) };
    case 'list_files':
    case 'Glob':
    case 'list_directory':
      return { icon: Search, label: 'Listed files', arg: i.path ?? i.pattern ?? '' };
    case 'search_files':
    case 'Grep':
      return { icon: Search, label: 'Searched for', arg: i.pattern ?? '' };
    case 'web_fetch':
    case 'WebFetch':
      return { icon: Globe, label: 'Fetched', arg: i.url ?? '' };
    case 'web_search':
    case 'WebSearch':
    case 'google_web_search':
      return { icon: Globe, label: 'Searched the web', arg: i.query ?? '' };
    case 'report_progress':
      return { icon: Check, label: 'Progress', arg: i.note ?? '' };
    case 'ask_manager':
      return { icon: HelpCircle, label: 'Asked the manager', arg: i.question ?? '' };
    case 'delegate':
      return {
        icon: Users,
        label: `Brought in ${i.tasks?.length ?? 0} helper${i.tasks?.length === 1 ? '' : 's'}`,
        arg: (i.tasks ?? []).map((t: any) => t.title).join(' · '),
      };
    default:
      return { icon: Wrench, label: step.name, arg: short(i, 120) };
  }
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(false);
  const d = describe(step);
  const Icon = d.icon;
  const inputText = typeof step.input?.command === 'string' ? step.input.command : JSON.stringify(step.input, null, 2);
  return (
    <div className="step">
      <button className={`step-head${step.isError ? ' err' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="step-icon">
          <Icon size={14} />
        </span>
        <span className="step-label">{d.label}</span>
        <span className="step-arg truncate mono">{short(d.arg, 140)}</span>
        <span className="step-state">
          {!step.done ? (
            <Loader2 size={13} className="spin" />
          ) : step.isError ? (
            <AlertTriangle size={13} />
          ) : (
            <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }} />
          )}
        </span>
      </button>
      {open && (
        <div className="step-body">
          {inputText && inputText !== '{}' && <pre className="code">{inputText}</pre>}
          {step.output !== undefined && <pre className={`code${step.isError ? ' err' : ''}`}>{step.output || '(no output)'}</pre>}
        </div>
      )}
    </div>
  );
}

// ---------- messages ----------

function Brief({ who, text }: { who: string; text: string }) {
  const long = text.length > 420 || text.split('\n').length > 7;
  const [open, setOpen] = useState(false);
  return (
    <div className={`msg-brief${long && !open ? ' clamped' : ''}`}>
      <div className="who">{who}</div>
      <div className="body">{text}</div>
      {long && (
        <button className="more" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  return (
    <details className="thinking">
      <summary>
        <Sparkles size={12} />
        <span className={live ? 'shimmer' : ''}>{live ? 'Thinking…' : 'Thought it through'}</span>
      </summary>
      <div className="body">{text}</div>
    </details>
  );
}

export const Transcript = memo(function Transcript({
  events,
  streaming,
  variant,
  busy,
}: {
  events: AgentEvent[];
  streaming?: Record<string, StreamingBlock>;
  /** 'pm' is the user's own conversation; 'agent' is a worker's log read over its shoulder. */
  variant: 'pm' | 'agent';
  busy: boolean;
}) {
  const items = useMemo(() => group(events, !busy), [events, busy]);
  const live = Object.entries(streaming ?? {});
  const textClass = variant === 'pm' ? 'msg-pm' : 'msg-agent';

  return (
    <>
      {items.map((it) => {
        switch (it.kind) {
          case 'user':
            if (it.from === 'user' && variant === 'pm') {
              return (
                <div key={it.key} className="msg-user">
                  {it.text}
                </div>
              );
            }
            if (it.from === 'system') {
              return (
                <div key={it.key} className="sys-events">
                  {it.text.split('\n').map((line, i) => (
                    <div key={i} className="ev">
                      <span>{line}</span>
                    </div>
                  ))}
                </div>
              );
            }
            return <Brief key={it.key} who={it.from === 'user' ? 'From you' : 'From the project manager'} text={it.text} />;
          case 'text':
            return <Markdown key={it.key} text={it.text} className={textClass} />;
          case 'thinking':
            return <Thinking key={it.key} text={it.text} />;
          case 'steps':
            return (
              <div key={it.key} className="steps">
                {it.steps.map((s) => (
                  <StepRow key={s.id} step={s} />
                ))}
              </div>
            );
          case 'notice':
            return (
              <div key={it.key} className="sys-line">
                {it.text}
              </div>
            );
          case 'error':
            return (
              <div key={it.key} className="callout bad">
                {it.text}
              </div>
            );
        }
      })}
      {live.map(([key, block]) =>
        block.type === 'thinking' ? (
          <Thinking key={key} text={block.text} live />
        ) : /^<q/.test(block.text.trim()) ? null : (
          <div key={key} className={`${textClass} caret`}>
            <Markdown text={block.text} />
          </div>
        ),
      )}
    </>
  );
});

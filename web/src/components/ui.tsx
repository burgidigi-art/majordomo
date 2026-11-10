import { memo, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RuntimeInfo, Task, TaskStatus } from '../../../shared/types.ts';
import { familyOf, STATUS_LABEL } from '../lib.ts';
import { useStore } from '../store.ts';

export const Markdown = memo(function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export function Avatar({
  name,
  family,
  live,
  small,
}: {
  name: string;
  family: RuntimeInfo['family'];
  live?: boolean;
  small?: boolean;
}) {
  return (
    <span className={`avatar fam-${family}${live ? ' live' : ''}${small ? ' sm' : ''}`} aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function TaskAvatar({ task, small }: { task: Task; small?: boolean }) {
  const runtimes = useStore((s) => s.app?.runtimes ?? []);
  return <Avatar name={task.crewName} family={familyOf(runtimes, task.runtime)} live={task.status === 'running'} small={small} />;
}

export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span className={`pill ${status}`}>
      <span className="dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

// ---------- toasts ----------

let pushToast: (t: { text: string; bad?: boolean }) => void = () => {};

export function toast(text: string, bad = false): void {
  pushToast({ text, bad });
}

/** Run an action and surface its failure, instead of letting a rejected promise vanish. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const out = await fn();
    if (success) toast(success);
    return out;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
    return undefined;
  }
}

export function Toaster() {
  const [item, setItem] = useState<{ text: string; bad?: boolean; key: number } | null>(null);
  useEffect(() => {
    pushToast = (t) => setItem({ ...t, key: Date.now() });
    return () => {
      pushToast = () => {};
    };
  }, []);
  useEffect(() => {
    if (!item) return;
    const timer = setTimeout(() => setItem(null), item.bad ? 7000 : 2600);
    return () => clearTimeout(timer);
  }, [item]);
  if (!item) return null;
  return (
    <div key={item.key} className={`toast${item.bad ? ' bad' : ''}`} role="status">
      {item.text}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

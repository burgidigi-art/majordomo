import { Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { useStore } from '../store.ts';
import { attempt } from './ui.tsx';

/** What the manager carries between conversations: facts about you, and reminders it set for itself. */
export function Memory() {
  const app = useStore((s) => s.app)!;
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 860 }}>
        <div className="page-head">
          <div className="grow">
            <h1 className="page-title">Memory</h1>
            <p className="page-sub">
              Lasting facts about you and how you like things done. The manager saves these itself as you talk; remove any that are wrong or out of
              date.
            </p>
          </div>
        </div>
        <section className="section">
          <h2>What it remembers</h2>
          <p>{app.memory.length ? `${app.memory.length} saved` : 'Nothing saved yet.'}</p>
          <div className="card">
            {app.memory.length === 0 ? (
              <div className="list-row hint">Nothing yet. Tell the manager a preference and it will keep it.</div>
            ) : (
              app.memory.map((m) => (
                <div key={m.id} className="list-row">
                  <span className="chip">{m.id}</span>
                  <span className="grow">{m.text}</span>
                  <button className="icon-btn" aria-label="Forget" onClick={() => void attempt(() => api.forget(m.id))}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
        <section className="section">
          <h2>Reminders</h2>
          <p>Times the manager has asked to be woken up, to check on something or follow up with you.</p>
          {app.reminders.length === 0 ? (
            <div className="card">
              <div className="list-row hint">No reminders set. Ask the manager to check back on something and it will appear here.</div>
            </div>
          ) : (
            <div className="card">
              {app.reminders.map((r) => (
                <div key={r.id} className="list-row">
                  <span className="chip">{r.id}</span>
                  <span className="grow">
                    {r.note}
                    <div className="hint">
                      {new Date(r.dueAt).toLocaleString()}
                      {r.repeatMinutes ? ` · repeats every ${r.repeatMinutes} min` : ''}
                    </div>
                  </span>
                  <button className="icon-btn" aria-label="Cancel reminder" onClick={() => void attempt(() => api.cancelReminder(r.id))}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

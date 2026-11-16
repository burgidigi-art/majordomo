import { ChevronDown, ChevronRight, Plug, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PluginServer } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { attempt, Empty, toast } from './ui.tsx';

const STATUS: Record<PluginServer['status'], { label: string; tone: string }> = {
  running: { label: 'Running', tone: 'ok' },
  idle: { label: 'Starts when needed', tone: 'idle' },
  error: { label: 'Could not start', tone: 'bad' },
  'needs-sign-in': { label: 'Needs sign-in', tone: 'warn' },
  unsupported: { label: 'Not supported', tone: 'bad' },
};

function AddPlugin({ onAdded }: { onAdded: (list: PluginServer[]) => void }) {
  const [kind, setKind] = useState<'command' | 'url'>('command');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [header, setHeader] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const headers: Record<string, string> = header.trim() ? { Authorization: header.trim() } : {};
    const body = kind === 'url' ? { name, url: value, headers } : { name, command: value };
    const res = await attempt(() => api.addPlugin(body), 'Added');
    setBusy(false);
    if (res) {
      onAdded(res.plugins);
      setName('');
      setValue('');
      setHeader('');
    }
  };
  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Add a plugin</h3>
      <div className="hint" style={{ marginTop: -4 }}>
        A plugin’s instructions give either a command that starts it on this computer (often <span className="mono">npx …</span> or{' '}
        <span className="mono">uvx …</span>) or an address. Plugins set up in Claude Code, Claude Desktop, Codex or Hermes are found on their own.
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input className="input" style={{ width: 170 }} value={name} placeholder="Name, e.g. GitHub" aria-label="Plugin name" onChange={(e) => setName(e.target.value)} />
        <select className="select" style={{ width: 175 }} value={kind} aria-label="How it connects" onChange={(e) => setKind(e.target.value as 'command' | 'url')}>
          <option value="command">Runs a command</option>
          <option value="url">Has an address</option>
        </select>
        <input
          className="input mono grow"
          style={{ minWidth: 240 }}
          value={value}
          spellCheck={false}
          placeholder={kind === 'url' ? 'https://example.com/mcp' : 'npx -y @modelcontextprotocol/server-github'}
          aria-label={kind === 'url' ? 'Address' : 'Command'}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      {kind === 'url' && (
        <input
          className="input mono"
          value={header}
          spellCheck={false}
          placeholder="Authorization header, if it needs one (e.g. Bearer …) — optional"
          aria-label="Authorization header"
          onChange={(e) => setHeader(e.target.value)}
        />
      )}
      <div className="row">
        <button className="btn primary" disabled={busy || !name.trim() || !value.trim()} onClick={() => void add()}>
          <Plug size={14} /> Add
        </button>
      </div>
    </div>
  );
}

/**
 * Plugin tools, on the Settings page: every plugin found or added, whether the crew may use it, and
 * whether it is working. Test connects to it right away and lists its tools.
 */
export function Plugins() {
  const [list, setList] = useState<PluginServer[] | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');

  const load = async (rescan = false) => {
    const res = await attempt(() => api.plugins(rescan));
    if (res) setList(res.plugins);
  };
  useEffect(() => void load(), []);

  const groups = useMemo(() => {
    const out: { label: string; items: PluginServer[] }[] = [];
    for (const p of list ?? []) {
      let g = out.find((x) => x.label === p.sourceLabel);
      if (!g) out.push((g = { label: p.sourceLabel, items: [] }));
      g.items.push(p);
    }
    return out;
  }, [list]);

  if (!list) return <div className="faint">Looking for plugins…</div>;

  const test = async (p: PluginServer) => {
    setBusy(p.id);
    const res = await attempt(() => api.testPlugin(p.id));
    setBusy('');
    if (!res) return;
    setList(res.plugins);
    if (res.ok) {
      toast(`${p.name} works: ${res.tools?.length ?? 0} tools.`);
      setOpen({ ...open, [p.id]: true });
    } else toast(res.error ?? 'It could not start.', true);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <span className="faint grow" style={{ fontSize: 12.5 }}>
          {list.filter((p) => p.enabled).length} of {list.length} on
        </span>
        <button className="btn sm" onClick={() => void load(true)} title="Look again for plugins set up in other tools">
          <RefreshCw size={13} /> Rescan
        </button>
      </div>

      {groups.length === 0 ? (
        <Empty title="No plugins yet">Plugins you set up in Claude Code, Claude Desktop, Codex or Hermes show up here on their own, or add one below.</Empty>
      ) : (
        groups.map((g) => (
          <div key={g.label} className="card skill-group">
            <div className="skill-group-head">
              <span className="skill-group-name">{g.label}</span>
            </div>
            {g.items.map((p) => {
              const st = STATUS[p.status];
              const expanded = !!open[p.id];
              return (
                <div key={p.id} className="list-row skill-row plugin-row">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    disabled={p.status === 'unsupported'}
                    aria-label={`Let the crew use ${p.name}`}
                    onChange={(e) => void attempt(() => api.setPlugins([p.id], e.target.checked)).then((r) => r && setList(r.plugins))}
                  />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="plugin-title">
                      <span className="skill-name">{p.name}</span>
                      <span className={`plugin-status ${st.tone}`}>{st.label}</span>
                    </span>
                    <span className="skill-path mono" title={p.summary}>
                      {p.summary}
                    </span>
                    {p.error && p.status !== 'idle' && p.status !== 'running' && <span className="plugin-error">{p.error}</span>}
                    {p.tools.length > 0 && (
                      <button className="skill-toggle plugin-tools-toggle" onClick={() => setOpen({ ...open, [p.id]: !expanded })} aria-expanded={expanded}>
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {p.tools.length} tools
                      </button>
                    )}
                    {expanded && (
                      <span className="plugin-tools">
                        {p.tools.map((t) => (
                          <span key={t.name} className="plugin-tool">
                            <b className="mono">{t.name}</b> {t.description}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="row" style={{ flex: 'none', gap: 6 }}>
                    {p.status !== 'unsupported' && (
                      <button className="btn ghost sm" disabled={busy === p.id} onClick={() => void test(p)}>
                        {busy === p.id ? 'Starting…' : 'Test'}
                      </button>
                    )}
                    {p.removable && (
                      <button
                        className="btn ghost sm"
                        aria-label={`Remove ${p.name}`}
                        onClick={() => {
                          if (confirm(`Remove ${p.name}?`)) void attempt(() => api.removePlugin(p.id)).then((r) => r && setList(r.plugins));
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))
      )}

      <AddPlugin onAdded={setList} />
    </div>
  );
}

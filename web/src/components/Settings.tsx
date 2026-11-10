import { Check, Copy, Loader2, Plus, Smartphone, Star, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { CrewProfile, Effort, ModelOption, RuntimeId, RuntimeInfo, Settings as SettingsT, VoiceProvider, VoiceStatus } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useStore } from '../store.ts';
import { attempt, Avatar, toast } from './ui.tsx';

const modelCache = new Map<string, ModelOption[]>();

/** Free-text model field with suggestions pulled live from the account, so nothing is hard-coded. */
function ModelPicker({
  runtime,
  value,
  onChange,
  ready,
}: {
  runtime: RuntimeId;
  value: string;
  onChange: (v: string) => void;
  ready: boolean;
}) {
  const listId = useId();
  const [options, setOptions] = useState<ModelOption[]>(modelCache.get(runtime) ?? []);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  useEffect(() => {
    setOptions(modelCache.get(runtime) ?? []);
    setState('idle');
  }, [runtime]);

  const load = () => {
    if (!ready || modelCache.has(runtime) || state === 'loading') return;
    setState('loading');
    api
      .models(runtime)
      .then((list) => {
        modelCache.set(runtime, list);
        setOptions(list);
        setState('idle');
      })
      .catch(() => setState('error'));
  };

  const cli = options.some((o) => o.id === '');
  return (
    <>
      <input
        className="input mono"
        list={listId}
        value={value}
        placeholder={!ready ? 'Connect this account first' : cli || /code|codex|cli/.test(runtime) ? 'CLI default' : state === 'loading' ? 'Loading models…' : 'Choose or type a model id'}
        onFocus={load}
        onChange={(e) => onChange(e.target.value.trim())}
        spellCheck={false}
        autoComplete="off"
      />
      <datalist id={listId}>
        {options
          .filter((o) => o.id)
          .map((o) => (
            <option key={o.id} value={o.id}>
              {o.label && o.label !== o.id ? o.label : undefined}
            </option>
          ))}
      </datalist>
      {state === 'error' && <span className="hint">Could not load the model list — type a model id.</span>}
    </>
  );
}

function EffortSelect({ value, onChange }: { value: Effort | null | undefined; onChange: (v: Effort | null) => void }) {
  return (
    <select className="select" value={value ?? ''} onChange={(e) => onChange((e.target.value || null) as Effort | null)} aria-label="Effort">
      <option value="">Default effort</option>
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
      <option value="xhigh">Extra high</option>
      <option value="max">Max</option>
    </select>
  );
}

// ---------- accounts ----------

function AccountCard({ rt, isPm }: { rt: RuntimeInfo; isPm: boolean }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'adopt'>('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [model, setModel] = useState('');

  const save = async () => {
    setBusy('save');
    const ok = await attempt(() => api.saveKey(rt.id, key));
    setBusy('');
    if (ok) {
      setKey('');
      modelCache.delete(rt.id);
      toast('Key saved');
    }
  };
  const test = async () => {
    setBusy('test');
    setResult(null);
    const r = await attempt(() => api.test(rt.id));
    setBusy('');
    if (r) setResult(r);
  };
  const adopt = async () => {
    setBusy('adopt');
    const ok = await attempt(() => api.adopt(rt.id, model));
    setBusy('');
    if (ok) {
      setAdopting(false);
      toast(`${rt.label} now runs your manager and crew`);
    }
  };

  return (
    <div className="card acct">
      <div className="acct-top">
        <Avatar name={rt.label} family={rt.family} />
        <div className="grow">
          <h3>{rt.label}</h3>
          <div className="auth">{rt.auth}</div>
        </div>
        <span className={`pill ${rt.ready ? 'done' : ''}`}>
          <span className="dot" />
          {rt.ready ? (isPm ? 'Runs your manager' : 'Ready') : 'Not connected'}
        </span>
      </div>

      <div className="detail">{rt.ready ? rt.detail : rt.setupHint}</div>
      {rt.experimental && <div className="hint">{rt.experimental}</div>}

      {rt.kind === 'api' && rt.id !== 'demo' && (
        <div className="row">
          <input
            className="input mono"
            type="password"
            value={key}
            placeholder={rt.ready ? 'Replace key…' : 'Paste API key'}
            aria-label={`${rt.label} API key`}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && key.trim() && void save()}
          />
          <button className="btn" disabled={!key.trim() || busy === 'save'} onClick={() => void save()}>
            Save
          </button>
        </div>
      )}

      {rt.id !== 'demo' && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={busy === 'test' || (rt.kind === 'api' && !rt.ready)} onClick={() => void test()}>
            {busy === 'test' ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
            {rt.kind === 'cli' ? 'Check sign-in' : 'Test'}
          </button>
          {rt.ready && !isPm && (
            <button className="btn sm" onClick={() => setAdopting((v) => !v)}>
              Use for manager & crew
            </button>
          )}
          {rt.keySource === 'saved' && (
            <button className="btn ghost sm danger" onClick={() => void attempt(() => api.removeKey(rt.id), 'Key removed')}>
              Remove key
            </button>
          )}
        </div>
      )}

      {adopting && (
        <div className="field">
          <label>Model</label>
          <ModelPicker runtime={rt.id} value={model} onChange={setModel} ready={rt.ready} />
          <div className="row">
            <button className="btn primary sm" disabled={busy === 'adopt'} onClick={() => void adopt()}>
              Make this my manager
            </button>
            <span className="hint">Starts a fresh manager conversation on this account.</span>
          </div>
        </div>
      )}

      {result && <div className={`msg ${result.ok ? 'ok' : 'bad'}`}>{result.message}</div>}
    </div>
  );
}

// ---------- phone ----------

function CopyLine({ text, href }: { text: string; href?: string }) {
  const copy = () => void navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy — select it by hand', true));
  return (
    <div className="copy-line">
      {href ? (
        <a className="mono" href={href} target="_blank" rel="noreferrer noopener">
          {text}
        </a>
      ) : (
        <span className="mono">{text}</span>
      )}
      <button className="icon-btn" aria-label="Copy" title="Copy" onClick={copy}>
        <Copy size={14} />
      </button>
    </div>
  );
}

const VOICE_CHOICES: [VoiceProvider, string][] = [
  ['auto', 'Automatic'],
  ['openai', 'OpenAI'],
  ['gemini', 'Gemini'],
  ['command', 'A command on this computer'],
  ['off', 'Off'],
];

function VoiceNotes({ voice }: { voice: VoiceStatus }) {
  const [draft, setDraft] = useState({ provider: voice.provider, model: voice.model, command: voice.command });
  useEffect(() => setDraft({ provider: voice.provider, model: voice.model, command: voice.command }), [voice.provider, voice.model, voice.command]);
  const dirty = draft.provider !== voice.provider || draft.model !== voice.model || draft.command !== voice.command;
  const save = (next = draft) => void attempt(() => api.saveTelegram({ voice: next }));
  const cloud = draft.provider === 'openai' || draft.provider === 'gemini';

  return (
    <div className="field">
      <label htmlFor="voice-provider">Voice notes</label>
      <span className="hint">
        Send a voice note and it is transcribed, shown back to you as “Heard: …”, then handled like a typed message. Claude cannot transcribe
        audio, so this needs an OpenAI or Gemini key, or a transcriber of your own.
      </span>
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <select
          id="voice-provider"
          className="select"
          style={{ width: 230 }}
          value={draft.provider}
          onChange={(e) => {
            // Switching service takes effect at once; a model id belongs to one provider, so it is cleared.
            const next = { ...draft, provider: e.target.value as VoiceProvider, model: '' };
            setDraft(next);
            save(next);
          }}
        >
          {VOICE_CHOICES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {cloud && (
          <input
            className="input mono grow"
            style={{ minWidth: 200 }}
            value={draft.model}
            placeholder="Model — leave empty for the default"
            aria-label="Transcription model"
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
          />
        )}
        {(draft.provider === 'command' || (draft.provider === 'auto' && draft.command)) && (
          <input
            className="input mono grow"
            style={{ minWidth: 260 }}
            value={draft.command}
            placeholder="my-transcriber {file}"
            aria-label="Transcription command"
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && dirty && save()}
          />
        )}
        {dirty && (
          <button className="btn primary" onClick={() => save()}>
            Save
          </button>
        )}
      </div>
      {draft.provider === 'command' && (
        <span className="hint">
          Any command that prints the spoken words. <span className="mono">{'{file}'}</span> is replaced with the path of the recording (Ogg/Opus);
          nothing leaves this computer.
        </span>
      )}
      {voice.using ? (
        <span className="hint">
          Transcribed by <b>{voice.using}</b>
          {voice.using.startsWith('A command') ? '.' : ' — the recording is sent to that provider and billed to your key.'}
        </span>
      ) : (
        <span className="hint" style={{ color: voice.provider === 'off' ? undefined : 'var(--attn)' }}>
          {voice.problem}
        </span>
      )}
    </div>
  );
}

function Phone() {
  const tg = useStore((s) => s.app!.telegram);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);

  const connect = async () => {
    setBusy(true);
    const ok = await attempt(() => api.saveTelegram({ token }));
    setBusy(false);
    if (ok) setToken('');
  };
  const disconnect = () => {
    if (window.confirm('Disconnect the Telegram bot? Linked chats are forgotten and the token is removed from this computer.')) {
      void attempt(() => api.removeTelegram(), 'Telegram disconnected');
    }
  };

  const link = `https://t.me/${tg.botUsername}?start=${tg.pairCode}`;
  const showLink = tg.connected && (tg.chats.length === 0 || linking);

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="acct-top">
        <span className="avatar fam-gemini">
          <Smartphone size={15} />
        </span>
        <div className="grow">
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Telegram{tg.botUsername ? ` · @${tg.botUsername}` : ''}</h3>
          <div className="hint">
            {!tg.configured
              ? 'Not set up'
              : tg.error
                ? 'Not connected'
                : !tg.connected
                  ? 'Connecting…'
                  : tg.chats.length
                    ? `Linked to ${tg.chats.map((c) => c.name).join(', ')}`
                    : 'Bot connected — now link your phone'}
          </div>
        </div>
        <span className={`pill ${tg.connected && tg.chats.length ? 'done' : tg.error ? 'failed' : ''}`}>
          <span className="dot" />
          {tg.connected && tg.chats.length ? 'Ready' : tg.error ? 'Problem' : tg.connected ? 'Waiting for your phone' : 'Off'}
        </span>
      </div>

      {tg.error && <div className="callout bad">{tg.error}</div>}

      {(!tg.configured || tg.error) && (
        <>
          {!tg.configured && (
            <ol className="steps-list">
              <li>
                In Telegram, open a chat with <b>@BotFather</b> and send <span className="mono">/newbot</span>. Pick any name; this bot is yours alone.
              </li>
              <li>BotFather replies with a token. Paste it here.</li>
            </ol>
          )}
          <div className="row">
            <input
              className="input mono"
              type="password"
              value={token}
              placeholder={tg.configured ? 'Paste a new bot token' : '123456789:AAE…'}
              aria-label="Telegram bot token"
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && token.trim() && void connect()}
            />
            <button className="btn primary" disabled={!token.trim() || busy} onClick={() => void connect()}>
              Connect
            </button>
          </div>
        </>
      )}

      {showLink && (
        <div className="field">
          <label>Link your phone</label>
          <span className="hint">
            Open this link on any device signed in to your Telegram account and press <b>Start</b>. It works once; after that only the linked chat
            can talk to the bot.
          </span>
          <CopyLine text={link} href={link} />
          <span className="hint">
            Or open @{tg.botUsername} and send <span className="mono">/start {tg.pairCode}</span>
          </span>
        </div>
      )}

      {tg.chats.length > 0 && (
        <>
          <div>
            {tg.chats.map((c) => (
              <div key={c.id} className="list-row" style={{ padding: '6px 0', alignItems: 'center' }}>
                <span className="grow">
                  {c.name} <span className="faint mono">· chat {c.id}</span>
                </span>
                <button className="btn ghost sm" onClick={() => void attempt(() => api.unpairChat(c.id), 'Chat unlinked')}>
                  Unlink
                </button>
              </div>
            ))}
          </div>
          <label className="switch">
            <input type="checkbox" checked={tg.notify} onChange={(e) => void attempt(() => api.saveTelegram({ notify: e.target.checked }))} />
            <span>
              Send me updates on my phone
              <div className="hint">
                When on, the manager also messages you when work finishes or needs you, and command approvals arrive with Allow / Decline buttons. When
                off, it only answers what you send from the phone.
              </div>
            </span>
          </label>
          <VoiceNotes voice={tg.voice} />
        </>
      )}

      {tg.configured && (
        <div className="row">
          {tg.connected && tg.chats.length > 0 && !linking && (
            <button className="btn sm" onClick={() => setLinking(true)}>
              Link another chat
            </button>
          )}
          {showLink && (
            <button className="btn ghost sm" onClick={() => void attempt(() => api.newPairCode(), 'New pairing link made; the old one no longer works')}>
              Make a new link
            </button>
          )}
          <span className="grow" />
          <button className="btn ghost sm danger" onClick={disconnect}>
            Disconnect bot
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- page ----------

export function Settings() {
  const app = useStore((s) => s.app)!;
  const [draft, setDraft] = useState<SettingsT>(app.settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(app.settings), [app.settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(app.settings);

  const ready = (id: RuntimeId) => !!app.runtimes.find((r) => r.id === id)?.ready;
  const patch = (p: Partial<SettingsT>) => setDraft((d) => ({ ...d, ...p }));
  const patchCrew = (id: string, p: Partial<CrewProfile>) =>
    setDraft((d) => ({ ...d, crew: d.crew.map((c) => (c.id === id ? { ...c, ...p } : c)) }));

  const addCrew = () => {
    const id = `crew-${Date.now().toString(36)}`;
    const base = draft.crew.find((c) => c.id === draft.defaultCrewId) ?? draft.crew[0];
    setDraft((d) => ({
      ...d,
      crew: [...d.crew, { id, name: 'New member', strengths: '', runtime: base?.runtime ?? draft.pm.runtime, model: base?.model ?? '', effort: null }],
    }));
  };

  const save = async () => {
    setSaving(true);
    await attempt(() => api.saveSettings(draft), 'Settings saved');
    setSaving(false);
  };

  const runtimeOptions = app.runtimes.map((r) => (
    <option key={r.id} value={r.id} disabled={!r.ready}>
      {r.label}
      {r.ready ? '' : ' — not connected'}
    </option>
  ));

  return (
    <div className="page">
      <div className="page-inner" style={{ paddingBottom: 120 }}>
        <div className="page-head">
          <div className="grow">
            <h1 className="page-title">Settings</h1>
            <p className="page-sub">Connect the accounts you already pay for, decide who is on the crew, and set how much freedom agents have.</p>
          </div>
        </div>

        <section className="section">
          <h2>Accounts</h2>
          <p>
            Subscriptions are used through each vendor’s own command-line agent, which holds your login — sign in once in a terminal and
            Majordomo drives it. API keys are billed per token and stay on this computer.
          </p>
          <div className="acct-grid">
            {app.runtimes.map((rt) => (
              <AccountCard key={rt.id} rt={rt} isPm={app.settings.pm.runtime === rt.id} />
            ))}
          </div>
        </section>

        <section className="section">
          <h2>Phone</h2>
          <p>
            Message your manager from Telegram: start projects, ask where things stand, and get told when work is done. The bot runs from this
            computer, so it answers while Majordomo is running here.
          </p>
          <Phone />
        </section>

        <section className="section">
          <h2>Project manager</h2>
          <p>The one agent you talk to. It plans, delegates and reports — pick your most capable model here.</p>
          <div className="card" style={{ padding: 16 }}>
            <div className="grid-3">
              <div className="field">
                <label>Runs on</label>
                <select
                  className="select"
                  value={draft.pm.runtime}
                  onChange={(e) => patch({ pm: { ...draft.pm, runtime: e.target.value as RuntimeId, model: '' } })}
                >
                  {runtimeOptions}
                </select>
              </div>
              <div className="field">
                <label>Model</label>
                <ModelPicker runtime={draft.pm.runtime} value={draft.pm.model} onChange={(model) => patch({ pm: { ...draft.pm, model } })} ready={ready(draft.pm.runtime)} />
              </div>
              <div className="field">
                <label>Effort</label>
                <EffortSelect value={draft.pm.effort} onChange={(effort) => patch({ pm: { ...draft.pm, effort } })} />
              </div>
            </div>
            {draft.pm.runtime !== app.settings.pm.runtime && (
              <div className="hint" style={{ marginTop: 10 }}>
                The manager’s conversation lives with the account that ran it. After switching, it re-reads your projects and memory but not the earlier chat.
              </div>
            )}
          </div>
        </section>

        <section className="section">
          <h2>Crew</h2>
          <p>
            The agents your manager can assign work to. Describe what each is good at — the manager reads this to decide who gets which task. Mix
            accounts freely: a strong model for hard problems, a fast one for legwork.
          </p>
          <div className="card">
            {draft.crew.map((c) => {
              const fam = app.runtimes.find((r) => r.id === c.runtime)?.family ?? 'demo';
              const isDefault = draft.defaultCrewId === c.id;
              return (
                <div key={c.id} className="crew-row">
                  <Avatar name={c.name} family={fam} />
                  <div className="field">
                    <input className="input" value={c.name} aria-label="Name" onChange={(e) => patchCrew(c.id, { name: e.target.value })} />
                    <textarea
                      className="textarea"
                      style={{ minHeight: 54, fontSize: 13 }}
                      value={c.strengths}
                      aria-label="Strengths"
                      placeholder="What is this crew member good at?"
                      onChange={(e) => patchCrew(c.id, { strengths: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <select className="select" value={c.runtime} aria-label="Runs on" onChange={(e) => patchCrew(c.id, { runtime: e.target.value as RuntimeId, model: '' })}>
                      {runtimeOptions}
                    </select>
                    <EffortSelect value={c.effort} onChange={(effort) => patchCrew(c.id, { effort })} />
                  </div>
                  <div className="field">
                    <ModelPicker runtime={c.runtime} value={c.model} onChange={(model) => patchCrew(c.id, { model })} ready={ready(c.runtime)} />
                  </div>
                  <button
                    className={`btn sm ${isDefault ? '' : 'ghost'}`}
                    title="The manager uses the default when it does not pick someone"
                    onClick={() => patch({ defaultCrewId: c.id })}
                  >
                    <Star size={13} fill={isDefault ? 'currentColor' : 'none'} />
                    {isDefault ? 'Default' : 'Set default'}
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Remove ${c.name}`}
                    disabled={draft.crew.length <= 1}
                    onClick={() => setDraft((d) => ({ ...d, crew: d.crew.filter((x) => x.id !== c.id) }))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
            <div className="list-row">
              <button className="btn sm" onClick={addCrew}>
                <Plus size={14} /> Add crew member
              </button>
            </div>
          </div>
        </section>

        <section className="section">
          <h2>How agents work</h2>
          <p>Agents run on this computer, inside each project’s workspace folder.</p>
          <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="grid-3">
              <div className="field">
                <label>What should the manager call you?</label>
                <input className="input" value={draft.userName} onChange={(e) => patch({ userName: e.target.value })} placeholder="Optional" />
              </div>
              <div className="field">
                <label>Agents working at once</label>
                <input className="input" type="number" min={1} max={16} value={draft.maxParallel} onChange={(e) => patch({ maxParallel: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Shell commands</label>
                <select className="select" value={draft.approvalMode} onChange={(e) => patch({ approvalMode: e.target.value as SettingsT['approvalMode'] })}>
                  <option value="auto">Run without asking</option>
                  <option value="ask">Ask me before each command</option>
                </select>
              </div>
            </div>
            <div className="hint">
              {draft.approvalMode === 'auto'
                ? 'Agents on an API key run shell commands freely. File edits are limited to the project workspace, but a shell command can reach anything your user account can — use “ask” if that worries you.'
                : 'Agents on an API key pause and show you each shell command first. CLI agents (Claude Code, Codex, Gemini CLI) cannot ask through this dashboard, so in this mode they are limited to reading and editing files.'}
            </div>
            <div className="grid-3">
              <div className="field">
                <label>Workspace root</label>
                <input className="input mono" value={draft.workspaceRoot} onChange={(e) => patch({ workspaceRoot: e.target.value })} />
              </div>
              <div className="field">
                <label>Summarise history after (tokens)</label>
                <input className="input" type="number" min={20000} step={10000} value={draft.compactAtTokens} onChange={(e) => patch({ compactAtTokens: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Codex CLI sandbox</label>
                <select className="select" value={draft.codexSandbox} onChange={(e) => patch({ codexSandbox: e.target.value as SettingsT['codexSandbox'] })}>
                  <option value="workspace-write">Workspace only (recommended)</option>
                  <option value="danger-full-access">Full access</option>
                </select>
              </div>
            </div>
          </div>
        </section>

        <section className="section">
          <h2>What the manager remembers</h2>
          <p>Lasting facts about you and how you like things done. The manager adds these itself; remove any that are wrong.</p>
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
          {app.reminders.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
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

        <section className="section">
          <h2>Start over</h2>
          <p>Clears the chat with your manager and its working memory of the conversation. Projects, tasks, files and saved memories are kept.</p>
          <button
            className="btn danger"
            onClick={() => {
              if (window.confirm('Clear the conversation with your manager? Projects and files are kept.')) {
                void attempt(() => api.resetPm(), 'Conversation cleared').then(() => useStore.getState().loadEvents('pm', true));
              }
            }}
          >
            Clear the manager conversation
          </button>
        </section>
      </div>

      {dirty && (
        <div className="toast" style={{ display: 'flex', alignItems: 'center', gap: 12, animation: 'none' }}>
          <span>Unsaved changes</span>
          <button className="btn ghost sm" onClick={() => setDraft(app.settings)}>
            Discard
          </button>
          <button className="btn primary sm" disabled={saving} onClick={() => void save()}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

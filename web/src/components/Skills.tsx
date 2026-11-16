import { ChevronDown, ChevronRight, Download, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Skill, SkillRepo } from '../../../shared/types.ts';
import { api, type SkillsPayload } from '../api.ts';
import { ago } from '../lib.ts';
import { attempt, Empty } from './ui.tsx';

/** Well-known collections to start from. Anything else can be pasted in. */
const SUGGESTED = [{ repo: 'anthropics/skills', what: 'Anthropic’s public examples: documents, spreadsheets, slides, design and more' }];

interface Group {
  key: string;
  label: string;
  repo?: SkillRepo;
  skills: Skill[];
}

/**
 * Skills, on the Settings page: the ones already on this computer, grouped by the tool that installed
 * them, and the ones added from repositories. Switched-on skills are offered to every agent on the crew.
 */
export function Skills() {
  const [data, setData] = useState<SkillsPayload | null>(null);
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = async (rescan = false) => {
    const next = await attempt(() => api.skills(rescan));
    if (next) setData(next);
  };
  useEffect(() => void load(), []);

  const run = async (label: string, fn: () => Promise<SkillsPayload>, success?: string) => {
    setBusy(label);
    const next = await attempt(fn, success);
    if (next) setData(next);
    setBusy('');
  };

  const groups = useMemo<Group[]>(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const match = (s: Skill) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
    const out: Group[] = [];
    for (const s of data.skills) {
      const key = s.repo ? `repo:${s.repo}` : s.source;
      let g = out.find((x) => x.key === key);
      if (!g) out.push((g = { key, label: s.sourceLabel, repo: data.repos.find((r) => r.id === s.repo), skills: [] }));
      if (match(s)) g.skills.push(s);
    }
    return out.filter((g) => g.skills.length || !q);
  }, [data, query]);

  if (!data) return <div className="faint">Looking for skills…</div>;
  const total = data.skills.length;
  const on = data.skills.filter((s) => s.enabled).length;

  const addRepo = (value = repo) => {
    if (!value.trim()) return;
    void run('add', () => api.addSkillRepo(value.trim()), 'Added. Its skills are listed below, switched off until you turn them on.').then(() => setRepo(''));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Add skills from a repository</h3>
        <div className="hint" style={{ marginTop: -4 }}>
          Paste a GitHub repository (owner/name or its address). Its skills are downloaded to this computer and listed below,{' '}
          <b>switched off</b>: they are instructions written by someone else, which your agents will follow, so turn on only the ones you trust.
        </div>
        <div className="row">
          <input
            className="input grow"
            value={repo}
            placeholder="owner/repository or https://github.com/…"
            aria-label="Repository"
            spellCheck={false}
            onChange={(e) => setRepo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addRepo()}
          />
          <button className="btn primary" disabled={!repo.trim() || !!busy} onClick={() => addRepo()}>
            <Download size={14} /> {busy === 'add' ? 'Downloading…' : 'Add'}
          </button>
        </div>
        {SUGGESTED.filter((s) => !data.repos.some((r) => r.name === s.repo)).map((s) => (
          <div key={s.repo} className="hint">
            Try{' '}
            <button className="link-btn" disabled={!!busy} onClick={() => addRepo(s.repo)}>
              {s.repo}
            </button>{' '}
            — {s.what}.
          </div>
        ))}
      </div>

      <div className="row" style={{ alignItems: 'center' }}>
        <div className="skill-search grow">
          <Search size={14} />
          <input className="input" value={query} placeholder="Search skills" aria-label="Search skills" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="faint" style={{ fontSize: 12.5 }}>
          {on} of {total} on
        </span>
        <button className="btn sm" disabled={!!busy} onClick={() => void run('rescan', () => api.skills(true))} title="Look again for skills installed by other tools">
          <RefreshCw size={13} /> Rescan
        </button>
      </div>

      {groups.length === 0 ? (
        <Empty title={query ? 'No skills match' : 'No skills yet'}>
          {query
            ? 'Try another word.'
            : `Skills installed for Claude Code, Codex or Hermes on this computer show up here on their own. You can also add a repository above, or put your own skill folders in ${data.ownFolder}.`}
        </Empty>
      ) : (
        groups.map((g) => {
          const ids = g.skills.map((s) => s.id);
          const groupOn = g.skills.filter((s) => s.enabled).length;
          const expanded = open[g.key] ?? (!!query || g.skills.length <= 6);
          return (
            <div key={g.key} className="card skill-group">
              <div className="skill-group-head">
                <button className="skill-toggle" onClick={() => setOpen({ ...open, [g.key]: !expanded })} aria-expanded={expanded}>
                  {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <span className="skill-group-name">{g.label}</span>
                  <span className="faint">
                    {groupOn} of {g.skills.length} on
                  </span>
                </button>
                <span className="grow" />
                {g.repo && (
                  <>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {g.repo.updatedAt ? `updated ${ago(g.repo.updatedAt)}` : ''}
                    </span>
                    <button className="btn ghost sm" disabled={!!busy} onClick={() => void run(`update:${g.repo!.id}`, () => api.updateSkillRepo(g.repo!.id), 'Up to date')}>
                      <RefreshCw size={13} /> {busy === `update:${g.repo.id}` ? 'Updating…' : 'Update'}
                    </button>
                    <button
                      className="btn ghost sm"
                      disabled={!!busy}
                      onClick={() => {
                        if (confirm(`Remove ${g.repo!.name} and its skills from this computer?`)) void run('remove', () => api.removeSkillRepo(g.repo!.id), 'Removed');
                      }}
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </>
                )}
                <button className="btn ghost sm" disabled={!!busy || groupOn === g.skills.length} onClick={() => void run('bulk', () => api.setSkills(ids, true))}>
                  All on
                </button>
                <button className="btn ghost sm" disabled={!!busy || groupOn === 0} onClick={() => void run('bulk', () => api.setSkills(ids, false))}>
                  All off
                </button>
              </div>
              {expanded && (
                <div>
                  {g.skills.map((s) => (
                    <label key={s.id} className="list-row skill-row">
                      <input type="checkbox" checked={s.enabled} onChange={(e) => void run('toggle', () => api.setSkills([s.id], e.target.checked))} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="skill-name">{s.name}</span>
                        <span className="skill-desc">{s.description || 'No description.'}</span>
                        <span className="skill-path mono" title={s.file}>
                          {s.dir}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

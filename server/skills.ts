// Skills: folders of instructions (a SKILL.md, sometimes with scripts and references beside it) that
// teach an agent a kind of work. Claude Code, Codex, Hermes and others share the format, so the skills
// the user already has are found where those tools keep them, and more can be added from a git
// repository. Every agent on the crew, whatever its account, is told which skills are switched on and
// where they are, and reads the instructions itself when a task calls for one.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Skill, SkillRepo, SkillSource } from '../shared/types.ts';
import { DATA_DIR, kvGet, kvSet } from './db.ts';

const MAX_DEPTH = 6;
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build']);

export const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const REPOS_DIR = path.join(SKILLS_DIR, 'repos');
const OWN_DIR = path.join(SKILLS_DIR, 'own');

interface Root {
  source: SkillSource;
  label: string;
  dir: string;
  /** Repository skills are written by others, so they start switched off. */
  defaultOn: boolean;
  repo?: string;
}

/** Where each tool keeps its skills, plus Majordomo's own folders. */
export function skillRoots(home = os.homedir()): Root[] {
  const roots: Root[] = [
    { source: 'majordomo', label: 'Majordomo', dir: OWN_DIR, defaultOn: true },
    { source: 'claude', label: 'Claude Code', dir: path.join(home, '.claude', 'skills'), defaultOn: true },
    { source: 'claude-plugin', label: 'Claude Code plugins', dir: path.join(home, '.claude', 'plugins', 'cache'), defaultOn: true },
    { source: 'agents', label: 'Shared (~/.agents)', dir: path.join(home, '.agents', 'skills'), defaultOn: true },
    { source: 'codex', label: 'Codex', dir: path.join(home, '.codex', 'skills'), defaultOn: true },
    { source: 'hermes', label: 'Hermes', dir: path.join(home, '.hermes', 'skills'), defaultOn: true },
  ];
  for (const repo of listRepoDirs()) {
    roots.push({ source: 'repo', label: repo.name, dir: repo.dir, defaultOn: false, repo: repo.id });
  }
  return roots;
}

// ---------- reading a SKILL.md ----------

const unquote = (v: string) => {
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).replace(/\\"/g, '"');
  return s;
};

/** The name and description from a SKILL.md's front matter, falling back to its folder and first paragraph. */
export function parseSkill(text: string, folderName: string): { name: string; description: string } {
  let name = '';
  let description = '';
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  let body = text;
  if (fm) {
    body = text.slice(fm[0].length);
    const lines = fm[1]!.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^(name|description):\s*(.*)$/.exec(lines[i]!);
      if (!m) continue;
      let value = m[2]!;
      // A folded or literal block: the indented lines that follow are the value.
      if (/^[>|][-+]?\s*$/.test(value)) {
        const block: string[] = [];
        while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
        value = block.join(' ').trim();
      } else {
        value = unquote(value);
      }
      if (m[1] === 'name') name = value;
      else description = value;
    }
  }
  if (!description) {
    const para = body
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^#+\s.*$/gm, '').trim())
      .find(Boolean);
    description = para ?? '';
  }
  return { name: name || folderName, description: description.replace(/\s+/g, ' ').trim() };
}

function findSkillFiles(dir: string, depth = 0, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const own = entries.find((e) => e.isFile() && e.name.toLowerCase() === 'skill.md');
  if (own) {
    out.push(path.join(dir, own.name));
    // A skill's own subfolders are its resources, not more skills.
    return out;
  }
  if (depth >= MAX_DEPTH) return out;
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    if (e.isDirectory() || e.isSymbolicLink()) findSkillFiles(path.join(dir, e.name), depth + 1, out);
  }
  return out;
}

// ---------- the catalogue ----------

let cache: { at: number; skills: Skill[] } | null = null;

function enabledMap(): Record<string, boolean> {
  return kvGet<Record<string, boolean>>('skills:enabled', {});
}

/** Every skill found, with whether it is switched on. Rescanned at most every 30 seconds unless forced. */
export function listSkills(force = false): Skill[] {
  if (!force && cache && Date.now() - cache.at < 30_000) return cache.skills;
  const on = enabledMap();
  const seen = new Set<string>();
  const skills: Skill[] = [];
  for (const root of skillRoots()) {
    for (const file of findSkillFiles(root.dir)) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8').slice(0, 64_000);
      } catch {
        continue;
      }
      const dir = path.dirname(file);
      const id = `${root.repo ? `repo:${root.repo}` : root.source}:${path.relative(root.dir, dir) || '.'}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const { name, description } = parseSkill(text, path.basename(dir));
      skills.push({
        id,
        name,
        description,
        source: root.source,
        sourceLabel: root.label,
        repo: root.repo,
        dir,
        file,
        enabled: on[id] ?? root.defaultOn,
      });
    }
  }
  skills.sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel) || a.name.localeCompare(b.name));
  cache = { at: Date.now(), skills };
  return skills;
}

export function setSkillsEnabled(ids: string[], enabled: boolean): void {
  const on = enabledMap();
  for (const id of ids) on[id] = enabled;
  kvSet('skills:enabled', on);
  cache = null;
}

const MAX_LISTED = 80;

/**
 * The part of a task's opening message that tells the agent which skills it may use. Claude Code
 * already offers its own skills and installed plugins to Claude agents, so those are left out for
 * them. Returns '' when there is nothing to tell.
 */
export function skillCatalog(opts: { nativeClaude: boolean }): string {
  const usable = listSkills().filter((s) => s.enabled && !(opts.nativeClaude && (s.source === 'claude' || s.source === 'claude-plugin')));
  if (!usable.length) return '';
  const shown = usable.slice(0, MAX_LISTED);
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const lines = shown.map((s) => `- ${s.name}: ${clip(s.description, 220)} (${s.file})`);
  const more = usable.length > shown.length ? `\n- …and ${usable.length - shown.length} more, listed in ${SKILLS_DIR}` : '';
  return (
    '# Skills you can use\n' +
    'A skill is a folder of instructions, and sometimes scripts, for a particular kind of work. If one fits this task, ' +
    'read its SKILL.md before you start and follow it; files it mentions are relative to its folder. Skip the ones that do not apply.\n' +
    `${lines.join('\n')}${more}`
  );
}

/** Folders an agent may need to read outside its workspace to use the skills it is offered. */
export function skillFolders(): string[] {
  const dirs = new Set<string>();
  for (const s of listSkills()) if (s.enabled) dirs.add(path.dirname(s.dir));
  return [...dirs];
}

/** Names of the skills switched on, for the manager's view of what the crew can do. */
export function enabledSkillNames(): string[] {
  return listSkills()
    .filter((s) => s.enabled)
    .map((s) => s.name);
}

// ---------- finding skills on GitHub ----------

export interface FoundRepo {
  name: string;
  description: string;
  stars: number;
  updatedAt: number;
  url: string;
  /** Tagged on GitHub as a collection of agent or Claude skills. */
  tagged: boolean;
  /** Already added here. */
  added: boolean;
}

const SKILL_TOPICS = new Set(['agent-skills', 'claude-skills', 'skills', 'claude-code-skills', 'anthropic-skills', 'agent-skill', 'skill']);
const searchCache = new Map<string, { at: number; repos: Omit<FoundRepo, 'added'>[] }>();
let fetchGitHub: typeof fetch = (...args) => fetch(...args);
export function _setGitHubFetch(fn: typeof fetch | null): void {
  fetchGitHub = fn ?? ((...args) => fetch(...args));
  searchCache.clear();
}

/**
 * Search GitHub for repositories of skills. The user's words are searched together with "skills",
 * which finds collections whether or not they are tagged; with no words, the most-starred repositories
 * tagged as agent skills are shown. GitHub allows about ten searches a minute without signing in, so
 * results are kept for five minutes.
 */
export async function searchSkillRepos(query: string, sort: 'stars' | 'best' = 'stars'): Promise<FoundRepo[]> {
  const words = query.replace(/[^\p{L}\p{N}\s.+#-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  const q = words ? `${words} skills` : 'topic:agent-skills';
  const key = `${q}|${sort}`;
  let hit = searchCache.get(key);
  if (!hit || Date.now() - hit.at > 5 * 60_000) {
    const url = new URL('https://api.github.com/search/repositories');
    url.searchParams.set('q', q);
    url.searchParams.set('per_page', '30');
    if (sort === 'stars' || !words) url.searchParams.set('sort', 'stars');
    let res: Response;
    try {
      res = await fetchGitHub(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Majordomo', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Could not reach GitHub: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const wait = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : 60;
      throw new Error(`GitHub allows about ten searches a minute without signing in. Try again in ${wait} seconds.`);
    }
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) throw new Error(`GitHub search failed: ${json?.message ?? `HTTP ${res.status}`}`);
    hit = {
      at: Date.now(),
      repos: (json?.items ?? []).map((r: any) => ({
        name: String(r.full_name),
        description: String(r.description ?? ''),
        stars: Number(r.stargazers_count) || 0,
        updatedAt: Date.parse(r.pushed_at ?? r.updated_at ?? '') || 0,
        url: String(r.html_url),
        tagged: (r.topics ?? []).some((t: string) => SKILL_TOPICS.has(t)),
      })),
    };
    searchCache.set(key, hit);
  }
  const added = new Set(listRepos().map((r) => r.name.toLowerCase()));
  return hit.repos.map((r) => ({ ...r, added: added.has(r.name.toLowerCase()) }));
}

// ---------- repositories ----------

type Git = (args: string[], cwd?: string) => Promise<string>;

const realGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
      else resolve(stdout);
    });
  });

let git: Git = realGit;
export function _setGit(fn: Git | null): void {
  git = fn ?? realGit;
}

/**
 * Turn what the user pasted into a clone URL and a folder name. Accepts owner/repo for GitHub, or an
 * https address of any git host. Nothing else: no local paths, no ssh, no options in disguise.
 */
export function parseRepo(input: string): { url: string; id: string; name: string } | null {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let host = 'github.com';
  let owner = '';
  let repo = '';
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (short) {
    [, owner, repo] = short as unknown as [string, string, string];
  } else {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    // github.com/owner/repo/tree/main/skills → owner/repo
    if (parts.length < 2) return null;
    host = u.hostname;
    [owner, repo] = parts as [string, string];
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || owner.startsWith('-') || repo.startsWith('-')) return null;
  if (!/^[a-z0-9.-]+$/i.test(host)) return null;
  const id = `${host === 'github.com' ? '' : `${host}__`}${owner}__${repo}`;
  return { url: `https://${host}/${owner}/${repo}.git`, id, name: host === 'github.com' ? `${owner}/${repo}` : `${host}/${owner}/${repo}` };
}

function listRepoDirs(): { id: string; name: string; dir: string }[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(REPOS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const meta = kvGet<{ name?: string } | null>(`skills:repo:${e.name}`, null);
      return { id: e.name, name: meta?.name ?? e.name.replace(/__/g, '/'), dir: path.join(REPOS_DIR, e.name) };
    });
}

export function listRepos(): SkillRepo[] {
  const skills = listSkills();
  return listRepoDirs().map((r) => {
    const meta = kvGet<{ url?: string; updatedAt?: number } | null>(`skills:repo:${r.id}`, null);
    const mine = skills.filter((s) => s.repo === r.id);
    return { id: r.id, name: r.name, url: meta?.url ?? '', updatedAt: meta?.updatedAt ?? 0, skills: mine.length, enabled: mine.filter((s) => s.enabled).length };
  });
}

export async function addRepo(input: string): Promise<SkillRepo> {
  const parsed = parseRepo(input);
  if (!parsed) throw new Error('Paste a GitHub repository as owner/name, or its https:// address.');
  const dir = path.join(REPOS_DIR, parsed.id);
  if (fs.existsSync(dir)) throw new Error(`${parsed.name} is already added. Use Update to fetch its latest version.`);
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  try {
    await git(['clone', '--depth', '1', '--', parsed.url, dir]);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Could not download ${parsed.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  kvSet(`skills:repo:${parsed.id}`, { name: parsed.name, url: parsed.url, updatedAt: Date.now() });
  cache = null;
  const repo = listRepos().find((r) => r.id === parsed.id)!;
  if (!repo.skills) {
    // Nothing to offer: do not leave a stranger's code lying around for no reason.
    fs.rmSync(dir, { recursive: true, force: true });
    kvSet(`skills:repo:${parsed.id}`, null);
    cache = null;
    throw new Error(`${parsed.name} has no skills in it (no SKILL.md files were found).`);
  }
  return repo;
}

function repoDir(id: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(id) || id.startsWith('.')) throw new Error('Unknown repository.');
  const dir = path.join(REPOS_DIR, id);
  if (!fs.existsSync(dir)) throw new Error('Unknown repository.');
  return dir;
}

export async function updateRepo(id: string): Promise<SkillRepo> {
  const dir = repoDir(id);
  await git(['pull', '--ff-only', '--depth', '1'], dir);
  const meta = kvGet<Record<string, unknown> | null>(`skills:repo:${id}`, null) ?? {};
  kvSet(`skills:repo:${id}`, { ...meta, updatedAt: Date.now() });
  cache = null;
  return listRepos().find((r) => r.id === id)!;
}

export function removeRepo(id: string): void {
  const dir = repoDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
  kvSet(`skills:repo:${id}`, null);
  const on = enabledMap();
  for (const key of Object.keys(on)) if (key.startsWith(`repo:${id}:`)) delete on[key];
  kvSet('skills:enabled', on);
  cache = null;
}

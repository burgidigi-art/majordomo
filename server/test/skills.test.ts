import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, beforeEach, test } from 'node:test';
import { tempHome } from './helpers.ts';

// Skills: found where Claude Code, Hermes and others keep them, added from repositories, switched on
// and off, and offered to every agent.

process.env.MAJORDOMO_DEMO = '1';
const data = tempHome();
// A home folder laid out like the user's, with each tool's skills where that tool puts them.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'majordomo-skills-home-'));
process.env.HOME = home;

function skill(dir: string, text: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
}

skill(path.join(home, '.claude/skills/brand-voice'), '---\nname: brand-voice\ndescription: Write in the house style for social posts.\n---\n# Brand voice\n');
skill(
  path.join(home, '.claude/plugins/cache/market/marketing/1.2.0/skills/campaign-plan'),
  '---\nname: campaign-plan\ndescription: >\n  Plan a marketing campaign\n  from brief to calendar.\n---\nBody',
);
skill(path.join(home, '.hermes/skills/social/instagram-captions'), '---\nname: "instagram-captions"\ndescription: "Captions that fit Instagram"\n---\n');
// A skill's own subfolders are resources, not more skills.
skill(path.join(home, '.hermes/skills/social/instagram-captions/examples'), '---\nname: not-a-skill\n---\n');
skill(path.join(home, '.agents/skills/no-front-matter'), '# Weekly report\n\nTurn the week’s numbers into a one-page report.\n');

let skills: typeof import('../skills.ts');
let cli: typeof import('../agents/cli.ts');
let app: typeof import('../http.ts')['app'];
const local = { host: 'localhost:4317', origin: 'http://localhost:4317', 'content-type': 'application/json' };

/** A stand-in for git: "clones" by writing the given skills into the target folder. */
let repoContents: Record<string, string> = {};
const gitCalls: string[][] = [];

before(async () => {
  skills = await import('../skills.ts');
  cli = await import('../agents/cli.ts');
  app = (await import('../http.ts')).app;
  skills._setGit(async (args, cwd) => {
    gitCalls.push(cwd ? [...args, `@${path.basename(cwd)}`] : args);
    if (args[0] === 'clone') {
      const dir = args.at(-1)!;
      fs.mkdirSync(dir, { recursive: true });
      for (const [rel, text] of Object.entries(repoContents)) skill(path.join(dir, rel), text);
    }
    return '';
  });
});

beforeEach(() => {
  repoContents = {};
  gitCalls.length = 0;
});

const byName = () => Object.fromEntries(skills.listSkills(true).map((s) => [s.name, s]));

// ----- finding skills -----

test('skills installed for Claude Code, its plugins, Hermes and ~/.agents are all found', () => {
  const found = byName();
  assert.deepEqual(Object.keys(found).sort(), ['brand-voice', 'campaign-plan', 'instagram-captions', 'no-front-matter']);
  assert.equal(found['brand-voice']!.source, 'claude');
  assert.equal(found['campaign-plan']!.source, 'claude-plugin');
  assert.equal(found['instagram-captions']!.source, 'hermes');
  assert.equal(found['no-front-matter']!.source, 'agents');
  assert.ok(Object.values(found).every((s) => s.enabled), 'skills already on this computer start switched on');
});

test('names and descriptions are read from front matter in its usual forms', () => {
  const found = byName();
  assert.equal(found['campaign-plan']!.description, 'Plan a marketing campaign from brief to calendar.', 'a folded block');
  assert.equal(found['instagram-captions']!.description, 'Captions that fit Instagram', 'quoted');
  assert.equal(found['no-front-matter']!.description, 'Turn the week’s numbers into a one-page report.', 'no front matter: the first paragraph');
  assert.deepEqual(skills.parseSkill('---\ndescription: |\n  Line one.\n  Line two.\n---', 'folder'), { name: 'folder', description: 'Line one. Line two.' });
});

// ----- what agents are told -----

test('every agent is told about the switched-on skills and where their instructions are', () => {
  const catalog = skills.skillCatalog({ nativeClaude: false });
  for (const s of skills.listSkills()) assert.ok(catalog.includes(`- ${s.name}: `) && catalog.includes(s.file), s.name);
  assert.match(catalog, /read its SKILL\.md before you start/);
});

test('Claude agents are not told twice about skills Claude Code already gives them', () => {
  const catalog = skills.skillCatalog({ nativeClaude: true });
  assert.ok(!catalog.includes('brand-voice') && !catalog.includes('campaign-plan'));
  assert.ok(catalog.includes('instagram-captions') && catalog.includes('no-front-matter'));
});

test('a switched-off skill is not offered, and with none on nothing is said', () => {
  const all = skills.listSkills(true).map((s) => s.id);
  skills.setSkillsEnabled([skills.listSkills().find((s) => s.name === 'instagram-captions')!.id], false);
  assert.ok(!skills.skillCatalog({ nativeClaude: false }).includes('instagram-captions'));
  skills.setSkillsEnabled(all, false);
  assert.equal(skills.skillCatalog({ nativeClaude: false }), '');
  assert.deepEqual(skills.skillFolders(), []);
  skills.setSkillsEnabled(all, true);
});

test('Claude Code agents may use their own skills and read the skill folders; Gemini agents may read them too', () => {
  const dirs = skills.skillFolders();
  assert.ok(dirs.includes(path.join(home, '.hermes/skills/social')));
  const base = { agentId: 'T-1', model: '', cwd: path.join(data, 'ws'), prompt: 'x', manager: false, signal: new AbortController().signal, readDirs: dirs };
  const claude = cli.cliArgs({ ...base, runtime: 'claude-code' });
  assert.match(claude[claude.indexOf('--allowedTools') + 1]!, /(^|,)Skill(,|$)/);
  for (const d of dirs) assert.ok(claude.some((a, i) => a === '--add-dir' && claude[i + 1] === d), d);
  const gem = cli.cliArgs({ ...base, runtime: 'gemini-cli' });
  assert.equal(gem[gem.indexOf('--include-directories') + 1], dirs.join(','));
  const manager = cli.cliArgs({ ...base, runtime: 'claude-code', manager: true });
  assert.ok(!manager.includes('--add-dir'), 'the manager does not do the work, so it gets no extra folders');
});

// ----- repositories -----

test('a repository can be named as owner/name or by its address; anything else is refused', () => {
  assert.deepEqual(skills.parseRepo('anthropics/skills'), { url: 'https://github.com/anthropics/skills.git', id: 'anthropics__skills', name: 'anthropics/skills' });
  assert.equal(skills.parseRepo('https://github.com/anthropics/skills/tree/main/skills')?.url, 'https://github.com/anthropics/skills.git');
  assert.equal(skills.parseRepo('https://gitlab.com/team/kit.git')?.name, 'gitlab.com/team/kit');
  for (const bad of ['git@github.com:a/b.git', 'http://github.com/a/b', 'file:///etc', '/Users/me/skills', '--upload-pack=touch/x', 'https://user:pw@github.com/a/b', 'a/b/c', '']) {
    assert.equal(skills.parseRepo(bad), null, bad);
  }
});

test('skills from an added repository are listed switched off until the user turns them on', async () => {
  repoContents = {
    'skills/pdf': '---\nname: pdf\ndescription: Read and fill PDF forms.\n---',
    'skills/slides': '---\nname: slides\ndescription: Build a slide deck.\n---',
  };
  const res = await app.request('/api/skills/repos', { method: 'POST', headers: local, body: JSON.stringify({ url: 'anthropics/skills' }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { skills: { name: string; enabled: boolean; repo?: string }[]; repos: { name: string; skills: number; enabled: number }[] };
  assert.deepEqual(gitCalls[0]!.slice(0, 4), ['clone', '--depth', '1', '--'], 'a shallow clone, with the address after --');
  assert.deepEqual(body.repos.map((r) => [r.name, r.skills, r.enabled]), [['anthropics/skills', 2, 0]]);
  assert.ok(body.skills.filter((s) => s.repo).every((s) => !s.enabled));
  assert.ok(!skills.skillCatalog({ nativeClaude: false }).includes('Read and fill PDF forms'));

  const pdf = skills.listSkills().find((s) => s.name === 'pdf')!;
  await app.request('/api/skills', { method: 'PUT', headers: local, body: JSON.stringify({ ids: [pdf.id], enabled: true }) });
  assert.ok(skills.skillCatalog({ nativeClaude: false }).includes('Read and fill PDF forms'));
});

test('adding the same repository twice, or one with no skills, is refused and leaves nothing behind', async () => {
  const again = await app.request('/api/skills/repos', { method: 'POST', headers: local, body: JSON.stringify({ url: 'anthropics/skills' }) });
  assert.equal(again.status, 400);
  assert.match(((await again.json()) as { error: string }).error, /already added/);

  repoContents = {};
  const empty = await app.request('/api/skills/repos', { method: 'POST', headers: local, body: JSON.stringify({ url: 'someone/nothing-here' }) });
  assert.equal(empty.status, 400);
  assert.match(((await empty.json()) as { error: string }).error, /no skills/);
  assert.ok(!fs.existsSync(path.join(skills.SKILLS_DIR, 'repos', 'someone__nothing-here')));
});

test('a repository can be updated and removed, and removing it forgets its switches', async () => {
  const up = await app.request('/api/skills/repos/anthropics__skills/update', { method: 'POST', headers: local });
  assert.equal(up.status, 200);
  assert.deepEqual(gitCalls.at(-1), ['pull', '--ff-only', '--depth', '1', '@anthropics__skills']);

  const gone = await app.request('/api/skills/repos/anthropics__skills', { method: 'DELETE', headers: local });
  assert.equal(gone.status, 200);
  assert.ok(!skills.listSkills(true).some((s) => s.repo));
  assert.ok(!fs.existsSync(path.join(skills.SKILLS_DIR, 'repos', 'anthropics__skills')));

  // Added again later, its skills start switched off again.
  repoContents = { 'skills/pdf': '---\nname: pdf\n---' };
  await app.request('/api/skills/repos', { method: 'POST', headers: local, body: JSON.stringify({ url: 'anthropics/skills' }) });
  assert.equal(skills.listSkills(true).find((s) => s.name === 'pdf')?.enabled, false);
});

test('only repositories Majordomo added can be updated or removed', async () => {
  for (const id of ['..', '../../etc', '.hidden', 'not-there']) {
    const res = await app.request(`/api/skills/repos/${encodeURIComponent(id)}`, { method: 'DELETE', headers: local });
    assert.ok(res.status === 400 || res.status === 404, `${id}: ${res.status}`);
  }
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/brand-voice/SKILL.md')));
});

test('another website cannot add repositories', async () => {
  const res = await app.request('/api/skills/repos', { method: 'POST', headers: { ...local, origin: 'https://evil.example' }, body: '{"url":"a/b"}' });
  assert.equal(res.status, 403);
});

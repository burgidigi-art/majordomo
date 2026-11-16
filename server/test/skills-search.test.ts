import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { tempHome } from './helpers.ts';

// Finding skill collections on GitHub from Settings.

process.env.MAJORDOMO_DEMO = '1';
tempHome();

let skills: typeof import('../skills.ts');
let app: typeof import('../http.ts')['app'];
let calls: URL[] = [];
let reply: () => Response;

const item = (name: string, stars: number, topics: string[] = [], description = '') => ({
  full_name: name,
  description,
  stargazers_count: stars,
  pushed_at: '2026-11-01T00:00:00Z',
  html_url: `https://github.com/${name}`,
  topics,
});

before(async () => {
  skills = await import('../skills.ts');
  app = (await import('../http.ts')).app;
});

beforeEach(() => {
  calls = [];
  reply = () => Response.json({ items: [item('acme/instagram-skills', 1200, ['agent-skills'], 'Captions and reels'), item('someone/scraper', 90)] });
  skills._setGitHubFetch(async (url) => {
    calls.push(new URL(String(url)));
    return reply();
  });
});

test('words are searched together with "skills", busiest first, and results say which are skill collections', async () => {
  const res = await app.request('/api/skills/search?q=instagram%20captions', { headers: { host: 'localhost:4317' } });
  const { repos } = (await res.json()) as { repos: { name: string; stars: number; tagged: boolean; added: boolean; url: string }[] };
  assert.equal(calls[0]!.searchParams.get('q'), 'instagram captions skills');
  assert.equal(calls[0]!.searchParams.get('sort'), 'stars');
  assert.deepEqual(
    repos.map((r) => [r.name, r.stars, r.tagged, r.added]),
    [
      ['acme/instagram-skills', 1200, true, false],
      ['someone/scraper', 90, false, false],
    ],
  );
  assert.equal(repos[0]!.url, 'https://github.com/acme/instagram-skills');
});

test('with no words, the most-starred collections tagged as agent skills are shown', async () => {
  await skills.searchSkillRepos('');
  assert.equal(calls[0]!.searchParams.get('q'), 'topic:agent-skills');
});

test('best match leaves the ordering to GitHub', async () => {
  await skills.searchSkillRepos('seo', 'best');
  assert.equal(calls[0]!.searchParams.get('sort'), null);
});

test('the same search within five minutes is answered without asking GitHub again', async () => {
  await skills.searchSkillRepos('invoices');
  await skills.searchSkillRepos('invoices');
  assert.equal(calls.length, 1);
});

test('search syntax typed by the user cannot change the query', async () => {
  await skills.searchSkillRepos('seo user:someone repo:x/y');
  assert.equal(calls[0]!.searchParams.get('q'), 'seo user someone repo x y skills');
});

test('running into GitHub’s limit says how long to wait', async () => {
  reply = () => new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 42) } });
  await assert.rejects(skills.searchSkillRepos('limits'), /ten searches a minute.*Try again in 4[0-3] seconds/);
});

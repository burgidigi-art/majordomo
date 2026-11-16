import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { StreamMessage } from '../../shared/types.ts';
import { tempHome } from './helpers.ts';

// "What's hot in the streets": GitHub's trending top 10, with a fallback, refreshed on a schedule.

process.env.MAJORDOMO_DEMO = '1';
tempHome();
const page = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'trending.html'), 'utf8');

let trending: typeof import('../trending.ts');
let bus: typeof import('../bus.ts');
let app: typeof import('../http.ts')['app'];
let calls: string[] = [];
let respond: (url: string) => Response;

before(async () => {
  trending = await import('../trending.ts');
  bus = await import('../bus.ts');
  app = (await import('../http.ts')).app;
});

beforeEach(() => {
  calls = [];
  respond = (url) => (url.includes('/trending') ? new Response(page, { headers: { 'content-type': 'text/html' } }) : Response.json({ items: [] }));
  trending._setTrendingFetch(async (url) => {
    calls.push(String(url));
    return respond(String(url));
  });
});

test('the Trending page is read: names, descriptions, language, stars and stars today', () => {
  const repos = trending.parseTrending(page);
  assert.deepEqual(repos[0], {
    rank: 1,
    name: 'acme/rocket',
    description: 'A fast & tiny launcher for everything — it\'s 10× quicker.',
    language: 'TypeScript',
    stars: 12345,
    starsToday: 1234,
    url: 'https://github.com/acme/rocket',
    download: 'https://github.com/acme/rocket/archive/HEAD.zip',
  });
  assert.deepEqual([repos[1]!.name, repos[1]!.description, repos[1]!.language, repos[1]!.stars, repos[1]!.starsToday], ['someone/no-description', '', '', 987, 56]);
});

test('only the top 10 are kept', () => {
  const block = page.slice(page.indexOf('<article'), page.indexOf('</article>') + '</article>'.length);
  const many = Array.from({ length: 14 }, (_, i) => block.replaceAll('acme/rocket', `acme/repo-${i}`)).join('\n');
  const repos = trending.parseTrending(`<main>${many}</main>`);
  assert.equal(repos.length, 10);
  assert.deepEqual([repos[0]!.rank, repos[9]!.rank, repos[9]!.name], [1, 10, 'acme/repo-9']);
});

test('a page that is not shaped as expected yields nothing rather than nonsense', () => {
  assert.deepEqual(trending.parseTrending('<html><body>Sign in to GitHub</body></html>'), []);
});

test('a refresh stores the list and pushes it to the dashboard', async () => {
  const pushed: StreamMessage[] = [];
  const stop = bus.subscribe((m) => m.kind === 'sync' && m.patch.trending && pushed.push(m));
  try {
    const s = await trending.refreshTrending(0);
    assert.equal(s.source, 'trending');
    assert.equal(s.repos.length, 2);
    assert.equal(pushed.length, 1);
    assert.deepEqual(trending.trendingState().repos.map((r) => r.name), ['acme/rocket', 'someone/no-description']);
  } finally {
    stop();
  }
});

test('opening the dashboard again within a minute reuses the list instead of asking GitHub again', async () => {
  await trending.refreshTrending(0);
  calls = [];
  const res = await app.request('/api/trending/refresh', { method: 'POST', headers: { host: 'localhost:4317', origin: 'http://localhost:4317' } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, []);
});

test('when the Trending page cannot be read, this week’s most-starred new repositories stand in', async () => {
  respond = (url) =>
    url.includes('/trending')
      ? new Response('<html>changed</html>')
      : Response.json({ items: [{ full_name: 'new/thing', description: 'Fresh', language: 'Rust', stargazers_count: 4321 }] });
  const s = await trending.refreshTrending(0);
  assert.equal(s.source, 'new-this-week');
  assert.deepEqual(s.repos[0], {
    rank: 1,
    name: 'new/thing',
    description: 'Fresh',
    language: 'Rust',
    stars: 4321,
    starsToday: null,
    url: 'https://github.com/new/thing',
    download: 'https://github.com/new/thing/archive/HEAD.zip',
  });
  const q = new URL(calls.find((c) => c.includes('api.github.com'))!).searchParams.get('q')!;
  assert.match(q, /^created:>\d{4}-\d{2}-\d{2}$/);
});

test('when GitHub cannot be reached at all, the last list stays and says so', async () => {
  await trending.refreshTrending(0);
  respond = () => new Response('nope', { status: 503 });
  const s = await trending.refreshTrending(0);
  assert.equal(s.repos.length, 2, 'the last good list is kept');
  assert.match(s.error, /Could not reach GitHub.*Showing the last list/);
});

test('the daily refresh is set for 12:01 am', () => {
  const at = (iso: string) => new Date(iso);
  const ms = (from: string) => trending.msUntilNextMorning(at(from));
  assert.equal(ms('2026-11-16T23:59:00'), 2 * 60_000, 'two minutes before 12:01');
  assert.equal(ms('2026-11-17T00:00:30'), 30_000, 'half a minute before');
  assert.equal(ms('2026-11-17T00:01:00'), 24 * 3600_000, 'just done: tomorrow');
  assert.equal(ms('2026-11-17T09:00:00'), 15 * 3600_000 + 60_000);
});

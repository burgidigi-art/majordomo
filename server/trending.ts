// "What's hot in the streets": GitHub's top 10 trending repositories today, for the dashboard.
// GitHub has no API for its Trending page, so the page itself is read; if that fails (GitHub changed
// the page, or it cannot be reached), the most-starred repositories created this week stand in, from
// GitHub's official search. Refreshed when Chiba starts, when the dashboard is opened, and every
// day at 12:01 am.
import type { TrendingRepo, TrendingState } from '../shared/types.ts';
import { sync } from './bus.ts';
import { kvGet, kvSet } from './db.ts';

const HEADERS = { 'User-Agent': 'Chiba', Accept: 'text/html,application/json' };
let fetcher: typeof fetch = (...a) => fetch(...a);
export function _setTrendingFetch(fn: typeof fetch | null): void {
  fetcher = fn ?? ((...a) => fetch(...a));
}

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const num = (s: string | undefined) => (s ? Number(s.replace(/[^\d]/g, '')) || 0 : 0);

const links = (name: string) => ({ url: `https://github.com/${name}`, download: `https://github.com/${name}/archive/HEAD.zip` });

/** Read the repositories off GitHub's Trending page. Returns [] if the page is not shaped as expected. */
export function parseTrending(html: string): TrendingRepo[] {
  const out: TrendingRepo[] = [];
  for (const block of html.split(/<article\b[^>]*class="[^"]*Box-row[^"]*"[^>]*>/).slice(1)) {
    const article = block.split('</article>')[0]!;
    // \b keeps <p and <a from matching the <path and <article tags around them.
    const href = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href="\/([^"/?#]+\/[^"/?#]+)"/.exec(article)?.[1];
    if (!href) continue;
    const name = decodeURIComponent(href);
    const description = decode(/<p\b[^>]*>([\s\S]*?)<\/p>/.exec(article)?.[1] ?? '');
    const language = decode(/itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/.exec(article)?.[1] ?? '');
    const starsLink = new RegExp(`href="/${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/stargazers"[^>]*>([\\s\\S]*?)</a>`).exec(article)?.[1];
    const today = /([\d,]+)\s+stars?\s+(today|this week|this month)/.exec(decode(article));
    out.push({ rank: out.length + 1, name, description, language, stars: num(decode(starsLink ?? '')), starsToday: today ? num(today[1]) : null, ...links(name) });
    if (out.length === 10) break;
  }
  return out;
}

async function fromTrendingPage(): Promise<TrendingRepo[]> {
  const res = await fetcher('https://github.com/trending?since=daily', { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub Trending answered HTTP ${res.status}`);
  const repos = parseTrending(await res.text());
  if (!repos.length) throw new Error('GitHub Trending could not be read; the page may have changed.');
  return repos;
}

async function fromSearch(): Promise<TrendingRepo[]> {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString().slice(0, 10);
  const url = new URL('https://api.github.com/search/repositories');
  url.searchParams.set('q', `created:>${since}`);
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('per_page', '10');
  const res = await fetcher(url, { headers: { 'User-Agent': 'Chiba', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub search answered HTTP ${res.status}`);
  const json = (await res.json()) as any;
  return (json?.items ?? []).slice(0, 10).map((r: any, i: number) => ({
    rank: i + 1,
    name: String(r.full_name),
    description: String(r.description ?? ''),
    language: String(r.language ?? ''),
    stars: Number(r.stargazers_count) || 0,
    starsToday: null,
    ...links(String(r.full_name)),
  }));
}

export function trendingState(): TrendingState {
  return kvGet<TrendingState>('trending', { repos: [], source: 'none', fetchedAt: 0, error: '' });
}

let running: Promise<TrendingState> | null = null;

/** Fetch the list again, unless it was fetched within `minAgeMs`. Keeps the last good list on failure. */
export function refreshTrending(minAgeMs = 60_000): Promise<TrendingState> {
  const current = trendingState();
  if (Date.now() - current.fetchedAt < minAgeMs && current.repos.length) return Promise.resolve(current);
  running ??= (async () => {
    let next: TrendingState;
    try {
      next = { repos: await fromTrendingPage(), source: 'trending', fetchedAt: Date.now(), error: '' };
    } catch (first) {
      try {
        next = { repos: await fromSearch(), source: 'new-this-week', fetchedAt: Date.now(), error: '' };
      } catch (second) {
        const why = second instanceof Error ? second.message : String(second);
        next = { ...current, error: `Could not reach GitHub (${why}).${current.repos.length ? ' Showing the last list.' : ''}` };
      }
      void first;
    }
    kvSet('trending', next);
    sync({ trending: next });
    return next;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Milliseconds until the next 12:01 am, local time. */
export function msUntilNextMorning(now = new Date()): number {
  const next = new Date(now);
  next.setHours(0, 1, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Refresh at start, then every day at 12:01 am. */
export function scheduleTrending(): void {
  void refreshTrending(0);
  const arm = () => {
    setTimeout(() => {
      void refreshTrending(0);
      arm();
    }, msUntilNextMorning()).unref();
  };
  arm();
}

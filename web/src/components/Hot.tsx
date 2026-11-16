import { Download, ExternalLink, Flame, RefreshCw, Star } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TrendingRepo, TrendingState } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { ago, compact, useNow } from '../lib.ts';

/** One repository: two lines of description, with More when there is more to read. */
function HotRow({ repo }: { repo: TrendingRepo }) {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const desc = useRef<HTMLParagraphElement>(null);
  // Only offer More when the description really runs past two lines.
  useLayoutEffect(() => {
    const el = desc.current;
    if (el && !open) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [repo.description, open]);
  const [owner, name] = repo.name.split('/');

  return (
    <li className="hot-row">
      <span className="hot-rank">{repo.rank}</span>
      <div className="hot-main">
        <div className="hot-top">
          <a className="hot-name" href={repo.url} target="_blank" rel="noreferrer noopener" title={`Open ${repo.name} on GitHub`}>
            <span className="faint">{owner} /</span> {name}
          </a>
          <a className="hot-btn" href={repo.download} target="_blank" rel="noreferrer noopener" title={`Download ${repo.name} as a .zip`}>
            <Download size={12} /> Download
          </a>
          <a className="hot-btn icon" href={repo.url} target="_blank" rel="noreferrer noopener" title={`Open ${repo.name} on GitHub`} aria-label={`Open ${repo.name} on GitHub`}>
            <ExternalLink size={12} />
          </a>
        </div>
        {repo.description ? (
          <>
            <p ref={desc} className={`hot-desc${open ? ' open' : ''}`}>
              {repo.description}
            </p>
            {(clipped || open) && (
              <button className="hot-more" onClick={() => setOpen(!open)} aria-expanded={open}>
                {open ? 'Less' : 'More'}
              </button>
            )}
          </>
        ) : (
          <p className="hot-desc faint">No description.</p>
        )}
        <div className="hot-meta">
          {repo.language && <span>{repo.language}</span>}
          <span title="Stars">
            <Star size={11} /> {compact(repo.stars)}
          </span>
          {repo.starsToday !== null && <span className="hot-today">+{compact(repo.starsToday)} today</span>}
        </div>
      </div>
    </li>
  );
}

/**
 * What's hot in the streets: GitHub's top 10 trending repositories today. Refreshed when Majordomo
 * starts, when the dashboard opens, and every day at 12:01 am; the list scrolls on its own.
 */
export function HotInTheStreets({ trending }: { trending: TrendingState }) {
  const now = useNow(true, 30_000);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    await api.refreshTrending(true).catch(() => {});
    setBusy(false);
  };
  const source = trending.source === 'new-this-week' ? 'Most-starred new repos this week' : 'Trending on GitHub today';

  return (
    <section className="panel hot-panel" aria-label="What's hot in the streets">
      <div className="hot-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="eyebrow">
            <Flame size={12} /> What’s hot in the streets
          </div>
          <div className="hot-sub">
            {source}
            {trending.fetchedAt ? ` · updated ${ago(trending.fetchedAt, now)}` : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={() => void refresh()} disabled={busy} aria-label="Refresh" title="Refresh now">
          <RefreshCw size={14} className={busy ? 'spin' : ''} />
        </button>
      </div>
      {trending.error && <div className="hot-error">{trending.error}</div>}
      {trending.repos.length ? (
        <ol className="hot-list">
          {trending.repos.map((r) => (
            <HotRow key={r.name} repo={r} />
          ))}
        </ol>
      ) : (
        <div className="faint hot-empty">{busy || !trending.fetchedAt ? 'Checking GitHub…' : 'Nothing to show right now.'}</div>
      )}
    </section>
  );
}

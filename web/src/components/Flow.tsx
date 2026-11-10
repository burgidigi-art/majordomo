import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RuntimeInfo } from '../../../shared/types.ts';

/**
 * The work-flow picture: a cloud of particles for your work, with a glittering stream running
 * to each connected account (top row) and each crew member (bottom row). A stream is bright and
 * fast while an agent is actually working there, and a faint trickle when it is idle — so the
 * picture is a reading of what is happening, not decoration.
 */

export interface FlowNode {
  id: string;
  label: string;
  family: RuntimeInfo['family'];
  live: boolean;
  href: string;
  /** A "+3 more" tile rather than a real destination. */
  more?: boolean;
  glyph?: string;
}

interface Pt {
  x: number;
  y: number;
}

interface Layout {
  w: number;
  h: number;
  hub: Pt & { r: number };
  top: Pt[];
  bottom: Pt[];
}

const TILE = 19; // half the height of a node tile
const FAMILIES: RuntimeInfo['family'][] = ['claude', 'openai', 'gemini', 'muse', 'openrouter', 'demo'];

function layoutFor(w: number, h: number, nTop: number, nBottom: number): Layout {
  const r = Math.max(70, Math.min(h * 0.42, w * 0.2, 126));
  const hub = { x: Math.max(r + 14, Math.min(w * 0.23, 190)), y: h / 2, r };
  const right = w - 46;
  const left = hub.x + r + Math.min(190, w * 0.2);
  const row = (n: number, y: number): Pt[] => {
    const gap = n > 1 ? Math.min(82, (right - left) / (n - 1)) : 0;
    return Array.from({ length: n }, (_, i) => ({ x: right - (n - 1 - i) * gap, y }));
  };
  return { w, h, hub, top: row(nTop, 46), bottom: row(nBottom, h - 46) };
}

const cubic = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
};

/**
 * One stream's route: out of the cloud, over a hump, along a shared trunk, then a turn up or down
 * into its node. Each stream gets its own lane so the bundle reads as parallel ribbons.
 */
function route(l: Layout, target: Pt, lane: number, lanes: number, up: boolean): { pts: Pt[]; len: number[] } {
  const { hub } = l;
  const spread = 7;
  // Streams leaving first (leftmost node) ride on the outside of the bundle, so none cross.
  const offset = (lanes - 1 - lane) * spread + 7;
  const trunkY = hub.y + (up ? -offset : offset);
  const start = { x: hub.x + hub.r * 0.18, y: hub.y - hub.r * 0.05 };
  const peak = { x: hub.x + hub.r * 1.18, y: hub.y - hub.r * 0.74 + (up ? -offset : offset) * 0.55 };
  const trunk = { x: Math.min(hub.x + hub.r + Math.min(150, l.w * 0.16), target.x - 30), y: trunkY };
  const bend = 15;
  const edge = { x: target.x, y: target.y + (up ? TILE + 4 : -(TILE + 4)) };

  const pts: Pt[] = [];
  for (let i = 0; i <= 26; i++) pts.push(cubic(start, { x: start.x + hub.r * 0.55, y: start.y }, { x: peak.x - hub.r * 0.42, y: peak.y }, peak, i / 26));
  for (let i = 1; i <= 26; i++) pts.push(cubic(peak, { x: peak.x + hub.r * 0.42, y: peak.y }, { x: trunk.x - 46, y: trunk.y }, trunk, i / 26));
  const corner = { x: target.x - bend, y: trunkY };
  const steps = Math.max(1, Math.round((corner.x - trunk.x) / 6));
  for (let i = 1; i <= steps; i++) pts.push({ x: trunk.x + ((corner.x - trunk.x) * i) / steps, y: trunkY });
  const after = { x: target.x, y: trunkY + (up ? -bend : bend) };
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const u = 1 - t;
    pts.push({ x: u * u * corner.x + 2 * u * t * target.x + t * t * after.x, y: u * u * corner.y + 2 * u * t * trunkY + t * t * after.y });
  }
  const drop = Math.max(1, Math.round(Math.abs(edge.y - after.y) / 6));
  for (let i = 1; i <= drop; i++) pts.push({ x: target.x, y: after.y + ((edge.y - after.y) * i) / drop });

  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, len };
}

/** Deterministic pseudo-random numbers, so the picture does not reshuffle on every render. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function readPalette(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const f of FAMILIES) out[f] = css.getPropertyValue(`--${f}`).trim() || '#f3b65f';
  out.text = css.getPropertyValue('--text').trim() || '#fff';
  out.muted = css.getPropertyValue('--text-3').trim() || '#777';
  return out;
}

export function FlowStage({
  top,
  bottom,
  hubLabel,
  hubCount,
  topTag,
  bottomTag,
  theme,
}: {
  top: FlowNode[];
  bottom: FlowNode[];
  hubLabel: string;
  hubCount: number;
  topTag: string;
  bottomTag: string;
  theme: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  // The animation loop reads these through refs so it never has to restart when data changes.
  const live = useRef({ top, bottom });
  live.current = { top, bottom };

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setLayout(layoutFor(el.clientWidth, el.clientHeight, top.length, bottom.length));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [top.length, bottom.length]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !layout) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(layout.w * dpr);
    cv.height = Math.round(layout.h * dpr);
    const palette = readPalette();
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rand = seeded(7);

    const streams = [
      ...layout.top.map((p, i) => ({ ...route(layout, p, i, layout.top.length, true), row: 'top' as const, i })),
      ...layout.bottom.map((p, i) => ({ ...route(layout, p, i, layout.bottom.length, false), row: 'bottom' as const, i })),
    ].map((s) => ({
      ...s,
      parts: Array.from({ length: 260 }, () => ({
        t: rand(),
        speed: 0.55 + rand() * 0.9,
        off: (rand() + rand() + rand() - 1.5) * 3.4,
        size: 0.7 + rand() * 1.7,
        phase: rand() * Math.PI * 2,
        bright: rand(),
      })),
    }));

    const cloud = Array.from({ length: 300 }, () => {
      const a = rand() * Math.PI * 2;
      return {
        a,
        d: Math.pow(rand(), 1.7),
        size: 0.6 + rand() * 1.8,
        phase: rand() * Math.PI * 2,
        spin: (rand() - 0.5) * 0.12,
        family: FAMILIES[Math.floor(rand() * FAMILIES.length)],
        white: rand() < 0.45,
      };
    });

    let frame = 0;
    let stopped = false;
    const draw = (now: number) => {
      const time = still ? 4 : now / 1000;
      const { hub } = layout;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, layout.w, layout.h);

      // the cloud's ring and glow
      ctx.save();
      ctx.strokeStyle = palette.muted;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.arc(hub.x, hub.y, hub.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      const glow = ctx.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, hub.r * 0.6);
      glow.addColorStop(0, 'rgba(255,255,255,0.20)');
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(hub.x - hub.r, hub.y - hub.r, hub.r * 2, hub.r * 2);

      for (const p of cloud) {
        const a = p.a + time * p.spin;
        const d = p.d * hub.r * 0.96;
        ctx.globalAlpha = (0.35 + 0.65 * Math.abs(Math.sin(p.phase + time * 1.6))) * (1 - p.d * 0.55);
        ctx.fillStyle = p.white ? palette.text : palette[p.family];
        ctx.fillRect(hub.x + Math.cos(a) * d, hub.y + Math.sin(a) * d, p.size, p.size);
      }

      for (const s of streams) {
        const node = (s.row === 'top' ? live.current.top : live.current.bottom)[s.i];
        if (!node) continue;
        const active = node.live;
        const total = s.len[s.len.length - 1];
        const color = node.more ? palette.muted : palette[node.family];
        // An idle stream shows a third of its particles, barely moving; a live one shows them all.
        const count = active ? s.parts.length : 90;
        const pxPerSec = active ? 78 : 7;
        for (let k = 0; k < count; k++) {
          const p = s.parts[k];
          const dist = ((p.t + (time * pxPerSec * p.speed) / total) % 1) * total;
          let j = 1;
          while (j < s.len.length - 1 && s.len[j] < dist) j++;
          const a = s.pts[j - 1];
          const b = s.pts[j];
          const seg = s.len[j] - s.len[j - 1] || 1;
          const f = (dist - s.len[j - 1]) / seg;
          const nx = -(b.y - a.y) / seg;
          const ny = (b.x - a.x) / seg;
          const twinkle = 0.5 + 0.5 * Math.sin(p.phase + time * (active ? 7 : 1.5));
          ctx.globalAlpha = active ? 0.4 + 0.6 * twinkle : 0.16 + 0.22 * twinkle;
          ctx.fillStyle = active && p.bright > 0.82 ? palette.text : color;
          ctx.fillRect(a.x + (b.x - a.x) * f + nx * p.off, a.y + (b.y - a.y) * f + ny * p.off, p.size, p.size);
        }
      }
      ctx.globalAlpha = 1;
      if (!still && !stopped) frame = requestAnimationFrame(draw);
    };

    const onVisibility = () => {
      cancelAnimationFrame(frame);
      if (!document.hidden && !still) frame = requestAnimationFrame(draw);
    };
    document.addEventListener('visibilitychange', onVisibility);
    frame = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [layout, theme]);

  const node = (n: FlowNode, p: Pt, below: boolean) => (
    <a key={n.id} href={n.href} className={`flow-node fam-${n.family}${n.live ? ' live' : ''}${below ? ' below' : ''}${n.more ? ' more' : ''}`} style={{ left: p.x, top: p.y + (below ? 12 : -12) }} title={n.label}>
      <span>{n.label}</span>
      <i className="flow-tile" style={{ fontStyle: 'normal' }}>
        {n.glyph ?? n.label.trim()[0]?.toUpperCase()}
      </i>
    </a>
  );

  return (
    <div className="flow-stage" ref={stage}>
      <canvas ref={canvas} aria-hidden />
      {layout && (
        <>
          <div className="flow-hub" style={{ left: layout.hub.x, top: layout.hub.y }}>
            {hubLabel}
            <b>{hubCount.toLocaleString()}</b>
          </div>
          {layout.top[0] && layout.top[0].x - layout.hub.x - layout.hub.r > 130 && (
            <div className="flow-tag" style={{ left: layout.top[0].x - 22, top: layout.top[0].y + 6 }}>
              {topTag}
            </div>
          )}
          {layout.bottom[0] && layout.bottom[0].x - layout.hub.x - layout.hub.r > 130 && (
            <div className="flow-tag" style={{ left: layout.bottom[0].x - 22, top: layout.bottom[0].y - 6 }}>
              {bottomTag}
            </div>
          )}
          {top.map((n, i) => layout.top[i] && node(n, layout.top[i], false))}
          {bottom.map((n, i) => layout.bottom[i] && node(n, layout.bottom[i], true))}
        </>
      )}
    </div>
  );
}

/** A small sphere of twinkling particles, used as an ornament on the manager card. */
export function SparkOrb({ theme, busy }: { theme: string; busy: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const speed = useRef(busy);
  speed.current = busy;
  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const size = 104;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = cv.height = size * dpr;
    const palette = readPalette();
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rand = seeded(23);
    const dots = Array.from({ length: 130 }, () => ({
      a: rand() * Math.PI * 2,
      d: Math.pow(rand(), 1.5),
      size: 0.6 + rand() * 1.5,
      phase: rand() * Math.PI * 2,
      spin: (rand() - 0.5) * 0.3,
      color: rand() < 0.5 ? palette.text : palette[FAMILIES[Math.floor(rand() * FAMILIES.length)]],
    }));
    let frame = 0;
    let stopped = false;
    let clock = 0;
    let last = 0;
    const draw = (now: number) => {
      clock += ((now - (last || now)) / 1000) * (speed.current ? 3 : 1);
      last = now;
      const time = still ? 3 : clock;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      for (const p of dots) {
        const a = p.a + time * p.spin;
        const d = p.d * (size / 2 - 5);
        ctx.globalAlpha = (0.3 + 0.7 * Math.abs(Math.sin(p.phase + time * 1.4))) * (1 - p.d * 0.45);
        ctx.fillStyle = p.color;
        ctx.fillRect(size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d, p.size, p.size);
      }
      ctx.globalAlpha = 1;
      if (!still && !stopped) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [theme]);
  return (
    <div className="spark-orb" aria-hidden>
      <canvas ref={canvas} />
    </div>
  );
}

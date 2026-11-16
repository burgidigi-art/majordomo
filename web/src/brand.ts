// Chiba's mark: a cartoon mid-shot of a karate gi, from the knees to the neck, tied with a black belt.
// One drawing serves the Mac app icon, the browser tab icon and the logo in the dashboard. Two poses:
// grip (hands holding the belt near its ends) or sides (arms hanging, hands just below the belt).

export type Pose = 'grip' | 'sides';

export interface MarkOptions {
  pose: Pose;
  /** Draw the orange tile behind it (app icon, favicon). Without it, the figure alone. */
  tile: boolean;
  /** Unique prefix for ids, so several marks can share a page. */
  id?: string;
}

// Cartoon palette: flat fills, one shadow tone, and a bold dark ink outline.
const INK = '#2a1f1a';
const GI = '#fdfaf3';
const GI_SHADOW = '#e6dccb';
const BELT = '#1d1b22';
const BELT_SHINE = '#4a4754';
const SKIN = '#e0a46a';
const SKIN_SHADOW = '#c4844b';
const LINE = 5; // outline width on the 256-unit grid
const FOLD = 3;

const outlined = (d: string, fill: string, width = LINE) =>
  `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
const fold = (d: string) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${FOLD}" stroke-linecap="round" opacity="0.85"/>`;

/** A sleeve: a thick stroke of cloth along `d`, inked on both sides, with a fold line. */
function sleeve(d: string, crease: string): string {
  return `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${44 + LINE * 2}" stroke-linecap="butt" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${GI}" stroke-width="44" stroke-linecap="butt" stroke-linejoin="round"/>
    ${fold(crease)}`;
}

/** A chunky cartoon fist around a belt end: knuckles on top, the thumb wrapped across the front. */
function fist(x: number, y: number, flip: boolean): string {
  const t = flip ? `translate(${x} ${y}) scale(-1 1)` : `translate(${x} ${y})`;
  return `<g transform="${t}">
      ${outlined('M-21 -10 Q -21 -18 -12 -18 L 12 -18 Q 21 -18 21 -9 L 21 9 Q 21 17 12 17 L -12 17 Q -21 17 -21 8 Z', SKIN)}
      ${fold('M-10 -18 v7 M0 -18 v8 M10 -18 v7')}
      ${outlined('M-21 -2 Q -4 -10 14 -2 Q 10 9 -18 8', SKIN, 4)}
      <path d="M-16 12 Q 0 15 14 11" fill="none" stroke="${SKIN_SHADOW}" stroke-width="3" stroke-linecap="round"/>
    </g>`;
}

/** A relaxed fist hanging at the side, drawn then turned half a circle so the thumb and knuckles sit naturally. */
function hangingFist(x: number, y: number, flip: boolean): string {
  // Turned about the fist's own centre (1, 3), so it stays where it hangs under the cuff.
  const t = `${flip ? `translate(${x} ${y}) scale(-1 1)` : `translate(${x} ${y})`} rotate(180 1 3)`;
  return `<g transform="${t}">
      ${outlined('M-15 -6 Q -15 -16 -5 -16 L 7 -16 Q 17 -16 17 -6 L 17 12 Q 17 22 7 22 L -5 22 Q -15 22 -15 12 Z', SKIN)}
      ${fold('M17 -2 h-7 M17 6 h-8 M17 14 h-6')}
      ${fold('M-6 -14 Q -2 -4 -8 6')}
      <path d="M-11 18 Q 0 21 11 18" fill="none" stroke="${SKIN_SHADOW}" stroke-width="3" stroke-linecap="round"/>
    </g>`;
}

/** An arm hanging straight down the side, its sleeve ending in a cuff just below the belt. */
function hangingArm(x: number, flip: boolean): string {
  const lean = flip ? -2 : 2;
  return `${hangingFist(x + lean, 194, flip)}
    ${sleeve(`M ${x - lean} -14 C ${x - lean} 60, ${x} 130, ${x + lean} 180`, `M ${x + (flip ? -10 : 10)} 30 C ${x + (flip ? -10 : 10)} 90, ${x + (flip ? -10 : 10)} 140, ${x + (flip ? -9 : 9)} 168`)}
    <path d="M ${x + lean - 27} 180 H ${x + lean + 27}" stroke="${INK}" stroke-width="${LINE}" stroke-linecap="round"/>
    <path d="M ${x + lean - 20} 172 H ${x + lean + 20}" stroke="${INK}" stroke-width="${FOLD}" stroke-linecap="round" opacity="0.6"/>`;
}

/** The figure on a 256 × 256 grid: neck at the top edge, knees at the bottom. */
function figure(pose: Pose): string {
  const arms =
    pose === 'grip'
      ? sleeve('M 0 -14 C 0 70, 4 140, 28 176 S 58 202, 74 207', 'M 14 24 C 14 92, 18 140, 34 166') +
        sleeve('M 256 -14 C 256 70, 252 140, 228 176 S 198 202, 182 207', 'M 242 24 C 242 92, 238 140, 222 166') +
        fist(92, 214, false) +
        fist(166, 217, true)
      : hangingArm(16, false) + hangingArm(240, true);

  return `
    <!-- trousers, to the knees -->
    ${outlined('M46 184 L 125 184 L 121 270 L 52 270 Z', GI)}
    ${outlined('M131 184 L 210 184 L 204 270 L 135 270 Z', GI)}
    <path d="M100 190 L 121 190 L 118 270 L 104 270 Z" fill="${GI_SHADOW}"/>
    ${fold('M88 200 L 86 262')}${fold('M168 200 L 170 262')}
    <!-- jacket: flat white with one shadow down the right side, flaring below the belt -->
    ${outlined('M30 -10 L 226 -10 L 220 150 L 230 200 L 26 200 L 36 150 Z', GI)}
    <path d="M196 -10 L 226 -10 L 220 150 L 230 200 L 200 200 L 192 150 Z" fill="${GI_SHADOW}"/>
    ${outlined('M30 -10 L 226 -10 L 220 150 L 230 200 L 26 200 L 36 150 Z', 'none')}
    ${fold('M60 168 Q 58 184 54 196')}${fold('M88 168 Q 88 184 86 196')}${fold('M196 168 Q 198 184 202 196')}${fold('M168 168 Q 168 184 170 196')}
    <!-- neck and the V of the chest -->
    ${outlined('M100 -10 L 156 -10 L 128 54 Z', SKIN)}
    <path d="M114 -10 Q 128 20 142 -10 Z" fill="${SKIN_SHADOW}"/>
    <!-- lapels, left over right, with a line of stitching -->
    ${outlined('M142 -10 L 164 -10 L 137 62 L 124 48 Z', GI)}
    ${outlined('M90 -10 L 114 -10 L 182 146 L 156 146 Z', GI)}
    <path d="M103 -6 L 168 140" stroke="${INK}" stroke-width="2" stroke-dasharray="5 5" opacity="0.6"/>
    <!-- the black belt, its knot and its ends -->
    ${outlined('M36 139 L 220 139 Q 224 139 224 143 L 224 157 Q 224 161 220 161 L 36 161 Q 32 161 32 157 L 32 143 Q 32 139 36 139 Z', BELT)}
    <path d="M42 145 H 104 M152 145 H 214" stroke="${BELT_SHINE}" stroke-width="2.5" stroke-linecap="round"/>
    ${outlined('M117 157 L 100 157 L 80 234 L 101 239 Z', BELT)}
    ${outlined('M139 157 L 156 157 L 180 236 L 159 241 Z', BELT)}
    <path d="M108 164 L 92 228 M148 164 L 167 230" stroke="${BELT_SHINE}" stroke-width="2.5" stroke-linecap="round"/>
    ${outlined('M110 133 Q 128 123 146 133 L 148 165 Q 128 175 108 165 Z', BELT)}
    <path d="M113 141 Q 128 153 143 141 M113 158 Q 128 146 143 158" fill="none" stroke="${BELT_SHINE}" stroke-width="2.5" stroke-linecap="round"/>
    ${arms}`;
}

/** The mark as an SVG document. */
export function markSvg({ pose, tile, id = 'chiba' }: MarkOptions): string {
  const p = `${id}-`;
  const box = tile ? { x: 100, size: 824, rx: 186 } : { x: 0, size: 1024, rx: 230 };
  const scale = box.size / 256;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Chiba">
  <defs>
    <linearGradient id="${p}tile" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="#f9ad7c"/><stop offset="1" stop-color="#ea5f38"/></linearGradient>
    <clipPath id="${p}clip"><rect x="${box.x}" y="${box.x}" width="${box.size}" height="${box.size}" rx="${box.rx}"/></clipPath>
  </defs>
  ${tile ? `<rect x="${box.x}" y="${box.x}" width="${box.size}" height="${box.size}" rx="${box.rx}" fill="url(#${p}tile)"/>` : ''}
  <g clip-path="url(#${p}clip)">
    <g transform="translate(${box.x} ${box.x}) scale(${scale}) translate(${256 * 0.07} 0) scale(0.86 1)">${figure(pose)}</g>
  </g>
  ${tile ? `<rect x="${box.x + 6}" y="${box.x + 6}" width="${box.size - 12}" height="${box.size - 12}" rx="${box.rx - 6}" fill="none" stroke="${INK}" stroke-width="14" opacity="0.9"/>` : ''}
</svg>`;
}

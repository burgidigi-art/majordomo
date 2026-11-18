// A personal icon. It is kept in the data folder (~/.majordomo/icon), never in this repository, so a
// picture someone wants on their own Dock is not published along with the code.
//
// The picture is a square PNG drawn the way macOS expects an app icon: the tile sits inside a
// transparent margin, 824 of 1024 across. The Mac app uses it as is; the dashboard crops the margin.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** icns entry types by pixel size. A size listed twice serves both a 1x and a 2x slot. */
const ICNS_TYPES = { 16: ['icp4'], 32: ['icp5', 'ic11'], 64: ['ic12'], 128: ['ic07'], 256: ['ic08', 'ic13'], 512: ['ic09', 'ic14'], 1024: ['ic10'] };
const SIZES = Object.keys(ICNS_TYPES).map(Number);

export function dataDir(env = process.env, home = os.homedir()) {
  return env.MAJORDOMO_HOME ? path.resolve(env.MAJORDOMO_HOME) : path.join(home, '.majordomo');
}

/** Where a personal icon lives: the picture, a small copy for the dashboard, and the Mac icon file. */
export function iconPaths(dir) {
  const folder = path.join(dir, 'icon');
  return { folder, png: path.join(folder, 'icon.png'), small: path.join(folder, 'icon-256.png'), icns: path.join(folder, 'app.icns') };
}

/** Width and height of a PNG, read from its header. Throws if the file is not a PNG. */
export function pngSize(data) {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error('That file is not a PNG image. Save the icon as a .png and try again.');
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Packs PNGs into an icns file. `images` maps a pixel size to that size's PNG data. */
export function packIcns(images) {
  const entries = [];
  for (const size of SIZES) {
    if (!images[size]) continue;
    for (const type of ICNS_TYPES[size]) {
      const head = Buffer.alloc(8);
      head.write(type, 0, 'latin1');
      head.writeUInt32BE(images[size].length + 8, 4);
      entries.push(head, images[size]);
    }
  }
  const body = Buffer.concat(entries);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.error ? 1 : (result.status ?? 1) };
}

/**
 * Saves `file` as the personal icon. macOS ships `sips`, which makes the smaller sizes; where it is
 * missing the picture is used at its own size only, which macOS scales as needed.
 */
export function setIcon(file, { dir = dataDir(), run = defaultRun } = {}) {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    throw new Error(`Could not read ${file}. Check the file is still there.`);
  }
  const { width, height } = pngSize(data);
  if (width !== height) throw new Error(`The icon has to be square. This one is ${width} × ${height}.`);
  if (width < 256) throw new Error(`The icon is too small (${width} px). Use one at least 256 px across; 1024 is best.`);

  const paths = iconPaths(dir);
  const images = {};
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-'));
  try {
    for (const size of SIZES.filter((s) => s <= width)) {
      if (size === width) {
        images[size] = data;
        continue;
      }
      const out = path.join(work, `${size}.png`);
      const made = run('sips', ['-z', String(size), String(size), file, '--out', out]);
      if (made.status === 0 && fs.existsSync(out)) images[size] = fs.readFileSync(out);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  fs.mkdirSync(paths.folder, { recursive: true });
  fs.writeFileSync(paths.png, data);
  // The dashboard shows the icon at 34 px, so it gets a small copy when one could be made.
  fs.writeFileSync(paths.small, images[256] ?? data);
  // An icns needs at least one picture at a size it has a slot for.
  const forMac = Object.keys(images).length > 0;
  if (forMac) fs.writeFileSync(paths.icns, packIcns(images));
  else fs.rmSync(paths.icns, { force: true });
  return { ...paths, size: width, sizes: Object.keys(images).map(Number), forMac };
}

/** Goes back to the built-in icon. */
export function clearIcon({ dir = dataDir() } = {}) {
  fs.rmSync(iconPaths(dir).folder, { recursive: true, force: true });
}

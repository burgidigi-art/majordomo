import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempHome } from './helpers.ts';

const home = tempHome();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { app } = await import('../http.ts');
const icon = (await import(path.join(repo, 'bin/icon.mjs'))) as {
  setIcon: (file: string, o: Record<string, unknown>) => { icns: string; small: string; png: string; forMac: boolean; sizes: number[] };
  clearIcon: (o: Record<string, unknown>) => void;
  packIcns: (images: Record<number, Buffer>) => Buffer;
  pngSize: (data: Buffer) => { width: number; height: number };
  iconPaths: (dir: string) => { icns: string };
};
const mac = (await import(path.join(repo, 'bin/mac-app.mjs'))) as { plan: (o: Record<string, unknown>) => { icon: string } };

const local = { host: 'localhost:4317' };
const sample = fs.readFileSync(path.join(repo, 'assets', 'icon.png'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'majordomo-icon-'));

/** A PNG header claiming the given size. Enough for everything that only reads dimensions. */
function pngOf(width: number, height: number): Buffer {
  const data = Buffer.from(sample);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

/** The entry types in an icns, in order, checking each holds a PNG and the lengths add up. */
function icnsTypes(file: Buffer): string[] {
  assert.equal(file.subarray(0, 4).toString(), 'icns');
  assert.equal(file.readUInt32BE(4), file.length);
  const types: string[] = [];
  for (let at = 8; at < file.length; at += file.readUInt32BE(at + 4)) {
    types.push(file.subarray(at, at + 4).toString());
    assert.equal(file.subarray(at + 8, at + 12).toString('latin1'), '\x89PNG');
  }
  return types;
}

/** Stands in for macOS `sips`: "resizes" by writing a PNG that claims the requested size. */
const sips = (_cmd: string, args: string[]) => {
  fs.writeFileSync(args[5]!, pngOf(Number(args[1]), Number(args[1])));
  return { status: 0 };
};

async function brand(): Promise<string> {
  const res = await app.request('/api/brand.svg', { headers: local });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  return res.text();
}
const embedded = (svg: string) => Buffer.from(/base64,([^"]+)"/.exec(svg)![1]!, 'base64');

test('the dashboard mark is the built-in icon, cropped to its tile, until a personal one is set', async () => {
  const svg = await brand();
  assert.ok(svg.includes('viewBox="100 100 824 824"'), 'the margin macOS wants around an app icon is cropped away');
  assert.deepEqual(embedded(svg), sample);

  const file = path.join(tmp(), 'mine.png');
  fs.writeFileSync(file, pngOf(1024, 1024));
  const saved = icon.setIcon(file, { dir: home, run: sips });
  assert.ok(saved.png.startsWith(home), 'a personal icon is kept in the data folder, not in the repository');
  assert.equal(icon.pngSize(embedded(await brand())).width, 256, 'the dashboard is served the small copy');

  icon.clearIcon({ dir: home });
  assert.deepEqual(embedded(await brand()), sample, 'clearing it brings the built-in icon back');
});

test('a personal icon becomes a full Mac icon, and the app installer picks it up', () => {
  const dir = tmp();
  const file = path.join(dir, 'mine.png');
  fs.writeFileSync(file, pngOf(1024, 1024));

  const builtIn = mac.plan({ root: repo, home: dir, env: { MAJORDOMO_HOME: dir }, applications: [dir] }).icon;
  assert.equal(builtIn, path.join(repo, 'assets', '00Dojo.icns'));

  const saved = icon.setIcon(file, { dir, run: sips });
  assert.deepEqual(icnsTypes(fs.readFileSync(saved.icns)), ['icp4', 'icp5', 'ic11', 'ic12', 'ic07', 'ic08', 'ic13', 'ic09', 'ic14', 'ic10']);
  assert.equal(mac.plan({ root: repo, home: dir, env: { MAJORDOMO_HOME: dir }, applications: [dir] }).icon, saved.icns);
});

test('without a resizing tool the picture is used at its own size', () => {
  const dir = tmp();
  const file = path.join(dir, 'mine.png');
  fs.writeFileSync(file, pngOf(1024, 1024));
  const saved = icon.setIcon(file, { dir, run: () => ({ status: 1 }) });
  assert.deepEqual(icnsTypes(fs.readFileSync(saved.icns)), ['ic10']);
  assert.deepEqual(fs.readFileSync(saved.small), fs.readFileSync(file), 'the dashboard falls back to the full picture');

  // An odd size has no slot of its own, so there is nothing to build a Mac icon from.
  fs.writeFileSync(file, pngOf(700, 700));
  assert.equal(icon.setIcon(file, { dir, run: () => ({ status: 1 }) }).forMac, false);
  assert.ok(!fs.existsSync(icon.iconPaths(dir).icns), 'a stale Mac icon is not left behind');
});

test('pictures that cannot work are refused with the reason', () => {
  const dir = tmp();
  const file = path.join(dir, 'mine.png');
  const opts = { dir, run: sips };
  fs.writeFileSync(file, 'not an image');
  assert.throws(() => icon.setIcon(file, opts), /not a PNG/);
  fs.writeFileSync(file, pngOf(1024, 768));
  assert.throws(() => icon.setIcon(file, opts), /has to be square.*1024 × 768/);
  fs.writeFileSync(file, pngOf(120, 120));
  assert.throws(() => icon.setIcon(file, opts), /too small/);
  assert.throws(() => icon.setIcon(path.join(dir, 'missing.png'), opts), /Could not read/);
  assert.ok(!fs.existsSync(path.join(dir, 'icon')), 'nothing is saved when the picture is refused');
});

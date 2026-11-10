import fs from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from '../shared/types.ts';
import { DATA_DIR } from './db.ts';

/**
 * Where files the user sends in (photos, documents) are kept until the manager decides
 * which project they belong to.
 */
export const INBOX_DIR = path.join(DATA_DIR, 'inbox');

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  zip: 'application/zip',
};

/** Image types every vision model accepts. */
const VISION = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** Providers cap inline images at about 5 MB; stay under it. */
export const VISION_MAX_BYTES = 4_500_000;

export function mimeOf(name: string): string {
  return MIME[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

export function isVisionImage(mime: string, size: number): boolean {
  return VISION.has(mime) && size > 0 && size <= VISION_MAX_BYTES;
}

/** File names arrive from outside; keep only a plain, harmless base name. */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'file';
  // Cap the length but keep the extension, which is how the file's type is recognised later.
  const ext = path.extname(clean).slice(0, 12);
  const stem = clean.slice(0, clean.length - path.extname(clean).length) || 'file';
  return stem.slice(0, 80 - ext.length) + ext;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function saveToInbox(name: string, bytes: Buffer, mime?: string): Promise<Attachment> {
  await fs.mkdir(INBOX_DIR, { recursive: true, mode: 0o700 });
  const clean = safeName(name);
  let file = path.join(INBOX_DIR, `${stamp()}-${clean}`);
  for (let n = 2; await fs.stat(file).then(() => true, () => false); n++) {
    const ext = path.extname(clean);
    file = path.join(INBOX_DIR, `${stamp()}-${clean.slice(0, clean.length - ext.length)}-${n}${ext}`);
  }
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const type = mime && mime !== 'application/octet-stream' ? mime : mimeOf(clean);
  return { name: clean, path: file, mime: type, size: bytes.length, image: isVisionImage(type, bytes.length) };
}

/** Resolve a name or path to a file inside the inbox, or null if it is not one. */
export async function inboxFile(ref: string): Promise<string | null> {
  const target = path.resolve(INBOX_DIR, ref);
  const rel = path.relative(INBOX_DIR, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  const stat = await fs.stat(target).catch(() => null);
  return stat?.isFile() ? target : null;
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

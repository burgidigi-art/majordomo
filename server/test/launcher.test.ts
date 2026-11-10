import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The launcher is plain JavaScript so it can run before anything is built; load it by path.
const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/build-check.mjs');

test('the launcher rebuilds the dashboard only when its source is newer than the build', async () => {
  const { buildReason } = (await import(helper)) as { buildReason: (root: string) => string | null };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'majordomo-launcher-'));
  const write = (rel: string, at: number) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, at, at);
  };
  const now = Math.floor(Date.now() / 1000);

  write('web/src/components/Deep.tsx', now - 500);
  write('web/index.html', now - 500);
  write('shared/types.ts', now - 500);
  assert.equal(buildReason(root), 'first run');

  write('web/dist/index.html', now - 100);
  assert.equal(buildReason(root), null, 'a build newer than every source file is current');

  // What a `git pull` does: it rewrites the files that changed, making them newer than the build.
  write('web/src/components/Deep.tsx', now);
  assert.equal(buildReason(root), 'the source has changed since the last build');

  write('web/dist/index.html', now + 10);
  assert.equal(buildReason(root), null);
  write('shared/types.ts', now + 20);
  assert.equal(buildReason(root), 'the source has changed since the last build', 'types shared with the server count too');

  // Server-only changes do not need a dashboard build.
  write('web/dist/index.html', now + 30);
  write('server/index.ts', now + 40);
  assert.equal(buildReason(root), null);
});

// Tests for lib/cursor-auth.mjs: sign-in helpers, request headers, the app-session reader.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import {
  OAUTH_CLIENT_ID,
  checksum,
  connectHeaders,
  createAppSessionProvider,
  dashboardCookieCandidates,
  decodeJwt,
  decryptSafeStorage,
  importAppToken,
  jwtExpMs,
  jwtSub,
  looksLikeJwt,
  obfuscate,
  pkcePoll,
  pkceStart,
  refreshTokens,
  safeStorageKey,
} from '../lib/cursor-auth.mjs';

const jwt = (payload) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2lnbmF0dXJl`;
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() });

describe('checksum', () => {
  it('obfuscates with a running xor-and-add starting from 165', () => {
    // b0 = (0 ^ 165) + 0 = 165; b1 = (0 ^ 165) + 1 = 166; b2 = (1 ^ 166) + 2 = 169
    assert.deepEqual([...obfuscate(new Uint8Array([0, 0, 1]))], [165, 166, 169]);
  });

  it('encodes floor(now / 1e6) as six big-endian bytes, then appends the machine id', () => {
    const machineId = 'ab'.repeat(32);
    const now = 1_763_164_800_000; // t = 1763164 = 0x1AE75C
    const expected = Buffer.from(obfuscate(new Uint8Array([0, 0, 0, 0x1a, 0xe7, 0x5c]))).toString('base64url');
    const got = checksum(machineId, now);
    assert.equal(got, expected + machineId);
    assert.equal(expected.length, 8);
    assert.doesNotMatch(expected, /[=+/]/);
  });

  it('changes only when the 1000-second bucket changes', () => {
    assert.equal(checksum('m', 2_000_000_000), checksum('m', 2_000_999_999));
    assert.notEqual(checksum('m', 2_000_000_000), checksum('m', 2_001_000_000));
  });
});

describe('PKCE sign-in', () => {
  it('pkceStart derives the challenge from the verifier and builds the deep-control URL', () => {
    const start = pkceStart({ random: () => Buffer.alloc(32, 7), uuid: () => 'uuid-1', dashboardBase: 'https://example.test' });
    assert.equal(start.verifier, Buffer.alloc(32, 7).toString('base64url'));
    assert.equal(start.challenge, createHash('sha256').update(start.verifier).digest('base64url'));
    const url = new URL(start.url);
    assert.equal(url.origin + url.pathname, 'https://example.test/loginDeepControl');
    assert.equal(url.searchParams.get('challenge'), start.challenge);
    assert.equal(url.searchParams.get('uuid'), 'uuid-1');
    assert.equal(url.searchParams.get('mode'), 'login');
    assert.equal(url.searchParams.get('redirectTarget'), 'cli');
  });

  it('pkcePoll maps 404 to pending, 403 to refused and 200 to tokens', async () => {
    const urls = [];
    const fetchImpl = (status, body) => async (url) => {
      urls.push(url);
      return res(status, body);
    };
    assert.deepEqual(await pkcePoll({ uuid: 'u', verifier: 'v', apiBase: 'https://api.test', fetchImpl: fetchImpl(404, {}) }), { status: 'pending' });
    assert.deepEqual(await pkcePoll({ uuid: 'u', verifier: 'v', apiBase: 'https://api.test', fetchImpl: fetchImpl(403, {}) }), { status: 'refused' });
    const ok = await pkcePoll({ uuid: 'u', verifier: 'v', apiBase: 'https://api.test', fetchImpl: fetchImpl(200, { accessToken: 'a', refreshToken: 'r', authId: 'i' }) });
    assert.deepEqual(ok, { status: 'ok', accessToken: 'a', refreshToken: 'r', authId: 'i' });
    assert.equal(urls[0], 'https://api.test/auth/poll?uuid=u&verifier=v');
    await assert.rejects(pkcePoll({ uuid: 'u', verifier: 'v', fetchImpl: fetchImpl(500, {}) }), /HTTP 500/);
  });

  it('refreshTokens posts the app client id and keeps the old refresh token when none comes back', async () => {
    let sent;
    const fetchImpl = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return res(200, { access_token: 'new' });
    };
    const got = await refreshTokens('old-refresh', { apiBase: 'https://api.test', fetchImpl });
    assert.deepEqual(sent, { url: 'https://api.test/oauth/token', body: { client_id: OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'old-refresh' } });
    assert.deepEqual(got, { accessToken: 'new', refreshToken: 'old-refresh', shouldLogout: false });
  });

  it('refreshTokens reports shouldLogout instead of throwing', async () => {
    const got = await refreshTokens('r', { fetchImpl: async () => res(200, { shouldLogout: true }) });
    assert.equal(got.shouldLogout, true);
    await assert.rejects(refreshTokens('r', { fetchImpl: async () => res(200, {}) }), /no access_token/);
    await assert.rejects(refreshTokens('r', { fetchImpl: async () => res(400, {}) }), /HTTP 400/);
  });
});

describe('JWT helpers', () => {
  it('decode payloads, subjects and expiry without verifying', () => {
    const token = jwt({ sub: 'auth0|user_01ABC', exp: 1_800_000_000, email: 'a@b.c' });
    assert.equal(decodeJwt(token).email, 'a@b.c');
    assert.equal(jwtSub(token), 'auth0|user_01ABC');
    assert.equal(jwtExpMs(token), 1_800_000_000_000);
    assert.equal(decodeJwt('nonsense'), null);
    assert.equal(jwtSub('a.b.c'), null);
    assert.equal(jwtExpMs(jwt({ sub: 'x' })), null);
    assert.ok(looksLikeJwt(token));
    assert.equal(looksLikeJwt('eyJ only'), false);
  });

  it('the dashboard cookie tries the id after the bar first, then the whole subject', () => {
    const token = jwt({ sub: 'auth0|user_01ABC' });
    assert.deepEqual(dashboardCookieCandidates(token), [`WorkosCursorSessionToken=user_01ABC%3A%3A${token}`, `WorkosCursorSessionToken=auth0%7Cuser_01ABC%3A%3A${token}`]);
    assert.equal(dashboardCookieCandidates(jwt({ sub: 'plain' })).length, 1);
    assert.throws(() => dashboardCookieCandidates('not-a-jwt'), /sub claim/);
  });
});

describe('connectHeaders', () => {
  it('sends what the desktop app sends', () => {
    const h = connectHeaders({ token: 'tok', machineId: 'mid', clientVersion: '0.75.0', platform: 'win32', nowMs: 1e12, requestId: 'rid' });
    assert.equal(h.authorization, 'Bearer tok');
    assert.equal(h['connect-protocol-version'], '1');
    assert.equal(h['x-cursor-client-type'], 'sand');
    assert.equal(h['x-cursor-client-version'], '0.75.0');
    assert.equal(h['x-cursor-client-os'], 'win32');
    assert.equal(h['x-cursor-client-source'], 'sand-desktop');
    assert.equal(h['x-sand-box-namespace'], 'prod');
    assert.equal(h['x-request-id'], 'rid');
    assert.ok(h['x-cursor-checksum'].endsWith('mid'));
    assert.match(h['user-agent'], /Sand\/0\.75\.0 Safari/);
  });
});

function encryptLikeTheApp(text, password) {
  const cipher = createCipheriv('aes-128-cbc', safeStorageKey(password), Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

describe('the desktop app session (macOS)', () => {
  const password = 'keychain-pass';
  const token = jwt({ sub: 'auth0|user_9', exp: 1_900_000_000, email: 'me@example.com' });
  const secrets = (accessToken = token) =>
    JSON.stringify({
      version: 1,
      'cursor-accounts': JSON.stringify({
        active: 'scope1',
        accounts: { scope1: { 'cursor-access-token': encryptLikeTheApp(accessToken, password), 'cursor-refresh-token': encryptLikeTheApp('REFRESH-SECRET', password) } },
      }),
    });
  const exec = (cmd, args) => {
    assert.equal(cmd, '/usr/bin/security');
    assert.deepEqual(args.slice(0, 2), ['find-generic-password', '-w']);
    return `${password}\n`;
  };

  it('decryptSafeStorage round-trips v10 values and passes plaintext ones through', () => {
    const key = safeStorageKey(password);
    assert.equal(decryptSafeStorage(encryptLikeTheApp('hello', password), key), 'hello');
    assert.equal(decryptSafeStorage(`scoped:v1:${encryptLikeTheApp('scoped', password)}`, key), 'scoped');
    assert.equal(decryptSafeStorage('plaintext:v1:abc', key), 'abc');
    assert.throws(() => decryptSafeStorage(Buffer.from('v11xxxxxxxxxxxxxxxxx').toString('base64'), key), /Unsupported/);
  });

  it('importAppToken returns only the access token; the refresh token is never decrypted', () => {
    const got = importAppToken({ platform: 'darwin', home: '/Users/x', exec, readFile: () => secrets() });
    assert.deepEqual(got, { source: 'app', accessToken: token, refreshToken: null, email: 'me@example.com' });
    assert.ok(!JSON.stringify(got).includes('REFRESH-SECRET'));
  });

  it('explains itself on other platforms, on a missing file and on a wrong key', () => {
    assert.throws(() => importAppToken({ platform: 'linux' }), /macOS only/);
    const missing = () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    };
    assert.throws(() => importAppToken({ platform: 'darwin', exec, readFile: missing }), /sign in first/);
    assert.throws(() => importAppToken({ platform: 'darwin', exec: () => 'wrong-pass', readFile: () => secrets() }));
    assert.throws(() => importAppToken({ platform: 'darwin', exec, readFile: () => '{}' }), /cursor-accounts/);
  });

  it('the session provider caches in memory, re-reads near expiry and on reload', () => {
    let current = jwt({ sub: 'u', exp: 2000 });
    let reads = 0;
    let nowMs = 1_000_000;
    const provider = createAppSessionProvider({
      platform: 'darwin',
      exec,
      now: () => nowMs,
      readFile: () => {
        reads += 1;
        return secrets(current);
      },
    });
    assert.equal(provider.get().accessToken, current);
    provider.get();
    assert.equal(reads, 1, 'cached while the token is fresh');
    assert.equal(provider.reload(), null, 'reload reports no change when the app still holds the same token');
    current = jwt({ sub: 'u', exp: 9000 });
    assert.equal(provider.reload().accessToken, current);
    nowMs = 9000 * 1000 - 30_000; // inside the last minute
    const before = reads;
    provider.get();
    assert.equal(reads, before + 1);
  });
});

// Browser sign-in for plugins that need one (Notion, Asana, Linear, Figma and other hosted MCP servers).
// This is the MCP authorization flow, the same one Claude Code and Claude Desktop use: the plugin says
// where its sign-in service is, Majordomo registers itself there as an app, the user approves in their
// browser, and the service sends back a code that Majordomo trades for tokens. The tokens stay in
// ~/.majordomo/secrets.json and are renewed when they run out.
import { createHash, randomBytes } from 'node:crypto';
import { getPluginAuth, setPluginAuth, type PluginAuth } from './settings.ts';

let redirectBase = 'http://localhost:4317';
export function setPluginRedirectBase(url: string): void {
  redirectBase = url;
}
export const pluginRedirectUri = () => `${redirectBase}/api/plugins/oauth/callback`;

export class SignInError extends Error {}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The parameters of a WWW-Authenticate: Bearer header, e.g. resource_metadata="…", scope="…". */
export function parseAuthenticate(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const re = /([A-Za-z_][\w-]*)=(?:"((?:\\.|[^"\\])*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) out[m[1]!.toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]!;
  return out;
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Where to look for a server's metadata document, path-aware as RFC 8414 and RFC 9728 describe. */
function wellKnown(base: string, name: string, withPath = true): string[] {
  const u = new URL(base);
  const p = u.pathname.replace(/\/$/, '');
  const urls = [];
  if (withPath && p) urls.push(`${u.origin}/.well-known/${name}${p}`);
  urls.push(`${u.origin}/.well-known/${name}`);
  return urls;
}

export interface Discovered {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope?: string;
}

/**
 * Find out how to sign in to a plugin at `mcpUrl`. It is asked first; its 401 answer names a resource
 * metadata document, which names the sign-in service, whose own metadata lists its endpoints. Servers
 * that predate that arrangement keep everything at their own address, so that is the fallback.
 */
export async function discover(mcpUrl: string, authenticate?: string | null): Promise<Discovered> {
  const params = parseAuthenticate(authenticate ?? null);
  let prm: any = null;
  if (params.resource_metadata) prm = await getJson(params.resource_metadata);
  if (!prm) for (const url of wellKnown(mcpUrl, 'oauth-protected-resource')) if ((prm = await getJson(url))) break;

  const issuer: string = prm?.authorization_servers?.[0] ?? new URL(mcpUrl).origin;
  let meta: any = null;
  const candidates = [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')];
  // OpenID Connect also allows the document under the issuer's own path.
  if (new URL(issuer).pathname.replace(/\/$/, '')) candidates.push(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  for (const url of candidates) if ((meta = await getJson(url))) break;

  const origin = new URL(issuer).origin;
  const scope = params.scope ?? (Array.isArray(prm?.scopes_supported) && prm.scopes_supported.length ? prm.scopes_supported.join(' ') : undefined);
  return {
    resource: typeof prm?.resource === 'string' ? prm.resource : mcpUrl.replace(/#.*$/, ''),
    authorizationEndpoint: meta?.authorization_endpoint ?? `${origin}/authorize`,
    tokenEndpoint: meta?.token_endpoint ?? `${origin}/token`,
    registrationEndpoint: meta?.registration_endpoint ?? (meta ? undefined : `${origin}/register`),
    scope,
  };
}

/** Ask the plugin something, to get the 401 that says where its sign-in service is. */
async function probe(mcpUrl: string): Promise<{ status: number; authenticate: string | null }> {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'majordomo', version: '1' } } }),
      signal: AbortSignal.timeout(15_000),
    });
    void res.body?.cancel();
    return { status: res.status, authenticate: res.headers.get('www-authenticate') };
  } catch (err) {
    throw new SignInError(`Could not reach ${new URL(mcpUrl).host}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function register(endpoint: string, redirectUri: string): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Majordomo',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw new SignInError(`Could not register with the sign-in service: ${err instanceof Error ? err.message : String(err)}`);
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok || !json?.client_id) {
    throw new SignInError(`The sign-in service would not register Majordomo (${json?.error_description ?? json?.error ?? `HTTP ${res.status}`}).`);
  }
  return { clientId: String(json.client_id), clientSecret: json.client_secret ? String(json.client_secret) : undefined };
}

// ---------- the sign-in itself ----------

interface Pending {
  id: string;
  name: string;
  verifier: string;
  auth: PluginAuth;
  expires: number;
}
const pending = new Map<string, Pending>();

/** Start signing in: returns the address of the service's sign-in page, to open in the browser. */
export async function startPluginSignIn(id: string, name: string, mcpUrl: string): Promise<string> {
  const redirectUri = pluginRedirectUri();
  const { status, authenticate } = await probe(mcpUrl);
  if (status !== 401 && status !== 403) {
    if (status >= 200 && status < 300) throw new SignInError(`${name} does not ask for a sign-in; it should work as it is.`);
    throw new SignInError(`${name} answered HTTP ${status} instead of asking for a sign-in.`);
  }
  const found = await discover(mcpUrl, authenticate);
  // Keep the app registration from last time when it was made for this server and this return address.
  const before = getPluginAuth(id);
  let client: { clientId: string; clientSecret?: string };
  if (before && before.resource === found.resource && before.redirectUri === redirectUri) {
    client = { clientId: before.clientId, clientSecret: before.clientSecret };
  } else {
    if (!found.registrationEndpoint) {
      throw new SignInError(`${name}'s sign-in service does not let apps register themselves, so Majordomo cannot sign in to it yet.`);
    }
    client = await register(found.registrationEndpoint, redirectUri);
  }
  const auth: PluginAuth = {
    ...(before ?? {}),
    resource: found.resource,
    authorizationEndpoint: found.authorizationEndpoint,
    tokenEndpoint: found.tokenEndpoint,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri,
    scope: found.scope,
  };
  // Remember the registration now, so a sign-in that is abandoned does not register a second app.
  setPluginAuth(id, { ...auth, accessToken: before?.resource === found.resource ? before.accessToken : undefined, refreshToken: before?.resource === found.resource ? before.refreshToken : undefined });

  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(24));
  for (const [k, p] of pending) if (p.expires < Date.now()) pending.delete(k);
  pending.set(state, { id, name, verifier, auth, expires: Date.now() + 15 * 60_000 });

  const url = new URL(found.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('resource', found.resource);
  if (found.scope) url.searchParams.set('scope', found.scope);
  return url.toString();
}

async function tokenRequest(auth: PluginAuth, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams({ ...params, client_id: auth.clientId, resource: auth.resource });
  if (auth.clientSecret) body.set('client_secret', auth.clientSecret);
  const res = await fetch(auth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = Object.fromEntries(new URLSearchParams(text));
  }
  if (!res.ok || !json?.access_token) throw new SignInError(json?.error_description ?? json?.error ?? `The sign-in service answered HTTP ${res.status}.`);
  return json;
}

function withTokens(auth: PluginAuth, json: any): PluginAuth {
  return {
    ...auth,
    accessToken: String(json.access_token),
    refreshToken: json.refresh_token ? String(json.refresh_token) : auth.refreshToken,
    expiresAt: Number(json.expires_in) > 0 ? Date.now() + Number(json.expires_in) * 1000 : undefined,
  };
}

/** The browser came back with a code: trade it for tokens. Returns which plugin signed in. */
export async function finishPluginSignIn(query: { code?: string; state?: string; error?: string; error_description?: string }): Promise<{ id: string; name: string }> {
  const p = query.state ? pending.get(query.state) : undefined;
  if (!p || p.expires < Date.now()) throw new SignInError('This sign-in has expired or did not start here. Start it again from Settings → Plugin tools.');
  pending.delete(query.state!);
  if (query.error) throw new SignInError(`${p.name} did not sign in: ${query.error_description ?? query.error}.`);
  if (!query.code) throw new SignInError(`${p.name} sent no sign-in code back.`);
  const json = await tokenRequest(p.auth, { grant_type: 'authorization_code', code: query.code, redirect_uri: p.auth.redirectUri, code_verifier: p.verifier });
  setPluginAuth(p.id, withTokens(p.auth, json));
  return { id: p.id, name: p.name };
}

const refreshing = new Map<string, Promise<string | null>>();

/**
 * The token to send to a plugin, renewed first when it has run out (or when `force`, after the plugin
 * refused it). null means the user has to sign in again.
 */
export async function pluginAccessToken(id: string, force = false): Promise<string | null> {
  const auth = getPluginAuth(id);
  if (!auth?.accessToken) return null;
  const fresh = !auth.expiresAt || auth.expiresAt - 60_000 > Date.now();
  if (fresh && !force) return auth.accessToken;
  if (!auth.refreshToken) return force ? null : auth.accessToken;
  const running = refreshing.get(id);
  if (running) return running;
  const attempt = (async () => {
    try {
      const json = await tokenRequest(auth, { grant_type: 'refresh_token', refresh_token: auth.refreshToken! });
      const next = withTokens(auth, json);
      setPluginAuth(id, next);
      return next.accessToken!;
    } catch {
      // The sign-in is no longer good: forget the tokens and keep the app registration.
      setPluginAuth(id, { ...auth, accessToken: undefined, refreshToken: undefined, expiresAt: undefined });
      return null;
    } finally {
      refreshing.delete(id);
    }
  })();
  refreshing.set(id, attempt);
  return attempt;
}

export function pluginSignedIn(id: string): boolean {
  return !!getPluginAuth(id)?.accessToken;
}

export function signOutPlugin(id: string): void {
  setPluginAuth(id, null);
}

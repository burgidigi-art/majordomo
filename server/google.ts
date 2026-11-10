import { createHash, randomBytes } from 'node:crypto';
import type { GoogleStatus } from '../shared/types.ts';
import { sync } from './bus.ts';
import { getGoogleSecrets, setGoogleSecrets } from './settings.ts';

/**
 * Gmail and Google Calendar, read-only plus drafts.
 *
 * Google has no "drafts only" permission: the scope that lets an app save a draft
 * (gmail.compose) also lets it send. So the limit is enforced here instead. This module is the
 * only code that talks to Gmail, it exposes search, read and create-draft and nothing else, and
 * request() refuses any path that would send — so no tool, prompt or agent can reach a send call.
 */

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const AUTH = () => `${process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com'}/o/oauth2/v2/auth`;
const TOKEN = () => process.env.GOOGLE_TOKEN_BASE || 'https://oauth2.googleapis.com';
const GMAIL = () => `${process.env.GOOGLE_API_BASE || 'https://gmail.googleapis.com'}/gmail/v1/users/me`;
const CALENDAR = () => `${process.env.GOOGLE_API_BASE || 'https://www.googleapis.com'}/calendar/v3`;

let redirectBase = 'http://127.0.0.1:4317';
export function setRedirectBase(url: string): void {
  redirectBase = url;
}
const redirectUri = () => `${redirectBase}/api/google/callback`;

let lastError = '';
let access: { token: string; expiresAt: number } | null = null;
/** Sign-ins in progress, keyed by the `state` value sent to Google. */
const pending = new Map<string, { verifier: string; at: number }>();

export class GoogleError extends Error {}

export function googleStatus(): GoogleStatus {
  const s = getGoogleSecrets();
  return {
    configured: !!s?.clientId,
    connected: !!s?.refreshToken,
    email: s?.email ?? '',
    error: lastError,
  };
}

export const googleConnected = () => !!getGoogleSecrets()?.refreshToken;

function push(): void {
  sync({ google: googleStatus() });
}

// ---------- sign-in ----------

export function saveClient(clientId: string, clientSecret: string): void {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    throw new GoogleError('That does not look like a Google client ID. It ends in .apps.googleusercontent.com.');
  }
  if (!secret) throw new GoogleError('Paste the client secret too.');
  // New credentials mean any earlier sign-in belonged to a different app.
  setGoogleSecrets({ clientId: id, clientSecret: secret });
  access = null;
  lastError = '';
  push();
}

/** The Google page to send the user to. Uses PKCE and a one-time state value. */
export function startSignIn(): string {
  const s = getGoogleSecrets();
  if (!s?.clientId) throw new GoogleError('Save a Google client ID and secret first.');
  const state = randomBytes(18).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  pending.set(state, { verifier, at: Date.now() });
  const q = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    // offline + consent is what makes Google hand back a refresh token.
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return `${AUTH()}?${q}`;
}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  const res = await fetch(`${TOKEN()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const err = new GoogleError(json?.error_description || json?.error || `Google sign-in failed (HTTP ${res.status})`);
    (err as GoogleError & { code?: string }).code = json?.error;
    throw err;
  }
  return json;
}

/** Google sent the user back. Swap the one-time code for tokens and note whose account it is. */
export async function finishSignIn(query: { code?: string; state?: string; error?: string }): Promise<void> {
  try {
    if (query.error) throw new GoogleError(query.error === 'access_denied' ? 'Sign-in was cancelled at Google.' : `Google reported: ${query.error}`);
    const flow = query.state ? pending.get(query.state) : undefined;
    if (!flow || !query.code) throw new GoogleError('That sign-in link has expired or was not started here. Press Connect again.');
    pending.delete(query.state!);
    const s = getGoogleSecrets()!;
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code: query.code,
      client_id: s.clientId,
      client_secret: s.clientSecret,
      redirect_uri: redirectUri(),
      code_verifier: flow.verifier,
    });
    if (!tokens.refresh_token) throw new GoogleError('Google did not return a long-lived sign-in. Remove this app at myaccount.google.com/permissions and connect again.');
    access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 };
    setGoogleSecrets({ ...s, refreshToken: tokens.refresh_token });
    const profile = await request<{ emailAddress?: string }>(`${GMAIL()}/profile`);
    setGoogleSecrets({ ...s, refreshToken: tokens.refresh_token, email: profile.emailAddress ?? '' });
    lastError = '';
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
  push();
}

export async function disconnect(forgetClient: boolean): Promise<void> {
  const s = getGoogleSecrets();
  if (s?.refreshToken) {
    // Tell Google to cancel the sign-in too; failing to reach it must not block forgetting it here.
    await fetch(`${TOKEN()}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: s.refreshToken }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
  setGoogleSecrets(forgetClient || !s ? null : { clientId: s.clientId, clientSecret: s.clientSecret });
  access = null;
  lastError = '';
  push();
}

async function accessToken(force = false): Promise<string> {
  if (!force && access && access.expiresAt - Date.now() > 60_000) return access.token;
  const s = getGoogleSecrets();
  if (!s?.refreshToken) throw new GoogleError('Google is not connected. The user can connect it under Settings → Email & calendar.');
  try {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId, client_secret: s.clientSecret });
    access = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 };
    return access.token;
  } catch (err) {
    if ((err as { code?: string }).code === 'invalid_grant') {
      // The sign-in was revoked or has expired (apps left in Google's "Testing" mode expire weekly).
      setGoogleSecrets({ clientId: s.clientId, clientSecret: s.clientSecret, email: s.email });
      access = null;
      lastError = 'The Google sign-in has expired or was revoked. Connect again.';
      push();
      throw new GoogleError('The Google sign-in has expired. The user needs to reconnect under Settings → Email & calendar.');
    }
    throw err;
  }
}

// ---------- the only door to Google's APIs ----------

/** True for the Gmail endpoints that send mail (messages.send and drafts.send). */
export function isSendEndpoint(url: string): boolean {
  return /\/(messages|drafts)\/send\b/.test(new URL(url).pathname);
}

async function request<T>(url: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  // Nothing in this harness may send mail. Refuse the send endpoints outright, whatever asked.
  if (isSendEndpoint(url)) throw new GoogleError('Sending mail is not permitted.');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${await accessToken(attempt > 0)}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && attempt === 0) continue;
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) throw new GoogleError(`Google said: ${json?.error?.message ?? `HTTP ${res.status}`}`);
    return json as T;
  }
}

// ---------- Gmail ----------

export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface Mail extends MailSummary {
  cc: string;
  body: string;
  attachments: { name: string; size: number }[];
  messageId: string;
  references: string;
  replyTo: string;
}

const header = (payload: any, name: string): string =>
  (payload?.headers ?? []).find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value ?? '';

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Find the readable text of a message: plain text if it has any, otherwise its HTML flattened. */
function bodyOf(payload: any): string {
  const found: { plain: string[]; html: string[] } = { plain: [], html: [] };
  const walk = (part: any) => {
    if (!part) return;
    const data = part.body?.data;
    if (data && !part.filename) {
      const text = Buffer.from(data, 'base64url').toString('utf8');
      if (part.mimeType === 'text/plain') found.plain.push(text);
      else if (part.mimeType === 'text/html') found.html.push(text);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return (found.plain.length ? found.plain.join('\n') : found.html.map(htmlToText).join('\n')).trim();
}

function attachmentsOf(payload: any): { name: string; size: number }[] {
  const out: { name: string; size: number }[] = [];
  const walk = (part: any) => {
    if (part?.filename) out.push({ name: part.filename, size: part.body?.size ?? 0 });
    for (const child of part?.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

function summarise(m: any): MailSummary {
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(m.payload, 'From'),
    to: header(m.payload, 'To'),
    subject: header(m.payload, 'Subject') || '(no subject)',
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : header(m.payload, 'Date'),
    snippet: m.snippet ?? '',
    unread: (m.labelIds ?? []).includes('UNREAD'),
  };
}

function full(m: any): Mail {
  return {
    ...summarise(m),
    cc: header(m.payload, 'Cc'),
    body: bodyOf(m.payload),
    attachments: attachmentsOf(m.payload),
    messageId: header(m.payload, 'Message-ID'),
    references: header(m.payload, 'References'),
    replyTo: header(m.payload, 'Reply-To'),
  };
}

export async function searchMail(query: string, max: number): Promise<{ total: number; messages: MailSummary[] }> {
  const q = new URLSearchParams({ q: query, maxResults: String(max) });
  const list = await request<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(`${GMAIL()}/messages?${q}`);
  const ids = (list.messages ?? []).map((m) => m.id);
  const fields = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';
  const messages = await Promise.all(ids.map((id) => request<any>(`${GMAIL()}/messages/${encodeURIComponent(id)}?${fields}`)));
  return { total: list.resultSizeEstimate ?? ids.length, messages: messages.map(summarise) };
}

export async function readMail(id: string, wholeThread: boolean): Promise<Mail[]> {
  const message = await request<any>(`${GMAIL()}/messages/${encodeURIComponent(id)}?format=full`);
  if (!wholeThread) return [full(message)];
  const thread = await request<{ messages?: any[] }>(`${GMAIL()}/threads/${encodeURIComponent(message.threadId)}?format=full`);
  return (thread.messages ?? [message]).map(full);
}

/** One header line. Line breaks are removed so a value can never smuggle in a second header. */
function headerLine(name: string, value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  // Non-ASCII subjects and names are sent as RFC 2047 encoded words.
  const needsEncoding = /[^\x20-\x7e]/.test(clean);
  return `${name}: ${needsEncoding && name === 'Subject' ? `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=` : clean}`;
}

export interface DraftInput {
  to?: string;
  cc?: string;
  subject?: string;
  body: string;
  /** Make the draft a reply in this message's conversation. */
  replyTo?: string;
}

/** Save a draft in the user's Gmail. It is never sent from here: sending is theirs to do, in Gmail. */
export async function createDraft(input: DraftInput): Promise<{ id: string; to: string; subject: string; reply: boolean }> {
  let { to = '', subject = '' } = input;
  let threadId: string | undefined;
  const headers: string[] = [];
  if (input.replyTo) {
    const original = (await readMail(input.replyTo, false))[0];
    threadId = original.threadId;
    to ||= original.replyTo || original.from;
    subject ||= /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    if (original.messageId) {
      headers.push(headerLine('In-Reply-To', original.messageId));
      headers.push(headerLine('References', `${original.references} ${original.messageId}`.trim()));
    }
  }
  if (!to.trim()) throw new GoogleError('A draft needs a recipient: give `to`, or `reply_to_message_id` to reply to a message.');
  // Flatten once, so what is stored and what is reported back are the same text.
  const flat = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
  to = flat(to);
  subject = flat(subject) || '(no subject)';
  const mime = [
    headerLine('To', to),
    ...(input.cc?.trim() ? [headerLine('Cc', input.cc)] : []),
    headerLine('Subject', subject),
    ...headers,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(input.body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
  const draft = await request<{ id: string }>(`${GMAIL()}/drafts`, {
    method: 'POST',
    body: { message: { raw: Buffer.from(mime, 'utf8').toString('base64url'), ...(threadId ? { threadId } : {}) } },
  });
  return { id: draft.id, to, subject, reply: !!threadId };
}

// ---------- Calendar ----------

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  attendees: string[];
  description: string;
  status: string;
}

export async function listEvents(opts: { from: Date; to: Date; query?: string; max: number; calendar?: string }): Promise<CalendarEvent[]> {
  const q = new URLSearchParams({
    timeMin: opts.from.toISOString(),
    timeMax: opts.to.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(opts.max),
  });
  if (opts.query) q.set('q', opts.query);
  const res = await request<{ items?: any[] }>(`${CALENDAR()}/calendars/${encodeURIComponent(opts.calendar || 'primary')}/events?${q}`);
  return (res.items ?? []).map((e) => ({
    title: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    allDay: !e.start?.dateTime,
    location: e.location ?? '',
    attendees: (e.attendees ?? []).map((a: any) => a.displayName || a.email).filter(Boolean),
    description: e.description ? htmlToText(String(e.description)) : '',
    status: e.status ?? '',
  }));
}

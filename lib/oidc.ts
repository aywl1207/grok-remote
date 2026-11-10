// Authentik / generic OIDC authorization-code + PKCE.
// Off unless OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET are set.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveOidcRuntime } from './auth-settings.js';
import { oidcPending } from './oidc-pending.js';

export interface OidcUser {
  sub: string;
  email: string;
  name: string;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  cookieSecret: Buffer;
  allowedEmails: Set<string> | null;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

const SESS_COOKIE = 'gr_sess';
const PEND_COOKIE = 'gr_oidc';
const SESS_MAX_AGE = 7 * 24 * 3600;
const PEND_MAX_AGE = 600;

let cached: { cfg: OidcConfig; disco: Discovery } | null | undefined;

export function oidcEnabled(): boolean {
  return !!resolveOidcRuntime();
}

export function loadOidcConfig(): OidcConfig | null {
  const resolved = resolveOidcRuntime();
  if (!resolved) return null;
  const allow = String(resolved.allowedEmails || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    issuer: resolved.issuer,
    clientId: resolved.clientId,
    clientSecret: resolved.clientSecret,
    redirectUri: resolved.redirectUri,
    cookieSecret: cookieKey(),
    allowedEmails: allow.length ? new Set(allow) : null,
  };
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function pkceChallenge(verifier: string): string {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

export function signPayload(secret: Buffer, payload: unknown, maxAgeSec: number): string {
  const body = { exp: Math.floor(Date.now() / 1000) + maxAgeSec, payload };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const enc = b64url(raw);
  const mac = b64url(crypto.createHmac('sha256', secret).update(enc).digest());
  return `${enc}.${mac}`;
}

export function verifyPayload<T>(secret: Buffer, token: string): T | null {
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const enc = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expect = b64url(crypto.createHmac('sha256', secret).update(enc).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const pad = enc.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(pad + '==='.slice((pad.length + 3) % 4), 'base64').toString('utf8');
    const body = JSON.parse(json) as { exp?: number; payload?: T };
    if (!body || typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
    return (body.payload ?? null) as T | null;
  } catch {
    return null;
  }
}

function cookieKey(): Buffer {
  const fromEnv = process.env['OIDC_COOKIE_SECRET'];
  if (fromEnv && fromEnv.length >= 16) return crypto.createHash('sha256').update(fromEnv).digest();
  const file = path.join(os.homedir(), '.grok-remote', 'oidc-cookie-key');
  try {
    const raw = fs.readFileSync(file);
    if (raw.length >= 32) return raw.subarray(0, 32);
  } catch { /* create */ }
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
  } catch { /* ephemeral */ }
  return key;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function cookieFlags(): string {
  return 'Path=/; HttpOnly; Secure; SameSite=Lax';
}

function cookieExpires(maxAge: number): string {
  return new Date(Date.now() + Math.max(0, maxAge) * 1000).toUTCString();
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number): void {
  const prev = res.getHeader('Set-Cookie');
  const next = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Expires=${cookieExpires(maxAge)}; ${cookieFlags()}`;
  if (!prev) res.setHeader('Set-Cookie', next);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, next]);
  else res.setHeader('Set-Cookie', [String(prev), next]);
}

function clearCookie(res: ServerResponse, name: string): void {
  setCookie(res, name, '', 0);
}

export function readSession(req: IncomingMessage, cfg: OidcConfig): OidcUser | null {
  const tok = parseCookies(req)[SESS_COOKIE];
  if (!tok) return null;
  return verifyPayload<OidcUser>(cfg.cookieSecret, tok);
}

function isPublicPath(url: string): boolean {
  if (url === '/api/health' || url === '/api/hello') return true;
  if (url.startsWith('/auth/')) return true;
  return false;
}

function wantsHtml(req: IncomingMessage): boolean {
  const acc = String(req.headers.accept || '');
  const dest = String(req.headers['sec-fetch-dest'] || '');
  if (dest === 'document') return true;
  return acc.includes('text/html') && !acc.includes('application/json');
}

async function discovery(cfg: OidcConfig): Promise<Discovery> {
  if (cached && cached.cfg.issuer === cfg.issuer) return cached.disco;
  const url = `${cfg.issuer}/.well-known/openid-configuration`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`oidc discovery ${r.status} from ${url}`);
  const j = await r.json() as Discovery;
  if (!j.authorization_endpoint || !j.token_endpoint || !j.userinfo_endpoint) {
    throw new Error('oidc discovery missing endpoints');
  }
  cached = { cfg, disco: j };
  return j;
}

export async function handleOidcRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  cfg: OidcConfig,
): Promise<boolean> {
  if (url === '/auth/login' && (req.method === 'GET' || req.method === 'HEAD')) {
    await beginLogin(req, res, cfg);
    return true;
  }
  if (url === '/auth/callback' && req.method === 'GET') {
    await finishLogin(req, res, cfg);
    return true;
  }
  if (url === '/auth/logout' && (req.method === 'GET' || req.method === 'POST')) {
    clearCookie(res, SESS_COOKIE);
    clearCookie(res, PEND_COOKIE);
    res.writeHead(302, { Location: '/' });
    res.end();
    return true;
  }
  if (url === '/auth/me' && req.method === 'GET') {
    const u = readSession(req, cfg);
    if (!u) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, user: u }));
    return true;
  }
  return false;
}

export function enforceOidc(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  cfg: OidcConfig,
): OidcUser | null {
  if (isPublicPath(url)) return { sub: '', email: '', name: '' };
  const user = readSession(req, cfg);
  if (user) return user;
  if (wantsHtml(req)) {
    const next = encodeURIComponent((req.url || '/').split('#')[0] || '/');
    res.writeHead(302, { Location: `/auth/login?next=${next}` });
    res.end();
    return null;
  }
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'unauthorized', login: '/auth/login' }));
  return null;
}


function esc(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (ch) => (
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[ch] || ch
  ));
}

function htmlAuth(
  res: ServerResponse,
  code: number,
  title: string,
  message: string,
  href: string,
  opts?: { auto?: boolean },
): void {
  const safeHref = href.startsWith('/') && !href.startsWith('//') ? href : '/';
  const auto = opts && opts.auto
    ? `<meta http-equiv="refresh" content="0;url=${esc(safeHref)}">
<script>location.replace(${JSON.stringify(safeHref)});</script>`
    : '';
  const action = opts && opts.auto ? 'Continue' : 'Try Again';
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${auto}
<style>
body{font-family:system-ui,sans-serif;background:#0c1117;color:#e6edf3;margin:0;padding:32px 20px;line-height:1.45}
a{display:inline-block;margin-top:16px;padding:10px 16px;background:#1f6feb;color:#fff;text-decoration:none;border-radius:8px}
p{color:#9aa4b2}
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p>${esc(message)}</p>
<p><a href="${esc(safeHref)}">${esc(action)}</a></p>
</body>
</html>`;
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function beginLogin(req: IncomingMessage, res: ServerResponse, cfg: OidcConfig): Promise<void> {
  const disco = await discovery(cfg);
  const qs = new URL(req.url || '/', 'http://local').searchParams;
  const rawNext = qs.get('next') || '/';
  const returnTo = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  const pending: Pending = {
    state: b64url(crypto.randomBytes(16)),
    verifier: b64url(crypto.randomBytes(32)),
    nonce: b64url(crypto.randomBytes(16)),
    returnTo,
  };
  oidcPending.save(pending, PEND_MAX_AGE * 1000);
  // Cookie is a fallback. iPad Safari often drops it on the bounce to Authentik.
  setCookie(res, PEND_COOKIE, signPayload(cfg.cookieSecret, pending, PEND_MAX_AGE), PEND_MAX_AGE);
  const auth = new URL(disco.authorization_endpoint);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', cfg.clientId);
  auth.searchParams.set('redirect_uri', cfg.redirectUri);
  auth.searchParams.set('scope', 'openid email profile');
  auth.searchParams.set('state', pending.state);
  auth.searchParams.set('nonce', pending.nonce);
  auth.searchParams.set('code_challenge', pkceChallenge(pending.verifier));
  auth.searchParams.set('code_challenge_method', 'S256');
  res.writeHead(302, { Location: auth.toString() });
  res.end();
}

async function finishLogin(req: IncomingMessage, res: ServerResponse, cfg: OidcConfig): Promise<void> {
  const qs = new URL(req.url || '/', 'http://local').searchParams;
  const code = qs.get('code') || '';
  const state = qs.get('state') || '';
  const err = qs.get('error');
  const pendTok = parseCookies(req)[PEND_COOKIE];
  const fromFile = state ? oidcPending.take(state) : null;
  const fromCookie = pendTok ? verifyPayload<Pending>(cfg.cookieSecret, pendTok) : null;
  const pending = fromFile || fromCookie;
  if (!fromFile && fromCookie) {
    process.stderr.write('[oidc] callback used cookie pending; server file missed\n');
  } else if (!fromCookie && fromFile) {
    process.stderr.write('[oidc] callback used server pending; Safari dropped gr_oidc cookie\n');
  }
  clearCookie(res, PEND_COOKIE);
  if (err) {
    htmlAuth(res, 401, 'Sign-in Failed', `Authentik returned ${esc(err)}.`, '/auth/login');
    return;
  }
  if (!code || !pending || pending.state !== state) {
    htmlAuth(res, 400, 'Sign-in Failed', 'This iPad or browser dropped the sign-in cookie on the way back from Authentik. Try again from this page.', '/auth/login');
    return;
  }
  const disco = await discovery(cfg);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: pending.verifier,
  });
  const tokRes = await fetch(disco.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  const tok = await tokRes.json() as { access_token?: string; error?: string; error_description?: string };
  if (!tokRes.ok || !tok.access_token) {
    htmlAuth(res, 401, 'Sign-in Failed', `Token exchange failed: ${tok.error_description || tok.error || tokRes.status}.`, '/auth/login');
    return;
  }
  const uiRes = await fetch(disco.userinfo_endpoint, {
    headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/json' },
  });
  const ui = await uiRes.json() as { sub?: string; email?: string; name?: string; preferred_username?: string };
  if (!uiRes.ok || !ui.sub) {
    htmlAuth(res, 401, 'Sign-in Failed', 'Could not read user info from Authentik.', '/auth/login');
    return;
  }
  const user: OidcUser = {
    sub: String(ui.sub),
    email: String(ui.email || '').toLowerCase(),
    name: String(ui.name || ui.preferred_username || ui.email || ui.sub),
  };
  if (cfg.allowedEmails && (!user.email || !cfg.allowedEmails.has(user.email))) {
    htmlAuth(res, 403, 'Sign-in Blocked', 'This account is not allowed to use Grok Remote.', '/auth/login');
    return;
  }
  setCookie(res, SESS_COOKIE, signPayload(cfg.cookieSecret, user, SESS_MAX_AGE), SESS_MAX_AGE);
  const next = pending.returnTo || '/';
  // 200 document + cookie is more reliable on iPad than Set-Cookie on a 302.
  htmlAuth(res, 200, 'Signed In', 'Continuing to Grok Remote.', next, { auto: true });
}

import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadOidcConfig, readSession, type OidcUser } from './oidc.js';
import {
  applyBasicAuth,
  loadAuthFile,
  probeBasicEnabled,
  probeBasicUsername,
  resolveOidcRuntime,
  saveAuthFile,
  writeOidcEnvFile,
} from './auth-settings.js';

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid json');
  return parsed as Record<string, unknown>;
}

function publicStatus(user: OidcUser | null): Record<string, unknown> {
  const file = loadAuthFile();
  const resolved = resolveOidcRuntime();
  let basicEnabled = file.basic.enabled;
  if (basicEnabled == null) {
    try { basicEnabled = probeBasicEnabled(); } catch { basicEnabled = false; }
  }
  let username = file.basic.username;
  if (!username) {
    try { username = probeBasicUsername(); } catch { username = 'opc'; }
  }
  return {
    ok: true,
    user: user && user.sub ? { sub: user.sub, email: user.email, name: user.name } : null,
    oidc: {
      enabled: !!resolved,
      issuer: resolved?.issuer || file.oidc.issuer || process.env['OIDC_ISSUER'] || '',
      clientId: resolved?.clientId || file.oidc.clientId || process.env['OIDC_CLIENT_ID'] || '',
      clientSecretSet: !!(resolved?.clientSecret || file.oidc.clientSecret || process.env['OIDC_CLIENT_SECRET']),
      redirectUri: resolved?.redirectUri || file.oidc.redirectUri || 'https://grok.aykc.cloud/auth/callback',
      allowedEmails: resolved?.allowedEmails || file.oidc.allowedEmails || '',
      source: resolved?.source || 'off',
    },
    basic: {
      enabled: !!basicEnabled,
      username: username || 'opc',
    },
  };
}

export async function handleAuthApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  if (url === '/api/auth' && method === 'GET') {
    const cfg = loadOidcConfig();
    const user = cfg ? readSession(req, cfg) : null;
    send(res, 200, publicStatus(user));
    return true;
  }

  if (url === '/api/auth/oidc' && method === 'PATCH') {
    const body = await readJson(req);
    const file = loadAuthFile();
    if (typeof body.enabled === 'boolean') file.oidc.enabled = body.enabled;
    if (typeof body.issuer === 'string') file.oidc.issuer = body.issuer.trim();
    if (typeof body.clientId === 'string') file.oidc.clientId = body.clientId.trim();
    if (typeof body.redirectUri === 'string') file.oidc.redirectUri = body.redirectUri.trim();
    if (typeof body.allowedEmails === 'string') file.oidc.allowedEmails = body.allowedEmails.trim();
    if (typeof body.clientSecret === 'string' && body.clientSecret.trim()) {
      file.oidc.clientSecret = body.clientSecret.trim();
    }
    if (file.oidc.enabled && (!file.oidc.issuer || !file.oidc.clientId || !(file.oidc.clientSecret || process.env['OIDC_CLIENT_SECRET']))) {
      send(res, 400, { ok: false, error: 'Issuer, client ID, and client secret are required to enable OAuth.' });
      return true;
    }
    if (file.oidc.enabled && file.oidc.issuer) {
      const disco = `${file.oidc.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
      try {
        const r = await fetch(disco, { headers: { accept: 'application/json' } });
        if (!r.ok) {
          send(res, 400, { ok: false, error: `Discovery failed (${r.status}) for ${disco}` });
          return true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send(res, 400, { ok: false, error: `Discovery failed: ${msg}` });
        return true;
      }
    }
    saveAuthFile(file);
    const resolved = resolveOidcRuntime();
    if (resolved) {
      try { writeOidcEnvFile(resolved); } catch { /* home file is enough for next boot */ }
    }
    send(res, 200, publicStatus(null));
    return true;
  }

  if (url === '/api/auth/basic' && method === 'PATCH') {
    const body = await readJson(req);
    const file = loadAuthFile();
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : !!file.basic.enabled;
    if (typeof body.username === 'string' && body.username.trim()) file.basic.username = body.username.trim();
    const password = typeof body.password === 'string' ? body.password : '';
    try {
      applyBasicAuth(enabled, file.basic.username, password || undefined);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send(res, 400, { ok: false, error: msg });
      return true;
    }
    file.basic.enabled = enabled;
    saveAuthFile(file);
    send(res, 200, publicStatus(null));
    return true;
  }

  return false;
}

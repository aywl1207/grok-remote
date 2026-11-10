// PKCE/state for OIDC must not live only in a cookie.
// iPad Safari bounce-tracking drops Set-Cookie on the 302 to Authentik.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface OidcPending {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  exp: number;
}

export function defaultPendingDir(): string {
  return path.join(os.homedir(), '.grok-remote', 'oidc-pending');
}

function safeState(state: string): string {
  return String(state || '').replace(/[^A-Za-z0-9_-]/g, '');
}

export function createPendingStore(dir: string) {
  const fileFor = (state: string): string | null => {
    const id = safeState(state);
    if (id.length < 8 || id !== state) return null;
    return path.join(dir, `${id}.json`);
  };

  const sweep = (now = Date.now()): void => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(dir, name);
      try {
        const rec = JSON.parse(fs.readFileSync(fp, 'utf8')) as { exp?: number };
        if (typeof rec.exp !== 'number' || rec.exp < now) fs.unlinkSync(fp);
      } catch {
        try { fs.unlinkSync(fp); } catch { /* ignore */ }
      }
    }
  };

  const save = (pending: Omit<OidcPending, 'exp'>, ttlMs: number, now = Date.now()): void => {
    const fp = fileFor(pending.state);
    if (!fp) return;
    fs.mkdirSync(dir, { recursive: true });
    const rec: OidcPending = { ...pending, exp: now + ttlMs };
    fs.writeFileSync(fp, JSON.stringify(rec), { mode: 0o600 });
    sweep(now);
  };

  const take = (state: string, now = Date.now()): OidcPending | null => {
    const fp = fileFor(state);
    if (!fp) return null;
    try {
      const rec = JSON.parse(fs.readFileSync(fp, 'utf8')) as OidcPending;
      try { fs.unlinkSync(fp); } catch { /* ignore */ }
      if (!rec || rec.state !== state) return null;
      if (typeof rec.exp !== 'number' || rec.exp < now) return null;
      if (!rec.verifier || !rec.nonce) return null;
      return rec;
    } catch {
      return null;
    }
  };

  return { save, take, sweep };
}

export const oidcPending = createPendingStore(defaultPendingDir());

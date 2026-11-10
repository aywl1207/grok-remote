// Persist sign-in settings and apply nginx basic auth.
// OIDC fields also live here so the UI can toggle without editing compose.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(os.homedir(), '.grok-remote');
const AUTH_FILE = path.join(ROOT, 'auth.json');
const OIDC_ENV = path.join(ROOT, 'secrets', 'oidc.env');

export interface OidcAuthFields {
  enabled: boolean | null;
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedEmails: string;
}

export interface BasicAuthFields {
  enabled: boolean | null;
  username: string;
}

export interface AuthFile {
  oidc: OidcAuthFields;
  basic: BasicAuthFields;
}

export interface ResolvedOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedEmails: string;
  source: 'file' | 'env';
}

const DEFAULT_REDIRECT = 'https://grok.aykc.cloud/auth/callback';

export function emptyAuthFile(): AuthFile {
  return {
    oidc: {
      enabled: null,
      issuer: '',
      clientId: '',
      clientSecret: '',
      redirectUri: DEFAULT_REDIRECT,
      allowedEmails: '',
    },
    basic: { enabled: null, username: 'opc' },
  };
}

export function loadAuthFile(): AuthFile {
  const base = emptyAuthFile();
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as Partial<AuthFile>;
    if (raw.oidc && typeof raw.oidc === 'object') base.oidc = { ...base.oidc, ...raw.oidc };
    if (raw.basic && typeof raw.basic === 'object') base.basic = { ...base.basic, ...raw.basic };
  } catch { /* missing */ }
  return base;
}

export function saveAuthFile(next: AuthFile): void {
  fs.mkdirSync(ROOT, { recursive: true });
  const out: AuthFile = {
    oidc: { ...next.oidc, clientSecret: next.oidc.clientSecret || '' },
    basic: { ...next.basic },
  };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(out, null, 2));
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch { /* ignore */ }
}

export function resolveOidcRuntime(env: NodeJS.ProcessEnv = process.env, file?: AuthFile): ResolvedOidc | null {
  const auth = file || loadAuthFile();
  if (auth.oidc.enabled === false) return null;
  const issuer = String(auth.oidc.issuer || env['OIDC_ISSUER'] || '').replace(/\/+$/, '');
  const clientId = String(auth.oidc.clientId || env['OIDC_CLIENT_ID'] || '').trim();
  const clientSecret = String(auth.oidc.clientSecret || env['OIDC_CLIENT_SECRET'] || '').trim();
  const redirectUri = String(auth.oidc.redirectUri || env['OIDC_REDIRECT_URI'] || DEFAULT_REDIRECT).trim();
  const allowedEmails = String(auth.oidc.allowedEmails || env['OIDC_ALLOWED_EMAILS'] || '').trim();
  const fromFile = !!(auth.oidc.issuer || auth.oidc.clientId);
  if (!issuer || !clientId || !clientSecret) return null;
  if (auth.oidc.enabled === null && !(env['OIDC_ISSUER'] && env['OIDC_CLIENT_ID'] && env['OIDC_CLIENT_SECRET'])) {
    return null;
  }
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    allowedEmails,
    source: fromFile ? 'file' : 'env',
  };
}

export function writeOidcEnvFile(resolved: ResolvedOidc, cookieSecret?: string): void {
  fs.mkdirSync(path.dirname(OIDC_ENV), { recursive: true });
  const lines = [
    `OIDC_ISSUER=${resolved.issuer}`,
    `OIDC_CLIENT_ID=${resolved.clientId}`,
    `OIDC_CLIENT_SECRET=${resolved.clientSecret}`,
    `OIDC_REDIRECT_URI=${resolved.redirectUri}`,
  ];
  if (resolved.allowedEmails) lines.push(`OIDC_ALLOWED_EMAILS=${resolved.allowedEmails}`);
  const cookie = cookieSecret || process.env['OIDC_COOKIE_SECRET'] || '';
  if (cookie) lines.push(`OIDC_COOKIE_SECRET=${cookie}`);
  fs.writeFileSync(OIDC_ENV, lines.join('\n') + '\n', { mode: 0o600 });
  dockerWrite('/opt/stacks/grok-remote/secrets/oidc.env', lines.join('\n') + '\n');
}

export function nginxProxyConf(basicEnabled: boolean): string {
  const auth = basicEnabled
    ? `        auth_basic "Grok Build Remote";\n        auth_basic_user_file /etc/nginx/htpasswd;`
    : `        auth_basic off;`;
  return `map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_tokens off;
    client_max_body_size 32m;

    location = /healthz {
        access_log off;
        auth_basic off;
        default_type text/plain;
        return 200 "ok\\n";
    }

    location / {
${auth}

        proxy_pass http://grok-remote:7910;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
`;
}

export function hashBasicPassword(password: string): string {
  const r = spawnSync('openssl', ['passwd', '-apr1', password], { encoding: 'utf8' });
  const hash = (r.stdout || '').trim();
  if (r.status !== 0 || !hash.startsWith('$apr1$')) {
    throw new Error(r.stderr || 'openssl passwd failed');
  }
  return hash;
}

export function probeBasicEnabled(): boolean {
  const r = spawnSync('docker', ['exec', 'grok-remote-web', 'grep', 'auth_basic "', '/etc/nginx/conf.d/default.conf'], {
    encoding: 'utf8',
  });
  return r.status === 0 && /auth_basic\s+"/.test(r.stdout || '');
}

export function probeBasicUsername(): string {
  const r = spawnSync('docker', ['run', '--rm', '-v', '/opt/stacks/grok-remote/secrets:/s:ro', 'alpine:3.20', 'sh', '-c', 'cut -d: -f1 /s/htpasswd'], {
    encoding: 'utf8',
  });
  const name = (r.stdout || '').trim().split('\n')[0] || '';
  return name || 'opc';
}

export function applyBasicAuth(enabled: boolean, username: string, password?: string): void {
  const user = username.trim() || 'opc';
  if (enabled && password && password.length > 0) {
    const line = `${user}:${hashBasicPassword(password)}\n`;
    dockerWrite('/opt/stacks/grok-remote/secrets/htpasswd', line);
  } else if (enabled) {
    const exists = spawnSync('docker', ['run', '--rm', '-v', '/opt/stacks/grok-remote/secrets:/s:ro', 'alpine:3.20', 'test', '-s', '/s/htpasswd']);
    if (exists.status !== 0) throw new Error('Set a password before enabling Basic Auth.');
  }
  dockerWrite('/opt/stacks/grok-remote/nginx/default.conf', nginxProxyConf(enabled));
  const test = spawnSync('docker', ['exec', 'grok-remote-web', 'nginx', '-t'], { encoding: 'utf8' });
  if (test.status !== 0) throw new Error(test.stderr || test.stdout || 'nginx -t failed');
  const reload = spawnSync('docker', ['exec', 'grok-remote-web', 'nginx', '-s', 'reload'], { encoding: 'utf8' });
  if (reload.status !== 0) throw new Error(reload.stderr || 'nginx reload failed');
}

function dockerWrite(hostPath: string, content: string): void {
  const tmp = path.join(ROOT, '.auth-write.tmp');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(tmp, content);
  const dir = path.posix.dirname(hostPath);
  const base = path.posix.basename(hostPath);
  const r = spawnSync('docker', [
    'run', '--rm',
    '-v', `${dir}:/n`,
    '-v', `${ROOT}:/h`,
    'alpine:3.20',
    'sh', '-c', `cat /h/.auth-write.tmp > /n/${base}`,
  ], { encoding: 'utf8' });
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  if (r.status !== 0) {
    throw new Error(r.stderr || `could not write ${hostPath}`);
  }
}

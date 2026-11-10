#!/usr/bin/env node
// grok-remote HTTP entry. Route policy lives in lib/*-http.ts and lib/routes/.
// See ARCHITECTURE.md. Do not put history compact or ACP here.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

import { AgentManager, type PublicAgent } from './lib/agent-manager.js';
import { load as loadSettings, save as saveSettings } from './lib/settings.js';
import {
  listFolders,
  createFolder,
  updateFolder,
  removeFolder,
  assignAgentToFolder,
  agentFolderId,
  setArchivedForAgent,
} from './lib/folders.js';
import { startRetentionTimer } from './lib/retention.js';
import { handleHistoryGet } from './lib/history-http.js';
import { resolveConversationWindow } from './lib/context-window.js';
import { deriveContextStatus } from './lib/context-status.js';
import { readCatalogModels } from './lib/model-catalog.js';
import { readSubagentInheritance, writeSubagentInheritance } from './lib/grok-features.js';
import { handleFilesList, handleFilesRaw, handleFilesPutRaw } from './lib/files-http.js';
import { bindTerminalHttp } from './lib/terminals-http.js';
import { bindSseHttp } from './lib/sse-http.js';
import { buildTrace, buildTraceForSessionId } from './lib/trace-host.js';
import { handleSystem } from './lib/routes/system.js';
import { runGrokText, errorToResponse } from './lib/grok-cli.js';
import {
  loadOidcConfig,
  handleOidcRoute,
  enforceOidc,
} from './lib/oidc.js';
import { handleAuthApi } from './lib/auth-routes.js';
import { staticCacheControl } from './lib/static-cache.js';
import { inferCwdForFolder } from './lib/conversation-folder.js';
import {
  readCurrentVersion,
  readLatestVersion,
  readDiff as readVersionDiff,
  isUpdateInProgress,
  readReleases,
} from './lib/version-update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const PORT = parseInt(process.env['PORT'] || '7910', 10);
const HOST = process.env['HOST'] || '0.0.0.0';

const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch { return '0.0.0'; }
})();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

const manager = new AgentManager();
const termHttp = bindTerminalHttp(manager);
const sseHttp = bindSseHttp(manager);

if (loadOidcConfig()) {
  const boot = loadOidcConfig();
  console.log(`[grok-remote] OIDC enabled issuer=${boot && boot.issuer}`);
} else {
  console.log('[grok-remote] OIDC off (set OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET)');
}

interface TailscaleIdentity {
  backend: string;
  dns: string;
  ip: string;
  hostname: string;
}

function safeJoin(base: string, rel: string): string | null {
  const target = path.resolve(base, '.' + rel);
  if (!target.startsWith(base)) return null;
  return target;
}

function tailscaleIdentity(): TailscaleIdentity | null {
  const r = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[]; HostName?: string }; BackendState?: string };
    const self = j.Self || {};
    return {
      backend: j.BackendState || '',
      dns: (self.DNSName || '').replace(/\.$/, ''),
      ip:  (self.TailscaleIPs && self.TailscaleIPs[0]) || '',
      hostname: self.HostName || os.hostname(),
    };
  } catch { return null; }
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = decodeURIComponent((req.url || '/').split('?')[0] || '/');
  const rel = url === '/' ? '/index.html' : url;
  let target = safeJoin(DIST, rel);
  if (!target || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // Hashed Vite assets must 404, not fall back to index.html — that
    // makes the browser treat HTML as a JS module and the UI goes blank.
    if (rel.startsWith('/assets/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    target = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(target)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('grok-remote: dist/ not built yet. Run `npm run build` (or `npm run install:setup`).\n');
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': staticCacheControl(rel),
  });
  fs.createReadStream(target).pipe(res);
}


function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, limitBytes: number = 32 * 1024 * 1024): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > limitBytes) {
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.length) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(`invalid json: ${msg}`));
      }
    });
    req.on('error', reject);
  });
}

function matchAgentRoute(url: string): { id: string; suffix: string } | null {
  const m = url.match(/^\/api\/agents\/([^\/]+)(\/[^?]*)?$/);
  if (!m || !m[1]) return null;
  return { id: m[1], suffix: m[2] || '' };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: string, method: string): Promise<void> {
  if (url === '/api/hello' && method === 'GET') {
    const ts = tailscaleIdentity();
    sendJson(res, 200, {
      ok: true,
      app: 'grok-remote',
      version: APP_VERSION,
      message: 'remote up. agent endpoints land here soon.',
      now: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      node: process.version,
      platform: process.platform,
      hostname: os.hostname(),
      tailscale: ts,
    });
    return;
  }

  if (url === '/api/health' && method === 'GET') {
    sendJson(res, 200, { ok: true, version: APP_VERSION, uptime_seconds: Math.floor(process.uptime()) });
    return;
  }

  if (url === '/api/version/current' && method === 'GET') {
    try {
      const data = await readCurrentVersion();
      sendJson(res, 200, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return;
  }
  if (url === '/api/version/latest' && method === 'GET') {
    try {
      const data = await readLatestVersion();
      sendJson(res, 200, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return;
  }
  if (url === '/api/version/diff' && method === 'GET') {
    try {
      const data = await readVersionDiff();
      sendJson(res, 200, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return;
  }
  if ((url === '/api/version/releases' || url.startsWith('/api/version/releases?'))
      && method === 'GET') {
    try {
      const force = /\bforce=1\b/.test(url);
      const data = await readReleases({ force });
      sendJson(res, 200, data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
    }
    return;
  }
  if (url === '/api/version/update' && method === 'POST') {
    if (isUpdateInProgress()) {
      sendJson(res, 409, { ok: false, error: 'update already in progress' });
      return;
    }
    sseHttp.handleVersionUpdateStream(req, res);
    return;
  }

  if (url === '/api/settings' && method === 'GET') {
    sendJson(res, 200, loadSettings());
    return;
  }

  if (url === '/api/settings' && method === 'PATCH') {
    try {
      const body = await readJsonBody(req);
      const merged = saveSettings((body || {}) as Record<string, unknown>);
      sendJson(res, 200, merged);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: msg });
    }
    return;
  }

  if (url === '/api/auth' || url.startsWith('/api/auth/')) {
    try {
      if (await handleAuthApi(req, res, url, method)) return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: msg });
      return;
    }
  }

  if (url === '/api/agents' && method === 'GET') {
    sendJson(res, 200, manager.list());
    return;
  }

  if (url === '/api/agents/stream' && method === 'GET') {
    sseHttp.handleAgentsStream(req, res);
    return;
  }

  if (url === '/api/folders' && method === 'GET') {
    sendJson(res, 200, listFolders());
    return;
  }

  if (url === '/api/folders' && method === 'POST') {
    try {
      const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
      const name = typeof body['name'] === 'string' ? body['name'] : '';
      const f = createFolder(name);
      sendJson(res, 201, f);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: msg });
    }
    return;
  }

  {
    const fm = url.match(/^\/api\/folders\/([^\/?]+)$/);
    if (fm) {
      const id = fm[1] || '';
      if (method === 'PATCH') {
        try {
          const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
          const patch: { name?: string; agentIds?: string[] } = {};
          if (typeof body['name'] === 'string') patch.name = body['name'];
          if (Array.isArray(body['agentIds'])) {
            patch.agentIds = (body['agentIds'] as unknown[])
              .filter((x): x is string => typeof x === 'string');
          }
          const out = updateFolder(id, patch);
          sendJson(res, 200, out);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg === 'folder not found' ? 404 : 400;
          sendJson(res, code, { ok: false, error: msg });
        }
        return;
      }
      if (method === 'DELETE') {
        const ok = removeFolder(id);
        if (ok) manager.emit('list_changed', { event: 'folders_changed' });
        sendJson(res, ok ? 200 : 404, { ok });
        return;
      }
    }
  }

  if (url === '/api/bg-terminals' && method === 'GET') {
    termHttp.handleGlobalBgTerminals(req, res);
    return;
  }

  {
    const sm = url.match(/^\/api\/subagents\/([^\/]+)\/trace$/);
    if (sm && method === 'GET') {
      const sid = sm[1] || '';
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(sid)) {
        sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
        return;
      }
      try {
        const data = await buildTraceForSessionId(sid);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
        return;
      }
    }
  }

  {
    const sm = url.match(/^\/api\/subagents\/([^\/]+)\/updates(?:\?.*)?$/);
    if (sm && method === 'GET') {
      const sid = sm[1] || '';
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!UUID_RE.test(sid)) {
        sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
        return;
      }
      const qs   = new URL(req.url || '/', 'http://x').searchParams;
      const cwd  = qs.get('cwd') || '';
      const root = path.join(os.homedir(), '.grok', 'sessions');

      function tryReadUpdates(sessionDir: string): unknown[] | null {
        const p = path.join(sessionDir, 'updates.jsonl');
        if (!fs.existsSync(p)) return null;
        let raw: string;
        try { raw = fs.readFileSync(p, 'utf8'); }
        catch { return null; }
        const out: unknown[] = [];
        for (const line of raw.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try { out.push(JSON.parse(t)); } catch { /* skip malformed */ }
        }
        return out;
      }

      let updates: unknown[] | null = null;
      let sourceDir: string | null = null;

      if (cwd) {
        const dir = path.join(root, encodeURIComponent(cwd), sid);
        updates = tryReadUpdates(dir);
        if (updates) sourceDir = dir;
      }
      if (!updates) {
        try {
          const cwds = fs.readdirSync(root);
          for (const enc of cwds) {
            const dir = path.join(root, enc, sid);
            const got = tryReadUpdates(dir);
            if (got) { updates = got; sourceDir = dir; break; }
          }
        } catch { /* root may not exist yet */ }
      }

      if (!updates) {
        sendJson(res, 404, {
          ok: false, error: 'session dir not flushed yet', sessionId: sid,
        });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        ok: true,
        sessionId: sid,
        source: 'direct',
        sourceDir,
        updates,
      }));
      return;
    }
  }

  if (url === '/api/agents' && method === 'POST') {
    try {
      const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
      const defaults = loadSettings();
      const settings = { ...((body['settings'] as Record<string, unknown>) || {}) };
      if (!body['model'] && !settings['model'] && defaults.defaultModel) {
        settings['model'] = defaults.defaultModel;
      }
      if (typeof settings['alwaysApprove'] !== 'boolean' && typeof defaults.autoApprove === 'boolean') {
        settings['alwaysApprove'] = defaults.autoApprove;
      }
      const folderId = typeof body['folderId'] === 'string' ? body['folderId'].trim() : '';
      let cwd = typeof body['cwd'] === 'string' ? body['cwd'] : '';
      if (!cwd && folderId) {
        const folder = listFolders().find((f) => f.id === folderId);
        const siblingIds = new Set(folder ? folder.agentIds : []);
        const siblingCwds = manager.list()
          .filter((a) => siblingIds.has(a.id))
          .map((a) => a.cwd);
        cwd = inferCwdForFolder({ folderName: folder?.name, siblingCwds });
      }
      const merged = {
        ...body,
        settings,
        ...(!cwd && defaults.defaultCwd ? { cwd: defaults.defaultCwd } : {}),
        ...(cwd ? { cwd } : {}),
      };
      const rec = await manager.spawn(merged as never);
      if (folderId) {
        try { assignAgentToFolder(rec.id, folderId); }
        catch { /* folder assignment should not fail the spawn */ }
      }
      sendJson(res, 201, rec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, { ok: false, error: msg });
    }
    return;
  }

  const route = matchAgentRoute(url);
  if (route) {
    const { id, suffix } = route;
    const rec = manager.get(id);
    if (!rec) { sendJson(res, 404, { ok: false, error: 'agent not found' }); return; }

    if (suffix === '' && method === 'GET') {
      sendJson(res, 200, rec);
      return;
    }
    if (suffix === '' && method === 'PATCH') {
      try {
        const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
        const out = await manager.update(id, body as never);
        // Side-effect: archive toggles also move the agent into / out of the
        // system "Archived" folder so the sidebar shows one canonical location.
        if (typeof body['archived'] === 'boolean') {
          try { setArchivedForAgent(id, body['archived'] as boolean); }
          catch { /* folder side-effect should never fail the patch response */ }
        }
        sendJson(res, 200, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '' && method === 'DELETE') {
      const ok = await manager.kill(id);
      sendJson(res, ok ? 200 : 404, { ok });
      return;
    }
    if (suffix === '/folder' && method === 'PUT') {
      try {
        const body = (await readJsonBody(req) || {}) as Record<string, unknown>;
        const raw = body['folderId'];
        const folderId = raw === null || raw === undefined ? null : String(raw);
        const out = assignAgentToFolder(id, folderId);
        sendJson(res, 200, { ok: true, folder: out });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = msg === 'folder not found' ? 404 : 400;
        sendJson(res, code, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/prompt' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { text?: unknown; attachments?: unknown; force?: unknown };
        const text = body?.text;
        const attachments = Array.isArray(body?.attachments) ? body.attachments as Record<string, unknown>[] : [];
        const force = body?.force === true;
        const hasText = typeof text === 'string' && text.length > 0;
        if (!hasText && !attachments.length) {
          sendJson(res, 400, { ok: false, error: 'text or attachments required' });
          return;
        }
        for (const att of attachments) {
          if (!att || typeof att !== 'object') {
            sendJson(res, 400, { ok: false, error: 'invalid attachment' });
            return;
          }
          if ((att as { kind?: unknown }).kind !== 'image') {
            sendJson(res, 400, { ok: false, error: `unsupported attachment kind: ${String((att as { kind?: unknown }).kind)}` });
            return;
          }
          const mt = (att as { mimeType?: unknown }).mimeType;
          if (typeof mt !== 'string' || !mt.startsWith('image/')) {
            sendJson(res, 400, { ok: false, error: 'attachment.mimeType must be image/*' });
            return;
          }
          const db = (att as { dataBase64?: unknown }).dataBase64;
          if (typeof db !== 'string' || !db.length) {
            sendJson(res, 400, { ok: false, error: 'attachment.dataBase64 required' });
            return;
          }
        }
        const result = await manager.prompt(id, { text: hasText ? (text as string) : '', attachments: attachments as never, force });
        sendJson(res, 202, { ok: true, accepted: true, debug: result?.debug || null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/interject' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { text?: unknown; attachments?: unknown };
        const text = body?.text;
        const attachments = Array.isArray(body?.attachments) ? body.attachments as Record<string, unknown>[] : [];
        const hasText = typeof text === 'string' && text.length > 0;
        if (!hasText && !attachments.length) {
          sendJson(res, 400, { ok: false, error: 'text or attachments required' });
          return;
        }
        const result = await manager.interject(id, { text: hasText ? (text as string) : '', attachments: attachments as never });
        sendJson(res, 200, { ok: true, steered: true, rpc: result.rpc, debug: result.debug || null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/cancel' && method === 'POST') {
      await manager.cancel(id);
      sendJson(res, 202, { ok: true, accepted: true });
      return;
    }
    if (suffix === '/rewind' && method === 'POST') {
      try {
        const body = (await readJsonBody(req) || {}) as { keepTurns?: number };
        const out = await manager.rewind(id, Number(body.keepTurns || 0));
        sendJson(res, 200, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/compact' && method === 'POST') {
      try {
        const body = (await readJsonBody(req) || {}) as { context?: unknown };
        const context = typeof body.context === 'string' ? body.context : '';
        // Compact takes ~1–2 min. Do not hold the HTTP request open — iPad /
        // proxies drop it and the UI then paints "Compact failed" even when
        // Grok finished. Lifecycle is auto_compact_started/completed over SSE.
        void manager.compact(id, { context }).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[compact] ${id} ${msg}\n`);
        });
        sendJson(res, 202, { ok: true, accepted: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/fork' && method === 'POST') {
      try {
        const body = (await readJsonBody(req) || {}) as {
          name?: string;
          directive?: string;
          folderId?: string | null;
        };
        const out = await manager.fork(id, body);
        const requested = Object.prototype.hasOwnProperty.call(body, 'folderId');
        let dest: string | null = null;
        if (requested) {
          const raw = body.folderId;
          dest = raw == null || String(raw).trim() === '' || String(raw) === 'archived'
            ? null
            : String(raw).trim();
        } else {
          const current = agentFolderId(id);
          dest = current && current !== 'archived' ? current : null;
        }
        if (dest) {
          try {
            assignAgentToFolder(out.id, dest);
            manager.emit('list_changed', { event: 'folders_changed' });
          } catch { /* folder assignment should not fail the fork */ }
        }
        sendJson(res, 201, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/permission' && method === 'POST') {
      try {
        const body = (await readJsonBody(req) || {}) as { requestId?: string; optionId?: string };
        const ok = manager.respondPermission(id, String(body.requestId || ''), String(body.optionId || ''));
        sendJson(res, ok ? 200 : 404, { ok });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/interactions' && method === 'GET') {
      sendJson(res, 200, { items: manager.pendingRequests(id) });
      return;
    }
    if (suffix === '/interaction' && method === 'POST') {
      try {
        const body = (await readJsonBody(req) || {}) as { requestId?: string; result?: unknown };
        const ok = manager.respondInteraction(id, String(body.requestId || ''), body.result);
        sendJson(res, ok ? 200 : 404, { ok });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/disconnect' && method === 'POST') {
      try {
        const out = await manager.disconnect(id);
        sendJson(res, 200, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/connect' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { recreateHold?: unknown; freshSession?: unknown; forkSession?: unknown };
        const out = await manager.connect(id, {
          recreateHold: body && body.recreateHold === true,
          freshSession: body && body.freshSession === true,
          forkSession: body && body.forkSession === true,
        });
        sendJson(res, 202, out);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
      }
      return;
    }
    if (suffix === '/context' && method === 'GET') {
      const used = typeof rec.totalTokens === 'number' ? rec.totalTokens : 0;
      const model = (rec.settings && (rec.settings as { model?: string }).model) || rec.model || '';
      const app = loadSettings();
      const settings = (rec.settings && typeof rec.settings === 'object')
        ? rec.settings as Record<string, unknown>
        : null;
      const win = resolveConversationWindow({
        modelId: String(model || ''),
        settings,
        defaults: {
          contextWindow: app['defaultContextWindow'],
          compactAtPercent: app['defaultCompactAtPercent'],
        },
      });
      sendJson(res, 200, deriveContextStatus({
        used,
        window: win.window,
        compactAtPercent: win.compactAtKnown ? win.compactAtPercent : undefined,
        compactAtKnown: win.compactAtKnown,
        compactionsRemaining: win.compactionsRemaining,
        model: win.model || String(model || ''),
        windows: win.windows,
      }));
      return;
    }
    if (suffix === '/history' && method === 'GET') {
      handleHistoryGet(req, res, id, rec);
      return;
    }
    if (suffix === '/files' && method === 'GET') {
      handleFilesList(req, res, rec);
      return;
    }
    if (suffix === '/trace' && method === 'GET') {
      try {
        const data = await buildTrace(rec as never);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: msg });
        return;
      }
    }
    if (suffix === '/files/raw' && (method === 'GET' || method === 'HEAD')) {
      handleFilesRaw(req, res, rec, method);
      return;
    }
    if (suffix === '/files/raw' && method === 'PUT') {
      await handleFilesPutRaw(req, res, rec);
      return;
    }
    if (suffix === '/stream' && method === 'GET') {
      sseHttp.handleStream(req, res, id);
      return;
    }
    if (suffix === '/terminals' && method === 'GET') {
      termHttp.handleTerminalList(req, res, rec);
      return;
    }
    {
      const tmatch = suffix.match(/^\/terminals\/([^/]+)(\/kill)?$/);
      if (tmatch) {
        const tid = tmatch[1] || '';
        const kill = !!tmatch[2];
        if (kill && method === 'POST')  { termHttp.handleTerminalKill(req, res, rec, tid); return; }
        if (!kill && method === 'GET')  { termHttp.handleTerminalRead(req, res, rec, tid); return; }
      }
    }
    {
      const bgmatch = suffix.match(/^\/bg-tasks\/([^/]+)$/);
      if (bgmatch && method === 'GET') {
        termHttp.handleBgTaskRead(req, res, rec, bgmatch[1] || '');
        return;
      }
    }
    if (suffix === '/publish' && method === 'POST') {
      const sessionId = rec.sessionId || rec.lastSessionId;
      if (!sessionId) {
        sendJson(res, 400, {
          ok: false,
          error: 'agent has no sessionId yet; complete at least one turn before publishing',
        });
        return;
      }
      try {
        const stdout = await runGrokText(['share', sessionId], {
          timeoutMs: 60_000,
          maxBytes: 256 * 1024,
        });
        const m = stdout.match(/https?:\/\/\S+/);
        const url2 = m ? m[0].replace(/[)\].,;]+$/, '') : null;
        if (!url2) {
          sendJson(res, 500, {
            ok: false,
            error: 'grok share did not print a URL',
            stdout: stdout.slice(-2000),
          });
          return;
        }
        sendJson(res, 200, { ok: true, url: url2, sessionId, stdout });
      } catch (err) {
        sendJson(res, 500, errorToResponse(err));
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url || '').split('?')[0] || '/';
  const oidcCfg = loadOidcConfig();
  if (oidcCfg) {
    try {
      if (await handleOidcRoute(req, res, url, oidcCfg)) return;
      if (!enforceOidc(req, res, url, oidcCfg)) return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Sign-in error: ${msg}
`);
      }
      return;
    }
  }
  if (url === '/api/system/models' && (req.method || 'GET') === 'GET') {
    const items = readCatalogModels();
    if (items.length) {
      sendJson(res, 200, { ok: true, source: 'cache', items });
      return;
    }
  }
  if (url === '/api/system/grok-features' && ((req.method || 'GET') === 'GET' || req.method === 'POST')) {
    try {
      if ((req.method || 'GET') === 'GET') {
        sendJson(res, 200, {
          ok: true,
          subagentModelInheritance: readSubagentInheritance(),
          applies: 'new-grok-sessions',
        });
      } else {
        const body = await readJsonBody(req) as { subagentModelInheritance?: unknown };
        if (!body || typeof body.subagentModelInheritance !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'subagentModelInheritance boolean required' });
          return;
        }
        writeSubagentInheritance(body.subagentModelInheritance);
        sendJson(res, 200, {
          ok: true,
          subagentModelInheritance: body.subagentModelInheritance,
          applies: 'new-grok-sessions',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: msg });
    }
    return;
  }
  if (url.startsWith('/api/system/')) {
    try {
      await handleSystem(req, res, url);
    } catch (err) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { ok: false, error: msg });
      }
    }
    return;
  }
  if (url.startsWith('/api/')) {
    try {
      await handleApi(req, res, url, req.method || 'GET');
    } catch (err) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, 500, { ok: false, error: msg });
      }
    }
    return;
  }
  serveStatic(req, res);
});

const retention = startRetentionTimer({ getSettings: loadSettings, manager: manager as never });

const REBIND_FLAG = path.join(os.homedir(), '.grok-remote', 'rebind-context');
let rebindBusy = false;
setInterval(() => {
  try {
    if (!fs.existsSync(REBIND_FLAG) || rebindBusy) return;
    fs.unlinkSync(REBIND_FLAG);
    rebindBusy = true;
    process.stderr.write('[rebind-context] flag seen; rebinding resumed holds to config.toml window\n');
    void manager.rebindContextWindows().then((rows) => {
      process.stderr.write(`[rebind-context] done ${JSON.stringify(rows)}\n`);
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[rebind-context] failed: ${msg}\n`);
    }).finally(() => { rebindBusy = false; });
  } catch { /* ignore */ }
}, 2000).unref();

async function boot(): Promise<void> {
  try { await manager.reconnectHeld(); }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[grok-remote] reconnectHeld failed:', msg);
  }
  try { manager.startTuiSessionSync(); }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[grok-remote] tui session sync failed:', msg);
  }
  server.listen(PORT, HOST, () => {
    const ts = tailscaleIdentity();
    const where = ts?.dns ? `http://${ts.dns}:${PORT}` : `http://${HOST}:${PORT}`;
    console.log(`[grok-remote] listening on ${HOST}:${PORT}`);
    console.log(`[grok-remote] tailnet url: ${where}`);
  });
}
void boot();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try { retention.stop(); } catch { /* ignore */ }
  });
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[grok-remote] shutdown on ${signal}`);
  try { await manager.shutdownAll(); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  const t = setTimeout(() => process.exit(0), 3000);
  t.unref?.();
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

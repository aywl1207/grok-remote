// GET /api/agents/:id/files and /files/raw
// List or stream files under the agent cwd. Never follow paths out of scope.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import type { PublicAgent } from './agent-manager.js';
import { sendJson, isNodeErr } from './http-util.js';

const FILE_MAX_BYTES = 256_000;

export function withinAgentScope(scopeDir: string, target: string): boolean {
  const scope = path.resolve(scopeDir);
  const resolved = path.resolve(target);
  if (!(resolved === scope || resolved.startsWith(scope + path.sep))) return false;
  let realScope = scope;
  try { realScope = fs.realpathSync(scope); } catch { /* keep lexical */ }
  let realTarget = resolved;
  try {
    if (fs.existsSync(resolved)) realTarget = fs.realpathSync(resolved);
  } catch {
    return false;
  }
  return realTarget === realScope || realTarget.startsWith(realScope + path.sep);
}

/** Hard cap for a Files-tab upload. Chunked so Cloudflare (~100 MB/request) is not the limit. */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function formatUploadLimit(bytes: number): string {
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (bytes >= gb && bytes % gb === 0) return `${bytes / gb} GB`;
  if (bytes >= mb && bytes % mb === 0) return `${bytes / mb} MB`;
  return `${bytes} bytes`;
}

export function sanitizeDestName(name: string): string {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[\x00-\x1f]/g, '').replace(/^\.+/, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return `file-${Date.now()}`;
  return cleaned.slice(0, 200);
}

export function uniqueDestName(dir: string, requested: string): string {
  const raw = sanitizeDestName(requested);
  let candidate = raw;
  const ext = path.extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i++}${ext}`;
  }
  return candidate;
}

export function resolveScopedPath(cwd: string, rel: string): string {
  const cleanRel = String(rel || '').replace(/^\/+/, '');
  const target = path.resolve(cwd, cleanRel);
  if (!withinAgentScope(cwd, target)) throw new Error('path escapes agent scope');
  return target;
}

export function contentDisposition(filename: string): string {
  const name = path.basename(String(filename || 'download'));
  const ascii = name.replace(/[^\x20-\x7E]/g, '_') || 'download';
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${ascii.replace(/"/g, '\\"')}"; filename*=UTF-8''${encoded}`;
}


export function handleFilesList(req: IncomingMessage, res: ServerResponse, rec: PublicAgent): void {
  const cwd = rec && rec.cwd;
  if (!cwd) { sendJson(res, 404, { ok: false, error: 'agent cwd missing' }); return; }

  const urlObj = new URL(req.url || '/', 'http://x');
  const rel = urlObj.searchParams.get('path') || '';
  const cleanRel = String(rel).replace(/^\/+/, '');

  let target: string;
  try {
    target = path.resolve(cwd, cleanRel);
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid path' });
    return;
  }
  if (!withinAgentScope(cwd, target)) {
    sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (isNodeErr(err) && err.code === 'ENOENT') {
      sendJson(res, 404, { ok: false, error: 'path not found' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: msg });
    return;
  }

  if (stat.isDirectory()) {
    let names: string[];
    try {
      names = fs.readdirSync(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
      return;
    }
    interface DirEntry { name: string; type: 'directory'; entries: null; isHidden: boolean }
    interface FileEntry { name: string; type: 'file'; size: number; mtime: string; isHidden: boolean }
    const dirs: DirEntry[] = [];
    const files: FileEntry[] = [];
    for (const name of names) {
      const full = path.join(target, name);
      let s: fs.Stats;
      try { s = fs.lstatSync(full); }
      catch { continue; }
      const isHidden = name.startsWith('.');
      if (s.isDirectory()) {
        dirs.push({ name, type: 'directory', entries: null, isHidden });
      } else if (s.isFile()) {
        files.push({
          name,
          type: 'file',
          size: s.size,
          mtime: s.mtime.toISOString(),
          isHidden,
        });
      } else {
        files.push({
          name,
          type: 'file',
          size: s.size,
          mtime: s.mtime.toISOString(),
          isHidden,
        });
      }
    }
    const cmp = <T extends { isHidden: boolean; name: string }>(a: T, b: T): number => {
      if (a.isHidden !== b.isHidden) return a.isHidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    };
    dirs.sort(cmp);
    files.sort(cmp);
    sendJson(res, 200, {
      type: 'directory',
      path: cleanRel,
      entries: [...dirs, ...files],
    });
    return;
  }

  if (stat.isFile()) {
    if (stat.size > FILE_MAX_BYTES) {
      sendJson(res, 200, {
        type: 'file',
        path: cleanRel,
        size: stat.size,
        truncated: true,
        content: null,
        reason: 'too_large',
      });
      return;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(target);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: msg });
      return;
    }
    const sniff = buf.subarray(0, Math.min(512, buf.length));
    let binary = false;
    for (let i = 0; i < sniff.length; i++) {
      if (sniff[i] === 0) { binary = true; break; }
    }
    if (binary) {
      sendJson(res, 200, {
        type: 'file',
        path: cleanRel,
        size: stat.size,
        binary: true,
        content: null,
      });
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      path: cleanRel,
      size: stat.size,
      binary: false,
      mtime: stat.mtime.toISOString(),
      content: buf.toString('utf8'),
    });
    return;
  }

  sendJson(res, 400, { ok: false, error: 'unsupported file type' });
}

const RAW_MAX_BYTES = 8 * 1024 * 1024 * 1024;

const RAW_MIME: Record<string, string> = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.bmp':  'image/bmp',
  '.ico':  'image/x-icon',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.ogv':  'video/ogg',
  '.m4v':  'video/x-m4v',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.m4a':  'audio/mp4',
  '.flac': 'audio/flac',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

type RangeParsed = { start: number; end: number } | { unsatisfiable: true } | null;

export function parseRange(headerVal: string | undefined, size: number): RangeParsed {
  if (!headerVal || typeof headerVal !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(headerVal.trim());
  if (!m) return { unsatisfiable: true };
  const startStr = m[1] || '';
  const endStr = m[2] || '';
  let start: number;
  let end: number;
  if (startStr === '' && endStr === '') return { unsatisfiable: true };
  if (startStr === '') {
    const n = parseInt(endStr, 10);
    if (!Number.isFinite(n) || n <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { unsatisfiable: true };
  }
  if (start > end || start < 0 || end >= size) return { unsatisfiable: true };
  return { start, end };
}

export function handleFilesRaw(req: IncomingMessage, res: ServerResponse, rec: PublicAgent, method: string): void {
  const cwd = rec && rec.cwd;
  if (!cwd) { sendJson(res, 404, { ok: false, error: 'agent cwd missing' }); return; }

  const urlObj = new URL(req.url || '/', 'http://x');
  const rel = urlObj.searchParams.get('path') || '';
  const cleanRel = String(rel).replace(/^\/+/, '');

  let target: string;
  try {
    target = path.resolve(cwd, cleanRel);
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid path' });
    return;
  }
  if (!withinAgentScope(cwd, target)) {
    sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    if (isNodeErr(err) && err.code === 'ENOENT') {
      sendJson(res, 404, { ok: false, error: 'path not found' });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: msg });
    return;
  }

  if (stat.isDirectory()) {
    sendJson(res, 400, { ok: false, error: 'path is a directory' });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 400, { ok: false, error: 'unsupported file type' });
    return;
  }
  if (stat.size > RAW_MAX_BYTES) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'file too large' }));
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const contentType = RAW_MIME[ext] || 'application/octet-stream';
  const lastModified = stat.mtime.toUTCString();

  const rangeHeader = req.headers['range'] as string | undefined;
  const parsed = parseRange(rangeHeader, stat.size);
  if (parsed && 'unsatisfiable' in parsed) {
    res.writeHead(416, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Range': `bytes */${stat.size}`,
    });
    res.end(JSON.stringify({ ok: false, error: 'range not satisfiable' }));
    return;
  }

  if (parsed) {
    const { start, end } = parsed;
    const chunkLen = end - start + 1;
    const rangeHeaders: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(chunkLen),
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Last-Modified': lastModified,
    };
    if (urlObj.searchParams.get('download') === '1') {
      rangeHeaders['Content-Disposition'] = contentDisposition(path.basename(target));
    }
    res.writeHead(206, rangeHeaders);
    if (method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(target, { start, end });
    stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
    stream.pipe(res);
    return;
  }

  const download = urlObj.searchParams.get('download') === '1';
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(stat.size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Last-Modified': lastModified,
  };
  if (download) headers['Content-Disposition'] = contentDisposition(path.basename(target));
  res.writeHead(200, headers);
  if (method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(target);
  stream.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
}


export const UPLOAD_CHUNK_MAX_BYTES = 16 * 1024 * 1024;

function sanitizeUploadId(raw: string): string {
  const id = String(raw || '').trim();
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(id)) throw new Error('invalid upload id');
  return id;
}

function readRequestToFile(
  req: IncomingMessage,
  dest: string,
  opts: { flags: string; start?: number; maxBytes: number },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, {
      flags: opts.flags,
      start: opts.start,
    });
    let written = 0;
    let failed = false;
    const fail = (err: Error): void => {
      if (failed) return;
      failed = true;
      try { out.destroy(); } catch { /* ignore */ }
      try { req.destroy(); } catch { /* ignore */ }
      reject(err);
    };
    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > opts.maxBytes) fail(new Error('chunk too large'));
    });
    req.on('error', fail);
    out.on('error', fail);
    req.pipe(out);
    out.on('finish', () => {
      if (!failed) resolve(written);
    });
  });
}

export async function handleFilesPutRaw(
  req: IncomingMessage,
  res: ServerResponse,
  rec: PublicAgent,
): Promise<void> {
  const cwd = rec && rec.cwd;
  if (!cwd) { sendJson(res, 404, { ok: false, error: 'agent cwd missing' }); return; }

  const urlObj = new URL(req.url || '/', 'http://x');
  const dirRel = String(urlObj.searchParams.get('dir') || '').replace(/^\/+/, '');
  const requested = String(urlObj.searchParams.get('name') || 'upload');
  const uploadIdRaw = String(urlObj.searchParams.get('uploadId') || '').trim();
  const offsetParam = parseInt(String(urlObj.searchParams.get('offset') || ''), 10);
  const totalParam = parseInt(String(urlObj.searchParams.get('total') || ''), 10);

  let destDir: string;
  try {
    destDir = resolveScopedPath(cwd, dirRel);
  } catch {
    sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
    return;
  }

  const declared = parseInt(String(req.headers['content-length'] || ''), 10);
  const chunkCap = uploadIdRaw ? UPLOAD_CHUNK_MAX_BYTES : UPLOAD_MAX_BYTES;
  if (Number.isFinite(declared) && declared > chunkCap) {
    sendJson(res, 413, { ok: false, error: `chunk too large (use smaller parts; max ${formatUploadLimit(UPLOAD_MAX_BYTES)} file)` });
    return;
  }
  if (Number.isFinite(totalParam) && totalParam > UPLOAD_MAX_BYTES) {
    sendJson(res, 413, { ok: false, error: `file too large (max ${formatUploadLimit(UPLOAD_MAX_BYTES)})` });
    return;
  }

  try {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const st = fs.statSync(destDir);
    if (!st.isDirectory()) {
      sendJson(res, 400, { ok: false, error: 'destination is not a directory' });
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { ok: false, error: msg });
    return;
  }
  if (!withinAgentScope(cwd, destDir)) {
    sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
    return;
  }

  const finalize = (tmp: string): { rel: string; name: string; size: number } => {
    const name = uniqueDestName(destDir, requested);
    const target = path.join(destDir, name);
    if (!withinAgentScope(cwd, target)) throw new Error('path escapes agent scope');
    fs.renameSync(tmp, target);
    const size = fs.statSync(target).size;
    const rel = path.relative(cwd, target).split(path.sep).join('/');
    return { rel, name, size };
  };

  // Chunked upload: many small PUTs so Cloudflare (100 MB/request) does not 413.
  if (uploadIdRaw) {
    let uploadId: string;
    try { uploadId = sanitizeUploadId(uploadIdRaw); }
    catch { sendJson(res, 400, { ok: false, error: 'invalid upload id' }); return; }
    const offset = Number.isFinite(offsetParam) ? offsetParam : 0;
    const total = Number.isFinite(totalParam) ? totalParam : 0;
    if (offset < 0 || (total && offset >= total)) {
      sendJson(res, 400, { ok: false, error: 'invalid offset' });
      return;
    }
    const tmp = path.join(destDir, `.uploading-${uploadId}`);
    if (!withinAgentScope(cwd, tmp)) {
      sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
      return;
    }
    try {
      const exists = fs.existsSync(tmp);
      const have = exists ? fs.statSync(tmp).size : 0;
      if (offset === 0) {
        if (exists) fs.unlinkSync(tmp);
      } else if (!exists || have !== offset) {
        sendJson(res, 409, { ok: false, error: 'upload session missing or out of order' });
        return;
      }
      const written = await readRequestToFile(req, tmp, {
        flags: offset === 0 ? 'w' : 'a',
        maxBytes: UPLOAD_CHUNK_MAX_BYTES,
      });
      const received = (offset === 0 ? 0 : have) + written;
      if (total && received > total) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        sendJson(res, 413, { ok: false, error: `file too large (max ${formatUploadLimit(UPLOAD_MAX_BYTES)})` });
        return;
      }
      if (total && received >= total) {
        const out = finalize(tmp);
        sendJson(res, 201, { ok: true, done: true, ...out });
        return;
      }
      sendJson(res, 202, { ok: true, done: false, received, total: total || received });
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = /too large/i.test(msg) ? 413 : 500;
      sendJson(res, code, { ok: false, error: msg });
      return;
    }
  }

  const name = uniqueDestName(destDir, requested);
  const target = path.join(destDir, name);
  if (!withinAgentScope(cwd, target)) {
    sendJson(res, 400, { ok: false, error: 'path escapes agent scope' });
    return;
  }
  const tmp = `${target}.uploading-${process.pid}-${Date.now()}`;
  try {
    const written = await readRequestToFile(req, tmp, { flags: 'w', maxBytes: UPLOAD_MAX_BYTES });
    fs.renameSync(tmp, target);
    const rel = path.relative(cwd, target).split(path.sep).join('/');
    sendJson(res, 201, { ok: true, path: rel, name, size: written });
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    const code = /too large/i.test(msg) ? 413 : 500;
    sendJson(res, code, { ok: false, error: msg });
  }
}

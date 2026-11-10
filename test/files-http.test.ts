import test from 'node:test';
import assert from 'node:assert/strict';
import { withinAgentScope, parseRange } from '../lib/files-http.js';

test('withinAgentScope allows cwd and children, rejects escape', () => {
  assert.equal(withinAgentScope('/home/opc', '/home/opc'), true);
  assert.equal(withinAgentScope('/home/opc', '/home/opc/projects'), true);
  assert.equal(withinAgentScope('/home/opc', '/etc/passwd'), false);
  assert.equal(withinAgentScope('/home/opc', '/home/opc/../etc'), false);
});

test('parseRange understands bytes=start-end', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.equal((parseRange('bytes=200-210', 100) as { unsatisfiable: true }).unsatisfiable, true);
  assert.equal(parseRange(undefined, 100), null);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeDestName,
  uniqueDestName,
  resolveScopedPath,
  contentDisposition,
} from '../lib/files-http.js';

test('sanitizeDestName strips paths and control chars', () => {
  assert.equal(sanitizeDestName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeDestName('notes.txt'), 'notes.txt');
  assert.equal(sanitizeDestName('..'), '_');
  assert.match(sanitizeDestName(''), /^file-/);
});

test('uniqueDestName adds a suffix when the file exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-files-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    assert.equal(uniqueDestName(dir, 'a.txt'), 'a-1.txt');
    assert.equal(uniqueDestName(dir, 'b.txt'), 'b.txt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveScopedPath rejects escapes', () => {
  assert.equal(resolveScopedPath('/home/opc/proj', 'uploads/x.png'), '/home/opc/proj/uploads/x.png');
  assert.throws(() => resolveScopedPath('/home/opc/proj', '../secret'));
});

test('contentDisposition marks the file as an attachment', () => {
  const d = contentDisposition('photo.png');
  assert.match(d, /attachment/);
  assert.match(d, /filename="photo.png"/);
});

test('chunked upload max is well under Cloudflare 100 MB', async () => {
  const { UPLOAD_CHUNK_MAX_BYTES, UPLOAD_MAX_BYTES, formatUploadLimit } = await import('../lib/files-http.js');
  assert.ok(UPLOAD_CHUNK_MAX_BYTES <= 16 * 1024 * 1024);
  assert.ok(UPLOAD_CHUNK_MAX_BYTES < 100 * 1024 * 1024);
  assert.equal(UPLOAD_MAX_BYTES, 2 * 1024 * 1024 * 1024);
  assert.equal(formatUploadLimit(UPLOAD_MAX_BYTES), '2 GB');
});

test('withinAgentScope rejects a symlink that escapes cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-scope-'));
  try {
    const link = path.join(dir, 'out');
    fs.symlinkSync('/etc', link);
    assert.equal(withinAgentScope(dir, link), false);
    assert.equal(withinAgentScope(dir, path.join(dir, 'ok.txt')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

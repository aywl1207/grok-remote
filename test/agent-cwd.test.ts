import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureCwdDir } from '../lib/agent-cwd.js';

test('ensureCwdDir creates a missing folder and returns the resolved path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-cwd-'));
  const dest = path.join(root, 'grok-remote');
  const out = ensureCwdDir(dest);
  assert.equal(out, path.resolve(dest));
  assert.equal(fs.statSync(out).isDirectory(), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('ensureCwdDir rejects a file path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-cwd-'));
  const file = path.join(root, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  assert.throws(() => ensureCwdDir(file), /not a directory/);
  fs.rmSync(root, { recursive: true, force: true });
});

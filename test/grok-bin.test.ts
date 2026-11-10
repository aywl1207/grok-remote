import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveGrokBin } from '../lib/grok-bin.js';

function fakeHome(): { home: string; file: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bin-'));
  const file = path.join(home, 'fake-grok');
  fs.writeFileSync(file, '#!/bin/sh\n');
  const binDir = path.join(home, '.grok', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(file, path.join(binDir, 'grok'));
  return { home, file };
}

test('explicit GROK_BIN other than the container mount wins', () => {
  const { home } = fakeHome();
  assert.equal(resolveGrokBin({ GROK_BIN: '/tmp/echo-grok' }, home), '/tmp/echo-grok');
});

test('stale container GROK_BIN yields the user install', () => {
  const { home, file } = fakeHome();
  assert.equal(
    resolveGrokBin({ GROK_BIN: '/usr/local/bin/grok' }, home),
    fs.realpathSync(file),
  );
});

test('missing user install keeps the container path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bin-empty-'));
  assert.equal(resolveGrokBin({ GROK_BIN: '/usr/local/bin/grok' }, home), '/usr/local/bin/grok');
});

test('no GROK_BIN and no user install falls back to grok on PATH', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bin-empty-'));
  assert.equal(resolveGrokBin({}, home), 'grok');
});

test('this host follows ~/.grok/bin/grok when the container mount is set', () => {
  const current = path.join(os.homedir(), '.grok', 'bin', 'grok');
  if (!fs.existsSync(current)) return;
  const resolved = resolveGrokBin({ GROK_BIN: '/usr/local/bin/grok' });
  assert.equal(resolved, fs.realpathSync(current));
  assert.equal(resolved.includes('/usr/local/bin/grok'), false);
});

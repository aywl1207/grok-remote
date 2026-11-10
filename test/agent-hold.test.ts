import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  holdName,
  holdSockPath,
  holdReadyPath,
  holdEnabled,
  holdNeedsHandshake,
  keepExistingHold,
  holdIdsFromDockerNames,
  grokHoldBindSource,
  grokHoldBindCandidates,
  markHoldReady,
  readHoldReady,
  clearHoldReady,
  holdArgsBindOldWindow,
} from '../lib/agent-hold.js';

test('holdName sanitizes agent ids', () => {
  assert.equal(holdName('2507d123-66c8-41f3-bdf5-5cbb822dc650'), 'gr-hold-2507d123-66c8-41f3-bdf5-5cbb822dc650');
  assert.equal(holdName('a/b c'), 'gr-hold-abc');
});

test('holdSockPath lives under ~/.grok-remote/agents', () => {
  const p = holdSockPath('abc');
  assert.equal(p, path.join(os.homedir(), '.grok-remote', 'agents', 'abc', 'acp.sock'));
});

test('holdEnabled is on unless GROK_HOLD=0', () => {
  assert.equal(holdEnabled(), process.env.GROK_HOLD !== '0');
});

test('holdNeedsHandshake only skips after a completed initialize', () => {
  assert.equal(holdNeedsHandshake(true, null), true);
  assert.equal(holdNeedsHandshake(true, 'sess-1'), true);
  assert.equal(holdNeedsHandshake(false, null), true);
  assert.equal(holdNeedsHandshake(false, 'sess-1'), false);
});

test('hold ready marker round-trips session id', () => {
  const id = 'test-hold-ready-' + process.pid;
  try {
    assert.equal(readHoldReady(id), null);
    markHoldReady(id, 'sess-abc');
    assert.equal(readHoldReady(id)?.sessionId, 'sess-abc');
    assert.equal(holdReadyPath(id), path.join(os.homedir(), '.grok-remote', 'agents', id, 'acp.ready'));
  } finally {
    clearHoldReady(id);
    try { fs.rmSync(path.join(os.homedir(), '.grok-remote', 'agents', id), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});


test('keepExistingHold never recreates a running hold', () => {
  assert.equal(keepExistingHold(true, true), 'attach');
  assert.equal(keepExistingHold(true, false), 'wait-sock');
  assert.equal(keepExistingHold(false, false), 'create');
  assert.equal(keepExistingHold(false, true), 'create');
});

test('holdIdsFromDockerNames strips the prefix', () => {
  assert.deepEqual(
    holdIdsFromDockerNames(['gr-hold-abc', 'nginx', 'gr-hold-2507d123-66c8-41f3-bdf5-5cbb822dc650', '']),
    ['abc', '2507d123-66c8-41f3-bdf5-5cbb822dc650'],
  );
});

test('grokHoldBindCandidates follows current grok, not a versioned download pin', () => {
  const c = grokHoldBindCandidates({ GROK_HOLD_BIN: '/opt/custom/grok' }, '/home/opc');
  assert.deepEqual(c, ['/opt/custom/grok', '/home/opc/.grok/bin/grok', '/usr/local/bin/grok']);
  assert.equal(c.some((p) => /grok-\d+\.\d+\.\d+-/.test(p)), false);
});

test('grokHoldBindSource returns a real file or null', () => {
  const src = grokHoldBindSource();
  if (src) assert.equal(fs.statSync(src).isFile(), true);
});

test('grokHoldBindSource prefers ~/.grok/bin/grok over leftover downloads', () => {
  const current = path.join(os.homedir(), '.grok', 'bin', 'grok');
  if (!fs.existsSync(current)) return;
  const src = grokHoldBindSource();
  assert.equal(src, fs.realpathSync(current));
  assert.equal(src?.includes('grok-1.0.5-linux-aarch64'), false);
});

test('holdArgsBindOldWindow is true only for resume/fork argv', () => {
  assert.equal(holdArgsBindOldWindow(['agent', '--no-leader', 'stdio']), false);
  assert.equal(holdArgsBindOldWindow(['-m', 'grok-4.6', 'agent', 'stdio']), false);
  assert.equal(holdArgsBindOldWindow(['-r', '01abc', 'agent', 'stdio']), true);
  assert.equal(holdArgsBindOldWindow(['--resume', '01abc', 'agent']), true);
  assert.equal(holdArgsBindOldWindow(['-r', '01abc', '--fork-session', 'agent']), true);
  assert.equal(holdArgsBindOldWindow(['--fork-session', 'agent']), true);
});

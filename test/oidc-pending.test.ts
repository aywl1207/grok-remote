import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPendingStore } from '../lib/oidc-pending.js';

test('oidc pending store round-trips and is single-use', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-pending-'));
  try {
    const store = createPendingStore(dir);
    store.save({
      state: 'abc12345state',
      verifier: 'ver',
      nonce: 'non',
      returnTo: '/#/x',
    }, 60_000, 1_000);
    const rec = store.take('abc12345state', 1_500);
    assert.ok(rec);
    assert.equal(rec.verifier, 'ver');
    assert.equal(rec.returnTo, '/#/x');
    assert.equal(store.take('abc12345state', 1_500), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('oidc pending store expires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-pending-'));
  try {
    const store = createPendingStore(dir);
    store.save({
      state: 'abc12345state',
      verifier: 'ver',
      nonce: 'non',
      returnTo: '/',
    }, 100, 1_000);
    assert.equal(store.take('abc12345state', 1_200), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('oidc pending store ignores unsafe state keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-pending-'));
  try {
    const store = createPendingStore(dir);
    store.save({
      state: '../etc/passwd',
      verifier: 'ver',
      nonce: 'non',
      returnTo: '/',
    }, 60_000);
    assert.equal(store.take('../etc/passwd'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

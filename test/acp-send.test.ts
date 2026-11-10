import test from 'node:test';
import assert from 'node:assert/strict';

import { acpCanSend } from '../lib/acp-client.js';

test('acpCanSend uses the hold socket even when proc is null', () => {
  assert.equal(acpCanSend({ destroyed: false }, null), true);
  assert.equal(acpCanSend({ destroyed: true }, null), false);
  assert.equal(acpCanSend(null, null), false);
});

test('acpCanSend falls back to in-process stdin', () => {
  assert.equal(acpCanSend(null, { stdin: { writable: true } }), true);
  assert.equal(acpCanSend(null, { stdin: { writable: false } }), false);
  assert.equal(acpCanSend({ destroyed: true }, { stdin: { writable: true } }), true);
  assert.equal(acpCanSend({ destroyed: false }, { stdin: { writable: false } }), true);
});

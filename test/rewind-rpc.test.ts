import test from 'node:test';
import assert from 'node:assert/strict';
import { rewindRpcTries } from '../lib/rewind-rpc.js';

test('rewindRpcTries prefers x.ai/rewind/execute', () => {
  const tries = rewindRpcTries('sess-1', 4);
  assert.equal(tries[0]!.method, 'x.ai/rewind/execute');
  assert.equal(tries[0]!.params['sessionId'], 'sess-1');
  assert.equal(tries[0]!.params['promptIndex'], 4);
  assert.equal(tries[0]!.params['target_prompt_index'], 4);
  const methods = tries.map((t) => t.method);
  assert.ok(methods.includes('x.ai/rewind'));
  assert.ok(methods.includes('session/rewind'));
});

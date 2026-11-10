import test from 'node:test';
import assert from 'node:assert/strict';
import { interjectRpcTries, interjectShouldTryNext } from '../lib/interject-rpc.js';

test('interjectRpcTries prefers x.ai/interject with prompt blocks', () => {
  const blocks = [{ type: 'text', text: 'steer' }];
  const tries = interjectRpcTries('sess-1', blocks, 'steer');
  assert.equal(tries[0]!.method, 'x.ai/interject');
  assert.equal(tries[0]!.params['sessionId'], 'sess-1');
  assert.deepEqual(tries[0]!.params['prompt'], blocks);
  const methods = tries.map((t) => t.method);
  assert.ok(methods.includes('x.ai/queue/interject'));
  assert.ok(methods.includes('session/interject'));
  assert.ok(tries.some((t) => t.params['text'] === 'steer'));
});

test('interjectShouldTryNext walks missing methods and bad params', () => {
  assert.equal(interjectShouldTryNext(new Error('Method not found: x.ai/interject')), true);
  assert.equal(interjectShouldTryNext(new Error('not supported by this agent version')), true);
  assert.equal(interjectShouldTryNext(new Error('Invalid params')), true);
  assert.equal(interjectShouldTryNext(new Error('interject timeout')), true);
  assert.equal(interjectShouldTryNext(new Error('session is busy')), false);
});

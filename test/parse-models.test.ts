import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelsPayload } from '../src/lib/api.ts';

test('parseModelsPayload reads system items', () => {
  assert.deepEqual(parseModelsPayload({ ok: true, items: [{ id: 'grok-4.6' }] }), [{ id: 'grok-4.6' }]);
  assert.deepEqual(parseModelsPayload({ models: ['a'] }), ['a']);
  assert.deepEqual(parseModelsPayload(['x']), ['x']);
  assert.deepEqual(parseModelsPayload(null), []);
});

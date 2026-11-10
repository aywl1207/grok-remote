import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEffort, parseModelCommand } from '../src/views/chat/model-picker.js';

test('parseModelCommand reads effort-only, model+effort, and model-only', () => {
  assert.deepEqual(parseModelCommand(null, 'high'), { model: '', effort: 'high' });
  assert.deepEqual(parseModelCommand(null, 'grok-4.6 high'), { model: 'grok-4.6', effort: 'high' });
  assert.deepEqual(parseModelCommand(null, 'grok-4.6'), { model: 'grok-4.6', effort: '' });
  assert.deepEqual(parseModelCommand(null, ''), { model: '', effort: '' });
});

test('parseModelCommand accepts effort labels and keeps a bare model id', () => {
  assert.equal(normalizeEffort('Extra High'), 'xhigh');
  assert.equal(normalizeEffort('xHigh'), 'xhigh');
  assert.equal(normalizeEffort('med'), 'medium');
  assert.deepEqual(parseModelCommand(null, 'Extra High'), { model: '', effort: 'xhigh' });
  assert.deepEqual(parseModelCommand(null, 'grok-4.7 Extra High'), { model: 'grok-4.7', effort: 'xhigh' });
  assert.deepEqual(parseModelCommand(null, 'grok-4.6'), { model: 'grok-4.6', effort: '' });
});

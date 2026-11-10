import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetModelParams, modelSettingsChanged } from '../lib/set-model.js';

test('buildSetModelParams is sessionId + modelId only', () => {
  const p = buildSetModelParams('sid-1', { modelId: 'grok-4.5' });
  assert.deepEqual(p, { sessionId: 'sid-1', modelId: 'grok-4.5' });
  assert.equal('model' in p, false);
  assert.equal('effort' in p, false);
});

test('buildSetModelParams puts effort in _meta', () => {
  const p = buildSetModelParams('sid-1', { modelId: 'grok-4.6', reasoningEffort: 'low' });
  assert.deepEqual(p, {
    sessionId: 'sid-1',
    modelId: 'grok-4.6',
    _meta: { reasoningEffort: 'low' },
  });
});

test('buildSetModelParams omits empty effort', () => {
  const p = buildSetModelParams('sid-1', { modelId: 'grok-4.6' });
  assert.equal(p.modelId, 'grok-4.6');
  assert.equal(p._meta, undefined);
});

test('modelSettingsChanged detects model and effort', () => {
  assert.deepEqual(
    modelSettingsChanged({ model: 'grok-4.6', reasoningEffort: 'high' }, { model: 'grok-4.5', reasoningEffort: 'high' }),
    { modelChanged: true, effortChanged: false },
  );
  assert.deepEqual(
    modelSettingsChanged({ model: 'grok-4.6', reasoningEffort: 'high' }, { model: 'grok-4.6', reasoningEffort: 'low' }),
    { modelChanged: false, effortChanged: true },
  );
  assert.deepEqual(
    modelSettingsChanged({ model: 'grok-4.6' }, { model: 'grok-4.6' }),
    { modelChanged: false, effortChanged: false },
  );
});

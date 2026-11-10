import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsNeedNewHold, settingsNeedHoldAfterRuntime, settingsNeedFreshSession } from '../lib/settings-hold.js';

test('settingsNeedNewHold is false when model and effort match', () => {
  assert.equal(settingsNeedNewHold(
    { model: 'grok-4.6', reasoningEffort: 'medium' },
    { model: 'grok-4.6', reasoningEffort: 'medium' },
  ), false);
});

test('settingsNeedNewHold is true when model changes', () => {
  assert.equal(settingsNeedNewHold(
    { model: 'grok-4.6' },
    { model: 'grok-4.5' },
  ), true);
});

test('settingsNeedNewHold is true when effort changes', () => {
  assert.equal(settingsNeedNewHold(
    { model: 'grok-4.6', reasoningEffort: 'medium' },
    { model: 'grok-4.6', reasoningEffort: 'high' },
  ), true);
});


test('settingsNeedHoldAfterRuntime is false when only model changed and runtime applied', () => {
  assert.equal(settingsNeedHoldAfterRuntime(
    { model: 'grok-4.6', reasoningEffort: 'high' },
    { model: 'grok-4.5', reasoningEffort: 'high' },
    true,
  ), false);
});

test('settingsNeedHoldAfterRuntime is true when effort changed even if runtime applied', () => {
  assert.equal(settingsNeedHoldAfterRuntime(
    { model: 'grok-4.6', reasoningEffort: 'high' },
    { model: 'grok-4.6', reasoningEffort: 'low' },
    true,
  ), true);
});

test('settingsNeedHoldAfterRuntime is true when runtime did not apply', () => {
  assert.equal(settingsNeedHoldAfterRuntime(
    { model: 'grok-4.6' },
    { model: 'grok-4.5' },
    false,
  ), true);
});

test('settingsNeedFreshSession is true for model or effort', () => {
  assert.equal(settingsNeedFreshSession({ model: 'grok-4.6' }, { model: 'qwen-local' }), true);
  assert.equal(settingsNeedFreshSession(
    { model: 'grok-4.6', reasoningEffort: 'high' },
    { model: 'grok-4.6', reasoningEffort: 'low' },
  ), true);
  assert.equal(settingsNeedFreshSession(
    { model: 'grok-4.6', reasoningEffort: 'high' },
    { model: 'grok-4.6', reasoningEffort: 'high' },
  ), false);
});

test('context window and auto-compact settings do not need a new hold', () => {
  assert.equal(settingsNeedNewHold(
    { model: 'grok-4.6', contextWindow: 200000, autoCompactThresholdPercent: 90 },
    { model: 'grok-4.6', contextWindow: 128000, autoCompactThresholdPercent: 100, uiAutoCompact: false },
  ), false);
  assert.equal(settingsNeedFreshSession(
    { model: 'grok-4.6', contextWindow: 200000 },
    { model: 'grok-4.6', contextWindow: 128000 },
  ), false);
});

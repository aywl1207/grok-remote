import test from 'node:test';
import assert from 'node:assert/strict';
import { isCustomModelId, customModelIdentityRules, mergeArgvRules, wrapPromptWithIdentity, stripIdentityWrapper } from '../lib/model-identity.js';

test('isCustomModelId is false for grok models and empty', () => {
  assert.equal(isCustomModelId('grok-4.6'), false);
  assert.equal(isCustomModelId('grok-4.5'), false);
  assert.equal(isCustomModelId(''), false);
  assert.equal(isCustomModelId('qwen-local'), true);
  assert.equal(isCustomModelId('qwen3.8:27b'), true);
});

test('customModelIdentityRules names the local model', () => {
  assert.equal(customModelIdentityRules('grok-4.6'), '');
  const r = customModelIdentityRules('qwen-local');
  assert.match(r, /qwen-local/);
  assert.match(r, /not Grok/);
});

test('mergeArgvRules prepends identity and keeps user rules', () => {
  const r = mergeArgvRules('Always use TypeScript.', 'qwen-local');
  assert.match(r, /qwen-local/);
  assert.match(r, /TypeScript/);
  assert.equal(mergeArgvRules('', 'grok-4.6'), '');
});

test('wrapPromptWithIdentity is a no-op for grok models', () => {
  assert.equal(wrapPromptWithIdentity('who are you?', 'grok-4.6'), 'who are you?');
});

test('stripIdentityWrapper removes the identity block', () => {
  const wrapped = wrapPromptWithIdentity('who are you?', 'qwen-local');
  assert.match(wrapped, /<identity>/);
  assert.equal(stripIdentityWrapper(wrapped).trim(), 'who are you?');
  assert.equal(stripIdentityWrapper('who are you?'), 'who are you?');
});

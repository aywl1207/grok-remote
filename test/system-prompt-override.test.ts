import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteGrokIdentity, identityLineForModel } from '../lib/system-prompt-override.js';

test('rewriteGrokIdentity replaces only the first identity line', () => {
  const src = 'You are Grok 4.6 released by xAI. You are an interactive CLI tool.\n\n<work_policy>\n- Keep going.\n';
  const out = rewriteGrokIdentity(src, 'qwen-local');
  assert.match(out, /^You are qwen-local/);
  assert.doesNotMatch(out, /You are Grok 4\.6 released/);
  assert.match(out, /<work_policy>/);
  assert.match(out, /Keep going/);
});

test('identityLineForModel names the local model', () => {
  assert.match(identityLineForModel('qwen-local'), /qwen-local/);
  assert.match(identityLineForModel('qwen-local'), /not Grok 4\.6/);
});

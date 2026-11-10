import test from 'node:test';
import assert from 'node:assert/strict';
import { isAutomaticRuntimePrompt } from '../src/lib/rewind-prompts.ts';

test('rewind skips automatic runtime prompts', () => {
  assert.equal(isAutomaticRuntimePrompt('hello'), false);
  assert.equal(isAutomaticRuntimePrompt('<system-reminder>check</system-reminder>'), true);
  assert.equal(isAutomaticRuntimePrompt('[scheduled task] ping'), true);
  assert.equal(isAutomaticRuntimePrompt('[monitor event] disk'), true);
});

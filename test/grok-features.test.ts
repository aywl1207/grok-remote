import test from 'node:test';
import assert from 'node:assert/strict';
import { readTomlSectionBool, setTomlSectionBool } from '../lib/grok-features.ts';

test('setTomlSectionBool toggles one key and keeps the rest', () => {
  const src = '[cli]\ntheme = "dark"\n\n[models]\ndefault_reasoning_effort = "medium"\n';
  const next = setTomlSectionBool(src, 'features', 'subagent_model_inheritance', true);
  assert.match(next, /\[cli\]/);
  assert.match(next, /default_reasoning_effort = "medium"/);
  assert.equal(readTomlSectionBool(next, 'features', 'subagent_model_inheritance'), true);
  const off = setTomlSectionBool(next, 'features', 'subagent_model_inheritance', false);
  assert.equal(readTomlSectionBool(off, 'features', 'subagent_model_inheritance'), false);
  assert.match(off, /\[cli\]/);
});

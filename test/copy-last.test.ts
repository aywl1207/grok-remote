import test from 'node:test';
import assert from 'node:assert/strict';

import { nthLastAssistant, lastAssistantTexts } from '../src/lib/copy.js';

test('nthLastAssistant returns newest first', () => {
  const turns = [
    { assistant: { text: 'first' } },
    { assistant: { text: 'second' } },
    { userText: 'x' },
  ];
  assert.deepEqual(lastAssistantTexts(turns), ['second', 'first']);
  assert.equal(nthLastAssistant(turns, 1), 'second');
  assert.equal(nthLastAssistant(turns, 2), 'first');
  assert.equal(nthLastAssistant(turns, 9), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { toolOutputText } from '../src/lib/render/tools.ts';

test('failed tool output includes rawOutput and a string error', () => {
  const text = toolOutputText({
    status: 'failed',
    rawOutput: { error: 'No such file' },
    error: 'No such file',
  });
  assert.match(text, /No such file/);
});

test('string content is kept', () => {
  assert.equal(toolOutputText({ content: 'permission denied' }), 'permission denied');
});

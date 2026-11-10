import test from 'node:test';
import assert from 'node:assert/strict';
import { atQuery } from '../src/views/chat/at-palette.js';

function ta(value: string, selectionStart: number) {
  return { composerTa: { value, selectionStart } };
}

test('atQuery finds @token at the caret and ignores mid-word', () => {
  assert.deepEqual(atQuery(ta('see @src/a', 10)), { start: 4, q: 'src/a', pos: 10 });
  assert.equal(atQuery(ta('email@x.com', 11)), null);
  assert.equal(atQuery(ta('hello', 5)), null);
  assert.deepEqual(atQuery(ta('@', 1)), { start: 0, q: '', pos: 1 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { insertAtPath } from '../src/views/chat/at-palette.ts';

test('insertAtPath keeps the @ mention', () => {
  const ta = {
    value: 'see @src',
    selectionStart: 8,
    setSelectionRange() {},
    dispatchEvent() {},
    focus() {},
  };
  const view = {
    composerTa: ta,
    _closeAtPalette() {},
  };
  insertAtPath(view, 'src/main.ts', { start: 4, q: 'src', pos: 8 });
  assert.equal(ta.value, 'see @src/main.ts ');
});

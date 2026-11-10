import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractFileDiff,
  cliDiffRows,
  extraDiffCount,
  isEditTool,
} from '../src/lib/tool-diff.js';

test('extractFileDiff reads SearchReplace old_string / new_string', () => {
  const d = extractFileDiff({
    kind: 'edit',
    rawInput: {
      variant: 'SearchReplace',
      file_path: '/tmp/a.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 2',
    },
  });
  assert.ok(d);
  assert.equal(d.path, '/tmp/a.ts');
  assert.equal(d.oldText, 'const a = 1');
  assert.equal(d.newText, 'const a = 2');
});

test('extractFileDiff reads ACP content type=diff', () => {
  const d = extractFileDiff({
    update: {
      kind: 'edit',
      content: [{ type: 'diff', path: 'x.ts', oldText: 'a', newText: 'b' }],
    },
  });
  assert.ok(d);
  assert.equal(d.path, 'x.ts');
  assert.equal(d.oldText, 'a');
  assert.equal(d.newText, 'b');
});

test('extractFileDiff reads Write contents as all-new text', () => {
  const d = extractFileDiff({
    rawInput: { variant: 'Write', file_path: 'n.ts', contents: 'line1\nline2' },
  });
  assert.ok(d);
  assert.equal(d.oldText, '');
  assert.equal(d.newText, 'line1\nline2');
});

test('extractFileDiff joins rawInput.edits', () => {
  const d = extractFileDiff({
    rawInput: {
      file_path: 'm.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    },
  });
  assert.ok(d);
  assert.equal(d.oldText, 'a\n\nc');
  assert.equal(d.newText, 'b\n\nd');
});

test('extractFileDiff returns null when there is no edit text', () => {
  assert.equal(extractFileDiff({ kind: 'edit', rawInput: { file_path: 'a.ts', variant: 'SearchReplace' } }), null);
  assert.equal(extractFileDiff({ kind: 'execute', rawInput: { command: 'ls' } }), null);
});

test('cliDiffRows prefixes old lines with del and new lines with add', () => {
  const rows = cliDiffRows('foo\nbar', 'foo\nbaz');
  assert.deepEqual(rows, [
    { kind: 'del', text: 'foo' },
    { kind: 'del', text: 'bar' },
    { kind: 'add', text: 'foo' },
    { kind: 'add', text: 'baz' },
  ]);
});

test('cliDiffRows treats Write as only ++ rows', () => {
  assert.deepEqual(cliDiffRows('', 'one\ntwo'), [
    { kind: 'add', text: 'one' },
    { kind: 'add', text: 'two' },
  ]);
});

test('cliDiffRows drops a trailing newline as an extra blank row', () => {
  assert.deepEqual(cliDiffRows('a\n', 'b\n'), [
    { kind: 'del', text: 'a' },
    { kind: 'add', text: 'b' },
  ]);
});

test('cliDiffRows caps and extraDiffCount reports the remainder', () => {
  const oldText = Array.from({ length: 60 }, (_, i) => 'o' + i).join('\n');
  const newText = Array.from({ length: 60 }, (_, i) => 'n' + i).join('\n');
  const rows = cliDiffRows(oldText, newText, 10);
  assert.equal(rows.length, 10);
  assert.equal(extraDiffCount(oldText, newText, 10), 110);
});

test('isEditTool matches kind=edit and write/searchreplace variants', () => {
  assert.equal(isEditTool({ kind: 'edit' }), true);
  assert.equal(isEditTool({ rawInput: { variant: 'SearchReplace' } }), true);
  assert.equal(isEditTool({ rawInput: { variant: 'Write' } }), true);
  assert.equal(isEditTool({ kind: 'execute', rawInput: { command: 'ls' } }), false);
});

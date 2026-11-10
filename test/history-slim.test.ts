import test from 'node:test';
import assert from 'node:assert/strict';

import { slimToolData } from '../lib/history.js';

test('slimToolData keeps SearchReplace old/new strings for ++/-- replay', () => {
  const slim = slimToolData({
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      kind: 'edit',
      title: 'Edit a.ts',
      rawInput: {
        variant: 'SearchReplace',
        file_path: 'a.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2',
      },
    },
  }) as { update: { rawInput: Record<string, string> } };
  assert.equal(slim.update.rawInput.old_string, 'const a = 1');
  assert.equal(slim.update.rawInput.new_string, 'const a = 2');
  assert.equal(slim.update.rawInput.file_path, 'a.ts');
});

test('slimToolData keeps ACP type=diff content', () => {
  const slim = slimToolData({
    kind: 'edit',
    content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }],
    rawInput: { variant: 'SearchReplace', file_path: 'a.ts' },
  }) as { content: Array<{ type: string; oldText: string; newText: string }> };
  assert.equal(slim.content[0]!.type, 'diff');
  assert.equal(slim.content[0]!.oldText, 'x');
  assert.equal(slim.content[0]!.newText, 'y');
});

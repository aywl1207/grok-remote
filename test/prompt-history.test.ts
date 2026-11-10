import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergePromptHistory,
  rememberPrompt,
  promptsFromTurns,
  parseStoredPromptHistory,
  previewPrompt,
  PROMPT_HIST_CAP,
} from '../src/lib/prompt-history.js';

test('mergePromptHistory keeps stored order and appends missing conversation prompts', () => {
  const stored = ['new', 'mid'];
  const turns = ['oldest', 'mid', 'new'];
  assert.deepEqual(mergePromptHistory(stored, turns), ['new', 'mid', 'oldest']);
});

test('mergePromptHistory recovers when stored was capped short of the conversation', () => {
  // Old cap kept the 80 newest (p100..p21). Older p20..p1 were dropped.
  const stored: string[] = [];
  for (let i = 100; i >= 21; i--) stored.push('p' + i);
  const turns: string[] = [];
  for (let i = 100; i >= 1; i--) turns.push('p' + i);
  const out = mergePromptHistory(stored, turns);
  assert.equal(out.length, 100);
  assert.equal(out[0], 'p100');
  assert.equal(out[79], 'p21');
  assert.equal(out[80], 'p20');
  assert.equal(out[99], 'p1');
});

test('promptsFromTurns is newest first and skips empty', () => {
  const turns = [{ userText: 'one' }, { userText: '' }, { userText: 'two' }];
  assert.deepEqual(promptsFromTurns(turns), ['two', 'one']);
});

test('rememberPrompt moves a repeat to the front and caps', () => {
  const next = rememberPrompt(['a', 'b', 'c'], 'b', 3);
  assert.deepEqual(next, ['b', 'a', 'c']);
  const capped = rememberPrompt(['a', 'b'], 'z', 2);
  assert.deepEqual(capped, ['z', 'a']);
});

test('synthetic / compact wrappers are not stored', () => {
  const out = mergePromptHistory(
    ['keep'],
    ['This session is being continued from a previous conversation.', '<user_info>x</user_info>'],
  );
  assert.deepEqual(out, ['keep']);
  assert.deepEqual(rememberPrompt(['keep'], '<system-reminder>nope</system-reminder>'), ['keep']);
});

test('parseStoredPromptHistory ignores junk and empty', () => {
  assert.deepEqual(parseStoredPromptHistory(null), []);
  assert.deepEqual(parseStoredPromptHistory('nope'), []);
  assert.deepEqual(parseStoredPromptHistory('["hi", ""]'), ['hi']);
});

test('cap default is well above a 100-turn conversation', () => {
  assert.ok(PROMPT_HIST_CAP >= 500);
});


test('previewPrompt appends an ellipsis when the record is too long', () => {
  const long = 'one two three four five six seven eight nine ten ' + 'word'.repeat(40);
  const out = previewPrompt(long, 40);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 41);
  assert.equal(previewPrompt('short'), 'short');
});

test('previewPrompt ellipsizes a single long token', () => {
  const out = previewPrompt('x'.repeat(200), 40);
  assert.equal(out, 'x'.repeat(40) + '…');
});

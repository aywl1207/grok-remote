import test from 'node:test';
import assert from 'node:assert/strict';
import { slashHintHasRequiredArg } from '../src/lib/slash-palette.ts';

test('optional and empty slash hints run immediately', () => {
  assert.equal(slashHintHasRequiredArg(null), false);
  assert.equal(slashHintHasRequiredArg(''), false);
  assert.equal(slashHintHasRequiredArg('[description]'), false);
  assert.equal(slashHintHasRequiredArg('[what to keep]'), false);
});

test('a required argument keeps the composer space', () => {
  assert.equal(slashHintHasRequiredArg('<description>'), true);
  assert.equal(slashHintHasRequiredArg('[interval] <prompt>'), true);
});

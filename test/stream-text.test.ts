import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStreamChunk, mergeAfterGap } from '../src/lib/stream-text.js';

test('mergeStreamChunk appends a repeated last character', () => {
  const r = mergeStreamChunk('你好', '好');
  assert.deepEqual(r, { append: '好', next: '你好好', acc: '' });
});

test('mergeStreamChunk does not drop a one-letter English token', () => {
  const r = mergeStreamChunk('the', 'e');
  assert.deepEqual(r, { append: 'e', next: 'thee', acc: '' });
});

test('mergeStreamChunk treats a growing snapshot as a suffix', () => {
  const r = mergeStreamChunk('hello wo', 'hello world');
  assert.deepEqual(r, { append: 'rld', next: 'hello world', acc: '' });
});

test('mergeStreamChunk skips an exact snapshot replay', () => {
  assert.equal(mergeStreamChunk('hello', 'hello'), null);
});

test('mergeStreamChunk skips a long duplicate suffix', () => {
  assert.equal(mergeStreamChunk('0123456789abcdef', '89abcdef'), null);
});

test('mergeStreamChunk holds a short restream prefix instead of dropping it', () => {
  const held = mergeStreamChunk('The 502 was because grok-remote was stopped', 'The');
  assert.deepEqual(held, {
    append: '',
    next: 'The 502 was because grok-remote was stopped',
    acc: 'The',
  });
  const cont = mergeStreamChunk('The 502 was because grok-remote was stopped', ' 502', held!.acc);
  assert.equal(cont && cont.append, '');
  assert.equal(cont && cont.acc, 'The 502');
});

test('mergeStreamChunk restores a prefix token when the next chunk is new text', () => {
  const held = mergeStreamChunk('三個問題', '三');
  assert.equal(held && held.acc, '三');
  assert.equal(held && held.append, '');
  const next = mergeStreamChunk('三個問題', '症', held!.acc);
  assert.deepEqual(next, { append: '三症', next: '三個問題三症', acc: '' });
});

test('mergeAfterGap reuses the bubble when the snapshot grows', () => {
  const r = mergeAfterGap('hello world', 'hello world more', '');
  assert.deepEqual(r, { kind: 'reuse', append: ' more', next: 'hello world more' });
});

test('mergeAfterGap does not eat the first CJK char of a new reply', () => {
  const r = mergeAfterGap('你好世界這是舊回覆', '好的，下一步', '');
  assert.equal(r.kind, 'fresh');
  if (r.kind === 'fresh') assert.equal(r.append, '好的，下一步');
});

test('mergeAfterGap skips a long restream prefix', () => {
  const r = mergeAfterGap('hello world and more', 'hello wo', '');
  assert.equal(r.kind, 'skip');
});


test('mergeAfterGap skips a short restream prefix after a gap', () => {
  const r = mergeAfterGap('The last Grok reply is already painted', 'The', '');
  assert.equal(r.kind, 'skip');
  if (r.kind === 'skip') assert.equal(r.acc, 'The');
});

test('mergeAfterGap keeps a held prefix when the next chunk is a new reply', () => {
  const r = mergeAfterGap('三個問題我先對上', '症', '三個');
  assert.equal(r.kind, 'fresh');
  if (r.kind === 'fresh') assert.equal(r.append, '三個症');
});

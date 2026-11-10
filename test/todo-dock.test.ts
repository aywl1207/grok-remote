import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeTodos, pickActiveTodoList } from '../src/lib/todo-dock.js';

test('summarizeTodos is inactive when empty or all completed', () => {
  assert.equal(summarizeTodos([]).active, false);
  assert.equal(summarizeTodos([
    { id: '1', content: 'A', status: 'completed' },
  ]).active, false);
});

test('summarizeTodos counts progress and picks the in-progress item', () => {
  const s = summarizeTodos([
    { id: '1', content: 'Read sidebar', status: 'in_progress' },
    { id: '2', content: 'Wire agents', status: 'pending' },
    { id: '3', content: 'Build', status: 'pending' },
    { id: '4', content: 'Verify', status: 'pending' },
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.done, 0);
  assert.equal(s.inProgress, 1);
  assert.equal(s.active, true);
  assert.equal(s.current && s.current.content, 'Read sidebar');
});

test('summarizeTodos falls back to the next pending item', () => {
  const s = summarizeTodos([
    { id: '1', content: 'Done item', status: 'completed' },
    { id: '2', content: 'Next up', status: 'pending' },
  ]);
  assert.equal(s.done, 1);
  assert.equal(s.inProgress, 0);
  assert.equal(s.current && s.current.content, 'Next up');
  assert.equal(s.active, true);
});


test('pickActiveTodoList uses the newest open list and ignores old completed ones', () => {
  const oldOpen = [
    { id: 'a', content: 'Ancient', status: 'in_progress' },
    { id: 'b', content: 'Also old', status: 'pending' },
  ];
  const done = [
    { id: 'c', content: 'Finished', status: 'completed' },
  ];
  const current = [
    { id: 'd', content: 'Now', status: 'in_progress' },
    { id: 'e', content: 'Later', status: 'pending' },
  ];
  const picked = pickActiveTodoList([oldOpen, done, current]);
  assert.deepEqual(picked.map((x) => x.id), ['d', 'e']);
});

test('pickActiveTodoList does not fall back to an older leftover list', () => {
  const older = [{ id: 'a', content: 'Still going', status: 'pending' }];
  const latest = [{ id: 'b', content: 'Done', status: 'completed' }];
  const picked = pickActiveTodoList([older, latest]);
  assert.deepEqual(picked, []);
});

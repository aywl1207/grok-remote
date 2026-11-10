import test from 'node:test';
import assert from 'node:assert/strict';

import { pruneTurnToolCards } from '../src/lib/tool-cap.js';

function entry(id: string, todo = false) {
  let removed = false;
  return {
    id,
    card: {
      isTodo: todo,
      node: { remove: () => { removed = true; } },
    },
    get removed() { return removed; },
  };
}

test('pruneTurnToolCards keeps the last N and removes older nodes', () => {
  const tools = [entry('a'), entry('b'), entry('c'), entry('d')];
  pruneTurnToolCards(tools, 2);
  assert.deepEqual(tools.map((t: any) => t.id), ['c', 'd']);
  assert.equal((tools as any).length, 2);
});

test('pruneTurnToolCards keeps todo cards in addition to the cap', () => {
  const tools = [entry('todo', true), entry('a'), entry('b'), entry('c')];
  pruneTurnToolCards(tools, 2);
  assert.deepEqual(tools.map((t: any) => t.id), ['todo', 'b', 'c']);
});

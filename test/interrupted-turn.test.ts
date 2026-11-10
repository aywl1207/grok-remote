import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldMarkInterruptedTurn } from '../src/lib/interrupted-turn.ts';

test('interrupted marker is only for a dead session with no reply', () => {
  assert.equal(shouldMarkInterruptedTurn({
    userText: 'hello', hasAssistant: false, hasTools: false, turnOpen: false, status: 'errored',
  }), true);
  assert.equal(shouldMarkInterruptedTurn({
    userText: 'hello', hasAssistant: false, hasTools: false, turnOpen: false, status: 'idle',
  }), false);
  assert.equal(shouldMarkInterruptedTurn({
    userText: 'hello', hasAssistant: true, hasTools: false, turnOpen: false, status: 'disconnected',
  }), false);
});

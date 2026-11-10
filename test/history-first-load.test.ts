import test from 'node:test';
import assert from 'node:assert/strict';

import { FIRST_LOAD_TURNS, LOAD_EARLIER_STEP, nextEarlierTurnCount } from '../src/views/chat/history-replay.js';

test('first open and load-earlier both use a 3-turn page', () => {
  assert.equal(FIRST_LOAD_TURNS, 3);
  assert.equal(LOAD_EARLIER_STEP, 3);
});

test('nextEarlierTurnCount pages by 3 and never dumps the rest', () => {
  assert.equal(nextEarlierTurnCount(3, 156), 3);
  assert.equal(nextEarlierTurnCount(153, 156), 3);
  assert.equal(nextEarlierTurnCount(154, 156), 2);
  assert.equal(nextEarlierTurnCount(155, 156), 1);
  assert.equal(nextEarlierTurnCount(156, 156), 0);
  assert.equal(nextEarlierTurnCount(0, 2), 2);
});

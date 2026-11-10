import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scrollFollowAction,
  liveTurnUsesHistoryPin,
  applyForceScrollFlags,
  holdScrollForPrepend,
  pinScrollDelta,
  restorePinScroll,
} from '../src/lib/chat-scroll.js';

test('programmatic snap does not pause follow after send', () => {
  assert.equal(scrollFollowAction({
    atBottom: false,
    autoScroll: true,
    userScrollIntent: false,
    lastEasedWrite: 400,
    scrollTop: 400,
  }), 'keep');
  assert.equal(scrollFollowAction({
    atBottom: false,
    autoScroll: true,
    userScrollIntent: false,
    lastEasedWrite: 10,
    scrollTop: 400,
    programmaticUntil: 200,
    now: 100,
  }), 'keep');
});

test('real user scroll-away pauses follow', () => {
  assert.equal(scrollFollowAction({
    atBottom: false,
    autoScroll: true,
    userScrollIntent: true,
    lastEasedWrite: 400,
    scrollTop: 120,
  }), 'pause');
});

test('returning to bottom resumes follow', () => {
  assert.equal(scrollFollowAction({
    atBottom: true,
    autoScroll: false,
    userScrollIntent: false,
    lastEasedWrite: 0,
    scrollTop: 800,
  }), 'resume');
});

test('live send does not use the history prepend pin', () => {
  assert.equal(liveTurnUsesHistoryPin(false, false), false);
  assert.equal(liveTurnUsesHistoryPin(true, false), true);
  assert.equal(liveTurnUsesHistoryPin(false, true), true);
});

test('force scroll clears quiet so the reply can follow', () => {
  const view = { _quietScroll: true, _autoScroll: false, _userScrollIntent: true };
  applyForceScrollFlags(view);
  assert.equal(view._quietScroll, false);
  assert.equal(view._autoScroll, true);
  assert.equal(view._userScrollIntent, false);
  assert.ok((view._programmaticScrollUntil || 0) > Date.now());
});

test('holdScrollForPrepend pauses follow so prepend cannot snap to latest', () => {
  const view = {
    _quietScroll: false,
    _autoScroll: true,
    _userScrollIntent: false,
    _easedScrollPending: true,
    _easedScrollRaf: 0,
  };
  holdScrollForPrepend(view);
  assert.equal(view._quietScroll, true);
  assert.equal(view._autoScroll, false);
  assert.equal(view._userScrollIntent, true);
  assert.equal(view._easedScrollPending, false);
});

test('restorePinScroll keeps the pinned turn in place after prepend', () => {
  assert.equal(pinScrollDelta(80, 280), 200);
  const stream = { scrollTop: 40 };
  assert.equal(restorePinScroll(stream, 80, 280), 240);
  assert.equal(stream.scrollTop, 240);
});

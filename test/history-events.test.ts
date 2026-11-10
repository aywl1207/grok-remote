import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eventNameOf,
  shouldSkipCatchUpEvent,
  shouldSkipHistoryReplay,
  isHistoryPass1,
  classifyHistoryPass2,
  splitHistoryLatestTurn,
  shouldSkipHistoryCatchUp,
  shouldSkipCatchUpFetch,
  dropEventsBeforeFirstUser,
  rewindKeepTurns,
} from '../src/lib/history-events.js';

test('eventNameOf prefers event then type then name', () => {
  assert.equal(eventNameOf({ event: 'user_message', type: 'x' }), 'user_message');
  assert.equal(eventNameOf({ type: 'tool_call' }), 'tool_call');
  assert.equal(eventNameOf(null), '');
});

test('catch-up keeps error; full replay drops error', () => {
  assert.equal(shouldSkipCatchUpEvent('error'), false);
  assert.equal(shouldSkipHistoryReplay('error'), true);
  assert.equal(shouldSkipCatchUpEvent('agent_status'), true);
  assert.equal(shouldSkipHistoryReplay('handshake'), true);
});

test('two-pass history classification', () => {
  assert.equal(isHistoryPass1('user_message'), true);
  assert.equal(isHistoryPass1('agent_thought_chunk'), false);
  assert.equal(classifyHistoryPass2('user_message'), 'user');
  assert.equal(classifyHistoryPass2('agent_message_chunk'), 'skip');
  assert.equal(classifyHistoryPass2('prompt_complete'), 'skip');
  assert.equal(classifyHistoryPass2('agent_thought_chunk'), 'paint');
  assert.equal(classifyHistoryPass2('tool_call'), 'paint');
  assert.equal(classifyHistoryPass2('agent_status'), 'skip');
});

test('splitHistoryLatestTurn keeps last user and after', () => {
  const events = [
    { event: 'user_message' },
    { event: 'agent_message_chunk' },
    { event: 'user_message' },
    { event: 'agent_thought_chunk' },
    { event: 'prompt_complete' },
    { event: 'agent_message_chunk' },
  ];
  const { older, latest, lastUserIndex } = splitHistoryLatestTurn(events);
  assert.equal(lastUserIndex, 2);
  assert.equal(older.length, 2);
  assert.equal(latest[0].event, 'user_message');
  assert.equal(latest[latest.length - 1].event, 'agent_message_chunk');
  assert.equal(latest.length, 4);
});

test('splitHistoryLatestTurn empty and single turn', () => {
  assert.deepEqual(splitHistoryLatestTurn([]), { older: [], latest: [], lastUserIndex: -1 });
  const one = [{ event: 'user_message' }, { event: 'agent_message_chunk' }];
  const s = splitHistoryLatestTurn(one);
  assert.equal(s.lastUserIndex, 0);
  assert.equal(s.older.length, 0);
  assert.equal(s.latest.length, 2);
});

test('shouldSkipHistoryCatchUp only looks at the last turn', () => {
  assert.equal(shouldSkipHistoryCatchUp({
    lastHistUser: 'hi',
    turns: [{ userText: 'hi', assistant: { n: 1 } }, { userText: 'next', assistant: { n: 1 } }],
  }), false);
  assert.equal(shouldSkipHistoryCatchUp({
    lastHistUser: 'hi',
    turns: [{ userText: 'older', assistant: { n: 1 } }, { userText: 'hi', assistant: { n: 1 } }],
  }), true);
  assert.equal(shouldSkipHistoryCatchUp({
    lastHistUser: 'hi',
    turns: [{ userText: 'hi', assistant: null }],
  }), false);
  assert.equal(shouldSkipHistoryCatchUp({ lastHistUser: 'hi', turns: [] }), false);
});

test('shouldSkipCatchUpFetch skips a finished first paint so last-N You rows are not appended', () => {
  assert.equal(shouldSkipCatchUpFetch({
    force: false, historyLoaded: true, turnCount: 3,
  }), true);
  assert.equal(shouldSkipCatchUpFetch({
    force: true, historyLoaded: true, turnCount: 3, lastTurnComplete: false,
  }), false);
  assert.equal(shouldSkipCatchUpFetch({
    force: false, historyLoaded: true, turnCount: 3, lastTurnComplete: true,
  }), true);
  assert.equal(shouldSkipCatchUpFetch({
    force: false, historyLoaded: false, turnCount: 0,
  }), false);
  assert.equal(shouldSkipCatchUpFetch({
    force: true, historyLoaded: false, turnCount: 0,
  }), false);
  assert.equal(shouldSkipCatchUpFetch({
    force: false, historyLoaded: true, turnCount: 2, activeTurn: true,
  }), true);
  assert.equal(shouldSkipCatchUpFetch({ replaying: true, historyLoaded: false }), true);
});

test('rewindKeepTurns maps a painted tail index onto the journal', () => {
  assert.equal(rewindKeepTurns(50, 3, 0), 48);
  assert.equal(rewindKeepTurns(50, 3, 2), 50);
  assert.equal(rewindKeepTurns(3, 3, 0), 1);
});

test('dropEventsBeforeFirstUser strips leftover reply before the first You', () => {
  const events = [
    { event: 'agent_message_chunk', data: { text: 'OLD-TAIL' } },
    { event: 'agent_thought_chunk', data: { text: 'old thought' } },
    { event: 'user_message', data: { text: 'latest ask' } },
    { event: 'agent_message_chunk', data: { text: 'new reply' } },
  ];
  const out = dropEventsBeforeFirstUser(events);
  assert.equal(out.length, 2);
  assert.equal(out[0].event, 'user_message');
  assert.equal(dropEventsBeforeFirstUser([{ event: 'agent_message_chunk' }]).length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { lastTurnIsOpen, lastTurnIsOpenFromNdjson, TURN_STALE_MS } from '../lib/turn-open.js';

const now = Date.parse('2026-08-18T06:00:00.000Z');
const recent = '2026-08-18T05:50:00.000Z';
const old = '2026-08-17T09:47:00.000Z';

test('lastTurnIsOpen is false until a user message', () => {
  assert.equal(lastTurnIsOpen([], now), false);
  assert.equal(lastTurnIsOpen([{ event: 'agent_status', at: recent }], now), false);
});

test('lastTurnIsOpen is true after recent user with no prompt_complete', () => {
  assert.equal(lastTurnIsOpen([
    { event: 'user_message', at: recent },
    { event: 'agent_thought_chunk', at: recent },
    { event: 'tool_call', at: recent },
  ], now), true);
});

test('lastTurnIsOpen is false after prompt_complete', () => {
  assert.equal(lastTurnIsOpen([
    { event: 'user_message', at: recent },
    { event: 'agent_message_chunk', at: recent },
    { event: 'prompt_complete', at: recent },
  ], now), false);
});

test('lastTurnIsOpen follows the newest user turn', () => {
  assert.equal(lastTurnIsOpen([
    { event: 'user_message', at: old },
    { event: 'prompt_complete', at: old },
    { event: 'user_message', at: recent },
    { event: 'agent_thought_chunk', at: recent },
  ], now), true);
  assert.equal(lastTurnIsOpen([
    { event: 'user_message', at: recent },
    { event: 'prompt_complete', at: recent },
    { event: 'user_message', at: recent },
    { event: 'prompt_complete', at: recent },
  ], now), false);
});

test('session_ready after last work closes the turn', () => {
  assert.equal(lastTurnIsOpen([
    { event: 'user_message', at: recent },
    { event: 'agent_thought_chunk', at: recent },
    { event: 'session_ready', at: recent },
  ], now), false);
});

test('session_ready during recent live work keeps the turn open', () => {
  const few = '2026-08-18T05:59:30.000Z';
  assert.equal(lastTurnIsOpen([
    { event: 'user_message', at: few },
    { event: 'tool_call', at: few },
    { event: 'session_ready', at: few },
  ], now), true);
});

test('work after session_ready keeps the turn open', () => {
  assert.equal(lastTurnIsOpen([
    { event: 'user_message', at: recent },
    { event: 'session_ready', at: recent },
    { event: 'agent_thought_chunk', at: recent },
  ], now), true);
});

test('stale last turn with no prompt_complete is not open', () => {
  assert.equal(lastTurnIsOpen([
    { event: 'user_message', at: old },
    { event: 'agent_thought_chunk', at: old },
    { event: 'agent_message_chunk', at: old },
  ], now), false);
  assert.ok(now - Date.parse(old) > TURN_STALE_MS);
});

test('just-sent user with no work yet is still open', () => {
  assert.equal(lastTurnIsOpen([
    { event: 'session_ready', at: old },
    { event: 'user_message', at: recent },
  ], now), true);
});

test('lastTurnIsOpenFromNdjson parses lines', () => {
  const text = [
    `{"event":"user_message","at":"${recent}"}`,
    `{"event":"agent_thought_chunk","at":"${recent}"}`,
    'not-json',
    `{"event":"tool_call","at":"${recent}"}`,
  ].join('\n');
  assert.equal(lastTurnIsOpenFromNdjson(text, now), true);
  assert.equal(lastTurnIsOpenFromNdjson(
    `{"event":"user_message","at":"${recent}"}\n{"event":"prompt_complete","at":"${recent}"}\n`,
    now,
  ), false);
});

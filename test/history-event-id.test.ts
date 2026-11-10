import test from 'node:test';
import assert from 'node:assert/strict';
import { maxLiveEventIdInLines } from '../lib/history.js';

test('maxLiveEventIdInLines keeps the newest raw chunk id', () => {
  const lines = [
    '{"event":"user_message","eventId":"1700000000000-1"}',
    '{"event":"agent_message_chunk","eventId":"1700000000000-2","data":{"_meta":{"eventId":"1700000000000-2"}}}',
    '{"event":"agent_message_chunk","eventId":"1700000000100-40"}',
  ];
  assert.equal(maxLiveEventIdInLines(lines), '1700000000100-40');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenFromMeta,
  occupancyFromEventData,
  lastOccupancyFromEvents,
  scanLastTotalTokens,
} from '../lib/token-occupancy.js';

test('tokenFromMeta reads either field', () => {
  assert.equal(tokenFromMeta({ totalTokens: 12 }), 12);
  assert.equal(tokenFromMeta({ total_tokens: 9 }), 9);
  assert.equal(tokenFromMeta({ totalTokens: -1 }), 0);
  assert.equal(tokenFromMeta(null), 0);
});

test('occupancyFromEventData skips replay and child sessions', () => {
  assert.equal(occupancyFromEventData({
    sessionId: 'parent',
    _meta: { totalTokens: 100 },
  }, 'parent'), 100);
  assert.equal(occupancyFromEventData({
    sessionId: 'child',
    _meta: { totalTokens: 900 },
  }, 'parent'), null);
  assert.equal(occupancyFromEventData({
    sessionId: 'parent',
    _meta: { totalTokens: 100, isReplay: true },
  }, 'parent'), null);
});

test('lastOccupancyFromEvents keeps the last parent value, not the peak', () => {
  const n = lastOccupancyFromEvents([
    { event: 'session_ready', data: { sessionId: 'p' } },
    { event: 'agent_thought_chunk', data: { sessionId: 'p', _meta: { totalTokens: 399_013 } } },
    { event: 'agent_thought_chunk', data: { sessionId: 'child', _meta: { totalTokens: 12 } } },
    { event: 'agent_thought_chunk', data: { sessionId: 'p', _meta: { totalTokens: 146_310 } } },
  ]);
  assert.equal(n, 146_310);
});

test('scanLastTotalTokens parses JSONL', () => {
  const raw = [
    '{"event":"session_ready","data":{"sessionId":"p"}}',
    '{"event":"agent_thought_chunk","data":{"sessionId":"p","_meta":{"totalTokens":200000}}}',
    '{"event":"agent_thought_chunk","data":{"sessionId":"p","_meta":{"totalTokens":146310}}}',
  ].join('\n');
  assert.equal(scanLastTotalTokens(raw), 146310);
});

test('tokenFromMeta ignores lifetime-sized totals', () => {
  assert.equal(tokenFromMeta({ totalTokens: 31_138_726 }), 0);
});

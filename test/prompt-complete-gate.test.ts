import test from 'node:test';
import assert from 'node:assert/strict';
import { promptCompleteGate } from '../src/lib/prompt-complete.ts';
import { waitingSubagentLabel } from '../src/lib/subagent-wait.ts';
import { nextTimestampMode, parseTimestampMode } from '../src/lib/timestamps.ts';

test('stuck pending cards do not block the queue when the server is idle', () => {
  assert.equal(promptCompleteGate({ localInFlight: 1, openTools: true, serverFlight: 2 }), 'wait');
  assert.equal(promptCompleteGate({ localInFlight: 1, openTools: true, serverFlight: 0 }), 'close-and-finish');
  assert.equal(promptCompleteGate({ localInFlight: 0, openTools: false, serverFlight: 0 }), 'finish');
});

test('subagent wait copy and timestamp cycle', () => {
  assert.equal(waitingSubagentLabel(1), 'Waiting for 1 subagent…');
  assert.equal(waitingSubagentLabel(3), 'Waiting for 3 subagents…');
  assert.equal(parseTimestampMode('0'), 'off');
  assert.equal(parseTimestampMode(null), 'on');
  assert.equal(nextTimestampMode('on'), 'minimal');
  assert.equal(nextTimestampMode('minimal'), 'off');
  assert.equal(nextTimestampMode('off'), 'on');
});

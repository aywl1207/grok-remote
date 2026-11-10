import test from 'node:test';
import assert from 'node:assert/strict';

import { dropResumeRestreamLines, eventIsReplay, shouldDropResumeRestream } from '../lib/attach-replay.js';

test('eventIsReplay reads _meta.isReplay only', () => {
  assert.equal(eventIsReplay({ _meta: { isReplay: true } }), true);
  assert.equal(eventIsReplay({ _meta: { isReplay: false } }), false);
  assert.equal(eventIsReplay({ update: { status: 'completed' } }), false);
  assert.equal(eventIsReplay(null), false);
});

test('shouldDropResumeRestream drops replay and the pre-ready gate', () => {
  assert.equal(shouldDropResumeRestream({ awaitingReady: true, isReplay: false }), true);
  assert.equal(shouldDropResumeRestream({ awaitingReady: false, isReplay: true }), true);
  assert.equal(shouldDropResumeRestream({ awaitingReady: true, isReplay: true }), true);
  assert.equal(shouldDropResumeRestream({ awaitingReady: false, isReplay: false }), false);
});

test('dropResumeRestreamLines removes replay text and tools in that second', () => {
  const user = JSON.stringify({ at: '2026-11-10T02:00:00.000Z', event: 'user_message', data: { text: 'hi' } });
  const keepTool = JSON.stringify({
    at: '2026-11-10T01:00:00.000Z', event: 'tool_call',
    data: { update: { toolCallId: 'live', status: 'completed' } },
  });
  const replayThought = JSON.stringify({
    at: '2026-11-10T02:23:20.100Z', event: 'agent_thought_chunk',
    data: { _meta: { isReplay: true }, update: { content: { text: 'old' } } },
  });
  const burstTool = JSON.stringify({
    at: '2026-11-10T02:23:20.200Z', event: 'tool_call',
    data: { update: { toolCallId: 'burst', status: 'completed' } },
  });
  const burstUpdate = JSON.stringify({
    at: '2026-11-10T02:23:20.300Z', event: 'tool_call_update',
    data: { update: { toolCallId: 'burst', status: 'completed' } },
  });
  const ready = JSON.stringify({ at: '2026-11-10T02:23:20.900Z', event: 'session_ready', data: { sessionId: 's' } });
  const laterTool = JSON.stringify({
    at: '2026-11-10T02:23:21.100Z', event: 'tool_call',
    data: { update: { toolCallId: 'after', status: 'pending' } },
  });
  const out = dropResumeRestreamLines([user, keepTool, replayThought, burstTool, burstUpdate, ready, laterTool]);
  const ids = out.map((l) => {
    const o = JSON.parse(l) as { event: string; data?: { update?: { toolCallId?: string } } };
    return o.event + ':' + (o.data?.update?.toolCallId || '');
  });
  assert.deepEqual(ids, ['user_message:', 'tool_call:live', 'session_ready:', 'tool_call:after']);
});

test('historical statusful tool without an isReplay sibling is kept', () => {
  const old = JSON.stringify({
    at: '2026-08-01T00:00:00.000Z', event: 'tool_call',
    data: { update: { toolCallId: 'old', status: 'completed', title: 'Exec' } },
  });
  const out = dropResumeRestreamLines([old]);
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]!).data.update.toolCallId, 'old');
});

test('multi-second replay drops tools in every second that contains isReplay', () => {
  const lines = [
    JSON.stringify({ at: '2026-11-10T02:26:15.100Z', event: 'agent_thought_chunk', data: { _meta: { isReplay: true } } }),
    JSON.stringify({ at: '2026-11-10T02:26:15.200Z', event: 'tool_call', data: { update: { toolCallId: 'prev', status: 'completed' } } }),
    JSON.stringify({ at: '2026-11-10T02:26:16.100Z', event: 'agent_message_chunk', data: { _meta: { isReplay: true } } }),
    JSON.stringify({ at: '2026-11-10T02:26:16.200Z', event: 'tool_call', data: { update: { toolCallId: 'same', status: 'failed' } } }),
    JSON.stringify({ at: '2026-11-10T02:26:16.900Z', event: 'session_ready', data: {} }),
    JSON.stringify({ at: '2026-11-10T02:26:17.100Z', event: 'tool_call', data: { update: { toolCallId: 'live', status: 'pending' } } }),
  ];
  const out = dropResumeRestreamLines(lines).map((l) => {
    const o = JSON.parse(l) as { event: string; data?: { update?: { toolCallId?: string } } };
    return o.event + ':' + (o.data?.update?.toolCallId || '');
  });
  assert.deepEqual(out, ['session_ready:', 'tool_call:live']);
});

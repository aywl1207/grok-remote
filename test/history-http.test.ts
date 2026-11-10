import test from 'node:test';
import assert from 'node:assert/strict';

import { compactHistoryForHttp, sliceHistoryByTurns, historyWantsAll } from '../lib/history.js';
import { appendNewerSessionTurns, mergeEventLines } from '../lib/transcript.js';

test('compactHistoryForHttp drops GET-only noise and keeps user/reply', () => {
  const lines = [
    JSON.stringify({ event: 'session_ready', data: {} }),
    JSON.stringify({ event: 'user_message', data: { text: 'hi' } }),
    JSON.stringify({ event: 'agent_thought_chunk', data: { update: { content: { type: 'text', text: 'a' } } } }),
    JSON.stringify({ event: 'agent_thought_chunk', data: { update: { content: { type: 'text', text: 'b' } } } }),
    JSON.stringify({ event: 'plan', data: {} }),
    JSON.stringify({ event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'ok' } } } }),
    JSON.stringify({ event: 'agent_exited', data: {} }),
  ];
  const out = compactHistoryForHttp(lines).map((l) => JSON.parse(l) as { event: string });
  assert.deepEqual(out.map((e) => e.event), [
    'user_message',
    'agent_thought_chunk',
    'agent_message_chunk',
  ]);
  const thought = out[1]!.data as { update: { content: { text: string } } };
  assert.equal(thought.update.content.text, 'ab');
});

test('sliceHistoryByTurns returns the last N user turns and compact text', () => {
  const lines: string[] = [];
  for (let i = 1; i <= 5; i++) {
    lines.push(JSON.stringify({ event: 'user_message', data: { text: 'u' + i } }));
    lines.push(JSON.stringify({ event: 'agent_message_chunk', data: { update: { content: { text: 'a' + i } } } }));
  }
  const raw = lines.join('\n') + '\n';
  const all = sliceHistoryByTurns(raw, { all: true, turns: 2 });
  assert.equal(all.totalTurns, 5);
  assert.equal(all.returnedTurns, 5);
  const tail = sliceHistoryByTurns(raw, { all: false, turns: 2 });
  assert.equal(tail.totalTurns, 5);
  assert.equal(tail.returnedTurns, 2);
  assert.match(tail.text, /"u4"/);
  assert.match(tail.text, /"u5"/);
  assert.doesNotMatch(tail.text, /"u1"/);
});

test('compactHistoryForHttp keeps last snapshot of a tool and fills status', () => {
  const lines = [
    JSON.stringify({ event: 'user_message', data: { text: 'hi' } }),
    JSON.stringify({ event: 'tool_call', data: { update: { toolCallId: 't1', title: 'Exec', status: 'pending' } } }),
    JSON.stringify({ event: 'tool_call_update', data: { update: { toolCallId: 't1', status: 'completed' } } }),
  ];
  const out = compactHistoryForHttp(lines).map((l) => JSON.parse(l) as { event: string; data: { update: { toolCallId: string; status: string } } });
  const tools = out.filter((e) => e.event === 'tool_call' || e.event === 'tool_call_update');
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.event, 'tool_call');
  assert.equal(tools[0]!.data.update.toolCallId, 't1');
  assert.equal(tools[0]!.data.update.status, 'completed');
});

test('historyWantsAll tails huge journals on first load', () => {
  assert.equal(historyWantsAll(true, 151, 3), true);
  assert.equal(historyWantsAll(false, 151, 3), false);
  assert.equal(historyWantsAll(false, 8, 3), true);
  assert.equal(historyWantsAll(false, 9, 3), false);
  assert.equal(historyWantsAll(false, 20, 10), false);
  assert.equal(historyWantsAll(false, 0, 3), true);
});

test('compactHistoryForHttp keeps compact x.ai/session/update and drops other x.ai noise', () => {
  const lines = [
    JSON.stringify({ event: 'user_message', data: { text: 'hi' } }),
    JSON.stringify({ event: 'x.ai/session/update', data: { params: { update: { sessionUpdate: 'auto_compact_started', percentage: 90 } } } }),
    JSON.stringify({ event: 'x.ai/session/update', data: { params: { update: { sessionUpdate: 'current_mode_update' } } } }),
    JSON.stringify({ event: 'x.ai/sessions/changed', data: {} }),
    JSON.stringify({ event: 'agent_message_chunk', data: { text: 'ok' } }),
  ];
  const out = compactHistoryForHttp(lines).map((l) => JSON.parse(l) as { event: string; data?: { params?: { update?: { sessionUpdate?: string } } } });
  const names = out.map((e) => e.event + ':' + ((e.data && e.data.params && e.data.params.update && e.data.params.update.sessionUpdate) || ''));
  assert.ok(names.some((n) => n.startsWith('x.ai/session/update:auto_compact_started')), names.join(','));
  assert.ok(!names.some((n) => n.includes('current_mode_update')), names.join(','));
  assert.ok(!names.some((n) => n.startsWith('x.ai/sessions/changed')), names.join(','));
});

test('HTTP merge result last assistant stays landing pad over TUI hello leftover', () => {
  const journal = [
    JSON.stringify({ event: 'user_message', data: { text: 'where do we land', sessionId: 'old-parent' } }),
    JSON.stringify({
      event: 'agent_message_chunk',
      data: { sessionId: 'old-parent', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'landing pad' } } },
    }),
  ];
  const session = [
    JSON.stringify({ event: 'user_message', data: { text: 'where do we land' } }),
    JSON.stringify({
      event: 'agent_message_chunk',
      data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } },
    }),
    JSON.stringify({ event: 'user_message', data: { text: 'where do we land' } }),
    JSON.stringify({
      event: 'agent_message_chunk',
      data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } },
    }),
    JSON.stringify({ event: 'user_message', data: { text: 'leftover' } }),
    JSON.stringify({
      event: 'agent_message_chunk',
      data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } },
    }),
  ];
  const merged = appendNewerSessionTurns(mergeEventLines(journal, session), session);
  const sliced = sliceHistoryByTurns(merged.join('\n') + '\n', {
    all: true,
    turns: 50,
    dropSessionIds: new Set(['child-subagent-id']),
  });
  const assistants = sliced.text.split('\n').filter(Boolean).map((l) => {
    try {
      const o = JSON.parse(l) as { event?: string; data?: { update?: { content?: { text?: string } }; text?: string } };
      if (o.event !== 'agent_message_chunk') return null;
      return o.data?.update?.content?.text || o.data?.text || null;
    } catch { return null; }
  }).filter(Boolean);
  assert.equal(assistants[assistants.length - 1], 'landing pad');
  assert.match(sliced.text, /old-parent/);
});

test('compactHistoryForHttp drops resume restream tools sharing an isReplay second', () => {
  const lines = [
    JSON.stringify({ at: '2026-11-10T02:00:00.000Z', event: 'user_message', data: { text: 'hi' } }),
    JSON.stringify({ at: '2026-11-10T02:00:01.000Z', event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'real' } } } }),
    JSON.stringify({ at: '2026-11-10T02:23:20.100Z', event: 'agent_thought_chunk', data: { _meta: { isReplay: true }, update: { content: { type: 'text', text: 'replay' } } } }),
    JSON.stringify({ at: '2026-11-10T02:23:20.200Z', event: 'tool_call', data: { update: { toolCallId: 't-replay', title: 'old', status: 'completed' } } }),
    JSON.stringify({ at: '2026-11-10T02:23:20.900Z', event: 'session_ready', data: {} }),
  ];
  const out = compactHistoryForHttp(lines).map((l) => JSON.parse(l) as { event: string; data?: { update?: { content?: { text?: string } } } });
  assert.deepEqual(out.map((e) => e.event), ['user_message', 'agent_message_chunk']);
  assert.equal(out[1]!.data!.update!.content!.text, 'real');
});

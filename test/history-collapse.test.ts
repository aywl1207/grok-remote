import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseHistoryForReplay, capTurnTools } from '../lib/history.js';

test('collapseHistoryForReplay keeps one thought and one reply per turn', () => {
  const evs = [
    { event: 'user_message', data: { text: 'hi' } },
    { event: 'agent_thought_chunk', data: { update: { content: { type: 'text', text: 'a' } } } },
    { event: 'tool_call', data: { update: { toolCallId: 't1', title: 'Exec' } } },
    { event: 'agent_thought_chunk', data: { update: { content: { type: 'text', text: 'b' } } } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'one' } } } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'two' } } } },
    { event: 'user_message', data: { text: 'next' } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'ok' } } } },
  ];
  const out = collapseHistoryForReplay(evs);
  const names = out.map((e) => e.event);
  assert.deepEqual(names, ['user_message', 'agent_thought_chunk', 'tool_call', 'agent_thought_chunk', 'agent_message_chunk', 'user_message', 'agent_message_chunk']);
  const thought = out[1]!.data as { update: { content: { text: string } } };
  assert.equal(thought.update.content.text, 'a');
  const thought2 = out[3]!.data as { update: { content: { text: string } } };
  assert.equal(thought2.update.content.text, 'b');
  const reply = out[4]!.data as { update: { content: { type: string; text: string } } };
  assert.equal(reply.update.content.text, 'onetwo');
});

test('capTurnTools keeps last 8 tools and all non-tools', () => {
  const rest = [];
  rest.push({ event: 'prompt_complete', data: {} });
  for (let i = 0; i < 20; i++) {
    rest.push({ event: 'tool_call', data: { update: { toolCallId: 't' + i } } });
  }
  rest.push({ event: 'session_info', data: {} });
  const out = capTurnTools(rest as any, 8);
  const tools = out.filter((e) => e.event === 'tool_call');
  assert.equal(tools.length, 8);
  assert.equal((tools[0]!.data as any).update.toolCallId, 't12');
  assert.equal((tools[7]!.data as any).update.toolCallId, 't19');
  assert.equal(out[0]!.event, 'prompt_complete');
  assert.equal(out[out.length - 1]!.event, 'session_info');
});

test('collapseHistoryForReplay caps tools per turn', () => {
  const evs: Array<Record<string, unknown>> = [{ event: 'user_message', data: { text: 'hi' } }];
  for (let i = 0; i < 15; i++) {
    evs.push({ event: 'tool_call', data: { update: { toolCallId: 't' + i } } });
  }
  evs.push({ event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'done' } } } });
  const out = collapseHistoryForReplay(evs);
  const tools = out.filter((e) => e.event === 'tool_call');
  assert.equal(tools.length, 8);
  assert.equal(out.filter((e) => e.event === 'user_message').length, 1);
  assert.equal(out.filter((e) => e.event === 'agent_message_chunk').length, 1);
});


test('older turns drop tool cards; last two turns keep a cap', () => {
  const evs: Array<Record<string, unknown>> = [];
  for (const u of ['one', 'two', 'three']) {
    evs.push({ event: 'user_message', data: { text: u } });
    evs.push({ event: 'tool_call', data: { update: { toolCallId: u + '-t' } } });
    evs.push({ event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'ok' } } } });
  }
  const out = collapseHistoryForReplay(evs);
  const tools = out.filter((e) => e.event === 'tool_call');
  assert.equal(tools.length, 2);
  assert.equal((tools[0]!.data as any).update.toolCallId, 'two-t');
  assert.equal((tools[1]!.data as any).update.toolCallId, 'three-t');
});

test('collapseHistoryForReplay dropTools strips tool cards on older pages', () => {
  const events = [
    { event: 'user_message', data: { text: 'u' } },
    { event: 'tool_call', data: { update: { toolCallId: 't1', title: 'Exec' } } },
    { event: 'agent_message_chunk', data: { update: { content: { text: 'ok' } } } },
  ];
  const out = collapseHistoryForReplay(events, { dropTools: true });
  assert.deepEqual(out.map((e) => e.event), ['user_message', 'agent_message_chunk']);
});

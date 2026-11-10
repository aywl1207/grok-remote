import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseHistoryForReplay, mergeCollapsedText } from '../lib/history-collapse.js';

test('mergeCollapsedText concatenates deltas and absorbs snapshots', () => {
  assert.equal(mergeCollapsedText('one', 'two'), 'onetwo');
  assert.equal(mergeCollapsedText('hello wo', 'hello world'), 'hello world');
  assert.equal(mergeCollapsedText('hello world', 'hello'), 'hello world');
  assert.equal(mergeCollapsedText('hello', 'hello'), 'hello');
});

test('collapseHistoryForReplay does not duplicate snapshot replies', () => {
  const evs = [
    { event: 'user_message', data: { text: 'hi' } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'Hel' } } } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'Hello' } } } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'Hello world' } } } },
  ];
  const out = collapseHistoryForReplay(evs);
  const reply = out.find((e) => e.event === 'agent_message_chunk')!;
  const text = (reply.data as { update: { content: { text: string } } }).update.content.text;
  assert.equal(text, 'Hello world');
});

test('collapseHistoryForReplay keeps separate replies split by tools', () => {
  const evs = [
    { event: 'user_message', data: { text: 'who' } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'I am Grok.' } } } },
    { event: 'tool_call', data: { update: { toolCallId: 't1', title: 'Exec' } } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: 'Ollama is up.' } } } },
  ];
  const out = collapseHistoryForReplay(evs);
  const replies = out.filter((e) => e.event === 'agent_message_chunk');
  assert.equal(replies.length, 2);
  const t0 = (replies[0]!.data as { update: { content: { text: string } } }).update.content.text;
  const t1 = (replies[1]!.data as { update: { content: { text: string } } }).update.content.text;
  assert.equal(t0, 'I am Grok.');
  assert.equal(t1, 'Ollama is up.');
  assert.deepEqual(out.map((e) => e.event), [
    'user_message', 'agent_message_chunk', 'tool_call', 'agent_message_chunk',
  ]);
});

test('mergeCollapsedText keeps a restreamed last answer instead of mashing the draft', () => {
  const draft = '先睇而家手續費點計，再按富途牛牛港股／美股分開。';
  const final = '對。牛牛港股、美股整手、美股碎股收費唔同，而家系統跟富途證券公布價分市場計。';
  assert.equal(mergeCollapsedText(draft, final), final);
  assert.equal(mergeCollapsedText('hello wo', 'hello world'), 'hello world');
  assert.equal(mergeCollapsedText('ab', 'c'), 'abc');
});

test('collapse keeps a later token that matches the reply prefix', () => {
  const evs = [
    { event: 'user_message', data: { text: 'hi' } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: '三' } } } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: '個' } } } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: '問題' } } } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: '三' } } } },
    { event: 'agent_message_chunk', data: { update: { content: { type: 'text', text: '症' } } } },
  ];
  const out = collapseHistoryForReplay(evs);
  const reply = out.find((e) => e.event === 'agent_message_chunk')!;
  const got = (reply.data as { update: { content: { text: string } } }).update.content.text;
  assert.equal(got, '三個問題三症');
});

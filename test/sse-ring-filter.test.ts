import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldDropSseEvent } from '../src/lib/sse-ring.js';

const opened = 1_700_000_000_000;

test('drops events already painted from history', () => {
  assert.equal(shouldDropSseEvent({
    name: 'agent_message_chunk',
    lastEventId: `${opened}-1`,
    lastHistoryEventId: `${opened}-2`,
    streamOpenedAt: opened + 1000,
  }), true);
});

test('drops stale ring disconnect and prompt_complete', () => {
  const stale = `${opened - 1000}-1`;
  assert.equal(shouldDropSseEvent({
    name: 'agent_status',
    lastEventId: stale,
    lastHistoryEventId: null,
    streamOpenedAt: opened,
    data: { status: 'disconnected' },
  }), true);
  assert.equal(shouldDropSseEvent({
    name: 'prompt_complete',
    lastEventId: stale,
    lastHistoryEventId: null,
    streamOpenedAt: opened,
  }), true);
});

test('keeps a live message after connect', () => {
  assert.equal(shouldDropSseEvent({
    name: 'agent_message_chunk',
    lastEventId: `${opened + 50}-1`,
    lastHistoryEventId: `${opened - 5000}-9`,
    streamOpenedAt: opened,
  }), false);
});

test('stale tool_call_update is dropped even when completed', () => {
  const stale = `${opened - 1000}-1`;
  assert.equal(shouldDropSseEvent({
    name: 'tool_call_update',
    lastEventId: stale,
    streamOpenedAt: opened,
    data: { status: 'running' },
  }), true);
  assert.equal(shouldDropSseEvent({
    name: 'tool_call_update',
    lastEventId: stale,
    streamOpenedAt: opened,
    data: { status: 'completed' },
  }), true);
});

test('tool events without a live timestamp are dropped (mobile EventSource)', () => {
  assert.equal(shouldDropSseEvent({
    name: 'tool_call',
    lastEventId: '',
    streamOpenedAt: opened,
    data: { status: 'completed' },
  }), true);
  assert.equal(shouldDropSseEvent({
    name: 'tool_call_update',
    lastEventId: '',
    streamOpenedAt: opened,
    data: { _t: opened - 5000, status: 'completed' },
  }), true);
  assert.equal(shouldDropSseEvent({
    name: 'tool_call',
    lastEventId: '',
    streamOpenedAt: opened,
    data: { _t: opened + 10, title: 'Exec' },
  }), false);
});


test('drops already-painted reply even if an older turn has no assistant', () => {
  const opened = 1_700_000_000_000;
  assert.equal(shouldDropSseEvent({
    name: 'agent_message_chunk',
    lastEventId: `${opened - 5000}-1`,
    lastHistoryEventId: `${opened + 50}-9`,
    streamOpenedAt: opened,
    turns: [
      { userText: 'Issue fixed?', assistant: null },
      { userText: 'later', assistant: { n: 1 } },
    ],
  }), true);
});

test('does not fill the last turn hole with an already-painted reply', () => {
  const opened = 1_700_000_000_000;
  assert.equal(shouldDropSseEvent({
    name: 'agent_message_chunk',
    lastEventId: `${opened - 5000}-1`,
    lastHistoryEventId: `${opened + 50}-9`,
    streamOpenedAt: opened,
    turns: [
      { userText: 'earlier', assistant: { n: 1 } },
      { userText: 'latest', assistant: null },
    ],
  }), true);
});

test('drops an older reply when every user turn already has assistant text', () => {
  const opened = 1_700_000_000_000;
  assert.equal(shouldDropSseEvent({
    name: 'agent_message_chunk',
    lastEventId: `${opened - 5000}-1`,
    lastHistoryEventId: `${opened + 50}-9`,
    streamOpenedAt: opened,
    turns: [
      { userText: 'Issue fixed?', assistant: { n: 1 } },
      { userText: 'later', assistant: { n: 1 } },
    ],
  }), true);
});


test('ring tool at connect time is dropped', () => {
  const opened = 1_700_000_000_000;
  assert.equal(shouldDropSseEvent({
    name: 'tool_call',
    lastEventId: `${opened - 10}-1`,
    streamOpenedAt: opened,
    data: { _t: opened - 10, title: 'Exec' },
  }), true);
});


test('drops a stale thought after the last turn already has a reply', () => {
  const opened = 1_700_000_000_000;
  assert.equal(shouldDropSseEvent({
    name: 'agent_thought_chunk',
    lastEventId: `${opened - 1000}-4`,
    lastHistoryEventId: `${opened - 500}-1`,
    streamOpenedAt: opened,
    turns: [{ userText: 'reload', assistant: { n: 1 } }],
  }), true);
});

test('drops a stale reply restream when the last turn already has a footer', () => {
  const opened = 1_700_000_000_000;
  assert.equal(shouldDropSseEvent({
    name: 'agent_message_chunk',
    lastEventId: `${opened - 1000}-9`,
    lastHistoryEventId: `${opened - 500}-1`,
    streamOpenedAt: opened,
    turns: [{ userText: 'reload', assistant: { n: 1 }, footer: {} }],
  }), true);
});

test('drops a stale reply restream when history already painted the last reply', () => {
  const opened = 1_700_000_000_000;
  assert.equal(shouldDropSseEvent({
    name: 'agent_message_chunk',
    lastEventId: `${opened - 1000}-9`,
    lastHistoryEventId: `${opened - 5000}-1`,
    streamOpenedAt: opened,
    turns: [{ userText: 'reload', assistant: { n: 1 } }],
  }), true);
});

test('keeps a live reply chunk after connect', () => {
  const opened = 1_700_000_000_000;
  assert.equal(shouldDropSseEvent({
    name: 'agent_message_chunk',
    lastEventId: `${opened + 20}-9`,
    lastHistoryEventId: `${opened - 5000}-1`,
    streamOpenedAt: opened,
    turns: [{ userText: 'reload', assistant: { n: 1 } }],
  }), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  payloadSessionId,
  isChildSessionPayload,
  sessionIdFromEventId,
  listSubagentSessionIds,
  dropSubagentHistoryLines,
} from '../lib/child-session.js';

const parent = '01a037fe-4521-7663-97f6-f806ccf1a5a5';
const child = '01a004ea-a011-7922-bbf9-234f8b33cb57';

test('payloadSessionId reads top-level, params, update, and _meta', () => {
  assert.equal(payloadSessionId({ sessionId: child }), child);
  assert.equal(payloadSessionId({ params: { sessionId: child } }), child);
  assert.equal(payloadSessionId({ update: { sessionId: child } }), child);
  assert.equal(payloadSessionId({ _meta: { sessionId: child } }), child);
});

test('payloadSessionId reads child ULID from eventId', () => {
  assert.equal(sessionIdFromEventId(`${child}-12441`), child);
  assert.equal(payloadSessionId({ _meta: { eventId: `${child}-12441` } }), child);
  assert.equal(sessionIdFromEventId('1786801518995-762'), '');
});

test('rebinding to a new session does not hide older parent replies in history', () => {
  const olderParent = child;
  assert.equal(isChildSessionPayload({
    payload: { sessionId: olderParent, update: { sessionUpdate: 'agent_message_chunk' } },
    parentSessionId: parent,
    lastSessionId: parent,
    fromHistory: true,
  }), false);
});

test('live subagent chunks are hidden even after the spawn card completes', () => {
  assert.equal(isChildSessionPayload({
    payload: { sessionId: child, update: { sessionUpdate: 'agent_message_chunk' } },
    parentSessionId: parent,
    lastSessionId: parent,
    subagentRunning: true,
  }), true);
  assert.equal(isChildSessionPayload({
    payload: { sessionId: child, update: { sessionUpdate: 'agent_message_chunk' } },
    parentSessionId: parent,
    lastSessionId: parent,
    subagentRunning: false,
  }), true);
});

test('live child user_message (spawn prompt) is a child payload', () => {
  assert.equal(isChildSessionPayload({
    payload: { sessionId: child, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Audit chat UI' } } },
    parentSessionId: parent,
    lastSessionId: parent,
  }), true);
});

test('child session is detected even when parent id is only lastSessionId', () => {
  assert.equal(isChildSessionPayload({
    payload: { sessionId: child, update: { sessionUpdate: 'agent_message_chunk' } },
    parentSessionId: '',
    lastSessionId: parent,
    subagentRunning: true,
  }), true);
  assert.equal(isChildSessionPayload({
    payload: { sessionId: parent, update: { sessionUpdate: 'agent_message_chunk' } },
    parentSessionId: '',
    lastSessionId: parent,
  }), false);
});

test('known child ids catch a child when parent id is missing', () => {
  assert.equal(isChildSessionPayload({
    payload: { sessionId: child },
    parentSessionId: '',
    lastSessionId: '',
    knownChildIds: [child],
  }), true);
  assert.equal(isChildSessionPayload({
    payload: { sessionId: child },
    parentSessionId: '',
    lastSessionId: '',
    knownChildIds: [],
  }), false);
});

test('parent chunks are never treated as child', () => {
  assert.equal(isChildSessionPayload({
    payload: { sessionId: parent },
    parentSessionId: parent,
  }), false);
});

test('compact completed with a child sessionId still looks like a child payload', () => {
  // handleEvent must exempt compact_* / auto_compact_* / compaction_checkpoint
  // before _isChildSessionPayload, or the parent stays Compacting….
  assert.equal(isChildSessionPayload({
    payload: { sessionId: child, update: { sessionUpdate: 'auto_compact_completed' } },
    parentSessionId: parent,
    lastSessionId: parent,
    subagentRunning: true,
  }), true);
});

test('fromHistory does not treat an unknown older parent sid as a child', () => {
  const olderParent = '01a09999-9999-4999-8999-999999999999';
  assert.equal(isChildSessionPayload({
    payload: { data: { sessionId: olderParent } },
    parentSessionId: parent,
    lastSessionId: parent,
    fromHistory: true,
  }), false);
  assert.equal(isChildSessionPayload({
    payload: { data: { sessionId: child } },
    parentSessionId: parent,
    lastSessionId: parent,
    knownChildIds: [child],
    fromHistory: true,
  }), true);
});

test('payloadSessionId reads journal data.sessionId envelopes', () => {
  assert.equal(payloadSessionId({ event: 'agent_message_chunk', data: { sessionId: child } }), child);
});

test('listSubagentSessionIds returns TUI session_kind=subagent only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'child-sess-'));
  try {
    const parentDir = path.join(home, 'sessions', encodeURIComponent('/tmp/p'), parent);
    const childDir = path.join(home, 'sessions', encodeURIComponent('/tmp/p'), child);
    fs.mkdirSync(parentDir, { recursive: true });
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(parentDir, 'summary.json'), JSON.stringify({
      info: { id: parent, cwd: '/tmp/p' },
      session_kind: 'user',
    }));
    fs.writeFileSync(path.join(childDir, 'summary.json'), JSON.stringify({
      info: { id: child, cwd: '/tmp/p' },
      session_kind: 'subagent',
    }));
    const ids = listSubagentSessionIds(home);
    assert.deepEqual(ids, [child]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dropSubagentHistoryLines keeps older parent journal replies', () => {
  const older = '01a01111-1111-4111-8111-111111111111';
  const raw = [
    JSON.stringify({ event: 'user_message', data: { text: 'q', sessionId: older } }),
    JSON.stringify({ event: 'agent_message_chunk', data: { sessionId: older, update: { content: { text: 'landing pad' } } } }),
    JSON.stringify({ event: 'agent_message_chunk', data: { sessionId: child, update: { content: { text: 'hello' } } } }),
  ].join('\n') + '\n';
  const out = dropSubagentHistoryLines(raw, [child]);
  assert.match(out, /landing pad/);
  assert.doesNotMatch(out, /"hello"/);
});

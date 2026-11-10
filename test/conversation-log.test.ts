import test from 'node:test';
import assert from 'node:assert/strict';

import { alreadyHasOptimisticUser, pickTurnForReplyChunk } from '../src/lib/conversation-log.js';

test('live chunks stay on the active turn', () => {
  const a = { userText: 'old', assistant: null };
  const b = { userText: 'new', assistant: null };
  assert.equal(pickTurnForReplyChunk([a, b], b, false), b);
});

test('stale ring reply attaches to the last empty user turn', () => {
  const a = { userText: 'Issue fixed?', assistant: null };
  const b = { userText: 'later', assistant: { n: 1 } };
  assert.equal(pickTurnForReplyChunk([a, b], b, true), a);
});

test('alreadyHasOptimisticUser skips a second You for the same un-replied send', () => {
  assert.equal(alreadyHasOptimisticUser({ userText: 'queued' }, 'queued'), true);
  assert.equal(alreadyHasOptimisticUser({ userText: 'queued', assistant: {} }, 'queued'), false);
  assert.equal(alreadyHasOptimisticUser({ userText: 'queued', tools: [{}] }, 'queued'), false);
  assert.equal(alreadyHasOptimisticUser({ userText: 'other' }, 'queued'), false);
  assert.equal(alreadyHasOptimisticUser(null, 'queued'), false);
});

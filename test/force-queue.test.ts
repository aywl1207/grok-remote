import test from 'node:test';
import assert from 'node:assert/strict';
import { FORCE_ENTER_MS, conversationIsWorking, hasPromptDraft, pickForceSendPayload, consumeForcePayload, shouldForceQueueSend, shouldFlushQueueOnIdle, chatIsReadyToSend } from '../src/lib/force-queue.js';

test('hasPromptDraft treats whitespace as empty', () => {
  assert.equal(hasPromptDraft('  '), false);
  assert.equal(hasPromptDraft('go'), true);
  assert.equal(hasPromptDraft('', [{ name: 'a.png' }]), true);
});

test('idle send is never a force', () => {
  assert.equal(shouldForceQueueSend({
    working: false, hasQueue: true, hasDraft: false,
  }), false);
});

test('Queue again with empty draft forces', () => {
  assert.equal(shouldForceQueueSend({
    working: true, hasQueue: true, hasDraft: false,
  }), true);
});

test('first Queue with draft does not force', () => {
  assert.equal(shouldForceQueueSend({
    working: true, hasQueue: false, hasDraft: true,
  }), false);
});

test('double Enter within the window forces', () => {
  const now = 10_000;
  assert.equal(shouldForceQueueSend({
    working: true,
    hasQueue: false,
    hasDraft: true,
    viaEnter: true,
    lastEnterAt: now - 200,
    now,
  }), true);
  assert.equal(shouldForceQueueSend({
    working: true,
    hasQueue: false,
    hasDraft: true,
    viaEnter: true,
    lastEnterAt: now - (FORCE_ENTER_MS + 50),
    now,
  }), false);
});

test('explicit force flag always wins while working', () => {
  assert.equal(shouldForceQueueSend({
    working: true, force: true, hasQueue: false, hasDraft: false,
  }), true);
});

test('conversationIsWorking ignores leftover running status', () => {
  assert.equal(conversationIsWorking({}), false);
  assert.equal(conversationIsWorking({ turnOpen: true }), true);
  assert.equal(conversationIsWorking({ hasOpenTurn: true }), false);
  assert.equal(conversationIsWorking({ inFlight: 2 }), true);
  assert.equal(conversationIsWorking({ forceSending: true }), true);
  assert.equal(conversationIsWorking({ inFlight: 0, turnOpen: false }), false);
});

test('pickForceSendPayload prefers the queued message over a new draft', () => {
  const p = pickForceSendPayload({
    queue: { text: 'queued' },
    draftText: 'new draft',
  });
  assert.equal(p && p.text, 'queued');
});

test('pickForceSendPayload uses draft when nothing is queued', () => {
  const p = pickForceSendPayload({
    queue: null,
    draftText: 'draft',
  });
  assert.equal(p && p.text, 'draft');
});

test('chatIsReadyToSend is false while starting; disconnected can send to reconnect', () => {
  assert.equal(chatIsReadyToSend({ agentId: 'a', status: 'idle' }), true);
  assert.equal(chatIsReadyToSend({ agentId: 'a', status: 'starting' }), false);
  assert.equal(chatIsReadyToSend({ agentId: 'a', status: 'disconnected' }), true);
  assert.equal(chatIsReadyToSend({ agentId: 'a', status: 'idle', working: true }), false);
  assert.equal(chatIsReadyToSend({ agentId: 'a', status: 'idle', blocked: true }), false);
  assert.equal(chatIsReadyToSend({ agentId: 'a', status: 'idle', connected: false }), true);
  assert.equal(chatIsReadyToSend({ status: 'idle' }), false);
});

test('disconnected leftover turnOpen is not working', () => {
  assert.equal(conversationIsWorking({ turnOpen: true, status: 'disconnected' }), false);
  assert.equal(conversationIsWorking({ turnOpen: true, status: 'idle' }), true);
});

test('consumeForcePayload clears the queue before Send Now cancel', () => {
  const queued = consumeForcePayload({
    queue: { text: 'queued' },
    draftText: 'draft',
  });
  assert.equal(queued.payload && queued.payload.text, 'queued');
  assert.equal(queued.clearQueue, true);
  assert.equal(queued.clearDraft, false);

  const draft = consumeForcePayload({
    queue: null,
    draftText: 'draft',
  });
  assert.equal(draft.payload && draft.payload.text, 'draft');
  assert.equal(draft.clearQueue, false);
  assert.equal(draft.clearDraft, true);

  const empty = consumeForcePayload({ queue: null, draftText: '' });
  assert.equal(empty.payload, null);
  assert.equal(empty.clearQueue, false);
});

test('idle paint must not flush while Send Now owns the queue', () => {
  assert.equal(shouldFlushQueueOnIdle({ forceSending: true }), false);
  assert.equal(shouldFlushQueueOnIdle({ flushing: true }), false);
  assert.equal(shouldFlushQueueOnIdle({}), true);
  assert.equal(shouldFlushQueueOnIdle({ forceSending: false, flushing: false }), true);
});

test('idle paint must not flush while Steer is in flight', () => {
  assert.equal(shouldFlushQueueOnIdle({ steering: true }), false);
  assert.equal(shouldFlushQueueOnIdle({ forceSending: false, flushing: false, steering: false }), true);
});

test('Steer in flight is not ready to send', () => {
  assert.equal(chatIsReadyToSend({
    agentId: 'a1', connected: true, status: 'idle', working: false, steering: true,
  }), false);
  assert.equal(chatIsReadyToSend({
    agentId: 'a1', connected: true, status: 'idle', working: false, steering: false,
  }), true);
});

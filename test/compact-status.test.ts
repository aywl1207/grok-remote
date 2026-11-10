import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactUpdateFromPayload,
  compactPayloadIsReplay,
  compactingPreview,
  isCompactJournalEvent,
  shouldPaintCompactStarted,
  shouldIgnoreLateCompactStarted,
  compactRpcTries,
  compactUsageTries,
  occupancyFromUnknown,
  compactPhaseOf,
  plausibleCompactAfter,
  MAX_CONTEXT_OCCUPANCY,
  compactInFlightAck,
  compactDroppedEnough,
  tokensAfterFromCompactUpdate,
  compactRpcShouldTryNext,
  compactPromptText,
  isAcpMethodMissing,
} from '../lib/compact-status.js';

const startedEnv = {
  method: '_x.ai/session/update',
  params: {
    sessionId: 's',
    update: {
      sessionUpdate: 'auto_compact_started',
      tokens_used: 404614,
      context_window: 500000,
      percentage: 81,
      reason: 'Context window 81% full',
    },
    _meta: { isReplay: false },
  },
};

test('parses auto_compact_started from x.ai session/update envelope', () => {
  const u = compactUpdateFromPayload('x.ai/session/update', startedEnv);
  assert.equal(u && u.phase, 'started');
  assert.equal(u && u.tokensUsed, 404614);
  assert.equal(u && u.percentage, 81);
  assert.match(compactingPreview(u!), /81%/);
  assert.equal(compactPayloadIsReplay(startedEnv), false);
});

test('parses auto_compact_completed token drop', () => {
  const u = compactUpdateFromPayload('auto_compact_completed', {
    update: {
      sessionUpdate: 'auto_compact_completed',
      tokens_before: 404614,
      tokens_after: 8277,
      elapsed_ms: 110889,
    },
  });
  assert.equal(u && u.phase, 'completed');
  assert.equal(u && u.tokensAfter, 8277);
  assert.match(compactingPreview(u!), /404,614/);
  assert.match(compactingPreview(u!), /8,277/);
});

test('ignores unrelated session updates', () => {
  assert.equal(compactUpdateFromPayload('x.ai/session/update', {
    params: { update: { sessionUpdate: 'turn_completed' } },
  }), null);
});

test('replay flag is read from nested _meta', () => {
  assert.equal(compactPayloadIsReplay({
    params: { update: { sessionUpdate: 'auto_compact_started' }, _meta: { isReplay: true } },
  }), true);
});

test('isCompactJournalEvent keeps x.ai compact updates and drops other session noise', () => {
  assert.equal(isCompactJournalEvent('x.ai/session/update', startedEnv), true);
  assert.equal(isCompactJournalEvent('auto_compact_started', { update: { sessionUpdate: 'auto_compact_started' } }), true);
  assert.equal(isCompactJournalEvent('x.ai/session/update', {
    params: { update: { sessionUpdate: 'turn_completed' } },
  }), false);
  assert.equal(isCompactJournalEvent('tool_call', { update: { sessionUpdate: 'tool_call' } }), false);
});

test('shouldPaintCompactStarted hides attach replay but shows live compact', () => {
  assert.equal(shouldPaintCompactStarted({ fromHistory: true }), false);
  assert.equal(shouldPaintCompactStarted({ replaying: true }), false);
  assert.equal(shouldPaintCompactStarted({ isReplay: true, turnOpen: false }), false);
  assert.equal(shouldPaintCompactStarted({ isReplay: true, turnOpen: true }), true);
  assert.equal(shouldPaintCompactStarted({ isReplay: false, turnOpen: false }), true);
});

test('compactRpcTries targets x.ai/compact_conversation with optional context', () => {
  const bare = compactRpcTries('sess-1');
  assert.equal(bare[0]!.method, 'x.ai/compact_conversation');
  assert.deepEqual(bare[0]!.params, { sessionId: 'sess-1' });
  const noted = compactRpcTries('sess-1', 'keep the auth work');
  assert.equal(noted[0]!.params['context'], 'keep the auth work');
});

test('compactPhaseOf maps failed and cancelled', () => {
  assert.equal(compactPhaseOf('auto_compact_failed'), 'failed');
  assert.equal(compactPhaseOf('auto_compact_cancelled'), 'failed');
  assert.equal(compactPhaseOf('auto_compact_completed'), 'completed');
});

test('occupancyFromUnknown prefers tokens_after on compact results', () => {
  assert.equal(occupancyFromUnknown({ tokens_before: 200000, tokens_after: 74000 }), 74000);
  assert.equal(occupancyFromUnknown({ usage: { totalTokens: 12345 } }), 12345);
  assert.equal(occupancyFromUnknown({ total_tokens: 9 }), 9);
});

test('compactUsageTries targets x.ai/session/usage', () => {
  const tries = compactUsageTries('sess-1');
  assert.equal(tries[0]!.method, 'x.ai/session/usage');
  assert.deepEqual(tries[0]!.params, { sessionId: 'sess-1' });
});

test('compactRpcTries includes user_context alias', () => {
  const noted = compactRpcTries('sess-1', 'keep the auth work');
  assert.equal(noted[0]!.params['context'], 'keep the auth work');
  assert.equal(noted[0]!.params['user_context'], 'keep the auth work');
});

test('occupancyFromUnknown ignores lifetime-sized totals', () => {
  assert.equal(occupancyFromUnknown({ total_tokens: 31_138_726 }), undefined);
  assert.equal(occupancyFromUnknown({ tokens_after: 74000 }), 74000);
  assert.equal(plausibleCompactAfter({ tokensBefore: 292711, tokensAfter: 31138726 }), undefined);
  assert.equal(plausibleCompactAfter({ tokensBefore: 292711, tokensAfter: 74000 }), 74000);
  assert.ok(MAX_CONTEXT_OCCUPANCY >= 2_000_000);
});

test('compactInFlightAck is a no-throw in-flight ack without a second started event', () => {
  assert.deepEqual(compactInFlightAck(), { ok: true, rpc: 'in-flight' });
});


test('compactPromptText is /compact with optional hint', () => {
  assert.equal(compactPromptText(), '/compact');
  assert.equal(compactPromptText('  keep the auth  '), '/compact keep the auth');
});

test('isAcpMethodMissing matches grok agent stdio errors', () => {
  assert.equal(isAcpMethodMissing(new Error('Method not found')), true);
  assert.equal(isAcpMethodMissing('not supported by this agent version'), true);
  assert.equal(isAcpMethodMissing(new Error('session is busy')), false);
});

test('compactRpcTries includes session/compact aliases', () => {
  const methods = compactRpcTries('sess-1').map((t) => t.method);
  assert.ok(methods.includes('x.ai/compact_conversation'));
  assert.ok(methods.includes('x.ai/session/compact'));
  assert.ok(methods.includes('session/compact'));
});

test('shouldIgnoreLateCompactStarted only skips a recent live finish echo', () => {
  const finishedAt = 10_000;
  assert.equal(shouldIgnoreLateCompactStarted({
    compacting: false, compactFinished: true, finishedAt, now: 11_000,
  }), true);
  assert.equal(shouldIgnoreLateCompactStarted({
    compacting: false, compactFinished: true, finishedAt, now: 20_000,
  }), false);
  assert.equal(shouldIgnoreLateCompactStarted({
    compacting: false, compactFinished: true, finishedAt: 0, now: 11_000,
  }), false);
  assert.equal(shouldIgnoreLateCompactStarted({
    compacting: true, compactFinished: true, finishedAt, now: 11_000,
  }), false);
});

test('compactDroppedEnough requires a real occupancy drop', () => {
  assert.equal(compactDroppedEnough({ tokensBefore: 180_000, tokensAfter: 74_000 }), true);
  assert.equal(compactDroppedEnough({ tokensBefore: 180_000, tokensAfter: 180_000 }), false);
  assert.equal(compactDroppedEnough({ tokensBefore: 180_000, tokensAfter: 179_500 }), false);
  assert.equal(compactDroppedEnough({ tokensBefore: 180_000, tokensAfter: 170_000 }), true);
  assert.equal(compactDroppedEnough({ tokensBefore: 180_000, tokensAfter: undefined }), false);
});

test('isAcpMethodMissing does not treat generic not-found as a missing RPC', () => {
  assert.equal(isAcpMethodMissing(new Error('file not found')), false);
  assert.equal(isAcpMethodMissing(new Error('Method not found: x.ai/compact_conversation')), true);
  assert.equal(compactRpcShouldTryNext(new Error('Method not found')), true);
});

test('compactRpcTries includes session.compact alias', () => {
  const methods = compactRpcTries('sess-1').map((t) => t.method);
  assert.ok(methods.includes('session.compact'));
});


test('tokensAfterFromCompactUpdate ignores a completed event that did not drop', () => {
  assert.equal(tokensAfterFromCompactUpdate({
    sessionUpdate: 'auto_compact_completed',
    tokens_before: 190280,
    tokens_after: 190280,
  }), undefined);
  assert.equal(tokensAfterFromCompactUpdate({
    sessionUpdate: 'auto_compact_completed',
    tokens_before: 190280,
    tokens_after: 6564,
  }), 6564);
  assert.equal(tokensAfterFromCompactUpdate({
    sessionUpdate: 'auto_compact_started',
    tokens_after: 1000,
  }), undefined);
});

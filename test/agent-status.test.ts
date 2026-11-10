import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePublicStatus, shouldApplyAgentStatus, clientIsLive, isDisplayedWorking, sidebarDisplayStatus, followServerTurnOpen, applyWorkingOverlayRow, applyToolInFlight, LOCAL_TURN_HOLD_MS, LOCAL_TURN_GRACE_MS } from '../lib/agent-status.js';

test('shouldApplyAgentStatus ignores replayed disconnect while connected', () => {
  assert.equal(shouldApplyAgentStatus({ connected: true, status: 'idle' }, 'disconnected'), false);
  assert.equal(shouldApplyAgentStatus({ connected: true, status: 'running' }, 'exited'), false);
  assert.equal(shouldApplyAgentStatus({ connected: false, status: 'disconnected' }, 'disconnected'), true);
  assert.equal(shouldApplyAgentStatus({ connected: true, status: 'idle' }, 'running'), true);
});

test('derivePublicStatus prefers live client idle', () => {
  assert.equal(derivePublicStatus({ hasClient: true, clientStatus: 'idle', recordStatus: 'disconnected' }), 'idle');
});

test('shouldApplyAgentStatus ignores agent-exited error while connected', () => {
  assert.equal(
    shouldApplyAgentStatus({ connected: true, status: 'idle' }, 'errored', 'agent exited'),
    false,
  );
  assert.equal(
    shouldApplyAgentStatus({ connected: false, status: 'errored' }, 'errored', 'boom'),
    true,
  );
});

test('clientIsLive is false after a dropped hold socket', () => {
  assert.equal(clientIsLive({
    sessionId: 'sess',
    status: 'disconnected',
    sock: null,
  }), false);
  assert.equal(clientIsLive({
    sessionId: 'sess',
    status: 'idle',
    sock: { destroyed: true },
  }), false);
  assert.equal(clientIsLive({
    sessionId: 'sess',
    status: 'idle',
    sock: { destroyed: false },
  }), true);
  assert.equal(clientIsLive({ status: 'starting' }), true);
});

test('derivePublicStatus is running while the last turn is still open', () => {
  assert.equal(derivePublicStatus({
    hasClient: true,
    clientStatus: 'idle',
    recordStatus: 'idle',
    turnOpen: true,
  }), 'running');
  assert.equal(derivePublicStatus({
    hasClient: true,
    clientStatus: 'idle',
    recordStatus: 'idle',
    turnOpen: false,
  }), 'idle');
});

test('derivePublicStatus ignores leftover ACP running when the last turn is closed', () => {
  assert.equal(derivePublicStatus({
    hasClient: true,
    clientStatus: 'running',
    recordStatus: 'idle',
    turnOpen: false,
    inFlight: 0,
  }), 'idle');
  assert.equal(derivePublicStatus({
    hasClient: true,
    clientStatus: 'running',
    recordStatus: 'idle',
    turnOpen: true,
    inFlight: 0,
  }), 'running');
});

test('isDisplayedWorking ignores leftover ACP running', () => {
  assert.equal(isDisplayedWorking({ status: 'running', turnOpen: false, inFlight: 0 }), false);
  assert.equal(isDisplayedWorking({ status: 'idle', turnOpen: true }), true);
  assert.equal(isDisplayedWorking({ status: 'idle', inFlight: 2 }), true);
});

test('sidebarDisplayStatus matches chat idle unless a turn is open', () => {
  assert.equal(sidebarDisplayStatus({ status: 'running', turnOpen: false, inFlight: 0 }), 'idle');
  assert.equal(sidebarDisplayStatus({ status: 'running', turnOpen: true, inFlight: 0 }), 'running');
  assert.equal(sidebarDisplayStatus({ status: 'idle', turnOpen: false, inFlight: 2 }), 'running');
  assert.equal(sidebarDisplayStatus({ status: 'starting', turnOpen: false }), 'starting');
  assert.equal(sidebarDisplayStatus({ status: 'disconnected', turnOpen: true }), 'disconnected');
});

test('followServerTurnOpen keeps local send until the hold expires', () => {
  const now = 10_000;
  assert.equal(followServerTurnOpen({
    local: true, server: true, holdUntil: now + LOCAL_TURN_HOLD_MS, now,
  }), true);
  assert.equal(followServerTurnOpen({
    local: true, server: false, holdUntil: now - 1, now,
  }), false);
  assert.equal(followServerTurnOpen({
    local: false, server: true, holdUntil: 0, now,
  }), true);
});

test('followServerTurnOpen lets server idle win after a short send grace', () => {
  const sentAt = 10_000;
  const holdUntil = sentAt + LOCAL_TURN_HOLD_MS;
  assert.equal(followServerTurnOpen({
    local: true, server: false, holdUntil, now: sentAt + 200,
  }), true);
  assert.equal(followServerTurnOpen({
    local: true, server: false, holdUntil, now: sentAt + LOCAL_TURN_GRACE_MS + 50,
  }), false);
});

test('applyWorkingOverlayRow is a short hint, not a sticky Running', () => {
  const now = 10_000;
  const idle = { status: 'idle', turnOpen: false, inFlight: 0 };
  const hinted = applyWorkingOverlayRow(idle, now + 1_000, now);
  assert.equal(hinted.turnOpen, true);
  assert.equal(hinted.status, 'running');
  const expired = applyWorkingOverlayRow(idle, now - 1, now);
  assert.equal(expired.turnOpen, false);
  assert.equal(expired.status, 'idle');
  const disconnected = applyWorkingOverlayRow(
    { status: 'disconnected', turnOpen: false, inFlight: 0 },
    now + 1_000,
    now,
  );
  assert.equal(disconnected.status, 'disconnected');
});

test('applyToolInFlight tracks start and drops terminal updates', () => {
  const ids = new Set();
  assert.equal(applyToolInFlight(ids, { sessionUpdate: 'tool_call', callId: 'a', status: '' }), true);
  assert.deepEqual([...ids], ['a']);
  assert.equal(applyToolInFlight(ids, { sessionUpdate: 'tool_call_update', callId: 'a', status: '' }), false);
  assert.deepEqual([...ids], ['a']);
  assert.equal(applyToolInFlight(ids, { sessionUpdate: 'tool_call_update', callId: 'a', status: 'completed' }), true);
  assert.equal(ids.size, 0);
});

test('applyToolInFlight adds pending updates after reconnect', () => {
  const ids = new Set();
  assert.equal(applyToolInFlight(ids, { sessionUpdate: 'tool_call_update', callId: 'b', status: 'pending' }), true);
  assert.deepEqual([...ids], ['b']);
});

test('applyToolInFlight does not revive a completed tool from an empty patch', () => {
  const ids = new Set();
  applyToolInFlight(ids, { sessionUpdate: 'tool_call', callId: 'c' });
  applyToolInFlight(ids, { sessionUpdate: 'tool_call_update', callId: 'c', status: 'completed' });
  assert.equal(applyToolInFlight(ids, { sessionUpdate: 'tool_call_update', callId: 'c', status: '' }), false);
  assert.equal(ids.size, 0);
});

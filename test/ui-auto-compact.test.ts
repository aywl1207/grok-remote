import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideUiAutoCompact,
  nextArmedAfterCompact,
  rearmAtTokens,
  uiAutoCompactEnabled,
  armedAfterCompactOutcome,
  armedAfterInFlightAck,
} from '../lib/ui-auto-compact.js';

test('ui auto-compact uses the config window, not a catalog default', () => {
  const d = decideUiAutoCompact({
    used: 180_000,
    window: 200_000,
    compactAtPercent: 90,
    armed: true,
  });
  assert.equal(d.compactAtTokens, 180_000);
  assert.equal(d.action, 'compact');
  assert.equal(d.reason, 'over-line');
});

test('under the config line stays armed and does not compact', () => {
  const d = decideUiAutoCompact({
    used: 74_000,
    window: 200_000,
    compactAtPercent: 90,
    armed: true,
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.nextArmed, true);
  assert.equal(d.reason, 'under-line');
});

test('catalog-sized occupancy still compact at a smaller config line', () => {
  // Engine would wait for ~80% of 500k. UI line is 90% of 200k.
  const d = decideUiAutoCompact({
    used: 202_000,
    window: 200_000,
    compactAtPercent: 90,
  });
  assert.equal(d.action, 'compact');
  assert.ok(d.compactAtTokens < 400_000);
});

test('does not compact mid-turn unless allowDuringTurn', () => {
  const hold = decideUiAutoCompact({
    used: 190_000,
    window: 200_000,
    compactAtPercent: 90,
    turnOpen: true,
  });
  assert.equal(hold.action, 'skip');
  assert.equal(hold.reason, 'turn-open');
  const go = decideUiAutoCompact({
    used: 190_000,
    window: 200_000,
    compactAtPercent: 90,
    turnOpen: true,
    allowDuringTurn: true,
  });
  assert.equal(go.action, 'compact');
});

test('in-flight and disarmed skip; hysteresis re-arms under 90% of the line', () => {
  assert.equal(rearmAtTokens(180_000), 162_000);
  const busy = decideUiAutoCompact({
    used: 190_000, window: 200_000, compactAtPercent: 90, inFlight: true,
  });
  assert.equal(busy.action, 'skip');
  const disarmed = decideUiAutoCompact({
    used: 190_000, window: 200_000, compactAtPercent: 90, armed: false,
  });
  assert.equal(disarmed.action, 'skip');
  assert.equal(disarmed.reason, 'disarmed');
  const rearm = decideUiAutoCompact({
    used: 74_000, window: 200_000, compactAtPercent: 90, armed: false,
  });
  assert.equal(rearm.action, 'skip');
  assert.equal(rearm.nextArmed, true);
});

test('nextArmedAfterCompact stays down if occupancy did not drop enough', () => {
  assert.equal(nextArmedAfterCompact({ usedAfter: 74_000, compactAtTokens: 180_000 }), true);
  assert.equal(nextArmedAfterCompact({ usedAfter: 185_000, compactAtTokens: 180_000 }), false);
  assert.equal(nextArmedAfterCompact({ usedAfter: undefined, compactAtTokens: 180_000 }), false);
});

test('cooldown and disabled skip compact', () => {
  const cool = decideUiAutoCompact({
    used: 190_000, window: 200_000, compactAtPercent: 90,
    now: 1_000, retryAt: 2_000,
  });
  assert.equal(cool.action, 'skip');
  assert.equal(cool.reason, 'cooldown');
  const off = decideUiAutoCompact({
    used: 190_000, window: 200_000, compactAtPercent: 90, enabled: false,
  });
  assert.equal(off.action, 'skip');
  assert.equal(uiAutoCompactEnabled({ GROK_REMOTE_UI_AUTO_COMPACT: '0' }), false);
  assert.equal(uiAutoCompactEnabled({}), true);
  assert.equal(uiAutoCompactEnabled({ GROK_REMOTE_UI_AUTO_COMPACT: '1' }), true);
});

test('implausible occupancy (lifetime totals) does not auto-compact', () => {
  const d = decideUiAutoCompact({
    used: 31_138_726,
    window: 200_000,
    compactAtPercent: 90,
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'implausible-occupancy');
});

test('sendingPrompt skips compact so before-prompt cannot block client.prompt', () => {
  const d = decideUiAutoCompact({
    used: 190_000,
    window: 200_000,
    compactAtPercent: 90,
    sendingPrompt: true,
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'sending-prompt');
  assert.equal(d.nextArmed, true);
});


test('does not compact while tools are still in flight', () => {
  const d = decideUiAutoCompact({
    used: 190_000,
    window: 200_000,
    compactAtPercent: 90,
    toolsLive: true,
  });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'tools-live');
});

test('in-flight compact ack stays disarmed', () => {
  assert.equal(armedAfterInFlightAck(), false);
  const o = armedAfterCompactOutcome({
    rpc: 'in-flight', compactAtTokens: 180_000, usedAfter: 180_000,
  });
  assert.equal(o.armed, false);
  assert.equal(o.cooldown, false);
});

test('unsupported compact RPC stays disarmed with cooldown', () => {
  const o = armedAfterCompactOutcome({
    rpc: 'unsupported', compactAtTokens: 180_000, usedAfter: 180_000, dropped: false,
  });
  assert.equal(o.armed, false);
  assert.equal(o.cooldown, true);
});

test('prompt fallback without a drop does not re-arm', () => {
  const o = armedAfterCompactOutcome({
    rpc: 'session/prompt', compactAtTokens: 180_000, usedAfter: 185_000, dropped: false,
  });
  assert.equal(o.armed, false);
  assert.equal(o.cooldown, true);
});


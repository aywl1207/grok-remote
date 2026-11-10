import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveContextStatus, contextPillLabel, shouldApplyLiveOccupancy, pickUsedTokens, occupancyFromMeta } from '../lib/context-status.js';

test('deriveContextStatus computes percent and compact line', () => {
  const st = deriveContextStatus({ used: 200_000, window: 500_000, compactAtPercent: 80 });
  assert.equal(st.compactAtTokens, 400_000);
  assert.equal(st.remainingToCompact, 200_000);
  assert.equal(Math.round(st.percent), 40);
  assert.equal(st.level, 'ok');
});

test('deriveContextStatus warns near the compact line', () => {
  const st = deriveContextStatus({ used: 320_000, window: 500_000, compactAtPercent: 80 });
  assert.equal(st.level, 'warn');
});

test('deriveContextStatus is soon at or past the compact line', () => {
  const st = deriveContextStatus({ used: 400_000, window: 500_000, compactAtPercent: 80 });
  assert.equal(st.level, 'soon');
});

test('contextPillLabel shows used, window, and percent', () => {
  const st = deriveContextStatus({ used: 192_000, window: 200_000, compactAtPercent: 90 });
  assert.match(contextPillLabel(st), /192k/);
  assert.match(contextPillLabel(st), /200k/);
  assert.match(contextPillLabel(st), /96%/);
});

test('shouldApplyLiveOccupancy ignores history replay', () => {
  assert.equal(shouldApplyLiveOccupancy({}), true);
  assert.equal(shouldApplyLiveOccupancy({ fromHistory: true }), false);
  assert.equal(shouldApplyLiveOccupancy({ replaying: true }), false);
  assert.equal(shouldApplyLiveOccupancy({ isReplay: true }), false);
});

test('pickUsedTokens prefers live occupancy over a stale snapshot', () => {
  assert.equal(pickUsedTokens({ live: 146310, snap: 399013 }), 146310);
  assert.equal(pickUsedTokens({ live: null, snap: 146310 }), 146310);
  assert.equal(pickUsedTokens({}), 0);
});

test('occupancyFromMeta returns null when missing', () => {
  assert.equal(occupancyFromMeta({ totalTokens: 4 }), 4);
  assert.equal(occupancyFromMeta({}), null);
});

test('contextPillLabel omits a guessed window when none was provided', () => {
  const st = deriveContextStatus({ used: 84_392 });
  assert.equal(st.windowKnown, false);
  assert.equal(contextPillLabel(st), '84k');
  assert.doesNotMatch(contextPillLabel(st), /500k|200k/);
});

test('deriveContextStatus does not invent an auto-compact line', () => {
  const omitted = deriveContextStatus({ used: 400_000, window: 500_000 });
  assert.equal(omitted.compactAtKnown, false);
  assert.equal(omitted.level, 'ok');
  const explicitFalse = deriveContextStatus({
    used: 400_000,
    window: 500_000,
    compactAtPercent: 80,
    compactAtKnown: false,
  });
  assert.equal(explicitFalse.compactAtKnown, false);
  assert.equal(explicitFalse.level, 'ok');
});

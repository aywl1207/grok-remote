import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_WINDOW_TTL_MS,
  shouldRefreshContextWindow,
  applyContextWindow,
  clearContextWindow,
  tokensPillText,
  localContextStatus,
} from '../src/views/chat/context-panel.ts';

test('shouldRefreshContextWindow is true until a live window arrives', () => {
  const view: Record<string, unknown> = { agentId: 'a1' };
  assert.equal(shouldRefreshContextWindow(view), true);
  applyContextWindow(view, { window: 180000, compactAtPercent: 90, model: 'grok-4.6' });
  assert.equal(shouldRefreshContextWindow(view, view._contextWindowAt as number), false);
  assert.equal(
    shouldRefreshContextWindow(view, (view._contextWindowAt as number) + CONTEXT_WINDOW_TTL_MS + 1),
    true,
  );
});

test('clearContextWindow drops the cache so the next paint re-reads config', () => {
  const view: Record<string, unknown> = { agentId: 'a1' };
  applyContextWindow(view, { window: 180000 });
  clearContextWindow(view);
  assert.equal(view._contextWindow, null);
  assert.equal(shouldRefreshContextWindow(view), true);
});

test('tokensPillText shows Compacting while a compact is in flight', () => {
  const view: Record<string, unknown> = {
    agentId: 'a1',
    _compacting: true,
    latestTotalTokens: 180000,
  };
  applyContextWindow(view, { window: 200000, compactAtPercent: 90, model: 'grok-4.6' });
  const st = localContextStatus(view);
  assert.equal(tokensPillText(view, st), 'Compacting…');
  view._compacting = false;
  assert.match(tokensPillText(view, st), /200k/);
});

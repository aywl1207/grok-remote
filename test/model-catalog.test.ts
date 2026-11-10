import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogFromText } from '../lib/model-catalog.ts';

test('catalog keeps efforts, windows, notice, and config stubs', () => {
  const cache = JSON.stringify({
    models: {
      'grok-4.7': {
        info: {
          id: 'grok-4.7',
          name: 'Grok 4.7',
          context_window: 256000,
          context_windows: [128000, 256000],
          auto_compact_threshold_percent: 80,
          notice_banner: 'Smart auto',
          reasoning_efforts: [
            { id: 'high', label: 'High', default: true },
            { id: 'xhigh', label: 'Extra High' },
          ],
        },
      },
    },
  });
  const toml = '[model.qwen-local]\ncontext_window = 32768\n';
  const items = catalogFromText(cache, toml);
  const grok = items.find((m) => m.id === 'grok-4.7');
  const local = items.find((m) => m.id === 'qwen-local');
  assert.ok(grok);
  assert.deepEqual(grok!.windows, [128000, 256000]);
  assert.equal(grok!.notice, 'Smart auto');
  assert.equal(grok!.efforts[0].recommended, true);
  assert.equal(grok!.compactAtKnown, true);
  assert.ok(local);
  assert.equal(local!.contextWindow, 32768);
});

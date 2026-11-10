import test from 'node:test';
import assert from 'node:assert/strict';

import { countLiveItems } from '../src/lib/live-bar.js';

test('countLiveItems ignores idle skills and exited chips', () => {
  assert.equal(countLiveItems([]), 0);
  assert.equal(countLiveItems([{ live: false }, { kind: 'skill' } as { live?: boolean }]), 0);
  assert.equal(countLiveItems([{ live: true }, { live: false }, { live: true }]), 2);
});

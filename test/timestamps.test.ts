import test from 'node:test';
import assert from 'node:assert/strict';

import { timestampsEnabled, setTimestampsEnabled } from '../src/lib/timestamps.js';

test('timestampsEnabled defaults on and can be toggled', () => {
  const store = new Map();
  const orig = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  try {
    assert.equal(timestampsEnabled(), true);
    setTimestampsEnabled(false);
    assert.equal(timestampsEnabled(), false);
    setTimestampsEnabled(true);
    assert.equal(timestampsEnabled(), true);
  } finally {
    globalThis.localStorage = orig;
  }
});

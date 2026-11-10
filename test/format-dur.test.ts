import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtDur } from '../src/lib/format.js';

test('fmtDur covers ms, seconds, and minutes', () => {
  assert.equal(fmtDur(400), '400ms');
  assert.equal(fmtDur(1500), '1.5s');
  assert.equal(fmtDur(12000), '12s');
  assert.equal(fmtDur(65000), '1m 5s');
  assert.equal(fmtDur(-1), '');
});

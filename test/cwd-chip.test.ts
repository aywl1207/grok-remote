import test from 'node:test';
import assert from 'node:assert/strict';

import { cwdTail } from '../src/lib/cwd-chip.js';

test('cwdTail keeps short paths intact', () => {
  assert.equal(cwdTail(''), '');
  assert.equal(cwdTail('/home/opc'), '/home/opc');
});

test('cwdTail keeps last two segments of a long path', () => {
  assert.equal(cwdTail('/home/opc/projects/default'), '…/projects/default');
  assert.equal(cwdTail('/home/opc/grok-projects/os-layout'), '…/grok-projects/os-layout');
});

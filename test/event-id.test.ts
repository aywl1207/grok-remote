import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLiveEventId, alreadyInHistory, maxLiveEventId } from '../src/lib/event-id.js';

test('parseLiveEventId only accepts timestamp-seq', () => {
  assert.deepEqual(parseLiveEventId('1700000000000-3'), { t: 1700000000000, n: 3 });
  assert.equal(parseLiveEventId('sess-3'), null);
  assert.equal(parseLiveEventId('backfill-1'), null);
});

test('alreadyInHistory does not compare sess ids to live ids', () => {
  assert.equal(alreadyInHistory('1700000000000-3', '1700000000000-2'), true);
  assert.equal(alreadyInHistory('1700000000000-3', '1700000000000-3'), true);
  assert.equal(alreadyInHistory('1700000000000-3', '1700000000000-4'), false);
  assert.equal(alreadyInHistory('1700000000000-3', 'sess-9'), false);
  assert.equal(alreadyInHistory('sess-9', '1700000000000-1'), false);
});

test('maxLiveEventId picks the newest live id, not array order', () => {
  assert.equal(maxLiveEventId('1786968767996-86', '1786968811144-185'), '1786968811144-185');
  assert.equal(maxLiveEventId('1786968811144-185', '1786968811144-10'), '1786968811144-185');
  assert.equal(maxLiveEventId('sess-3', '1786968811144-185'), '1786968811144-185');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { rowStatusLabel, rowStatusKey, SIDEBAR_COPY, SIDEBAR_SORT_DEFAULT } from '../src/lib/sidebar-row.js';

test('rowStatusLabel shows Idle, Disconnected, and Running', () => {
  assert.equal(rowStatusLabel('idle'), 'Idle');
  assert.equal(rowStatusLabel('disconnected'), 'Disconnected');
  assert.equal(rowStatusLabel('exited'), 'Disconnected');
  assert.equal(rowStatusLabel('running'), 'Running');
  assert.equal(rowStatusLabel('starting'), 'Starting');
  assert.equal(rowStatusLabel('errored'), 'Errored');
  assert.equal(rowStatusLabel(null), 'Idle');
});

test('rowStatusKey maps exited to disconnected', () => {
  assert.equal(rowStatusKey('exited'), 'disconnected');
  assert.equal(rowStatusKey('running'), 'running');
  assert.equal(rowStatusKey('idle'), 'idle');
});

test('sidebar copy uses Conversations wording', () => {
  assert.equal(SIDEBAR_COPY.title, 'Conversations');
  assert.equal(SIDEBAR_COPY.empty, 'No conversations yet.');
  assert.equal(SIDEBAR_SORT_DEFAULT, 'activity_desc');
  assert.equal(SIDEBAR_COPY.folderNew, 'New');
  assert.equal(SIDEBAR_COPY.folderFork, 'Fork');
  assert.equal(SIDEBAR_COPY.handleNew, '+ New chat');
  assert.equal(SIDEBAR_COPY.search, 'Search chats or projects');
  assert.equal(SIDEBAR_COPY.projects, 'Projects');
});

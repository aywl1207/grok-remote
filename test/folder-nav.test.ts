import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVED_FOLDER_ID,
  TOP_LEVEL_ID,
  folderActivity,
  projectLiveWork,
  projectMatchesSearch,
  resolveActiveFolderId,
  sortProjects,
} from '../src/views/agents/folder-nav.ts';

test('folderActivity uses the newest lastSeen', () => {
  assert.equal(folderActivity([
    { lastSeen: '2026-01-01' },
    { lastSeen: '2026-08-01', createdAt: '2020-01-01' },
    { createdAt: '2026-09-01' },
  ]), '2026-09-01');
});

test('sortProjects puts recent work first and Archived last', () => {
  const folders = [
    { id: ARCHIVED_FOLDER_ID, name: 'Archived' },
    { id: 'old', name: 'Old' },
    { id: 'new', name: 'New' },
  ];
  const activity = new Map([
    ['old', '2026-01-01'],
    ['new', '2026-08-01'],
  ]);
  assert.deepEqual(sortProjects(folders, activity).map((f) => f.id), [
    'new', 'old', ARCHIVED_FOLDER_ID,
  ]);
});

test('projectMatchesSearch hits folder name or contained chats', () => {
  assert.equal(projectMatchesSearch({ name: 'Invest Bot', search: 'invest', chatMatchCount: 0 }), true);
  assert.equal(projectMatchesSearch({ name: 'Invest Bot', search: 'zzz', chatMatchCount: 2 }), true);
  assert.equal(projectMatchesSearch({ name: 'Invest Bot', search: 'zzz', chatMatchCount: 0 }), false);
  assert.equal(projectMatchesSearch({ name: 'Invest Bot', search: '', chatMatchCount: 0 }), true);
});

test('resolveActiveFolderId prefers saved, then selected, then first live project', () => {
  assert.equal(resolveActiveFolderId({
    saved: 'b',
    folderIds: ['a', 'b'],
    hasTopLevel: true,
    selectedFolderId: 'a',
  }), 'b');
  assert.equal(resolveActiveFolderId({
    saved: 'gone',
    folderIds: ['a', 'b'],
    hasTopLevel: true,
    selectedFolderId: null,
  }), TOP_LEVEL_ID);
  assert.equal(resolveActiveFolderId({
    saved: null,
    folderIds: ['a', ARCHIVED_FOLDER_ID],
    hasTopLevel: false,
    selectedFolderId: undefined,
  }), 'a');
});

test('projectLiveWork counts live turns, not leftover ACP running', () => {
  assert.deepEqual(projectLiveWork([
    { status: 'running', turnOpen: true },
    { status: 'running', turnOpen: false },
    { status: 'idle', inFlight: 2 },
    { status: 'starting' },
    { status: 'idle' },
  ]), { running: 2, starting: 1 });
});

test('sortProjects puts live work above recent idle projects', () => {
  const folders = [
    { id: 'idle', name: 'Idle' },
    { id: 'live', name: 'Live' },
  ];
  const activity = new Map([
    ['idle', '2026-08-20'],
    ['live', '2026-01-01'],
  ]);
  const live = new Map([['live', 1]]);
  assert.deepEqual(sortProjects(folders, activity, live).map((f) => f.id), ['live', 'idle']);
});

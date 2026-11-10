import test from 'node:test';
import assert from 'node:assert/strict';

import { pickDefaultFolderId, siblingCwdsForFolder, pickForkSourceId } from '../src/views/agents/new-chat.ts';

const folders = [
  { id: 'archived', name: 'Archived', agentIds: [], system: true },
  { id: 'f1', name: 'Grok Remote', agentIds: ['a'] },
  { id: 'f2', name: 'Default', agentIds: ['b', 'c'] },
];

test('pickDefaultFolderId skips Archived and honors a preset', () => {
  assert.equal(pickDefaultFolderId(folders, 'f2'), 'f2');
  assert.equal(pickDefaultFolderId(folders, 'archived'), 'f1');
  assert.equal(pickDefaultFolderId(folders), 'f1');
});

test('siblingCwdsForFolder returns cwds of agents in that folder', () => {
  const agents = [
    { id: 'a', cwd: '/home/opc/grok-projects/grok-remote' },
    { id: 'b', cwd: '/home/opc/grok-projects/default' },
    { id: 'z', cwd: '/tmp' },
  ];
  assert.deepEqual(
    siblingCwdsForFolder(folders[1], agents),
    ['/home/opc/grok-projects/grok-remote'],
  );
});

test('pickForkSourceId prefers the selected chat in the folder', () => {
  assert.equal(pickForkSourceId({
    folderAgentIds: ['a', 'b', 'c'],
    selectedId: 'b',
  }), 'b');
});

test('pickForkSourceId uses the only chat in the folder', () => {
  assert.equal(pickForkSourceId({
    folderAgentIds: ['a'],
    selectedId: 'z',
  }), 'a');
});

test('pickForkSourceId forks the selected chat into an empty folder', () => {
  assert.equal(pickForkSourceId({
    folderAgentIds: [],
    selectedId: 'z',
    fallbackIds: ['x', 'z'],
  }), 'z');
});

test('pickForkSourceId returns null when the user must pick', () => {
  assert.equal(pickForkSourceId({
    folderAgentIds: ['a', 'b'],
    selectedId: 'z',
    fallbackIds: ['a', 'b', 'z'],
  }), null);
});

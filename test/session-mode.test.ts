import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readPermissionMode,
  permissionLabel,
  cyclePermissionMode,
  permissionSettingsPatch,
  permissionNeedsReconnect,
} from '../src/lib/session-mode.js';

test('readPermissionMode defaults to always-approve', () => {
  assert.equal(readPermissionMode(null), 'always-approve');
  assert.equal(readPermissionMode({}), 'always-approve');
});

test('readPermissionMode treats alwaysApprove false as ask, or auto when set', () => {
  assert.equal(readPermissionMode({ alwaysApprove: false }), 'ask');
  assert.equal(readPermissionMode({ alwaysApprove: false, permissionMode: 'auto' }), 'auto');
});

test('permissionLabel uses Title Case names', () => {
  assert.equal(permissionLabel('ask'), 'Ask');
  assert.equal(permissionLabel('auto'), 'Auto');
  assert.equal(permissionLabel('always-approve'), 'Always-Approve');
});

test('cyclePermissionMode walks ask → auto → always-approve → ask', () => {
  assert.equal(cyclePermissionMode('ask'), 'auto');
  assert.equal(cyclePermissionMode('auto'), 'always-approve');
  assert.equal(cyclePermissionMode('always-approve'), 'ask');
});

test('permissionSettingsPatch and reconnect flag', () => {
  assert.deepEqual(permissionSettingsPatch('ask'), {
    alwaysApprove: false,
    permissionMode: 'ask',
    autoMode: false,
  });
  assert.deepEqual(permissionSettingsPatch('auto'), {
    alwaysApprove: false,
    permissionMode: 'auto',
    autoMode: true,
  });
  assert.equal(permissionNeedsReconnect('always-approve'), false);
  assert.equal(permissionNeedsReconnect('ask'), true);
});

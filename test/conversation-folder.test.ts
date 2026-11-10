import test from 'node:test';
import assert from 'node:assert/strict';

import { PROJECTS_ROOT, resolveFolderInput, projectGroupName, folderNameToCwd, inferCwdForFolder } from '../lib/conversation-folder.js';

test('bare name becomes a project folder', () => {
  assert.equal(resolveFolderInput('my-app'), `${PROJECTS_ROOT}/my-app`);
  assert.equal(resolveFolderInput('  invest bot  '), `${PROJECTS_ROOT}/invest bot`);
});

test('absolute path is kept', () => {
  assert.equal(resolveFolderInput('/home/opc/grok-projects/os-layout/'), '/home/opc/grok-projects/os-layout');
});

test('empty or dotted names do not resolve', () => {
  assert.equal(resolveFolderInput(''), '');
  assert.equal(resolveFolderInput('...'), '');
  assert.equal(resolveFolderInput('../up'), `${PROJECTS_ROOT}/-up`);
});

test('projectGroupName matches TUI cwd groups', () => {
  assert.equal(projectGroupName('/home/opc/grok-projects/grok-remote', PROJECTS_ROOT, '/home/opc'), 'Grok Remote');
  assert.equal(projectGroupName('/home/opc/grok-projects/default', PROJECTS_ROOT, '/home/opc'), 'Default');
  assert.equal(projectGroupName('/home/opc/grok-projects/invest-bot', PROJECTS_ROOT, '/home/opc'), 'Invest Bot');
  assert.equal(projectGroupName('/home/opc', PROJECTS_ROOT, '/home/opc'), 'Home');
  assert.equal(projectGroupName('/tmp/other', PROJECTS_ROOT, '/home/opc'), '');
  assert.equal(projectGroupName('/home/opc/.grok-remote/agents/abc/cwd', PROJECTS_ROOT, '/home/opc'), '');
});

test('folderNameToCwd reverses sidebar titles', () => {
  assert.equal(folderNameToCwd('Grok Remote'), `${PROJECTS_ROOT}/grok-remote`);
  assert.equal(folderNameToCwd('Invest Bot'), `${PROJECTS_ROOT}/invest-bot`);
  assert.equal(folderNameToCwd('Default'), `${PROJECTS_ROOT}/default`);
  assert.equal(folderNameToCwd('Home'), '/home/opc');
});

test('inferCwdForFolder prefers the most common sibling cwd', () => {
  assert.equal(inferCwdForFolder({
    folderName: 'Default',
    siblingCwds: [
      '/home/opc/grok-projects/default',
      '/home/opc/grok-projects/default/',
      '/tmp/other',
    ],
  }), '/home/opc/grok-projects/default');
  assert.equal(inferCwdForFolder({ folderName: 'Grok Remote' }), `${PROJECTS_ROOT}/grok-remote`);
});

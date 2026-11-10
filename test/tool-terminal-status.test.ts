import test from 'node:test';
import assert from 'node:assert/strict';
import { isShellKind, shellStatusLabel, terminalToolStatus } from '../src/lib/render/tools.ts';

test('cancelled turns close tools as canceled', () => {
  assert.equal(terminalToolStatus('cancelled'), 'canceled');
  assert.equal(terminalToolStatus('end_turn'), 'completed');
  assert.equal(terminalToolStatus(''), 'completed');
});

test('shell cards say Running and Ran without changing the canonical id', () => {
  assert.equal(isShellKind({ kind: 'run_terminal_command' }), true);
  assert.equal(isShellKind({ kind: 'read', rawInput: { command: 'ls' } }), true);
  assert.equal(isShellKind({ kind: 'read' }), false);
  assert.equal(shellStatusLabel('Running'), 'Running …');
  assert.equal(shellStatusLabel('Completed'), 'Ran …');
  assert.equal(shellStatusLabel('Canceled'), null);
});

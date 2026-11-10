import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSubAgentCall,
  pickSubAgentLabel,
  pickSubAgentType,
  humanizeSubAgentType,
  subAgentTypeSlug,
  formatSubAgentStatus,
  effectiveSubAgentStatus,
  childSessionEventFinishesSubagent,
  pickCardIndexForChildSession,
  openCardBlocksParentTurn,
  readSubAgentMeta,
} from '../src/lib/render.js';

test('isSubAgentCall detects spawn title, type, Task variant, and agent kind', () => {
  assert.equal(isSubAgentCall({ title: 'spawn_subagent' }), true);
  assert.equal(isSubAgentCall({ rawInput: { subagent_type: 'explore' } }), true);
  assert.equal(isSubAgentCall({ rawInput: { variant: 'Task' } }), true);
  assert.equal(isSubAgentCall({ kind: 'task' }), true);
  assert.equal(isSubAgentCall({ kind: 'agent(explore)' }), true);
  assert.equal(isSubAgentCall({ kind: 'read', title: 'Read foo' }), false);
  assert.equal(isSubAgentCall(null), false);
});

test('pickSubAgentLabel prefers description, then title, then prompt first line', () => {
  assert.equal(pickSubAgentLabel({ rawInput: { description: 'Inspect docker stack' } }), 'Inspect docker stack');
  assert.equal(pickSubAgentLabel({ title: 'Search auth middleware' }), 'Search auth middleware');
  assert.equal(pickSubAgentLabel({ title: 'spawn_subagent', rawInput: { prompt: 'Look at src\nand then edit' } }), 'Look at src');
  assert.equal(pickSubAgentLabel({ title: 'spawn_subagent' }), 'Subagent');
});

test('pickSubAgentType reads subagent_type, agent(kind), Task variant', () => {
  assert.equal(pickSubAgentType({ rawInput: { subagent_type: 'explore' } }), 'explore');
  assert.equal(pickSubAgentType({ kind: 'agent(plan)' }), 'plan');
  assert.equal(pickSubAgentType({ rawInput: { variant: 'Task' } }), 'general-purpose');
  assert.equal(pickSubAgentType({ kind: 'task' }), 'general-purpose');
});

test('humanizeSubAgentType uses Title Case names for built-ins and custom slugs', () => {
  assert.equal(humanizeSubAgentType('general-purpose'), 'General Purpose');
  assert.equal(humanizeSubAgentType('explore'), 'Explore');
  assert.equal(humanizeSubAgentType('plan'), 'Plan');
  assert.equal(humanizeSubAgentType('my_custom'), 'My Custom');
  assert.equal(humanizeSubAgentType(''), 'General Purpose');
});

test('subAgentTypeSlug normalizes task/agent to general-purpose', () => {
  assert.equal(subAgentTypeSlug('Explore'), 'explore');
  assert.equal(subAgentTypeSlug('task'), 'general-purpose');
  assert.equal(subAgentTypeSlug('agent'), 'general-purpose');
});

test('formatSubAgentStatus keeps Title Case and spells Cancelled', () => {
  assert.equal(formatSubAgentStatus('Running'), 'Running');
  assert.equal(formatSubAgentStatus('Completed'), 'Completed');
  assert.equal(formatSubAgentStatus('Canceled'), 'Cancelled');
  assert.equal(formatSubAgentStatus(''), 'Pending');
});

test('readSubAgentMeta collects type, label, and optional flags', () => {
  const meta = readSubAgentMeta({
    title: 'Inspect docker stack',
    rawInput: {
      description: 'Inspect docker stack',
      subagent_type: 'explore',
      background: true,
      isolation: 'worktree',
      capability_mode: 'read-only',
    },
  });
  assert.equal(meta.typeLabel, 'Explore');
  assert.equal(meta.typeSlug, 'explore');
  assert.equal(meta.label, 'Inspect docker stack');
  assert.equal(meta.background, true);
  assert.equal(meta.isolation, 'Worktree');
  assert.equal(meta.capability, 'Read-Only');
});

test('spawn completed stays Running until the child session finishes', () => {
  assert.equal(effectiveSubAgentStatus({ toolStatus: 'Completed' }), 'Running');
  assert.equal(effectiveSubAgentStatus({ toolStatus: 'Completed', childFinished: true }), 'Completed');
  assert.equal(effectiveSubAgentStatus({ toolStatus: 'Failed' }), 'Failed');
  assert.equal(effectiveSubAgentStatus({ toolStatus: 'Running', childFinished: true }), 'Completed');
  assert.equal(effectiveSubAgentStatus({ toolStatus: 'Pending' }), 'Pending');
});

test('child prompt_complete finishes the subagent; idle does not', () => {
  assert.equal(childSessionEventFinishesSubagent('prompt_complete'), true);
  assert.equal(childSessionEventFinishesSubagent('agent_status', { status: 'disconnected' }), true);
  assert.equal(childSessionEventFinishesSubagent('agent_status', { status: 'idle' }), false);
  assert.equal(childSessionEventFinishesSubagent('agent_message_chunk'), false);
});

test('pickCardIndexForChildSession matches id, or the only open unmatched card', () => {
  const a = { childId: 'child-a', open: true };
  const b = { childId: '', open: true };
  assert.equal(pickCardIndexForChildSession([a, b], 'child-a'), 0);
  assert.equal(pickCardIndexForChildSession([b], 'child-z'), 0);
  assert.equal(pickCardIndexForChildSession([b, { childId: '', open: true }], 'child-z'), -1);
});

test('history spawn completed stays Completed; live spawn stays Running', () => {
  assert.equal(effectiveSubAgentStatus({ toolStatus: 'Completed', fromHistory: true }), 'Completed');
  assert.equal(effectiveSubAgentStatus({ toolStatus: 'Completed', fromHistory: false }), 'Running');
});

test('subagent cards do not block parent prompt_complete', () => {
  assert.equal(openCardBlocksParentTurn({ isSubagent: true, status: 'Running' }), false);
  assert.equal(openCardBlocksParentTurn({ isSubagent: false, status: 'Running' }), true);
  assert.equal(openCardBlocksParentTurn({ isSubagent: false, status: 'Completed' }), false);
});

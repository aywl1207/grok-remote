import test from 'node:test';
import assert from 'node:assert/strict';
import { sortAgents, matchesSearch } from '../src/views/agents/sort.js';

test('sortAgents keeps starred conversations first', () => {
  const list = [
    { id: 'a', name: 'zulu', starred: false, createdAt: '2026-01-02' },
    { id: 'b', name: 'alpha', starred: true, createdAt: '2026-01-01' },
    { id: 'c', name: 'mid', starred: false, createdAt: '2026-01-03' },
  ];
  const out = sortAgents(list, 'created_desc');
  assert.equal(out[0]!.id, 'b');
  assert.deepEqual(out.slice(1).map((x) => x.id), ['c', 'a']);
});

test('matchesSearch looks at name, id, and model only', () => {
  const a = { id: 'xyz', name: 'Invest', model: 'grok-4', cwd: '/secret' };
  assert.equal(matchesSearch(a, 'invest'), true);
  assert.equal(matchesSearch(a, 'xyz'), true);
  assert.equal(matchesSearch(a, 'grok'), true);
  assert.equal(matchesSearch(a, 'secret'), false);
  assert.equal(matchesSearch(a, ''), true);
});

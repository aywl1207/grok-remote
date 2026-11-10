import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWorkflowMeta } from '../lib/workflows.js';

test('parseWorkflowMeta reads name description and when_to_use', () => {
  const raw = `
let meta = #{
  name: "review-changes",
  description: "Review a branch",
  when_to_use: "After opening a PR",
};
`;
  const m = parseWorkflowMeta(raw);
  assert.equal(m.name, 'review-changes');
  assert.equal(m.description, 'Review a branch');
  assert.equal(m.whenToUse, 'After opening a PR');
});

test('parseWorkflowMeta returns empty strings when missing', () => {
  const m = parseWorkflowMeta('fn main() {}');
  assert.equal(m.name, '');
  assert.equal(m.description, '');
});

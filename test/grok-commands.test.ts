import test from 'node:test';
import assert from 'node:assert/strict';
import { GROK_BUILD_COMMANDS, localHrefForSlash } from '../src/lib/grok-commands.ts';

test('localHrefForSlash maps builtin local pages', () => {
  assert.equal(localHrefForSlash('/skills'), '#/settings/skills');
  assert.equal(localHrefForSlash('/memory'), '#/settings/memory');
  assert.equal(localHrefForSlash('/hooks'), '#/settings/hooks');
  assert.equal(localHrefForSlash('/compact'), null);
  assert.equal(localHrefForSlash('/imagine a cat'), null);
  assert.equal(localHrefForSlash('hello'), null);
});

test('localHrefForSlash honors merged command lists', () => {
  const href = localHrefForSlash('/foo', [
    ...GROK_BUILD_COMMANDS,
    { name: 'foo', kind: 'local', href: '#/settings/foo' },
  ]);
  assert.equal(href, '#/settings/foo');
});

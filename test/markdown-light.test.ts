import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseProse, safeLinkUrl } from '../src/lib/render/markdown.ts';

test('dollar amounts stay plain text', () => {
  const parts = parseInline('Cost is $12.50 and $3.');
  assert.deepEqual(parts, [{ kind: 'text', text: 'Cost is $12.50 and $3.' }]);
});

test('links and images do not keep markdown markers', () => {
  const parts = parseInline('See [docs](https://x.ai/cli) and ![plot](notaurl) plus ![ok](https://x.ai/a.png).');
  assert.equal(parts[0].kind, 'text');
  assert.deepEqual(parts[1], { kind: 'link', text: 'docs', href: 'https://x.ai/cli' });
  assert.deepEqual(parts[3], { kind: 'img', alt: 'plot', src: null, fallback: 'notaurl' });
  assert.equal(parts[5].kind, 'img');
  if (parts[5].kind === 'img') assert.equal(parts[5].src, 'https://x.ai/a.png');
});

test('unsafe links are shown as text', () => {
  assert.equal(safeLinkUrl('javascript:alert(1)'), null);
  const parts = parseInline('[x](javascript:alert)');
  assert.deepEqual(parts, [{ kind: 'text', text: 'x' }]);
});

test('quotes, lists, and headings split out of prose', () => {
  const blocks = parseProse('# Title\n\n- one\n- two\n\n> quoted line\n> next');
  assert.equal(blocks[0].kind, 'h');
  assert.equal(blocks[1].kind, 'ul');
  assert.equal(blocks[2].kind, 'quote');
  if (blocks[2].kind === 'quote') assert.equal(blocks[2].text, 'quoted line\nnext');
});

test('windows newlines become line breaks inside a paragraph', () => {
  const blocks = parseProse('hello\r\nworld');
  assert.equal(blocks.length, 1);
  if (blocks[0].kind === 'p') assert.equal(blocks[0].lines.length, 2);
});

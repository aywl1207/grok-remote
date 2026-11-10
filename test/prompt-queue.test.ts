import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasQueueContent,
  saveAgentQueue,
  loadAgentQueue,
  PROMPT_QUEUE_KEY,
} from '../src/lib/prompt-queue.js';

const mem: Record<string, string> = {};
const stub = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => { mem[k] = String(v); },
  removeItem: (k: string) => { delete mem[k]; },
};
(globalThis as { sessionStorage?: unknown }).sessionStorage = stub;

test('hasQueueContent needs text or attachments', () => {
  assert.equal(hasQueueContent(null), false);
  assert.equal(hasQueueContent({ text: '  ' }), false);
  assert.equal(hasQueueContent({ text: 'hello' }), true);
  assert.equal(hasQueueContent({ text: '', attachments: [{ name: 'a.png' }] }), true);
});

test('save and load queue per agent', () => {
  saveAgentQueue('aaa', { text: 'first', attachments: [] });
  saveAgentQueue('bbb', { text: 'second', attachments: [{ name: 'x' }] });
  assert.equal(loadAgentQueue('aaa')?.text, 'first');
  assert.equal(loadAgentQueue('bbb')?.text, 'second');
  assert.equal((loadAgentQueue('bbb')?.attachments as { name: string }[])[0]?.name, 'x');
  saveAgentQueue('aaa', null);
  assert.equal(loadAgentQueue('aaa'), null);
  assert.equal(loadAgentQueue('bbb')?.text, 'second');
  assert.ok(String(mem[PROMPT_QUEUE_KEY] || '').includes('bbb'));
});

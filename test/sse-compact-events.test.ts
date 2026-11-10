import test from 'node:test';
import assert from 'node:assert/strict';

type FakeListener = (ev: { data: string }) => void;

interface FakeES {
  url: string;
  readyState: number;
  listeners: Map<string, FakeListener[]>;
  addEventListener(name: string, fn: FakeListener): void;
  fire(name: string, data: string): void;
  close(): void;
}

let lastInstance: FakeES | null = null;

class FakeEventSource implements FakeES {
  url: string;
  readyState = 0;
  listeners = new Map<string, FakeListener[]>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    lastInstance = this;
  }
  addEventListener(name: string, fn: FakeListener): void {
    let arr = this.listeners.get(name);
    if (!arr) { arr = []; this.listeners.set(name, arr); }
    arr.push(fn);
  }
  fire(name: string, data: string): void {
    const arr = this.listeners.get(name) || [];
    for (const fn of arr) fn({ data });
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;

const { openStream, KNOWN_EVENTS } = await import('../src/lib/sse.js');

test('KNOWN_EVENTS includes Grok compact lifecycle names', () => {
  for (const n of [
    'x.ai/session/update',
    'auto_compact_started',
    'auto_compact_completed',
    'auto_compact_failed',
    'auto_compact_cancelled',
    'compact_started',
    'compact_completed',
    'compact_failed',
    'compaction_checkpoint',
    'user_message',
    'user_message_chunk',
    'handshake',
  ]) {
    assert.ok((KNOWN_EVENTS as readonly string[]).includes(n), n);
  }
});

test('openStream delivers x.ai/session/update compact events', () => {
  lastInstance = null;
  const calls: Array<[string, unknown]> = [];
  const h = openStream('/x', {
    onAny: (name, parsed) => { calls.push([name, parsed]); },
  });
  assert.ok(lastInstance!.listeners.has('x.ai/session/update'));
  lastInstance!.fire(
    'x.ai/session/update',
    '{"params":{"update":{"sessionUpdate":"auto_compact_started","percentage":81}}}',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'x.ai/session/update');
  const parsed = calls[0][1] as { params?: { update?: { sessionUpdate?: string } } };
  assert.equal(parsed.params?.update?.sessionUpdate, 'auto_compact_started');
  h.close();
});

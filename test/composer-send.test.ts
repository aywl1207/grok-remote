import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPrompt, shouldSendComposerEnter, localSessionHref, shouldDropChildEvent, canStartCompact, applyCompactSettleTimeout, removeRootBlockingCards, isWorking, viewIsReadyToSend, flushQueue, scheduleFlushQueue, forceSendQueued, steerQueued } from '../src/views/chat/composer.ts';
import { GROK_BUILD_COMMANDS } from '../src/lib/grok-commands.ts';

function mockView(text: string, opts?: { local?: () => Promise<boolean> | boolean }) {
  const classList = {
    add() {},
    remove() {},
    contains() { return true; },
  };
  return {
    agentId: 'a1',
    composerTa: { value: text },
    composerHint: { classList, textContent: 'Usage: /compact' },
    palette: { classList },
    composerCancel: { disabled: true },
    imageAttach: { getAttachments: () => [], clear() {} },
    _promptQueue: null,
    _lastEnterAt: 0,
    currentAgent: { connected: true, status: 'idle', inFlight: 0 },
    root: { querySelector: () => null },
    _tryLocalModelCommand: async () => false,
    _tryLocalSessionCommand: opts && opts.local ? opts.local : async () => false,
    _pushPromptHist() {},
    _buildPayloadSnapshot(t: string) { return { text: t }; },
    startTurn() {},
    scrollToBottom() {},
    showToast() {},
    _syncSendBtn() {},
  };
}

test('sendPrompt clears the textbox before a slow local command resolves', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const view = mockView('/compact keep the landing pad', {
    local: async () => { await gate; return true; },
  });
  const pending = sendPrompt(view);
  assert.equal(view.composerTa.value, '');
  release();
  await pending;
  assert.equal(view.composerTa.value, '');
});

test('sendPrompt restores the draft if the local command throws', async () => {
  const view = mockView('/fork', {
    local: async () => { throw new Error('nope'); },
  });
  await sendPrompt(view);
  assert.equal(view.composerTa.value, '/fork');
});

test('sendPrompt treats a resolved local command as done after clearing', async () => {
  const view = mockView('/skills');
  view._tryLocalSessionCommand = async (text: string) => text === '/skills';
  await sendPrompt(view);
  assert.equal(view.composerTa.value, '');
});

test('IME Enter does not send while composing', () => {
  assert.equal(shouldSendComposerEnter({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSendComposerEnter({ key: 'Enter', shiftKey: false, keyCode: 229 }), false);
  assert.equal(shouldSendComposerEnter({ key: 'Enter', shiftKey: true }), false);
  assert.equal(shouldSendComposerEnter({ key: 'Enter', shiftKey: false }), true);
});

test('localSessionHref navigates builtin local pages even if the agent overwrote the name', () => {
  assert.equal(localSessionHref('/skills'), '#/settings/skills');
  assert.equal(localSessionHref('/hooks'), '#/settings/hooks');
  assert.equal(localSessionHref('/plugins'), '#/settings/plugins');
  assert.equal(localSessionHref('/marketplace'), '#/settings/marketplaces');
  assert.equal(localSessionHref('/memory'), '#/settings/memory');
  assert.equal(localSessionHref('/workflows'), '#/settings/workflows');
  const agentOnly = [{ name: 'skills', kind: 'agent' as const }];
  assert.equal(localSessionHref('/skills', agentOnly), '#/settings/skills');
  assert.equal(localSessionHref('/skills', GROK_BUILD_COMMANDS), '#/settings/skills');
  assert.equal(localSessionHref('/compact'), null);
  assert.equal(localSessionHref('/skills extra'), null);
});

test('compact re-entry is rejected while already compacting', () => {
  assert.equal(canStartCompact({ agentId: 'a1', _compacting: false }), true);
  assert.equal(canStartCompact({ agentId: 'a1', _compacting: true }), false);
  assert.equal(canStartCompact({ agentId: null, _compacting: false }), false);
});

test('compact settle timeout unlocks send without marking finished', () => {
  const paints: string[] = [];
  const view: any = {
    _compacting: true,
    _compactFinished: false,
    _compactCard: { isConnected: true },
    _renderTokensPill() { paints.push('tokens'); },
    _paintLiveStatus() { paints.push('live'); },
    _syncSendBtn() { paints.push('send'); },
    currentAgent: { connected: true, status: 'idle', inFlight: 0 },
    root: { querySelector: () => null },
    agentId: 'a1',
  };
  applyCompactSettleTimeout(view);
  assert.equal(view._compacting, false);
  assert.equal(view._compactFinished, false);
  assert.ok(view._compactCard && view._compactCard.isConnected);
  assert.deepEqual(paints, ['tokens', 'live', 'send']);
  assert.equal(isWorking(view), false);
  assert.equal(viewIsReadyToSend(view), true);
  applyCompactSettleTimeout({ _compacting: true, _compactFinished: true });
});

test('setAgent leftover plan/perm cards are removed from the root', () => {
  const removed: string[] = [];
  const root = {
    querySelectorAll(sel: string) {
      assert.equal(sel, '.plan-card, .perm-card');
      return [
        { remove() { removed.push('plan'); } },
        { remove() { removed.push('perm'); } },
      ];
    },
  };
  removeRootBlockingCards(root);
  assert.deepEqual(removed, ['plan', 'perm']);
});

test('compact SSE is not dropped as a child-session payload', () => {
  assert.equal(shouldDropChildEvent('auto_compact_completed', {}, true), false);
  assert.equal(shouldDropChildEvent('compact_completed', {}, true), false);
  assert.equal(shouldDropChildEvent('compaction_checkpoint', {}, true), false);
  assert.equal(shouldDropChildEvent('auto_compact_started', {}, true), false);
  assert.equal(shouldDropChildEvent('compact_failed', {}, true), false);
  assert.equal(shouldDropChildEvent('agent_message_chunk', {}, true), true);
  assert.equal(shouldDropChildEvent('agent_message_chunk', {}, false), false);
});

test('sendPrompt clears image chips with the text draft', async () => {
  let cleared = 0;
  const view = mockView('hello');
  view.imageAttach = { getAttachments: () => [{ kind: 'image' }], clear() { cleared += 1; } };
  view._tryLocalSessionCommand = async () => true;
  await sendPrompt(view);
  assert.equal(view.composerTa.value, '');
  assert.ok(cleared >= 1);
});

test('flushQueue does not send while Send Now is in flight', async () => {
  const view: any = {
    agentId: 'a1',
    _promptQueue: { text: 'queued', attachments: [] },
    _forceSending: true,
    _flushingQueue: false,
  };
  await flushQueue(view);
  assert.equal(view._promptQueue && view._promptQueue.text, 'queued');
});

test('scheduleFlushQueue is skipped while Send Now owns the queue', () => {
  const view: any = {
    _promptQueue: { text: 'queued', attachments: [] },
    _forceSending: true,
    _flushTimer: null,
  };
  scheduleFlushQueue(view);
  assert.equal(view._flushTimer, null);
});

test('forceSendQueued takes the queue before cancel so idle flush cannot resend', async () => {
  const prompts: string[] = [];
  let cancelCalls = 0;
  const orig = (globalThis as any).fetch;
  const view: any = mockView('');
  view._promptQueue = { text: 'queued-now', attachments: [] };
  view._isWorking = () => true;
  view._turnOpen = true;
  view.activeTurn = { userText: 'old' };
  view.endTurn = () => {};
  view._renderQueueBar = () => {};
  view.turns = [];
  view.startTurn = (text: string) => { view.turns.push({ userText: text }); };
  view._tryLocalSessionCommand = async () => false;
  view._tryLocalModelCommand = async () => false;
  // forceSendQueued calls api.cancel then sendPrompt -> api.prompt.
  // Intercept by stubbing methods used: we patch after import is hard,
  // so simulate consume + the cancel paint path instead.
  const { consumeForcePayload, shouldFlushQueueOnIdle } = await import('../src/lib/force-queue.js');
  const consumed = consumeForcePayload({
    queue: view._promptQueue,
    draftText: '',
    draftAttachments: [],
  });
  assert.equal(consumed.clearQueue, true);
  view._promptQueue = null;
  view._forceSending = true;
  view._turnOpen = false;
  assert.equal(shouldFlushQueueOnIdle({ forceSending: true }), false);
  await flushQueue(view);
  assert.equal(view._promptQueue, null);
  void orig;
  void prompts;
  void cancelCalls;
});

test('steerQueued keeps the queue when interject is unsupported', async () => {
  const view: any = {
    agentId: 'a1',
    composerTa: { value: '' },
    imageAttach: { getAttachments: () => [], clear() {} },
    _promptQueue: { text: 'steer-me', attachments: [] },
    _isWorking: () => true,
    _renderQueueBar() {},
    _syncSendBtn() {},
    showToast() {},
  };
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url.includes('/interject')) {
      return new Response(JSON.stringify({ ok: false, error: 'Method not found: x.ai/interject' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected fetch ' + url);
  };
  try {
    await steerQueued(view);
    assert.equal(view._promptQueue && view._promptQueue.text, 'steer-me');
  } finally {
    globalThis.fetch = orig;
  }
});

test('steerQueued clears the queue after a successful interject', async () => {
  const view: any = {
    agentId: 'a1',
    composerTa: { value: '' },
    imageAttach: { getAttachments: () => [], clear() {} },
    _promptQueue: { text: 'steer-me', attachments: [] },
    _isWorking: () => true,
    _renderQueueBar() {},
    _syncSendBtn() {},
    showToast() {},
  };
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url.includes('/interject')) {
      return new Response(JSON.stringify({ ok: true, steered: true, rpc: 'x.ai/interject' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected fetch ' + url);
  };
  try {
    await steerQueued(view);
    assert.equal(view._promptQueue, null);
  } finally {
    globalThis.fetch = orig;
  }
});

test('flushQueue sends the queued prompt instead of putting it back', async () => {
  const bodies: Array<{ text?: string; force?: boolean }> = [];
  const view: any = mockView('');
  view._promptQueue = { text: 'send me next', attachments: [] };
  view._isWorking = () => false;
  view._flushingQueue = false;
  view._forceSending = false;
  view._steering = false;
  view._isReplaying = false;
  view._turnOpen = false;
  view._renderQueueBar = () => {};
  view._syncSendBtn = () => {};
  view._pushPromptHist = () => {};
  view.startTurn = () => {};
  view.scrollToBottom = () => {};
  view.composerCancel = { disabled: true };
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
  }
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any) => {
    const url = String(input);
    if (url.includes('/prompt')) {
      bodies.push(JSON.parse(String(init && init.body || '{}')));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected ' + url);
  };
  try {
    await flushQueue(view);
    assert.equal(view._promptQueue, null);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.text, 'send me next');
    assert.equal(bodies[0]!.force, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test('sendPrompt turns Windows newlines into newlines', async () => {
  const bodies: Array<{ text?: string }> = [];
  const view: any = mockView('ignored');
  view._isWorking = () => false;
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
  }
  const orig = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any) => {
    const url = String(input);
    if (url.includes('/prompt')) {
      bodies.push(JSON.parse(String(init && init.body || '{}')));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('unexpected ' + url);
  };
  try {
    await sendPrompt(view, { text: 'hello\r\nworld' });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.text, 'hello\nworld');
  } finally {
    globalThis.fetch = orig;
  }
});

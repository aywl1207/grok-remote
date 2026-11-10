import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseModelWindowOverrides,
  parseSessionCompactPercent,
  readModelConfigOverride,
  readModelWindow,
  resetContextWindowFileCache,
  resolveConversationWindow,
} from '../lib/context-window.js';

test('quoted [model."grok-4.6"] binds 200k / 90%', () => {
  const all = parseModelWindowOverrides(`
[model."grok-4.6"]
# quotes required
context_window = 200000
auto_compact_threshold_percent = 90

[model.qwen-local]
context_window = 32768
`);
  assert.equal(all['grok-4.6']?.context_window, 200000);
  assert.equal(all['grok-4.6']?.auto_compact_threshold_percent, 90);
  assert.equal(all['qwen-local']?.context_window, 32768);
});

test('unquoted [model.grok-4.6] is nested and ignored', () => {
  const all = parseModelWindowOverrides(`
[model.grok-4.6]
context_window = 200000
auto_compact_threshold_percent = 90
`);
  assert.equal(all['grok-4.6'], undefined);
  assert.equal(all['grok-4'], undefined);
});

test('readModelConfigOverride picks the named model only', () => {
  const toml = `
[model."grok-4.6"]
context_window = 200_000
auto_compact_threshold_percent = 90
[model."grok-4.5"]
context_window = 500000
auto_compact_threshold_percent = 80
`;
  const a = readModelConfigOverride('grok-4.6', toml);
  const b = readModelConfigOverride('grok-4.5', toml);
  const c = readModelConfigOverride('other', toml);
  assert.equal(a.context_window, 200000);
  assert.equal(a.auto_compact_threshold_percent, 90);
  assert.equal(b.context_window, 500000);
  assert.equal(b.auto_compact_threshold_percent, 80);
  assert.deepEqual(c, {});
});


test('[session] auto_compact_threshold_percent is parsed', () => {
  assert.equal(parseSessionCompactPercent(`
[session]
auto_compact_threshold_percent = 90
[model."grok-4.6"]
context_window = 200000
`), 90);
  assert.equal(parseSessionCompactPercent(`[ui]\nyolo = true\n`), null);
});

test('readModelWindow re-reads config.toml after it changes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-ctxwin-'));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  resetContextWindowFileCache();
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), `
[model."grok-4.6"]
context_window = 180000
auto_compact_threshold_percent = 90
`);
    assert.equal(readModelWindow('grok-4.6').window, 180000);
    assert.equal(readModelWindow('grok-4.6').compactAtPercent, 90);
    fs.writeFileSync(path.join(home, 'config.toml'), `
[session]
auto_compact_threshold_percent = 85
[model."grok-4.6"]
context_window = 256000
`);
    const w = readModelWindow('grok-4.6');
    assert.equal(w.window, 256000);
    assert.equal(w.compactAtPercent, 85);
  } finally {
    if (prev == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
    resetContextWindowFileCache();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readModelWindow does not borrow grok-4.6 catalog for another model', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-ctxwin-'));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  resetContextWindowFileCache();
  try {
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: {
        'grok-4.6': { info: { id: 'grok-4.6', context_window: 500000, auto_compact_threshold_percent: 80 } },
      },
    }));
    fs.writeFileSync(path.join(home, 'config.toml'), `
[model.qwen-local]
context_window = 32768
`);
    const q = readModelWindow('qwen-local');
    assert.equal(q.window, 32768);
    const other = readModelWindow('totally-unknown');
    assert.equal(other.window, 500000);
  } finally {
    if (prev == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
    resetContextWindowFileCache();
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test('resolveConversationWindow prefers per-chat settings over defaults and catalog', () => {
  const w = resolveConversationWindow({
    modelId: 'totally-unknown',
    settings: { contextWindow: 120000, autoCompactThresholdPercent: 100, uiAutoCompact: true },
    defaults: { contextWindow: 200000, compactAtPercent: 90 },
  });
  assert.equal(w.window, 120000);
  assert.equal(w.compactAtPercent, 100);
  assert.equal(w.uiAutoCompact, true);
});

test('resolveConversationWindow uses grok-remote defaults when chat has no override', () => {
  const w = resolveConversationWindow({
    modelId: 'totally-unknown',
    settings: { alwaysApprove: true },
    defaults: { contextWindow: 200000, compactAtPercent: 90 },
  });
  assert.equal(w.window, 200000);
  assert.equal(w.compactAtPercent, 90);
  assert.equal(w.uiAutoCompact, true);
});

test('resolveConversationWindow can disable UI auto-compact per chat', () => {
  const w = resolveConversationWindow({
    settings: { uiAutoCompact: false },
    defaults: { contextWindow: 200000, compactAtPercent: 90 },
  });
  assert.equal(w.uiAutoCompact, false);
});

test('readModelWindow marks compact percent unknown when nobody set one', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-ctxwin-'));
  const prev = process.env.GROK_HOME;
  process.env.GROK_HOME = home;
  resetContextWindowFileCache();
  try {
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'plain': { info: { id: 'plain', context_window: 1000 } } },
    }));
    fs.writeFileSync(path.join(home, 'config.toml'), '[ui]\n');
    const plain = readModelWindow('plain');
    assert.equal(plain.window, 1000);
    assert.equal(plain.compactAtKnown, false);
    const known = readModelWindow('plain');
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({
      models: { 'plain': { info: { id: 'plain', context_window: 1000, auto_compact_threshold_percent: 70, context_windows: [1000, 2000] } } },
    }));
    resetContextWindowFileCache();
    const again = readModelWindow('plain');
    assert.equal(again.compactAtKnown, true);
    assert.equal(again.compactAtPercent, 70);
    assert.deepEqual(again.windows, [1000, 2000]);
    void known;
  } finally {
    if (prev == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prev;
    resetContextWindowFileCache();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

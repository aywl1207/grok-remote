import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  listTuiSessions,
  listAllTuiSessions,
  writeTuiSessionTitle,
  deleteTuiSessionDir,
  planTuiSessionSync,
  shouldKillTuiOrphan,
  planTuiDuplicateCleanup,
  pickCanonicalTuiSession,
  importTuiChatHistory,
  tuiSessionTitle,
  isDisposableImportedChat,
  isDuplicateNameShell,
  isIgnoredUiCwd,
} from '../lib/tui-sessions.js';

function writeSummary(root: string, cwd: string, id: string, title: string, kind = '') {
  const dir = path.join(root, 'sessions', encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id, cwd },
    generated_title: title,
    session_summary: title,
    session_kind: kind || undefined,
    updated_at: '2026-08-22T00:00:00Z',
  }));
  return dir;
}

test('tuiSessionTitle prefers generated_title', () => {
  assert.equal(tuiSessionTitle({ generated_title: 'A', session_summary: 'B' }), 'A');
  assert.equal(tuiSessionTitle({ session_summary: 'B' }), 'B');
  assert.equal(tuiSessionTitle({}), '');
});

test('listTuiSessions skips subagents and reads titles', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-sess-'));
  try {
    writeSummary(home, '/tmp/p', 'sess-1', 'Alpha');
    writeSummary(home, '/tmp/p', 'sess-2', 'Child', 'subagent');
    const list = listTuiSessions(home);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, 'sess-1');
    assert.equal(list[0]!.title, 'Alpha');
    assert.equal(list[0]!.cwd, '/tmp/p');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('writeTuiSessionTitle updates generated_title', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-sess-'));
  try {
    const dir = writeSummary(home, '/tmp/p', 'sess-1', 'Old');
    assert.equal(writeTuiSessionTitle(dir, 'New Name'), true);
    const again = listTuiSessions(home);
    assert.equal(again[0]!.title, 'New Name');
    assert.equal(again[0]!.titleIsManual, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('deleteTuiSessionDir only removes a session folder', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-sess-'));
  try {
    const dir = writeSummary(home, '/tmp/p', 'sess-1', 'Alpha');
    assert.equal(deleteTuiSessionDir(dir, home), true);
    assert.equal(listTuiSessions(home).length, 0);
    assert.equal(deleteTuiSessionDir(path.join(home, 'sessions'), home), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('planTuiSessionSync renames, adopts, and removes', () => {
  const sessions = [
    { id: 's1', cwd: '/a', title: 'TUI Title', kind: '', dir: '/x/s1', updatedAt: '', createdAt: '', chatMessages: 20, titleIsManual: false },
    { id: 's2', cwd: '/a', title: 'New Chat', kind: '', dir: '/x/s2', updatedAt: '', createdAt: '', chatMessages: 3, titleIsManual: false },
  ];
  const agents = [
    { id: 'ag1', name: 'Old Name', lastSessionId: 's1' },
    { id: 'ag-orphan', name: 'Gone', lastSessionId: 'missing' },
    { id: 'ag-local', name: 'Local only', lastSessionId: null },
  ];
  const plan = planTuiSessionSync(agents, sessions);
  assert.deepEqual(plan.rename, [{ agentId: 'ag1', name: 'TUI Title' }]);
  assert.equal(plan.adopt.length, 1);
  assert.equal(plan.adopt[0]!.id, 's2');
  assert.deepEqual(plan.removeAgentIds, ['ag-orphan']);
});

test('isDisposableImportedChat drops identity pings and empty shells', () => {
  assert.equal(isDisposableImportedChat({
    name: 'User Inquiry About AI Identity',
    grokRemoteHistoryBytes: 0,
    tuiChatMessages: 5,
  }), true);
  assert.equal(isDisposableImportedChat({
    name: 'session-01a01839',
    grokRemoteHistoryBytes: 0,
    tuiChatMessages: 2,
  }), true);
  assert.equal(isDisposableImportedChat({
    name: 'Access Home Assistant OS 192.168.20.62',
    grokRemoteHistoryBytes: 0,
    tuiChatMessages: 299,
  }), false);
  assert.equal(isDisposableImportedChat({
    name: 'User Inquiry About AI Identity',
    holdRunning: true,
    grokRemoteHistoryBytes: 1000,
    tuiChatMessages: 2,
  }), false);
  assert.equal(isDisposableImportedChat({
    name: 'Paper-trading invest-bot plan and implement',
    grokRemoteHistoryBytes: 0,
    tuiChatMessages: 35,
  }), false);
});

test('planTuiSessionSync does not let TUI auto-title overwrite a manual name', () => {
  const sessions = [
    { id: 's1', cwd: '/a', title: 'Old Auto Title', kind: '', dir: '/x/s1', updatedAt: '', createdAt: '', chatMessages: 20, titleIsManual: false },
  ];
  const agents = [
    { id: 'ag1', name: 'My Pinned Name', lastSessionId: 's1', autoNamed: false },
  ];
  const plan = planTuiSessionSync(agents, sessions);
  assert.deepEqual(plan.rename, []);
});

test('planTuiSessionSync follows a TUI /rename', () => {
  const sessions = [
    { id: 's1', cwd: '/a', title: 'TUI Manual', kind: '', dir: '/x/s1', updatedAt: '', createdAt: '', chatMessages: 20, titleIsManual: true },
  ];
  const agents = [
    { id: 'ag1', name: 'Old', lastSessionId: 's1', autoNamed: false },
  ];
  const plan = planTuiSessionSync(agents, sessions);
  assert.deepEqual(plan.rename, [{ agentId: 'ag1', name: 'TUI Manual' }]);
});


test('listTuiSessions collapses duplicate session ids to the newest folder', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-sess-'));
  try {
    const older = writeSummary(home, '/tmp/old', 'sess-1', 'Old Auto');
    const newer = writeSummary(home, '/tmp/new', 'sess-1', 'Live Title');
    const olderSum = path.join(older, 'summary.json');
    const newerSum = path.join(newer, 'summary.json');
    const o = JSON.parse(fs.readFileSync(olderSum, 'utf8'));
    o.updated_at = '2026-08-18T00:00:00Z';
    o.num_chat_messages = 200;
    fs.writeFileSync(olderSum, JSON.stringify(o));
    const n = JSON.parse(fs.readFileSync(newerSum, 'utf8'));
    n.updated_at = '2026-08-22T00:00:00Z';
    n.num_chat_messages = 10;
    fs.writeFileSync(newerSum, JSON.stringify(n));
    const all = listAllTuiSessions(home);
    assert.equal(all.length, 2);
    const list = listTuiSessions(home);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.title, 'Live Title');
    assert.equal(list[0]!.dir, newer);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pickCanonicalTuiSession prefers the folder matching cwd over a newer leftover', () => {
  const sessions = [
    { id: 's1', cwd: '/tmp/old', title: 'Leftover', kind: '', dir: '/sessions/%2Ftmp%2Fold/s1', updatedAt: '2026-08-22T12:00:00Z', createdAt: '', chatMessages: 9, titleIsManual: false },
    { id: 's1', cwd: '/tmp/live', title: 'Live', kind: '', dir: '/sessions/%2Ftmp%2Flive/s1', updatedAt: '2026-08-20T00:00:00Z', createdAt: '', chatMessages: 3, titleIsManual: true },
  ];
  const keep = pickCanonicalTuiSession(sessions, '/tmp/live');
  assert.equal(keep && keep.dir, '/sessions/%2Ftmp%2Flive/s1');
});

test('planTuiDuplicateCleanup drops leftover dirs and import copies history', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-sess-'));
  try {
    const older = writeSummary(home, '/tmp/old', 'sess-1', 'Old Auto');
    const newer = writeSummary(home, '/tmp/new', 'sess-1', 'Live Title');
    fs.writeFileSync(path.join(older, 'chat_history.jsonl'), '{"type":"user","content":"<user_query>old turn</user_query>"}\n');
    fs.writeFileSync(path.join(newer, 'chat_history.jsonl'), '{"type":"user","content":"<user_query>new turn</user_query>"}\n');
    const o = JSON.parse(fs.readFileSync(path.join(older, 'summary.json'), 'utf8'));
    o.updated_at = '2026-08-18T00:00:00Z';
    fs.writeFileSync(path.join(older, 'summary.json'), JSON.stringify(o));
    const n = JSON.parse(fs.readFileSync(path.join(newer, 'summary.json'), 'utf8'));
    n.updated_at = '2026-08-22T00:00:00Z';
    fs.writeFileSync(path.join(newer, 'summary.json'), JSON.stringify(n));
    const all = listAllTuiSessions(home);
    const plan = planTuiDuplicateCleanup(all);
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.keep.dir, newer);
    assert.equal(plan[0]!.drop.length, 1);
    assert.equal(plan[0]!.drop[0]!.dir, older);
    assert.equal(importTuiChatHistory(older, newer), true);
    const imported = fs.readdirSync(newer).filter((x) => x.startsWith('chat_history.imported'));
    assert.equal(imported.length, 1);
    const body = fs.readFileSync(path.join(newer, imported[0]!), 'utf8');
    assert.ok(body.includes('old turn'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('planTuiSessionSync does not adopt a leftover duplicate of a linked session', () => {
  const sessions = [
    { id: 's1', cwd: '/a', title: 'Live', kind: '', dir: '/x/new/s1', updatedAt: '2026-08-22T00:00:00Z', createdAt: '', chatMessages: 3, titleIsManual: true },
    { id: 's1', cwd: '/old', title: 'Old Auto', kind: '', dir: '/x/old/s1', updatedAt: '2026-08-18T00:00:00Z', createdAt: '', chatMessages: 200, titleIsManual: false },
  ];
  const agents = [
    { id: 'ag1', name: 'Live', lastSessionId: 's1', autoNamed: false, cwd: '/a' },
  ];
  const plan = planTuiSessionSync(agents, sessions);
  assert.equal(plan.adopt.length, 0);
  assert.deepEqual(plan.rename, []);
  assert.deepEqual(plan.removeAgentIds, []);
});

test('planTuiSessionSync does not adopt a predecessor session with the same title', () => {
  const sessions = [
    { id: 's-new', cwd: '/proj', title: 'Grok Remote UI, iPad Auth, and TUI Sync', kind: '', dir: '/x/s-new', updatedAt: '2026-08-24T00:00:00Z', createdAt: '', chatMessages: 10, titleIsManual: true },
    { id: 's-old', cwd: '/proj', title: 'Grok Remote UI, iPad Auth, and TUI Sync', kind: '', dir: '/x/s-old', updatedAt: '2026-08-23T00:00:00Z', createdAt: '', chatMessages: 289, titleIsManual: true },
    { id: 's-other', cwd: '/other', title: 'Invest Bot', kind: '', dir: '/x/s-other', updatedAt: '', createdAt: '', chatMessages: 12, titleIsManual: false },
  ];
  const agents = [
    { id: 'ag1', name: 'Grok Remote UI, iPad Auth, and TUI Sync', lastSessionId: 's-new', autoNamed: false, cwd: '/proj' },
  ];
  const plan = planTuiSessionSync(agents, sessions);
  assert.deepEqual(plan.adopt.map((s) => s.id), ['s-other']);
  assert.deepEqual(plan.removeAgentIds, []);
});

test('planTuiSessionSync does not adopt a same-title leftover in an old cwd', () => {
  const sessions = [
    { id: 's-live', cwd: '/home/opc/grok-projects/grok-remote', title: 'Grok Remote UI, iPad Auth, and TUI Sync', kind: '', dir: '/x/live', updatedAt: '2026-08-24T00:00:00Z', createdAt: '', chatMessages: 95, titleIsManual: true },
    { id: 's-stale', cwd: '/home/opc/projects/default', title: 'Grok Remote UI, iPad Auth, and TUI Sync', kind: '', dir: '/x/stale', updatedAt: '2026-08-24T02:03:00Z', createdAt: '', chatMessages: 2, titleIsManual: true },
  ];
  const agents = [
    { id: 'ag1', name: 'Grok Remote UI, iPad Auth, and TUI Sync', lastSessionId: 's-live', autoNamed: false, cwd: '/home/opc/grok-projects/grok-remote' },
  ];
  const plan = planTuiSessionSync(agents, sessions);
  assert.equal(plan.adopt.length, 0);
});

test('isDuplicateNameShell drops empty shells that copy a heavier chat name', () => {
  const peers = [
    { id: 'heavy', name: 'Grok Remote UI, iPad Auth, and TUI Sync', grokRemoteHistoryBytes: 80_000_000 },
    { id: 'empty', name: 'Grok Remote UI, iPad Auth, and TUI Sync', grokRemoteHistoryBytes: 0 },
    { id: 'other', name: 'Invest Bot', grokRemoteHistoryBytes: 100 },
  ];
  assert.equal(isDuplicateNameShell({
    id: 'empty',
    name: 'Grok Remote UI, iPad Auth, and TUI Sync',
    grokRemoteHistoryBytes: 0,
    peers,
  }), true);
  assert.equal(isDuplicateNameShell({
    id: 'heavy',
    name: 'Grok Remote UI, iPad Auth, and TUI Sync',
    grokRemoteHistoryBytes: 80_000_000,
    peers,
  }), false);
  assert.equal(isDuplicateNameShell({
    id: 'other',
    name: 'Invest Bot',
    grokRemoteHistoryBytes: 100,
    peers,
  }), false);
});

test('isIgnoredUiCwd is true for /tmp and /var/tmp only', () => {
  assert.equal(isIgnoredUiCwd('/tmp'), true);
  assert.equal(isIgnoredUiCwd('/tmp/beichen-cio-abc'), true);
  assert.equal(isIgnoredUiCwd('/var/tmp/work'), true);
  assert.equal(isIgnoredUiCwd('/home/opc/grok-projects/invest-bot'), false);
  assert.equal(isIgnoredUiCwd('/home/opc/tmp-not-really'), false);
  assert.equal(isIgnoredUiCwd(''), false);
});

test('planTuiSessionSync does not adopt /tmp sessions', () => {
  const sessions = [
    { id: 'tmp1', cwd: '/tmp/beichen-cio-x', title: 'Empty-book CIO memo JSON output', kind: '', dir: '/x/tmp1', updatedAt: '', createdAt: '', chatMessages: 4, titleIsManual: false },
    { id: 'real1', cwd: '/home/opc/grok-projects/invest-bot', title: 'Invest Bot', kind: '', dir: '/x/real1', updatedAt: '', createdAt: '', chatMessages: 40, titleIsManual: true },
  ];
  const plan = planTuiSessionSync([], sessions);
  assert.deepEqual(plan.adopt.map((s) => s.id), ['real1']);
});

test('planTuiSessionSync removes existing /tmp sidebar shells', () => {
  const sessions = [
    { id: 'tmp1', cwd: '/tmp/beichen-risk-y', title: 'Memo', kind: '', dir: '/x/tmp1', updatedAt: '', createdAt: '', chatMessages: 3, titleIsManual: false },
    { id: 'real1', cwd: '/home/opc/grok-projects/invest-bot', title: 'Invest Bot', kind: '', dir: '/x/real1', updatedAt: '', createdAt: '', chatMessages: 40, titleIsManual: true },
  ];
  const agents = [
    { id: 'ag-tmp', name: 'Memo', lastSessionId: 'tmp1', cwd: '/tmp/beichen-risk-y' },
    { id: 'ag-real', name: 'Invest Bot', lastSessionId: 'real1', cwd: '/home/opc/grok-projects/invest-bot' },
  ];
  const plan = planTuiSessionSync(agents, sessions);
  assert.equal(plan.adopt.length, 0);
  assert.deepEqual(plan.removeAgentIds, ['ag-tmp']);
});

test('shouldKillTuiOrphan never deletes a dashboard chat with history or a hold', () => {
  assert.equal(shouldKillTuiOrphan({
    grokRemoteHistoryBytes: 50_000,
    ignoredCwd: false,
  }), false);
  assert.equal(shouldKillTuiOrphan({
    grokRemoteHistoryBytes: 0,
    holdRunning: true,
    ignoredCwd: true,
  }), false);
  assert.equal(shouldKillTuiOrphan({
    grokRemoteHistoryBytes: 0,
    ignoredCwd: false,
  }), false);
  assert.equal(shouldKillTuiOrphan({
    grokRemoteHistoryBytes: 0,
    ignoredCwd: true,
  }), true);
});

test('isDisposableImportedChat keeps a named dashboard chat with two messages', () => {
  assert.equal(isDisposableImportedChat({
    name: 'Invest Bot',
    grokRemoteHistoryBytes: 1000,
    tuiChatMessages: 2,
  }), false);
});

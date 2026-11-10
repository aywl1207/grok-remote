import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readLastUserTurns, countUserTurns, dropNewestUserTurns, readUserTurnsWindow, agentDir } from '../lib/history.js';

test('readLastUserTurns returns only the newest turns', () => {
  const id = 'test-hist-tail-' + process.pid;
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'history.jsonl');
  try {
    const lines = [];
    for (let i = 1; i <= 8; i++) {
      lines.push(JSON.stringify({ event: 'user_message', data: { text: 'u' + i } }));
      lines.push(JSON.stringify({ event: 'agent_message_chunk', data: { update: { content: { text: 'a' + i } } } }));
    }
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    const raw = readLastUserTurns(id, 3);
    const users = raw.split('\n').filter((l) => l.includes('"user_message"'));
    assert.ok(users.length >= 3);
    assert.match(raw, /"u8"/);
    assert.doesNotMatch(raw, /"u1"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('countUserTurns counts only user_message events', () => {
  const id = 'test-hist-count-' + process.pid;
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'history.jsonl');
  try {
    const lines = [];
    for (let i = 1; i <= 5; i++) {
      lines.push(JSON.stringify({ event: 'user_message', data: { text: 'u' + i } }));
      lines.push(JSON.stringify({ event: 'agent_message_chunk', data: { update: { content: { text: 'a' + i } } } }));
    }
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    assert.equal(countUserTurns(id), 5);
    assert.equal(countUserTurns(id), 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('countUserTurns increments from sidecar after append-only growth', () => {
  const id = 'test-hist-incr-' + process.pid;
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'history.jsonl');
  try {
    const lines = [];
    for (let i = 1; i <= 4; i++) {
      lines.push(JSON.stringify({ event: 'user_message', data: { text: 'u' + i } }));
    }
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    assert.equal(countUserTurns(id), 4);
    fs.appendFileSync(fp, JSON.stringify({ event: 'agent_message_chunk', data: { text: 'x' } }) + '\n');
    assert.equal(countUserTurns(id), 4);
    fs.appendFileSync(fp, JSON.stringify({ event: 'user_message', data: { text: 'u5' } }) + '\n');
    assert.equal(countUserTurns(id), 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dropNewestUserTurns keeps the older window', () => {
  const lines = [];
  for (let i = 1; i <= 6; i++) {
    lines.push(JSON.stringify({ event: 'user_message', data: { text: 'u' + i } }));
    lines.push(JSON.stringify({ event: 'agent_message_chunk', data: { text: 'a' + i } }));
  }
  const raw = lines.join('\n') + '\n';
  const kept = dropNewestUserTurns(raw, 3);
  assert.match(kept, /"u3"/);
  assert.doesNotMatch(kept, /"u4"/);
  assert.doesNotMatch(kept, /"u6"/);
});

test('readUserTurnsWindow returns 3 turns before the painted tail', () => {
  const id = 'test-hist-window-' + process.pid;
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'history.jsonl');
  try {
    const lines = [];
    for (let i = 1; i <= 9; i++) {
      lines.push(JSON.stringify({ event: 'user_message', data: { text: 'u' + i } }));
      lines.push(JSON.stringify({ event: 'agent_message_chunk', data: { text: 'a' + i } }));
    }
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    const raw = readUserTurnsWindow(id, 3, 3);
    assert.match(raw, /"u4"/);
    assert.match(raw, /"u6"/);
    assert.doesNotMatch(raw, /"u3"/);
    assert.doesNotMatch(raw, /"u7"/);
    const older = readUserTurnsWindow(id, 3, 6);
    assert.match(older, /"u1"/);
    assert.match(older, /"u3"/);
    assert.doesNotMatch(older, /"u4"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readUserTurnsWindow offsets stay correct with unicode lines', () => {
  const id = 'test-hist-unicode-' + process.pid;
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'history.jsonl');
  try {
    const lines = [];
    for (let i = 1; i <= 6; i++) {
      lines.push(JSON.stringify({ event: 'user_message', data: { text: 'u' + i } }));
      lines.push(JSON.stringify({ event: 'agent_message_chunk', data: { text: '你好世界'.repeat(20) + i } }));
    }
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    const raw = readUserTurnsWindow(id, 2, 2);
    assert.match(raw, /"u3"/);
    assert.match(raw, /"u4"/);
    assert.doesNotMatch(raw, /"u2"/);
    assert.doesNotMatch(raw, /"u5"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readLastUserTurns does not keep previous-turn leftover before the window', () => {
  const id = 'test-hist-prefix-' + process.pid;
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, 'history.jsonl');
  try {
    const lines = [
      JSON.stringify({ event: 'agent_message_chunk', data: { update: { content: { text: 'OLD-TAIL -prompt compact' } } } }),
      JSON.stringify({ event: 'agent_thought_chunk', data: { update: { content: { text: 'old thought' } } } }),
    ];
    for (let i = 1; i <= 3; i++) {
      lines.push(JSON.stringify({ event: 'user_message', data: { text: 'u' + i } }));
      lines.push(JSON.stringify({ event: 'agent_message_chunk', data: { update: { content: { text: 'a' + i } } } }));
    }
    fs.writeFileSync(fp, lines.join('\n') + '\n');
    const raw = readLastUserTurns(id, 3);
    assert.match(raw, /"u1"/);
    assert.match(raw, /"u3"/);
    assert.doesNotMatch(raw, /OLD-TAIL/);
    assert.doesNotMatch(raw, /old thought/);
    const first = JSON.parse(raw.split('\n').find(Boolean));
    assert.equal(first.event, 'user_message');
    assert.equal(first.data.text, 'u1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

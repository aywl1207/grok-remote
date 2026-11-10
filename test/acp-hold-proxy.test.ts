import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const holdScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/acp-hold.ts');

function waitSock(sockPath: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(sockPath)) return resolve();
      if (Date.now() > deadline) return reject(new Error('hold sock missing'));
      setTimeout(tick, 30);
    };
    tick();
  });
}

function connect(sockPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function readOnce(s: net.Socket, ms = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for hold echo')), ms);
    s.once('data', (buf) => {
      clearTimeout(t);
      resolve(buf.toString('utf8'));
    });
  });
}

test('hold replaces a stale client so the new attach can write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-hold-'));
  const sockPath = path.join(dir, 'acp.sock');
  const echo = 'node';
  const echoArgv = ['-e', 'process.stdin.pipe(process.stdout)'];
  let child: ChildProcess | null = null;
  try {
    child = spawn('node', ['--import', 'tsx', holdScript, '--sock', sockPath, '--cwd', dir, '--', ...echoArgv], {
      env: { ...process.env, GROK_BIN: echo },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitSock(sockPath);
    const first = await connect(sockPath);
    first.write('one\n');
    assert.equal(await readOnce(first), 'one\n');

    const second = await connect(sockPath);
    await new Promise((r) => setTimeout(r, 80));
    second.write('two\n');
    assert.equal(await readOnce(second), 'two\n');
    second.end();
    first.destroy();
  } finally {
    try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

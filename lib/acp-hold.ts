// Sibling-container shim: one grok stdio process, reconnectable Unix socket.
// Client disconnect does not kill grok.

import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';

function arg(flag: string, fallback = ''): string {
  const i = process.argv.indexOf(flag);
  if (i < 0 || !process.argv[i + 1]) return fallback;
  return process.argv[i + 1]!;
}

const sockPath = arg('--sock');
const cwd = arg('--cwd', process.cwd());
const split = process.argv.indexOf('--');
const grokArgv = split >= 0 ? process.argv.slice(split + 1) : ['agent', '--no-leader', '--always-approve', 'stdio'];
const grokBin = process.env['GROK_BIN'] || 'grok';

if (!sockPath) {
  process.stderr.write('acp-hold: --sock required\n');
  process.exit(2);
}

try { fs.unlinkSync(sockPath); } catch { /* ignore */ }

const grok = spawn(grokBin, grokArgv, {
  cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

grok.on('error', (err) => {
  process.stderr.write(`[acp-hold] grok spawn error: ${err.message}\n`);
});
grok.stderr?.on('data', (b: Buffer) => {
  process.stderr.write(b);
});
grok.on('exit', (code, signal) => {
  process.stderr.write(`[acp-hold] grok exit code=${code} signal=${signal}\n`);
  try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
  process.exit(code ?? 1);
});

let client: net.Socket | null = null;
// Keep unanswered agent->client requests while the UI is detached so
// grok-remote can answer them on attach instead of leaving grok blocked.
let partial = '';
const pendingReqs: string[] = [];
const PENDING_MAX = 32;

function takeRequests(buf: Buffer): void {
  partial += buf.toString('utf8');
  let nl: number;
  while ((nl = partial.indexOf('\n')) >= 0) {
    const line = partial.slice(0, nl);
    partial = partial.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { id?: unknown; method?: unknown };
      if (o && o.id != null && typeof o.method === 'string') {
        pendingReqs.push(line + '\n');
        if (pendingReqs.length > PENDING_MAX) pendingReqs.shift();
      }
    } catch { /* ignore non-json */ }
  }
}

function flushPending(sock: net.Socket): void {
  for (const line of pendingReqs) {
    try { sock.write(line); } catch { /* ignore */ }
  }
  pendingReqs.length = 0;
  if (partial) {
    try { sock.write(partial); } catch { /* ignore */ }
    partial = '';
  }
}

grok.stdout?.on('data', (buf: Buffer) => {
  if (client && !client.destroyed && client.writable) {
    try { client.write(buf); return; } catch { /* fall through */ }
  }
  takeRequests(buf);
});

const server = net.createServer((sock) => {
  // Newest UI attach wins. A leftover half-open client after grok-remote
  // restart must not block the next connection (that left stdin unwritable).
  if (client && client !== sock) {
    try { client.destroy(); } catch { /* ignore */ }
  }
  client = sock;
  flushPending(sock);
  sock.on('data', (buf: Buffer) => {
    if (grok.stdin && grok.stdin.writable) grok.stdin.write(buf);
  });
  const clear = () => { if (client === sock) client = null; };
  sock.on('close', clear);
  sock.on('error', clear);
});

server.listen(sockPath, () => {
  try { fs.chmodSync(sockPath, 0o660); } catch { /* ignore */ }
  process.stderr.write(`[acp-hold] listening ${sockPath}\n`);
});

function die(): void {
  try { grok.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => {
    try { grok.kill('SIGKILL'); } catch { /* ignore */ }
    process.exit(0);
  }, 2000).unref();
}
process.on('SIGTERM', die);
process.on('SIGINT', die);

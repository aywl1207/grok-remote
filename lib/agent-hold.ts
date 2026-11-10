// Start / stop a sibling Docker container that holds `grok agent stdio`
// so grok-remote can restart without killing the session.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOLD_PREFIX = 'gr-hold-';
const IMAGE = process.env['GROK_HOLD_IMAGE'] || 'grok-remote:local';

export function holdEnabled(): boolean {
  return process.env['GROK_HOLD'] !== '0';
}

/**
 * Host path bind-mounted into the hold as /usr/local/bin/grok.
 * Follow ~/.grok/bin/grok (current install) — never pin a leftover
 * downloads/grok-<ver>-* file, or holds stay on the old grok after update.
 */
export function grokHoldBindCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  const out: string[] = [];
  const override = env['GROK_HOLD_BIN'];
  if (override) out.push(override);
  out.push(path.join(home, '.grok', 'bin', 'grok'));
  out.push('/usr/local/bin/grok');
  return out;
}

export function grokHoldBindSource(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string | null {
  for (const raw of grokHoldBindCandidates(env, home)) {
    try {
      const resolved = fs.realpathSync(raw);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch { /* missing */ }
  }
  return null;
}

/** Starred conversations and any live hold are re-attached on boot. */
export function shouldAttachOnBoot(rec: { starred?: boolean; archived?: boolean }, held: boolean): boolean {
  if (rec.archived) return false;
  return !!(rec.starred || held);
}

export function holdName(agentId: string): string {
  return HOLD_PREFIX + String(agentId).replace(/[^a-zA-Z0-9_.-]/g, '');
}

export function holdSockPath(agentId: string): string {
  return path.join(os.homedir(), '.grok-remote', 'agents', agentId, 'acp.sock');
}

export function holdReadyPath(agentId: string): string {
  return path.join(os.homedir(), '.grok-remote', 'agents', agentId, 'acp.ready');
}

export function readHoldReady(agentId: string): { sessionId: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(holdReadyPath(agentId), 'utf8')) as { sessionId?: unknown };
    if (typeof raw.sessionId === 'string' && raw.sessionId) return { sessionId: raw.sessionId };
  } catch { /* missing or corrupt */ }
  return null;
}

export function markHoldReady(agentId: string, sessionId: string): void {
  fs.mkdirSync(path.dirname(holdReadyPath(agentId)), { recursive: true });
  fs.writeFileSync(holdReadyPath(agentId), JSON.stringify({ sessionId, at: Date.now() }));
}

export function clearHoldReady(agentId: string): void {
  try { fs.unlinkSync(holdReadyPath(agentId)); } catch { /* ignore */ }
}

/** Handshake only when this hold has never completed initialize. */
export function holdNeedsHandshake(created: boolean, readySessionId: string | null): boolean {
  return created || !readySessionId;
}

/** Never replace a live hold. Missing sock is wait, not recreate. */
export function keepExistingHold(running: boolean, sockExists: boolean): 'attach' | 'wait-sock' | 'create' {
  if (running && sockExists) return 'attach';
  if (running && !sockExists) return 'wait-sock';
  return 'create';
}

export function holdIdsFromDockerNames(names: string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const n = String(raw || '').trim();
    if (n.startsWith('gr-hold-') && n.length > 8) out.push(n.slice('gr-hold-'.length));
  }
  return out;
}

export function listLiveHoldIds(): string[] {
  const r = docker(['ps', '--format', '{{.Names}}', '--filter', 'name=gr-hold-']);
  if (r.status !== 0) return [];
  return holdIdsFromDockerNames((r.stdout || '').split('\n'));
}

function docker(args: string[], timeoutMs = 20000): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function holdRunning(agentId: string): boolean {
  const r = docker(['inspect', '-f', '{{.State.Running}}', holdName(agentId)]);
  return r.status === 0 && r.stdout.trim() === 'true';
}

export async function ensureHold(opts: {
  agentId: string;
  cwd: string;
  argv: string[];
}): Promise<{ sock: string; created: boolean }> {
  const sock = holdSockPath(opts.agentId);
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  const running = holdRunning(opts.agentId);
  let action = keepExistingHold(running, fs.existsSync(sock));
  if (action === 'wait-sock') {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && holdRunning(opts.agentId)) {
      if (fs.existsSync(sock)) { action = 'attach'; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (action === 'wait-sock' && holdRunning(opts.agentId)) {
      throw new Error('hold is running but acp.sock is missing; not replacing it');
    }
  }
  if (action === 'attach' || (holdRunning(opts.agentId) && fs.existsSync(sock))) {
    return { sock, created: false };
  }
  docker(['rm', '-f', holdName(opts.agentId)]);
  try { fs.unlinkSync(sock); } catch { /* ignore */ }
  clearHoldReady(opts.agentId);
  const name = holdName(opts.agentId);
  const grokBin = grokHoldBindSource();
  const run = docker([
    'run', '-d',
    '--name', name,
    '--restart', 'no',
    '--no-healthcheck',
    '--user', '1000:1000',
    '--group-add', '983',
    '-e', 'HOME=/home/opc',
    '-e', `GROK_BIN=${process.env['GROK_BIN'] || '/usr/local/bin/grok'}`,
    '-e', `TZ=${process.env['TZ'] || 'Asia/Hong_Kong'}`,
    '-v', '/home/opc:/home/opc',
    ...(grokBin ? ['-v', `${grokBin}:/usr/local/bin/grok:ro`] : []),
    '-w', '/opt/grok-remote',
    IMAGE,
    'node', '--import', 'tsx', 'lib/acp-hold.ts',
    '--sock', sock,
    '--cwd', opts.cwd,
    '--',
    ...opts.argv,
  ], 30000);
  if (run.status !== 0) {
    throw new Error(`hold start failed: ${run.stderr || run.stdout || run.status}`);
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) return { sock, created: true };
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('hold socket did not appear');
}

export function stopHold(agentId: string): void {
  docker(['rm', '-f', holdName(agentId)]);
  try { fs.unlinkSync(holdSockPath(agentId)); } catch { /* ignore */ }
  clearHoldReady(agentId);
}

/** Resume (`-r`) / `--fork-session` copy the old session context_window. */
export function holdArgsBindOldWindow(args: string[]): boolean {
  for (const a of args) {
    if (a === '-r' || a === '--resume' || a === '--fork-session') return true;
  }
  return false;
}

export function inspectHoldArgs(agentId: string): string[] {
  const r = docker(['inspect', '-f', '{{json .Args}}', holdName(agentId)]);
  if (r.status !== 0) return [];
  try {
    const v = JSON.parse(r.stdout || '[]') as unknown;
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

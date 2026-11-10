// GET /api/bg-terminals and /api/agents/:id/terminals*
// ACP terminalHost + grok bgTasks, merged. Kill must not touch holds.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import type { AgentManager, PublicAgent } from './agent-manager.js';
import { inferDevServerUrl } from './dev-url.js';
import { sendJson } from './http-util.js';

export function bindTerminalHttp(manager: AgentManager) {
  interface MergedTerminal {
    id: string;
    source: 'acp' | 'grok' | 'merged';
    command: string;
    cwd: string;
    exited: boolean;
    exitStatus: { exitCode: number | null; signal: string | NodeJS.Signals | null } | null;
    bytes?: number;
    truncated?: boolean;
    outputFile: string | null;
    startedAt: number | null;
    endedAt: number | null;
    url?: string;
  }

  function handleGlobalBgTerminals(_req2: IncomingMessage, res: ServerResponse): void {
    const out: { agentId: string; agentName: string; terminals: MergedTerminal[] }[] = [];
    let runningTotal = 0;
    for (const rec of manager.list()) {
      const a = manager.getRaw(rec.id);
      const merged = mergeBgSources(a);
      for (const t of merged) if (!t.exited) runningTotal++;
      if (merged.length) {
        out.push({ agentId: rec.id, agentName: rec.name || rec.id, terminals: merged });
      }
    }
    sendJson(res, 200, { ok: true, runningCount: runningTotal, agents: out });
  }

  function mergeBgSources(a: ReturnType<typeof manager.getRaw>): MergedTerminal[] {
    const byId = new Map<string, MergedTerminal>();
    const host = a && a.client && a.client.terminalHost;
    if (host && host._terminals) {
      for (const t of host._terminals.values()) {
        byId.set(t.id, {
          id: t.id,
          source: 'acp',
          command: t.command,
          cwd: t.cwd,
          exited: !!t.exited,
          exitStatus: t.exitStatus || null,
          bytes: t.buffer ? t.buffer.length : 0,
          truncated: !!t.truncated,
          outputFile: null,
          startedAt: null,
          endedAt: null,
        });
      }
    }
    if (a && a.bgTasks && a.bgTasks.size) {
      for (const t of a.bgTasks.values()) {
        const grokStatus = (t.exit_code != null || t.signal)
          ? { exitCode: t.exit_code, signal: t.signal }
          : null;
        const existing = byId.get(t.id);
        if (existing) {
          existing.source = 'merged';
          existing.command = t.command || existing.command;
          existing.cwd = t.cwd || existing.cwd;
          existing.outputFile = t.output_file || existing.outputFile;
          existing.startedAt = t.startedAt || existing.startedAt;
          existing.endedAt = t.endedAt || existing.endedAt;
          if (t.completed && !existing.exited) existing.exited = true;
          if (!existing.exitStatus && grokStatus) existing.exitStatus = grokStatus;
        } else {
          byId.set(t.id, {
            id: t.id,
            source: 'grok',
            command: t.command,
            cwd: t.cwd,
            outputFile: t.output_file || null,
            exited: !!t.completed,
            exitStatus: grokStatus,
            startedAt: t.startedAt,
            endedAt: t.endedAt || null,
          });
        }
      }
    }
    for (const t of byId.values()) {
      if (!t.url) {
        let output = '';
        if (t.source === 'acp' || t.source === 'merged') {
          const acpT = host && host._terminals && host._terminals.get(t.id);
          if (acpT && acpT.buffer) {
            output = acpT.buffer.toString('utf8', 0, Math.min(acpT.buffer.length, 16 * 1024));
          }
        }
        if (!output && t.outputFile) {
          try {
            const buf = readFileTail(t.outputFile, 16 * 1024);
            if (buf) output = buf.toString('utf8');
          } catch { /* ignore */ }
        }
        if (!output && (t.source === 'grok' || t.source === 'merged')) {
          const bg = a && a.bgTasks && a.bgTasks.get(t.id);
          if (bg && typeof bg.cached_output === 'string' && bg.cached_output.length) {
            output = bg.cached_output;
          }
        }
        const url2 = inferDevServerUrl(t.command, output);
        if (url2) t.url = url2;
      }
    }
    return [...byId.values()].sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
  }

  function readFileTail(filePath: string, n: number): Buffer | null {
    try {
      const st = fs.statSync(filePath);
      const size = st.size;
      if (size <= n) return fs.readFileSync(filePath);
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      fs.closeSync(fd);
      return buf;
    } catch { return null; }
  }

  function handleTerminalList(_req2: IncomingMessage, res: ServerResponse, rec: PublicAgent): void {
    const a = manager.getRaw(rec.id);
    sendJson(res, 200, { ok: true, terminals: mergeBgSources(a) });
  }

  function handleTerminalRead(req: IncomingMessage, res: ServerResponse, rec: PublicAgent, tid: string): void {
    const a = manager.getRaw(rec.id);
    const host = a && a.client && a.client.terminalHost;
    const t = host && host._terminals && host._terminals.get(tid);
    if (t) {
      const output = t.buffer ? t.buffer.toString('utf8') : '';
      sendJson(res, 200, {
        ok: true,
        id: t.id,
        source: 'acp',
        command: t.command,
        cwd: t.cwd,
        exited: !!t.exited,
        exitStatus: t.exitStatus || null,
        truncated: !!t.truncated,
        output,
        url: inferDevServerUrl(t.command, output),
      });
      return;
    }
    handleBgTaskRead(req, res, rec, tid);
  }

  function handleBgTaskRead(_req2: IncomingMessage, res: ServerResponse, rec: PublicAgent, tid: string): void {
    const a = manager.getRaw(rec.id);
    const t = a && a.bgTasks && a.bgTasks.get(tid);
    if (!t) { sendJson(res, 404, { ok: false, error: 'bg task not found' }); return; }
    const TAIL_BYTES = 64 * 1024;
    let output = '';
    let truncated = false;
    if (t.output_file) {
      try {
        const st = fs.statSync(t.output_file);
        const size = st.size;
        if (size > TAIL_BYTES) {
          const fd = fs.openSync(t.output_file, 'r');
          const buf = Buffer.alloc(TAIL_BYTES);
          fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
          fs.closeSync(fd);
          output = buf.toString('utf8');
          truncated = true;
        } else {
          output = fs.readFileSync(t.output_file, 'utf8');
        }
      } catch (err) {
        if (typeof t.cached_output === 'string' && t.cached_output.length) {
          output = t.cached_output;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          output = `[grok-remote] failed to read log: ${msg}`;
        }
      }
    } else if (typeof t.cached_output === 'string' && t.cached_output.length) {
      output = t.cached_output;
    }
    sendJson(res, 200, {
      ok: true,
      id: t.id,
      source: 'grok',
      command: t.command,
      cwd: t.cwd,
      outputFile: t.output_file || null,
      startedAt: t.startedAt,
      endedAt: t.endedAt || null,
      exited: !!t.completed,
      exitStatus: (t.exit_code != null || t.signal) ? { exitCode: t.exit_code, signal: t.signal } : null,
      truncated,
      output,
      url: inferDevServerUrl(t.command, output),
    });
  }

  function handleTerminalKill(_req2: IncomingMessage, res: ServerResponse, rec: PublicAgent, tid: string): void {
    const a = manager.getRaw(rec.id);
    const host = a && a.client && a.client.terminalHost;
    const t = host && host._terminals && host._terminals.get(tid);
    if (t) {
      try {
        if (t.proc && !t.exited) t.proc.kill('SIGTERM');
      } catch { /* ignore */ }
      sendJson(res, 200, { ok: true });
      return;
    }
    const bg = a && a.bgTasks && a.bgTasks.get(tid);
    if (!bg) { sendJson(res, 404, { ok: false, error: 'terminal not found' }); return; }
    if (bg.completed) { sendJson(res, 200, { ok: true, alreadyExited: true }); return; }
    const cwd = bg.cwd || '';
    if (!cwd) { sendJson(res, 500, { ok: false, error: 'task has no cwd; cannot derive kill pattern' }); return; }
    try {
      spawnSync('/usr/bin/pkill', ['-TERM', '-f', cwd], { timeout: 4000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, error: `pkill failed: ${msg}` });
      return;
    }
    bg.completed = true;
    bg.signal    = bg.signal || 'killed-by-user';
    bg.endedAt   = Date.now();
    try { manager.emit('list_changed', { event: 'bg_tasks', id: rec.id, count: 0 }); } catch { /* ignore */ }
    sendJson(res, 200, { ok: true, source: 'grok', killed: true });
  }


  return {
    handleGlobalBgTerminals,
    handleTerminalList,
    handleTerminalRead,
    handleBgTaskRead,
    handleTerminalKill,
  };
}

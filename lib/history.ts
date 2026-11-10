// Per-agent append-only JSONL history at ~/.grok-remote/agents/<id>/history.jsonl.
//
// Two compact paths, do not mix them:
//   compactHistoryLines     — disk rewrite (conservative). Used by rewriteCompactHistory.
//   compactHistoryForHttp   — GET /history only. Drops more noise, then collapse + cap.
// GET never writes this file. Session merge lives in transcript.ts.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { collapseHistoryForReplay, capTurnTools, historyEventText, setHistoryEventText, mergeCollapsedStep } from './history-collapse.js';
import { isCompactJournalEvent } from './compact-status.js';
import { payloadSessionId } from './child-session.js';
import { dropResumeRestreamLines } from './attach-replay.js';

const ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

export function agentDir(agentId: string): string {
  return path.join(ROOT, agentId);
}

export function historyPath(agentId: string): string {
  return path.join(agentDir(agentId), 'history.jsonl');
}

export function turnCountPath(agentId: string): string {
  return path.join(agentDir(agentId), 'history.turns.json');
}

export function ensureAgentDirs(agentId: string): string {
  const dir = agentDir(agentId);
  fs.mkdirSync(path.join(dir, 'cwd'), { recursive: true });
  return dir;
}

const HISTORY_DROP = new Set([
  'available_commands_update',
  'x.ai/session_notification',
  'x.ai/queue/changed',
  'x.ai/sessions/changed',
  'x.ai/models/update',
  'prompt_result',
  'stderr',
  'handshake',
  'tool_call_delta_chunk',
  'plan_approval',
  'user_question',
  'interaction_request',
  'error',
  'agent_status',
]);

/** Extra events dropped only on GET /history. Journal append keeps them. */
const HISTORY_HTTP_DROP = new Set([
  ...HISTORY_DROP,
  'x.ai/session/update',
  'x.ai/mcp/servers_updated',
  'x.ai/mcp_initialized',
  'x.ai/announcements/update',
  'session_ready',
  'agent_exited',
  'agent_updated',
  'current_mode_update',
  'user_message_chunk',
  'plan',
]);

function slimStr(v: unknown, n = 500): unknown {
  if (typeof v === 'string' && v.length > n) return v.slice(0, n) + '…';
  return v;
}

export function slimToolData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const rec = data as Record<string, unknown>;
  const nested = rec.update && typeof rec.update === 'object';
  const src = (nested ? rec.update : rec) as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const k of ['sessionUpdate', 'toolCallId', 'id', 'kind', 'title', 'status', 'locations']) {
    if (src[k] != null) keep[k] = src[k];
  }
  const ri = src.rawInput;
  if (ri && typeof ri === 'object') {
    const slim: Record<string, unknown> = {};
    const srcRi = ri as Record<string, unknown>;
    for (const k of [
      'command', 'cmd', 'path', 'file_path', 'url', 'variant', 'merge', 'target_file', 'todos',
      'old_string', 'new_string', 'oldString', 'newString', 'old_str', 'new_str',
      'oldText', 'newText', 'contents', 'content',
    ]) {
      if (srcRi[k] == null) continue;
      const cap = (k === 'command' || k === 'cmd' || k === 'url') ? 500 : 16000;
      slim[k] = slimStr(srcRi[k], cap);
    }
    if (Array.isArray(srcRi.edits)) {
      slim.edits = srcRi.edits.slice(0, 20).map((item) => {
        if (!item || typeof item !== 'object') return item;
        const rec = item as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of ['old_string', 'new_string', 'oldString', 'newString', 'oldText', 'newText']) {
          if (rec[k] != null) out[k] = slimStr(rec[k], 16000);
        }
        return out;
      });
    }
    keep.rawInput = slim;
  }
  const content = src.content;
  if (Array.isArray(content)) {
    const kept: unknown[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const rec = block as Record<string, unknown>;
      if (rec.type !== 'diff') continue;
      kept.push({
        type: 'diff',
        path: rec.path ?? rec.file_path ?? '',
        oldText: slimStr(rec.oldText ?? rec.old_string, 16000),
        newText: slimStr(rec.newText ?? rec.new_string, 16000),
      });
    }
    if (kept.length) keep.content = kept;
  }
  if (nested) {
    const out: Record<string, unknown> = {};
    if (rec.sessionId != null) out.sessionId = rec.sessionId;
    out.update = keep;
    return out;
  }
  return keep;
}

function slimHistoryEvent(event: unknown): unknown | null {
  if (!event || typeof event !== 'object') return event;
  const ev = event as { event?: string; data?: unknown };
  const name = ev.event || '';
  if (HISTORY_DROP.has(name)) return null;
  if (name === 'tool_call' || name === 'tool_call_update') {
    return { ...ev, data: slimToolData(ev.data) };
  }
  return ev;
}


export function append(agentId: string, event: unknown): void {
  try {
    const slim = slimHistoryEvent(event);
    if (slim == null) return;
    ensureAgentDirs(agentId);
    fs.appendFileSync(historyPath(agentId), JSON.stringify(slim) + '\n');
    if (slim && (slim as { event?: string }).event === 'user_message') {
      bumpUserTurnCount(agentId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[history] append failed for ${agentId}: ${msg}\n`);
  }
}

function toolCallIdOf(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const rec = data as Record<string, unknown>;
  const src = (rec.update && typeof rec.update === 'object' ? rec.update : rec) as Record<string, unknown>;
  return String(src.toolCallId || src.id || '');
}

/** Merge consecutive thought/answer chunks and keep one snapshot per tool. */
function mergeHistoryLines(lines: string[], drop: Set<string>): Record<string, unknown>[] {
  const merged: Record<string, unknown>[] = [];
  let textAcc = '';
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    const name = String(ev.event || '');
    if (!name || drop.has(name)) continue;
    if (name === 'tool_call' || name === 'tool_call_update') {
      ev = { ...ev, data: slimToolData(ev.data) };
    }
    const prev = merged.length ? merged[merged.length - 1] : null;
    if (prev && (name === 'agent_thought_chunk' || name === 'agent_message_chunk') && prev.event === name) {
      const have = historyEventText(prev.data);
      const step = mergeCollapsedStep(have, historyEventText(ev.data), textAcc);
      if (step.text !== have) setHistoryEventText(prev, step.text);
      textAcc = step.acc;
      if (ev.eventId) prev.eventId = ev.eventId;
      if (ev.at) prev.at = ev.at;
      continue;
    }
    textAcc = '';
    merged.push(ev);
  }
  const lastTool = new Map<string, number>();
  for (let i = 0; i < merged.length; i++) {
    const ev = merged[i];
    if (!ev) continue;
    const name = String(ev.event || '');
    if (name !== 'tool_call' && name !== 'tool_call_update') continue;
    const tid = toolCallIdOf(ev.data);
    if (!tid) continue;
    lastTool.set(tid, i);
  }
  const dropIdx = new Set<number>();
  for (let i = 0; i < merged.length; i++) {
    const ev = merged[i];
    if (!ev) continue;
    const name = String(ev.event || '');
    if (name !== 'tool_call' && name !== 'tool_call_update') continue;
    const tid = toolCallIdOf(ev.data);
    if (tid && lastTool.get(tid) !== i) dropIdx.add(i);
    else if (name === 'tool_call_update') ev.event = 'tool_call';
  }
  return merged.filter((_, i) => !dropIdx.has(i));
}

export function compactHistoryLines(lines: string[]): string[] {
  return mergeHistoryLines(lines, HISTORY_DROP).map((ev) => JSON.stringify(ev));
}

/** Rewrite the on-disk journal if it has grown into token-by-token chunks. */
export function rewriteCompactHistory(agentId: string): { before: number; after: number } {
  const fp = historyPath(agentId);
  try {
    if (!fs.existsSync(fp)) return { before: 0, after: 0 };
    const raw = fs.readFileSync(fp, 'utf8');
    const before = raw.length;
    const compacted = compactHistoryLines(raw.split('\n').filter(Boolean));
    const next = compacted.length ? compacted.join('\n') + '\n' : '';
    if (next.length >= before) return { before, after: before };
    const inLines = raw.split('\n').filter(Boolean).length;
    if (before > 80_000 && (next.length < before * 0.2 || compacted.length < Math.max(8, inLines * 0.15))) {
      process.stderr.write(`[history] skip compact ${agentId}: ${before} -> ${next.length}\n`);
      return { before, after: before };
    }
    const tmp = fp + '.compact';
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, fp);
    return { before, after: next.length };
  } catch {
    return { before: 0, after: 0 };
  }
}

export function readAll(agentId: string): string {
  try {
    return fs.readFileSync(historyPath(agentId)).toString('utf8');
  } catch {
    return '';
  }
}

interface TurnCountRec {
  size: number;
  mtimeMs: number;
  n: number;
  offsets?: number[];
}

const userTurnCountCache = new Map<string, TurnCountRec>();

function rememberTurnCount(agentId: string, rec: TurnCountRec): void {
  userTurnCountCache.set(historyPath(agentId), rec);
  try { fs.writeFileSync(turnCountPath(agentId), JSON.stringify(rec)); } catch { /* ignore */ }
}

function readSidecarCount(agentId: string): TurnCountRec | null {
  try {
    const rec = JSON.parse(fs.readFileSync(turnCountPath(agentId), 'utf8')) as {
      size?: number; n?: number; mtimeMs?: number; offsets?: number[];
    };
    if (typeof rec.size !== 'number' || typeof rec.n !== 'number') return null;
    const offsets = Array.isArray(rec.offsets)
      ? rec.offsets.filter((n) => typeof n === 'number')
      : undefined;
    return {
      size: rec.size,
      mtimeMs: typeof rec.mtimeMs === 'number' ? rec.mtimeMs : 0,
      n: rec.n,
      ...(offsets && offsets.length ? { offsets } : {}),
    };
  } catch { /* missing */ }
  return null;
}

/** Count user_message events in [start, end) and their byte offsets. */
export function scanUserMessagesInRange(fp: string, start: number, end: number): { count: number; offsets: number[] } {
  if (end <= start) return { count: 0, offsets: [] };
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(Math.min(256 * 1024, Math.max(1, end - start)));
  const offsets: number[] = [];
  let leftover = Buffer.alloc(0);
  let leftoverStart = start;
  let pos = start;
  try {
    while (pos < end) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - pos), pos);
      if (n <= 0) break;
      const chunk = leftover.length ? Buffer.concat([leftover, buf.subarray(0, n)]) : buf.subarray(0, n);
      let from = 0;
      while (from < chunk.length) {
        const nl = chunk.indexOf(0x0a, from);
        if (nl < 0) break;
        const lineBuf = chunk.subarray(from, nl);
        if (lineBuf.indexOf('"user_message"') !== -1) {
          const line = lineBuf.toString('utf8');
          try {
            if ((JSON.parse(line) as { event?: string }).event === 'user_message') {
              offsets.push(leftoverStart + from);
            }
          } catch { /* skip */ }
        }
        from = nl + 1;
      }
      leftover = chunk.subarray(from);
      leftoverStart += from;
      pos += n;
    }
    if (leftover.length && leftover.indexOf('"user_message"') !== -1) {
      const line = leftover.toString('utf8');
      try {
        if ((JSON.parse(line) as { event?: string }).event === 'user_message') {
          offsets.push(leftoverStart);
        }
      } catch { /* skip */ }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { count: offsets.length, offsets };
}

/** Count user_message events in [start, end). start is a previous EOF. */
export function countUserMessagesInRange(fp: string, start: number, end: number): number {
  return scanUserMessagesInRange(fp, start, end).count;
}

function bumpUserTurnCount(agentId: string): void {
  try {
    const fp = historyPath(agentId);
    const st = fs.statSync(fp);
    const prev = userTurnCountCache.get(fp) || readSidecarCount(agentId);
    if (!prev) return;
    const extra = prev.size < st.size ? scanUserMessagesInRange(fp, prev.size, st.size) : { count: 0, offsets: [] };
    const offsets = (prev.offsets && prev.offsets.length === prev.n)
      ? prev.offsets.concat(extra.offsets)
      : undefined;
    rememberTurnCount(agentId, {
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      n: prev.n + extra.count,
      ...(offsets ? { offsets } : {}),
    });
  } catch { /* next count will scan */ }
}

/** Count user_message lines. Cached by file size (memory + sidecar). */
export function countUserTurns(agentId: string): number {
  const fp = historyPath(agentId);
  let st: fs.Stats;
  try { st = fs.statSync(fp); } catch { return 0; }
  if (st.size === 0) return 0;
  const mtimeMs = Math.round(st.mtimeMs);
  const prev = userTurnCountCache.get(fp) || readSidecarCount(agentId);
  if (prev && prev.size === st.size) {
    userTurnCountCache.set(fp, { ...prev, mtimeMs });
    return prev.n;
  }
  if (prev && prev.size < st.size) {
    const extra = scanUserMessagesInRange(fp, prev.size, st.size);
    const n = prev.n + extra.count;
    const offsets = (prev.offsets && prev.offsets.length === prev.n)
      ? prev.offsets.concat(extra.offsets)
      : undefined;
    rememberTurnCount(agentId, { size: st.size, mtimeMs, n, ...(offsets ? { offsets } : {}) });
    return n;
  }
  const scanned = scanUserMessagesInRange(fp, 0, st.size);
  rememberTurnCount(agentId, { size: st.size, mtimeMs, n: scanned.count, offsets: scanned.offsets });
  return scanned.count;
}

function readFileRange(fp: string, start: number, end: number): string {
  if (end <= start) return '';
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, end - start, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Drop the newest `drop` user turns from a tail slice. */
export function dropNewestUserTurns(raw: string, drop: number): string {
  if (drop <= 0) return raw;
  const lines = String(raw || '').split('\n').filter(Boolean);
  const userIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    if (line.indexOf('"user_message"') === -1) continue;
    try {
      if ((JSON.parse(line) as { event?: string }).event === 'user_message') userIdx.push(i);
    } catch { /* skip */ }
  }
  if (userIdx.length <= drop) return '';
  const cut = userIdx[userIdx.length - drop]!;
  return lines.slice(0, cut).join('\n') + (cut > 0 ? '\n' : '');
}

function ensureTurnOffsets(agentId: string): number[] | null {
  const fp = historyPath(agentId);
  let st: fs.Stats;
  try { st = fs.statSync(fp); } catch { return null; }
  if (st.size === 0) return [];
  const mtimeMs = Math.round(st.mtimeMs);
  const prev = userTurnCountCache.get(fp) || readSidecarCount(agentId);
  if (prev && prev.size === st.size && prev.offsets && prev.offsets.length === prev.n) {
    return prev.offsets;
  }
  if (prev && prev.size < st.size && prev.offsets && prev.offsets.length === prev.n) {
    const extra = scanUserMessagesInRange(fp, prev.size, st.size);
    const offsets = prev.offsets.concat(extra.offsets);
    rememberTurnCount(agentId, { size: st.size, mtimeMs, n: prev.n + extra.count, offsets });
    return offsets;
  }
  const scanned = scanUserMessagesInRange(fp, 0, st.size);
  rememberTurnCount(agentId, { size: st.size, mtimeMs, n: scanned.count, offsets: scanned.offsets });
  return scanned.offsets;
}

/** `turns` user turns ending `skipNewest` turns before EOF. */
export function readUserTurnsWindow(agentId: string, turns: number, skipNewest: number): string {
  const keep = Math.max(0, turns);
  const skip = Math.max(0, skipNewest);
  if (keep <= 0) return '';
  const fp = historyPath(agentId);
  let st: fs.Stats;
  try { st = fs.statSync(fp); } catch { return ''; }
  const offsets = ensureTurnOffsets(agentId);
  if (offsets && offsets.length) {
    const endIdx = offsets.length - skip;
    const startIdx = Math.max(0, endIdx - keep);
    if (startIdx >= endIdx) return '';
    const startOff = offsets[startIdx]!;
    const endOff = skip === 0 ? st.size : offsets[endIdx]!;
    return readFileRange(fp, startOff, endOff);
  }
  return dropNewestUserTurns(readLastUserTurns(agentId, keep + skip), skip);
}

export function truncateAfterUserTurns(agentId: string, keepTurns: number): { kept: number; dropped: number } {
  const raw = readAll(agentId);
  if (!raw) return { kept: 0, dropped: 0 };
  const lines = raw.split('\n').filter(Boolean);
  let seen = 0;
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    if (line.indexOf('"user_message"') === -1) continue;
    try {
      const obj = JSON.parse(line) as { event?: string };
      if (obj && obj.event === 'user_message') {
        seen += 1;
        if (seen === keepTurns + 1) { cut = i; break; }
      }
    } catch { /* skip */ }
  }
  const keptLines = lines.slice(0, cut);
  fs.writeFileSync(historyPath(agentId), keptLines.length ? keptLines.join('\n') + '\n' : '');
  return { kept: keptLines.length, dropped: lines.length - keptLines.length };
}


function toolIdOf(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const rec = data as Record<string, unknown>;
  const src = (rec.update && typeof rec.update === 'object' ? rec.update : rec) as Record<string, unknown>;
  return String(src.toolCallId || src.id || '');
}

function toolStatusOf(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const rec = data as Record<string, unknown>;
  const src = (rec.update && typeof rec.update === 'object' ? rec.update : rec) as Record<string, unknown>;
  const meta = rec._meta && typeof rec._meta === 'object'
    ? (rec._meta as { updateParams?: { status?: unknown } }).updateParams
    : undefined;
  return String(src.status || (meta && meta.status) || '').toLowerCase();
}

const TERMINAL_TOOL = new Set(['completed', 'success', 'succeeded', 'failed', 'error', 'errored', 'canceled', 'cancelled']);

/** Stamp a later no-status snapshot with the last terminal status for that tool. */
export function fillMissingToolStatus(events: Array<Record<string, unknown>>): void {
  const lastTerm = new Map<string, string>();
  for (const ev of events) {
    const name = String(ev.event || '');
    if (name !== 'tool_call' && name !== 'tool_call_update') continue;
    const tid = toolIdOf(ev.data);
    const st = toolStatusOf(ev.data);
    if (tid && TERMINAL_TOOL.has(st)) lastTerm.set(tid, st);
  }
  for (const ev of events) {
    const name = String(ev.event || '');
    if (name !== 'tool_call' && name !== 'tool_call_update') continue;
    const tid = toolIdOf(ev.data);
    if (!tid || toolStatusOf(ev.data)) continue;
    const st = lastTerm.get(tid);
    if (!st) continue;
    const data = (ev.data && typeof ev.data === 'object') ? { ...(ev.data as Record<string, unknown>) } : {};
    if (data.update && typeof data.update === 'object') {
      ev.data = { ...data, update: { ...(data.update as Record<string, unknown>), status: st } };
    } else {
      ev.data = { ...data, status: st };
    }
  }
}


export function readLastUserTurns(agentId: string, turns: number): string {
  const fp = historyPath(agentId);
  let st: fs.Stats;
  try { st = fs.statSync(fp); } catch { return ''; }
  if (st.size === 0 || turns <= 0) return '';
  const fd = fs.openSync(fp, 'r');
  const chunk = 512 * 1024;
  let pos = st.size;
  let buf = '';
  try {
    while (pos > 0) {
      const size = Math.min(chunk, pos);
      pos -= size;
      const block = Buffer.alloc(size);
      fs.readSync(fd, block, 0, size, pos);
      buf = block.toString('utf8') + buf;
      const start = pos === 0 ? 0 : buf.indexOf('\n') + 1;
      const slice = buf.slice(start);
      const userIdx: number[] = [];
      let offset = 0;
      for (const line of slice.split('\n')) {
        if (line && line.indexOf('"user_message"') !== -1) {
          try {
            const o = JSON.parse(line) as { event?: string };
            if (o.event === 'user_message') userIdx.push(offset);
          } catch { /* skip */ }
        }
        offset += line.length + 1;
      }
      if (userIdx.length >= turns || pos === 0) {
        // Always start at a user_message. cut=0 kept the previous turn's
        // thought/reply tail and that painted as a second latest Grok bubble.
        const cut = userIdx.length >= turns
          ? userIdx[userIdx.length - turns]!
          : (userIdx[0] ?? 0);
        return slice.slice(cut);
      }
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}


export { collapseHistoryForReplay, capTurnTools } from './history-collapse.js';


export function compactHistoryForHttp(
  lines: string[],
  opts?: { dropSessionIds?: Set<string> },
): string[] {
  lines = dropResumeRestreamLines(lines);
  const drop = new Set(HISTORY_HTTP_DROP);
  drop.delete('x.ai/session/update');
  const dropSids = opts && opts.dropSessionIds;
  const kept = mergeHistoryLines(lines, drop).filter((ev) => {
    const name = String(ev.event || '');
    if (dropSids && dropSids.size) {
      const sid = payloadSessionId(ev.data) || payloadSessionId(ev);
      if (sid && dropSids.has(sid)) return false;
    }
    if (name !== 'x.ai/session/update') return true;
    return isCompactJournalEvent(name, ev.data);
  });
  fillMissingToolStatus(kept);
  const collapsed = collapseHistoryForReplay(kept);
  let lastUser = -1;
  for (let i = 0; i < collapsed.length; i++) {
    if (collapsed[i] && collapsed[i].event === 'user_message') lastUser = i;
  }
  const CAP = 16000;
  for (let i = 0; i < collapsed.length; i++) {
    const ev = collapsed[i];
    if (!ev) continue;
    const name = String(ev.event || '');
    if (name !== 'agent_thought_chunk' && name !== 'agent_message_chunk') continue;
    const cap = i >= lastUser ? 24000 : CAP;
    const text = historyEventText(ev.data);
    if (text.length > cap) setHistoryEventText(ev, text.slice(0, cap));
  }
  return collapsed.map((ev) => JSON.stringify(ev));
}

function maxLiveEventIdOf(a: string, b: string): string {
  const pa = /^(\d+)-(\d+)$/.exec(a);
  const pb = /^(\d+)-(\d+)$/.exec(b);
  if (!pa) return pb ? b : (a || b);
  if (!pb) return a;
  const ta = Number(pa[1]);
  const tb = Number(pb[1]);
  if (ta !== tb) return ta > tb ? a : b;
  return Number(pa[2]) >= Number(pb[2]) ? a : b;
}

/** Newest `${Date.now()}-seq` id in raw journal lines (before collapse). */
export function maxLiveEventIdInLines(lines: string[]): string {
  let last = '';
  const re = /"eventId"\s*:\s*"(\d{10,}-\d+)"/g;
  for (const line of lines) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) last = maxLiveEventIdOf(last, m[1]!);
  }
  return last;
}

export interface SliceHistoryOptions { all: boolean; turns: number; dropSessionIds?: Set<string> }
export interface SliceHistoryResult {
  text: string;
  totalTurns: number;
  returnedTurns: number;
  lastEventId: string;
}

export function sliceHistoryByTurns(raw: string, { all, turns, dropSessionIds }: SliceHistoryOptions): SliceHistoryResult {
  if (!raw) return { text: '', totalTurns: 0, returnedTurns: 0, lastEventId: '' };
  const lines = raw.split('\n').filter(Boolean);
  const userMessageIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    if (line.indexOf('"user_message"') === -1) continue;
    try {
      const obj = JSON.parse(line) as { event?: string };
      if (obj && obj.event === 'user_message') userMessageIndices.push(i);
    } catch { /* skip malformed */ }
  }
  const totalTurns = userMessageIndices.length;
  let sliced = lines;
  let returnedTurns = totalTurns;
  if (!all && totalTurns > turns) {
    const cutoffLineIdx = userMessageIndices[totalTurns - turns];
    if (cutoffLineIdx != null) {
      sliced = lines.slice(cutoffLineIdx);
      returnedTurns = turns;
    }
  } else if (!all && userMessageIndices.length && userMessageIndices[0]! > 0) {
    sliced = lines.slice(userMessageIndices[0]);
  }
  const lastEventId = maxLiveEventIdInLines(sliced);
  const compacted = compactHistoryForHttp(sliced, { dropSessionIds });
  return {
    text: compacted.join('\n') + (compacted.length ? '\n' : ''),
    totalTurns,
    returnedTurns,
    lastEventId,
  };
}


export function historyWantsAll(allReq: boolean, journalTurns: number, turns: number): boolean {
  if (allReq) return true;
  if (journalTurns <= 0) return true;
  return journalTurns <= Math.max(8, turns);
}

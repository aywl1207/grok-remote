// Last known context occupancy for the sidebar token chip.

import fs from 'node:fs';
import { MAX_CONTEXT_OCCUPANCY } from './compact-status.js';

export function tokenFromMeta(meta: unknown): number {
  if (!meta || typeof meta !== 'object') return 0;
  const rec = meta as { totalTokens?: unknown; total_tokens?: unknown };
  const tt = rec.totalTokens ?? rec.total_tokens;
  if (typeof tt !== 'number' || !Number.isFinite(tt) || tt < 0) return 0;
  if (tt > MAX_CONTEXT_OCCUPANCY) return 0;
  return tt;
}

export function occupancyFromEventData(
  data: unknown,
  parentSessionId?: string,
): number | null {
  if (!data || typeof data !== 'object') return null;
  const rec = data as { _meta?: Record<string, unknown>; sessionId?: unknown };
  const meta = rec._meta;
  if (!meta || meta['isReplay'] === true) return null;
  const sid = typeof rec.sessionId === 'string' ? rec.sessionId : '';
  if (parentSessionId && sid && sid !== parentSessionId) return null;
  const n = tokenFromMeta(meta);
  if (n > 0) return n;
  return null;
}

/** Walk parsed events and keep the last parent occupancy (skip replay/child). */
export function lastOccupancyFromEvents(
  events: Array<{ event?: unknown; data?: unknown }>,
  parentSessionId?: string,
): number {
  let last = 0;
  let parent = parentSessionId || '';
  for (const ev of events) {
    const data = ev && ev.data;
    if (String(ev && ev.event || '') === 'session_ready' && data && typeof data === 'object') {
      const sid = (data as { sessionId?: unknown }).sessionId;
      if (typeof sid === 'string' && sid) parent = sid;
    }
    const n = occupancyFromEventData(data, parent || undefined);
    if (typeof n === 'number') last = n;
  }
  return last;
}

/** Walk JSONL text and keep the last parent occupancy (skip replay/child). */
export function scanLastTotalTokens(raw: string, parentSessionId?: string): number {
  const events: Array<{ event?: unknown; data?: unknown }> = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    if (line.indexOf('totalToken') < 0 && line.indexOf('total_tokens') < 0
        && line.indexOf('session_ready') < 0) continue;
    try { events.push(JSON.parse(line) as { event?: unknown; data?: unknown }); }
    catch { /* ignore */ }
  }
  return lastOccupancyFromEvents(events, parentSessionId);
}

export function readLastTotalTokens(historyFile: string, tailBytes = 1_500_000): number {
  try {
    const st = fs.statSync(historyFile);
    const start = st.size > tailBytes ? st.size - tailBytes : 0;
    const fd = fs.openSync(historyFile, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
      }
      return scanLastTotalTokens(text);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

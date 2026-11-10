// Parent vs child (subagent) session id on ACP / SSE / journal envelopes.

import fs from 'node:fs';
import path from 'node:path';

import { grokHome, readTuiSummaryFile, tuiSessionsRoot } from './tui-sessions.js';

export function payloadSessionId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const rec = payload as Record<string, unknown>;
  if (typeof rec['sessionId'] === 'string' && rec['sessionId'].trim()) {
    return rec['sessionId'].trim();
  }
  const data = rec['data'];
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (typeof d['sessionId'] === 'string' && d['sessionId'].trim()) {
      return d['sessionId'].trim();
    }
    const nested = payloadSessionIdFromFields(d);
    if (nested) return nested;
  }
  const nested = payloadSessionIdFromFields(rec);
  if (nested) return nested;
  return sessionIdFromEventId(rec['eventId']);
}

function payloadSessionIdFromFields(rec: Record<string, unknown>): string {
  const params = rec['params'];
  if (params && typeof params === 'object') {
    const sid = (params as Record<string, unknown>)['sessionId'];
    if (typeof sid === 'string' && sid.trim()) return sid.trim();
  }
  const update = rec['update'];
  if (update && typeof update === 'object') {
    const sid = (update as Record<string, unknown>)['sessionId'];
    if (typeof sid === 'string' && sid.trim()) return sid.trim();
  }
  const meta = rec['_meta'];
  if (meta && typeof meta === 'object') {
    const m = meta as Record<string, unknown>;
    if (typeof m['sessionId'] === 'string' && m['sessionId'].trim()) return m['sessionId'].trim();
    const fromEid = sessionIdFromEventId(m['eventId']);
    if (fromEid) return fromEid;
  }
  return '';
}

/** Grok child chunks prefix eventId with the child session ULID/UUID. */
export function sessionIdFromEventId(eid: unknown): string {
  if (typeof eid !== 'string' || !eid) return '';
  const m = eid.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?$/i);
  return m && m[1] ? m[1] : '';
}

export function parentSessionIds(opts: {
  parentSessionId?: string | null;
  lastSessionId?: string | null;
  knownParentIds?: string[];
}): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  add(opts.parentSessionId);
  add(opts.lastSessionId);
  for (const id of opts.knownParentIds || []) add(id);
  return out;
}

/** Live ACP: this chunk is not the hold's current session (subagent or leftover). */
export function isForeignSessionId(
  sid: string,
  ...parentIds: Array<string | null | undefined>
): boolean {
  if (!sid) return false;
  const parents = parentIds.map((s) => String(s || '').trim()).filter(Boolean);
  if (!parents.length) return false;
  return !parents.includes(sid);
}

/**
 * Hide subagent chunks from the parent You/Grok timeline.
 * Do NOT treat every other session id as a child: rebound / resumed
 * chats keep older parent session ids in the journal. Those must paint.
 */
export function isChildSessionPayload(opts: {
  payload: unknown;
  parentSessionId?: string | null;
  lastSessionId?: string | null;
  knownChildIds?: string[];
  knownParentIds?: string[];
  fromHistory?: boolean;
  /** Ignored. Live foreign sids are children even after spawn completes. */
  subagentRunning?: boolean;
}): boolean {
  const sid = payloadSessionId(opts.payload);
  if (!sid) return false;
  const parents = parentSessionIds(opts);
  if (parents.includes(sid)) return false;
  const kids = opts.knownChildIds || [];
  if (kids.includes(sid)) return true;
  // History: unknown ids are older parent sessions of this chat.
  if (opts.fromHistory) return false;
  // Live: spawn_subagent returns (and its card untracks) before the child
  // streams. Any other session id on this ACP socket is the subagent.
  if (parents.length) return true;
  return false;
}

/** TUI folders with session_kind === "subagent". Not older parent session ids. */
export function listSubagentSessionIds(home = grokHome()): string[] {
  const base = tuiSessionsRoot(home);
  const ids: string[] = [];
  const seen = new Set<string>();
  let groups: string[] = [];
  try { groups = fs.readdirSync(base); } catch { return []; }
  for (const g of groups) {
    if (g.startsWith('.') || g.endsWith('.sqlite')) continue;
    const groupDir = path.join(base, g);
    let names: string[] = [];
    try {
      if (!fs.statSync(groupDir).isDirectory()) continue;
      names = fs.readdirSync(groupDir);
    } catch { continue; }
    for (const id of names) {
      const sum = path.join(groupDir, id, 'summary.json');
      if (!fs.existsSync(sum)) continue;
      const rec = readTuiSummaryFile(sum);
      if (!rec || rec.kind !== 'subagent') continue;
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      ids.push(rec.id);
    }
  }
  return ids;
}

/** Drop journal/SSE lines whose sessionId is a TUI subagent. Keep old parent sids. */
export function dropSubagentHistoryLines(raw: string, childIds: Iterable<string>): string {
  const drop = childIds instanceof Set ? childIds : new Set(
    [...childIds].map((s) => String(s || '').trim()).filter(Boolean),
  );
  if (!drop.size) return raw;
  const out: string[] = [];
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let sid = '';
    try {
      sid = payloadSessionId(JSON.parse(line));
    } catch { /* keep corrupt */ }
    if (sid && drop.has(sid)) continue;
    out.push(line);
  }
  return out.length ? out.join('\n') + '\n' : '';
}

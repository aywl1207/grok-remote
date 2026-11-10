// Build the history the UI replays.
// Journal is the long conversation. Session fills gaps:
//   • users the journal never saw (CLI / leftover after compact)
//   • assistant/thought text when a journal user has no reply

import fs from 'node:fs';
import path from 'node:path';

import {
  grokHome,
  listAllTuiSessions,
  listSessionHistoryFiles,
  pickCanonicalTuiSession,
} from './tui-sessions.js';

export function isSyntheticUserText(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.startsWith('<system-reminder>') || s.startsWith('<user_info>') || s.startsWith('<available_skills>')) return true;
  if (/^This session is being continued from a previous conversation/i.test(s)) return true;
  if (/^The user wants to revise the plan\b/i.test(s)) return true;
  if (/^Your task is to produce a faithful, concise summary\b/i.test(s)) return true;
  if (s.startsWith('<') && s.indexOf('<user_query>') < 0) return true;
  return false;
}

export function extractUserQuery(text: string): string {
  const m = String(text || '').match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m && m[1]) return m[1].trim();
  const s = String(text || '').trim();
  if (isSyntheticUserText(s)) return '';
  return s;
}

/** Grok auto-compact continuation blob. Empty if this is not a compact notice. */
export function extractCompactionSummary(text: string): string {
  const s = String(text || '').trim();
  if (!/^This session is being continued from a previous conversation/i.test(s)) return '';
  let body = s;
  const cut = body.search(/Full verbatim rollouts of previous segments|Do NOT modify these files\./i);
  if (cut > 0) body = body.slice(0, cut).trim();
  if (body.length > 8000) body = body.slice(0, 8000) + '\n…';
  return body;
}

export function normUserText(text: string): string {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string')
      ? (x as { text: string }).text : '').join('\n');
  }
  return '';
}

export function sessionDir(cwd?: string | null, sessionId?: string | null): string | null {
  if (!cwd || !sessionId) return null;
  return path.join(grokHome(), 'sessions', encodeURIComponent(cwd), sessionId);
}

/** Combine TUI journals (imported leftovers first, live last). Keep the first copy of each user turn. */
export function concatSessionEvents(parts: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const events of parts) {
    if (!events.length) continue;
    const turns = groupUserTurns(events);
    if (!turns.length) {
      out.push(...events);
      continue;
    }
    for (const st of turns) {
      if (!st.user.startsWith('__compact__:') && seen.has(st.user)) continue;
      seen.add(st.user);
      out.push(...st.lines);
    }
  }
  return out;
}

export function sessionChatPath(cwd?: string | null, sessionId?: string | null): string | null {
  const dir = sessionDir(cwd, sessionId);
  return dir ? path.join(dir, 'chat_history.jsonl') : null;
}

function userTextOf(line: string): string {
  try {
    const o = JSON.parse(line) as { event?: string; data?: { text?: string } };
    if (o.event === 'user_message' && o.data && o.data.text) return normUserText(o.data.text);
  } catch { /* skip */ }
  return '';
}

function eventNameOfLine(line: string): string {
  try {
    return String((JSON.parse(line) as { event?: string }).event || '');
  } catch {
    return '';
  }
}

export function turnHasAssistant(events: string[], userIndex: number): boolean {
  for (let i = userIndex + 1; i < events.length; i++) {
    const ev = eventNameOfLine(events[i] || '');
    if (ev === 'user_message' || ev === 'session_summary_generated') break;
    if (ev === 'agent_message_chunk') return true;
  }
  return false;
}

export function sessionLinesToEvents(raw: string): string[] {
  const out: string[] = [];
  if (!raw) return out;
  let n = 0;
  let sessionTurnOpen = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    const typ = String(row.type || '');
    n += 1;
    const at = '';
    const id = `sess-${n}`;
    if (typ === 'user') {
      if (sessionTurnOpen) {
        out.push(JSON.stringify({
          eventId: `sess-complete-${n}`, at, event: 'prompt_complete',
          data: { stopReason: 'end_turn' },
        }));
        sessionTurnOpen = false;
      }
      const text = contentToText(row.content);
      const compact = extractCompactionSummary(text);
      if (compact) {
        out.push(JSON.stringify({
          eventId: id, at, event: 'session_summary_generated',
          data: { summary: compact, text: compact },
        }));
        continue;
      }
      if (row.synthetic_reason && text.indexOf('<user_query>') < 0) continue;
      const q = extractUserQuery(text);
      if (!q || isSyntheticUserText(q)) continue;
      out.push(JSON.stringify({ eventId: id, at, event: 'user_message', data: { text: q } }));
      sessionTurnOpen = true;
    } else if (typ === 'reasoning') {
      const summary = row.summary;
      let text = '';
      if (Array.isArray(summary)) {
        text = summary.map((x) => (x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string')
          ? (x as { text: string }).text : '').join('\n');
      } else {
        text = contentToText(summary);
      }
      if (text) {
        out.push(JSON.stringify({
          eventId: id, at, event: 'agent_thought_chunk',
          data: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } },
        }));
      }
    } else if (typ === 'assistant') {
      const text = contentToText(row.content);
      if (text) {
        out.push(JSON.stringify({
          eventId: id, at, event: 'agent_message_chunk',
          data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
        }));
      }
    }
  }
  if (sessionTurnOpen) {
    out.push(JSON.stringify({
      eventId: `sess-complete-end`, at: '', event: 'prompt_complete',
      data: { stopReason: 'end_turn' },
    }));
  }
  return out;
}

export interface SessTurn {
  user: string;
  lines: string[];
}

export function groupUserTurns(eventLines: string[]): SessTurn[] {
  const turns: SessTurn[] = [];
  let cur: SessTurn | null = null;
  for (const line of eventLines) {
    const user = userTextOf(line);
    if (user) {
      cur = { user, lines: [line] };
      turns.push(cur);
      continue;
    }
    try {
      const o = JSON.parse(line) as { event?: string; eventId?: string };
      if (o.event === 'session_summary_generated') {
        cur = { user: `__compact__:${o.eventId || String(turns.length)}`, lines: [line] };
        turns.push(cur);
        continue;
      }
    } catch { /* not json */ }
    if (cur) cur.lines.push(line);
  }
  return turns;
}

function sessNonUserLines(st: SessTurn): string[] {
  return st.lines.filter((line) => !userTextOf(line) && eventNameOfLine(line) !== 'session_summary_generated');
}

function sessHasAssistant(st: SessTurn): boolean {
  return st.lines.some((line) => eventNameOfLine(line) === 'agent_message_chunk');
}

function assistantChunkText(line: string): string {
  try {
    const o = JSON.parse(line) as { data?: { update?: { content?: { text?: string } }; text?: string } };
    return o.data?.update?.content?.text || o.data?.text || '';
  } catch {
    return '';
  }
}

function assistantTextOf(lines: string[]): string {
  let n = '';
  for (const line of lines) {
    if (eventNameOfLine(line) !== 'agent_message_chunk') continue;
    n += assistantChunkText(line);
  }
  return n.trim().replace(/\s+/g, ' ');
}

function lastTurnAssistantText(eventLines: string[]): string {
  const turns = groupUserTurns(eventLines);
  if (!turns.length) return assistantTextOf(eventLines);
  return assistantTextOf(turns[turns.length - 1]!.lines);
}

function assistantTextLen(lines: string[]): number {
  return assistantTextOf(lines).length;
}

/** Leftover compact/TUI snapshot after the last overlapping user — not a live tail. */
function extraLooksLikeTuiSnapshot(extra: SessTurn[]): boolean {
  if (extra.length > 8) return true;
  let compact = 0;
  let assistantOnly = 0;
  for (const st of extra) {
    if (st.user.startsWith('__compact__:')) {
      compact += 1;
      continue;
    }
    const hasUser = st.lines.some((line) => !!userTextOf(line));
    if (!hasUser && sessHasAssistant(st)) assistantOnly += 1;
  }
  if (compact > 0) return true;
  if (assistantOnly >= 2) return true;
  return false;
}

/**
 * Journal is the spine. Session inserts users the journal never saw
 * (CLI-only / leftover after Grok compacted chat_history.jsonl).
 * When a journal user has no assistant block, session thought/reply
 * for that same user is spliced after the journal user line.
 */
export function mergeEventLines(
  remoteEvents: string[],
  sessEvents: string[],
  opts?: { journalTurnCount?: number; skipCompaction?: boolean },
): string[] {
  if (!sessEvents.length) return remoteEvents.slice();
  if (!remoteEvents.length) return sessEvents.slice();

  const remoteUsers = new Set<string>();
  const journalPos = new Map<string, number>();
  for (let i = 0; i < remoteEvents.length; i++) {
    const user = userTextOf(remoteEvents[i] || '');
    if (!user) continue;
    remoteUsers.add(user);
    journalPos.set(user, i);
  }

  const sessTurns = groupUserTurns(sessEvents);
  const remoteUserCount = remoteUsers.size;
  let sessUserCount = 0;
  for (const st of sessTurns) {
    if (st.user && !st.user.startsWith('__compact__:')) sessUserCount += 1;
  }
  // Journal still has the long conversation. Grok compact only rewrote
  // chat_history.jsonl — do not paint a "Context Compacted" card.
  const journalCount = typeof opts?.journalTurnCount === 'number' && opts.journalTurnCount > 0
    ? opts.journalTurnCount
    : remoteUserCount;
  const journalHasFullHistory = journalCount > sessUserCount;
  let journalHasCompact = false;
  for (const line of remoteEvents) {
    if (line.indexOf('"session_summary_generated"') !== -1) {
      try {
        if ((JSON.parse(line) as { event?: string }).event === 'session_summary_generated') {
          journalHasCompact = true;
          break;
        }
      } catch { /* skip */ }
    }
  }
  const skipCompact = journalHasFullHistory || journalHasCompact;

  const insertBefore = new Map<number, SessTurn[]>();
  const fillAfter = new Map<number, string[]>();
  const appendAtEnd: SessTurn[] = [];
  let pending: SessTurn[] = [];
  for (const st of sessTurns) {
    if (skipCompact && st.user.startsWith('__compact__:')) continue;
    if (remoteUsers.has(st.user)) {
      const ji = journalPos.get(st.user);
      // A first-load tail is not the full journal. Do not splice older
      // TUI leftovers in front of the last few grok-remote turns.
      const remoteIsTail = journalCount > remoteUserCount;
      if (pending.length && ji != null && !remoteIsTail) {
        const list = insertBefore.get(ji) || [];
        list.push(...pending);
        insertBefore.set(ji, list);
        pending = [];
      } else if (remoteIsTail) {
        pending = [];
      }
      if (ji != null && !turnHasAssistant(remoteEvents, ji) && sessHasAssistant(st)) {
        const next = sessNonUserLines(st);
        const prev = fillAfter.get(ji);
        if (!prev || assistantTextLen(next) >= assistantTextLen(prev)) {
          fillAfter.set(ji, next);
        }
      }
      continue;
    }
    pending.push(st);
  }
  // Journal is the spine. A session-only tail turn (often stamped
  // with Date.now()) would look like a live Running prompt the user
  // never sent in grok-remote.
  if (pending.length && !remoteUserCount) appendAtEnd.push(...pending);

  const out: string[] = [];
  for (let i = 0; i < remoteEvents.length; i++) {
    const extra = insertBefore.get(i);
    if (extra) {
      for (const st of extra) out.push(...st.lines);
    }
    out.push(remoteEvents[i]!);
    const filled = fillAfter.get(i);
    if (filled && filled.length) out.push(...filled);
  }
  for (const st of appendAtEnd) out.push(...st.lines);
  return out;
}

/**
 * After reconnect, Grok's TUI journal often has newer turns the grok-remote
 * history.jsonl never recorded (hold kept running, ACP missed user_message).
 * Append those after the last overlapping journal user. Do not prepend older
 * leftover TUI copies into a first-load tail.
 */
export function appendNewerSessionTurns(remoteEvents: string[], sessEvents: string[]): string[] {
  if (!sessEvents.length) return remoteEvents.slice();
  if (!remoteEvents.length) return sessEvents.slice();
  const remoteUsers = new Set<string>();
  let lastRemote = '';
  for (const line of remoteEvents) {
    const user = userTextOf(line || '');
    if (!user) continue;
    remoteUsers.add(user);
    lastRemote = user;
  }
  const sessTurns = groupUserTurns(sessEvents);
  // Same prompt text can appear twice (compact snapshots). Match from the end.
  let lastMatch = -1;
  if (lastRemote) {
    for (let i = sessTurns.length - 1; i >= 0; i--) {
      if (sessTurns[i]!.user === lastRemote) {
        lastMatch = i;
        break;
      }
    }
  }
  if (lastMatch < 0) {
    for (let i = sessTurns.length - 1; i >= 0; i--) {
      if (remoteUsers.has(sessTurns[i]!.user)) {
        lastMatch = i;
        break;
      }
    }
  }
  // No overlap with this journal tail: dumping the whole TUI session
  // after the latest grok-remote turns paints an outdated Grok reply
  // when the loading overlay lifts.
  if (lastMatch < 0) return remoteEvents.slice();
  const extra = sessTurns.slice(lastMatch + 1);
  if (extraLooksLikeTuiSnapshot(extra)) return remoteEvents.slice();
  const journalAsst = lastTurnAssistantText(remoteEvents);
  const overlapAsst = assistantTextOf(sessTurns[lastMatch]!.lines);
  // Outdated TUI copy of the last user (e.g. "hello" vs journal "landing pad").
  if (journalAsst && overlapAsst && journalAsst !== overlapAsst) return remoteEvents.slice();
  const out = remoteEvents.slice();
  const lastIdx = extra.length - 1;
  for (let i = 0; i < extra.length; i++) {
    const st = extra[i]!;
    if (!st.user || st.user.startsWith('__compact__:')) continue;
    if (remoteUsers.has(st.user)) continue;
    // A TUI user line with no reply must not become the loaded "latest"
    // bubble. Live SSE will paint an in-flight prompt; history should end
    // on the last complete Grok reply.
    if (!sessHasAssistant(st)) continue;
    out.push(...st.lines);
  }
  return out;
}

function newestCompactionRequest(dir: string): string | null {
  const reqDir = path.join(dir, 'compaction_requests');
  let best: { fp: string; mtime: number } | null = null;
  try {
    for (const name of fs.readdirSync(reqDir)) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(reqDir, name);
      let st: fs.Stats;
      try { st = fs.statSync(fp); } catch { continue; }
      if (!best || st.mtimeMs > best.mtime) best = { fp, mtime: st.mtimeMs };
    }
  } catch { /* none */ }
  return best ? best.fp : null;
}

function eventsFromCompactionRequest(fp: string): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8')) as { chat_history?: unknown };
    if (!Array.isArray(data.chat_history)) return [];
    const ndjson = data.chat_history.map((row) => JSON.stringify(row)).join('\n');
    return sessionLinesToEvents(ndjson);
  } catch {
    return [];
  }
}

export function loadSessionEvents(
  rec: { cwd?: string; sessionId?: string; lastSessionId?: string } | null,
  opts?: { skipCompaction?: boolean },
): string[] {
  const sid = rec && (rec.sessionId || rec.lastSessionId);
  const cwd = rec && rec.cwd;
  if (!sid) return [];
  const matches = listAllTuiSessions().filter((s) => s.id === sid);
  const keep = pickCanonicalTuiSession(matches, cwd || null);
  const dirs: string[] = [];
  const seenDir = new Set<string>();
  const addDir = (d: string | null | undefined) => {
    if (!d) return;
    const abs = path.resolve(d);
    if (seenDir.has(abs) || !fs.existsSync(abs)) return;
    seenDir.add(abs);
    dirs.push(abs);
  };
  addDir(keep && keep.dir);
  for (const s of matches) addDir(s.dir);
  addDir(sessionDir(cwd, sid));

  const parts: string[][] = [];
  const seenFile = new Set<string>();
  if (!(opts && opts.skipCompaction)) {
    const compactDir = (keep && keep.dir) || sessionDir(cwd, sid);
    const compactFp = compactDir ? newestCompactionRequest(compactDir) : null;
    const fromCompact = compactFp ? eventsFromCompactionRequest(compactFp) : [];
    if (fromCompact.length) parts.push(fromCompact);
  }
  for (const dir of dirs) {
    for (const fp of listSessionHistoryFiles(dir)) {
      const abs = path.resolve(fp);
      if (seenFile.has(abs)) continue;
      seenFile.add(abs);
      let raw = '';
      try { raw = fs.readFileSync(fp).toString('utf8'); } catch { continue; }
      const next = sessionLinesToEvents(raw);
      if (next.length) parts.push(next);
    }
  }
  return concatSessionEvents(parts);
}


export function lastUserTurnHasAssistant(raw: string): boolean {
  const lines = String(raw || '').split('\n');
  let lastUser = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || '';
    if (!line || line.indexOf('"user_message"') === -1) continue;
    try {
      if ((JSON.parse(line) as { event?: string }).event === 'user_message') lastUser = i;
    } catch { /* skip */ }
  }
  if (lastUser < 0) return false;
  for (let i = lastUser + 1; i < lines.length; i++) {
    const line = lines[i] || '';
    if (!line) continue;
    if (line.indexOf('"user_message"') !== -1) {
      try {
        if ((JSON.parse(line) as { event?: string }).event === 'user_message') break;
      } catch { /* skip */ }
    }
    if (line.indexOf('"agent_message_chunk"') === -1) continue;
    try {
      if ((JSON.parse(line) as { event?: string }).event === 'agent_message_chunk') return true;
    } catch { /* skip */ }
  }
  return false;
}

export function mergeSessionTranscript(
  remoteRaw: string,
  rec: { cwd?: string; sessionId?: string; lastSessionId?: string } | null,
  opts?: { journalTurnCount?: number; skipCompaction?: boolean },
): string {
  try {
    const remoteEvents: string[] = [];
    for (const line of String(remoteRaw || '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { event?: string };
        if (o && o.event) remoteEvents.push(line);
      } catch { /* skip corrupt */ }
    }

    const sessEvents = loadSessionEvents(rec, { skipCompaction: !!(opts && opts.skipCompaction) });

    if (!sessEvents.length) {
      return remoteEvents.length ? remoteEvents.join('\n') + '\n' : (remoteRaw || '');
    }

    const merged = mergeEventLines(remoteEvents, sessEvents, opts);
    const out = appendNewerSessionTurns(merged, sessEvents);
    return out.length ? out.join('\n') + '\n' : '';
  } catch {
    return remoteRaw;
  }
}

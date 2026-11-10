// Grok TUI sessions live under ~/.grok/sessions/<encoded-cwd>/<session-id>/.
// grok-remote conversations are separate agent records linked by lastSessionId.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TuiSession {
  id: string;
  cwd: string;
  title: string;
  kind: string;
  dir: string;
  updatedAt: string;
  createdAt: string;
  chatMessages: number | null;
  titleIsManual: boolean;
}

export function grokHome(): string {
  const env = process.env['GROK_HOME'];
  if (env && env.trim()) return env.trim();
  return path.join(os.homedir(), '.grok');
}

/** Throwaway CLI / scheduler sessions under /tmp must not become sidebar chats. */
export function isIgnoredUiCwd(cwd?: string | null): boolean {
  const raw = String(cwd || '').trim();
  if (!raw) return false;
  let n: string;
  try { n = path.resolve(raw); } catch { n = raw; }
  const norm = n.replace(/\\/g, '/');
  const roots = ['/tmp', '/var/tmp'];
  for (const root of roots) {
    if (norm === root || norm.startsWith(root + '/')) return true;
  }
  return false;
}

export function tuiSessionsRoot(home = grokHome()): string {
  return path.join(home, 'sessions');
}

export function tuiSessionTitle(summary: Record<string, unknown> | null | undefined): string {
  if (!summary || typeof summary !== 'object') return '';
  const title = String(summary.generated_title || summary.session_summary || '').trim();
  return title;
}

export function readTuiSummaryFile(fp: string): TuiSession | null {
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>;
    const info = (d.info && typeof d.info === 'object') ? d.info as Record<string, unknown> : {};
    const dir = path.dirname(fp);
    const id = String(info.id || path.basename(dir) || '').trim();
    if (!id) return null;
    const group = path.basename(path.dirname(dir));
    let cwd = typeof info.cwd === 'string' ? info.cwd : '';
    if (!cwd) {
      try { cwd = decodeURIComponent(group); } catch { cwd = group; }
    }
    const chatMessages = typeof d.num_chat_messages === 'number' ? d.num_chat_messages : null;
    return {
      id,
      cwd,
      title: tuiSessionTitle(d),
      kind: String(d.session_kind || ''),
      dir,
      updatedAt: String(d.updated_at || d.last_active_at || ''),
      createdAt: String(d.created_at || ''),
      chatMessages,
      titleIsManual: d.title_is_manual === true,
    };
  } catch {
    return null;
  }
}

/** Every TUI session folder, including leftover copies of the same id after a cwd move. */
export function listAllTuiSessions(home = grokHome()): TuiSession[] {
  const base = tuiSessionsRoot(home);
  const out: TuiSession[] = [];
  let groups: string[] = [];
  try { groups = fs.readdirSync(base); } catch { return []; }
  for (const g of groups) {
    if (g.startsWith('.') || g.endsWith('.sqlite')) continue;
    const groupDir = path.join(base, g);
    let ids: string[] = [];
    try {
      if (!fs.statSync(groupDir).isDirectory()) continue;
      ids = fs.readdirSync(groupDir);
    } catch { continue; }
    for (const id of ids) {
      const sum = path.join(groupDir, id, 'summary.json');
      const rec = fs.existsSync(sum) ? readTuiSummaryFile(sum) : null;
      if (!rec) continue;
      if (rec.kind === 'subagent') continue;
      out.push(rec);
    }
  }
  return out;
}

/** Session ids Grok marked as subagents. Used to strip child chunks from parent history. */
export function listSubagentSessionIds(home = grokHome()): Set<string> {
  const base = tuiSessionsRoot(home);
  const out = new Set<string>();
  let groups: string[] = [];
  try { groups = fs.readdirSync(base); } catch { return out; }
  for (const g of groups) {
    if (g.startsWith('.') || g.endsWith('.sqlite')) continue;
    const groupDir = path.join(base, g);
    let ids: string[] = [];
    try {
      if (!fs.statSync(groupDir).isDirectory()) continue;
      ids = fs.readdirSync(groupDir);
    } catch { continue; }
    for (const id of ids) {
      const sum = path.join(groupDir, id, 'summary.json');
      const rec = fs.existsSync(sum) ? readTuiSummaryFile(sum) : null;
      if (rec && rec.kind === 'subagent' && rec.id) out.add(rec.id);
    }
  }
  return out;
}

export function sessionDirMatchesCwd(sess: TuiSession, cwd?: string | null): boolean {
  if (!sess || !cwd) return false;
  try {
    if (sess.cwd && path.resolve(sess.cwd) === path.resolve(cwd)) return true;
  } catch { /* ignore */ }
  const encoded = encodeURIComponent(cwd);
  const parent = path.basename(path.dirname(sess.dir));
  return parent === encoded;
}

/** Prefer the folder Grok is actually using (cwd match), then the newest write. */
export function pickCanonicalTuiSession(
  sessions: TuiSession[],
  preferredCwd?: string | null,
): TuiSession | null {
  const list = sessions.filter(Boolean);
  if (!list.length) return null;
  const ranked = list.slice().sort((a, b) => {
    const am = sessionDirMatchesCwd(a, preferredCwd) ? 1 : 0;
    const bm = sessionDirMatchesCwd(b, preferredCwd) ? 1 : 0;
    if (am !== bm) return bm - am;
    const at = Date.parse(a.updatedAt) || 0;
    const bt = Date.parse(b.updatedAt) || 0;
    if (at !== bt) return bt - at;
    const ac = a.chatMessages || 0;
    const bc = b.chatMessages || 0;
    if (ac !== bc) return bc - ac;
    return a.dir.localeCompare(b.dir);
  });
  return ranked[0] || null;
}

export function dedupeTuiSessions(
  sessions: TuiSession[],
  preferredCwdById?: Map<string, string>,
): TuiSession[] {
  const byId = new Map<string, TuiSession[]>();
  for (const s of sessions) {
    const list = byId.get(s.id) || [];
    list.push(s);
    byId.set(s.id, list);
  }
  const out: TuiSession[] = [];
  for (const [id, list] of byId) {
    const keep = pickCanonicalTuiSession(list, preferredCwdById?.get(id) || null);
    if (keep) out.push(keep);
  }
  return out;
}

export function listTuiSessions(home = grokHome()): TuiSession[] {
  return dedupeTuiSessions(listAllTuiSessions(home));
}

export function findTuiSession(
  sessionId: string,
  homeOrOpts?: string | { home?: string; cwd?: string | null },
): TuiSession | null {
  const opts = typeof homeOrOpts === 'string' ? { home: homeOrOpts } : (homeOrOpts || {});
  const home = opts.home || grokHome();
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const matches = listAllTuiSessions(home).filter((s) => s.id === id);
  return pickCanonicalTuiSession(matches, opts.cwd || null);
}

export function planTuiDuplicateCleanup(
  sessions: TuiSession[],
  preferredCwdById?: Map<string, string>,
): Array<{ keep: TuiSession; drop: TuiSession[] }> {
  const byId = new Map<string, TuiSession[]>();
  for (const s of sessions) {
    const list = byId.get(s.id) || [];
    list.push(s);
    byId.set(s.id, list);
  }
  const out: Array<{ keep: TuiSession; drop: TuiSession[] }> = [];
  for (const list of byId.values()) {
    if (list.length < 2) continue;
    const keep = pickCanonicalTuiSession(list, preferredCwdById?.get(list[0]!.id) || null);
    if (!keep) continue;
    const keepAbs = path.resolve(keep.dir);
    const drop = list.filter((s) => path.resolve(s.dir) !== keepAbs);
    if (drop.length) out.push({ keep, drop });
  }
  return out;
}

/** Copy leftover TUI transcript into the live session folder without touching live chat_history.jsonl. */
export function importTuiChatHistory(fromDir: string, intoDir: string): boolean {
  const srcDir = path.resolve(fromDir);
  const destDir = path.resolve(intoDir);
  if (!srcDir || !destDir || srcDir === destDir) return false;
  const src = path.join(srcDir, 'chat_history.jsonl');
  if (!fs.existsSync(src) || !fs.existsSync(destDir)) return false;
  let st: fs.Stats;
  try { st = fs.statSync(src); } catch { return false; }
  if (!st.size) return false;
  const live = path.join(destDir, 'chat_history.jsonl');
  try {
    if (fs.existsSync(live) && fs.readFileSync(src).equals(fs.readFileSync(live))) return false;
  } catch { /* still copy */ }
  const tag = path.basename(srcDir).slice(0, 12);
  const dest = path.join(destDir, `chat_history.imported-${tag}.jsonl`);
  if (fs.existsSync(dest)) return false;
  try {
    fs.copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

export function listSessionHistoryFiles(dir: string): string[] {
  if (!dir) return [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const imported = names
    .filter((n) => n.startsWith('chat_history.imported') && n.endsWith('.jsonl'))
    .sort()
    .map((n) => path.join(dir, n));
  const live = path.join(dir, 'chat_history.jsonl');
  const out = imported.slice();
  if (fs.existsSync(live)) out.push(live);
  return out;
}

export function writeTuiSessionTitle(dir: string, title: string, opts?: { manual?: boolean }): boolean {
  const fp = path.join(dir, 'summary.json');
  const next = String(title || '').trim();
  if (!next) return false;
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>;
    d.generated_title = next;
    d.session_summary = next;
    d.title_is_manual = opts && opts.manual === false ? false : true;
    d.updated_at = new Date().toISOString();
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, fp);
    return true;
  } catch {
    return false;
  }
}

export function deleteTuiSessionDir(dir: string, home = grokHome()): boolean {
  const root = path.resolve(tuiSessionsRoot(home));
  const abs = path.resolve(dir);
  if (abs === root || !abs.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(path.join(abs, 'summary.json'))) return false;
  try {
    fs.rmSync(abs, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export interface TuiSyncAgent {
  id: string;
  name: string;
  lastSessionId?: string | null;
  autoNamed?: boolean;
  cwd?: string | null;
}

export interface TuiSyncPlan {
  rename: Array<{ agentId: string; name: string }>;
  adopt: TuiSession[];
  removeAgentIds: string[];
}

export function planTuiSessionSync(agents: TuiSyncAgent[], sessions: TuiSession[]): TuiSyncPlan {
  const preferred = new Map<string, string>();
  for (const a of agents) {
    const sid = a.lastSessionId ? String(a.lastSessionId) : '';
    if (sid && a.cwd) preferred.set(sid, a.cwd);
  }
  const unique = dedupeTuiSessions(sessions, preferred).filter((s) => !isIgnoredUiCwd(s.cwd));
  const bySession = new Map<string, TuiSyncAgent[]>();
  for (const a of agents) {
    const sid = a.lastSessionId ? String(a.lastSessionId) : '';
    if (!sid) continue;
    const list = bySession.get(sid) || [];
    list.push(a);
    bySession.set(sid, list);
  }
  const claimedTitles = new Set(
    agents.map((a) => String(a.name || '').trim()).filter(Boolean),
  );
  const rename: TuiSyncPlan['rename'] = [];
  const adopt: TuiSession[] = [];
  const seen = new Set<string>();
  for (const sess of unique) {
    seen.add(sess.id);
    const linked = bySession.get(sess.id) || [];
    if (!linked.length) {
      // A model/effort switch starts session/new. The old TUI folder
      // keeps the same title; do not turn it into a second sidebar chat.
      const title = String(sess.title || '').trim();
      if (title && claimedTitles.has(title)) continue;
      adopt.push(sess);
      continue;
    }
    if (!sess.title) continue;
    for (const a of linked) {
      if (a.name === sess.title) continue;
      // A grok-remote rename is sticky. Do not let TUI auto-title overwrite it.
      if (a.autoNamed === false && !sess.titleIsManual) continue;
      rename.push({ agentId: a.id, name: sess.title });
    }
  }
  const removeAgentIds: string[] = [];
  for (const a of agents) {
    const sid = a.lastSessionId ? String(a.lastSessionId) : '';
    if (!sid) continue;
    if (!seen.has(sid)) removeAgentIds.push(a.id);
  }
  return { rename, adopt, removeAgentIds };
}


export function shouldKillTuiOrphan(opts: {
  starred?: boolean;
  archived?: boolean;
  holdRunning?: boolean;
  grokRemoteHistoryBytes: number;
  ignoredCwd?: boolean;
}): boolean {
  if (opts.starred || opts.archived || opts.holdRunning) return false;
  if ((opts.grokRemoteHistoryBytes || 0) >= 256) return false;
  // Dashboard project chats must survive a missing TUI session folder
  // (rebind / compact before summary.json is listed).
  if (!opts.ignoredCwd) return false;
  return true;
}

export function isDisposableImportedChat(opts: {
  name: string;
  starred?: boolean;
  archived?: boolean;
  holdRunning?: boolean;
  grokRemoteHistoryBytes: number;
  tuiChatMessages: number | null;
}): boolean {
  if (opts.starred || opts.archived || opts.holdRunning) return false;
  if (opts.grokRemoteHistoryBytes >= 8 * 1024) return false;
  const name = String(opts.name || '').trim();
  const msgs = opts.tuiChatMessages;
  const untitled = !name || /^session-/i.test(name);
  const identity = /identity|who the local model|who are you|greeting and identity/i.test(name);
  if (untitled && (msgs == null || msgs <= 8)) return true;
  if (identity && (msgs == null || msgs <= 10)) return true;
  // Do not treat a short named dashboard chat as disposable. That deleted
  // real conversations after the hold exited.
  return false;
}

/** Empty grok-remote shell whose title already belongs to a heavier conversation. */
export function isDuplicateNameShell(opts: {
  id: string;
  name: string;
  grokRemoteHistoryBytes: number;
  peers: Array<{ id: string; name: string; grokRemoteHistoryBytes: number }>;
}): boolean {
  const name = String(opts.name || '').trim();
  if (!name || /^session-/i.test(name)) return false;
  if (opts.grokRemoteHistoryBytes >= 32 * 1024) return false;
  return opts.peers.some((p) =>
    p.id !== opts.id
    && String(p.name || '').trim() === name
    && p.grokRemoteHistoryBytes > opts.grokRemoteHistoryBytes,
  );
}

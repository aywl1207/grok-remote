// Conversation status shown in the sidebar and chat header.

export function isLiveWorkUpdate(sessionUpdate: string | undefined | null): boolean {
  const k = String(sessionUpdate || '');
  return k === 'agent_thought_chunk'
    || k === 'agent_message_chunk'
    || k === 'tool_call'
    || k === 'tool_call_start'
    || k === 'tool_call_update';
}

export function derivePublicStatus(opts: {
  hasClient: boolean;
  clientStatus?: string | null;
  recordStatus?: string | null;
  lastError?: string | null;
  inFlight?: number;
  turnOpen?: boolean;
}): string {
  if (!opts.hasClient) return 'disconnected';
  const s = opts.clientStatus || opts.recordStatus || 'disconnected';
  if (s === 'exited') return 'disconnected';
  if (s === 'errored') {
    if (/agent exited/i.test(String(opts.lastError || ''))) return 'disconnected';
    return 'errored';
  }
  if (s === 'starting') return 'starting';
  const toolsLive = typeof opts.inFlight === 'number' && opts.inFlight > 0;
  // A leftover ACP "running" after reconnect is not a live turn.
  // The journal (turnOpen) and in-flight tools are the source of truth.
  if (opts.turnOpen || toolsLive) return 'running';
  if (s === 'running' && opts.turnOpen === false) return 'idle';
  if (s === 'running') return 'running';
  if (s === 'idle') return 'idle';
  return s;
}

/** Drop a replayed disconnect / "agent exited" that would hide a live agent. */
export function shouldApplyAgentStatus(
  current: { connected?: boolean; status?: string | null } | null,
  incoming: string,
  err?: string | null,
): boolean {
  const next = String(incoming || '').toLowerCase();
  if (!current) return true;
  const st = String(current.status || '');
  if (next === 'errored' && /agent exited/i.test(String(err || ''))) {
    if (current.connected || st === 'idle' || st === 'running' || st === 'disconnected') return false;
  }
  if (next !== 'disconnected' && next !== 'exited') return true;
  if (current.connected && (st === 'idle' || st === 'running' || st === 'starting')) return false;
  return true;
}

/** True when this AcpClient can carry traffic. Disconnected + sessionId is dead. */
export function clientIsLive(c: {
  sessionId?: string | null;
  status?: string | null;
  sock?: { destroyed?: boolean } | null;
  proc?: { stdin?: { writable?: boolean } | null } | null;
} | null | undefined): boolean {
  if (!c) return false;
  const st = String(c.status || '');
  if (st === 'starting') return true;
  if (st === 'exited' || st === 'errored' || st === 'disconnected') return false;
  if (!c.sessionId) return false;
  if (c.sock && !c.sock.destroyed) return true;
  if (c.proc && c.proc.stdin && c.proc.stdin.writable) return true;
  return false;
}


/** UI Running only for a live turn or in-flight tools. Leftover ACP running is idle. */
export function isDisplayedWorking(opts: {
  status?: string | null;
  turnOpen?: boolean;
  inFlight?: number;
}): boolean {
  if (opts.turnOpen) return true;
  if (typeof opts.inFlight === 'number' && opts.inFlight > 0) return true;
  return false;
}

/** Sidebar chip: Starting/Error/Disconnected stay; Running only for a live turn. */
export function sidebarDisplayStatus(a: {
  status?: string | null;
  turnOpen?: boolean;
  inFlight?: number;
}): string {
  const raw = String(a.status || 'idle');
  if (raw === 'starting' || raw === 'errored' || raw === 'disconnected' || raw === 'exited') return raw;
  const working = isDisplayedWorking({
    status: raw,
    turnOpen: !!a.turnOpen,
    inFlight: typeof a.inFlight === 'number' ? a.inFlight : 0,
  });
  if (working) return 'running';
  if (raw === 'running') return 'idle';
  return raw || 'idle';
}

/** Optimistic Running after Send, until the server turnOpen flag arrives. */
export const LOCAL_TURN_HOLD_MS = 8_000;
/** Keep Send/Queue in sync with sidebar: server idle wins after this grace. */
export const LOCAL_TURN_GRACE_MS = 800;

/** Local Send can show Running immediately; after the hold, the server wins. */
export function followServerTurnOpen(opts: {
  local: boolean;
  server?: boolean | null;
  holdUntil?: number | null;
  now?: number;
}): boolean {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (typeof opts.server === 'boolean') {
    if (opts.server) return true;
    if (opts.local && typeof opts.holdUntil === 'number' && now < opts.holdUntil) {
      const sentAt = opts.holdUntil - LOCAL_TURN_HOLD_MS;
      if (now - sentAt < LOCAL_TURN_GRACE_MS) return true;
    }
    return false;
  }
  if (opts.local && typeof opts.holdUntil === 'number' && now < opts.holdUntil) return true;
  return !!opts.local;
}

/** Sidebar overlay is a short Send hint. It must not keep a finished turn Running. */
export function applyWorkingOverlayRow<T extends {
  status?: string | null;
  turnOpen?: boolean;
  inFlight?: number;
}>(row: T, overlayUntil: number | undefined, now = Date.now()): T {
  if (isDisplayedWorking({
    turnOpen: !!row.turnOpen,
    inFlight: typeof row.inFlight === 'number' ? row.inFlight : 0,
  })) return row;
  if (typeof overlayUntil !== 'number' || now >= overlayUntil) return row;
  const raw = String(row.status || '');
  if (raw === 'starting' || raw === 'errored' || raw === 'disconnected' || raw === 'exited') return row;
  return { ...row, turnOpen: true, status: 'running' };
}

export const TERMINAL_TOOL_STATUS = new Set([
  'completed', 'success', 'succeeded', 'failed', 'error', 'errored',
  'canceled', 'cancelled',
]);

const LIVE_TOOL_STATUS = new Set(['pending', 'running', 'in_progress', 'inprogress']);

const TOOL_SESSION_UPDATES = new Set([
  'tool_call', 'tool_call_start', 'tool_call_update', 'tool_call_end',
]);

/** Add/remove a tool id from the in-flight set.
 *  Start events count unless already terminal. Updates only add on an
 *  explicit live status so a late empty patch cannot revive a completed tool. */
export function applyToolInFlight(
  ids: Set<string>,
  opts: { sessionUpdate?: string | null; status?: string | null; callId?: string | null },
): boolean {
  const callId = String(opts.callId || '');
  if (!callId) return false;
  const sub = String(opts.sessionUpdate || '');
  if (!TOOL_SESSION_UPDATES.has(sub)) return false;
  const lowered = String(opts.status || '').toLowerCase();
  if (TERMINAL_TOOL_STATUS.has(lowered) || sub === 'tool_call_end') {
    return ids.delete(callId);
  }
  const start = sub === 'tool_call' || sub === 'tool_call_start';
  const liveUpdate = sub === 'tool_call_update' && LIVE_TOOL_STATUS.has(lowered);
  if (!start && !liveUpdate) return false;
  const before = ids.size;
  ids.add(callId);
  return ids.size !== before;
}

export function isToolSessionUpdate(sessionUpdate: string | undefined | null): boolean {
  return TOOL_SESSION_UPDATES.has(String(sessionUpdate || ''));
}


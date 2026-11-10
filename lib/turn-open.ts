// Last user turn is in progress only while work is still happening.
// A missing prompt_complete is not enough: reconnects write session_ready
// and leave yesterday's turn looking "open" forever.

export const TURN_WORK_EVENTS = new Set([
  'agent_thought_chunk',
  'agent_message_chunk',
  'tool_call',
  'tool_call_update',
  'tool_call_start',
]);

/** No chunks for this long → the last turn was abandoned. */
export const TURN_STALE_MS = 60 * 60 * 1000;
/** Re-attach must not close a turn that still had work in the last two minutes.
 *  docker restart / ACP reconnect writes session_ready after the last journaled
 *  tool event even while grok is still executing that tool. */
export const TURN_ATTACH_LIVE_MS = 2 * 60 * 1000;

function eventAtMs(ev: { at?: unknown } | null | undefined): number {
  if (!ev || ev.at == null) return 0;
  if (typeof ev.at === 'number' && Number.isFinite(ev.at)) return ev.at;
  const t = Date.parse(String(ev.at));
  return Number.isFinite(t) ? t : 0;
}

export function lastTurnIsOpen(
  events: Array<{ event?: unknown; at?: unknown } | null | undefined>,
  nowMs = Date.now(),
): boolean {
  let lastUser = -1;
  let lastComplete = -1;
  let lastReady = -1;
  let lastWork = -1;
  let lastUserAt = 0;
  let lastWorkAt = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    const n = String(ev.event || '');
    const t = eventAtMs(ev);
    if (n === 'user_message') {
      lastUser = i;
      lastUserAt = t;
    } else if (n === 'prompt_complete') {
      lastComplete = i;
    } else if (n === 'session_ready') {
      lastReady = i;
    } else if (TURN_WORK_EVENTS.has(n)) {
      lastWork = i;
      lastWorkAt = t;
    }
  }
  if (lastUser < 0) return false;
  if (lastComplete > lastUser) return false;
  const lastActivity = Math.max(lastUserAt, lastWorkAt);
  // session_ready is written on attach, which is always after the last
  // journaled chunk. Only treat that as a closed turn when the last
  // activity is old enough that grok is no longer mid-tool.
  if (lastReady > lastUser && lastReady > lastWork) {
    if (!lastActivity || nowMs - lastActivity > TURN_ATTACH_LIVE_MS) return false;
  }
  if (lastActivity && nowMs - lastActivity > TURN_STALE_MS) return false;
  return true;
}

export function lastTurnIsOpenFromNdjson(text: string, nowMs = Date.now()): boolean {
  if (!text) return false;
  const events: Array<{ event?: unknown; at?: unknown }> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed) as { event?: unknown; at?: unknown }); } catch { /* skip */ }
  }
  return lastTurnIsOpen(events, nowMs);
}

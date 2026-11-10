// First SSE connect replays the in-process ring (last ~200 events).
// History already painted those. Drop stale ring events so they cannot
// append a second footer, re-open a plan card, or flash Disconnected.

import { alreadyInHistory, parseLiveEventId } from './event-id.js';

const STALE_ALWAYS_DROP = new Set([
  'agent_status',
  'error',
  'prompt_complete',
  'plan_approval',
  'user_question',
  'permission_request',
  'tool_call',
  'tool_call_update',
]);

const TOOL_EVENTS = new Set(['tool_call', 'tool_call_update']);

export interface SseRingFilterOpts {
  name: string;
  lastEventId?: unknown;
  lastHistoryEventId?: unknown;
  streamOpenedAt?: number | null;
  data?: {
    status?: unknown;
    update?: { status?: unknown };
    text?: unknown;
    data?: { text?: unknown };
    _t?: unknown;
    _eventId?: unknown;
    eventId?: unknown;
  } | null;
  turns?: Array<{ userText?: unknown; assistant?: unknown; footer?: unknown }>;
}

function eventTimeMs(lastEventId: unknown, data: SseRingFilterOpts['data']): number {
  const parsed = parseLiveEventId(lastEventId)
    || parseLiveEventId(data && (data._eventId || data.eventId));
  if (parsed) return parsed.t;
  const t = data && data._t;
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}

export function shouldDropSseEvent(opts: SseRingFilterOpts): boolean {
  const { name, lastEventId, lastHistoryEventId, streamOpenedAt, data, turns } = opts;
  const eid = lastEventId || (data && (data._eventId || data.eventId));
  const isTextChunk = name === 'agent_message_chunk' || name === 'agent_thought_chunk';
  if (alreadyInHistory(lastHistoryEventId, eid)) {
    // Never restream a painted chunk into a later empty You turn.
    // That painted the previous Grok reply as the "latest" bubble.
    return true;
  }
  const opened = streamOpenedAt || 0;
  const eventTs = eventTimeMs(lastEventId, data);
  const staleRing = !!(opened && eventTs && eventTs < opened - 250);
  // Named EventSource events often have an empty lastEventId on mobile.
  // Ring replay arrives in the first second. Live tools always have _t.
  if (TOOL_EVENTS.has(name) && opened) {
    // Ring tools are always older than this connect. Live tools have
    // _t / id at or after stream open.
    if (!eventTs || eventTs < opened) return true;
  }
  if (eventTs && opened && eventTs < opened && (name === 'agent_status' || name === 'error')) {
    return true;
  }
  if (staleRing && STALE_ALWAYS_DROP.has(name)) return true;
  if (staleRing && isTextChunk) return true;
  if (staleRing && name === 'user_message') {
    const raw = data && (data.text || (data.data && data.data.text) || '');
    const already = String(raw || '').trim();
    if (already && (turns || []).some((turn) => String(turn.userText || '').trim() === already)) {
      return true;
    }
  }
  return false;
}

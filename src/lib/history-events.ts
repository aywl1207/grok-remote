// Which ACP events the chat UI replays from GET /history.
// ChatView must call these. Do not copy the skip sets into chat.ts.

export const HISTORY_CATCHUP_SKIP = new Set([
  'handshake',
  'available_commands_update',
  'tool_call_delta_chunk',
  'agent_status',
  'plan_approval',
  'user_question',
]);

/** Full replay also drops error banners (they are live-only). */
export const HISTORY_REPLAY_SKIP = new Set([
  ...HISTORY_CATCHUP_SKIP,
  'error',
  'session_summary_generated',
]);

/** Pass 1 paints You + reply. prompt_complete is listed so replay can
 *  update tokens, but ChatView must not endTurn until the reply exists. */
export const HISTORY_PASS1 = new Set([
  'user_message',
  'agent_message_chunk',
  'prompt_complete',
]);

export function eventNameOf(
  ev: { event?: unknown; type?: unknown; name?: unknown } | null | undefined,
): string {
  if (!ev) return '';
  return String(ev.event || ev.type || ev.name || '');
}

export function shouldSkipCatchUpEvent(name: string): boolean {
  return !name || HISTORY_CATCHUP_SKIP.has(name);
}

export function shouldSkipHistoryReplay(name: string): boolean {
  return !name || HISTORY_REPLAY_SKIP.has(name);
}

export function isHistoryPass1(name: string): boolean {
  return HISTORY_PASS1.has(name);
}

export type HistoryPass2Kind = 'user' | 'skip' | 'paint';

/** Pass 2 attaches thoughts/tools onto the matching turn. */
export function classifyHistoryPass2(name: string): HistoryPass2Kind {
  if (name === 'user_message') return 'user';
  if (!name || name === 'agent_message_chunk' || name === 'prompt_complete') return 'skip';
  if (shouldSkipHistoryReplay(name)) return 'skip';
  return 'paint';
}

export interface HistoryTurnSplit<T> {
  older: T[];
  latest: T[];
  lastUserIndex: number;
}

/** Last user_message and everything after it. Older turns stay in `older`. */
export function splitHistoryLatestTurn<T extends { event?: unknown; type?: unknown; name?: unknown }>(
  events: T[],
): HistoryTurnSplit<T> {
  let lastUser = -1;
  for (let i = 0; i < events.length; i++) {
    if (eventNameOf(events[i]) === 'user_message') lastUser = i;
  }
  if (lastUser < 0) return { older: [], latest: events.slice(), lastUserIndex: -1 };
  if (lastUser === 0) return { older: [], latest: events.slice(), lastUserIndex: 0 };
  return {
    older: events.slice(0, lastUser),
    latest: events.slice(lastUser),
    lastUserIndex: lastUser,
  };
}

/** Last-N windows can still start with the previous turn's reply. Do not paint those. */
export function dropEventsBeforeFirstUser<T extends { event?: unknown; type?: unknown; name?: unknown }>(
  events: T[],
): T[] {
  if (!Array.isArray(events) || !events.length) return [];
  for (let i = 0; i < events.length; i++) {
    if (eventNameOf(events[i]) === 'user_message') return events.slice(i);
  }
  return [];
}

/** Skip GET catch-up when the last painted turn already matches the journal. */
export function shouldSkipHistoryCatchUp(opts: {
  lastHistUser: string;
  turns: Array<{ userText?: unknown; assistant?: unknown }>;
}): boolean {
  const hist = String(opts.lastHistUser || '').trim();
  if (!hist) return true;
  const turns = opts.turns || [];
  if (!turns.length) return false;
  const last = turns[turns.length - 1];
  const lastUser = String((last && last.userText) || '').trim();
  if (lastUser !== hist) return false;
  return !!(last && last.assistant);
}

/** Skip the extra GET after first paint. Live SSE fills an open turn. */
export function shouldSkipCatchUpFetch(opts: {
  force?: boolean;
  replaying?: boolean;
  historyLoaded?: boolean;
  turnCount?: number;
  activeTurn?: boolean;
  lastTurnComplete?: boolean;
}): boolean {
  if (opts.replaying) return true;
  if (opts.activeTurn && !opts.force) return true;
  if (opts.force) return false;
  // Re-fetching last-N after first paint appends those You rows under the
  // live Grok reply (journal event ids ≠ live `${t}-user` ids).
  if (opts.historyLoaded && (opts.turnCount || 0) > 0 && opts.lastTurnComplete !== false) {
    return true;
  }
  return false;
}

/** Map a painted-tail picker index to the journal user-turn index the rewind RPC expects. */
export function rewindKeepTurns(totalTurns: number, paintedTurns: number, localIndex: number): number {
  const painted = Math.max(0, Math.floor(Number(paintedTurns) || 0));
  const total = Math.max(painted, Math.floor(Number(totalTurns) || 0));
  const i = Math.max(0, Math.floor(Number(localIndex) || 0));
  return Math.max(1, total - painted + i + 1);
}

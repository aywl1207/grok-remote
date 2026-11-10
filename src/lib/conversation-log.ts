// One decision table for every user bubble.
// History replay and live SSE must call this. Do not invent extra You rows.

import { isSyntheticUserText, normalizeUserText, sameUserText } from './user-text.js';

export interface TurnLike {
  userText?: string;
  assistant?: unknown;
  tools?: unknown[];
}

export type UserDecision =
  | { action: 'ignore' }
  | { action: 'fill-empty'; text: string; attachments: unknown[] }
  | { action: 'start'; text: string; attachments: unknown[] };

export function decideUserMessage(
  turns: TurnLike[],
  active: TurnLike | null | undefined,
  rawText: unknown,
  attachments: unknown[] | undefined,
  fromHistory: boolean,
): UserDecision {
  const atts = Array.isArray(attachments) ? attachments : [];
  const text = normalizeUserText(rawText);
  if (!text && !atts.length) return { action: 'ignore' };

  const raw = String(rawText || '');
  if (!atts.length && isSyntheticUserText(raw) && !raw.includes('<user_query>')) {
    return { action: 'ignore' };
  }

  if (active && !normalizeUserText(active.userText)) {
    return { action: 'fill-empty', text, attachments: atts };
  }

  const last = turns.length ? turns[turns.length - 1] : undefined;

  // Live / SSE ring: never start a second You for a prompt already on screen.
  if (!fromHistory) {
    if (active && sameUserText(active.userText, text)) return { action: 'ignore' };
    if (turns.some((turn) => sameUserText(turn.userText, text))) return { action: 'ignore' };
    return { action: 'start', text, attachments: atts };
  }

  // History may repeat the same wording after a finished reply. That is a new turn.
  // A repeat with no reply yet is a duplicate line — ignore.
  if (last && sameUserText(last.userText, text) && !last.assistant && !(last.tools && last.tools.length)) {
    return { action: 'ignore' };
  }
  return { action: 'start', text, attachments: atts };
}

export function isDuplicateTailTurn(prev?: TurnLike, last?: TurnLike): boolean {
  if (!prev || !last) return false;
  if (!sameUserText(prev.userText, last.userText)) return false;
  return !last.assistant && !(last.tools && last.tools.length);
}

/** Local send already painted this You bubble; do not startTurn again. */
export function alreadyHasOptimisticUser(
  last: TurnLike | null | undefined,
  text: unknown,
): boolean {
  if (!last) return false;
  return sameUserText(last.userText, text) && !last.assistant && !(last.tools && last.tools.length);
}


/** Stale ring replay: put the reply on the last user who still has no answer. */
export function pickTurnForReplyChunk<T extends { userText?: unknown; assistant?: unknown }>(
  turns: T[],
  active: T | null | undefined,
  staleRing: boolean,
): T | null {
  if (!staleRing) return active || (turns.length ? turns[turns.length - 1]! : null);
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (!t) continue;
    if (String(t.userText || '').trim() && !t.assistant) return t;
  }
  return active || (turns.length ? turns[turns.length - 1]! : null);
}

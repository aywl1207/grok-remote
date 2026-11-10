// Composer ↑ / ↓ prompt history.
// Conversation user turns are the spine. localStorage is a cache.
// Always merge — a short first seed used to stick and hide older prompts.

import { extractUserQuery, normalizeUserText } from './user-text.js';

export const PROMPT_HIST_CAP = 500;

export function normalizePrompt(text: unknown): string {
  return extractUserQuery(String(text || '')).trim();
}

function dedupeKey(text: string): string {
  return normalizeUserText(text);
}

export function promptsFromTurns(
  turns: Array<{ userText?: unknown } | null | undefined> | null | undefined,
): string[] {
  const out: string[] = [];
  const list = turns || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const t = normalizePrompt(list[i] && list[i]!.userText);
    if (t) out.push(t);
  }
  return out;
}

/** Newest first. Stored entries win order; missing conversation prompts append. */
export function mergePromptHistory(
  stored: unknown,
  turnTexts: unknown,
  cap: number = PROMPT_HIST_CAP,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    const t = normalizePrompt(raw);
    if (!t) return;
    const key = dedupeKey(t);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  if (Array.isArray(stored)) for (const item of stored) add(item);
  if (Array.isArray(turnTexts)) for (const item of turnTexts) add(item);
  if (out.length > cap) out.length = cap;
  return out;
}

export function rememberPrompt(
  list: string[] | null | undefined,
  text: unknown,
  cap: number = PROMPT_HIST_CAP,
): string[] {
  const t = normalizePrompt(text);
  if (!t) return Array.isArray(list) ? list.slice() : [];
  const key = dedupeKey(t);
  const next = (Array.isArray(list) ? list : []).filter((item) => dedupeKey(item) !== key);
  next.unshift(t);
  if (next.length > cap) next.length = cap;
  return next;
}

export function parseStoredPromptHistory(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return mergePromptHistory(arr, [], PROMPT_HIST_CAP);
  } catch {
    return [];
  }
}

export function previewPrompt(text: unknown, max = 90): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const cut = slice.lastIndexOf(' ');
  const head = cut >= Math.floor(max * 0.6) ? slice.slice(0, cut) : slice;
  return head.replace(/[.,;:]+$/, '') + '…';
}

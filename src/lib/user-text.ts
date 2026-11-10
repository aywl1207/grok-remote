import { stripIdentityWrapper } from '../../lib/model-identity.js';

// Shared rules for "what the user actually typed".
// TUI session files wrap prompts in <user_query>; SSE may send the wrapper
// or the inner text. Compare only the normalized inner string.

export function extractUserQuery(text: string): string {
  const raw = stripIdentityWrapper(String(text || ''));
  const m = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m && m[1]) return m[1].trim();
  const s = raw.trim();
  return isSyntheticUserText(s) ? '' : s;
}

export function isSyntheticUserText(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.startsWith('<system-reminder>') || s.startsWith('<user_info>') || s.startsWith('<available_skills>')) {
    return true;
  }
  if (/^This session is being continued from a previous conversation/i.test(s)) return true;
  if (/^The user wants to revise the plan\b/i.test(s)) return true;
  if (s.startsWith('<') && !s.includes('<user_query>')) return true;
  return false;
}

export function normalizeUserText(text: unknown): string {
  return extractUserQuery(String(text || '')).replace(/\s+/g, ' ').trim();
}

export function sameUserText(a: unknown, b: unknown): boolean {
  const left = normalizeUserText(a);
  const right = normalizeUserText(b);
  return !!left && left === right;
}

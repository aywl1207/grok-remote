// Collapse a history event list for UI replay. No filesystem.
// Keep chronological order. Merge only consecutive same-type text runs.
// Last 2 user turns keep a cap of tool cards; older turns drop tools.

import { mergeStreamChunk } from './stream-text.js';

export const TOOLS_PER_TURN = 8;

function sharedPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}


function shouldReplaceCollapsed(have: string, incoming: string): boolean {
  if (!incoming || !have) return false;
  if (incoming.startsWith(have) || have.startsWith(incoming) || incoming === have) return false;
  const shared = sharedPrefixLen(have, incoming);
  return incoming.length >= 24
    && incoming.length >= have.length * 0.5
    && shared < 12
    && shared < incoming.length * 0.2;
}

/** One history-merge step. `acc` holds a prefix that may be a restream or new text. */
export function mergeCollapsedStep(
  have: string,
  incoming: string,
  acc = '',
): { text: string; acc: string } {
  if (!incoming) return { text: have, acc };
  if (!have) return { text: incoming, acc: '' };
  if (shouldReplaceCollapsed(have, incoming)) return { text: incoming, acc: '' };
  const merged = mergeStreamChunk(have, incoming, acc);
  if (!merged) return { text: have, acc };
  return { text: merged.next, acc: merged.acc };
}

/** Concatenate deltas; absorb growing snapshots; replace a restreamed answer. */
export function mergeCollapsedText(have: string, incoming: string): string {
  return mergeCollapsedStep(have, incoming, '').text;
}

export function historyEventText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const rec = data as { update?: unknown; content?: unknown; text?: unknown };
  const src = (rec.update && typeof rec.update === 'object' ? rec.update : rec) as { content?: unknown; text?: unknown };
  if (typeof src.content === 'string') return src.content;
  if (src.content && typeof src.content === 'object' && typeof (src.content as { text?: unknown }).text === 'string') {
    return (src.content as { text: string }).text;
  }
  return typeof src.text === 'string' ? src.text : '';
}

export function setHistoryEventText(ev: Record<string, unknown>, text: string): void {
  const data = (ev.data && typeof ev.data === 'object') ? ev.data as Record<string, unknown> : {};
  if (data.update && typeof data.update === 'object') {
    const upd = { ...(data.update as Record<string, unknown>) };
    const c = upd.content;
    upd.content = (c && typeof c === 'object')
      ? { ...(c as Record<string, unknown>), text }
      : { type: 'text', text };
    ev.data = { ...data, update: upd };
    return;
  }
  ev.data = { ...data, content: { type: 'text', text } };
}

export function isToolEvent(e: Record<string, unknown>): boolean {
  const name = String(e.event || '');
  return name === 'tool_call' || name === 'tool_call_update';
}

export function capTurnTools(
  rest: Array<Record<string, unknown>>,
  keep = TOOLS_PER_TURN,
): Array<Record<string, unknown>> {
  const toolIdx: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (isToolEvent(rest[i]!)) toolIdx.push(i);
  }
  if (toolIdx.length <= keep) return rest;
  const keepSet = new Set(toolIdx.slice(-keep));
  return rest.filter((e, i) => !isToolEvent(e) || keepSet.has(i));
}

function eventName(ev: Record<string, unknown>): string {
  return String(ev.event || '');
}

function mergeConsecutiveTextRuns(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i]!;
    const name = eventName(ev);
    if (name === 'agent_thought_chunk' || name === 'agent_message_chunk') {
      const first = { ...ev };
      let text = historyEventText(first.data);
      let acc = '';
      i += 1;
      while (i < events.length && eventName(events[i]!) === name) {
        const step = mergeCollapsedStep(text, historyEventText(events[i]!.data), acc);
        text = step.text;
        acc = step.acc;
        i += 1;
      }
      const cap = name === 'agent_thought_chunk' ? 16000 : 24000;
      if (text.length > cap) text = text.slice(0, cap);
      setHistoryEventText(first, text);
      out.push(first);
      continue;
    }
    out.push(ev);
    i += 1;
  }
  return out;
}

function capToolsByTurn(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let users = 0;
  for (const ev of events) {
    if (eventName(ev) === 'user_message') users += 1;
  }
  const keepFrom = Math.max(0, users - 2);
  const out: Array<Record<string, unknown>> = [];
  let turnNo = -1;
  let buf: Array<Record<string, unknown>> = [];
  const flush = (): void => {
    if (!buf.length) return;
    const next = turnNo >= keepFrom
      ? capTurnTools(buf)
      : buf.filter((e) => !isToolEvent(e));
    out.push(...next);
    buf = [];
  };
  for (const ev of events) {
    if (eventName(ev) === 'user_message') {
      flush();
      turnNo += 1;
    }
    buf.push(ev);
  }
  flush();
  return out;
}

export function collapseHistoryForReplay(
  events: Array<Record<string, unknown>>,
  opts?: { dropTools?: boolean },
): Array<Record<string, unknown>> {
  const merged = mergeConsecutiveTextRuns(events);
  if (opts && opts.dropTools) return merged.filter((e) => !isToolEvent(e));
  return capToolsByTurn(merged);
}

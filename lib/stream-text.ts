// Merge live ACP text chunks without dropping real characters.
// Grok may send deltas, growing snapshots, or restream an old reply
// after Thought/Execute. A short token that matches the start of the
// reply (CJK, "The", "先") is held until the next chunk: if the text
// diverges it was new and must be kept; if it keeps matching, it was
// a restream and must not be appended.

export const RESTREAM_MIN = 8;

export interface StreamMerge {
  append: string;
  next: string;
  acc: string;
}

export function mergeStreamChunk(have: string, incoming: string, acc = ''): StreamMerge | null {
  if (!incoming) return null;
  if (!have) return { append: incoming, next: incoming, acc: '' };
  if (incoming === have) return acc ? { append: '', next: have, acc: '' } : null;
  if (incoming.startsWith(have)) {
    const extra = incoming.slice(have.length);
    return extra ? { append: extra, next: incoming, acc: '' } : null;
  }
  if (!acc && incoming.length >= RESTREAM_MIN && have.endsWith(incoming)) return null;
  const held = acc + incoming;
  if (have.startsWith(held) && held.length < have.length) {
    return { append: '', next: have, acc: held };
  }
  if (acc) {
    const extra = acc + incoming;
    return { append: extra, next: have + extra, acc: '' };
  }
  if (have.startsWith(incoming)) return null;
  return { append: incoming, next: have + incoming, acc: '' };
}

/** After a thought/tool gap: reuse the last reply only for a true restream. */
export function mergeAfterGap(
  prev: string,
  incoming: string,
  acc: string,
): { kind: 'skip'; acc: string } | { kind: 'reuse'; append: string; next: string } | { kind: 'fresh'; append: string; next: string } {
  if (!incoming) return { kind: 'skip', acc };
  if (!prev) return { kind: 'fresh', append: incoming, next: incoming };
  if (incoming === prev) return { kind: 'skip', acc: '' };
  if (incoming.startsWith(prev)) {
    const extra = incoming.slice(prev.length);
    return extra
      ? { kind: 'reuse', append: extra, next: incoming }
      : { kind: 'skip', acc: '' };
  }
  if (prev.startsWith(incoming) && (
    incoming.length >= RESTREAM_MIN || prev.length > incoming.length
  )) {
    return { kind: 'skip', acc: incoming };
  }
  if (acc && prev.startsWith(acc + incoming)) {
    const nextAcc = acc + incoming;
    return { kind: 'skip', acc: nextAcc.length >= prev.length ? '' : nextAcc };
  }
  if (acc) {
    const next = acc + incoming;
    return { kind: 'fresh', append: next, next };
  }
  return { kind: 'fresh', append: incoming, next: incoming };
}

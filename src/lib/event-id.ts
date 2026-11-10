// Live SSE / history event ids are `${Date.now()}-${seq}`.
// Journal backfill uses `backfill-N` / `sess-N` — not comparable to live ids.

export function parseLiveEventId(eid: unknown): { t: number; n: number } | null {
  const m = String(eid || '').match(/^(\d+)-(\d+)$/);
  if (!m) return null;
  return { t: Number(m[1]), n: Number(m[2]) };
}

export function alreadyInHistory(lastId: unknown, eid: unknown): boolean {
  if (!lastId || !eid) return false;
  if (String(eid) === String(lastId)) return true;
  const a = parseLiveEventId(eid);
  const b = parseLiveEventId(lastId);
  // backfill-N / sess-N ids are not comparable to live Date.now()-seq ids.
  // Treating them as numbers used to skip every new SSE event.
  if (!a || !b) return false;
  if (a.t !== b.t) return a.t < b.t;
  return a.n <= b.n;
}

/** Newer of two live ids. Non-live ids are ignored. */
export function maxLiveEventId(a: unknown, b: unknown): string {
  const pa = parseLiveEventId(a);
  const pb = parseLiveEventId(b);
  if (!pa && !pb) return String(a || b || '');
  if (!pa) return String(b);
  if (!pb) return String(a);
  if (pa.t !== pb.t) return pa.t > pb.t ? String(a) : String(b);
  return pa.n >= pb.n ? String(a) : String(b);
}

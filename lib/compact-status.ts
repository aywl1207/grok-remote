// Parse Grok auto-compact lifecycle from ACP / x.ai session updates.

export type CompactPhase = 'started' | 'checkpoint' | 'completed' | 'failed';

export interface CompactUpdate {
  phase: CompactPhase;
  reason?: string;
  percentage?: number;
  tokensUsed?: number;
  contextWindow?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  elapsedMs?: number;
  summaryPreview?: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? v as Record<string, unknown> : null;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

export function compactPhaseOf(name: string): CompactPhase | null {
  const s = String(name || '');
  if (s === 'auto_compact_started' || s === 'compact_started') return 'started';
  if (s === 'compaction_checkpoint') return 'checkpoint';
  if (s === 'auto_compact_failed' || s === 'auto_compact_cancelled' || s === 'compact_failed') {
    return 'failed';
  }
  if (s === 'auto_compact_completed' || s === 'compact_completed' || s === 'session_summary_generated') {
    return 'completed';
  }
  return null;
}

/** Pull the inner sessionUpdate object from SSE / journal envelopes. */
export function compactUpdateRecord(payload: unknown): Record<string, unknown> | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const params = asRecord(rec['params']) || rec;
  const update = asRecord(params['update']) || asRecord(rec['update']);
  if (update && (update['sessionUpdate'] || update['tokens_used'] || update['tokens_before'])) return update;
  if (rec['sessionUpdate']) return rec;
  return update;
}

export function compactUpdateFromPayload(name: string, payload: unknown): CompactUpdate | null {
  const update = compactUpdateRecord(payload) || {};
  const su = str(update['sessionUpdate']) || name;
  const phase = compactPhaseOf(su);
  if (!phase) return null;
  return {
    phase,
    reason: str(update['reason']),
    percentage: num(update['percentage']),
    tokensUsed: num(update['tokens_used'] ?? update['tokensUsed']),
    contextWindow: num(update['context_window'] ?? update['contextWindow']),
    tokensBefore: num(update['tokens_before'] ?? update['tokensBefore']),
    tokensAfter: num(update['tokens_after'] ?? update['tokensAfter']),
    elapsedMs: num(update['elapsed_ms'] ?? update['elapsedMs']),
    summaryPreview: str(update['summary_preview'] ?? update['summary'] ?? update['text']) || null,
  };
}

export function compactPayloadIsReplay(payload: unknown): boolean {
  const rec = asRecord(payload);
  if (!rec) return false;
  const params = asRecord(rec['params']) || rec;
  const meta = asRecord(params['_meta']) || asRecord(rec['_meta']);
  return !!(meta && meta['isReplay'] === true);
}

export function compactingPreview(u: CompactUpdate): string {
  if (u.phase === 'failed') {
    return u.reason || u.summaryPreview || 'Compact failed';
  }
  if (u.phase === 'completed') {
    if (u.tokensBefore != null && u.tokensAfter != null) {
      return `${u.tokensBefore.toLocaleString()} → ${u.tokensAfter.toLocaleString()} tokens`;
    }
    return u.summaryPreview || 'Context compacted';
  }
  if (u.phase === 'checkpoint') return 'Saving checkpoint…';
  const bits: string[] = [];
  if (u.reason) bits.push(u.reason);
  else if (u.percentage != null) bits.push(`Context window ${Math.round(u.percentage)}% full`);
  if (u.tokensUsed != null && u.contextWindow != null) {
    bits.push(`${u.tokensUsed.toLocaleString()} / ${u.contextWindow.toLocaleString()}`);
  } else if (u.tokensUsed != null) {
    bits.push(`${u.tokensUsed.toLocaleString()} tokens`);
  }
  return bits.join(' · ') || 'Compressing conversation history';
}

/** True when this journal/SSE event is a compact lifecycle update. */
export function isCompactJournalEvent(name: string, payload?: unknown): boolean {
  if (compactPhaseOf(String(name || ''))) return true;
  const n = String(name || '');
  if (n !== 'x.ai/session/update' && n !== 'session/update' && n !== '_x.ai/session/update') {
    return false;
  }
  return compactUpdateFromPayload(n, payload) != null;
}

/** Attach restreams old compact with isReplay. Live compact during a turn must paint. */
export function shouldPaintCompactStarted(opts: {
  fromHistory?: boolean;
  replaying?: boolean;
  isReplay?: boolean;
  turnOpen?: boolean;
}): boolean {
  if (opts.fromHistory || opts.replaying) return false;
  if (opts.isReplay && !opts.turnOpen) return false;
  return true;
}

/** Late ACP "started" after THIS compact already finished. Do not use a
 *  leftover finished flag from history / a previous compact — that hid
 *  Compacting… on the next auto-compact. */
export const COMPACT_STARTED_ECHO_MS = 4_000;

export function shouldIgnoreLateCompactStarted(opts: {
  compacting?: boolean;
  compactFinished?: boolean;
  finishedAt?: number | null;
  now?: number;
  echoWindowMs?: number;
}): boolean {
  if (opts.compacting) return false;
  if (!opts.compactFinished) return false;
  const at = opts.finishedAt;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return false;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const windowMs = typeof opts.echoWindowMs === 'number' ? opts.echoWindowMs : COMPACT_STARTED_ECHO_MS;
  const ago = now - at;
  return ago >= 0 && ago < windowMs;
}

export function compactRpcTries(sessionId: string, context?: string): Array<{ method: string; params: Record<string, unknown> }> {
  const sid = String(sessionId || '').trim();
  const note = String(context || '').trim();
  const params: Record<string, unknown> = { sessionId: sid };
  if (note) {
    params['context'] = note;
    params['user_context'] = note;
  }
  return [
    { method: 'x.ai/compact_conversation', params },
    { method: '_x.ai/compact_conversation', params },
    { method: 'x.ai/session/compact', params },
    { method: '_x.ai/session/compact', params },
    { method: 'session/compact', params },
    { method: 'session.compact', params },
  ];
}

export function compactUsageTries(sessionId: string): Array<{ method: string; params: Record<string, unknown> }> {
  const sid = String(sessionId || '').trim();
  const params: Record<string, unknown> = { sessionId: sid };
  return [
    { method: 'x.ai/session/usage', params },
    { method: '_x.ai/session/usage', params },
  ];
}

/** Lifetime billing totals from session/usage are not context occupancy. */
export const MAX_CONTEXT_OCCUPANCY = 10_000_000;

function occupancyNum(v: unknown): number | undefined {
  const n = num(v);
  if (n == null || n > MAX_CONTEXT_OCCUPANCY) return undefined;
  return n;
}

/** Best-effort occupancy from a compact RPC result or session/usage payload. */
export function occupancyFromUnknown(v: unknown, preferAfter = true): number | undefined {
  const rec = asRecord(v);
  if (!rec) return occupancyNum(v);
  const keys = preferAfter
    ? ['tokens_after', 'tokensAfter', 'tokens_used', 'tokensUsed', 'totalTokens', 'total_tokens']
    : ['tokens_before', 'tokensBefore', 'tokens_used', 'tokensUsed', 'totalTokens', 'total_tokens'];
  for (const k of keys) {
    const n = occupancyNum(rec[k]);
    if (n != null) return n;
  }
  for (const k of ['usage', 'result', 'data', 'update']) {
    const nested = asRecord(rec[k]);
    if (!nested) continue;
    const n = occupancyFromUnknown(nested, preferAfter);
    if (n != null) return n;
  }
  return undefined;
}

/** How long to wait for x.ai/compact_conversation. It blocks while Grok rewrites context (~90s). */
export const COMPACT_RPC_TIMEOUT_MS = 120_000;

/** Occupancy from a live auto_compact_completed update, only when it actually dropped. */
export function tokensAfterFromCompactUpdate(update: unknown): number | undefined {
  const rec = asRecord(update);
  if (!rec) return undefined;
  const su = str(rec['sessionUpdate']);
  if (su !== 'auto_compact_completed' && su !== 'compact_completed') return undefined;
  const before = num(rec['tokens_before'] ?? rec['tokensBefore']);
  const after = plausibleCompactAfter({
    tokensBefore: before,
    tokensAfter: num(rec['tokens_after'] ?? rec['tokensAfter']),
  });
  if (typeof after !== 'number') return undefined;
  if (typeof before === 'number' && after >= before) return undefined;
  return after;
}

/** Compact should drop occupancy. Reject after-counts that went up or are huge. */
export function plausibleCompactAfter(opts: {
  tokensBefore?: number;
  tokensAfter?: number;
}): number | undefined {
  const after = opts.tokensAfter;
  if (typeof after !== 'number' || !Number.isFinite(after) || after < 0) return undefined;
  if (after > MAX_CONTEXT_OCCUPANCY) return undefined;
  const before = opts.tokensBefore;
  if (typeof before === 'number' && after > before) return undefined;
  return after;
}

/** Minimum drop before we believe compact actually ran (not a prompt-ack token field). */
export const MIN_COMPACT_DROP_TOKENS = 1_000;
export const MIN_COMPACT_DROP_RATIO = 0.05;

export function compactDroppedEnough(opts: {
  tokensBefore?: number;
  tokensAfter?: number;
}): boolean {
  const before = opts.tokensBefore;
  const after = opts.tokensAfter;
  if (typeof before !== 'number' || !Number.isFinite(before) || before <= 0) return false;
  if (typeof after !== 'number' || !Number.isFinite(after) || after < 0) return false;
  if (after >= before) return false;
  const drop = before - after;
  return drop >= MIN_COMPACT_DROP_TOKENS || drop / before >= MIN_COMPACT_DROP_RATIO;
}


/** Second Compact Now while RPC is running: ack without a second RPC or started event. */
export function compactInFlightAck(): { ok: true; rpc: 'in-flight' } {
  return { ok: true, rpc: 'in-flight' };
}

/** Slash-command fallback when the hold ACP does not expose compact_conversation. */
export function compactPromptText(context?: string): string {
  const note = String(context || '').trim();
  return note ? `/compact ${note}` : '/compact';
}

export function isAcpMethodMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return /method not found|unknown method|not supported by this agent version/i.test(msg);
}

/** Keep walking the compact RPC alias list when this agent lacks the method. */
export function compactRpcShouldTryNext(err: unknown): boolean {
  return isAcpMethodMissing(err);
}


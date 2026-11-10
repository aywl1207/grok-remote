// Context occupancy + auto-compact status. Pure. No filesystem.

export const DEFAULT_CONTEXT_WINDOW = 500_000;
export const DEFAULT_COMPACT_PERCENT = 80;

export type ContextLevel = 'ok' | 'warn' | 'soon';

export interface ContextStatus {
  model: string;
  used: number;
  window: number;
  windowKnown: boolean;
  percent: number;
  compactAtPercent: number;
  compactAtKnown: boolean;
  compactAtTokens: number;
  remainingToCompact: number;
  compactionsRemaining: number | null;
  level: ContextLevel;
  windows: number[];
}

function windowList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const item of raw) {
    const n = typeof item === 'number' ? item : Number(item);
    if (!Number.isFinite(n) || n <= 0) continue;
    const v = Math.floor(n);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function deriveContextStatus(opts: {
  used?: number;
  window?: number | null;
  compactAtPercent?: number;
  compactAtKnown?: boolean;
  compactionsRemaining?: number | null;
  model?: string;
  windows?: number[];
}): ContextStatus {
  const used = Math.max(0, Number(opts.used) || 0);
  const rawWindow = Number(opts.window);
  const windowKnown = Number.isFinite(rawWindow) && rawWindow > 0;
  const window = windowKnown ? Math.floor(rawWindow) : DEFAULT_CONTEXT_WINDOW;
  const pctRaw = Number(opts.compactAtPercent);
  const pctValid = Number.isFinite(pctRaw) && pctRaw > 0 && pctRaw <= 100;
  // An omitted percent is not a reported threshold. Do not warn off the fallback 80.
  const compactAtKnown = opts.compactAtKnown === true || (opts.compactAtKnown !== false && pctValid);
  const pct = pctValid ? pctRaw : DEFAULT_COMPACT_PERCENT;
  const compactAtTokens = Math.floor(window * (pct / 100));
  const remainingToCompact = Math.max(0, compactAtTokens - used);
  const percent = window > 0 ? Math.min(100, (used / window) * 100) : 0;
  const ofLine = compactAtTokens > 0 ? used / compactAtTokens : 0;
  let level: ContextLevel = 'ok';
  if (compactAtKnown) {
    if (ofLine >= 1 || percent >= pct) level = 'soon';
    else if (ofLine >= 0.75 || percent >= pct * 0.75) level = 'warn';
  }
  return {
    model: String(opts.model || ''),
    used,
    window,
    windowKnown,
    percent,
    compactAtPercent: pct,
    compactAtKnown,
    compactAtTokens,
    remainingToCompact,
    compactionsRemaining: typeof opts.compactionsRemaining === 'number'
      ? opts.compactionsRemaining
      : null,
    level,
    windows: windowList(opts.windows),
  };
}

export function contextPillLabel(st: ContextStatus): string {
  const used = formatTokensShort(st.used);
  if (!st.used) return 'ctx';
  if (!st.windowKnown) return used;
  const pct = st.percent < 10 ? st.percent.toFixed(1) : String(Math.round(st.percent));
  return `${used} / ${formatTokensShort(st.window)} · ${pct}%`;
}

export function formatTokensShort(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

export function occupancyFromMeta(meta: unknown): number | null {
  if (!meta || typeof meta !== 'object') return null;
  const rec = meta as { totalTokens?: unknown; total_tokens?: unknown };
  const tt = rec.totalTokens ?? rec.total_tokens;
  if (typeof tt !== 'number' || !Number.isFinite(tt) || tt < 0) return null;
  return tt;
}

/** History replay walks older turns after the latest. Those must not clobber live occupancy. */
export function shouldApplyLiveOccupancy(opts: {
  fromHistory?: boolean;
  replaying?: boolean;
  isReplay?: boolean;
}): boolean {
  if (opts.fromHistory || opts.replaying || opts.isReplay) return false;
  return true;
}

export function pickUsedTokens(opts: { live?: number | null; snap?: number | null }): number {
  const live = opts.live;
  if (typeof live === 'number' && live >= 0) return live;
  const snap = opts.snap;
  if (typeof snap === 'number' && snap >= 0) return snap;
  return 0;
}

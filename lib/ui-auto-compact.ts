// Grok's engine auto-compacts off the catalog window for known models
// (grok-4.6 is 500k in models_cache.json). config.toml context_window on a
// known model does not shrink that engine window. Grok Remote therefore
// calls compact() when occupancy hits the *config* line the UI already shows.

import { deriveContextStatus } from './context-status.js';

export interface UiAutoCompactInput {
  used: number;
  window: number;
  compactAtPercent: number;
  armed?: boolean;
  inFlight?: boolean;
  turnOpen?: boolean;
  allowDuringTurn?: boolean;
  enabled?: boolean;
  now?: number;
  retryAt?: number;
  /** True when a user prompt is about to be sent. Skip compact; after-turn covers occupancy. */
  sendingPrompt?: boolean;
  /** True while a tool call is still pending. Compact must not steal the turn. */
  toolsLive?: boolean;
}

export interface UiAutoCompactDecision {
  action: 'compact' | 'skip';
  compactAtTokens: number;
  nextArmed: boolean;
  reason: string;
}

export function uiAutoCompactEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['GROK_REMOTE_UI_AUTO_COMPACT'];
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** Re-arm once occupancy is back under 90% of the compact line. */
export function rearmAtTokens(compactAtTokens: number): number {
  const line = Math.max(0, Math.floor(Number(compactAtTokens) || 0));
  return Math.floor(line * 0.9);
}

export function decideUiAutoCompact(opts: UiAutoCompactInput): UiAutoCompactDecision {
  const st = deriveContextStatus({
    used: opts.used,
    window: opts.window,
    compactAtPercent: opts.compactAtPercent,
  });
  const line = st.compactAtTokens;
  const rearmAt = rearmAtTokens(line);
  const used = st.used;
  const over = line > 0 && used >= line;

  if (opts.enabled === false) {
    return { action: 'skip', compactAtTokens: line, nextArmed: true, reason: 'disabled' };
  }
  if (st.windowKnown && used > st.window * 4) {
    return { action: 'skip', compactAtTokens: line, nextArmed: true, reason: 'implausible-occupancy' };
  }
  if (opts.inFlight) {
    return { action: 'skip', compactAtTokens: line, nextArmed: false, reason: 'in-flight' };
  }

  let armed = opts.armed !== false;
  if (!armed && used < rearmAt) armed = true;

  const retryAt = typeof opts.retryAt === 'number' ? opts.retryAt : 0;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (retryAt > now) {
    return { action: 'skip', compactAtTokens: line, nextArmed: armed, reason: 'cooldown' };
  }

  if (!over) {
    return { action: 'skip', compactAtTokens: line, nextArmed: true, reason: 'under-line' };
  }
  if (!armed) {
    return { action: 'skip', compactAtTokens: line, nextArmed: false, reason: 'disarmed' };
  }
  if (opts.sendingPrompt) {
    // Do not compact on the before-prompt path. The turn is about to open;
    // after-turn (and session-ready) already cover occupancy.
    return { action: 'skip', compactAtTokens: line, nextArmed: true, reason: 'sending-prompt' };
  }
  if (opts.toolsLive) {
    return { action: 'skip', compactAtTokens: line, nextArmed: true, reason: 'tools-live' };
  }
  if (opts.turnOpen && !opts.allowDuringTurn) {
    return { action: 'skip', compactAtTokens: line, nextArmed: true, reason: 'turn-open' };
  }
  return { action: 'compact', compactAtTokens: line, nextArmed: false, reason: 'over-line' };
}

export function nextArmedAfterCompact(opts: {
  usedAfter: number | undefined;
  compactAtTokens: number;
}): boolean {
  const line = Math.max(0, Math.floor(Number(opts.compactAtTokens) || 0));
  if (!(line > 0)) return true;
  if (typeof opts.usedAfter !== 'number' || !Number.isFinite(opts.usedAfter)) return false;
  return opts.usedAfter < rearmAtTokens(line);
}

export const UI_AUTO_COMPACT_FAIL_COOLDOWN_MS = 120_000;

/** In-flight ack must not re-arm: the owner compact decides armed/cooldown. */
export function armedAfterInFlightAck(): boolean {
  return false;
}

export function armedAfterCompactOutcome(opts: {
  rpc: string;
  usedAfter?: number;
  compactAtTokens: number;
  dropped?: boolean;
}): { armed: boolean; cooldown: boolean } {
  if (opts.rpc === 'in-flight') return { armed: false, cooldown: false };
  if (opts.rpc === 'unsupported' || opts.rpc === 'session/prompt') {
    // Prompt fallback is not a real compact RPC. Stay down so occupancy
    // events cannot start another /compact turn that grows the context.
    if (opts.dropped === true) {
      return {
        armed: nextArmedAfterCompact({
          usedAfter: opts.usedAfter,
          compactAtTokens: opts.compactAtTokens,
        }),
        cooldown: false,
      };
    }
    return { armed: false, cooldown: true };
  }
  if (opts.dropped === false) return { armed: false, cooldown: true };
  return {
    armed: nextArmedAfterCompact({
      usedAfter: opts.usedAfter,
      compactAtTokens: opts.compactAtTokens,
    }),
    cooldown: false,
  };
}

// Chat stream follow: do not treat our own scrollTop writes as the user
// scrolling away. That was turning auto-follow off right after Send.

export type ScrollFollowAction = 'keep' | 'pause' | 'resume';

export interface ScrollFollowOpts {
  atBottom: boolean;
  autoScroll: boolean;
  userScrollIntent: boolean;
  lastEasedWrite: number | null | undefined;
  scrollTop: number;
  programmaticUntil?: number;
  now?: number;
}

export function scrollFollowAction(opts: ScrollFollowOpts): ScrollFollowAction {
  const now = opts.now != null ? opts.now : Date.now();
  const ourWrite = opts.lastEasedWrite != null
    && Math.abs(opts.scrollTop - opts.lastEasedWrite) <= 4;
  const inWindow = !!(opts.programmaticUntil && now < opts.programmaticUntil);
  if ((ourWrite || inWindow) && !opts.userScrollIntent) return 'keep';
  if (opts.atBottom) return 'resume';
  if (opts.autoScroll) return 'pause';
  return 'keep';
}

export function liveTurnUsesHistoryPin(isReplaying: boolean, fromHistory?: boolean): boolean {
  return !!(isReplaying || fromHistory);
}

export function applyForceScrollFlags(view: {
  _quietScroll?: boolean;
  _autoScroll?: boolean;
  _userScrollIntent?: boolean;
  _programmaticScrollUntil?: number;
}): void {
  view._quietScroll = false;
  view._autoScroll = true;
  view._userScrollIntent = false;
  view._programmaticScrollUntil = Date.now() + 160;
}

/** Pause follow so prepending older turns cannot snap the stream to Latest. */
export function holdScrollForPrepend(view: {
  _quietScroll?: boolean;
  _autoScroll?: boolean;
  _userScrollIntent?: boolean;
  _easedScrollPending?: boolean;
  _easedScrollRaf?: number;
}): void {
  view._quietScroll = true;
  view._autoScroll = false;
  view._userScrollIntent = true;
  view._easedScrollPending = false;
  if (view._easedScrollRaf) {
    cancelAnimationFrame(view._easedScrollRaf);
    view._easedScrollRaf = 0;
  }
}

export function pinScrollDelta(beforeTop: number, afterTop: number): number {
  if (!Number.isFinite(beforeTop) || !Number.isFinite(afterTop)) return 0;
  return afterTop - beforeTop;
}

export function restorePinScroll(
  stream: { scrollTop: number },
  pinTopBefore: number,
  pinTopAfter: number,
): number {
  const next = Math.max(0, stream.scrollTop + pinScrollDelta(pinTopBefore, pinTopAfter));
  stream.scrollTop = next;
  return next;
}


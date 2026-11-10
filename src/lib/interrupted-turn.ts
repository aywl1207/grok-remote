// A crash marker only when the last user turn never received a reply.
// Idle is not enough: a message that is about to start has the same shape.

const INTERRUPTED = new Set(['errored', 'disconnected', 'exited', 'killed']);

export function shouldMarkInterruptedTurn(opts: {
  userText?: unknown;
  hasAssistant?: boolean;
  hasTools?: boolean;
  turnOpen?: boolean;
  status?: unknown;
}): boolean {
  const status = String(opts.status || '').trim().toLowerCase();
  if (!INTERRUPTED.has(status)) return false;
  if (opts.turnOpen) return false;
  if (!String(opts.userText || '').trim()) return false;
  if (opts.hasAssistant) return false;
  if (opts.hasTools) return false;
  return true;
}

// prompt_complete vs cards still painted Pending.

export type PromptCompleteGate = 'wait' | 'close-and-finish' | 'finish';

export function promptCompleteGate(opts: {
  localInFlight?: number;
  openTools?: boolean;
  serverFlight?: number;
}): PromptCompleteGate {
  const local = Math.max(0, Number(opts.localInFlight) || 0);
  const server = Math.max(0, Number(opts.serverFlight) || 0);
  if (local > 0 || opts.openTools) {
    if (server > 0) return 'wait';
    return 'close-and-finish';
  }
  return 'finish';
}

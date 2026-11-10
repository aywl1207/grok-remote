// Which conversation settings require a new grok process (new hold argv).

const ARGV_KEYS = [
  'model',
  'reasoningEffort',
  'systemPromptOverride',
  'rules',
  'tools',
  'disallowedTools',
  'sandbox',
  'worktree',
  'alwaysApprove',
  'permissionMode',
  'autoMode',
] as const;

function norm(v: unknown): string {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => String(x)));
  if (typeof v === 'boolean') return v ? '1' : '';
  return String(v);
}

export function settingsNeedNewHold(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): boolean {
  const a = prev || {};
  const b = next || {};
  for (const k of ARGV_KEYS) {
    if (norm(a[k]) !== norm(b[k])) return true;
  }
  if (norm(a.allow) !== norm(b.allow)) return true;
  if (norm(a.deny) !== norm(b.deny)) return true;
  return false;
}

export function settingsNeedHoldAfterRuntime(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
  runtimeApplied: boolean,
): boolean {
  if (!settingsNeedNewHold(prev, next)) return false;
  if (!runtimeApplied) return true;
  // Model was applied live. Effort / tools / argv still need a new hold.
  const a = prev || {};
  const b = next || {};
  for (const k of ARGV_KEYS) {
    if (k === 'model') continue;
    if (norm(a[k]) !== norm(b[k])) return true;
  }
  if (norm(a.allow) !== norm(b.allow)) return true;
  if (norm(a.deny) !== norm(b.deny)) return true;
  return false;
}


export function settingsNeedFreshSession(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): boolean {
  const a = prev || {};
  const b = next || {};
  return norm(a.model) !== norm(b.model)
    || norm(a.reasoningEffort) !== norm(b.reasoningEffort);
}

// Permission-mode helpers. Plan is a separate agent command, not a setting.

export type PermissionMode = 'ask' | 'auto' | 'always-approve';

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'always-approve'];

export function readPermissionMode(settings: unknown): PermissionMode {
  const s = settings && typeof settings === 'object'
    ? settings as Record<string, unknown>
    : {};
  if (s.alwaysApprove === false) return s.permissionMode === 'auto' ? 'auto' : 'ask';
  return 'always-approve';
}

export function permissionLabel(mode: PermissionMode): string {
  if (mode === 'ask') return 'Ask';
  if (mode === 'auto') return 'Auto';
  return 'Always-Approve';
}

export function cyclePermissionMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.indexOf(mode);
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]!;
}

export function permissionSettingsPatch(mode: PermissionMode): {
  alwaysApprove: boolean;
  permissionMode: PermissionMode;
  autoMode: boolean;
} {
  return {
    alwaysApprove: mode === 'always-approve',
    permissionMode: mode,
    autoMode: mode === 'auto',
  };
}

export function permissionNeedsReconnect(mode: PermissionMode): boolean {
  return mode !== 'always-approve';
}

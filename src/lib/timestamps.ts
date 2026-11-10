// Message clocks: on, minimal (hover), or off.
// Stored values 1/missing stay on, 0 stays off.

const KEY = 'grok-remote.timestamps';

export type TimestampMode = 'off' | 'minimal' | 'on';

export function parseTimestampMode(stored: string | null | undefined): TimestampMode {
  const v = String(stored || '').trim().toLowerCase();
  if (v === '0' || v === 'off' || v === 'false') return 'off';
  if (v === 'minimal' || v === 'min') return 'minimal';
  return 'on';
}

export function nextTimestampMode(mode: TimestampMode): TimestampMode {
  if (mode === 'on') return 'minimal';
  if (mode === 'minimal') return 'off';
  return 'on';
}

export function timestampModeLabel(mode: TimestampMode): string {
  if (mode === 'off') return 'Off';
  if (mode === 'minimal') return 'Minimal';
  return 'On';
}

export function timestampMode(): TimestampMode {
  try { return parseTimestampMode(localStorage.getItem(KEY)); }
  catch { return 'on'; }
}

export function timestampsEnabled(): boolean {
  return timestampMode() !== 'off';
}

export function setTimestampMode(mode: TimestampMode): void {
  const stored = mode === 'off' ? '0' : mode === 'minimal' ? 'minimal' : '1';
  try { localStorage.setItem(KEY, stored); }
  catch { /* ignore */ }
  applyTimestampsAttr();
}

export function setTimestampsEnabled(on: boolean): void {
  setTimestampMode(on ? 'on' : 'off');
}

export function cycleTimestampMode(): TimestampMode {
  const next = nextTimestampMode(timestampMode());
  setTimestampMode(next);
  return next;
}

export function toggleTimestamps(): boolean {
  const next = cycleTimestampMode();
  return next !== 'off';
}

export function applyTimestampsAttr(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.timestamps = timestampMode();
}

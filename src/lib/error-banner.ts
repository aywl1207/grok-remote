// Live Error banners. Empty ACP payloads stringify as "{}" on disconnect
// and must not stick around after reconnect.

export function errorBannerText(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === 'string') return cleanBannerText(data);
  if (typeof data !== 'object') return cleanBannerText(String(data));
  const rec = data as Record<string, unknown>;
  const raw = rec.message ?? rec.error ?? rec.reason;
  if (typeof raw === 'string') return cleanBannerText(raw);
  if (raw && typeof raw === 'object') return errorBannerText(raw);
  return null;
}

export function cleanBannerText(text: string): string | null {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t === '{}' || t === '[]' || t === 'null' || t === 'undefined' || t === '[object Object]') return null;
  if (/agent exited/i.test(t)) return null;
  if (/user_request/i.test(t)) return null;
  return t;
}

export function shouldClearErrorBanners(
  prev: { status?: string; connected?: boolean } | null | undefined,
  next: { status?: string; connected?: boolean } | null | undefined,
): boolean {
  if (!next) return false;
  const nextUp = agentLooksConnected(next);
  if (!nextUp) return false;
  if (!prev) return false;
  return !agentLooksConnected(prev);
}

export function agentLooksConnected(a: { status?: string; connected?: boolean } | null | undefined): boolean {
  if (!a) return false;
  if (a.connected === false) return false;
  const st = String(a.status || '');
  if (st === 'disconnected' || st === 'exited' || st === 'errored') return false;
  return true;
}

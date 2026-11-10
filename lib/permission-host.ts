// session/request_permission — auto-approve or wait for the web UI.

export interface PermissionOutcome {
  outcome: {
    outcome: 'selected' | 'cancelled' | string;
    optionId?: string;
  };
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface PermissionRequest {
  requestId: string;
  toolCall?: Record<string, unknown> | null;
  options: PermissionOption[];
  raw: unknown;
}

export interface PermissionHost {
  auto: boolean;
  requestPermission(params?: unknown): Promise<PermissionOutcome>;
  respond(requestId: string, optionId: string): boolean;
  setAuto(auto: boolean): void;
  pending(): PermissionRequest[];
}

export function createPermissionHost(opts?: {
  onRequest?: (req: PermissionRequest) => void;
}): PermissionHost {
  const waiting = new Map<string, { resolve: (v: PermissionOutcome) => void; req: PermissionRequest }>();
  let seq = 0;
  const host: PermissionHost = {
    auto: true,
    setAuto(auto: boolean) { host.auto = !!auto; },
    pending() { return [...waiting.values()].map((w) => w.req); },
    respond(requestId: string, optionId: string) {
      const w = waiting.get(requestId);
      if (!w) return false;
      waiting.delete(requestId);
      const cancelled = optionId === 'cancelled' || optionId === 'reject' || optionId === 'reject_once';
      w.resolve({
        outcome: {
          outcome: cancelled ? 'cancelled' : 'selected',
          optionId,
        },
      });
      return true;
    },
    async requestPermission(params?: unknown): Promise<PermissionOutcome> {
      if (host.auto) {
        return { outcome: { outcome: 'selected', optionId: 'allow_always' } };
      }
      const rec = (params && typeof params === 'object') ? params as Record<string, unknown> : {};
      const toolCall = (rec.toolCall && typeof rec.toolCall === 'object')
        ? rec.toolCall as Record<string, unknown>
        : (rec.update && typeof rec.update === 'object' ? rec.update as Record<string, unknown> : rec);
      let options: PermissionOption[] = [];
      const rawOpts = rec.options;
      if (Array.isArray(rawOpts)) {
        for (const o of rawOpts) {
          if (!o || typeof o !== 'object') continue;
          const r = o as Record<string, unknown>;
          const optionId = String(r.optionId || r.id || '');
          if (!optionId) continue;
          options.push({ optionId, name: String(r.name || r.label || optionId), kind: r.kind ? String(r.kind) : undefined });
        }
      }
      const ri = toolCall && toolCall.rawInput && typeof toolCall.rawInput === 'object'
        ? toolCall.rawInput as Record<string, unknown>
        : null;
      if (!options.length && ri && Array.isArray(ri.options)) {
        for (const o of ri.options) {
          if (!o || typeof o !== 'object') continue;
          const r = o as Record<string, unknown>;
          const optionId = String(r.id || r.optionId || r.label || '');
          if (!optionId) continue;
          options.push({ optionId, name: String(r.label || r.name || optionId) });
        }
      }
      if (!options.length) {
        options = [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ];
      }
      const requestId = `perm-${++seq}`;
      const req: PermissionRequest = { requestId, toolCall, options, raw: params };
      return new Promise((resolve) => {
        waiting.set(requestId, { resolve, req });
        try { opts?.onRequest?.(req); } catch { /* ignore */ }
      });
    },
  };
  return host;
}

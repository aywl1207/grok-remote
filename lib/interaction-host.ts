// Reverse-requests the TUI implements: plan approval + user questions.
// Grok sends JSON-RPC requests `_x.ai/exit_plan_mode` and `_x.ai/ask_user_question`.

export interface InteractionRequest {
  requestId: string;
  kind: 'exit_plan_mode' | 'ask_user_question';
  params: Record<string, unknown>;
}

export interface InteractionHost {
  request(kind: InteractionRequest['kind'], params?: unknown): Promise<unknown>;
  respond(requestId: string, result: unknown): boolean;
  pending(): InteractionRequest[];
}

export function createInteractionHost(opts?: {
  onRequest?: (req: InteractionRequest) => void;
}): InteractionHost {
  const waiting = new Map<string, { resolve: (v: unknown) => void; req: InteractionRequest }>();
  let seq = 0;
  const host: InteractionHost = {
    pending() { return [...waiting.values()].map((w) => w.req); },
    respond(requestId, result) {
      const w = waiting.get(requestId);
      if (!w) return false;
      waiting.delete(requestId);
      w.resolve(result);
      return true;
    },
    request(kind, params) {
      const rec = (params && typeof params === 'object') ? params as Record<string, unknown> : {};
      const requestId = `ix-${kind}-${++seq}`;
      const req: InteractionRequest = { requestId, kind, params: rec };
      return new Promise((resolve) => {
        waiting.set(requestId, { resolve, req });
        try { opts?.onRequest?.(req); } catch { /* ignore */ }
      });
    },
  };
  return host;
}

export function buildExitPlanModeResult(action: string, feedback?: string): unknown {
  const a = String(action || '').toLowerCase().replace(/-/g, '_');
  if (a === 'abandoned' || a === 'abandon' || a === 'quit') {
    return { type: 'abandoned' };
  }
  if (a === 'request_changes' || a === 'changes' || a === 'reject') {
    return { type: 'request_changes', feedback: String(feedback || '').trim() || 'Please revise the plan.' };
  }
  return { type: 'approved' };
}

export function buildAskUserQuestionResult(
  action: string,
  answers?: unknown,
): unknown {
  const a = String(action || '').toLowerCase().replace(/-/g, '_');
  if (a === 'skip' || a === 'skip_interview' || a === 'skipinterview') {
    return { type: 'skip_interview' };
  }
  return { type: 'accepted', answers: answers ?? [] };
}

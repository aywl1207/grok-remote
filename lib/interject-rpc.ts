/** ACP mid-turn interject aliases. TUI uses x.ai/queue/interject; stdio may differ. */

import { isAcpMethodMissing } from './compact-status.js';

export const INTERJECT_RPC_TIMEOUT_MS = 2_000;

export function interjectRpcTries(
  sessionId: string,
  blocks: unknown[],
  text: string,
): Array<{ method: string; params: Record<string, unknown> }> {
  const sid = String(sessionId || '').trim();
  const prompt = Array.isArray(blocks) ? blocks : [];
  const body = String(text || '');
  return [
    { method: 'x.ai/interject', params: { sessionId: sid, prompt } },
    { method: 'x.ai/interject', params: { sessionId: sid, content: prompt, text: body, cancelSubagents: false } },
    { method: 'x.ai/queue/interject', params: { sessionId: sid, prompt } },
    { method: '_x.ai/interject', params: { sessionId: sid, prompt } },
    { method: 'session/interject', params: { sessionId: sid, prompt } },
  ];
}

export function interjectShouldTryNext(err: unknown): boolean {
  if (isAcpMethodMissing(err)) return true;
  const msg = err instanceof Error ? err.message : String(err || '');
  return /invalid params|invalid request|missing field|unknown variant|deserialize|parse|interject timeout/i.test(msg);
}

export function interjectUnsupportedMessage(): string {
  return 'This grok hold cannot interject mid-turn. Message stays queued until the turn ends.';
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'interject timeout'): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

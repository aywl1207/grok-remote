/** ACP rewind aliases. Grok agent stdio exposes execute/points, not x.ai/rewind. */

export function rewindRpcTries(
  sessionId: string,
  keepTurns: number,
): Array<{ method: string; params: Record<string, unknown> }> {
  const sid = String(sessionId || '').trim();
  const keep = Math.max(0, Math.floor(Number(keepTurns) || 0));
  const params: Record<string, unknown> = {
    sessionId: sid,
    promptIndex: keep,
    target_prompt_index: keep,
  };
  return [
    { method: 'x.ai/rewind/execute', params },
    { method: '_x.ai/rewind/execute', params },
    { method: 'x.ai/rewind', params },
    { method: 'x.ai/rewind/to', params },
    { method: 'session/rewind', params },
  ];
}

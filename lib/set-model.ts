// Params for ACP session/set_model.
// Official fields are sessionId + modelId + optional _meta.
// Extra top-level aliases make grok reject the RPC.

export function buildSetModelParams(
  sessionId: string,
  opts: { modelId?: string; reasoningEffort?: string },
): Record<string, unknown> {
  const params: Record<string, unknown> = { sessionId };
  const model = String(opts.modelId || '').trim();
  if (model) params.modelId = model;
  const effort = String(opts.reasoningEffort || '').trim();
  if (effort) params._meta = { reasoningEffort: effort };
  return params;
}

export function modelSettingsChanged(
  prev: { model?: unknown; reasoningEffort?: unknown } | null | undefined,
  next: { model?: unknown; reasoningEffort?: unknown } | null | undefined,
): { modelChanged: boolean; effortChanged: boolean } {
  const pm = String((prev && prev.model) || '').trim();
  const nm = String((next && next.model) || '').trim();
  const pe = String((prev && prev.reasoningEffort) || '').trim();
  const ne = String((next && next.reasoningEffort) || '').trim();
  return { modelChanged: pm !== nm, effortChanged: pe !== ne };
}

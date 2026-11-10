// Identity rules for non-Grok models. Grok's default system prompt
// still says "You are Grok 4.6", so a local model will claim that
// unless we append an explicit correction.

export function isCustomModelId(modelId?: string | null): boolean {
  const id = String(modelId || '').trim();
  if (!id) return false;
  return !/^grok-/i.test(id);
}

export function customModelIdentityRules(modelId?: string | null): string {
  const id = String(modelId || '').trim();
  if (!isCustomModelId(id)) return '';
  return [
    `You are the local model configured as "${id}". You are not Grok, not Grok 4.6, and not built by xAI.`,
    `If asked who you are or which model you are, name "${id}" (the local Ollama / custom model).`,
    'Keep using tools and grok-remote workflows as instructed in the rest of the system prompt.',
  ].join(' ');
}

export function mergeArgvRules(userRules?: string | null, modelId?: string | null): string {
  const identity = customModelIdentityRules(modelId);
  const user = String(userRules || '').trim();
  return [identity, user].filter(Boolean).join('\n\n');
}


const IDENTITY_OPEN = '<identity>';
const IDENTITY_CLOSE = '</identity>';

export function wrapPromptWithIdentity(userText: string, modelId?: string | null): string {
  const identity = customModelIdentityRules(modelId);
  const body = String(userText || '');
  if (!identity) return body;
  return `${IDENTITY_OPEN}\n${identity}\n${IDENTITY_CLOSE}\n\n${body}`;
}

export function stripIdentityWrapper(text: string): string {
  const raw = String(text || '');
  const re = /^\s*<identity>[\s\S]*?<\/identity>\s*/i;
  return raw.replace(re, '');
}

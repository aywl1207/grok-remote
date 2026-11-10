// User-typed rewind targets. Automatic runtime turns are not prompts the user sent.

const AUTO_TAG = /<(system-reminder|scheduled|monitor|runtime|local-command)\b/i;
const AUTO_BRACKET = /\[(scheduled task|monitor event|loop iteration|workflow)\b/i;

export function isAutomaticRuntimePrompt(text: unknown): boolean {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  return AUTO_TAG.test(raw) || AUTO_BRACKET.test(raw);
}

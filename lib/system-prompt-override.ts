// For custom models, grok still prepends "You are Grok 4.6".
// --rules is ignored in `grok agent stdio`. Replace only the identity
// line of a recent grok system prompt and pass --system-prompt-override.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isCustomModelId } from './model-identity.js';

const IDENTITY_RE = /^You are Grok[^\n]*/i;

export function identityLineForModel(modelId: string): string {
  const id = String(modelId || '').trim() || 'the local model';
  return `You are ${id}, a local model running through grok-remote. You are not Grok, not Grok 4.6, and not built by xAI. You are an interactive CLI tool that helps users with software engineering tasks.`;
}

export function rewriteGrokIdentity(prompt: string, modelId: string): string {
  const body = String(prompt || '');
  const line = identityLineForModel(modelId);
  if (IDENTITY_RE.test(body)) return body.replace(IDENTITY_RE, line);
  return `${line}\n\n${body}`;
}

export function findRecentSystemPrompt(cwd?: string | null): string {
  const sessionsRoot = path.join(os.homedir(), '.grok', 'sessions');
  const want = cwd ? encodeURIComponent(path.resolve(cwd)) : '';
  let newest = '';
  let newestM = 0;
  let walk: string[] = [];
  try { walk = fs.readdirSync(sessionsRoot); } catch { return ''; }
  for (const name of walk) {
    if (want && name !== want && !name.startsWith(want)) continue;
    const dir = path.join(sessionsRoot, name);
    let kids: string[] = [];
    try { kids = fs.readdirSync(dir); } catch { continue; }
    for (const sid of kids) {
      const file = path.join(dir, sid, 'system_prompt.txt');
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.mtimeMs < newestM) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes('You are Grok') && text.length > 500) {
          newest = text;
          newestM = st.mtimeMs;
        }
      } catch { /* missing */ }
    }
  }
  return newest;
}

export function systemPromptOverrideForModel(
  modelId?: string | null,
  cwd?: string | null,
): string {
  if (!isCustomModelId(modelId)) return '';
  const template = findRecentSystemPrompt(cwd);
  if (!template) return identityLineForModel(String(modelId));
  return rewriteGrokIdentity(template, String(modelId));
}

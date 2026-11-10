// List saved Grok workflow scripts (*.rhai). This is a catalog, not the
// live /workflows run dashboard.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface WorkflowEntry {
  name: string;
  path: string;
  scope: 'user' | 'project';
  cwd?: string;
  description: string;
  whenToUse: string;
}

export function parseWorkflowMeta(raw: string): { name: string; description: string; whenToUse: string } {
  const text = String(raw || '');
  const pick = (key: string): string => {
    const m = text.match(new RegExp(String.raw`${key}\s*:\s*"([^"]*)"`, 'i'));
    return m && m[1] ? m[1] : '';
  };
  return {
    name: pick('name'),
    description: pick('description'),
    whenToUse: pick('when_to_use') || pick('whenToUse'),
  };
}

function listRhai(dir: string, scope: 'user' | 'project', cwd?: string): WorkflowEntry[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); }
  catch { return []; }
  const out: WorkflowEntry[] = [];
  for (const file of names) {
    if (!file.endsWith('.rhai')) continue;
    const fp = path.join(dir, file);
    let st: fs.Stats;
    try { st = fs.statSync(fp); }
    catch { continue; }
    if (!st.isFile()) continue;
    let raw = '';
    try { raw = fs.readFileSync(fp, 'utf8'); }
    catch { continue; }
    const meta = parseWorkflowMeta(raw);
    const name = meta.name || file.replace(/\.rhai$/i, '');
    out.push({
      name,
      path: fp,
      scope,
      ...(cwd ? { cwd } : {}),
      description: meta.description,
      whenToUse: meta.whenToUse,
    });
  }
  return out;
}

function agentCwds(): string[] {
  const root = path.join(os.homedir(), '.grok-remote', 'agents');
  let ids: string[] = [];
  try { ids = fs.readdirSync(root); }
  catch { return []; }
  const cwds = new Set<string>();
  for (const id of ids) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8')) as { cwd?: unknown };
      if (typeof meta.cwd === 'string' && meta.cwd.trim()) cwds.add(path.resolve(meta.cwd.trim()));
    } catch { /* skip */ }
  }
  return [...cwds];
}

export function listSavedWorkflows(): WorkflowEntry[] {
  const out: WorkflowEntry[] = [];
  out.push(...listRhai(path.join(os.homedir(), '.grok', 'workflows'), 'user'));
  for (const cwd of agentCwds()) {
    out.push(...listRhai(path.join(cwd, '.grok', 'workflows'), 'project', cwd));
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  return out;
}

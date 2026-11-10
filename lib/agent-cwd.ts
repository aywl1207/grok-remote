// Resolve and create a conversation working directory.
// Used by spawn + PATCH cwd. Does not touch holds.

import fs from 'node:fs';
import path from 'node:path';

import { resolveFolderInput } from './conversation-folder.js';

export { PROJECTS_ROOT, resolveFolderInput } from './conversation-folder.js';

export function ensureCwdDir(cwd: string): string {
  const resolved = resolveFolderInput(cwd);
  if (!resolved) throw new Error('folder name required');
  const next = path.resolve(resolved);
  if (!next || next === path.sep) throw new Error('cwd is not a directory');
  let st: fs.Stats | null = null;
  try { st = fs.statSync(next); }
  catch { st = null; }
  if (st && !st.isDirectory()) throw new Error('cwd is not a directory');
  if (!st) fs.mkdirSync(next, { recursive: true });
  st = fs.statSync(next);
  if (!st.isDirectory()) throw new Error('cwd is not a directory');
  return next;
}

// Turn ACP edit payloads into CLI-style ++ / -- rows.

export type DiffRowKind = 'add' | 'del';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
}

export interface FileDiff {
  path: string;
  oldText: string;
  newText: string;
}

const MAX_ROWS = 80;
const TEXT_KEYS = [
  'old_string', 'oldString', 'old_str', 'oldText',
  'new_string', 'newString', 'new_str', 'newText',
  'contents', 'content',
] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function pick(rec: Record<string, unknown> | null, keys: string[]): string | null {
  if (!rec) return null;
  for (const k of keys) {
    const s = str(rec[k]);
    if (s != null) return s;
  }
  return null;
}

function splitLines(s: string): string[] {
  if (!s) return [];
  const parts = s.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function unwrapUpdate(payload: unknown): Record<string, unknown> {
  const rec = asRecord(payload);
  if (!rec) return {};
  const inner = asRecord(rec.update);
  return inner || rec;
}

function diffFromBlock(block: unknown): FileDiff | null {
  const rec = asRecord(block);
  if (!rec) return null;
  const type = str(rec.type);
  if (type && type !== 'diff') return null;
  const newText = pick(rec, ['newText', 'new_text', 'new_string', 'newString']);
  const oldText = pick(rec, ['oldText', 'old_text', 'old_string', 'oldString']);
  if (newText == null && oldText == null) return null;
  return {
    path: pick(rec, ['path', 'file_path', 'filePath']) || '',
    oldText: oldText || '',
    newText: newText || '',
  };
}

function diffFromEdits(edits: unknown, path: string): FileDiff | null {
  if (!Array.isArray(edits) || !edits.length) return null;
  const oldParts: string[] = [];
  const newParts: string[] = [];
  let any = false;
  for (const item of edits) {
    const rec = asRecord(item);
    if (!rec) continue;
    const oldText = pick(rec, ['old_string', 'oldString', 'oldText']);
    const newText = pick(rec, ['new_string', 'newString', 'newText']);
    if (oldText == null && newText == null) continue;
    any = true;
    if (oldParts.length) { oldParts.push(''); newParts.push(''); }
    oldParts.push(oldText || '');
    newParts.push(newText || '');
  }
  if (!any) return null;
  return { path, oldText: oldParts.join('\n'), newText: newParts.join('\n') };
}

export function extractFileDiff(payload: unknown): FileDiff | null {
  const src = unwrapUpdate(payload);
  const content = src.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const d = diffFromBlock(block);
      if (d && (d.oldText || d.newText)) return d;
    }
  } else {
    const d = diffFromBlock(content);
    if (d && (d.oldText || d.newText)) return d;
  }

  const ri = asRecord(src.rawInput) || {};
  const path = pick(ri, ['file_path', 'filePath', 'path', 'target_file'])
    || pick(src, ['title'])
    || '';
  const fromEdits = diffFromEdits(ri.edits, path);
  if (fromEdits) return fromEdits;

  const oldText = pick(ri, ['old_string', 'oldString', 'old_str', 'oldText']);
  const newText = pick(ri, ['new_string', 'newString', 'new_str', 'newText', 'contents', 'content']);
  if (oldText == null && newText == null) return null;
  if (typeof ri.content === 'object' && newText == null) return null;
  return { path, oldText: oldText || '', newText: newText || '' };
}

export function isEditTool(payload: unknown): boolean {
  const src = unwrapUpdate(payload);
  const kind = (str(src.kind) || '').toLowerCase();
  if (kind === 'edit') return true;
  const ri = asRecord(src.rawInput);
  const variant = (pick(ri, ['variant']) || '').toLowerCase();
  return variant === 'searchreplace' || variant === 'write' || variant === 'multiedit';
}

/** CLI-style rows: every old line as `--`, every new line as `++`. */
export function cliDiffRows(oldText: string, newText: string, limit = MAX_ROWS): DiffRow[] {
  const dels = splitLines(oldText).map((text) => ({ kind: 'del' as const, text }));
  const adds = splitLines(newText).map((text) => ({ kind: 'add' as const, text }));
  const all = dels.concat(adds);
  return all.length > limit ? all.slice(0, limit) : all;
}

export function extraDiffCount(oldText: string, newText: string, limit = MAX_ROWS): number {
  const n = splitLines(oldText).length + splitLines(newText).length;
  return n > limit ? n - limit : 0;
}

export function slimDiffString(v: unknown, cap: number): unknown {
  if (typeof v === 'string' && v.length > cap) return v.slice(0, cap) + '…';
  return v;
}

export const DIFF_INPUT_KEYS: readonly string[] = TEXT_KEYS;

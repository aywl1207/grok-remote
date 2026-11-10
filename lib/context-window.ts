// Catalog window from ~/.grok/models_cache.json, then [model."id"] from config.toml.
// Re-reads when those files change (mtime/size). No baked-in per-model window.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_COMPACT_PERCENT,
  DEFAULT_CONTEXT_WINDOW,
  deriveContextStatus,
  type ContextStatus,
} from './context-status.js';

export interface ModelWindow {
  model: string;
  window: number;
  windows: number[];
  compactAtPercent: number;
  compactAtKnown: boolean;
  compactionsRemaining: number | null;
}

export interface ModelWindowOverride {
  context_window?: number;
  auto_compact_threshold_percent?: number;
}

type FileSnap = { path: string; mtimeMs: number; size: number; text: string };

let configSnap: FileSnap | null = null;
let cacheSnap: FileSnap | null = null;

function grokHome(): string {
  const env = String(process.env['GROK_HOME'] || '').trim();
  return env || path.join(os.homedir(), '.grok');
}

function cachePath(): string {
  return path.join(grokHome(), 'models_cache.json');
}

function configPath(): string {
  return path.join(grokHome(), 'config.toml');
}

function readFileLive(filePath: string, prev: FileSnap | null): FileSnap | null {
  try {
    const st = fs.statSync(filePath);
    if (
      prev
      && prev.path === filePath
      && prev.mtimeMs === st.mtimeMs
      && prev.size === st.size
    ) {
      return prev;
    }
    return {
      path: filePath,
      mtimeMs: st.mtimeMs,
      size: st.size,
      text: fs.readFileSync(filePath, 'utf8'),
    };
  } catch {
    return null;
  }
}

function readConfigToml(): string | null {
  configSnap = readFileLive(configPath(), configSnap);
  return configSnap ? configSnap.text : null;
}

function readModelsCacheText(): string | null {
  cacheSnap = readFileLive(cachePath(), cacheSnap);
  return cacheSnap ? cacheSnap.text : null;
}

/** Test helper: drop mtime snaps so the next read hits disk. */
export function resetContextWindowFileCache(): void {
  configSnap = null;
  cacheSnap = null;
}

function positiveInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  return null;
}

function compactPercent(v: unknown): number | null {
  const n = positiveInt(v);
  if (n == null || n > 100) return null;
  return n;
}

/** Quoted [model."grok-4.6"] is the model id. Unquoted [model.grok-4.6] is nested grok-4 → 6. */
export function parseModelWindowOverrides(toml: string): Record<string, ModelWindowOverride> {
  const out: Record<string, ModelWindowOverride> = {};
  let cur: string | null = null;
  for (const rawLine of String(toml || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const quoted = line.match(/^\[model\.(?:"([^"]+)"|'([^']+)')\]$/);
    if (quoted) {
      cur = quoted[1] || quoted[2] || null;
      if (cur && !out[cur]) out[cur] = {};
      continue;
    }
    const bare = line.match(/^\[model\.([A-Za-z0-9_-]+)\]$/);
    if (bare) {
      cur = bare[1] || null;
      if (cur && !out[cur]) out[cur] = {};
      continue;
    }
    if (line.startsWith('[')) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = (kv[2] || '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    const num = Number(val.replace(/_/g, ''));
    if (key === 'context_window') {
      const w = positiveInt(num);
      if (w != null) out[cur]!.context_window = w;
    } else if (key === 'auto_compact_threshold_percent') {
      const p = compactPercent(num);
      if (p != null) out[cur]!.auto_compact_threshold_percent = p;
    }
  }
  return out;
}

/** [session] auto_compact_threshold_percent — applies unless the model table overrides it. */
export function parseSessionCompactPercent(toml: string): number | null {
  let inSession = false;
  for (const rawLine of String(toml || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (/^\[session\]$/.test(line)) {
      inSession = true;
      continue;
    }
    if (line.startsWith('[')) {
      inSession = false;
      continue;
    }
    if (!inSession) continue;
    const kv = line.match(/^auto_compact_threshold_percent\s*=\s*(.+)$/);
    if (!kv) continue;
    const num = Number(String(kv[1] || '').trim().replace(/_/g, ''));
    return compactPercent(num);
  }
  return null;
}

export function readModelConfigOverride(modelId?: string | null, tomlText?: string): ModelWindowOverride {
  const want = String(modelId || '').trim();
  if (!want) return {};
  let toml = tomlText;
  if (toml == null) toml = readConfigToml() || '';
  if (!toml) return {};
  const all = parseModelWindowOverrides(toml);
  return all[want] || {};
}

function listedWindows(info: Record<string, unknown> | null): number[] {
  if (!info) return [];
  const keys = ['context_windows', 'context_window_options', 'available_context_windows'];
  for (const key of keys) {
    const raw = info[key];
    if (!Array.isArray(raw)) continue;
    const out: number[] = [];
    for (const item of raw) {
      const n = typeof item === 'number'
        ? item
        : (item && typeof item === 'object'
          ? Number((item as { context_window?: unknown; size?: unknown; tokens?: unknown }).context_window
            ?? (item as { size?: unknown }).size
            ?? (item as { tokens?: unknown }).tokens)
          : Number.NaN);
      if (!Number.isFinite(n) || n <= 0) continue;
      const v = Math.floor(n);
      if (!out.includes(v)) out.push(v);
    }
    if (out.length) return out;
  }
  return [];
}

export function readModelWindow(modelId?: string | null): ModelWindow {
  const want = String(modelId || '').trim();
  let window = DEFAULT_CONTEXT_WINDOW;
  let windowFromSource = false;
  let compactAtPercent = DEFAULT_COMPACT_PERCENT;
  let compactAtKnown = false;
  let remaining: number | null = null;
  let model = want;
  let windows: number[] = [];
  try {
    const rawText = readModelsCacheText();
    const raw = rawText ? JSON.parse(rawText) as {
      models?: Record<string, { info?: Record<string, unknown> }>;
    } : null;
    const models = raw && raw.models && typeof raw.models === 'object' ? raw.models : {};
    const info = (want && models[want] && models[want]!.info) || null;
    if (info) {
      const w = info['context_window'];
      if (typeof w === 'number' && w > 0) {
        window = w;
        windowFromSource = true;
      }
      const p = info['auto_compact_threshold_percent'];
      if (typeof p === 'number' && p > 0 && p <= 100) {
        compactAtPercent = p;
        compactAtKnown = true;
      }
      const c = info['compactions_remaining'];
      if (typeof c === 'number' && c >= 0) remaining = c;
      if (!model && typeof info['id'] === 'string') model = info['id'];
      windows = listedWindows(info);
    }
  } catch { /* defaults */ }

  const toml = readConfigToml();
  if (toml) {
    const sess = parseSessionCompactPercent(toml);
    if (sess != null) {
      compactAtPercent = sess;
      compactAtKnown = true;
    }
  }
  if (want) {
    const ov = readModelConfigOverride(want, toml || undefined);
    if (typeof ov.context_window === 'number') {
      window = ov.context_window;
      windowFromSource = true;
    }
    if (typeof ov.auto_compact_threshold_percent === 'number') {
      compactAtPercent = ov.auto_compact_threshold_percent;
      compactAtKnown = true;
    }
  }
  if (!windows.length && windowFromSource) windows = [window];
  else if (windowFromSource && !windows.includes(window)) windows = [window, ...windows];
  return { model, window, windows, compactAtPercent, compactAtKnown, compactionsRemaining: remaining };
}

export function contextStatusFor(used: number, modelId?: string | null): ContextStatus {
  const w = readModelWindow(modelId);
  return deriveContextStatus({
    used,
    window: w.window,
    compactAtPercent: w.compactAtKnown ? w.compactAtPercent : undefined,
    compactAtKnown: w.compactAtKnown,
    compactionsRemaining: w.compactionsRemaining,
    model: w.model || modelId || '',
    windows: w.windows,
  });
}

/** Per-conversation / grok-remote defaults overlay the model catalog + config.toml. */
export function resolveConversationWindow(opts: {
  modelId?: string | null;
  settings?: Record<string, unknown> | null;
  defaults?: { contextWindow?: unknown; compactAtPercent?: unknown } | null;
}): ModelWindow & { uiAutoCompact: boolean } {
  const base = readModelWindow(opts.modelId);
  const s = (opts.settings && typeof opts.settings === 'object') ? opts.settings : {};
  const d = (opts.defaults && typeof opts.defaults === 'object') ? opts.defaults : {};
  const fromSettingsWin = positiveInt(s['contextWindow']) ?? positiveInt(s['context_window']);
  const fromDefaultsWin = positiveInt(d.contextWindow);
  const fromSettingsPct = compactPercent(s['autoCompactThresholdPercent'])
    ?? compactPercent(s['auto_compact_threshold_percent']);
  const fromDefaultsPct = compactPercent(d.compactAtPercent);
  const enabled = s['uiAutoCompact'] !== false && s['ui_auto_compact'] !== false;
  const compactAtKnown = fromSettingsPct != null || fromDefaultsPct != null || base.compactAtKnown;
  return {
    ...base,
    window: fromSettingsWin ?? fromDefaultsWin ?? base.window,
    compactAtPercent: fromSettingsPct ?? fromDefaultsPct ?? base.compactAtPercent,
    compactAtKnown,
    uiAutoCompact: enabled,
  };
}


// Model list for the website picker. Prefer ~/.grok/models_cache.json over `grok models`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseModelWindowOverrides } from './context-window.js';

export interface CatalogEffort {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  windows: number[];
  compactAtPercent?: number;
  compactAtKnown: boolean;
  efforts: CatalogEffort[];
  notice?: string;
}

function grokHome(): string {
  const env = String(process.env['GROK_HOME'] || '').trim();
  return env || path.join(os.homedir(), '.grok');
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function windowListFromInfo(info: Record<string, unknown>): number[] {
  const keys = ['context_windows', 'context_window_options', 'available_context_windows'];
  for (const key of keys) {
    const raw = info[key];
    if (!Array.isArray(raw)) continue;
    const out: number[] = [];
    for (const item of raw) {
      const rec = asRecord(item);
      const n = rec
        ? positiveInt(rec['context_window'] ?? rec['size'] ?? rec['tokens'] ?? rec['window'])
        : positiveInt(item);
      if (n == null || out.includes(n)) continue;
      out.push(n);
    }
    if (out.length) return out;
  }
  return [];
}

function effortsFromInfo(info: Record<string, unknown>): CatalogEffort[] {
  const raw = info['reasoning_efforts'];
  if (!Array.isArray(raw)) return [];
  const out: CatalogEffort[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = String(rec['id'] || rec['value'] || '').trim();
    if (!id) continue;
    const label = String(rec['label'] || id).trim() || id;
    const description = String(rec['description'] || '').trim();
    out.push({
      id,
      label,
      ...(description ? { description } : {}),
      recommended: rec['default'] === true || rec['recommended'] === true,
    });
  }
  return out;
}

function modelFromInfo(key: string, info: Record<string, unknown>): CatalogModel | null {
  const id = String(info['id'] || key || '').trim();
  if (!id) return null;
  const name = String(info['name'] || info['model'] || id).trim() || id;
  const description = String(info['description'] || '').trim();
  const contextWindow = positiveInt(info['context_window']) ?? undefined;
  let windows = windowListFromInfo(info);
  if (contextWindow && !windows.includes(contextWindow)) windows = [contextWindow, ...windows];
  else if (!windows.length && contextWindow) windows = [contextWindow];
  const pct = positiveInt(info['auto_compact_threshold_percent']);
  const compactAtPercent = pct != null && pct <= 100 ? pct : undefined;
  const notice = String(info['notice'] || info['notice_banner'] || '').trim();
  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    windows,
    ...(compactAtPercent ? { compactAtPercent } : {}),
    compactAtKnown: compactAtPercent != null,
    efforts: effortsFromInfo(info),
    ...(notice ? { notice } : {}),
  };
}

export function parseModelsCache(raw: unknown): CatalogModel[] {
  const root = asRecord(raw);
  if (!root) return [];
  const bag = asRecord(root['models']) || null;
  if (!bag) return [];
  const out: CatalogModel[] = [];
  for (const [key, val] of Object.entries(bag)) {
    const rec = asRecord(val);
    if (!rec) continue;
    const info = asRecord(rec['info']) || rec;
    const model = modelFromInfo(key, info);
    if (model) out.push(model);
  }
  return out;
}

export function mergeConfigModelStubs(models: CatalogModel[], toml: string): CatalogModel[] {
  const overrides = parseModelWindowOverrides(toml || '');
  const byId = new Map(models.map((m) => [m.id, m]));
  for (const [id, ov] of Object.entries(overrides)) {
    const hit = byId.get(id);
    if (hit) {
      if (typeof ov.context_window === 'number') {
        hit.contextWindow = ov.context_window;
        if (!hit.windows.includes(ov.context_window)) hit.windows = [...hit.windows, ov.context_window];
      }
      if (typeof ov.auto_compact_threshold_percent === 'number') {
        hit.compactAtPercent = ov.auto_compact_threshold_percent;
        hit.compactAtKnown = true;
      }
      continue;
    }
    const window = ov.context_window;
    byId.set(id, {
      id,
      name: id,
      ...(window ? { contextWindow: window } : {}),
      windows: window ? [window] : [],
      ...(typeof ov.auto_compact_threshold_percent === 'number'
        ? { compactAtPercent: ov.auto_compact_threshold_percent }
        : {}),
      compactAtKnown: typeof ov.auto_compact_threshold_percent === 'number',
      efforts: [],
    });
  }
  return [...byId.values()];
}

export function catalogFromText(cacheText: string | null, tomlText: string | null): CatalogModel[] {
  let models: CatalogModel[] = [];
  if (cacheText && cacheText.trim()) {
    try { models = parseModelsCache(JSON.parse(cacheText)); }
    catch { models = []; }
  }
  return mergeConfigModelStubs(models, tomlText || '');
}

export function readCatalogModels(): CatalogModel[] {
  const home = grokHome();
  let cacheText: string | null = null;
  let tomlText: string | null = null;
  try { cacheText = fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'); }
  catch { cacheText = null; }
  try { tomlText = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); }
  catch { tomlText = null; }
  return catalogFromText(cacheText, tomlText);
}

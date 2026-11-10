// /model and /effort picker. ChatView methods are thin delegates.

import { api } from '../../lib/api';
import { formatTokensShort } from '../../lib/context-status.js';
import { el } from '../../lib/render';
import { clearContextWindow } from './context-panel';

export const MODEL_EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

const EFFORT_ALIAS: Record<string, string> = {
  none: 'none',
  minimal: 'minimal',
  min: 'minimal',
  low: 'low',
  medium: 'medium',
  med: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  xh: 'xhigh',
  extrahigh: 'xhigh',
};

const EFFORT_PRETTY: Record<string, string> = {
  '': 'Default',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'xHigh',
};

export function normalizeEffort(raw: unknown): string | null {
  const key = String(raw || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!key) return null;
  return EFFORT_ALIAS[key] || null;
}

export function parseModelCommand(_view: unknown, rest: string): { model: string; effort: string } {
  const raw = String(rest || '').trim();
  if (!raw) return { model: '', effort: '' };
  const parts = raw.split(/\s+/);
  if (parts.length >= 2) {
    const two = normalizeEffort(parts.slice(-2).join(' '));
    if (two) return { model: parts.slice(0, -2).join(' '), effort: two };
  }
  const last = normalizeEffort(parts[parts.length - 1] || '');
  if (last && parts.length >= 2) return { model: parts.slice(0, -1).join(' '), effort: last };
  if (last) return { model: '', effort: last };
  return { model: raw, effort: '' };
}

export async function tryLocalModelCommand(view: any, text: string): Promise<boolean> {
  const m = String(text || '').trim().match(/^\/(model|m|effort)(?:\s+(.*))?$/i);
  if (!m) return false;
  const cmd = (m[1] || '').toLowerCase();
  const rest = (m[2] || '').trim();
  if (cmd === 'effort') {
    if (!rest) {
      view._openModelPicker({ effortOnly: true });
      return true;
    }
    const parsed = view._parseModelCommand(rest);
    const effort = normalizeEffort(parsed.effort || parsed.model);
    if (!effort) {
      view.showToast('Usage: /effort none|minimal|low|medium|high|xhigh', 'warn');
      return true;
    }
    await view._applyModelSettings({ effort });
    return true;
  }
  if (!rest) {
    view._openModelPicker();
    return true;
  }
  const parsed = view._parseModelCommand(rest);
  const patch: { model?: string; effort?: string } = {};
  if (parsed.model) patch.model = parsed.model;
  if (parsed.effort) patch.effort = parsed.effort;
  await view._applyModelSettings(patch);
  return true;
}

export interface ModelChoice {
  id: string;
  name: string;
  notice: string;
  windows: number[];
  efforts: Array<{ id?: string; label?: string; description?: string; recommended?: boolean; default?: boolean }>;
  contextWindow: number;
}

export async function loadModelChoices(_view: any): Promise<ModelChoice[]> {
  try {
    const data: any = await api.systemModels.get();
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    return items
      .map((it: any) => ({
        id: String((it && (it.id || it.name)) || '').trim(),
        name: String((it && it.name) || '').trim(),
        notice: String((it && (it.notice || it.notice_banner)) || '').trim(),
        windows: Array.isArray(it && it.windows)
          ? it.windows.map((n: unknown) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0)
          : [],
        efforts: Array.isArray(it && it.efforts) ? it.efforts : [],
        contextWindow: Number(it && (it.contextWindow || it.context_window)) || 0,
      }))
      .filter((it: ModelChoice) => it.id);
  } catch {
    return [];
  }
}

export function currentModelSettings(view: any) {
  const a = view.currentAgent || {};
  const s = (a.settings && typeof a.settings === 'object') ? a.settings : {};
  return {
    model: String(s.model || a.model || '').trim(),
    liveModel: String(a.liveModel || a.model || '').trim(),
    effort: String(s.reasoningEffort || '').trim(),
    contextWindow: Number(s.contextWindow || a.contextWindow) || 0,
  };
}

export async function applyModelSettings(view: any, opts: {
  model?: string;
  effort?: string;
  clearEffort?: boolean;
  contextWindow?: number;
} = {}) {
  if (!view.agentId) {
    view.showToast('No conversation selected.', 'warn');
    return;
  }
  const model = opts.model;
  const effort = opts.effort;
  const patch: any = {};
  try {
    if (typeof model === 'string' && model.trim()) {
      let id = model.trim();
      const choices = await view._loadModelChoices();
      const lc = id.toLowerCase();
      const hit = choices.find((c: any) => c.id.toLowerCase() === lc || (c.name && c.name.toLowerCase() === lc));
      if (hit) id = hit.id;
      patch.model = id;
    }
    if (opts.clearEffort) {
      patch.reasoningEffort = '';
    } else if (typeof effort === 'string' && effort.trim()) {
      const ev = normalizeEffort(effort);
      if (!ev) {
        view.showToast('Usage: /effort none|minimal|low|medium|high|xhigh', 'warn');
        return;
      }
      patch.reasoningEffort = ev;
    }
    if (typeof opts.contextWindow === 'number' && opts.contextWindow > 0) {
      patch.contextWindow = Math.floor(opts.contextWindow);
    }
    if (!Object.keys(patch).length) {
      view.showToast('Nothing to change.', 'info');
      return;
    }
    const before = view._currentModelSettings();
    const updated: any = await api.updateAgent(view.agentId, { settings: patch });
    if (updated && updated.id === view.agentId) view.applyAgentRefresh(updated);
    clearContextWindow(view);
    view._renderModelPill();
    if (typeof view._renderTokensPill === 'function') view._renderTokensPill();
    const next = view._currentModelSettings();
    const label = [
      next.model ? `Model ${next.model}` : '',
      next.effort ? `Effort ${next.effort}` : 'Effort default',
    ].filter(Boolean).join(' · ');
    const live = !!(view.currentAgent && view.currentAgent.status !== 'disconnected' && view.currentAgent.status !== 'exited');
    const effortChanged = before.effort !== next.effort;
    // Apply a model always starts a new grok session. set_model + resume
    // `-r` can leave grok-4.6 in place (qwen-local needs a new session).
    if (live && (patch.model || effortChanged)) {
      view.showToast(`${label} — starting a new grok session…`, 'info');
      await view._reconnectForSettings(label, { freshSession: true });
    } else if (updated && updated.runtimeApplied) {
      view.showToast(`${label} — applied.`, 'info');
    } else if (live && (patch.model || patch.reasoningEffort != null)) {
      view.showToast(`${label} — reconnecting…`, 'info');
      await view._reconnectForSettings(label);
    } else {
      view.showToast(`${label} — saved.`, 'info');
    }
  } catch (e: any) {
    try { view.showToast(`Model change failed: ${e && e.message ? e.message : String(e)}`, 'warn'); }
    catch { /* never throw out of the picker */ }
  }
}

export function closeModelPicker(view: any) {
  if (view._modelPicker) {
    try { view._modelPicker.remove(); } catch { /* ignore */ }
    view._modelPicker = null;
  }
}

export async function openModelPicker(view: any, opts?: { effortOnly?: boolean }) {
  try {
    await view._openModelPickerUnsafe(opts);
  } catch (e: any) {
    try { view._closeModelPicker(); } catch { /* ignore */ }
    try { view.showToast(`Could not open model picker: ${e && e.message ? e.message : String(e)}`, 'warn'); }
    catch { /* ignore */ }
  }
}

interface EffortChip { id: string; label: string; recommended: boolean }

function effortChips(choice: ModelChoice | undefined): EffortChip[] {
  const fromModel = choice && Array.isArray(choice.efforts) ? choice.efforts : [];
  const chips: EffortChip[] = [];
  for (const raw of fromModel) {
    const id = normalizeEffort(raw && (raw.id || raw.label)) || '';
    if (!id || chips.some((c) => c.id === id)) continue;
    chips.push({
      id,
      label: String((raw && raw.label) || EFFORT_PRETTY[id] || id),
      recommended: !!(raw && (raw.recommended || raw.default)),
    });
  }
  if (chips.length) return chips;
  return MODEL_EFFORT_LEVELS.map((id) => ({ id, label: EFFORT_PRETTY[id] || id, recommended: false }));
}

export async function openModelPickerUnsafe(view: any, opts?: { effortOnly?: boolean }) {
  view._closeModelPicker();
  if (view.composerHint) {
    view.composerHint.classList.add('hidden');
    view.composerHint.textContent = '';
  }
  const effortOnly = !!(opts && opts.effortOnly);
  const cur = view._currentModelSettings();
  const panel = el('div', { class: 'model-picker', role: 'dialog', 'aria-label': 'Switch Model' });
  view._modelPicker = panel;
  const host = view.composerEl || view.root;
  host.appendChild(panel);

  const title = el('div', { class: 'model-picker__title' }, effortOnly ? 'Reasoning effort' : 'Switch model');
  const status = el('div', { class: 'model-picker__status' }, 'Loading models…');
  const notice = el('div', { class: 'model-picker__notice', hidden: true });
  const list = el('div', { class: 'model-picker__list' });
  const windows = el('div', { class: 'model-picker__windows' });
  const efforts = el('div', { class: 'model-picker__efforts' });
  let choices: ModelChoice[] = [];
  let pickedModel = cur.model;
  let pickedEffort = cur.effort;
  let pickedWindow = cur.contextWindow || 0;
  let effortTouched = false;
  let windowTouched = false;

  const selected = () => choices.find((c) => c.id.toLowerCase() === String(pickedModel || '').toLowerCase());

  const paintNotice = () => {
    const text = !effortOnly && selected() && selected()!.notice;
    notice.hidden = !text;
    notice.textContent = text || '';
  };

  const paintWindows = () => {
    windows.replaceChildren();
    if (effortOnly) return;
    const sizes = (selected() && selected()!.windows) || [];
    const unique = [...new Set(sizes.filter((n) => n > 1))];
    if (unique.length < 2) return;
    windows.appendChild(el('span', { class: 'model-picker__efforts-label' }, 'Context window'));
    for (const size of unique) {
      const on = pickedWindow === size;
      windows.appendChild(el('button', {
        type: 'button',
        class: 'model-picker__chip' + (on ? ' is-on' : ''),
        onclick: () => {
          pickedWindow = size;
          windowTouched = true;
          paintWindows();
        },
      }, formatTokensShort(size)));
    }
  };

  const paintEfforts = () => {
    efforts.replaceChildren(el('span', { class: 'model-picker__efforts-label' }, 'Effort'));
    const chips = effortChips(selected());
    const recommended = chips.find((c) => c.recommended);
    if (effortOnly && !effortTouched && !pickedEffort && recommended) {
      pickedEffort = recommended.id;
      effortTouched = true;
    }
    const levels = [{ id: '', label: 'Default', recommended: false }, ...chips];
    for (const lv of levels) {
      const on = pickedEffort === lv.id;
      const rec = lv.recommended && !on;
      const btn = el('button', {
        type: 'button',
        class: 'model-picker__chip' + (on ? ' is-on' : '') + (rec ? ' is-recommended' : ''),
        title: rec ? 'Recommended for this model' : '',
        onclick: () => {
          pickedEffort = lv.id;
          effortTouched = true;
          paintEfforts();
        },
      }, lv.label);
      efforts.appendChild(btn);
    }
  };

  const actions = el('div', { class: 'model-picker__actions' },
    el('button', {
      type: 'button', class: 'btn btn--primary',
      onclick: async () => {
        view._closeModelPicker();
        const patch: { model?: string; effort?: string; clearEffort?: boolean; contextWindow?: number } = {};
        if (!effortOnly && pickedModel) patch.model = pickedModel;
        if (effortTouched) {
          if (pickedEffort) patch.effort = pickedEffort;
          else patch.clearEffort = true;
        }
        if (windowTouched && pickedWindow > 0) patch.contextWindow = pickedWindow;
        await view._applyModelSettings(patch);
      },
    }, 'Apply'),
    el('button', {
      type: 'button', class: 'btn btn--ghost',
      onclick: () => view._closeModelPicker(),
    }, 'Cancel'),
  );
  for (const n of [title, status, notice, list, windows, efforts, actions]) panel.appendChild(n);
  choices = await view._loadModelChoices();
  if (view._modelPicker !== panel) return;
  view._modelCatalog = choices;
  if (effortOnly) {
    status.textContent = cur.effort ? `Current effort: ${cur.effort}` : 'Current effort: default';
    paintNotice();
    paintEfforts();
    return;
  }
  list.replaceChildren();
  if (!choices.length) {
    status.textContent = 'Could not list models. Type an id, e.g. /model grok-4.6 high';
  } else {
    status.textContent = cur.model ? `Current: ${cur.model}` : 'Pick a model';
    for (const c of choices) {
      const on = pickedModel && c.id.toLowerCase() === pickedModel.toLowerCase();
      const row = el('button', {
        type: 'button',
        class: 'model-picker__row' + (on ? ' is-on' : ''),
        onclick: () => {
          pickedModel = c.id;
          for (const n of list.querySelectorAll('.model-picker__row')) n.classList.remove('is-on');
          row.classList.add('is-on');
          paintNotice();
          paintWindows();
          paintEfforts();
        },
      },
        el('span', { class: 'model-picker__id' }, c.id),
        c.name && c.name !== c.id ? el('span', { class: 'model-picker__name' }, c.name) : null,
      );
      list.appendChild(row);
    }
  }
  paintNotice();
  paintWindows();
  paintEfforts();
}

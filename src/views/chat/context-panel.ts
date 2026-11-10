// Compact context / auto-compact status panel (CLI /context).
// Window and compact % come from GET /context (config.toml + catalog), not a UI constant.

import { el } from '../../lib/render';
import { api } from '../../lib/api';
import {
  deriveContextStatus,
  contextPillLabel,
  formatTokensShort,
  pickUsedTokens,
  occupancyFromMeta,
  type ContextStatus,
} from '../../lib/context-status.js';

/** Re-read config-backed window this often so a toml edit shows up without a rebuild. */
export const CONTEXT_WINDOW_TTL_MS = 2500;

export function currentUsedTokens(view: any): number {
  return pickUsedTokens({
    live: view.latestTotalTokens,
    snap: view.currentAgent && view.currentAgent.totalTokens,
  });
}

export function applyOccupancy(view: any, tt: unknown): void {
  if (typeof tt !== 'number' || !Number.isFinite(tt) || tt < 0) return;
  view.latestTotalTokens = tt;
  view._tokensLiveAt = Date.now();
  if (view.currentAgent) view.currentAgent.totalTokens = tt;
  if (typeof view._renderTokensPill === 'function') view._renderTokensPill();
}

export { occupancyFromMeta };

export function currentModelId(view: any): string {
  const a = view.currentAgent || {};
  return String((a.settings && a.settings.model) || a.model || a.modelHint || '') || '';
}

export function shouldRefreshContextWindow(view: any, now = Date.now()): boolean {
  if (!view.agentId) return false;
  if (view._contextWindowFetch) return false;
  if (!view._contextWindow) return true;
  const at = view._contextWindowAt;
  if (typeof at !== 'number') return true;
  return now - at >= CONTEXT_WINDOW_TTL_MS;
}

export function applyContextWindow(view: any, data: {
  window?: unknown;
  compactAtPercent?: unknown;
  compactAtKnown?: unknown;
  compactionsRemaining?: unknown;
  model?: unknown;
  windows?: unknown;
} | null | undefined): void {
  if (!data || typeof data.window !== 'number' || !(data.window > 0)) return;
  const pct = Number(data.compactAtPercent);
  const pctValid = Number.isFinite(pct) && pct > 0 && pct <= 100;
  const known = data.compactAtKnown === true || (data.compactAtKnown == null && pctValid);
  const windows = Array.isArray(data.windows)
    ? data.windows.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  view._contextWindow = {
    window: data.window,
    compactAtPercent: pctValid ? pct : data.compactAtPercent,
    compactAtKnown: known,
    compactionsRemaining: data.compactionsRemaining,
    model: data.model,
    windows,
  };
  view._contextWindowAt = Date.now();
}

export function clearContextWindow(view: any): void {
  view._contextWindow = null;
  view._contextWindowAt = 0;
  view._contextWindowFetch = null;
}

export function localContextStatus(view: any): ContextStatus {
  const cached = view._contextWindow;
  const a = view.currentAgent || {};
  const window = (cached && cached.window) || a.contextWindow || a.context_window;
  const pct = (cached && cached.compactAtPercent) || a.compactAtPercent;
  const known = cached
    ? cached.compactAtKnown === true
    : (a.compactAtKnown === true || (a.compactAtKnown == null && typeof pct === 'number' && pct > 0));
  return deriveContextStatus({
    used: currentUsedTokens(view),
    window: typeof window === 'number' && window > 0 ? window : null,
    compactAtPercent: known ? pct : undefined,
    compactAtKnown: known,
    compactionsRemaining: cached && cached.compactionsRemaining,
    model: currentModelId(view) || (cached && cached.model) || '',
    windows: (cached && cached.windows) || a.contextWindows,
  });
}

export async function refreshContextWindow(view: any): Promise<ContextStatus> {
  const id = view.agentId;
  if (!id) return localContextStatus(view);
  try {
    const data = await api.agentContext(id) as ContextStatus & { ok?: boolean };
    applyContextWindow(view, data);
  } catch { /* keep last known window; do not invent one */ }
  return localContextStatus(view);
}

export function tokensPillText(view: any, st: ContextStatus): string {
  if (view._compacting) return 'Compacting…';
  return contextPillLabel(st);
}

export function paintTokensPill(view: any): void {
  if (!view.tokensPill) return;
  if (shouldRefreshContextWindow(view)) {
    view._contextWindowFetch = refreshContextWindow(view).finally(() => {
      view._contextWindowFetch = null;
      paintTokensPill(view);
    });
  }
  const st = localContextStatus(view);
  if (!st.used && !view._compacting) {
    view.tokensPill.hidden = true;
    view.tokensPill.replaceChildren();
    return;
  }
  view.tokensPill.hidden = false;
  view.tokensPill.classList.toggle('tab-tokens--warn', !view._compacting && st.windowKnown && st.compactAtKnown && st.level === 'warn');
  view.tokensPill.classList.toggle('tab-tokens--soon', !!(view._compacting || (st.windowKnown && st.compactAtKnown && st.level === 'soon')));
  view.tokensPill.replaceChildren(document.createTextNode(tokensPillText(view, st)));
  view.tokensPill.title = view._compacting
    ? 'Compressing conversation history'
    : st.windowKnown && st.compactAtKnown
      ? `${st.used.toLocaleString()} / ${st.window.toLocaleString()} · auto-compact at ${st.compactAtPercent}% (${st.compactAtTokens.toLocaleString()})`
      : st.windowKnown
        ? `${st.used.toLocaleString()} / ${st.window.toLocaleString()}`
        : `${st.used.toLocaleString()} used`;
  view._lastRenderedTokens = st.used;
}

export function closeContextPanel(view: any): void {
  if (view.contextPanelEl) {
    view.contextPanelEl.hidden = true;
    view.contextPanelEl.replaceChildren();
  }
}

export function toggleContextPanel(view: any): void {
  if (!view.contextPanelEl) return;
  if (!view.contextPanelEl.hidden) { closeContextPanel(view); return; }
  void openContextPanel(view);
}

export async function openContextPanel(view: any): Promise<void> {
  if (!view.contextPanelEl) return;
  const st = await refreshContextWindow(view);
  const a = view.currentAgent || {};
  const pct = st.percent < 10 ? st.percent.toFixed(1) : String(Math.round(st.percent));
  const barPct = Math.max(1, Math.min(100, st.percent));
  const linePct = Math.max(1, Math.min(100, st.compactAtPercent));
  const remain = formatTokensShort(st.remainingToCompact);
  const levelLabel = view._compacting
    ? 'Compacting…'
    : !st.windowKnown
      ? 'Reading config…'
      : st.level === 'soon' ? 'Compact soon' : st.level === 'warn' ? 'Approaching compact' : 'Headroom ok';

  const compactBtn = el('button', {
    type: 'button',
    class: 'btn btn--primary ctx-panel__btn',
    onclick: () => {
      closeContextPanel(view);
      if (typeof view._runCompact === 'function') void view._runCompact();
      else {
        if (view.composerTa) view.composerTa.value = '/compact';
        void view.send();
      }
    },
  }, 'Compact Now');

  view.contextPanelEl.replaceChildren(
    el('div', { class: 'ctx-panel__head' },
      el('span', { class: 'ctx-panel__title' }, 'Context'),
      el('span', { class: `ctx-panel__level ctx-panel__level--${st.windowKnown ? st.level : 'ok'}` }, levelLabel),
    ),
    el('div', { class: 'ctx-panel__bar' },
      el('div', { class: `ctx-panel__fill ctx-panel__fill--${st.windowKnown ? st.level : 'ok'}`, style: `width:${barPct}%` }),
      st.compactAtKnown
        ? el('div', { class: 'ctx-panel__mark', style: `left:${linePct}%`, title: `Auto-compact at ${st.compactAtPercent}%` })
        : null,
    ),
    el('div', { class: 'ctx-panel__nums' },
      st.windowKnown
        ? `${formatTokensShort(st.used)} / ${formatTokensShort(st.window)} · ${pct}%`
        : `${formatTokensShort(st.used)} used`,
    ),
    el('dl', { class: 'ctx-panel__dl' },
      row('Model', st.model || currentModelId(view) || '—'),
      row('Used', st.used.toLocaleString()),
      row('Window', st.windowKnown ? st.window.toLocaleString() : 'from config…'),
      row('Auto-compact', st.compactAtKnown ? `${st.compactAtPercent}% (${formatTokensShort(st.compactAtTokens)})` : '—'),
      row('Until compact', st.windowKnown && st.compactAtKnown ? remain : '—'),
      row('Folder', a.cwd || '—'),
      (a.settings && typeof a.settings.worktree === 'string' && a.settings.worktree)
        ? row('Worktree', String(a.settings.worktree))
        : null,
      row('Compactions left', st.compactionsRemaining == null ? '—' : String(st.compactionsRemaining)),
      row('Session', a.sessionId || '—'),
    ),
    el('div', { class: 'ctx-panel__actions' }, compactBtn),
  );
  view.contextPanelEl.hidden = false;
  const host = (view.tokensPill && view.tokensPill.parentElement) || view.root;
  if (host && view.contextPanelEl.parentNode !== host) host.appendChild(view.contextPanelEl);
  const onDoc = (ev: Event) => {
    const t = ev.target as Node | null;
    if (t && view.contextPanelEl && (view.contextPanelEl.contains(t) || (view.tokensPill && view.tokensPill.contains(t)))) return;
    closeContextPanel(view);
    document.removeEventListener('click', onDoc);
  };
  setTimeout(() => document.addEventListener('click', onDoc), 0);
}

function row(k: string, v: string): HTMLElement {
  return el('div', { class: 'ctx-panel__row' },
    el('dt', null, k),
    el('dd', null, v),
  );
}

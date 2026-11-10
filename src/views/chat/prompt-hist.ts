// Composer ↑ / ↓ prompt-history UI. Merge/cap lives in src/lib/prompt-history.ts.

import { el } from '../../lib/render';
import {
  mergePromptHistory,
  rememberPrompt,
  promptsFromTurns,
  parseStoredPromptHistory,
  previewPrompt,
  PROMPT_HIST_CAP,
} from '../../lib/prompt-history.js';

export function promptHistKey(view: any) {
  return view.agentId ? `grok-remote.promptHistory.${view.agentId}` : '';
}

export function loadPromptHist(view: any) {
  view._promptHistIdx = -1;
  view._promptHistDraft = '';
  const key = view._promptHistKey();
  let stored: string[] = [];
  if (key) {
    try { stored = parseStoredPromptHistory(localStorage.getItem(key)); }
    catch { stored = []; }
  }
  // Always merge conversation turns. A first seed used to cap at 80 and
  // then stick, so older You rows vanished from ↑ history.
  view._promptHist = mergePromptHistory(stored, promptsFromTurns(view.turns));
  if (view._promptHist.length) view._savePromptHist();
  view._renderPromptHist();
}

export function savePromptHist(view: any) {
  const key = view._promptHistKey();
  if (!key || !view._promptHist || !view._promptHist.length) return;
  try { localStorage.setItem(key, JSON.stringify(view._promptHist.slice(0, PROMPT_HIST_CAP))); }
  catch { /* ignore quota */ }
}

export function rememberPromptOnView(view: any, text: string, persist: boolean) {
  view._promptHist = rememberPrompt(view._promptHist, text);
  if (persist) view._savePromptHist();
}

export function pushPromptHist(view: any, text: string) {
  view._rememberPrompt(text, true);
  view._promptHistIdx = -1;
  view._promptHistDraft = '';
  view._closePromptHist();
}

export function promptHistOpen(view: any) {
  if (view._promptHistIdx < 0) {
    view._promptHistDraft = view.composerTa ? view.composerTa.value : '';
  }
  if (!(view._promptHist || []).length) {
    view.showToast('No prompt history yet.', 'info');
    return;
  }
  if (view._promptHistIdx < 0) view._promptHistIdx = 0;
  view._applyPromptHistIdx();
  view._renderPromptHist();
  if (!view.promptHistEl) {
    view._promptHistIdx = -1;
    if (view.promptHistBtn) view.promptHistBtn.classList.remove('is-on');
  }
}

export function closePromptHist(view: any) {
  view._promptHistIdx = -1;
  if (view.promptHistEl) view.promptHistEl.hidden = true;
  if (view.promptHistBtn) view.promptHistBtn.classList.remove('is-on');
}

export function togglePromptHist(view: any) {
  if (view.promptHistEl && !view.promptHistEl.hidden) {
    view._restorePromptDraft();
    view._closePromptHist();
    return;
  }
  view._promptHistOpen();
}

export function restorePromptDraft(view: any) {
  if (!view.composerTa) return;
  view.composerTa.value = view._promptHistDraft || '';
  view.composerTa.dispatchEvent(new Event('input', { bubbles: true }));
}

export function applyPromptHistIdx(view: any) {
  const list = view._promptHist || [];
  if (!view.composerTa) return;
  if (view._promptHistIdx < 0 || view._promptHistIdx >= list.length) {
    view._restorePromptDraft();
    return;
  }
  view.composerTa.value = list[view._promptHistIdx];
  try {
    const n = view.composerTa.value.length;
    view.composerTa.setSelectionRange(n, n);
  } catch { /* ignore */ }
  view.composerTa.dispatchEvent(new Event('input', { bubbles: true }));
  view.composerTa.focus();
}

export function stepPromptHist(view: any, dir: number) {
  const list = view._promptHist || [];
  if (!list.length) {
    if (dir < 0) view.showToast('No prompt history yet.', 'info');
    return;
  }
  if (view._promptHistIdx < 0) {
    if (dir > 0) return; // ↓ never opens history
    view._promptHistDraft = view.composerTa ? view.composerTa.value : '';
    view._promptHistIdx = 0;
  } else {
    const next = view._promptHistIdx + (dir < 0 ? 1 : -1);
    if (next < 0) {
      view._restorePromptDraft();
      view._closePromptHist();
      return;
    }
    view._promptHistIdx = Math.min(next, list.length - 1);
  }
  view._applyPromptHistIdx();
  view._renderPromptHist();
}

export function onPromptHistKey(view: any, ev: any) {
  if (!ev || ev.altKey || ev.metaKey || ev.ctrlKey) return false;
  const slashOpen = view.palette && !view.palette.classList.contains('hidden');
  // slash-palette uses capture; if its panel is visible, leave arrows to it.
  const slashPanel = view.composerEl && view.composerEl.querySelector('.slash-palette:not(.hidden)');
  if (slashOpen || slashPanel) return false;
  const empty = !(view.composerTa && String(view.composerTa.value || '').trim());
  const browsing = view._promptHistIdx >= 0;
  if (ev.key === 'ArrowUp') {
    if (!browsing && !empty) return false;
    ev.preventDefault();
    view._stepPromptHist(-1);
    return true;
  }
  if (ev.key === 'ArrowDown') {
    if (!browsing) return false;
    ev.preventDefault();
    view._stepPromptHist(1);
    return true;
  }
  if (ev.key === 'Escape' && browsing) {
    ev.preventDefault();
    view._restorePromptDraft();
    view._closePromptHist();
    return true;
  }
  return false;
}

export function renderPromptHist(view: any) {
  const elp = view.promptHistEl;
  if (!elp) return;
  const list = view._promptHist || [];
  const browsing = view._promptHistIdx >= 0;
  if (view.promptHistBtn) view.promptHistBtn.classList.toggle('is-on', browsing);
  if (!browsing || !list.length) {
    elp.hidden = true;
    elp.replaceChildren();
    return;
  }
  elp.hidden = false;
  const head = el('div', { class: 'prompt-hist__head' },
    el('span', { class: 'prompt-hist__title' }, 'Prompt history'),
    el('span', { class: 'prompt-hist__meta' },
      `${view._promptHistIdx + 1}/${list.length}  ·  ↑↓ choose  ·  enter send`),
  );
  const rows = el('div', { class: 'prompt-hist__list' });
  // Newest sits at the bottom (next to the input). ↑ goes older / up the
  // list, ↓ goes newer / down — same as the CLI. Render the full list
  // (scrollable) so a long conversation does not look truncated.
  for (let i = list.length - 1; i >= 0; i--) {
    const active = i === view._promptHistIdx;
    const preview = previewPrompt(list[i]);
    const row = el('button', {
      type: 'button',
      class: 'prompt-hist__row' + (active ? ' is-on' : ''),
      onclick: () => {
        view._promptHistIdx = i;
        view._applyPromptHistIdx();
        view._renderPromptHist();
      },
    },
      el('span', { class: 'prompt-hist__inner' },
        el('span', { class: 'prompt-hist__idx' }, String(i + 1)),
        el('span', { class: 'prompt-hist__text' }, preview || '(empty)'),
      ),
    );
    rows.appendChild(row);
  }
  elp.replaceChildren(head, rows);
  const on = elp.querySelector('.prompt-hist__row.is-on');
  if (on && typeof (on as any).scrollIntoView === 'function') {
    try { (on as any).scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
  }
}

// ── todos / tasks panes (CLI ctrl+t / ctrl+g) ────────────────────────


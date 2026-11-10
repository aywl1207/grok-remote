// Chat tools column + Split.js. Keys persist per tab (tools vs files).

import Split from 'split.js';
import { el } from '../../lib/render';
import { iconHtml } from '../../lib/icons';

export const CHAT_TOOLS_TAB_KEY = 'grok-remote.split.chat.tab';
export const CHAT_TOOLS_FULLSCREEN_KEY = 'grok-remote.split.chat.fullscreen';
export const CHAT_SPLIT_SIZES_KEY = 'grok-remote.split.chat';
export const CHAT_SPLIT_COLLAPSED_KEY = 'grok-remote.split.chat.collapsed';
export const CHAT_SPLIT_MOBILE_COLLAPSED_KEY = 'grok-remote.split.chat.mobile-collapsed';
export const CHAT_SPLIT_DEFAULT_SIZES = { tools: [70, 30], files: [50, 50] };
export const CHAT_SPLIT_MOBILE_MAX = 720;

export function scrollToolsToBottom(view: any, opts?: any) {
  if (!view.toolsStreamEl) return;
  const force = !!(opts && opts.force);
  if (!force && view._autoScrollTools === false) return;
  if (force) {
    view.toolsStreamEl.scrollTop = view.toolsStreamEl.scrollHeight;
    view._lastEasedToolsWrite = view.toolsStreamEl.scrollTop;
    view._easedToolsTarget = view.toolsStreamEl.scrollTop;
    return;
  }
  if (typeof document !== 'undefined' && document.hidden) {
    view.toolsStreamEl.scrollTop = view.toolsStreamEl.scrollHeight;
    view._lastEasedToolsWrite = view.toolsStreamEl.scrollTop;
    view._easedToolsTarget = view.toolsStreamEl.scrollTop;
    return;
  }
  if (view._easedToolsRaf) return;
  const tick = () => {
    view._easedToolsRaf = 0;
    if (!view.toolsStreamEl || !view.toolsStreamEl.isConnected) return;
    if (view._autoScrollTools === false) return;
    const el = view.toolsStreamEl;
    const target = Math.max(0, el.scrollHeight - el.clientHeight);
    view._easedToolsTarget = target;
    const current = el.scrollTop;
    const delta = target - current;
    if (Math.abs(delta) <= 1) {
      el.scrollTop = target;
      view._lastEasedToolsWrite = target;
      return;
    }
    const next = current + delta * 0.22;
    el.scrollTop = next;
    view._lastEasedToolsWrite = next;
    view._easedToolsRaf = requestAnimationFrame(tick);
  };
  view._easedToolsRaf = requestAnimationFrame(tick);
}

// Tools column header: title, fullscreen (desktop), close. Files live on
// the top-level Files tab, not inside this panel.
export function buildToolsColHeader(view: any) {
  const fullscreen = el('button', {
    type: 'button',
    class: 'chat-tools-col__icon-btn chat-tools-col__fullscreen',
    title: view._toolsColFullscreen ? 'Restore tools panel' : 'Expand tools panel',
    onclick: () => view._toggleToolsFullscreen(),
  });
  fullscreen.innerHTML = iconHtml(view._toolsColFullscreen ? 'minimize-2' : 'maximize-2');
  view._splitFullscreenBtn = fullscreen;

  const closeBtn = el('button', {
    type: 'button',
    class: 'chat-tools-col__icon-btn chat-tools-col__close',
    title: 'Close tool calls panel',
    'aria-label': 'Close tool calls panel',
    onclick: () => view._closeToolsCol(),
  });
  closeBtn.innerHTML = iconHtml('x');
  view._splitCloseBtn = closeBtn;

  // Topbar still toggles the panel on desktop. The in-panel close is
  // required on mobile, where those topbar buttons are hidden.
  view._splitToggleBtn = null;
  view._toolsTabBtns = { tools: null };

  const header = el('div', { class: 'chat-tools-col__head' },
    el('div', { class: 'chat-tools-col__title' }, 'Tool calls'),
    el('span', { class: 'chat-tools-col__spacer' }),
    fullscreen,
    closeBtn,
  );

  view.toolsColEl.replaceChildren(header, view.toolsStreamEl);
  if (view.toolsStreamEl) view.toolsStreamEl.hidden = false;
}

export function closeToolsCol(view: any) {
  if (view._toolsColFullscreen) {
    view._toolsColFullscreen = false;
    try { localStorage.setItem(CHAT_TOOLS_FULLSCREEN_KEY, '0'); } catch { /* ignore */ }
    view._applyToolsFullscreenClass();
    if (view._splitFullscreenBtn) {
      view._splitFullscreenBtn.innerHTML = iconHtml('maximize-2');
      view._splitFullscreenBtn.title = 'Expand tools panel';
    }
  }
  if (!view._chatSplitCollapsed) view._toggleToolsCol();
}


export function readToolsColTab(_view?: any) {
  return 'tools';
}

export function readToolsColFullscreen(view: any) {
  try { return localStorage.getItem(CHAT_TOOLS_FULLSCREEN_KEY) === '1'; }
  catch { return false; }
}

export function setToolsColTab(view: any, _key?: any) {
  view._toolsColTab = 'tools';
  try { localStorage.setItem(CHAT_TOOLS_TAB_KEY, 'tools'); } catch { /* ignore */ }
  view._applyToolsColTab();
}

export function applyToolsColTab(view: any) {
  view._toolsColTab = 'tools';
  if (view.toolsStreamEl) view.toolsStreamEl.hidden = false;
  if (view.toolsFilesPaneEl) {
    view.toolsFilesPaneEl.hidden = true;
    view.toolsFilesPaneEl.replaceChildren();
  }
  view._toolsFilesMounted = false;
}

export function toggleToolsFullscreen(view: any) {
  // Mobile: stacked layout, fullscreen has no meaning since there is no
  // side-by-side split.
  if (view._isChatMobile()) return;
  // Going fullscreen on a collapsed split: expand first so the user has
  // something to look at. Otherwise toggling fullscreen on a collapsed
  // column would have no visible effect.
  if (!view._toolsColFullscreen && view._chatSplitCollapsed) {
    view._toggleToolsCol();
  }
  view._toolsColFullscreen = !view._toolsColFullscreen;
  try {
    localStorage.setItem(
      CHAT_TOOLS_FULLSCREEN_KEY,
      view._toolsColFullscreen ? '1' : '0',
    );
  } catch { /* ignore */ }
  view._applyToolsFullscreenClass();
  if (view._splitFullscreenBtn) {
    view._splitFullscreenBtn.innerHTML = iconHtml(
      view._toolsColFullscreen ? 'minimize-2' : 'maximize-2',
    );
    view._splitFullscreenBtn.title = view._toolsColFullscreen
      ? 'Restore tools panel'
      : 'Expand tools panel';
  }
}

export function applyToolsFullscreenClass(view: any) {
  if (!view.chatSplitEl) return;
  view.chatSplitEl.classList.toggle(
    'chat-split--tools-fullscreen',
    !!view._toolsColFullscreen,
  );
}

export function isValidSizesArray(view: any, a: any) {
  return Array.isArray(a) && a.length === 2 &&
    a.every((n: any) => typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100);
}

export function readAllChatSplitSizes(view: any) {
  const defaults = CHAT_SPLIT_DEFAULT_SIZES;
  try {
    const raw = localStorage.getItem(CHAT_SPLIT_SIZES_KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw);
    // Legacy format: a bare [a, b] from before per-tab sizes existed.
    // Treat it as the Tools tab's prior preference; keep the new Files
    // default unless the user has already customized it.
    if (view._isValidSizesArray(parsed)) {
      return { ...defaults, tools: parsed };
    }
    if (parsed && typeof parsed === 'object') {
      const out = { ...defaults };
      if (view._isValidSizesArray(parsed.tools)) out.tools = parsed.tools;
      if (view._isValidSizesArray(parsed.files)) out.files = parsed.files;
      return out;
    }
  } catch { /* ignore */ }
  return { ...defaults };
}

export function readChatSplitSizesForTab(view: any, tab: any) {
  const all: any = view._readAllChatSplitSizes();
  return (all[tab] || all.tools).slice();
}

export function writeChatSplitSizesForTab(view: any, tab: any, sizes: any) {
  if (!view._isValidSizesArray(sizes)) return;
  const all: any = view._readAllChatSplitSizes();
  all[tab] = sizes;
  try { localStorage.setItem(CHAT_SPLIT_SIZES_KEY, JSON.stringify(all)); }
  catch { /* ignore */ }
}

export function isChatMobile(view: any) {
  return window.innerWidth <= CHAT_SPLIT_MOBILE_MAX;
}

/** First visit is collapsed. Saved "0" means the user opened tools. */
export function mobileToolsStartCollapsed(stored: string | null): boolean {
  return stored !== '0';
}

export function initChatSplit(view: any) {
  if (view._chatSplit) return;
  // Mobile: don't init Split.js. CSS stacks the tools column below the
  // chat stream (see .chat-split @media block). Hide the in-header toggle
  // since it has no meaning when the layout is stacked.
  if (view._isChatMobile()) {
    let stored: string | null = null;
    try { stored = localStorage.getItem(CHAT_SPLIT_MOBILE_COLLAPSED_KEY); } catch { /* ignore */ }
    view._chatSplitCollapsed = mobileToolsStartCollapsed(stored);
    if (stored == null) {
      try { localStorage.setItem(CHAT_SPLIT_MOBILE_COLLAPSED_KEY, '1'); } catch { /* ignore */ }
    }
    view._applyChatSplitCollapsedClass();
    return;
  }
  if (view._splitToggleBtn) view._splitToggleBtn.hidden = false;

  // Default collapsed: thinking + tools + answer stay in one stream.
  // Users can still expand the side panel; stored '0' keeps it open.
  let collapsed = true;
  try {
    const stored = localStorage.getItem(CHAT_SPLIT_COLLAPSED_KEY);
    if (stored === '0') collapsed = false;
  } catch { /* ignore */ }
  // Seed the cached "last sizes" from the currently active tab so an
  // expand-after-collapse comes back to the right width for that tab.
  view._chatSplitLastSizes = view._readChatSplitSizesForTab(view._toolsColTab);

  const buildSplit = (sizes: any) => {
    view._chatSplit = Split([view.streamEl, view.toolsColEl], {
      sizes,
      minSize: [400, 240],
      gutterSize: 6,
      snapOffset: 0,
      expandToMin: true,
      direction: 'horizontal',
      elementStyle: (dim, size, gutterSize) => ({
        'flex-basis': `calc(${size}% - ${gutterSize}px)`,
      }),
      gutterStyle: (dim, gutterSize) => ({ 'flex-basis': `${gutterSize}px` }),
      onDragEnd: (next) => {
        // Persist under the tab that is active at the moment of the
        // drag. Users get a remembered width per tab without any
        // explicit "save" step.
        view._chatSplitLastSizes = next;
        view._writeChatSplitSizesForTab(view._toolsColTab, next);
      },
    });
  };

  view._chatSplitCollapsed = collapsed;
  view._applyChatSplitCollapsedClass();
  view._applyToolsFullscreenClass();
  view._updateToolsToggleLabel();
  if (!collapsed) buildSplit(view._chatSplitLastSizes);
  view._chatSplitBuild = buildSplit;
}

export function destroyChatSplit(view: any) {
  if (view._chatSplit) {
    // No args: Split.js clears its inline flex-basis from both panes
    // (and removes the gutter). Preserving inline styles would leave
    // the chat-stream stuck at its dragged width even after the
    // tools column collapses, which fights the CSS rule that
    // reclaims the freed space.
    try { view._chatSplit.destroy(); } catch { /* ignore */ }
    view._chatSplit = null;
  }
}

export function applyChatSplitCollapsedClass(view: any) {
  if (!view.chatSplitEl) return;
  view.chatSplitEl.classList.toggle('chat-split--tools-collapsed', !!view._chatSplitCollapsed);
  // Notify the topbar so its right-side panel icon can reflect state.
  document.dispatchEvent(new CustomEvent('grok-remote:tools-state', {
    detail: { collapsed: !!view._chatSplitCollapsed },
  }));
}

export function updateToolsToggleLabel(view: any) {
  if (!view._splitToggleBtn) return;
  const c = !!view._chatSplitCollapsed;
  view._splitToggleBtn.textContent = c ? '⟨' : '⟩';
  view._splitToggleBtn.title = c ? 'Expand tools panel' : 'Collapse tools panel';
}

export function toggleToolsCol(view: any) {
  if (view._isChatMobile()) {
    const next = !view._chatSplitCollapsed;
    view._chatSplitCollapsed = next;
    try { localStorage.setItem(CHAT_SPLIT_MOBILE_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    view._applyChatSplitCollapsedClass();
    return;
  }
  const next = !view._chatSplitCollapsed;
  view._chatSplitCollapsed = next;
  try { localStorage.setItem(CHAT_SPLIT_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  if (next) {
    view._destroyChatSplit();
  } else if (view._chatSplitBuild) {
    view._chatSplitBuild(view._chatSplitLastSizes);
  }
  view._applyChatSplitCollapsedClass();
  view._updateToolsToggleLabel();
}


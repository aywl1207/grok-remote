// Composer send / queue / payload inspector / cancel.

import { api } from '../../lib/api';
import { el } from '../../lib/render';
import { renderErrorBanner } from '../../lib/render';
import { conversationIsWorking, hasPromptDraft, consumeForcePayload, pickForceSendPayload, shouldForceQueueSend, shouldFlushQueueOnIdle, chatIsReadyToSend, queueReason } from '../../lib/force-queue.js';
import { applyForceScrollFlags } from '../../lib/chat-scroll.js';
import { alreadyHasOptimisticUser } from '../../lib/conversation-log.js';
import { LOCAL_TURN_HOLD_MS } from '../../../lib/agent-status.js';
import { hasQueueContent, saveAgentQueue } from '../../lib/prompt-queue.js';
import { GROK_BUILD_COMMANDS, localHrefForSlash } from '../../lib/grok-commands.js';
import { normalizeNewlines } from '../../lib/render/markdown.js';
import { isCompactJournalEvent } from '../../../lib/compact-status.js';

/** Enter sends unless IME composition is active (isComposing or keyCode 229). */
export function shouldSendComposerEnter(ev: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
} | null | undefined): boolean {
  if (!ev || ev.key !== 'Enter' || ev.shiftKey) return false;
  if (ev.isComposing || ev.keyCode === 229) return false;
  return true;
}

/** `/skills` etc. navigate locally. Prefer merged commands, then builtins. */
export function localSessionHref(
  text: string,
  merged?: Array<{ name: string; kind?: string; href?: string }> | null,
): string | null {
  return localHrefForSlash(text, merged || []) || localHrefForSlash(text, GROK_BUILD_COMMANDS);
}

/** Compact lifecycle SSE must not be dropped as a child-session payload. */
export function shouldDropChildEvent(name: unknown, payload: unknown, isChild: boolean): boolean {
  if (!isChild) return false;
  if (isCompactJournalEvent(String(name || ''), payload)) return false;
  return true;
}

export function canStartCompact(view: { agentId?: unknown; _compacting?: unknown } | null | undefined): boolean {
  return !!(view && view.agentId) && !view._compacting;
}

/** Settle waiter timed out: unlock send, keep the card, leave finished false. */
export function applyCompactSettleTimeout(view: any): void {
  if (!view || view._compactFinished) return;
  view._compacting = false;
  if (typeof view._renderTokensPill === 'function') view._renderTokensPill();
  if (typeof view._paintLiveStatus === 'function') view._paintLiveStatus();
  if (typeof view._syncSendBtn === 'function') view._syncSendBtn();
}

export function removeRootBlockingCards(root: any): void {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('.plan-card, .perm-card').forEach((n: Element) => {
    try { n.remove(); } catch { /* ignore */ }
  });
}

export function isWorking(view: any) {
  const a = view.currentAgent;
  return conversationIsWorking({
    forceSending: !!view._forceSending,
    turnOpen: !!view._turnOpen,
    hasOpenTurn: !!(view.activeTurn && !view.activeTurn.footer),
    inFlight: a && typeof a.inFlight === 'number' ? a.inFlight : 0,
    compacting: !!view._compacting,
    status: a && a.status,
    connected: a ? a.connected !== false : true,
  });
}

export function viewIsReadyToSend(view: any): boolean {
  const a = view && view.currentAgent;
  const host = view && (view.root || (typeof document !== 'undefined' ? document : null));
  const blocked = !!(host && typeof host.querySelector === 'function' && (
    host.querySelector('.plan-card:not(.plan-card--q)')
    || host.querySelector('.plan-card--q')
    || host.querySelector('.perm-card')
  ));
  return chatIsReadyToSend({
    agentId: view && view.agentId,
    replaying: !!(view && view._isReplaying),
    forceSending: !!(view && view._forceSending),
    flushing: !!(view && view._flushingQueue),
    steering: !!(view && view._steering),
    connected: a ? a.connected !== false : false,
    status: a && a.status,
    working: isWorking(view),
    blocked,
  });
}

export function scheduleFlushQueue(view: any) {
  if (!view || !view._promptQueue) return;
  if (!shouldFlushQueueOnIdle({ forceSending: !!view._forceSending, flushing: !!view._flushingQueue, steering: !!view._steering })) return;
  if (view._flushTimer) clearTimeout(view._flushTimer);
  view._flushTimer = setTimeout(() => {
    view._flushTimer = null;
    void flushQueue(view);
  }, 50);
}

// Live bar is only for work that is actually in flight.
// History cards default to Pending when the terminal update is missing,
// so Pending from replay must not keep "Working · 1 Running" stuck.
export function wantLiveChip(_view: any, live: boolean, st: string): boolean {
  if (st === 'Running') return true;
  if (st === 'Pending') return !!live;
  return false;
}

export function pruneLiveBar(view: any) {
  view._resyncInFlightStrip();
  if (!view._isWorking()) view._clearAllInFlight();
  for (const [tid, rec] of [...(view._subagentMap || new Map()).entries()]) {
    const st = String(rec.card && rec.card.getStatus && rec.card.getStatus() || '');
    if (st === 'Running') continue;
    if (st === 'Pending' && view._isWorking()) continue;
    view._untrackSubagent(tid);
  }
}

export function persistQueue(view: any) {
  saveAgentQueue(view && view.agentId, view && view._promptQueue);
}

export function syncSendBtn(view: any) {
  if (!view.composerSend) return;
  const queued = hasQueueContent(view._promptQueue);
  if (!view._isWorking()) {
    view.composerSend.textContent = 'Send';
    view.composerSend.title = queued ? 'Send the queued message' : 'Send';
    return;
  }
  if (queued) {
    view.composerSend.textContent = 'Send Now';
    view.composerSend.title = 'Send now: cancel this turn and send the queued message';
    return;
  }
  view.composerSend.textContent = 'Queue';
  view.composerSend.title = 'Agent is working. Queue this message, or tap again / double Enter to send now.';
}

export function renderQueueBar(view: any) {
  const bar = view.queueBarEl;
  if (!bar) return;
  const q = view._promptQueue;
  if (!q || !(q.text || (q.attachments && q.attachments.length))) {
    bar.hidden = true;
    bar.replaceChildren();
    view._syncSendBtn();
    return;
  }
  bar.hidden = false;
  const preview = String(q.text || '').replace(/\s+/g, ' ').slice(0, 120) || '(attachment)';
  bar.replaceChildren(
    el('span', { class: 'composer-queue__kicker' }, 'Queued'),
    el('span', { class: 'composer-queue__text' }, preview),
    el('button', {
      type: 'button',
      class: 'composer-queue__edit',
      title: 'Edit this queued message. It will not send until you do.',
      onclick: () => editQueued(view),
    }, 'Edit'),
    el('button', {
      type: 'button',
      class: 'composer-queue__steer',
      title: 'Inject into this turn without cancelling',
      onclick: () => { void view._steerQueued(); },
    }, 'Steer'),
    el('button', {
      type: 'button',
      class: 'composer-queue__send',
      title: 'Cancel this turn and send the queued message next',
      onclick: () => { void view._forceSendQueued(); },
    }, 'Send Now'),
    el('button', {
      type: 'button',
      class: 'composer-queue__clear',
      onclick: () => { view._promptQueue = null; persistQueue(view); view._renderQueueBar(); },
    }, 'Clear'),
  );
  view._syncSendBtn();
}

export function enqueuePrompt(view: any, text: string, attachments: any[], opts?: { reason?: 'working' | 'not-ready'; silent?: boolean }) {
  view._promptQueue = { text, attachments };
  persistQueue(view);
  view._renderQueueBar();
  if (opts && opts.silent) return;
  const reason = (opts && opts.reason) || queueReason({ working: isWorking(view) });
  view.showToast(
    reason === 'working'
      ? 'Queued. Steer injects it into this turn; Send Now cancels and runs it next.'
      : 'Queued. Will send when the chat is ready.',
    'info',
  );
}

export function editQueued(view: any) {
  const q = view && view._promptQueue;
  if (!q) return;
  view._queueEditing = true;
  const text = String(q.text || '');
  view._promptQueue = null;
  persistQueue(view);
  view._renderQueueBar();
  if (view.composerTa) {
    view.composerTa.value = text;
    try { view.composerTa.focus(); } catch { /* ignore */ }
    const n = text.length;
    try { view.composerTa.setSelectionRange(n, n); } catch { /* ignore */ }
  }
  view._queueEditing = false;
  view.showToast('Queued message is in the composer. It will not send until you do.', 'info');
}

export async function flushQueue(view: any) {
  if (view && view._queueEditing) return;
  const q = view._promptQueue;
  if (!q || !view.agentId) return;
  if (view._flushingQueue || view._forceSending || view._steering) return;
  if (!viewIsReadyToSend(view)) return;
  view._flushingQueue = true;
  view._promptQueue = null;
  persistQueue(view);
  view._renderQueueBar();
  try {
    await sendPrompt(view, { fromQueue: true, text: q.text || '', attachments: q.attachments || [] });
  } finally {
    view._flushingQueue = false;
  }
}


export async function steerQueued(view: any) {
  if (!view.agentId || view._steering || view._forceSending) return;
  const draftText = view.composerTa ? String(view.composerTa.value || '').trim() : '';
  const draftAtts = view.imageAttach ? view.imageAttach.getAttachments() : [];
  const payload = pickForceSendPayload({
    queue: view._promptQueue,
    draftText,
    draftAttachments: draftAtts,
  });
  if (!payload) {
    view.showToast('Nothing queued to steer.', 'warn');
    return;
  }
  if (!view._isWorking()) {
    await sendPrompt(view, { text: payload.text || '', attachments: payload.attachments || [] });
    return;
  }
  view._steering = true;
  try {
    await api.interject(view.agentId, { text: payload.text || '', attachments: payload.attachments || [] });
    const queued = !!(view._promptQueue && (String(view._promptQueue.text || '').trim() || (view._promptQueue.attachments && view._promptQueue.attachments.length)));
    if (queued) {
      view._promptQueue = null;
      persistQueue(view);
      view._renderQueueBar();
    } else {
      if (view.composerTa) view.composerTa.value = '';
      if (view.imageAttach) view.imageAttach.clear();
    }
    view.showToast('Steering this turn. Grok will take it at the next safe gap.', 'info');
  } catch (e: any) {
    const msg = e && e.message ? String(e.message) : String(e || 'interject failed');
    view.showToast(msg, 'warn');
  } finally {
    view._steering = false;
    view._syncSendBtn();
  }
}

export async function forceSendQueued(view: any) {
  if (!view.agentId || view._forceSending) return;
  const draftText = view.composerTa ? String(view.composerTa.value || '').trim() : '';
  const draftAtts = view.imageAttach ? view.imageAttach.getAttachments() : [];
  const consumed = consumeForcePayload({
    queue: view._promptQueue,
    draftText,
    draftAttachments: draftAtts,
  });
  if (!consumed.payload) {
    view.showToast('Nothing queued to send.', 'warn');
    return;
  }
  // Drop the queue before cancel. Cancel looks idle and used to flush the
  // same item, so Send Now painted the You bubble twice.
  if (consumed.clearQueue) {
    view._promptQueue = null;
    persistQueue(view);
    view._renderQueueBar();
  }
  if (consumed.clearDraft) {
    if (view.composerTa) view.composerTa.value = '';
    if (view.imageAttach) view.imageAttach.clear();
  }
  const q = consumed.payload;
  const wasWorking = view._isWorking();
  view._forceSending = true;
  try {
    if (wasWorking) {
      try { await api.cancel(view.agentId); } catch { /* send anyway */ }
      view._turnOpen = false;
      view._turnOpenHoldUntil = 0;
      if (view.activeTurn) view.endTurn({ stopReason: 'cancelled' });
      try {
        document.dispatchEvent(new CustomEvent('grok-remote:agent-working', {
          detail: { id: view.agentId, working: false },
        }));
      } catch { /* ignore */ }
    }
    view.showToast(wasWorking ? 'Sending now. Current turn cancelled.' : 'Sending now.', 'info');
    await sendPrompt(view, { force: true, text: q.text || '', attachments: q.attachments || [] });
  } finally {
    view._forceSending = false;
    view._lastEnterAt = 0;
  }
}

export function clearComposerDraft(view: any) {
  if (view && view.composerTa) view.composerTa.value = '';
  if (view && view.composerHint) {
    view.composerHint.classList.add('hidden');
    view.composerHint.textContent = '';
  }
  if (view && view.palette && view.palette.classList) view.palette.classList.add('hidden');
  if (view && view.imageAttach && typeof view.imageAttach.clear === 'function') {
    view.imageAttach.clear();
  }
}

export async function sendPrompt(view: any, opts?: {
  force?: boolean;
  viaEnter?: boolean;
  fromQueue?: boolean;
  text?: string;
  attachments?: any[];
}) {
  if (!view.agentId) return;
  const rawText = opts && opts.text != null
    ? String(opts.text || '')
    : (view.composerTa ? String(view.composerTa.value || '') : '');
  const text = normalizeNewlines(rawText).trim();
  const attachments = opts && Array.isArray(opts.attachments)
    ? opts.attachments
    : (view.imageAttach ? view.imageAttach.getAttachments() : []);
  // Wipe the box before any await. Local /commands (especially /compact)
  // used to leave the draft visible until the handler finished.
  if (text || attachments.length) clearComposerDraft(view);
  try {
    if (await view._tryLocalModelCommand(text) || await view._tryLocalSessionCommand(text)) {
      return;
    }
  } catch (e: any) {
    if (text && view.composerTa && !String(view.composerTa.value || '').trim()) {
      view.composerTa.value = text;
    }
    if (typeof view.showToast === 'function') {
      view.showToast(e && e.message ? e.message : String(e), 'warn');
    }
    return;
  }
  const queued = !!(view._promptQueue && (view._promptQueue.text || (view._promptQueue.attachments && view._promptQueue.attachments.length)));
  const force = shouldForceQueueSend({
    working: view._isWorking(),
    force: !!(opts && opts.force),
    hasQueue: queued,
    hasDraft: hasPromptDraft(text, attachments),
    viaEnter: !!(opts && opts.viaEnter),
    lastEnterAt: view._lastEnterAt || 0,
    now: Date.now(),
  });
  if (opts && opts.viaEnter) view._lastEnterAt = Date.now();
  if (force && !opts?.force) {
    await forceSendQueued(view);
    return;
  }
  if (!text && !attachments.length) return;
  // flushQueue sets _flushingQueue before calling us. That flag makes
  // viewIsReadyToSend false, which used to put the queued text straight
  // back and never send it.
  if (!force && !opts?.fromQueue && !viewIsReadyToSend(view)) {
    enqueuePrompt(view, text, attachments, { reason: queueReason({ working: isWorking(view) }) });
    if (view.composerTa) view.composerTa.value = '';
    if (view.imageAttach) view.imageAttach.clear();
    if (view.composerHint) {
      view.composerHint.classList.add('hidden');
      view.composerHint.textContent = '';
    }
    return;
  }
  view._pushPromptHist(text);

  // Snapshot the payload for the inspector after the draft is already captured.
  view._lastPayload = view._buildPayloadSnapshot(text, attachments);
  view._lastServerEcho = null;

  clearComposerDraft(view);

  // Start a turn locally and let the SSE stream fill in the rest.
  // The user just sent a message; they want to see it land, so re-enable
  // auto-scroll regardless of where they were in the history.
  applyForceScrollFlags(view);
  view._historyInsertBefore = null;
  if (view._jumpToLatestBtn) view._jumpToLatestBtn.hidden = true;
  view._turnOpen = true;
  view._turnOpenHoldUntil = Date.now() + LOCAL_TURN_HOLD_MS;
  try {
    document.dispatchEvent(new CustomEvent('grok-remote:agent-working', {
      detail: { id: view.agentId, working: true },
    }));
  } catch { /* ignore */ }
  const lastTurn = Array.isArray(view.turns) && view.turns.length
    ? view.turns[view.turns.length - 1]
    : view.activeTurn;
  if (!alreadyHasOptimisticUser(lastTurn, text)) {
    view.startTurn(text, { attachments });
  }
  view.scrollToBottom({ force: true });
  const snap = () => {
    if (!view.agentId || view._userScrollIntent) return;
    view.scrollToBottom({ force: true });
  };
  requestAnimationFrame(snap);
  setTimeout(snap, 80);
  setTimeout(snap, 220);
  view.composerCancel.disabled = false;
  view._syncSendBtn();

  try {
    const resp = await api.prompt(view.agentId, { text, attachments, force: !!(opts && opts.force) });
    view._lastServerEcho = resp && typeof resp === 'object' ? resp : null;
    if (view.imageAttach) view.imageAttach.clear();
  } catch (e: any) {
    view._turnOpen = false;
    view._turnOpenHoldUntil = 0;
    view.activeTurn && view.activeTurn.root.appendChild(renderErrorBanner(e.message));
    if (view.activeTurn && typeof view.endTurn === 'function') view.endTurn(null);
    if (!viewIsReadyToSend(view) && (text || attachments.length)) {
      enqueuePrompt(view, text, attachments, { reason: 'not-ready' });
    }
    if (typeof view._paintLiveStatus === 'function') view._paintLiveStatus();
  }
}

export function buildPayloadSnapshot(view: any, text: any, attachments: any) {
  // Build the same body shape api.prompt would send, so the inspector
  // shows the exact wire payload (base64 included).
  const safeAttachments = (attachments || []).map((a: any) => ({
    kind:       a.kind || 'image',
    name:       a.name || null,
    mimeType:   a.mimeType || null,
    size:       a.size || null,
    dataBase64: a.dataBase64 || '',
  }));
  const body: any = { text };
  if (safeAttachments.length) body.attachments = safeAttachments;
  return {
    method:  'POST',
    url:     `/api/agents/${view.agentId}/prompt`,
    body,
    sentAt:  new Date().toISOString(),
  };
}

export function openPayloadInspector(view: any) {
  // Build a "current draft" snapshot from the composer + attachments so
  // the inspector works both before send (preview) and after send (echo).
  const text = view.composerTa ? view.composerTa.value : '';
  const attachments = view.imageAttach ? view.imageAttach.getAttachments() : [];
  const draftPayload = (text.trim() || attachments.length)
    ? view._buildPayloadSnapshot(text.trim(), attachments)
    : null;

  if (view._payloadModal) {
    try { view._payloadModal.remove(); } catch { /* ignore */ }
    view._payloadModal = null;
  }

  const close = () => {
    if (view._payloadModal) {
      try { view._payloadModal.remove(); } catch { /* ignore */ }
      view._payloadModal = null;
    }
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (ev: any) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const dumpBlock = (title: any, value: any, opts: any = {}) => {
    const pretty = value == null ? 'null' : JSON.stringify(value, null, 2);
    const shown = pretty.length > 20000 && !opts.full
      ? view._truncateBase64(pretty)
      : pretty;
    const pre = el('pre', { class: 'payload-pre' }, shown);
    const copyBtn = el('button', {
      class: 'btn btn--ghost payload-copy',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(pretty);
          view.showToast('Payload copied.', 'info');
        } catch (e: any) {
          view.showToast(`Copy failed: ${e.message}`, 'warn');
        }
      },
    }, 'Copy');
    return el('section', { class: 'payload-section' },
      el('header', { class: 'payload-section-head' },
        el('h3', null, title),
        copyBtn,
      ),
      pre,
    );
  };

  const sections = [];
  if (draftPayload) {
    sections.push(dumpBlock(
      'composer draft (would be sent on click)',
      draftPayload,
    ));
  }
  if (view._lastPayload) {
    sections.push(dumpBlock(
      'last sent request body',
      view._lastPayload,
    ));
  }
  if (view._lastServerEcho) {
    sections.push(dumpBlock(
      'server response (echoed back, after attachment processing)',
      view._lastServerEcho,
    ));
  }
  if (!sections.length) {
    sections.push(el('div', { class: 'payload-empty' },
      'No payload yet. Type or attach something, then click here to preview,',
      ' or send a message and reopen this panel to see the actual request.'));
  }

  const closeBtn = el('button', {
    class: 'btn btn--ghost payload-close',
    type: 'button',
    onclick: close,
  }, 'Close');

  const modal = el('div', { class: 'payload-modal' },
    el('div', { class: 'payload-modal-backdrop', onclick: close }),
    el('div', { class: 'payload-modal-card' },
      el('header', { class: 'payload-modal-head' },
        el('h2', null, 'Outgoing prompt payload'),
        el('div', { class: 'payload-modal-hint' },
          'Base64 image data is truncated in the view; the copy button copies the FULL payload to your clipboard.'),
        closeBtn,
      ),
      el('div', { class: 'payload-modal-body' }, ...sections),
    ),
  );
  view._payloadModal = modal;
  document.body.appendChild(modal);
}

export function truncateBase64(view: any, pretty: any) {
  // Replace long dataBase64 strings inline with a "<NNN bytes>" placeholder
  // so the panel stays readable. The copy button still copies the original.
  return pretty.replace(/"dataBase64": "([A-Za-z0-9+/=]{200,})"/g, (_m: any, b64: any) => {
    return `"dataBase64": "<base64, ${b64.length} chars; copied in full when you click copy>"`;
  });
}

export async function cancelPrompt(view: any) {
  if (!view.agentId) return;
  view._turnOpen = false;
  view._turnOpenHoldUntil = 0;
  if (view.currentAgent) {
    view.currentAgent.turnOpen = false;
    if (view.currentAgent.status === 'running') view.currentAgent.status = 'idle';
    view.currentAgent.inFlight = 0;
  }
  try {
    document.dispatchEvent(new CustomEvent('grok-remote:agent-working', {
      detail: { id: view.agentId, working: false },
    }));
  } catch { /* ignore */ }
  if (typeof view._finalizePendingTools === 'function') {
    view._finalizePendingTools({ includeActive: true });
  }
  if (view.activeTurn && typeof view.endTurn === 'function') {
    view.endTurn({ stopReason: 'cancelled' });
  }
  if (typeof view._paintLiveStatus === 'function') view._paintLiveStatus();
  if (typeof view._syncSendBtn === 'function') view._syncSendBtn();
  scheduleFlushQueue(view);
  try {
    await api.cancel(view.agentId);
    view.showToast('Turn cancelled.', 'warn');
  } catch (e: any) {
    view.showToast('Turn cancelled here. The agent may still be finishing.', 'warn');
  }
}

// ── settings drawer ─────────────────────────────────────────────────
// Implementation: ./chat/settings-drawer.ts

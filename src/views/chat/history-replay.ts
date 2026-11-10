// Two-pass history replay for ChatView.

export const FIRST_LOAD_TURNS = 3;
export const LOAD_EARLIER_STEP = 3;

export function nextEarlierTurnCount(have: number, total: number, step = LOAD_EARLIER_STEP): number {
  if (!Number.isFinite(have) || !Number.isFinite(total)) return 0;
  const remaining = Math.max(0, Math.floor(total) - Math.floor(have));
  if (remaining <= 0) return 0;
  return Math.min(Math.max(1, step), remaining);
}

function paintedUserTurns(view: any): number {
  return (view.turns || []).filter((t: any) => t && String(t.userText || '').trim()).length;
}
// Latest turn first (You + thought + reply), then older turns above.
// Policy: src/lib/history-events.ts

import { api } from '../../lib/api';
import { el } from '../../lib/render';
import { shouldMarkInterruptedTurn } from '../../lib/interrupted-turn.js';
import {
  eventNameOf,
  shouldSkipCatchUpEvent,
  shouldSkipHistoryReplay,
  isHistoryPass1,
  classifyHistoryPass2,
  splitHistoryLatestTurn,
  dropEventsBeforeFirstUser,
  shouldSkipCatchUpFetch,
} from '../../lib/history-events.js';
import { parseLiveEventId, maxLiveEventId } from '../../lib/event-id.js';
import { sameUserText } from '../../lib/user-text.js';
import { collapseHistoryForReplay } from '../../../lib/history-collapse.js';
import { lastTurnIsOpen } from '../../../lib/turn-open.js';
import { holdScrollForPrepend, restorePinScroll } from '../../lib/chat-scroll.js';

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function applyNewHistoryEvents(view: any, events: any[]) {
  if (!Array.isArray(events) || !events.length) return;
  events = dropEventsBeforeFirstUser(collapseHistoryForReplay(events));
  let applied = 0;
  let skipPaintedTurn = false;
  for (const ev of events) {
    const eid = ev && ev.eventId;
    if (eid && view._alreadyInHistory(eid)) continue;
    const name = eventNameOf(ev);
    if (shouldSkipCatchUpEvent(name)) continue;
    if (name === 'user_message') {
      const data = ev.data || ev.payload || ev || {};
      const text = String((data && (data.text || (data.update && data.update.text))) || '').trim();
      skipPaintedTurn = !!(text && (view.turns || []).some((turn: any) => sameUserText(turn.userText, text)));
    }
    if (skipPaintedTurn) {
      if (eid && parseLiveEventId(eid)) view._lastHistoryEventId = maxLiveEventId(view._lastHistoryEventId, eid);
      continue;
    }
    const t = Date.parse(ev.at);
    if (Number.isFinite(t)) view._lastEventTs = t;
    view.handleEvent(name, ev.data || ev.payload || ev, { fromHistory: true });
    if (eid && parseLiveEventId(eid)) view._lastHistoryEventId = maxLiveEventId(view._lastHistoryEventId, eid);
    applied += 1;
  }
  view._lastEventTs = null;
  return applied;
}

export async function catchUpHistory(view: any, opts?: { force?: boolean }) {
  const force = !!(opts && opts.force);
  if (!view.agentId) return;
  const last = view.turns && view.turns.length ? view.turns[view.turns.length - 1] : null;
  if (shouldSkipCatchUpFetch({
    force,
    replaying: !!view._isReplaying,
    historyLoaded: !!view._historyLoaded,
    turnCount: view.turns ? view.turns.length : 0,
    activeTurn: !!view.activeTurn,
    lastTurnComplete: !!(last && String(last.userText || '').trim() && last.assistant),
  })) return;
  try {
    // Never wipe an already-painted stream on catch-up. Full replaceChildren
    // is what made the conversation blink after reconnect.
    if (view._historyLoaded && view.turns && view.turns.length) {
      const hist: any = await api.history(view.agentId, { turns: FIRST_LOAD_TURNS });
      const events: any[] = (hist && Array.isArray(hist.events)) ? hist.events : [];
      applyNewHistoryEvents(view, events);
      return;
    }
    await view.refreshHistory({ turns: FIRST_LOAD_TURNS, force: true });
  } catch { /* ignore */ }
}

export function showChatLoading(view: any) {
  if (view.loadingEl) view.loadingEl.hidden = false;
}

export function hideChatLoading(view: any) {
  if (view.loadingEl) view.loadingEl.hidden = true;
}

export function replayHistoryEvent(view: any, ev: any) {
  const name = eventNameOf(ev);
  if (shouldSkipHistoryReplay(name)) return;
  const t = Date.parse(ev.at);
  if (Number.isFinite(t)) view._lastEventTs = t;
  const data = ev.data || ev.payload || ev;
  view.handleEvent(name, data, { fromHistory: true });
  return name;
}

/** Latest turn in collapsed order so thought sits above the reply. */
function replayLatestTurn(view: any, events: any[], keepTools: boolean) {
  let lastTurnHadComplete = false;
  for (const ev of events) {
    const name = eventNameOf(ev);
    if (shouldSkipHistoryReplay(name)) continue;
    if (name === 'tool_call_update') continue;
    if (!keepTools && name === 'tool_call') continue;
    const applied = view._replayHistoryEvent(ev);
    if (applied === 'user_message') lastTurnHadComplete = false;
    if (applied === 'prompt_complete') lastTurnHadComplete = true;
  }
  return lastTurnHadComplete;
}

function latestReplyPainted(view: any) {
  const last = view.turns && view.turns.length ? view.turns[view.turns.length - 1] : null;
  if (!last || !last.root) return false;
  if (!view._historyLastHasReply) return true;
  const node = last.assistant && last.assistant.node;
  if (!node) return false;
  const h = Math.max(node.offsetHeight || 0, node.getBoundingClientRect().height || 0);
  return h >= 8;
}

async function waitUntilLatestReady(view: any, gen: number, maxFrames = 8) {
  let frames = 0;
  while (frames < maxFrames) {
    if (gen !== view._historyGen) return false;
    if (typeof view._scrollStreamToEnd === 'function') view._scrollStreamToEnd();
    else if (typeof view._snapLatestTurn === 'function') view._snapLatestTurn();
    else if (view.streamEl) view.streamEl.scrollTop = view.streamEl.scrollHeight;
    if (latestReplyPainted(view)) return true;
    frames += 1;
    await nextFrame();
  }
  if (typeof view._scrollStreamToEnd === 'function') view._scrollStreamToEnd();
  else if (typeof view._snapLatestTurn === 'function') view._snapLatestTurn();
  return latestReplyPainted(view);
}

export async function refreshHistory(view: any, { all = false, turns = 80, force = false, preserveAnchor = false } = {}) {
  if (!view.agentId) return;
  view._historyAll = !!all;
  const gen = (view._historyGen = (view._historyGen || 0) + 1);
  try {
    const hist: any = await api.history(view.agentId, { turns, all });
    if (gen !== view._historyGen) return;
    const rawEvents: any[] = (hist && Array.isArray(hist.events)) ? hist.events : [];
    const events: any[] = collapseHistoryForReplay(rawEvents);
    view._historyLoaded = true;
    if (!events.length && view.turns && view.turns.length) return;
    // A live send already painted a turn; do not wipe it with a late history
    // response (that used to blank the UI mid-message). Initial open uses
    // force so a racing SSE ring cannot block the first paint.
    if (!force && view.activeTurn && view.turns && view.turns.length && !view._isReplaying) {
      view._applyNewHistoryEvents(events);
      return;
    }
    const anchorText = preserveAnchor && view.turns && view.turns[0]
      ? String(view.turns[0].userText || '')
      : '';
    view._showChatLoading();
    view.streamEl.replaceChildren();
    if (view.toolsStreamEl) view.toolsStreamEl.replaceChildren();
    if (view.root) view.root.querySelectorAll('.plan-card, .perm-card').forEach((n: Element) => n.remove());
    view.turns = [];
    view.activeTurn = null;
    view._historyInsertBefore = null;
    // If there are older turns we didn't load, show a banner at the top.
    const total = (hist && hist.totalTurns) || 0;
    const returned = (hist && hist.returnedTurns) || 0;
    if (!all && total > returned && returned > 0) {
      view.streamEl.appendChild(view._buildLoadEarlierBanner(total - returned));
    }
    view._historyTotalTurns = total;
    let lastHasReply = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const n = eventNameOf(events[i]);
      if (n === 'agent_message_chunk') { lastHasReply = true; break; }
      if (n === 'user_message') break;
    }
    view._historyLastHasReply = lastHasReply;
    view._isReplaying = true;
    let lastHid = (hist && hist.lastEventId) || view._lastHistoryEventId || '';
    let lastTurnHadComplete = false;
    try {
      // Collapse keeps only the first chunk id. Raw ids must win or the
      // SSE ring restreams the last reply as a second bubble.
      for (const ev of rawEvents) {
        if (ev && ev.eventId && parseLiveEventId(ev.eventId)) {
          lastHid = maxLiveEventId(lastHid, ev.eventId);
        }
      }
      for (const ev of events) {
        if (ev && ev.eventId && parseLiveEventId(ev.eventId)) {
          lastHid = maxLiveEventId(lastHid, ev.eventId);
        }
      }
      let usersInPayload = 0;
      for (const ev of events) {
        if (eventNameOf(ev) === 'user_message') usersInPayload += 1;
      }
      const keepToolsFrom = Math.max(0, usersInPayload - 2);
      const split = splitHistoryLatestTurn(events);
      const older = dropEventsBeforeFirstUser(split.older);
      const latest = split.latest;

      // Latest turn first, in collapsed order (thought above reply).
      // Overlay stays up until older turns are in the DOM too.
      lastTurnHadComplete = replayLatestTurn(view, latest, usersInPayload - 1 >= keepToolsFrom);
      view._syncTodoDock();
      const lastTurn = view.turns && view.turns.length ? view.turns[view.turns.length - 1] : null;
      view._historyInsertBefore = lastTurn && lastTurn.root ? lastTurn.root : null;
      view._quietScroll = true;
      if (view.streamEl) view.streamEl.classList.add('chat-stream--prepend');
      await nextFrame();
      if (gen !== view._historyGen) return;
      if (typeof view._scrollStreamToEnd === 'function') view._scrollStreamToEnd();

      // Older turns: You + reply, then thoughts/tools. Insert above latest.
      // Keep the cover up so a send during prepend cannot land on a pin.
      const OLDER_BATCH = 8;
      let sinceYield = 0;
      for (const ev of older) {
        if (!isHistoryPass1(eventNameOf(ev))) continue;
        view._replayHistoryEvent(ev);
        sinceYield += 1;
        if (sinceYield >= OLDER_BATCH) {
          sinceYield = 0;
          await nextFrame();
          if (gen !== view._historyGen) return;
        }
      }
      let turnIdx = -1;
      sinceYield = 0;
      for (const ev of older) {
        const name = eventNameOf(ev);
        const kind = classifyHistoryPass2(name);
        if (kind === 'user') { turnIdx += 1; continue; }
        if (kind === 'skip') continue;
        if (name === 'tool_call_update') continue;
        if (turnIdx < keepToolsFrom && name === 'tool_call') continue;
        if (turnIdx >= 0 && view.turns[turnIdx]) view.activeTurn = view.turns[turnIdx];
        view._replayHistoryEvent(ev);
        sinceYield += 1;
        if (sinceYield >= 24) {
          sinceYield = 0;
          await nextFrame();
          if (gen !== view._historyGen) return;
        }
      }
    } finally {
      view._isReplaying = false;
      view._historyInsertBefore = null;
      if (view.streamEl) view.streamEl.classList.remove('chat-stream--prepend');
      view._syncTodoDock();
      // A newer refreshHistory owns the overlay. Never lift it from here.
    }
    if (gen !== view._historyGen) return;
    view._lastHistoryEventId = lastHid || view._lastHistoryEventId;
    view._lastEventTs = null;
    // Pass 2 leaves activeTurn on the last thought/tool turn, which may
    // be an older finished turn. Pin it back to the newest user turn.
    view.activeTurn = (view.turns && view.turns.length)
      ? view.turns[view.turns.length - 1]
      : null;
    const connected = !!(view.currentAgent && view.currentAgent.status
      && view.currentAgent.status !== 'disconnected'
      && view.currentAgent.status !== 'exited'
      && view.currentAgent.status !== 'errored');
    // Missing prompt_complete is not enough: a reconnect after yesterday's
    // work must not keep the row on Running forever.
    const turnOpen = lastTurnIsOpen(events) && !!view.activeTurn;
    view._turnOpen = turnOpen;
    view._turnOpenHoldUntil = 0;
    if (turnOpen && connected && view.currentAgent) {
      view.currentAgent.status = 'running';
      try {
        document.dispatchEvent(new CustomEvent('grok-remote:agent-working', {
          detail: { id: view.agentId, working: true },
        }));
      } catch { /* ignore */ }
    } else {
      if (view.currentAgent && view.currentAgent.status === 'running') {
        view.currentAgent.status = 'idle';
      }
      try {
        document.dispatchEvent(new CustomEvent('grok-remote:agent-working', {
          detail: { id: view.agentId, working: false },
        }));
      } catch { /* ignore */ }
    }
    // Finalize Thought on every finished turn. Keep dots only on the
    // newest turn while it is still running and has no prompt_complete.
    for (const turn of view.turns) {
      const keepOpen = turn === view.activeTurn && turnOpen;
      if (!keepOpen) view._finalizeTurnThoughts(turn);
    }
    if (view.activeTurn && !turnOpen) {
      markInterruptedTurn(view, view.activeTurn);
      view.endTurn(null);
    }
    view._finalizePendingTools({ includeActive: !turnOpen });
    // Replay walks older turns after the latest. Restore occupancy from
    // the server snapshot, not a previous turn's peak.
    const snap = view.currentAgent && view.currentAgent.totalTokens;
    if (typeof snap === 'number' && snap >= 0) view.latestTotalTokens = snap;
    if (typeof view._renderTokensPill === 'function') view._renderTokensPill();
    if (typeof view._paintLiveStatus === 'function') view._paintLiveStatus();
    view._collapseHistoryTodos();
    view._repairDuplicateTail();
    void view._syncPendingCards();
    view._loadPromptHist();
    if (anchorText) {
      const hit = (view.turns || []).find((t: any) => String(t.userText || '') === anchorText);
      if (hit && hit.root && typeof hit.root.scrollIntoView === 'function') {
        view._autoScroll = false;
        if (view._jumpToLatestBtn) view._jumpToLatestBtn.hidden = false;
        hit.root.scrollIntoView({ block: 'center' });
        view._hideChatLoading();
        view._loadPinUntil = 0;
        return;
      }
    }
    if (view.streamEl) view.streamEl.classList.remove('chat-stream--prepend');
    view._autoScroll = true;
    if (typeof view._scrollStreamToEnd === 'function') view._scrollStreamToEnd();
    else if (view.streamEl) view.streamEl.scrollTop = view.streamEl.scrollHeight;
    await waitUntilLatestReady(view, gen);
    if (gen !== view._historyGen) return;
    view._hideChatLoading();
    view._loadPinUntil = 0;
    // Ring replay / catch-up must not ease-scroll the just-opened stream.
    view._quietScroll = true;
    const quietGen = gen;
    setTimeout(() => {
      if (view._historyGen === quietGen) view._quietScroll = false;
    }, 160);
  } catch (e) {
    if (gen === view._historyGen) view._hideChatLoading();
    throw e;
  }
}

export async function loadEarlierTurns(view: any) {
  if (!view.agentId || view._isReplaying) return;
  const have = paintedUserTurns(view);
  const total = view._historyTotalTurns || have;
  const want = nextEarlierTurnCount(have, total);
  if (want <= 0) {
    const stream = view.streamEl;
    const old = stream && stream.querySelector('.history-load-more');
    if (old) old.remove();
    return;
  }
  const hist: any = await api.history(view.agentId, { turns: want, skip: have });
  if (hist && hist.totalTurns) view._historyTotalTurns = hist.totalTurns;
  const rawEvents: any[] = (hist && Array.isArray(hist.events)) ? hist.events : [];
  const events: any[] = collapseHistoryForReplay(rawEvents, { dropTools: true });
  const stream = view.streamEl;
  const firstTurn = view.turns && view.turns[0];
  const pin = firstTurn && firstTurn.root;
  const existed = new Set(view.turns || []);
  view._historyInsertBefore = pin || null;
  view._isReplaying = true;
  holdScrollForPrepend(view);
  if (stream) stream.classList.add('chat-stream--hold-scroll');
  const pinTopBefore = (pin && typeof pin.getBoundingClientRect === 'function')
    ? pin.getBoundingClientRect().top
    : 0;
  try {
    for (const ev of events) {
      if (!isHistoryPass1(eventNameOf(ev))) continue;
      view._replayHistoryEvent(ev);
    }
    let turnIdx = -1;
    for (const ev of events) {
      const name = eventNameOf(ev);
      const kind = classifyHistoryPass2(name);
      if (kind === 'user') { turnIdx += 1; continue; }
      if (kind === 'skip') continue;
      if (name === 'tool_call' || name === 'tool_call_update') continue;
      if (turnIdx >= 0 && view.turns[turnIdx]) view.activeTurn = view.turns[turnIdx];
      view._replayHistoryEvent(ev);
    }
  } finally {
    view._isReplaying = false;
    view._historyInsertBefore = null;
    view.activeTurn = (view.turns && view.turns.length) ? view.turns[view.turns.length - 1] : null;
  }
  for (const turn of view.turns || []) {
    if (!existed.has(turn) && typeof view._finalizeTurnThoughts === 'function') {
      view._finalizeTurnThoughts(turn);
    }
  }
  const still = Math.max(0, (view._historyTotalTurns || 0) - paintedUserTurns(view));
  if (stream) {
    const oldBanner = stream.querySelector('.history-load-more');
    if (oldBanner) oldBanner.remove();
    if (still > 0) stream.insertBefore(view._buildLoadEarlierBanner(still), stream.firstChild);
    const pinTopAfter = (pin && pin.isConnected && typeof pin.getBoundingClientRect === 'function')
      ? pin.getBoundingClientRect().top
      : pinTopBefore;
    const next = restorePinScroll(stream, pinTopBefore, pinTopAfter);
    view._lastEasedWrite = next;
    view._programmaticScrollUntil = Date.now() + 250;
    view._autoScroll = false;
    view._userScrollIntent = true;
  }
  if (typeof view._syncTodoDock === 'function') view._syncTodoDock();
  if (stream && pin && pin.isConnected) {
    requestAnimationFrame(() => {
      if (!view.streamEl || view.streamEl !== stream || !pin.isConnected) return;
      const again = restorePinScroll(stream, pinTopBefore, pin.getBoundingClientRect().top);
      view._lastEasedWrite = again;
      stream.classList.remove('chat-stream--hold-scroll');
      view._quietScroll = false;
    });
  } else {
    if (stream) stream.classList.remove('chat-stream--hold-scroll');
    view._quietScroll = false;
  }
}

export function buildLoadEarlierBanner(view: any, missingCount: any) {
  const step = Math.min(LOAD_EARLIER_STEP, Math.max(1, Number(missingCount) || LOAD_EARLIER_STEP));
  const btn = el('button', {
    class: 'history-load-more-btn',
    type: 'button',
    onclick: async () => {
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = 'Loading…';
      try {
        await loadEarlierTurns(view);
      } catch (e: any) {
        btn.disabled = false;
        btn.textContent = orig;
        view.showToast(`Could not load earlier turns: ${e && e.message ? e.message : e}`, 'warn');
      }
    },
  }, `Load ${step} Earlier Turn${step === 1 ? '' : 's'} (${missingCount} more)`);
  return el('div', { class: 'history-load-more' }, btn);
}

function markInterruptedTurn(view: any, turn: any): void {
  const agent = view.currentAgent || {};
  const root = turn && turn.root;
  const hasAssistant = !!(turn && turn.assistant) || !!(root && root.querySelector && root.querySelector('.msg--assistant'));
  const hasTools = !!(turn && Array.isArray(turn.tools) && turn.tools.length)
    || !!(root && root.querySelector && root.querySelector('.tool-pill, .subagent-card, .todo-card'));
  if (!shouldMarkInterruptedTurn({
    userText: turn && turn.userText,
    hasAssistant,
    hasTools,
    turnOpen: false,
    status: agent.status,
  })) return;
  if (root && root.querySelector && root.querySelector('.turn-interrupted')) return;
  const card = el('div', { class: 'turn-interrupted' }, 'This turn was interrupted before Grok replied.');
  const host = (turn && (turn.result || turn.root)) || root;
  if (host && host.appendChild) host.appendChild(card);
}

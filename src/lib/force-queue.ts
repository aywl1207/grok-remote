// When to override a live turn and send the queued prompt now.

export const FORCE_ENTER_MS = 700;

export function hasPromptDraft(text: unknown, attachments?: unknown[] | null): boolean {
  if (String(text || '').trim()) return true;
  return Array.isArray(attachments) && attachments.length > 0;
}

/** Second Queue tap (empty draft, something queued) or double Enter. */
export function shouldForceQueueSend(opts: {
  working: boolean;
  force?: boolean;
  hasQueue: boolean;
  hasDraft: boolean;
  viaEnter?: boolean;
  lastEnterAt?: number;
  now?: number;
}): boolean {
  if (opts.force) return true;
  if (!opts.working) return false;
  if (opts.hasQueue && !opts.hasDraft) return true;
  if (opts.viaEnter) {
    const last = opts.lastEnterAt || 0;
    const now = opts.now || 0;
    if (last && now && now - last <= FORCE_ENTER_MS && (opts.hasQueue || opts.hasDraft)) {
      return true;
    }
  }
  return false;
}

/** Live work only. Do not trust leftover ACP status === "running". */
export function conversationIsWorking(opts: {
  forceSending?: boolean;
  turnOpen?: boolean;
  hasOpenTurn?: boolean;
  inFlight?: number;
  compacting?: boolean;
  status?: string | null;
  connected?: boolean | null;
}): boolean {
  const st = String(opts.status || '');
  if (st === 'disconnected' || st === 'exited' || st === 'errored') return false;
  if (opts.connected === false) return false;
  if (opts.forceSending) return true;
  if (opts.compacting) return true;
  if (opts.turnOpen) return true;
  // An open turn card without turnOpen is leftover UI, not live work.
  return typeof opts.inFlight === 'number' && opts.inFlight > 0;
}


/** Send Now sends the queued item. Draft is used only when nothing is queued. */
export function pickForceSendPayload(opts: {
  queue: { text?: string; attachments?: unknown[] } | null | undefined;
  draftText?: string;
  draftAttachments?: unknown[] | null;
}): { text: string; attachments: unknown[] } | null {
  const q = opts.queue;
  const queued = !!(q && (String(q.text || '').trim() || (Array.isArray(q.attachments) && q.attachments.length)));
  if (queued) {
    return { text: String(q!.text || ''), attachments: Array.isArray(q!.attachments) ? q!.attachments : [] };
  }
  const draft = String(opts.draftText || '').trim();
  const atts = Array.isArray(opts.draftAttachments) ? opts.draftAttachments : [];
  if (!hasPromptDraft(draft, atts)) return null;
  return { text: draft, attachments: atts };
}

/** Take the Send Now payload off the queue before cancel, so idle flush cannot send it again. */
export function consumeForcePayload(opts: {
  queue: { text?: string; attachments?: unknown[] } | null | undefined;
  draftText?: string;
  draftAttachments?: unknown[] | null;
}): {
  payload: { text: string; attachments: unknown[] } | null;
  clearQueue: boolean;
  clearDraft: boolean;
} {
  const payload = pickForceSendPayload(opts);
  if (!payload) return { payload: null, clearQueue: false, clearDraft: false };
  const q = opts.queue;
  const queued = !!(q && (String(q.text || '').trim() || (Array.isArray(q.attachments) && q.attachments.length)));
  return { payload, clearQueue: queued, clearDraft: !queued };
}

/** Cancel makes the chat look idle. Do not flush the queued item Send Now already owns. */
export function shouldFlushQueueOnIdle(opts: {
  forceSending?: boolean;
  flushing?: boolean;
  steering?: boolean;
}): boolean {
  return !opts.forceSending && !opts.flushing && !opts.steering;
}

/** Agent can take a prompt: connected, idle, not blocked. */
export function chatIsReadyToSend(opts: {
  agentId?: string | null;
  replaying?: boolean;
  forceSending?: boolean;
  flushing?: boolean;
  steering?: boolean;
  connected?: boolean | null;
  status?: string | null;
  working?: boolean;
  blocked?: boolean;
}): boolean {
  if (!opts.agentId) return false;
  if (opts.replaying || opts.forceSending || opts.flushing || opts.steering) return false;
  if (opts.working || opts.blocked) return false;
  const st = String(opts.status || '');
  if (st === 'starting') return false;
  // Disconnected/errored: send anyway so POST /prompt can reconnect.
  return true;
}

export function queueReason(opts: { working?: boolean }): 'working' | 'not-ready' {
  return opts.working ? 'working' : 'not-ready';
}


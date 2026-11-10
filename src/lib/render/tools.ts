// Tool / subagent / TodoWrite cards.

import { cliDiffRows, extraDiffCount, extractFileDiff } from '../tool-diff.js';
import { el } from './el.js';

interface StatusStyle { cls: string; label: string }

const PENDING_STYLE: StatusStyle = { cls: 'tool-status--pending', label: 'Pending' };
const STATUS_STYLES: Record<string, StatusStyle> = {
  Pending:   PENDING_STYLE,
  Running:   { cls: 'tool-status--running',   label: 'Running'   },
  Completed: { cls: 'tool-status--completed', label: 'Completed' },
  Failed:    { cls: 'tool-status--failed',    label: 'Failed'    },
  Canceled:  { cls: 'tool-status--canceled',  label: 'Canceled'  },
};

export function isShellKind(payload: { kind?: unknown; rawInput?: { command?: unknown; cmd?: unknown } | null } | null | undefined): boolean {
  const kind = String(payload && payload.kind || '').trim().toLowerCase();
  if (kind === 'bash' || kind === 'shell' || kind === 'execute' || kind === 'run_terminal_command' || kind === 'terminal') {
    return true;
  }
  const raw = payload && payload.rawInput;
  const cmd = raw && (raw.command || raw.cmd);
  return typeof cmd === 'string' && cmd.trim().length > 0;
}

export function shellStatusLabel(canonical: string): string | null {
  const st = String(canonical || '').trim().toLowerCase();
  if (!st || st === 'pending' || st === 'running' || st === 'in_progress' || st === 'inprogress') return 'Running …';
  if (st === 'completed' || st === 'success' || st === 'succeeded') return 'Ran …';
  return null;
}

export function terminalToolStatus(stopReason?: unknown): 'canceled' | 'completed' {
  return /cancel/i.test(String(stopReason || '')) ? 'canceled' : 'completed';
}

function normalizeStatus(s: unknown): string | null {
  if (!s) return null;
  const k = String(s).trim().toLowerCase();
  switch (k) {
    case 'pending':                  return 'Pending';
    case 'running':
    case 'in_progress':
    case 'inprogress':               return 'Running';
    case 'completed':
    case 'success':
    case 'succeeded':                return 'Completed';
    case 'failed':
    case 'error':
    case 'errored':                  return 'Failed';
    case 'canceled':
    case 'cancelled':                return 'Canceled';
    default:                         return null;
  }
}

interface ToolPayload {
  toolCallId?: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: Record<string, unknown> & { variant?: string; command?: string; cmd?: string; todos?: unknown[]; merge?: boolean };
  rawOutput?: unknown;
  content?: unknown;
  _meta?: { updateParams?: { status?: string } };
  [k: string]: unknown;
}

export function toolOutputText(payload: {
  content?: unknown;
  rawOutput?: unknown;
  error?: unknown;
  message?: unknown;
} | null | undefined): string {
  if (!payload) return '';
  const chunks: string[] = [];
  const push = (value: unknown) => {
    if (value == null || value === '') return;
    chunks.push(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  const content = payload.content;
  if (typeof content === 'string') push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      if (!c) continue;
      if (typeof c === 'string') push(c);
      else if (typeof c === 'object') {
        const co = c as { type?: string; text?: unknown; content?: unknown };
        if (co.type === 'diff') continue;
        if (typeof co.text === 'string') push(co.text);
        else if (co.text) push(String(co.text));
        else if (typeof co.content === 'string') push(co.content);
        else if (co.content) push(co.content);
        else push(c);
      }
    }
  }
  const raw = payload.rawOutput;
  if (typeof raw === 'string') push(raw);
  else if (raw && typeof raw === 'object' && Object.keys(raw as object).length) push(raw);
  if (payload.error != null) push(payload.error);
  if (typeof payload.message === 'string') push(payload.message);
  const uniq: string[] = [];
  for (const c of chunks) {
    if (!c.trim()) continue;
    const hit = uniq.findIndex((u) => u.includes(c) || c.includes(u));
    if (hit >= 0) {
      const prev = uniq[hit] || '';
      if (c.length > prev.length) uniq[hit] = c;
      continue;
    }
    uniq.push(c);
  }
  return uniq.join('\n');
}

function readStatus(payload: ToolPayload | null | undefined): string | null {
  if (!payload) return null;
  const meta = payload._meta && payload._meta.updateParams && payload._meta.updateParams.status;
  return normalizeStatus(meta) || normalizeStatus(payload.status) || null;
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

function inferToolTitle(update: ToolPayload): string {
  const title = update.title;
  const cmd = update.rawInput && (update.rawInput.command || update.rawInput.cmd);
  if (cmd) return String(cmd);
  if (title) return title;
  if (update.kind) return update.kind;
  return 'tool call';
}

function paintToolDiff(host: HTMLElement, pill: HTMLElement, payload: ToolPayload): void {
  const d = extractFileDiff(payload);
  if (!d || (!d.oldText && !d.newText)) return;
  const rows = cliDiffRows(d.oldText, d.newText);
  if (!rows.length) return;
  const extra = extraDiffCount(d.oldText, d.newText);
  host.hidden = false;
  pill.classList.add('tool-pill--diff');
  const kids: HTMLElement[] = rows.map((row) =>
    el('div', { class: `tool-diff__row tool-diff__row--${row.kind}` },
      el('span', { class: 'tool-diff__mark' }, row.kind === 'add' ? '++' : '--'),
      el('span', { class: 'tool-diff__code' }, row.text),
    ),
  );
  if (extra > 0) {
    kids.push(el('div', { class: 'tool-diff__more' }, `… ${extra} more lines`));
  }
  host.replaceChildren(...kids);
}

export function isTodoWriteToolCall(data: ToolPayload | null | undefined): boolean {
  return !!(data && data.rawInput && data.rawInput.variant === 'TodoWrite');
}

const SUBAGENT_ID_RE = /subagent_id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function isSubAgentCall(data: ToolPayload | null | undefined): boolean {
  if (!data) return false;
  const kind = String(data.kind || '');
  if (/^agent(?:\(.*\))?$/i.test(kind) || /^task$/i.test(kind)) return true;
  const title = String(data.title || '');
  if (/spawn_subagent/i.test(title) || /^subagent\b/i.test(title)) return true;
  const ri = data.rawInput;
  if (ri && typeof ri === 'object') {
    if (ri.variant === 'Task') return true;
    const t = (ri as { subagent_type?: unknown }).subagent_type;
    if (typeof t === 'string' && t) return true;
  }
  return false;
}

function rawInputOf(data: ToolPayload | null | undefined): Record<string, unknown> {
  const ri = data && data.rawInput;
  return ri && typeof ri === 'object' ? ri as Record<string, unknown> : {};
}

export function pickSubAgentLabel(data: ToolPayload): string {
  const ri = rawInputOf(data);
  if (typeof ri.description === 'string' && ri.description.trim()) return ri.description.trim();
  if (typeof data.title === 'string' && data.title.trim() && !/spawn_subagent/i.test(data.title)) {
    return data.title.trim();
  }
  if (typeof ri.prompt === 'string' && ri.prompt.trim()) {
    return ri.prompt.trim().split('\n')[0]!.slice(0, 80);
  }
  return 'Subagent';
}

export function pickSubAgentType(data: ToolPayload): string {
  const ri = rawInputOf(data);
  if (typeof ri.subagent_type === 'string' && ri.subagent_type.trim()) return ri.subagent_type.trim();
  const kind = String(data.kind || '');
  const wrapped = kind.match(/^agent\((.+)\)$/i);
  if (wrapped && wrapped[1]) return wrapped[1].trim();
  if (/^(task|agent)$/i.test(kind)) return 'general-purpose';
  if (kind && !/^tool$/i.test(kind)) return kind;
  if (ri.variant === 'Task') return 'general-purpose';
  return 'general-purpose';
}

export function humanizeSubAgentType(type: string): string {
  const raw = String(type || '').trim();
  if (!raw) return 'General Purpose';
  const slug = raw.replace(/_/g, '-').toLowerCase();
  const known: Record<string, string> = {
    'general-purpose': 'General Purpose',
    'explore': 'Explore',
    'plan': 'Plan',
    'task': 'General Purpose',
    'agent': 'General Purpose',
  };
  if (known[slug]) return known[slug];
  return raw.split(/[-_\s]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function subAgentTypeSlug(type: string): string {
  const s = String(type || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s || s === 'task' || s === 'agent') return 'general-purpose';
  return s;
}

export function formatSubAgentStatus(status: string): string {
  if (status === 'Canceled') return 'Cancelled';
  return status || 'Pending';
}

/**
 * spawn_subagent ACP status "completed" means the child was launched, not
 * that it finished. Keep Running until the child session actually ends.
 */
export function effectiveSubAgentStatus(opts: {
  toolStatus?: string | null;
  childFinished?: boolean;
  fromHistory?: boolean;
}): string {
  const st = String(opts.toolStatus || 'Pending');
  if (opts.fromHistory) {
    if (st === 'Failed' || st === 'Canceled') return st;
    if (st === 'Completed') return 'Completed';
    return st || 'Pending';
  }
  if (opts.childFinished) {
    if (st === 'Failed' || st === 'Canceled') return st;
    return st === 'Pending' || st === 'Running' || st === 'InProgress' ? 'Completed' : st;
  }
  if (st === 'Failed' || st === 'Canceled') return st;
  if (st === 'Completed') return 'Running';
  return st || 'Pending';
}

/** Spawn cards stay visually Running; they must not block parent prompt_complete. */
export function openCardBlocksParentTurn(opts: {
  isSubagent?: boolean;
  status?: string | null;
}): boolean {
  if (opts.isSubagent) return false;
  const st = String(opts.status || '').toLowerCase();
  return !st || st === 'pending' || st === 'running' || st === 'in_progress' || st === 'inprogress';
}

/** Child SSE that means this subagent's turn is over. */
export function childSessionEventFinishesSubagent(name: unknown, payload?: unknown): boolean {
  const n = String(name || '');
  if (n === 'prompt_complete' || n === 'prompt_result') return true;
  if (n === 'agent_status' || n === 'session_notification') {
    const rec = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const data = rec['data'] && typeof rec['data'] === 'object' ? rec['data'] as Record<string, unknown> : rec;
    const st = String(data['status'] || data['state'] || rec['status'] || '').toLowerCase();
    return st === 'disconnected' || st === 'exited' || st === 'errored';
  }
  return false;
}

export function pickCardIndexForChildSession(
  cards: Array<{ childId?: string | null; open?: boolean }>,
  sid: string,
): number {
  const want = String(sid || '').trim();
  if (!want) return -1;
  const exact = cards.findIndex((c) => String(c.childId || '').trim() === want);
  if (exact >= 0) return exact;
  const unmatched: number[] = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!;
    if (String(c.childId || '').trim()) continue;
    if (c.open === false) continue;
    unmatched.push(i);
  }
  return unmatched.length === 1 ? unmatched[0]! : -1;
}

export interface SubAgentMeta {
  typeName: string;
  typeSlug: string;
  typeLabel: string;
  label: string;
  background: boolean;
  isolation: string;
  capability: string;
}

export function readSubAgentMeta(data: ToolPayload | null | undefined): SubAgentMeta {
  if (!data) {
    return {
      typeName: 'general-purpose',
      typeSlug: 'general-purpose',
      typeLabel: 'General Purpose',
      label: 'Subagent',
      background: false,
      isolation: '',
      capability: '',
    };
  }
  const typeName = pickSubAgentType(data);
  const ri = rawInputOf(data);
  const iso = String(ri.isolation || '').toLowerCase();
  const capRaw = String(ri.capability_mode || ri.capabilityMode || '').toLowerCase().replace(/_/g, '-');
  const capMap: Record<string, string> = {
    'read-only': 'Read-Only',
    'readonly': 'Read-Only',
    'read-write': 'Read-Write',
    'readwrite': 'Read-Write',
    'execute': 'Execute',
  };
  return {
    typeName,
    typeSlug: subAgentTypeSlug(typeName),
    typeLabel: humanizeSubAgentType(typeName),
    label: pickSubAgentLabel(data),
    background: !!ri.background,
    isolation: iso === 'worktree' ? 'Worktree' : '',
    capability: capMap[capRaw] || '',
  };
}

function extractSubagentIdFromPayload(data: ToolPayload): string {
  const ri = data.rawInput as Record<string, unknown> | undefined;
  if (ri && typeof ri.subagent_id === 'string' && ri.subagent_id) return ri.subagent_id;
  const ro = data.rawOutput;
  if (ro && typeof ro === 'object') {
    const r = ro as { subagent_id?: unknown; text?: unknown };
    if (typeof r.subagent_id === 'string' && r.subagent_id) return r.subagent_id;
    if (typeof r.text === 'string') {
      const m = r.text.match(SUBAGENT_ID_RE);
      if (m && m[1]) return m[1];
    }
  }
  const blob = typeof data.content === 'string' ? data.content : JSON.stringify(data.content || '');
  const m = blob.match(SUBAGENT_ID_RE);
  return (m && m[1]) || '';
}

export function renderSubagentCard(initial: ToolPayload): ToolCard {
  const startedAt = Date.now();
  let endedAt: number | null = null;
  let childId = extractSubagentIdFromPayload(initial);
  let childFinished = !!initial.childFinished;
  let meta = readSubAgentMeta(initial);
  let toolStatus = readStatus(initial) || 'Pending';
  let status = effectiveSubAgentStatus({
    toolStatus,
    childFinished,
    fromHistory: !!initial.fromHistory,
  });

  const dots = el('span', { class: 'subagent-card__dots', 'aria-hidden': 'true' },
    el('span'), el('span'), el('span'));
  const typeEl = el('span', { class: 'subagent-card__type' }, meta.typeLabel);
  const labelEl = el('span', { class: 'subagent-card__label' }, meta.label);
  const flagsEl = el('span', { class: 'subagent-card__flags' });
  const statusEl = el('span', { class: 'subagent-card__status' }, formatSubAgentStatus(status));
  const durEl = el('span', { class: 'subagent-card__dur' }, '');
  const tailEl = el('span', { class: 'subagent-card__tail' }, statusEl, durEl);

  const node = el('div', {
    class: 'subagent-card',
    role: 'status',
    'aria-live': 'polite',
  }, dots, typeEl, labelEl, flagsEl, tailEl);
  node.dataset.toolId = initial.toolCallId || '';
  paint();

  let durTimer: ReturnType<typeof setInterval> | null = null;
  const terminal = (status === 'Completed' || status === 'Failed' || status === 'Canceled');
  if (terminal && childFinished) {
    endedAt = startedAt;
    paint();
  } else {
    durTimer = setInterval(() => {
      if (endedAt) { if (durTimer) clearInterval(durTimer); durTimer = null; return; }
      durEl.textContent = fmtDur(Date.now() - startedAt);
    }, 400);
  }

  function paintFlags() {
    const chips: HTMLElement[] = [];
    if (meta.background) chips.push(el('span', { class: 'subagent-card__flag' }, 'Background'));
    if (meta.isolation) chips.push(el('span', { class: 'subagent-card__flag' }, meta.isolation));
    if (meta.capability) chips.push(el('span', { class: 'subagent-card__flag' }, meta.capability));
    flagsEl.replaceChildren(...chips);
    flagsEl.hidden = chips.length === 0;
  }

  function paint() {
    node.classList.toggle('subagent-card--running', status === 'Pending' || status === 'Running');
    node.classList.toggle('subagent-card--done', status === 'Completed');
    node.classList.toggle('subagent-card--fail', status === 'Failed' || status === 'Canceled');
    node.dataset.type = meta.typeSlug;
    node.dataset.status = status.toLowerCase();
    typeEl.textContent = meta.typeLabel;
    labelEl.textContent = meta.label;
    statusEl.textContent = formatSubAgentStatus(status);
    paintFlags();
    const elapsedMs = (endedAt || Date.now()) - startedAt;
    const elapsed = endedAt && endedAt === startedAt ? '' : fmtDur(elapsedMs);
    durEl.textContent = elapsed;
    durEl.hidden = !elapsed;
    const bits = ['Subagent', meta.typeLabel, formatSubAgentStatus(status) + ':', meta.label];
    if (meta.background) bits.push('Background');
    if (meta.isolation) bits.push(meta.isolation);
    if (meta.capability) bits.push(meta.capability);
    if (elapsed) bits.push(elapsed);
    node.setAttribute('aria-label', bits.join(' '));
  }

  function applyUpdate(payload: ToolPayload): void {
    const canonical = readStatus(payload);
    if (payload.rawInput || (payload.title && !/spawn_subagent/i.test(String(payload.title)))) {
      const next = readSubAgentMeta(payload);
      if (next.label && next.label !== 'Subagent') meta = { ...meta, label: next.label };
      if (next.typeName) {
        meta = {
          ...meta,
          typeName: next.typeName,
          typeSlug: next.typeSlug,
          typeLabel: next.typeLabel,
        };
      }
      if (payload.rawInput) {
        meta = {
          ...meta,
          background: next.background,
          isolation: next.isolation,
          capability: next.capability,
        };
      }
    }
    const sid = extractSubagentIdFromPayload(payload);
    if (sid) childId = sid;
    if (canonical) toolStatus = canonical;
    if (payload && (payload as { childFinished?: unknown }).childFinished) childFinished = true;
    status = effectiveSubAgentStatus({ toolStatus, childFinished });
    if (status === 'Completed' || status === 'Failed' || status === 'Canceled') {
      endedAt = endedAt || Date.now();
      if (durTimer) { clearInterval(durTimer); durTimer = null; }
    } else if (!durTimer && !endedAt) {
      durTimer = setInterval(() => {
        if (endedAt) { if (durTimer) clearInterval(durTimer); durTimer = null; return; }
        durEl.textContent = fmtDur(Date.now() - startedAt);
      }, 400);
    }
    paint();
  }

  function markChildFinished(finalStatus?: string): void {
    childFinished = true;
    if (finalStatus) toolStatus = finalStatus;
    applyUpdate({});
  }

  function setChildId(id: string): void {
    const v = String(id || '').trim();
    if (v) childId = v;
  }

  return {
    node,
    applyUpdate,
    appendDelta: () => { /* parent only sees spawn lifecycle */ },
    getStatus: () => status,
    isSubagent: true,
    getChildId: () => childId,
    setChildId,
    markChildFinished,
    getLabel: () => meta.label,
    getType: () => meta.typeName,
    getElapsedMs: () => (endedAt || Date.now()) - startedAt,
    getBackground: () => meta.background,
    dispose: () => { if (durTimer) { clearInterval(durTimer); durTimer = null; } },
  } as ToolCard;
}

export interface ToolCard {
  node: HTMLElement;
  applyUpdate(payload: ToolPayload): void;
  appendDelta(payload: unknown): void;
  getStatus(): string;
  ingestExternal?: (payload: ToolPayload) => void;
  isTodo?: boolean;
  isSubagent?: boolean;
  getChildId?: () => string;
  setChildId?: (id: string) => void;
  markChildFinished?: (finalStatus?: string) => void;
  getLabel?: () => string;
  getType?: () => string;
  getElapsedMs?: () => number;
  getBackground?: () => boolean;
  getTodos?: () => Array<{ id: string; content: string; status: string }>;
  setCollapsed?: (collapsed: boolean) => void;
  dispose?: () => void;
}

export function renderToolCard(initial: ToolPayload): ToolCard {
  if (isTodoWriteToolCall(initial)) return renderTodoWriteCard(initial);
  if (isSubAgentCall(initial)) return renderSubagentCard(initial);
  let shell = isShellKind(initial || {});
  let canonicalStatus = readStatus(initial) || 'Pending';
  const startedAt = Date.now();
  let endedAt: number | null = null;

  function displayLabel(canon: string): string {
    if (shell) {
      const shellLabel = shellStatusLabel(canon);
      if (shellLabel) return shellLabel;
    }
    return (STATUS_STYLES[canon] || PENDING_STYLE).label;
  }

  const styleInfo = STATUS_STYLES[canonicalStatus] || PENDING_STYLE;
  const kindEl   = el('span', { class: 'tool-pill__kind' }, (initial && initial.kind) || 'tool');
  const titleEl  = el('span', { class: 'tool-pill__label' }, inferToolTitle(initial || {}));
  const durEl    = el('span', { class: 'tool-pill__dur' }, '');
  const statusEl = el('span', { class: `tool-pill__status ${styleInfo.cls}` }, displayLabel(canonicalStatus));
  const caretEl  = el('span', { class: 'tool-pill__caret' }, '▸');

  const rawInputBody = el('pre', { class: 'tool-pill-body__pre' });
  rawInputBody.textContent = initial && initial.rawInput ? JSON.stringify(initial.rawInput, null, 2) : '{}';
  const outputBody = el('pre', { class: 'tool-pill-body__pre' });

  const inputSection = el('div', { class: 'tool-pill-body__section' },
    el('div', { class: 'tool-pill-body__title' }, 'Input'),
    rawInputBody,
  );
  const outputSection = el('div', { class: 'tool-pill-body__section tool-pill-body__section--output' },
    el('div', { class: 'tool-pill-body__title' }, 'Output'),
    outputBody,
  );
  const body = el('div', { class: 'tool-pill__body', hidden: true }, inputSection, outputSection);
  const diffHost = el('div', { class: 'tool-diff', hidden: true });

  const head = el('button', {
    type: 'button',
    class: 'tool-pill__head',
    title: inferToolTitle(initial || {}),
    onclick: () => {
      body.hidden = !body.hidden;
      caretEl.textContent = body.hidden ? '▸' : '▾';
      node.classList.toggle('tool-pill--open', !body.hidden);
    },
  }, caretEl, kindEl, titleEl, durEl, statusEl);

  const node = el('div', { class: 'tool-pill', dataset: { toolId: (initial && initial.toolCallId) || '' } },
    head,
    diffHost,
    body,
  );
  paintToolDiff(diffHost, node, initial || {});

  let outputBuf = '';

  let durTimer: ReturnType<typeof setInterval> | null = null;
  const isTerminal = (canonicalStatus === 'Completed' || canonicalStatus === 'Failed' || canonicalStatus === 'Canceled');
  if (isTerminal) {
    endedAt = startedAt;
    durEl.textContent = '';
  } else {
    durTimer = setInterval(() => {
      if (endedAt) { if (durTimer) clearInterval(durTimer); durTimer = null; return; }
      durEl.textContent = fmtDur(Date.now() - startedAt) + '…';
    }, 500);
  }

  function revealFailure(): void {
    if (!body.hidden) return;
    body.hidden = false;
    caretEl.textContent = '▾';
    node.classList.toggle('tool-pill--open', true);
  }

  function setStatus(canonical: string): void {
    canonicalStatus = canonical;
    const info = STATUS_STYLES[canonical] || PENDING_STYLE;
    statusEl.className = `tool-pill__status ${info.cls}`;
    statusEl.textContent = displayLabel(canonical);
    if ((canonical === 'Completed' || canonical === 'Failed' || canonical === 'Canceled') && !endedAt) {
      endedAt = Date.now();
      if (durTimer) { clearInterval(durTimer); durTimer = null; }
      durEl.textContent = fmtDur(endedAt - startedAt);
    }
    if (canonical === 'Failed') revealFailure();
  }

  function applyUpdate(payload: ToolPayload): void {
    if (isShellKind(payload) || (payload && payload.kind && isShellKind({ kind: payload.kind }))) shell = true;
    const canonical = readStatus(payload);
    if (canonical) setStatus(canonical);
    if (payload.title || (payload.rawInput && payload.rawInput.command)) {
      titleEl.textContent = inferToolTitle(payload);
      head.title = inferToolTitle(payload);
    }
    if (payload.kind) kindEl.textContent = payload.kind;
    if (payload.rawInput) {
      rawInputBody.textContent = JSON.stringify(payload.rawInput, null, 2);
    }
    paintToolDiff(diffHost, node, payload);
    const joined = toolOutputText(payload);
    if (joined) {
      if (!outputBuf || joined.includes(outputBuf)) outputBuf = joined;
      else if (!outputBuf.includes(joined)) outputBuf = outputBuf + '\n' + joined;
      outputBody.textContent = outputBuf;
    }
  }

  function appendDelta(payload: unknown): void {
    let chunk = '';
    if (typeof payload === 'string') chunk = payload;
    else if (payload && typeof payload === 'object') {
      const p = payload as { text?: unknown; content?: unknown; delta?: unknown };
      if (typeof p.text === 'string') chunk = p.text;
      else if (p.content) {
        if (typeof p.content === 'string') chunk = p.content;
        else if (typeof (p.content as { text?: unknown }).text === 'string') chunk = (p.content as { text: string }).text;
      } else if (p.delta) {
        chunk = typeof p.delta === 'string' ? p.delta : JSON.stringify(p.delta);
      } else {
        chunk = JSON.stringify(payload);
      }
    } else {
      chunk = JSON.stringify(payload);
    }
    outputBuf += chunk;
    outputBody.textContent = outputBuf;
  }

  if (canonicalStatus === 'Failed') revealFailure();
  return { node, applyUpdate, appendDelta, getStatus: () => canonicalStatus };
}

interface TodoEntry { content: string; status: string }

export function renderTodoWriteCard(initial: ToolPayload): ToolCard {
  const startedAt = Date.now();
  let endedAt: number | null = null;
  void startedAt; void endedAt;
  const todos = new Map<string, TodoEntry>();

  const summaryEl = el('span', { class: 'todo-card__summary' }, '0/0');
  const titleEl   = el('span', { class: 'todo-card__title' }, 'Plan');
  const statusEl  = el('span', { class: 'todo-card__status' }, 'Running');
  void titleEl;
  const head      = el('button', {
    type: 'button',
    class: 'todo-card__head',
    title: 'Show or hide todos',
  },
    el('span', { class: 'todo-card__ico' }, '☑'),
    titleEl,
    summaryEl,
    el('span', { class: 'todo-card__spacer' }),
    statusEl,
  ) as HTMLButtonElement;
  const list = el('div', { class: 'todo-card__list', role: 'list' });
  const node = el('div', { class: 'tool-pill tool-pill--todo todo-card todo-card--collapsed' }, head, list);
  let collapsed = true;
  list.hidden = true;
  function setCollapsed(next: boolean): void {
    collapsed = !!next;
    list.hidden = collapsed;
    node.classList.toggle('todo-card--collapsed', collapsed);
  }
  head.onclick = () => setCollapsed(!collapsed);

  function statusGlyph(s: string | undefined): string {
    if (s === 'completed')   return '✓';
    if (s === 'in_progress') return '◐';
    if (s === 'cancelled' || s === 'canceled') return '×';
    return '○';
  }

  function ingest(payload: ToolPayload): void {
    const ri = payload && payload.rawInput;
    if (!ri || !Array.isArray(ri.todos)) return;
    const merge = !!ri.merge;
    if (!merge) todos.clear();
    for (const t of ri.todos as Array<{ id?: string | number; content?: unknown; status?: unknown } | null>) {
      if (!t || t.id == null) continue;
      const key = String(t.id);
      const cur = todos.get(key) || { content: '', status: 'pending' };
      if (t.content != null) cur.content = String(t.content);
      if (t.status  != null) cur.status  = String(t.status);
      todos.set(key, cur);
    }
  }

  function render(): void {
    let done = 0, inProgress = 0;
    list.replaceChildren();
    for (const [id, t] of todos) {
      if (t.status === 'completed') done++;
      else if (t.status === 'in_progress') inProgress++;
      const item = el('div', {
        class: `todo-item todo-item--${(t.status || 'pending').replace(/_/g, '-')}`,
        role: 'listitem',
        dataset: { id },
      },
        el('span', { class: 'todo-item__indicator' }, statusGlyph(t.status)),
        el('span', { class: 'todo-item__content' }, t.content || '(No description)'),
      );
      list.appendChild(item);
    }
    const total = todos.size;
    summaryEl.textContent = inProgress
      ? `${done}/${total} done · ${inProgress} in progress`
      : `${done}/${total} done`;
  }

  function applyStatus(payload: ToolPayload): void {
    const canonical = readStatus(payload);
    if (!canonical) return;
    if (canonical === 'Completed' || canonical === 'Failed' || canonical === 'Canceled') {
      if (!endedAt) endedAt = Date.now();
      statusEl.textContent = 'Done';
      statusEl.classList.remove('todo-card__status--running');
      statusEl.classList.add('todo-card__status--done');
    } else {
      statusEl.textContent = 'Running';
      statusEl.classList.add('todo-card__status--running');
      statusEl.classList.remove('todo-card__status--done');
    }
  }

  function applyUpdate(payload: ToolPayload): void {
    ingest(payload);
    applyStatus(payload);
    render();
  }

  ingest(initial);
  applyStatus(initial);
  render();

  return {
    node,
    applyUpdate,
    appendDelta: (): void => { /* TodoWrite uses rawInput, not delta chunks */ },
    getStatus: (): string => statusEl.textContent || '',
    ingestExternal: (payload: ToolPayload): void => { ingest(payload); applyStatus(payload); render(); },
    isTodo: true,
    setCollapsed,
    getTodos: () => Array.from(todos.entries()).map(([id, t]) => ({ id, content: t.content, status: t.status })),
  };
}

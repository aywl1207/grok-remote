// Registry of live AcpClient instances + per-agent SSE ring buffers and history.
// Hold lifecycle: agent-hold.ts. Status labels: agent-status.ts. Journal: history.ts.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { AcpClient, type AcpClientSettings } from './acp-client.js';
import { derivePublicStatus, clientIsLive, applyToolInFlight, isToolSessionUpdate } from './agent-status.js';
import { modelSettingsChanged } from './set-model.js';
import { wrapPromptWithIdentity } from './model-identity.js';
import { lastTurnIsOpenFromNdjson } from './turn-open.js';
import { readLastTotalTokens } from './token-occupancy.js';
import { resolveConversationWindow } from './context-window.js';
import { load as loadAppSettings } from './settings.js';
import {
  decideUiAutoCompact,
  uiAutoCompactEnabled,
  UI_AUTO_COMPACT_FAIL_COOLDOWN_MS,
  armedAfterCompactOutcome,
} from './ui-auto-compact.js';
import { compactRpcTries, compactUsageTries, occupancyFromUnknown, plausibleCompactAfter, compactInFlightAck, MAX_CONTEXT_OCCUPANCY, compactPromptText, isAcpMethodMissing, compactRpcShouldTryNext, compactDroppedEnough, tokensAfterFromCompactUpdate, COMPACT_RPC_TIMEOUT_MS } from './compact-status.js';
import { rewindRpcTries } from './rewind-rpc.js';
import { interjectRpcTries, interjectShouldTryNext, interjectUnsupportedMessage, withTimeout, INTERJECT_RPC_TIMEOUT_MS } from './interject-rpc.js';
import { isForeignSessionId, payloadSessionId } from './child-session.js';
import { eventIsReplay, shouldDropResumeRestream } from './attach-replay.js';
import { stopHold, holdRunning, shouldAttachOnBoot, listLiveHoldIds, holdArgsBindOldWindow, inspectHoldArgs } from './agent-hold.js';
import { ensureAgentDirs, agentDir, historyPath, append as historyAppend, truncateAfterUserTurns,
  readLastUserTurns,
} from './history.js';
import { ensureCwdDir } from './agent-cwd.js';
import { createRing, type SseRing, type SseRingEntry } from './sse.js';
import {
  listTuiSessions,
  listAllTuiSessions,
  findTuiSession,
  writeTuiSessionTitle,
  deleteTuiSessionDir,
  tuiSessionsRoot,
  planTuiSessionSync,
  planTuiDuplicateCleanup,
  importTuiChatHistory,
  isDisposableImportedChat,
  shouldKillTuiOrphan,
  isDuplicateNameShell,
  isIgnoredUiCwd,
  type TuiSession,
} from './tui-sessions.js';
import { syncAgentsToProjectFolders, pruneMissingAgentsFromFolders } from './folders.js';
import { projectGroupName } from './conversation-folder.js';

const SSE_RING_LIMIT = 200;
const AGENTS_ROOT = path.join(os.homedir(), '.grok-remote', 'agents');

function nowIso(): string { return new Date().toISOString(); }

export interface BgTask {
  id: string;
  tool_call_id: string | null;
  command: string;
  cwd: string;
  output_file: string;
  startedAt: number;
  completed: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | string | null;
  endedAt?: number;
  kind: 'grok-bg';
  cached_output?: string;
}

export interface AgentMeta {
  id: string;
  name: string;
  autoNamed: boolean;
  modelHint: string | null;
  cwd: string;
  createdAt: string;
  lastSeen: string;
  lastSessionId: string | null;
  lastError: string | null;
  starred: boolean;
  archived: boolean;
  archivedAt: string | null;
  settings: AcpClientSettings | null;
  totalTokens?: number;
  uiAutoCompactRetryAt?: number;
}

interface AgentRingEntry extends SseRingEntry {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

interface AgentRecord extends AgentMeta {
  client: AcpClient | null;
  ring: SseRing<AgentRingEntry>;
  status: string;
  eventCounter: number;
  bgTasks?: Map<string, BgTask>;
  totalTokens?: number;
  inFlight?: number;
  turnOpen?: boolean;
  /** True from wire until session_ready. Resume restream has no isReplay on tool_call. */
  _awaitingSessionReady?: boolean;
  _inFlightIds?: Set<string>;
  _lastTokenEmit?: number;
  _lastTokenMetaWrite?: number;
  _tokenEmitTimer?: ReturnType<typeof setTimeout> | null;
  _uiAutoCompactArmed?: boolean;
  _uiAutoCompactInFlight?: boolean;
  _uiAutoCompactRetryAt?: number;
  _compactRpcInFlight?: boolean;
  _compactRpcUnsupported?: boolean;
  _compactTokensAfter?: number;
}

export interface AgentSpawnOptions {
  name?: string;
  model?: string;
  cwd?: string;
  settings?: AcpClientSettings | null;
  resumeSessionId?: string | null;
  fork?: boolean;
}

export interface AgentPatch {
  name?: string;
  starred?: boolean;
  archived?: boolean;
  cwd?: string;
  settings?: AcpClientSettings | null;
}

export interface PublicAgent {
  id: string;
  name: string;
  model: string | null;
  liveModel: string | null;
  status: string;
  connected: boolean;
  cwd: string;
  createdAt: string;
  lastSeen: string;
  lastSessionId: string | null;
  handshakeMeta: unknown;
  agentCapabilities: unknown;
  sessionId: string | null;
  availableCommands: unknown[];
  lastError: string | null;
  exitInfo: unknown;
  starred: boolean;
  archived: boolean;
  archivedAt: string | null;
  settings: AcpClientSettings | null;
  totalTokens: number;
  contextWindow: number;
  compactAtPercent: number;
  compactAtKnown: boolean;
  contextWindows: number[];
  inFlight: number;
  turnOpen: boolean;
  runtimeApplied?: boolean;
  runtimeError?: string | null;
}

export interface PromptAttachment {
  name?: string;
  mimeType?: string;
  dataBase64?: string;
}

export interface PromptInput {
  text?: string;
  attachments?: PromptAttachment[];
  force?: boolean;
}

export interface SavedFile {
  rel: string;
  abs: string;
  mimeType: string | null;
  size: number;
}

export function countRunningBg(record: AgentRecord | null | undefined): number {
  if (!record || !record.bgTasks) return 0;
  let n = 0;
  for (const v of record.bgTasks.values()) if (!v.completed) n++;
  return n;
}

function hydrateBgTasksFromHistory(agentId: string): Map<string, BgTask> {
  const out = new Map<string, BgTask>();
  let raw: string;
  try { raw = fs.readFileSync(historyPath(agentId), 'utf8'); }
  catch { return out; }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.indexOf('task_backgrounded') === -1 &&
        trimmed.indexOf('task_completed')    === -1 &&
        trimmed.indexOf('TaskOutput')         === -1) continue;
    let ev: { at?: string; data?: { params?: { update?: Record<string, unknown> }; update?: Record<string, unknown> } };
    try { ev = JSON.parse(trimmed); } catch { continue; }
    const upd = ev?.data?.params?.update;
    if (upd && upd['sessionUpdate'] === 'task_backgrounded') {
      const tid = upd['task_id'] as string | undefined;
      if (!tid) continue;
      out.set(tid, {
        id: tid,
        tool_call_id: (upd['tool_call_id'] as string) || null,
        command: (upd['command'] as string) || '',
        cwd: (upd['cwd'] as string) || '',
        output_file: (upd['output_file'] as string) || '',
        startedAt: Date.parse(ev.at || '') || Date.now(),
        completed: false,
        exit_code: null,
        signal: null,
        kind: 'grok-bg',
      });
      continue;
    }
    if (upd && upd['sessionUpdate'] === 'task_completed') {
      const snap = (upd['task_snapshot'] as Record<string, unknown>) || {};
      const tid = snap['task_id'] as string | undefined;
      if (!tid || !out.has(tid)) continue;
      const entry = out.get(tid)!;
      entry.completed = true;
      entry.exit_code = snap['exit_code'] != null ? (snap['exit_code'] as number) : null;
      entry.signal    = (snap['signal'] as string) || null;
      entry.endedAt   = Date.parse(ev.at || '') || Date.now();
      continue;
    }
    const ud = ev?.data?.update;
    const ro = ud && (ud['rawOutput'] as Record<string, unknown>);
    if (ro && ro['type'] === 'TaskOutput' && ro['Result']) {
      const result = ro['Result'] as Record<string, unknown>;
      if (result['task_id']) {
        const tid = result['task_id'] as string;
        const entry = out.get(tid);
        if (entry && typeof result['output'] === 'string' && (result['output'] as string).length) {
          entry.cached_output = result['output'] as string;
        }
      }
    }
  }
  return out;
}

function metaPath(id: string): string {
  return path.join(agentDir(id), 'meta.json');
}

function readMetaFromDisk(id: string): Partial<AgentMeta> | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as Partial<AgentMeta>;
  } catch { return null; }
}

function writeMeta(record: AgentRecord): void {
  try {
    fs.mkdirSync(agentDir(record.id), { recursive: true });
    const out: AgentMeta = {
      id: record.id,
      name: record.name,
      autoNamed: !!record.autoNamed,
      modelHint: record.modelHint || null,
      cwd: record.cwd,
      createdAt: record.createdAt,
      lastSeen: record.lastSeen,
      lastSessionId: record.lastSessionId || null,
      lastError: record.lastError || null,
      starred: !!record.starred,
      archived: !!record.archived,
      archivedAt: record.archivedAt || null,
      settings: record.settings && typeof record.settings === 'object' ? record.settings : null,
      totalTokens: typeof record.totalTokens === 'number' && record.totalTokens > 0 && record.totalTokens <= MAX_CONTEXT_OCCUPANCY ? record.totalTokens : 0,
      uiAutoCompactRetryAt: typeof record._uiAutoCompactRetryAt === 'number' && record._uiAutoCompactRetryAt > Date.now()
        ? record._uiAutoCompactRetryAt
        : undefined,
    };
    fs.writeFileSync(metaPath(record.id), JSON.stringify(out, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[meta] write failed for ${record.id}: ${msg}\n`);
  }
}

function listPersistedAgentIds(): string[] {
  try {
    return fs.readdirSync(AGENTS_ROOT).filter((name) => {
      try {
        return fs.statSync(path.join(AGENTS_ROOT, name)).isDirectory()
            && fs.existsSync(path.join(AGENTS_ROOT, name, 'meta.json'));
      } catch { return false; }
    });
  } catch { return []; }
}

const MIME_EXT: Record<string, string> = {
  'image/png':  '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif':  '.gif',
  'image/svg+xml': '.svg',
};

export function sanitizeFilename(name: string | null | undefined): string {
  return String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 100);
}

export function uniqueUploadName(dir: string, requestedName: string | undefined, mimeType: string | undefined): string {
  let raw = sanitizeFilename(requestedName);
  if (!raw) {
    const ext = (mimeType && MIME_EXT[mimeType]) || '';
    raw = `image-${Date.now()}${ext}`;
  }
  let candidate = raw;
  const ext = path.extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i++}${ext}`;
  }
  return candidate;
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '? bytes';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentLine(f: SavedFile): string {
  const size = humanSize(f.size);
  return `- ${f.abs} (${f.mimeType || 'application/octet-stream'}, ${size})`;
}

function composePromptPayload(a: AgentRecord, text: string, attachments: PromptAttachment[]): {
  blocks: unknown[];
  finalText: string;
  savedFiles: SavedFile[];
  histData: Record<string, unknown>;
  supportsImage: boolean;
} {
  const savedFiles: SavedFile[] = [];
  if (attachments.length) {
    const uploadsDir = path.join(a.cwd, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    for (const att of attachments) {
      if (!att || typeof att.dataBase64 !== 'string' || !att.dataBase64) continue;
      const buf = Buffer.from(att.dataBase64, 'base64');
      const candidate = uniqueUploadName(uploadsDir, att.name, att.mimeType);
      const abs = path.join(uploadsDir, candidate);
      fs.writeFileSync(abs, buf);
      savedFiles.push({
        rel: path.posix.join('uploads', candidate),
        abs,
        mimeType: att.mimeType || null,
        size: buf.length,
      });
    }
  }

  const handshake = a.client?.handshake as { agentCapabilities?: { promptCapabilities?: { image?: boolean; embeddedContext?: boolean } } } | null;
  const supportsImage = !!handshake?.agentCapabilities?.promptCapabilities?.image;
  let finalText = text;
  if (savedFiles.length) {
    const lines = savedFiles.map((f) => attachmentLine(f));
    const refBlock = 'Attached files:\n' + lines.join('\n');
    finalText = text && text.length ? `${text}\n\n${refBlock}` : refBlock;
  }

  const embeddedContext = !!handshake?.agentCapabilities?.promptCapabilities?.embeddedContext;
  const blocks: unknown[] = [];
  if (finalText && finalText.length) blocks.push({ type: 'text', text: finalText });
  for (const f of savedFiles) {
    const mime = (f.mimeType || '').toLowerCase();
    if (!mime.startsWith('image/')) continue;
    try {
      const buf = fs.readFileSync(f.abs);
      blocks.push({
        type: 'image',
        mimeType: f.mimeType || 'image/png',
        data: buf.toString('base64'),
      });
    } catch { /* fall back to text+resource_link only */ }
  }
  if (embeddedContext) {
    for (const f of savedFiles) {
      blocks.push({
        type: 'resource_link',
        uri: 'file://' + f.abs,
        name: path.basename(f.abs),
        mimeType: f.mimeType || 'application/octet-stream',
        size: f.size,
      });
    }
  }
  if (!blocks.length) throw new Error('empty prompt');
  const histAttachments = savedFiles.map((f) => ({
    rel: f.rel, mimeType: f.mimeType, size: f.size,
  }));
  const histData: Record<string, unknown> = histAttachments.length
    ? { text: finalText, attachments: histAttachments }
    : { text: finalText };
  return { blocks, finalText, savedFiles, histData, supportsImage };
}

function journalUserMessage(self: AgentManager, id: string, a: AgentRecord, histData: Record<string, unknown>): void {
  historyAppend(id, { at: nowIso(), event: 'user_message', data: histData });
  a.ring.push({
    id: `${Date.now()}-user`,
    event: 'user_message',
    data: { ...histData, _t: Date.now() },
  });
  self.emit(`agent:${id}`, {
    id: `${Date.now()}-user`,
    event: 'user_message',
    data: { ...histData, _t: Date.now() },
  });
}

function inferTurnOpen(id: string): boolean {
  try {
    return lastTurnIsOpenFromNdjson(readLastUserTurns(id, 1));
  } catch {
    return false;
  }
}

function markTurnOpen(record: AgentRecord, open: boolean): void {
  if (record.turnOpen === open) return;
  record.turnOpen = open;
}

function publicStatus(a: AgentRecord): string {
  return derivePublicStatus({
    hasClient: !!a.client,
    clientStatus: a.client?.status || null,
    recordStatus: a.status,
    lastError: a.client?.lastError || a.lastError || null,
    inFlight: a.inFlight || 0,
    turnOpen: !!a.turnOpen,
  });
}

export class AgentManager extends EventEmitter {
  agents: Map<string, AgentRecord>;
  private _tuiSyncTimer: ReturnType<typeof setInterval> | null = null;
  private _tuiSyncSoon: ReturnType<typeof setTimeout> | null = null;
  private _tuiSyncBusy = false;
  private _writingTuiTitle = new Set<string>();

  constructor() {
    super();
    this.agents = new Map();
    this._hydrateFromDisk();
  }

  private _hydrateFromDisk(): void {
    for (const id of listPersistedAgentIds()) {
      const meta = readMetaFromDisk(id);
      if (!meta || !meta.id) continue;
      const ring = createRing<AgentRingEntry>(SSE_RING_LIMIT);
      const record: AgentRecord = {
        id: meta.id,
        name: meta.name || `agent-${meta.id.slice(0, 8)}`,
        autoNamed: !!meta.autoNamed,
        modelHint: meta.modelHint || null,
        cwd: meta.cwd || path.join(agentDir(meta.id), 'cwd'),
        createdAt: meta.createdAt || nowIso(),
        lastSeen: meta.lastSeen || nowIso(),
        lastSessionId: meta.lastSessionId || null,
        lastError: meta.lastError || null,
        starred: !!meta.starred,
        archived: !!meta.archived,
        archivedAt: meta.archivedAt || null,
        settings: meta.settings && typeof meta.settings === 'object' ? meta.settings : null,
        client: null,
        ring,
        status: 'disconnected',
        eventCounter: 0,
      };
      const persisted = typeof meta.totalTokens === 'number' && meta.totalTokens > 0 && meta.totalTokens <= MAX_CONTEXT_OCCUPANCY ? meta.totalTokens : 0;
      record.totalTokens = persisted || readLastTotalTokens(historyPath(record.id));
      record.bgTasks = hydrateBgTasksFromHistory(record.id);
      record.turnOpen = inferTurnOpen(record.id);
      if (typeof meta.uiAutoCompactRetryAt === 'number' && meta.uiAutoCompactRetryAt > Date.now()) {
        record._uiAutoCompactRetryAt = meta.uiAutoCompactRetryAt;
      }
      this.agents.set(record.id, record);
    }
  }

  private _clearTokenTimer(record: AgentRecord): void {
    if (record._tokenEmitTimer) {
      clearTimeout(record._tokenEmitTimer);
      record._tokenEmitTimer = null;
    }
  }

  /** Live compact completed with a lower occupancy. Replay must not clobber. */
  private _noteCompactTokens(record: AgentRecord, update: Record<string, unknown> | undefined): void {
    const after = tokensAfterFromCompactUpdate(update);
    if (typeof after !== 'number') return;
    record._compactTokensAfter = after;
    this._emitTokens(record, after, true);
  }

  /** Prefer a real drop observed during compact over the pre-compact total. */
  private async _resolveCompactAfter(
    record: AgentRecord,
    tokensBefore: number | undefined,
    waitMs = 0,
  ): Promise<number | undefined> {
    const pick = (): number | undefined => {
      const observed = record._compactTokensAfter;
      if (compactDroppedEnough({ tokensBefore, tokensAfter: observed })) return observed;
      const live = typeof record.totalTokens === 'number' ? record.totalTokens : undefined;
      if (compactDroppedEnough({ tokensBefore, tokensAfter: live })) return live;
      return undefined;
    };
    const found = pick();
    if (found != null || waitMs <= 0) return found;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const next = pick();
      if (next != null) return next;
    }
    return undefined;
  }

  /** Coalesce occupancy SSE, but always flush the last value. */
  private _emitTokens(record: AgentRecord, tt: number, force = false): void {
    if (!Number.isFinite(tt) || tt < 0 || tt > MAX_CONTEXT_OCCUPANCY) return;
    record.totalTokens = tt;
    const now = Date.now();
    const fire = (): void => {
      record._tokenEmitTimer = null;
      record._lastTokenEmit = Date.now();
      this.emit('list_changed', {
        event: 'agent_tokens',
        id: record.id,
        totalTokens: record.totalTokens || 0,
      });
      if (!record._lastTokenMetaWrite || (Date.now() - record._lastTokenMetaWrite) >= 5000 || force) {
        record._lastTokenMetaWrite = Date.now();
        writeMeta(record);
      }
      if (!record.turnOpen) void this._uiAutoCompact(record, { reason: 'occupancy' });
    };
    if (force || !record._lastTokenEmit || (now - record._lastTokenEmit) >= 500) {
      this._clearTokenTimer(record);
      fire();
      return;
    }
    if (!record._tokenEmitTimer) {
      const wait = Math.max(50, 500 - (now - record._lastTokenEmit));
      record._tokenEmitTimer = setTimeout(fire, wait);
    }
  }

  private _agentModelId(record: AgentRecord): string {
    const s = record.settings;
    const fromSettings = s && typeof s.model === 'string' ? s.model.trim() : '';
    return fromSettings || record.client?.modelId || record.modelHint || '';
  }

  private _conversationWindow(record: AgentRecord) {
    const app = loadAppSettings();
    return resolveConversationWindow({
      modelId: this._agentModelId(record),
      settings: record.settings,
      defaults: {
        contextWindow: app['defaultContextWindow'],
        compactAtPercent: app['defaultCompactAtPercent'],
      },
    });
  }

  /** Compact when occupancy hits this chat's window line (settings, then grok-remote defaults). */
  private async _uiAutoCompact(record: AgentRecord, opts?: { reason?: string; sendingPrompt?: boolean }): Promise<void> {
    if (!record || isIgnoredUiCwd(record.cwd)) return;
    if (!uiAutoCompactEnabled()) return;
    if (record._compactRpcUnsupported) return;
    const win = this._conversationWindow(record);
    if (!win.uiAutoCompact) return;
    const used = typeof record.totalTokens === 'number' ? record.totalTokens : 0;
    const decision = decideUiAutoCompact({
      used,
      window: win.window,
      compactAtPercent: win.compactAtPercent,
      armed: record._uiAutoCompactArmed !== false,
      inFlight: !!record._uiAutoCompactInFlight || !!record._compactRpcInFlight,
      turnOpen: !!record.turnOpen,
      toolsLive: (record.inFlight || 0) > 0,
      retryAt: record._uiAutoCompactRetryAt,
      sendingPrompt: !!(opts && opts.sendingPrompt),
    });
    record._uiAutoCompactArmed = decision.nextArmed;
    if (decision.action !== 'compact') return;
    record._uiAutoCompactInFlight = true;
    record._uiAutoCompactArmed = false;
    const reason = (opts && opts.reason) || 'ui-auto';
    process.stderr.write(
      `[ui-auto-compact] ${record.id} ${reason} used=${used} line=${decision.compactAtTokens} window=${win.window} pct=${win.compactAtPercent}\n`,
    );
    try {
      const out = await this.compact(record.id, { promptFallback: false });
      const usedAfter = typeof out.tokensAfter === 'number' ? out.tokensAfter : record.totalTokens;
      const dropped = compactDroppedEnough({
        tokensBefore: used,
        tokensAfter: typeof usedAfter === 'number' ? usedAfter : undefined,
      });
      const outcome = armedAfterCompactOutcome({
        rpc: out.rpc,
        usedAfter,
        compactAtTokens: decision.compactAtTokens,
        dropped,
      });
      record._uiAutoCompactArmed = outcome.armed;
      record._uiAutoCompactRetryAt = outcome.cooldown
        ? Date.now() + UI_AUTO_COMPACT_FAIL_COOLDOWN_MS
        : undefined;
      writeMeta(record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ui-auto-compact] ${record.id} failed: ${msg}\n`);
      if (record._compactRpcUnsupported) {
        record._uiAutoCompactArmed = false;
        record._uiAutoCompactRetryAt = undefined;
      } else {
        record._uiAutoCompactArmed = false;
        record._uiAutoCompactRetryAt = Date.now() + UI_AUTO_COMPACT_FAIL_COOLDOWN_MS;
      }
      writeMeta(record);
    } finally {
      record._uiAutoCompactInFlight = false;
    }
  }

  list(): PublicAgent[] {
    return [...this.agents.values()]
      .filter((a) => !isIgnoredUiCwd(a.cwd))
      .map((a) => this._publicRecord(a));
  }

  get(id: string): PublicAgent | null {
    const a = this.agents.get(id);
    return a ? this._publicRecord(a) : null;
  }

  getRaw(id: string): AgentRecord | null {
    return this.agents.get(id) || null;
  }

  private _publicRecord(a: AgentRecord): PublicAgent {
    const handshake = a.client?.handshake as { _meta?: unknown; agentCapabilities?: unknown } | null;
    const model = (a.settings && typeof a.settings.model === 'string' && a.settings.model)
        || a.client?.modelId || a.modelHint || null;
    const win = this._conversationWindow(a);
    return {
      id: a.id,
      name: a.name,
      model,
      liveModel: a.client?.modelId || null,
      status: publicStatus(a),
      connected: !!a.client && a.client.status !== 'exited' && a.client.status !== 'errored',
      cwd: a.cwd,
      createdAt: a.createdAt,
      lastSeen: a.lastSeen,
      lastSessionId: a.client?.sessionId || a.lastSessionId || null,
      handshakeMeta: handshake?._meta || null,
      agentCapabilities: handshake?.agentCapabilities || null,
      sessionId: a.client?.sessionId || a.lastSessionId || null,
      availableCommands: a.client?.availableCommands || [],
      lastError: a.client?.lastError || a.lastError || null,
      exitInfo: a.client?.exitInfo || null,
      starred:    !!a.starred,
      archived:   !!a.archived,
      archivedAt: a.archivedAt || null,
      settings:   a.settings && typeof a.settings === 'object' ? a.settings : null,
      totalTokens: typeof a.totalTokens === 'number' ? a.totalTokens : 0,
      contextWindow: win.window,
      compactAtPercent: win.compactAtPercent,
      compactAtKnown: win.compactAtKnown,
      contextWindows: win.windows || [],
      inFlight: typeof a.inFlight === 'number' ? a.inFlight : 0,
      turnOpen: !!a.turnOpen,
    };
  }

  async update(id: string, patch: AgentPatch): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
    let changed = false;
    let runtimeApplied = false;
    let runtimeError: string | null = null;
    if (typeof patch.name === 'string' && patch.name.trim()) {
      a.name = patch.name.trim().slice(0, 200);
      a.autoNamed = false;
      changed = true;
      this._pushNameToTui(a);
    }
    if (typeof patch.starred === 'boolean' && a.starred !== patch.starred) {
      a.starred = patch.starred;
      changed = true;
    }
    if (typeof patch.cwd === 'string' && patch.cwd.trim()) {
      const next = ensureCwdDir(patch.cwd);
      if (a.cwd !== next) {
        a.cwd = next;
        changed = true;
      }
    }
    if (typeof patch.archived === 'boolean' && a.archived !== patch.archived) {
      a.archived = patch.archived;
      a.archivedAt = patch.archived ? nowIso() : null;
      changed = true;
      if (patch.archived && a.client) {
        try { await a.client.shutdown({ destroyHold: false }); } catch { /* ignore */ }
        a.client = null;
        a.status = 'disconnected';
      }
    }
    if (patch.settings === null) {
      if (a.settings != null) {
        a.settings = null;
        changed = true;
      }
    } else if (patch.settings && typeof patch.settings === 'object') {
      const prevSettings = a.settings;
      const next: AcpClientSettings = { ...(a.settings || {}), ...patch.settings };
      for (const k of Object.keys(next)) {
        const v = next[k];
        if (v == null) { delete next[k]; continue; }
        if (typeof v === 'string' && v.length === 0) { delete next[k]; continue; }
        if (Array.isArray(v) && v.length === 0) { delete next[k]; continue; }
      }
      a.settings = Object.keys(next).length ? next : null;
      changed = true;
      if (a.client) {
        const auto = !(a.settings && a.settings.alwaysApprove === false);
        a.client.permissionHost.setAuto(auto);
      }
      const { modelChanged, effortChanged } = modelSettingsChanged(prevSettings, a.settings);
      const wantModel = (a.settings && typeof a.settings.model === 'string') ? a.settings.model.trim() : '';
      const liveModel = (a.client && a.client.modelId) ? a.client.modelId : '';
      const liveMismatch = !!(wantModel && wantModel !== liveModel);
      if ((modelChanged || effortChanged || liveMismatch) && a.client && clientIsLive(a.client) && a.client.sessionId) {
        runtimeApplied = await this._applyRuntimeModel(a);
        if (!runtimeApplied) runtimeError = 'session/set_model failed';
      }
    }
    if (changed) {
      writeMeta(a);
      const emitEvent = this._emitEventFactory(a);
      emitEvent('agent_updated', {
        id: a.id,
        name: a.name,
        starred: !!a.starred,
        archived: !!a.archived,
        cwd: a.cwd,
      });
      this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(a) });
      if (!a.turnOpen) void this._uiAutoCompact(a, { reason: 'settings' });
    }
    const out = this._publicRecord(a);
    if (runtimeApplied) out.runtimeApplied = true;
    if (runtimeError) out.runtimeError = runtimeError;
    return out;
  }

  private async _applyRuntimeModel(record: AgentRecord): Promise<boolean> {
    const client = record.client;
    if (!client || !client.sessionId) return false;
    const s = record.settings || {};
    const modelId = (typeof s.model === 'string' && s.model.trim())
      || client.modelId
      || record.modelHint
      || '';
    const effort = typeof s.reasoningEffort === 'string' ? s.reasoningEffort.trim() : '';
    if (!modelId) return false;
    try {
      await client.setModel({ modelId, reasoningEffort: effort || undefined });
      process.stderr.write(`[set-model] ${record.id} model=${modelId} effort=${effort || '-'} ok\n`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[set-model] ${record.id} failed: ${msg}\n`);
      return false;
    }
  }

  private _emitEventFactory(record: AgentRecord): (event: string, data: Record<string, unknown>) => void {
    return (event: string, data: Record<string, unknown>): void => {
      record.eventCounter = (record.eventCounter || 0) + 1;
      const eventId = `${Date.now()}-${record.eventCounter}`;
      const wrapped: AgentRingEntry = { id: eventId, event, data: { ...data, _t: Date.now(), _eventId: eventId } };
      record.lastSeen = nowIso();
      const child = isForeignSessionId(
        payloadSessionId(data),
        record.client?.sessionId,
        record.lastSessionId,
      );
      // Subagent chunks share this ACP socket. Do not SSE, journal, or
      // restream them as the parent You/Grok timeline.
      if (child) return;
      this.emit(`agent:${record.id}`, wrapped);
      record.ring.push(wrapped);
      const at = record.lastSeen;
      // Sync: setImmediate lost the last turn on docker restart / SIGTERM.
      historyAppend(record.id, { eventId, at, event, data });
    };
  }

  private _wireClient(record: AgentRecord): void {
    const id = record.id;
    const emitEvent = this._emitEventFactory(record);
    const client = record.client;
    if (!client) return;
    // Cleared on session_ready. Attach of an already-ready hold emits that
    // immediately, so live turns are not swallowed.
    record._awaitingSessionReady = true;

    client.on('status', (_s: Record<string, unknown>) => {
      const status = publicStatus(record);
      emitEvent('agent_status', { status, turnOpen: !!record.turnOpen, inFlight: record.inFlight || 0 });
      this.emit('list_changed', {
        event: 'agent_status',
        id: record.id,
        status,
        turnOpen: !!record.turnOpen,
        inFlight: record.inFlight || 0,
      });
    });
    client.on('model', (m: { modelId?: string; contextWindow?: number }) => {
      emitEvent('agent_updated', {
        id: record.id,
        liveModel: m && m.modelId,
        contextWindow: m && m.contextWindow,
      });
      this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(record) });
    });
    client.on('handshake', (h: { _meta?: unknown; agentCapabilities?: unknown }) => {
      emitEvent('handshake', { meta: h?._meta || null, agentCapabilities: h?.agentCapabilities || null });
    });
    client.on('session_ready', (s: { sessionId?: string; resumed?: boolean }) => {
      record._awaitingSessionReady = false;
      if (s && s.sessionId) {
        record.lastSessionId = s.sessionId;
        record.lastError = null;
        if (record.client) record.client.lastError = null;
        record.fork = false;
        record.resumeSessionId = null;
        const scanned = readLastTotalTokens(historyPath(record.id));
        if (scanned > 0) this._emitTokens(record, scanned, true);
        else if (!(typeof record.totalTokens === 'number' && record.totalTokens > 0)) {
          record.totalTokens = 0;
        }
        writeMeta(record);
        this._syncNameWithTui(record);
      }
      // Append session_ready first so inferTurnOpen sees this attach.
      // Otherwise lastWork from the previous turn keeps Running forever.
      emitEvent('session_ready', s as unknown as Record<string, unknown>);
      record.turnOpen = inferTurnOpen(record.id);
      if (record.turnOpen) {
        record.status = 'running';
        if (record.client && record.client.status !== 'running') {
          record.client.setStatus('running');
        }
      } else {
        record.status = 'idle';
        if (record._inFlightIds) record._inFlightIds.clear();
        if (record.inFlight) {
          record.inFlight = 0;
          this.emit('list_changed', { event: 'agent_inflight', id: record.id, inFlight: 0 });
        }
        if (record.client && record.client.status === 'running') {
          record.client.setStatus('idle');
        }
      }
      this.emit('list_changed', {
        event: 'agent_status',
        id: record.id,
        status: record.turnOpen ? 'running' : 'idle',
        turnOpen: !!record.turnOpen,
        inFlight: record.inFlight || 0,
      });
      this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(record) });
      if (!record.turnOpen) void this._uiAutoCompact(record, { reason: 'session-ready' });
    });
    client.on('update', (params: { update?: Record<string, unknown>; _meta?: Record<string, unknown>; sessionId?: string }) => {
      const u = params?.update || {};
      const event = (u['sessionUpdate'] as string) || 'update';
      const meta = params?._meta;
      const sid = typeof params?.sessionId === 'string' ? params.sessionId : '';
      const parentSid = record.client?.sessionId || record.lastSessionId || '';
      const childSession = !!(sid && parentSid && sid !== parentSid);
      const replay = eventIsReplay(params);
      if (shouldDropResumeRestream({ awaitingReady: !!record._awaitingSessionReady, isReplay: replay })) return;
      const tt = meta && ((meta['totalTokens'] as number) ?? (meta['total_tokens'] as number));
      // Current context occupancy, not lifetime max. Replay/child sessions
      // must not inflate the parent conversation counter.
      if (!childSession && !replay && typeof tt === 'number' && Number.isFinite(tt) && tt >= 0) {
        this._emitTokens(record, tt);
      }
      if (!childSession && !replay) this._noteCompactTokens(record, u);
      const sub = u['sessionUpdate'];
      // Leftover thought/message chunks after attach must not reopen an
      // idle hold. Live tool calls do: reconnect and nested /compact often
      // clear turnOpen while grok is still executing.
      const callId = (u['toolCallId'] as string) || (u['id'] as string);
      const toolTs = Number((meta && (meta['agentTimestampMs'] ?? meta['_t'])) || 0);
      const toolTsMs = toolTs > 1e12 ? toolTs : (toolTs > 1e9 ? toolTs * 1000 : 0);
      const toolStale = toolTsMs > 0 && (Date.now() - toolTsMs) > 5 * 60 * 1000;
      if (callId && !toolStale && !childSession && !replay) {
        if (!record._inFlightIds) record._inFlightIds = new Set();
        const updateParams = (meta as Record<string, unknown> | undefined)?.['updateParams'] as Record<string, unknown> | undefined;
        const metaStatus = updateParams && updateParams['status'];
        const rawStatus = (u['status'] as string) || (metaStatus as string) || '';
        applyToolInFlight(record._inFlightIds, {
          sessionUpdate: typeof sub === 'string' ? sub : '',
          status: rawStatus,
          callId,
        });
        const nextCount = record._inFlightIds.size;
        if (nextCount !== record.inFlight) {
          record.inFlight = nextCount;
          this.emit('list_changed', { event: 'agent_inflight', id: record.id, inFlight: nextCount });
        }
        if (isToolSessionUpdate(typeof sub === 'string' ? sub : '') && nextCount > 0 && !record.turnOpen) {
          markTurnOpen(record, true);
          if (record.client && record.client.status !== 'running') {
            record.client.setStatus('running');
          } else {
            this.emit('list_changed', {
              event: 'agent_status',
              id: record.id,
              status: 'running',
              turnOpen: true,
              inFlight: nextCount,
            });
          }
        }
      }
      try {
        const ro = u['rawOutput'] as Record<string, unknown> | undefined;
        if (ro && ro['type'] === 'TaskOutput' && ro['Result']) {
          const result = ro['Result'] as Record<string, unknown>;
          if (result['task_id']) {
            const tid = result['task_id'] as string;
            if (record.bgTasks && record.bgTasks.has(tid)) {
              const entry = record.bgTasks.get(tid)!;
              if (typeof result['output'] === 'string' && (result['output'] as string).length) {
                entry.cached_output = result['output'] as string;
              }
            }
          }
        }
      } catch { /* ignore */ }
      emitEvent(event, { update: u, _meta: params?._meta || null, sessionId: params?.sessionId });
      if (event === 'x.ai/sessions/changed') this._scheduleTuiSync();
    });
    client.on('x_notification', (msg: { method?: string; params?: { update?: Record<string, unknown> } }) => {
      const method = msg.method || 'x_notification';
      const upd = msg?.params?.update;
      const xSid = msg?.params && (msg.params as { sessionId?: string }).sessionId;
      const xParent = record.client?.sessionId || record.lastSessionId || '';
      const xChild = !!(xSid && xParent && xSid !== xParent);
      const xReplay = eventIsReplay(msg.params);
      if (shouldDropResumeRestream({ awaitingReady: !!record._awaitingSessionReady, isReplay: xReplay })) return;
      emitEvent(method.replace(/^_/, ''), { method, params: msg.params });
      if (!xChild && !xReplay) this._noteCompactTokens(record, upd);
      if (upd && upd['sessionUpdate'] === 'task_backgrounded') {
        if (!record.bgTasks) record.bgTasks = new Map();
        const tid = upd['task_id'] as string | undefined;
        if (tid) {
          record.bgTasks.set(tid, {
            id: tid,
            tool_call_id: (upd['tool_call_id'] as string) || null,
            command: (upd['command'] as string) || '',
            cwd: (upd['cwd'] as string) || record.cwd || '',
            output_file: (upd['output_file'] as string) || '',
            startedAt: Date.now(),
            completed: false,
            exit_code: null,
            signal: null,
            kind: 'grok-bg',
          });
          this.emit('list_changed', { event: 'bg_tasks', id: record.id, count: countRunningBg(record) });
        }
      } else if (upd && upd['sessionUpdate'] === 'task_completed') {
        const snap = (upd['task_snapshot'] as Record<string, unknown>) || {};
        const tid = snap['task_id'] as string | undefined;
        if (tid && record.bgTasks && record.bgTasks.has(tid)) {
          const entry = record.bgTasks.get(tid)!;
          entry.completed = true;
          entry.exit_code = snap['exit_code'] != null ? (snap['exit_code'] as number) : null;
          entry.signal    = (snap['signal'] as string) || null;
          entry.endedAt   = Date.now();
          this.emit('list_changed', { event: 'bg_tasks', id: record.id, count: countRunningBg(record) });
        }
      }

      if (upd && upd['sessionUpdate'] === 'session_summary_generated' && record.autoNamed) {
        const summary = String(upd['session_summary'] || '').trim();
        if (summary) {
          const prev = record.name;
          const next = summary.length > 60 ? summary.slice(0, 60).replace(/\s+\S*$/, '') + '...' : summary;
          if (next && next !== prev) {
            record.name = next;
            writeMeta(record);
            emitEvent('agent_renamed', { id, name: next, prevName: prev, source: 'auto', summary });
          }
        }
      }
    });
    client.on('prompt_complete', (params: Record<string, unknown>) => {
      const toolsLive = !!(record._inFlightIds && record._inFlightIds.size > 0);
      if (toolsLive) {
        // Grok sometimes emits prompt_complete while a tool is still pending.
        markTurnOpen(record, true);
        if (record.client && record.client.status !== 'running') {
          record.client.setStatus('running');
        }
        if (typeof record.totalTokens === 'number') this._emitTokens(record, record.totalTokens, true);
        return;
      }
      markTurnOpen(record, false);
      if (record._inFlightIds) record._inFlightIds.clear();
      if (record.inFlight) {
        record.inFlight = 0;
        this.emit('list_changed', { event: 'agent_inflight', id: record.id, inFlight: 0 });
      }
      if (record.client && record.client.status === 'running') {
        record.client.setStatus('idle');
      }
      if (typeof record.totalTokens === 'number') this._emitTokens(record, record.totalTokens, true);
      emitEvent('prompt_complete', params);
      void this._uiAutoCompact(record, { reason: 'after-turn' });
    });
    client.on('prompt_result',  (result: Record<string, unknown>) => emitEvent('prompt_result', result));
    client.on('error', (err: Error | { message?: string }) => {
      record._awaitingSessionReady = false;
      record.lastError = (err && (err as Error).message) || String(err);
      writeMeta(record);
      emitEvent('error', { message: record.lastError });
    });
    client.on('exit', (info: Record<string, unknown>) => {
      record._awaitingSessionReady = false;
      emitEvent('agent_exited', info);
      if (record.client === client) {
        record.client = null;
        record.status = 'disconnected';
        writeMeta(record);
        if (record._inFlightIds) record._inFlightIds.clear();
        if (record.inFlight) {
          record.inFlight = 0;
          this.emit('list_changed', { event: 'agent_inflight', id: record.id, inFlight: 0 });
        }
        emitEvent('agent_status', { status: 'disconnected', reason: 'process_exit' });
        this.emit('list_changed', { event: 'agent_status', id: record.id, status: 'disconnected', turnOpen: false, inFlight: 0 });
      }
    });
    client.on('stderr', (chunk: string) => emitEvent('stderr', { chunk }));
    client.on('permission_request', (req: Record<string, unknown>) => {
      emitEvent('permission_request', req);
    });
    client.on('interaction_request', (req: Record<string, unknown>) => {
      const kind = req && req.kind;
      if (kind === 'exit_plan_mode') emitEvent('plan_approval', req);
      else if (kind === 'ask_user_question') emitEvent('user_question', req);
      else emitEvent('interaction_request', req);
    });
  }

  async spawn({ name, model, cwd, settings, resumeSessionId, fork }: AgentSpawnOptions = {}): Promise<PublicAgent> {
    const id = randomUUID();
    ensureAgentDirs(id);
    const dir = agentDir(id);
    const workCwd = cwd ? ensureCwdDir(cwd) : path.join(dir, 'cwd');
    fs.mkdirSync(workCwd, { recursive: true });

    const ring = createRing<AgentRingEntry>(SSE_RING_LIMIT);
    const record: AgentRecord = {
      id,
      name: name || `agent-${id.slice(0, 8)}`,
      autoNamed: !name,
      modelHint: model || null,
      cwd: workCwd,
      createdAt: nowIso(),
      lastSeen: nowIso(),
      lastSessionId: null,
      lastError: null,
      starred: false,
      archived: false,
      archivedAt: null,
      settings: settings && typeof settings === 'object' ? settings : null,
      resumeSessionId: resumeSessionId || null,
      fork: !!fork,
      client: null,
      ring,
      status: 'starting',
      eventCounter: 0,
    };
    this.agents.set(id, record);
    writeMeta(record);

    historyAppend(id, { at: nowIso(), event: 'agent_created', data: { id, name: record.name, cwd: workCwd } });

    this._connectRecord(record);
    const pub = this._publicRecord(record);
    this.emit('list_changed', { event: 'agent_added', agent: pub });
    return pub;
  }

  private _connectRecord(record: AgentRecord): AcpClient {
    if (record.client) return record.client;
    record.status = 'starting';
    const client = new AcpClient({
      agentId: record.id,
      cwd: record.cwd,
      modelHint: record.modelHint,
      settings: record.settings || null,
      resumeSessionId: record.resumeSessionId || (record.fork ? record.lastSessionId : record.lastSessionId) || null,
      fork: !!record.fork,
    });
    record.client = client;
    this._wireClient(record);
    const emitEvent = this._emitEventFactory(record);
    emitEvent('agent_status', { status: 'starting' });
    const resumeId = record.resumeSessionId || record.lastSessionId || null;
    client.start({ resumeSessionId: record.fork ? null : resumeId }).catch((err: Error | { message?: string }) => {
      const msg = (err && (err as Error).message) || String(err);
      if (/agent exited/i.test(msg)) {
        record.status = 'disconnected';
        record.client = record.client === client ? null : record.client;
        emitEvent('agent_status', { status: 'disconnected', reason: 'process_exit' });
        return;
      }
      record.lastError = msg;
      writeMeta(record);
      emitEvent('error', { message: record.lastError });
    });
    return client;
  }

  async connect(id: string, opts?: { recreateHold?: boolean; freshSession?: boolean; forkSession?: boolean }): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    const recreate = !!(opts && opts.recreateHold);
    const fresh = !!(opts && opts.freshSession);
    const forkSession = !!(opts && opts.forkSession);
    if (recreate) {
      // User asked to apply new -m / --reasoning-effort. Attach-only
      // reconnect keeps the old grok argv, so the switch never takes.
      // Resume `-r` and `--fork-session` both restore the old session
      // context_window. config.toml only binds on a fresh session/new
      // (journal in grok-remote stays). Use freshSession for that.
      if (fresh) {
        a.lastSessionId = null;
        a.resumeSessionId = null;
        a.fork = false;
        writeMeta(a);
      } else if (a.client && a.client.sessionId) {
        a.lastSessionId = a.client.sessionId;
        if (forkSession) a.fork = true;
      } else if (forkSession && a.lastSessionId) {
        a.fork = true;
      }
      if (a.client) {
        try { await a.client.shutdown({ destroyHold: true }); } catch { try { stopHold(id); } catch { /* ignore */ } }
        a.client = null;
      } else {
        try { stopHold(id); } catch { /* ignore */ }
      }
      a.status = 'starting';
    } else if (clientIsLive(a.client)) {
      return this._publicRecord(a);
    } else if (a.client) {
      // Detach only. Killing the hold here is what turned a handshake error
      // into a dead grok session when the user clicked Connect.
      try { await a.client.shutdown({ destroyHold: false }); } catch { /* ignore */ }
      a.client = null;
    }
    this._connectRecord(a);
    try { await this._waitForSession(a, 15000); }
    catch { /* status already recorded on the client */ }
    if (recreate) {
      // Resume `-r` restores the session model and ignores `-m`.
      try { await this._applyRuntimeModel(a); } catch { /* logged */ }
    }
    return this._publicRecord(a);
  }

  reconnectStarred(): void {
    void this.reconnectHeld();
  }

  /**
   * Holds started with `-r` / `--fork-session` keep the old Grok
   * context_window. Recreate those with a fresh session so config.toml binds.
   * Skip holds that already have no resume flag (already on live config).
   */
  async rebindContextWindows(): Promise<{ id: string; name: string; action: string }[]> {
    const out: { id: string; name: string; action: string }[] = [];
    const rows = [...this.agents.values()];
    for (const rec of rows) {
      if (!holdRunning(rec.id)) {
        out.push({ id: rec.id, name: rec.name, action: 'skip-not-held' });
        continue;
      }
      const args = inspectHoldArgs(rec.id);
      if (!holdArgsBindOldWindow(args)) {
        out.push({ id: rec.id, name: rec.name, action: 'skip-already-fresh' });
        continue;
      }
      process.stderr.write(`[rebind-context] ${rec.id} ${rec.name} fresh session\n`);
      try {
        await this.connect(rec.id, { recreateHold: true, freshSession: true });
        out.push({ id: rec.id, name: rec.name, action: 'rebound' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[rebind-context] ${rec.id} failed: ${msg}\n`);
        out.push({ id: rec.id, name: rec.name, action: `error:${msg}` });
      }
    }
    return out;
  }

  /** Attach every live hold (and starred agents) before the UI comes up. */
  async reconnectHeld(): Promise<void> {
    for (const id of listLiveHoldIds()) {
      if (!this.agents.has(id)) {
        process.stderr.write(`[reconnect] live hold has no agent record ${id}\n`);
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      const jobs: Promise<unknown>[] = [];
      for (const rec of this.agents.values()) {
        const held = holdRunning(rec.id);
        if (!shouldAttachOnBoot(rec, held)) continue;
        if (clientIsLive(rec.client)) continue;
        process.stderr.write(`[reconnect] ${held ? 'hold' : 'starred'} ${rec.id} pass=${pass + 1}\n`);
        jobs.push(this.connect(rec.id).catch((err: Error | { message?: string }) => {
          const msg = (err && (err as Error).message) || String(err);
          process.stderr.write(`[reconnect] ${rec.id} failed: ${msg}\n`);
        }));
      }
      if (!jobs.length) return;
      await Promise.all(jobs);
      const still = [...this.agents.values()].some((rec) => {
        if (!holdRunning(rec.id)) return false;
        const st = rec.client && rec.client.status;
        return !rec.client || st === 'errored' || st === 'disconnected';
      });
      if (!still) {
        this._dumpPublicStatus();
        return;
      }
      await new Promise((r) => setTimeout(r, 400 * (pass + 1)));
    }
    this._dumpPublicStatus();
  }

  private _dumpPublicStatus(): void {
    try {
      const rows = [...this.agents.values()].map((r) => {
        const a = this._publicRecord(r);
        return { id: a.id, name: a.name, status: a.status, inFlight: a.inFlight, connected: a.connected };
      });
      const extra = [...this.agents.values()].map((r) => ({
        id: r.id,
        turnOpen: !!r.turnOpen,
        clientStatus: r.client?.status || null,
        inFlight: r.inFlight || 0,
      }));
      fs.writeFileSync(
        '/tmp/gr-agents-debug.json',
        JSON.stringify({ at: new Date().toISOString(), rows, extra }, null, 2),
      );
    } catch { /* ignore */ }
  }

  async disconnect(id: string): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (!a.client) return this._publicRecord(a);
    const client = a.client;
    a.client = null;
    a.status = 'disconnected';
    if (client.sessionId) a.lastSessionId = client.sessionId;
    writeMeta(a);
    try { await client.shutdown({ destroyHold: false }); } catch { /* ignore */ }
    const emitEvent = this._emitEventFactory(a);
    this._clearTokenTimer(a);
    if (a._inFlightIds) a._inFlightIds.clear();
    if (a.inFlight) {
      a.inFlight = 0;
      this.emit('list_changed', { event: 'agent_inflight', id: a.id, inFlight: 0 });
    }
    emitEvent('agent_status', { status: 'disconnected', reason: 'user_request' });
    this.emit('list_changed', { event: 'agent_status', id: a.id, status: 'disconnected', turnOpen: false, inFlight: 0 });
    return this._publicRecord(a);
  }

  async kill(id: string, opts?: { keepTuiSession?: boolean }): Promise<boolean> {
    const a = this.agents.get(id);
    if (!a) return false;
    const tuiSid = a.lastSessionId;
    if (a.client) {
      try { await a.client.shutdown({ destroyHold: true }); } catch { /* ignore */ }
    } else {
      try { stopHold(a.id); } catch { /* ignore */ }
    }
    this.agents.delete(id);
    this.emit('list_changed', { event: 'agent_removed', id });
    try {
      const dir = agentDir(id);
      if (dir.startsWith(AGENTS_ROOT + path.sep)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[kill] failed to remove ${id}: ${msg}\n`);
    }
    if (!opts?.keepTuiSession && tuiSid) {
      const sess = findTuiSession(tuiSid, { cwd: a.cwd });
      if (sess) deleteTuiSessionDir(sess.dir);
    }
    return true;
  }

  async prompt(id: string, textOrOpts: string | PromptInput): Promise<{ ok: true; debug: Record<string, unknown> }> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');

    if (!clientIsLive(a.client)) {
      if (a.client) {
        try { await a.client.shutdown({ destroyHold: false }); } catch { /* ignore */ }
        a.client = null;
      }
      this._connectRecord(a);
      await this._waitForSession(a, 15000);
    }
    if (!a.client) throw new Error('reconnect failed');

    let text: string;
    let attachments: PromptAttachment[];
    let force = false;
    if (textOrOpts && typeof textOrOpts === 'object' && !Array.isArray(textOrOpts)) {
      text = String(textOrOpts.text || '');
      attachments = Array.isArray(textOrOpts.attachments) ? textOrOpts.attachments : [];
      force = textOrOpts.force === true;
    } else {
      text = String(textOrOpts || '');
      attachments = [];
    }

    const { blocks, finalText, savedFiles, histData, supportsImage } = composePromptPayload(a, text, attachments);
    journalUserMessage(this, id, a, histData);
    if (force && (a.turnOpen || a.client.status === 'running')) {
      try { await a.client.cancel(); } catch { /* send the new prompt anyway */ }
      markTurnOpen(a, false);
    }
    // Never await compact here: x.ai/compact_conversation blocks ~90s and the
    // user already sees their bubble. Skip compact while a prompt is about to
    // be sent (turn will open); after-turn / session-ready cover occupancy.
    void this._uiAutoCompact(a, { reason: 'before-prompt', sendingPrompt: true });
    markTurnOpen(a, true);
    if (a.client.status !== 'running') a.client.setStatus('running');
    a.client.prompt(blocks).catch(() => { /* error already emitted */ });
    return {
      ok: true,
      debug: {
        sessionId: a.client?.sessionId || null,
        composedText: finalText,
        promptBlocks: blocks,
        savedFiles: savedFiles.map((f) => ({
          abs: f.abs, rel: f.rel, mimeType: f.mimeType, size: f.size,
        })),
        supportsImage,
      },
    };
  }


  async interject(id: string, textOrOpts: string | PromptInput): Promise<{
    ok: true;
    steered: true;
    rpc: string;
    debug: Record<string, unknown>;
  }> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (!clientIsLive(a.client)) {
      if (a.client) {
        try { await a.client.shutdown({ destroyHold: false }); } catch { /* ignore */ }
        a.client = null;
      }
      this._connectRecord(a);
      await this._waitForSession(a, 15000);
    }
    if (!a.client) throw new Error('reconnect failed');
    let text: string;
    let attachments: PromptAttachment[];
    if (textOrOpts && typeof textOrOpts === 'object' && !Array.isArray(textOrOpts)) {
      text = String(textOrOpts.text || '');
      attachments = Array.isArray(textOrOpts.attachments) ? textOrOpts.attachments : [];
    } else {
      text = String(textOrOpts || '');
      attachments = [];
    }
    const { blocks, finalText, savedFiles, histData, supportsImage } = composePromptPayload(a, text, attachments);
    const sid = a.client.sessionId || a.lastSessionId;
    if (!sid) throw new Error('session not ready');
    let rpc: string | null = null;
    let lastErr: unknown = null;
    for (const t of interjectRpcTries(sid, blocks, finalText)) {
      try {
        await withTimeout(a.client.request(t.method, t.params), INTERJECT_RPC_TIMEOUT_MS);
        rpc = t.method;
        break;
      } catch (err) {
        lastErr = err;
        if (interjectShouldTryNext(err)) continue;
        throw err;
      }
    }
    if (!rpc) {
      throw new Error(interjectUnsupportedMessage());
    }
    journalUserMessage(this, id, a, { ...histData, interject: true });
    return {
      ok: true,
      steered: true,
      rpc,
      debug: {
        sessionId: sid,
        composedText: finalText,
        promptBlocks: blocks,
        savedFiles: savedFiles.map((f) => ({
          abs: f.abs, rel: f.rel, mimeType: f.mimeType, size: f.size,
        })),
        supportsImage,
        lastError: lastErr instanceof Error ? lastErr.message : (lastErr ? String(lastErr) : null),
      },
    };
  }

  async rewind(id: string, keepTurns: number): Promise<{ ok: true; kept: number; dropped: number; rpc?: string | null }> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    const keep = Math.max(0, Math.floor(Number(keepTurns) || 0));
    let rpc: string | null = null;
    const sid = a.client?.sessionId || a.lastSessionId;
    if (a.client && sid) {
      for (const t of rewindRpcTries(sid, keep)) {
        try {
          await a.client.request(t.method, t.params);
          rpc = t.method;
          break;
        } catch { /* try next */ }
      }
    }
    const { kept, dropped } = truncateAfterUserTurns(id, keep);
    return { ok: true, kept, dropped, rpc };
  }

  async compact(id: string, opts?: { context?: string; promptFallback?: boolean }): Promise<{
    ok: true;
    rpc: string;
    tokensBefore?: number;
    tokensAfter?: number;
  }> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (a._compactRpcInFlight) return compactInFlightAck();
    if (!clientIsLive(a.client)) {
      if (a.client) {
        try { await a.client.shutdown({ destroyHold: false }); } catch { /* ignore */ }
        a.client = null;
      }
      this._connectRecord(a);
      try { await this._waitForSession(a, 15000); }
      catch { /* status already recorded */ }
    }
    const emitEvent = this._emitEventFactory(a);
    const sid = a.client?.sessionId || a.lastSessionId;
    if (!a.client || !sid) {
      emitEvent('auto_compact_failed', {
        update: { sessionUpdate: 'auto_compact_failed', reason: 'not connected' },
        _meta: { isReplay: false },
        sessionId: sid || '',
      });
      throw new Error('not connected');
    }
    if (a._compactRpcInFlight) return compactInFlightAck();
    a._compactRpcInFlight = true;
    const note = opts && opts.context ? String(opts.context) : '';
    const allowPrompt = opts?.promptFallback !== false;
    const tokensBefore = typeof a.totalTokens === 'number' && a.totalTokens > 0 ? a.totalTokens : undefined;
    a._compactTokensAfter = undefined;
    emitEvent('auto_compact_started', {
      update: {
        sessionUpdate: 'auto_compact_started',
        reason: note.trim() || 'user',
        tokens_used: tokensBefore,
      },
      _meta: { isReplay: false },
      sessionId: sid,
    });
    let lastErr: unknown = null;
    let missing = 0;
    const finishOk = (rpc: string, tokensAfter?: number) => {
      const dropped = compactDroppedEnough({ tokensBefore, tokensAfter });
      const after = dropped ? tokensAfter : undefined;
      if (typeof after === 'number') this._emitTokens(a, after, true);
      emitEvent('auto_compact_completed', {
        update: {
          sessionUpdate: 'auto_compact_completed',
          reason: note.trim() || 'user',
          tokens_before: tokensBefore,
          tokens_after: after,
          summary: 'Context compacted',
        },
        _meta: {
          isReplay: false,
          ...(typeof after === 'number' ? { totalTokens: after } : {}),
        },
        sessionId: sid,
      });
      return {
        ok: true as const,
        rpc,
        ...(tokensBefore != null ? { tokensBefore } : {}),
        ...(typeof after === 'number' ? { tokensAfter: after } : {}),
      };
    };
    try {
      if (!a._compactRpcUnsupported) {
        for (const t of compactRpcTries(sid, note)) {
          try {
            const result = await Promise.race([
              a.client.request(t.method, t.params),
              new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`${t.method} timeout`)), COMPACT_RPC_TIMEOUT_MS);
              }),
            ]);
            let tokensAfter = plausibleCompactAfter({
              tokensBefore,
              tokensAfter: occupancyFromUnknown(result, true),
            });
            if (!compactDroppedEnough({ tokensBefore, tokensAfter })) {
              for (const u of compactUsageTries(sid)) {
                try {
                  const usage = await a.client.request(u.method, u.params);
                  const n = plausibleCompactAfter({
                    tokensBefore,
                    tokensAfter: occupancyFromUnknown(usage, true),
                  });
                  if (compactDroppedEnough({ tokensBefore, tokensAfter: n })) {
                    tokensAfter = n;
                    break;
                  }
                } catch { /* try next usage method */ }
              }
            }
            if (!compactDroppedEnough({ tokensBefore, tokensAfter })) {
              // The RPC ack often has the pre-compact total. The real
              // tokens_after arrives on session/update while we wait.
              tokensAfter = await this._resolveCompactAfter(a, tokensBefore, 8000);
            }
            return finishOk(t.method, tokensAfter);
          } catch (err) {
            lastErr = err;
            const em = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[compact] ${id} ${t.method} failed: ${em}\n`);
            if (compactRpcShouldTryNext(err) || isAcpMethodMissing(err)) {
              missing += 1;
              continue;
            }
            break;
          }
        }
        if (missing > 0 && missing >= compactRpcTries(sid, note).length) {
          a._compactRpcUnsupported = true;
          process.stderr.write(`[compact] ${id} agent stdio has no compact RPC\n`);
        }
      }
      if (!allowPrompt) {
        const msg = a._compactRpcUnsupported
          ? 'compact RPC not supported by this agent'
          : (lastErr instanceof Error ? lastErr.message : String(lastErr || 'compact failed'));
        throw new Error(msg);
      }
      // User-initiated compact: /compact still works as a slash prompt on some builds.
      const cmd = compactPromptText(note);
      process.stderr.write(`[compact] ${id} falling back to prompt ${cmd}\n`);
      await a.client.prompt(cmd);
      try {
        await a.client.waitForIdleTurn(180_000);
      } catch (err) {
        process.stderr.write(`[compact] ${id} prompt wait: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      const tokensAfter = await this._resolveCompactAfter(a, tokensBefore, 8000);
      if (!compactDroppedEnough({ tokensBefore, tokensAfter })) {
        throw new Error('compact prompt finished but occupancy did not drop');
      }
      return finishOk('session/prompt', tokensAfter);
    } catch (err) {
      lastErr = err;
      const em = err instanceof Error ? err.message : String(err);
      if (/prompt fallback failed|turn did not finish/i.test(em)) {
        process.stderr.write(`[compact] ${id} prompt fallback failed: ${em}\n`);
      }
    } finally {
      a._compactRpcInFlight = false;
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr || 'compact failed');
    emitEvent('auto_compact_failed', {
      update: {
        sessionUpdate: 'auto_compact_failed',
        reason: msg,
      },
      _meta: { isReplay: false },
      sessionId: sid,
    });
    throw new Error(msg);
  }

  async fork(id: string, opts?: { name?: string; directive?: string }): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    const sourceSid = a.client?.sessionId || a.lastSessionId;
    if (!sourceSid) throw new Error('source conversation has no session yet');
    const child = await this.spawn({
      name: (opts && opts.name) || `${a.name} (fork)`,
      cwd: a.cwd,
      settings: a.settings,
      resumeSessionId: sourceSid,
      fork: true,
    });
    // Copy UI history so the fork paints the same turns.
    try {
      const src = historyPath(id);
      const dst = historyPath(child.id);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    } catch { /* ignore */ }
    return child;
  }

  respondPermission(id: string, requestId: string, optionId: string): boolean {
    const a = this.agents.get(id);
    if (!a || !a.client) return false;
    return a.client.permissionHost.respond(requestId, optionId);
  }

  respondInteraction(id: string, requestId: string, result: unknown): boolean {
    const a = this.agents.get(id);
    if (!a || !a.client) return false;
    return a.client.interactionHost.respond(requestId, result);
  }

  pendingRequests(id: string): Array<Record<string, unknown>> {
    const a = this.agents.get(id);
    if (!a || !a.client) return [];
    const items: Array<Record<string, unknown>> = [];
    try {
      for (const req of a.client.interactionHost.pending()) {
        items.push({ ...req });
      }
    } catch { /* ignore */ }
    try {
      for (const req of a.client.permissionHost.pending()) {
        items.push({ kind: 'permission', ...req });
      }
    } catch { /* ignore */ }
    return items;
  }

  setPermissionAuto(id: string, auto: boolean): void {
    const a = this.agents.get(id);
    if (!a || !a.client) return;
    a.client.permissionHost.setAuto(auto);
  }

  async cancel(id: string): Promise<boolean> {
    const a = this.agents.get(id);
    if (!a) return false;
    const emitEvent = this._emitEventFactory(a);
    markTurnOpen(a, false);
    if (a._inFlightIds) a._inFlightIds.clear();
    if (a.inFlight) {
      a.inFlight = 0;
      this.emit('list_changed', { event: 'agent_inflight', id: a.id, inFlight: 0 });
    }
    if (a.client && (a.client.status === 'running' || a.client.status === 'starting')) {
      a.client.setStatus('idle');
    } else {
      a.status = 'idle';
    }
    emitEvent('prompt_complete', { stopReason: 'cancelled' });
    this.emit('list_changed', {
      event: 'agent_status',
      id: a.id,
      status: publicStatus(a),
      turnOpen: false,
      inFlight: 0,
    });
    if (a.client) {
      try { await a.client.cancel(); } catch { /* local abort already applied */ }
    }
    return true;
  }

  private async _waitForSession(record: AgentRecord, timeoutMs: number): Promise<void> {
    if (record.client && record.client.sessionId) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (record.client && record.client.sessionId) return;
      if (record.client && record.client.status === 'errored') {
        throw new Error(record.client.lastError || 'agent errored during reconnect');
      }
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    throw new Error('timed out waiting for session');
  }

  ring(id: string): SseRing<AgentRingEntry> | null {
    const a = this.agents.get(id);
    return a ? a.ring : null;
  }

  subscribe(id: string, listener: (event: AgentRingEntry) => void): () => void {
    this.on(`agent:${id}`, listener);
    return () => this.off(`agent:${id}`, listener);
  }

  startTuiSessionSync(): void {
    if (this._tuiSyncTimer) return;
    void this.syncTuiSessions();
    this._tuiSyncTimer = setInterval(() => { void this.syncTuiSessions(); }, 4000);
  }

  stopTuiSessionSync(): void {
    if (this._tuiSyncTimer) { clearInterval(this._tuiSyncTimer); this._tuiSyncTimer = null; }
    if (this._tuiSyncSoon) { clearTimeout(this._tuiSyncSoon); this._tuiSyncSoon = null; }
  }

  private _scheduleTuiSync(): void {
    if (this._tuiSyncSoon) return;
    this._tuiSyncSoon = setTimeout(() => {
      this._tuiSyncSoon = null;
      void this.syncTuiSessions();
    }, 250);
  }

  private _pushNameToTui(a: AgentRecord): void {
    const sid = a.lastSessionId;
    if (!sid) return;
    const sess = findTuiSession(sid, { cwd: a.cwd });
    if (!sess || sess.title === a.name) return;
    this._writingTuiTitle.add(sess.dir);
    writeTuiSessionTitle(sess.dir, a.name, { manual: true });
    setTimeout(() => this._writingTuiTitle.delete(sess.dir), 1500);
  }

  private _syncNameWithTui(a: AgentRecord): void {
    const sid = a.lastSessionId;
    if (!sid) return;
    const sess = findTuiSession(sid, { cwd: a.cwd });
    if (!sess) return;
    if (sess.title && sess.title !== a.name && (a.autoNamed || sess.titleIsManual)) {
      a.name = sess.title;
      if (sess.titleIsManual) a.autoNamed = false;
      writeMeta(a);
      this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(a) });
      return;
    }
    if (!a.autoNamed && a.name) this._pushNameToTui(a);
  }

  private _adoptTuiSession(sess: TuiSession): void {
    const id = randomUUID();
    ensureAgentDirs(id);
    let workCwd = path.join(agentDir(id), 'cwd');
    try { if (sess.cwd) workCwd = ensureCwdDir(sess.cwd); } catch { /* use agent cwd */ }
    try { fs.mkdirSync(workCwd, { recursive: true }); } catch { /* ignore */ }
    const record: AgentRecord = {
      id,
      name: sess.title || `session-${sess.id.slice(0, 8)}`,
      autoNamed: !sess.title,
      modelHint: null,
      cwd: workCwd,
      createdAt: sess.createdAt || nowIso(),
      lastSeen: sess.updatedAt || nowIso(),
      lastSessionId: sess.id,
      lastError: null,
      starred: false,
      archived: false,
      archivedAt: null,
      settings: null,
      client: null,
      ring: createRing<AgentRingEntry>(SSE_RING_LIMIT),
      status: 'disconnected',
      eventCounter: 0,
    };
    this.agents.set(id, record);
    writeMeta(record);
    this.emit('list_changed', { event: 'agent_added', agent: this._publicRecord(record) });
  }

  async syncTuiSessions(): Promise<void> {
    if (this._tuiSyncBusy) return;
    let sessions: TuiSession[];
    try {
      const root = tuiSessionsRoot();
      if (!fs.existsSync(root)) return;
      sessions = listAllTuiSessions();
    } catch {
      return;
    }
    this._tuiSyncBusy = true;
    try {
      const agents = [...this.agents.values()].map((a) => ({
        id: a.id,
        name: a.name,
        lastSessionId: a.lastSessionId,
        autoNamed: !!a.autoNamed,
        cwd: a.cwd,
      }));
      const preferred = new Map<string, string>();
      for (const a of agents) {
        if (a.lastSessionId && a.cwd) preferred.set(a.lastSessionId, a.cwd);
      }
      for (const { keep, drop } of planTuiDuplicateCleanup(sessions, preferred)) {
        for (const extra of drop) {
          importTuiChatHistory(extra.dir, keep.dir);
          deleteTuiSessionDir(extra.dir);
        }
      }
      sessions = listTuiSessions();
      const plan = planTuiSessionSync(agents, sessions);
      const held = new Set(listLiveHoldIds());
      plan.adopt = plan.adopt.filter((sess) => !isDisposableImportedChat({
        name: sess.title || `session-${sess.id.slice(0, 8)}`,
        grokRemoteHistoryBytes: 0,
        tuiChatMessages: sess.chatMessages,
      }));
      const histById = new Map<string, number>();
      for (const rec of this.agents.values()) {
        let hist = 0;
        try { hist = fs.statSync(historyPath(rec.id)).size; } catch { hist = 0; }
        histById.set(rec.id, hist);
      }
      const peers = [...this.agents.values()].map((a) => ({
        id: a.id,
        name: a.name,
        grokRemoteHistoryBytes: histById.get(a.id) || 0,
      }));
      for (const rec of [...this.agents.values()]) {
        if (rec.starred || rec.archived || held.has(rec.id)) continue;
        const hist = histById.get(rec.id) || 0;
        if (!isDuplicateNameShell({
          id: rec.id,
          name: rec.name,
          grokRemoteHistoryBytes: hist,
          peers,
        })) continue;
        // Never delete TUI history for a same-title leftover. The live
        // conversation already has the title; this is only the sidebar shell.
        await this.kill(rec.id, { keepTuiSession: true });
      }
      for (const r of plan.rename) {
        const rec = this.agents.get(r.agentId);
        if (!rec || rec.name === r.name) continue;
        const sess = rec.lastSessionId ? findTuiSession(rec.lastSessionId, { cwd: rec.cwd }) : null;
        if (sess && this._writingTuiTitle.has(sess.dir)) continue;
        rec.name = r.name;
        writeMeta(rec);
        this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(rec) });
      }
      for (const sess of plan.adopt) this._adoptTuiSession(sess);
      for (const id of plan.removeAgentIds) {
        const rec = this.agents.get(id);
        if (!rec) continue;
        if (!shouldKillTuiOrphan({
          starred: rec.starred,
          archived: rec.archived,
          holdRunning: held.has(id),
          grokRemoteHistoryBytes: histById.get(id) || 0,
          ignoredCwd: isIgnoredUiCwd(rec.cwd),
        })) continue;
        await this.kill(id, { keepTuiSession: true });
      }
      for (const rec of [...this.agents.values()]) {
        if (rec.starred || rec.archived || held.has(rec.id)) continue;
        if (!isIgnoredUiCwd(rec.cwd)) continue;
        await this.kill(rec.id, { keepTuiSession: true });
      }
      for (const rec of [...this.agents.values()]) {
        if (!rec.lastSessionId) continue;
        const sess = findTuiSession(rec.lastSessionId, { cwd: rec.cwd });
        let hist = 0;
        try { hist = fs.statSync(historyPath(rec.id)).size; } catch { hist = 0; }
        if (!isDisposableImportedChat({
          name: rec.name,
          starred: rec.starred,
          archived: rec.archived,
          holdRunning: held.has(rec.id),
          grokRemoteHistoryBytes: hist,
          tuiChatMessages: sess ? sess.chatMessages : null,
        })) continue;
        await this.kill(rec.id);
      }
      const ghosts = pruneMissingAgentsFromFolders(this.agents.keys());
      const grouped = syncAgentsToProjectFolders(
        [...this.agents.values()]
          .filter((a) => !isIgnoredUiCwd(a.cwd))
          .map((a) => ({ id: a.id, cwd: a.cwd, archived: !!a.archived })),
        (cwd) => projectGroupName(cwd),
      );
      for (const rec of this.agents.values()) {
        if (!rec.autoNamed && rec.lastSessionId) this._pushNameToTui(rec);
      }
      if (grouped || ghosts) this.emit('list_changed', { event: 'folders_changed' });
    } finally {
      this._tuiSyncBusy = false;
    }
  }

  async shutdownAll(): Promise<void> {
    this.stopTuiSessionSync();
    // Detach only — leave hold containers / grok processes running.
    await Promise.all([...this.agents.values()].map(async (a) => {
      if (!a.client) return;
      if (a.client.sessionId) a.lastSessionId = a.client.sessionId;
      writeMeta(a);
      try { await a.client.shutdown({ destroyHold: false }); } catch { /* ignore */ }
      a.client = null;
      a.status = 'disconnected';
    }));
  }
}

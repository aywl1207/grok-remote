// One ACP client per grok agent stdio process.
//
// Responsibilities:
//   - Spawn `grok agent --no-leader --always-approve stdio`.
//   - Drive the handshake (initialize + session/new).
//   - Read stdout line by line as JSON-RPC frames.
//   - Resolve responses to our outgoing requests.
//   - Dispatch agent->client requests to the host modules.
//   - Emit high-level events.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Socket } from 'node:net';

import {
  holdEnabled,
  ensureHold,
  stopHold,
  holdRunning,
  readHoldReady,
  markHoldReady,
  holdNeedsHandshake,
} from './agent-hold.js';
import { isLiveWorkUpdate } from './agent-status.js';
import { buildSetModelParams } from './set-model.js';
import { mergeArgvRules } from './model-identity.js';
import { resolveGrokBin } from './grok-bin.js';

/** Prefer the hold socket; in-process stdin is only used when not attached. */
export function acpCanSend(
  sock: { destroyed: boolean } | null,
  proc: { stdin?: { writable?: boolean } | null } | null,
): boolean {
  if (sock && !sock.destroyed) return true;
  return !!(proc && proc.stdin && proc.stdin.writable);
}

import { createTerminalHost, type TerminalHost } from './terminal-host.js';
import { createFsHost, type FsHost } from './fs-host.js';
import { createPermissionHost, type PermissionHost } from './permission-host.js';
import { createInteractionHost, type InteractionHost } from './interaction-host.js';

export interface AcpClientSettings {
  model?: string;
  reasoningEffort?: string;
  systemPromptOverride?: string;
  rules?: string;
  tools?: string;
  disallowedTools?: string;
  allow?: string[];
  deny?: string[];
  worktree?: boolean | string;
  sandbox?: string;
  alwaysApprove?: boolean;
  permissionMode?: string;
  autoMode?: boolean;
  [key: string]: unknown;
}

export interface AcpClientInit {
  agentId?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  modelHint?: string | null;
  settings?: AcpClientSettings | null;
  resumeSessionId?: string | null;
  fork?: boolean;
  onPermission?: (req: unknown) => void;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: never;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse | (JsonRpcRequest & JsonRpcResponse);

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  method: string;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

export interface AcpStatusExtra { [key: string]: unknown; }

export class AcpClient extends EventEmitter {
  cwd: string;
  env: NodeJS.ProcessEnv;
  modelHint: string | null;
  settings: AcpClientSettings | null;
  resumeSessionId: string | null;
  fork: boolean;

  proc: ChildProcess | null = null;
  sock: Socket | null = null;
  agentId: string | null = null;
  held = false;
  sessionId: string | null = null;
  handshake: unknown = null;
  modelId: string | null = null;
  availableCommands: unknown[] = [];
  status: string = 'starting';
  lastError: string | null = null;
  exitInfo: ExitInfo | null = null;

  terminalHost: TerminalHost;
  fsHost: FsHost;
  permissionHost: PermissionHost;
  interactionHost: InteractionHost;

  private _pending = new Map<string | number, PendingRpc>();
  private _nextId = 1;
  private _closing = false;
  protected _activePromptId: string | null = null;
  /** Nested session/prompt (UI compact fallback) must not idle the user turn. */
  promptDepth = 0;

  constructor({ agentId, cwd, env, modelHint, settings, resumeSessionId, fork, onPermission }: AcpClientInit) {
    super();
    this.agentId = agentId || null;
    this.cwd = cwd;
    this.env = env || process.env;
    this.modelHint = modelHint || null;
    this.settings = settings && typeof settings === 'object' ? settings : null;
    this.resumeSessionId = resumeSessionId || null;
    this.fork = !!fork;

    this.terminalHost = createTerminalHost({ getCwd: () => this.cwd });
    this.fsHost = createFsHost({ getCwd: () => this.cwd });
    this.permissionHost = createPermissionHost({
      onRequest: (req) => {
        this.emit('permission_request', req);
        try { onPermission?.(req); } catch { /* ignore */ }
      },
    });
    this.interactionHost = createInteractionHost({
      onRequest: (req) => {
        this.emit('interaction_request', req);
      },
    });
    const always = !(this.settings && this.settings.alwaysApprove === false);
    this.permissionHost.setAuto(always);
  }

  private _buildArgv(): string[] {
    const top: string[] = [];
    const s = this.settings || {};

    const modelOverride = typeof s.model === 'string' ? s.model.trim() : '';
    const model = modelOverride || (typeof this.modelHint === 'string' ? this.modelHint.trim() : '');
    if (model) top.push('-m', model);

    if (typeof s.reasoningEffort === 'string' && s.reasoningEffort.trim()) {
      top.push('--reasoning-effort', s.reasoningEffort.trim());
    }
    if (typeof s.systemPromptOverride === 'string' && s.systemPromptOverride.length > 0) {
      top.push('--system-prompt-override', s.systemPromptOverride);
    }
    const rules = mergeArgvRules(
      typeof s.rules === 'string' ? s.rules : '',
      s.systemPromptOverride ? '' : model,
    );
    if (rules) top.push('--rules', rules);
    if (typeof s.tools === 'string' && s.tools.trim()) {
      top.push('--tools', s.tools.trim());
    }
    if (typeof s.disallowedTools === 'string' && s.disallowedTools.trim()) {
      top.push('--disallowed-tools', s.disallowedTools.trim());
    }
    if (Array.isArray(s.allow)) {
      for (const rule of s.allow) {
        if (typeof rule === 'string' && rule.trim()) top.push('--allow', rule.trim());
      }
    }
    if (Array.isArray(s.deny)) {
      for (const rule of s.deny) {
        if (typeof rule === 'string' && rule.trim()) top.push('--deny', rule.trim());
      }
    }
    if (typeof s.sandbox === 'string' && s.sandbox.trim()) {
      top.push('--sandbox', s.sandbox.trim());
    }
    if (typeof s.worktree === 'string' && s.worktree.trim()) {
      top.push('-w', s.worktree.trim());
    } else if (s.worktree === true) {
      top.push('-w');
    }

    if (this.resumeSessionId) {
      top.push('-r', this.resumeSessionId);
      if (this.fork) top.push('--fork-session');
    }

    const alwaysApprove = s.alwaysApprove === false ? false : true;
    const agentFlags: string[] = ['agent', '--no-leader'];
    if (alwaysApprove) agentFlags.push('--always-approve');
    else if (s.permissionMode === 'auto' || s.autoMode === true) {
      top.push('--permission-mode', 'auto');
    }
    agentFlags.push('stdio');

    return [...top, ...agentFlags];
  }

  setStatus(s: string, extra?: AcpStatusExtra): void {
    this.status = s;
    this.emit('status', { status: s, ...(extra || {}) });
  }

  private _wireLines(input: NodeJS.ReadableStream): void {
    const rl = createInterface({ input });
    rl.on('line', (line: string) => { void this._onLine(line); });
  }

  private attachSocket(sockPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(sockPath);
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        try { sock.destroy(); } catch { /* ignore */ }
        reject(err);
      };
      const t = setTimeout(() => fail(new Error('hold socket connect timeout')), 8000);
      sock.once('connect', () => {
        // Old hold rejected a second client by ending immediately after accept.
        const settle = setTimeout(() => {
          if (settled) return;
          if (sock.destroyed || sock.readableEnded || !sock.writable) {
            fail(new Error('hold rejected socket'));
            return;
          }
          settled = true;
          clearTimeout(t);
          this.sock = sock;
          this.held = true;
          this._wireLines(sock);
          sock.on('close', () => {
            if (this.sock === sock) this.sock = null;
            if (this._closing) return;
            this.setStatus('disconnected');
            this.emit('exit', { code: null, signal: null, at: Date.now() });
          });
          sock.on('error', (err) => this.emit('stderr', String(err.message || err)));
          resolve();
        }, 40);
        sock.once('close', () => {
          if (!settled) {
            clearTimeout(settle);
            fail(new Error('hold rejected socket'));
          }
        });
      });
      sock.once('error', (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async attachSocketRetry(sockPath: string, tries = 20): Promise<void> {
    let last: unknown = null;
    for (let i = 0; i < tries; i++) {
      try {
        await this.attachSocket(sockPath);
        return;
      } catch (err) {
        last = err;
        await new Promise((r) => setTimeout(r, Math.min(500, 80 + i * 80)));
      }
    }
    throw last instanceof Error ? last : new Error('hold socket connect failed');
  }

  async start({ resumeSessionId = null }: { resumeSessionId?: string | null } = {}): Promise<void> {
    const argv = this._buildArgv();
    if (this.agentId && holdEnabled()) {
      try {
        const hold = await ensureHold({ agentId: this.agentId, cwd: this.cwd, argv });
        await this.attachSocketRetry(hold.sock);
        const ready = readHoldReady(this.agentId);
        const skipHandshake = !holdNeedsHandshake(hold.created, ready?.sessionId || null);
        if (skipHandshake) {
          this.sessionId = resumeSessionId || this.resumeSessionId || ready?.sessionId || null;
          this.setStatus('idle');
          this.emit('session_ready', { sessionId: this.sessionId, resumed: true, attached: true });
          this.emit('stderr', `[hold] attached session=${this.sessionId} created=${hold.created}\n`);
          return;
        }
        try {
          await this._handshake(resumeSessionId);
          if (this.sessionId) markHoldReady(this.agentId, this.sessionId);
          this.setStatus('idle');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const shutdown = !!(this.exitInfo && (this.exitInfo.code === 143 || this.exitInfo.signal === 'SIGTERM' || /agent exited/i.test(msg)));
          if (shutdown) {
            this.setStatus('exited', this.exitInfo || { code: 143 });
            return;
          }
          this.lastError = msg;
          this.setStatus('errored', { error: msg });
          this.emit('error', err);
        }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (this.agentId && holdRunning(this.agentId)) {
          this.lastError = msg;
          this.setStatus('errored', { error: msg });
          this.emit('error', err);
          this.emit('stderr', '[hold] attach failed, not spawning a second grok: ' + msg + '\n');
          return;
        }
        this.emit('stderr', '[hold] fallback to in-process: ' + msg + '\n');
      }
    }

    this.proc = spawn(
      resolveGrokBin(this.env),
      argv,
      { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    this.proc.on('error', (err: Error) => {
      this.lastError = err.message;
      this.setStatus('errored', { error: err.message });
      this.emit('error', err);
    });

    this.proc.on('exit', (code, signal) => {
      this.exitInfo = { code, signal, at: Date.now() };
      this.setStatus('exited', { code, signal });
      this.emit('exit', this.exitInfo);
      this.terminalHost.shutdownAll();
      for (const [, pending] of this._pending) {
        pending.reject(new Error('agent exited'));
      }
      this._pending.clear();
    });

    this.proc.stderr?.on('data', (b: Buffer) => {
      this.emit('stderr', b.toString('utf8'));
    });

    if (!this.proc.stdout) throw new Error('grok stdio process has no stdout');
    this._wireLines(this.proc.stdout);

    try {
      await this._handshake(resumeSessionId);
      this.setStatus('idle');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const shutdown = !!(this.exitInfo && (this.exitInfo.code === 143 || this.exitInfo.signal === 'SIGTERM' || /agent exited/i.test(msg)));
      if (shutdown) {
        this.setStatus('exited', this.exitInfo || { code: 143 });
        return;
      }
      this.lastError = msg;
      this.setStatus('errored', { error: msg });
      this.emit('error', err);
    }
  }

  private async _handshake(resumeSessionId: string | null): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    }) as { _meta?: { modelState?: { currentModelId?: string }; availableCommands?: unknown[] }; agentCapabilities?: { loadSession?: boolean } };
    this.handshake = init;
    const meta = init?._meta || {};
    this.modelId = meta?.modelState?.currentModelId || null;
    this.availableCommands = meta?.availableCommands || [];
    this.emit('handshake', init);

    const canLoad = !!init?.agentCapabilities?.loadSession;
    let loaded = false;
    // --resume --fork-session already cloned history into a new session.
    if (this.fork) resumeSessionId = null;
    if (resumeSessionId && canLoad) {
      try {
        await this.request('session/load', {
          sessionId: resumeSessionId,
          cwd: this.cwd,
          mcpServers: [],
        });
        this.sessionId = resumeSessionId;
        loaded = true;
        this.emit('session_ready', { sessionId: this.sessionId, resumed: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emit('stderr', `session/load failed (${msg}); starting fresh session\n`);
      }
    }
    if (!loaded) {
      const ns = await this.request('session/new', {
        cwd: this.cwd,
        mcpServers: [],
      }) as { sessionId?: string };
      if (!ns?.sessionId) throw new Error('session/new did not return sessionId');
      this.sessionId = ns.sessionId;
      this.emit('session_ready', { sessionId: this.sessionId, resumed: false });
    }
  }

  private _trySend(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): boolean {
    if (!acpCanSend(this.sock, this.proc)) return false;
    try {
      this.emit('rpc_send', msg);
      const line = JSON.stringify(msg) + '\n';
      if (this.sock && !this.sock.destroyed) {
        this.sock.write(line);
        return true;
      }
      if (this.proc?.stdin?.writable) {
        this.proc.stdin.write(line);
        return true;
      }
    } catch { /* closed between check and write */ }
    return false;
  }

  private _send(msg: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this._trySend(msg)) throw new Error('agent stdin not writable');
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = `c-${this._nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this._send({ jsonrpc: '2.0', method, params });
  }

  private async _onLine(line: string): Promise<void> {
    if (!line) return;
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(line) as JsonRpcMessage; }
    catch {
      this.emit('error', new Error(`non-json frame: ${line.slice(0, 120)}`));
      return;
    }
    this.emit('rpc_recv', msg);

    // `Partial<JsonRpcRequest & JsonRpcResponse>` collapses to never because
    // JsonRpcResponse declares `method?: never`. Use an explicit ad-hoc shape
    // covering every JSON-RPC field we read in this dispatcher.
    const anyMsg = msg as {
      id?: string | number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    if (anyMsg.id != null && (anyMsg.result !== undefined || anyMsg.error !== undefined) && !anyMsg.method) {
      const p = this._pending.get(anyMsg.id);
      if (p) {
        this._pending.delete(anyMsg.id);
        if (anyMsg.error) {
          const e = new Error(anyMsg.error.message || 'rpc error') as Error & { rpc?: unknown };
          e.rpc = anyMsg.error;
          p.reject(e);
        } else {
          p.resolve(anyMsg.result);
        }
      }
      return;
    }

    if (anyMsg.id != null && anyMsg.method) {
      this.emit('request', msg);
      try {
        const result = await this._dispatch(anyMsg.method, anyMsg.params);
        if (!this._trySend({ jsonrpc: '2.0', id: anyMsg.id, result })) {
          this.emit('stderr', `drop reply ${anyMsg.method}: agent stdin not writable\n`);
        }
      } catch (err) {
        const e = err as { rpc?: { code: number; message: string }; message?: string };
        const rpc = e?.rpc && typeof e.rpc === 'object'
          ? e.rpc
          : { code: -32603, message: e?.message || 'internal error' };
        if (!this._trySend({ jsonrpc: '2.0', id: anyMsg.id, error: rpc })) {
          this.emit('stderr', `drop error reply ${anyMsg.method}: agent stdin not writable\n`);
        }
      }
      return;
    }

    if (anyMsg.method) {
      this.emit('notification', msg);
      if (anyMsg.method === 'session/update') {
        this.emit('update', anyMsg.params);
        const upd = anyMsg.params && typeof anyMsg.params === 'object'
          ? (anyMsg.params as { update?: Record<string, unknown> }).update
          : undefined;
        const su = upd && typeof upd['sessionUpdate'] === 'string' ? String(upd['sessionUpdate']) : '';
        if (su === 'model_changed' || su === 'ModelChanged' || su === 'current_model_update') {
          const next = upd && (upd['new_model'] || upd['modelId'] || upd['currentModelId']);
          const winRaw = upd && (upd['context_window'] || upd['contextWindow']);
          const contextWindow = typeof winRaw === 'number' && winRaw > 0 ? winRaw : undefined;
          if (typeof next === 'string' && next.trim()) {
            const id = next.trim();
            const changed = this.modelId !== id || contextWindow != null;
            this.modelId = id;
            if (changed) this.emit('model', { modelId: id, contextWindow });
          }
        }
        const chunkMeta = upd && typeof upd['_meta'] === 'object' && upd['_meta']
          ? upd['_meta'] as { modelId?: unknown }
          : null;
        if (chunkMeta && typeof chunkMeta.modelId === 'string' && chunkMeta.modelId.trim()) {
          const next = chunkMeta.modelId.trim();
          if (this.modelId !== next) {
            this.modelId = next;
            this.emit('model', { modelId: next });
          }
        }
        if ((this.status === 'idle' || this.status === 'starting') && isLiveWorkUpdate(su)) {
          this.setStatus('running');
        }
      } else if (anyMsg.method === '_x.ai/session/prompt_complete') {
        this.promptDepth = Math.max(0, (this.promptDepth || 1) - 1);
        if (this.promptDepth === 0) {
          if (this.status === 'running' || this.status === 'starting') this.setStatus('idle');
          this.emit('prompt_complete', anyMsg.params);
        }
      } else if (anyMsg.method.startsWith('_x.ai/')) {
        this.emit('x_notification', msg);
      }
    }
  }

  private async _dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'terminal/create':        return this.terminalHost.create(params as never);
      case 'terminal/output':        return this.terminalHost.output(params as never);
      case 'terminal/wait_for_exit': return this.terminalHost.waitForExit(params as never);
      case 'terminal/kill':          return this.terminalHost.kill(params as never);
      case 'terminal/release':       return this.terminalHost.release(params as never);
      case 'fs/read_text_file':      return this.fsHost.readTextFile(params as never);
      case 'fs/write_text_file':     return this.fsHost.writeTextFile(params as never);
      case 'session/request_permission':
        return this.permissionHost.requestPermission(params);
      case '_x.ai/exit_plan_mode':
      case 'x.ai/exit_plan_mode':
        return this.interactionHost.request('exit_plan_mode', params);
      case '_x.ai/ask_user_question':
      case 'x.ai/ask_user_question':
        return this.interactionHost.request('ask_user_question', params);
      default: {
        const err = new Error(`Method not found: ${method}`) as Error & { rpc?: { code: number; message: string } };
        err.rpc = { code: -32601, message: `Method not found: ${method}` };
        throw err;
      }
    }
  }

  /** Wait until nested session/prompt (compact fallback) finishes. */
  async waitForIdleTurn(timeoutMs = 180_000): Promise<void> {
    if ((this.promptDepth || 0) <= 0 && this.status !== 'running') return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('prompt_complete', onComplete);
        this.off('status', onStatus);
        if (err) reject(err);
        else resolve();
      };
      const onComplete = () => finish();
      const onStatus = (info: { status?: string } | string) => {
        const s = typeof info === 'string' ? info : info && info.status;
        if (s === 'idle' || s === 'exited' || s === 'errored' || s === 'disconnected') finish();
      };
      const timer = setTimeout(() => finish(new Error('turn did not finish')), timeoutMs);
      this.once('prompt_complete', onComplete);
      this.on('status', onStatus);
      if ((this.promptDepth || 0) <= 0 && this.status !== 'running') finish();
    });
  }

  async prompt(textOrBlocks: string | unknown[]): Promise<unknown> {
    if (!this.sessionId) throw new Error('session not ready');
    let prompt: unknown[];
    if (Array.isArray(textOrBlocks)) {
      prompt = textOrBlocks;
    } else {
      prompt = [{ type: 'text', text: String(textOrBlocks) }];
    }
    this.promptDepth += 1;
    this.setStatus('running');
    try {
      const result = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      });
      // session/prompt can resolve before the turn is done. Idle only
      // on prompt_complete so a refresh mid-turn still reports Running.
      this.emit('prompt_result', result);
      return result;
    } catch (err) {
      this.promptDepth = Math.max(0, this.promptDepth - 1);
      const msg = err instanceof Error ? err.message : String(err);
      if (this.promptDepth === 0) this.setStatus('errored', { error: msg });
      throw err;
    }
  }

  async setModel(opts: { modelId?: string; reasoningEffort?: string }): Promise<unknown> {
    if (!this.sessionId) throw new Error('session not ready');
    const modelId = String(opts.modelId || this.modelId || '').trim();
    const params = buildSetModelParams(this.sessionId, {
      modelId,
      reasoningEffort: opts.reasoningEffort,
    });
    if (!params.modelId) throw new Error('session/set_model needs a model id');
    const tries = ['session/set_model', 'session/setModel'];
    let last: unknown = null;
    for (const method of tries) {
      try {
        const result = await this.request(method, params);
        this.modelId = modelId;
        this.emit('model', { modelId });
        return result;
      } catch (err) {
        last = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!/not found|unknown method|method not found/i.test(msg)) throw err;
      }
    }
    throw last instanceof Error ? last : new Error('session/set_model failed');
  }

  async cancel(): Promise<{ cancelled: boolean; reason?: string; result?: unknown; fallback?: string; error?: string }> {
    if (!this.sessionId) return { cancelled: false, reason: 'no session' };
    const sid = this.sessionId;
    const rpc = this.request('session/cancel', { sessionId: sid });
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('cancel timeout')), 2000);
    });
    try {
      const result = await Promise.race([rpc, timeout]);
      this.promptDepth = 0;
      if (this.status === 'running' || this.status === 'starting') this.setStatus('idle');
      return { cancelled: true, result };
    } catch (err) {
      try { this.notify('session/cancel', { sessionId: sid }); } catch { /* ignore */ }
      this.promptDepth = 0;
      if (this.status === 'running' || this.status === 'starting') this.setStatus('idle');
      const msg = err instanceof Error ? err.message : String(err);
      return { cancelled: true, fallback: 'notification', error: msg };
    }
  }

  async shutdown(signal: NodeJS.Signals | { destroyHold?: boolean; signal?: NodeJS.Signals } = 'SIGTERM'): Promise<void> {
    if (this._closing) return;
    this._closing = true;
    this.terminalHost.shutdownAll();
    // String form is "detach". Only { destroyHold: true } may stop a hold
    // (delete conversation). Disconnect / archive / process restart must not.
    const opts = typeof signal === 'string' ? { destroyHold: false, signal } : (signal || {});
    const destroyHold = opts.destroyHold === true;
    if (this.sock) {
      try { this.sock.destroy(); } catch { /* ignore */ }
      this.sock = null;
    }
    if (this.held && this.agentId && destroyHold) {
      try { stopHold(this.agentId); } catch { /* ignore */ }
    }
    if (this.proc && !this.proc.killed) {
      const sig = opts.signal || 'SIGTERM';
      try { this.proc.kill(sig); } catch { /* ignore */ }
      const proc = this.proc;
      const timer = setTimeout(() => {
        if (proc.exitCode == null && !proc.killed) {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2000);
      timer.unref?.();
    }
  }
}

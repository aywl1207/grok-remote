// SSE endpoints: version-update stream, agents list stream, per-agent ring.

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AgentManager } from './agent-manager.js';
import { writeHeaders as sseHeaders, writeEvent as sseWrite, writePing as ssePing } from './sse.js';
import { sendJson } from './http-util.js';
import { runUpdate as runVersionUpdate, type UpdateStepEvent } from './version-update.js';

export function bindSseHttp(manager: AgentManager) {
  function handleVersionUpdateStream(req: IncomingMessage, res: ServerResponse): void {
    sseHeaders(res);
    let counter = 0;
    const send = (data: UpdateStepEvent): void => {
      sseWrite(res, {
        id: `vupd-${Date.now()}-${++counter}`,
        event: 'update',
        data,
      });
    };
    send({ step: 'open', status: 'ok', detail: 'connected' });

    const heartbeat = setInterval(() => ssePing(res), 5000);
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);

    runVersionUpdate({
      emit: (ev: UpdateStepEvent) => { if (!closed) send(ev); },
    }).then(() => {
      if (!closed) {
        send({ step: 'done', status: 'ok', detail: 'all steps completed' });
        cleanup();
      }
    }).catch((err: unknown) => {
      if (!closed) {
        const msg = err instanceof Error ? err.message : String(err);
        send({ step: 'done', status: 'fail', detail: msg });
        cleanup();
      }
    });
  }

  function handleAgentsStream(req: IncomingMessage, res: ServerResponse): void {
    sseHeaders(res);
    let counter = 0;
    sseWrite(res, {
      id: `agents-${Date.now()}-${++counter}`,
      event: 'agents_snapshot',
      data: { agents: manager.list() },
    });
    const onChange = (payload: { event?: string; [k: string]: unknown }): void => {
      sseWrite(res, {
        id: `agents-${Date.now()}-${++counter}`,
        event: payload.event || 'agents_changed',
        data: payload,
      });
    };
    manager.on('list_changed', onChange);
    const heartbeat = setInterval(() => ssePing(res), 15000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      try { manager.off('list_changed', onChange); } catch { /* ignore */ }
      if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  function handleStream(req: IncomingMessage, res: ServerResponse, id: string): void {
    const ring = manager.ring(id);
    if (!ring) { sendJson(res, 404, { ok: false, error: 'agent not found' }); return; }

    sseHeaders(res);
    const lastId = req.headers['last-event-id'] as string | undefined;
    for (const ev of ring.since(lastId)) {
      sseWrite(res, ev);
    }

    const unsub = manager.subscribe(id, (ev) => sseWrite(res, ev));
    const heartbeat = setInterval(() => ssePing(res), 15000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      try { unsub(); } catch { /* ignore */ }
      if (!res.writableEnded) try { res.end(); } catch { /* ignore */ }
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
  }


  return {
    handleVersionUpdateStream,
    handleAgentsStream,
    handleStream,
  };
}

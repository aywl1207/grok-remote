// EventSource wrapper.
//
// Notes:
// - The browser's EventSource already handles Last-Event-ID automatically on
//   reconnect: it sends the value of the last `id:` field it observed.
// - We surface lifecycle hooks (open / error / event), allow registering
//   handlers per event name, and expose a close() that stops the connection.
// - The server is expected to emit named events (sessionUpdate discriminator)
//   plus our own lifecycle ones: agent_status, prompt_complete, error.

export const KNOWN_EVENTS = [
  'user_message',
  'user_message_chunk',
  'handshake',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'tool_call_delta_chunk',
  'available_commands_update',
  'session_summary_generated',
  'agent_status',
  'prompt_complete',
  'error',
  'session_notification',
  'permission_request',
  'plan_approval',
  'user_question',
  // Grok compact lifecycle. EventSource only delivers named events we
  // subscribe to; these never hit the generic "message" listener.
  'x.ai/session/update',
  'auto_compact_started',
  'auto_compact_completed',
  'auto_compact_failed',
  'auto_compact_cancelled',
  'compact_started',
  'compact_completed',
  'compact_failed',
  'compaction_checkpoint',
] as const;

export type StreamEventName = (typeof KNOWN_EVENTS)[number] | 'message';

export type StreamHandler = (parsed: unknown, ev: MessageEvent) => void;

export interface StreamOptions {
  onOpen?: () => void;
  onError?: (err: unknown) => void;
  onAny?: (name: StreamEventName, parsed: unknown, ev: MessageEvent) => void;
  on?: Partial<Record<StreamEventName, StreamHandler>>;
}

export interface StreamHandle {
  close(): void;
  isClosed(): boolean;
  readyState(): number;
}

export function openStream(url: string, { onOpen, onError, onAny, on }: StreamOptions = {}): StreamHandle {
  let es: EventSource | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const handlers: Partial<Record<StreamEventName, StreamHandler>> = { ...(on || {}) };

  const attach = (source: EventSource): void => {
    source.addEventListener('open', () => {
      if (typeof onOpen === 'function') onOpen();
    });
    source.addEventListener('error', (ev: Event) => {
      if (typeof onError === 'function') onError(ev);
      if (closed) return;
      // Browser EventSource auto-retries CONNECTING. A fatal CLOSED socket
      // never opens again unless we construct a new EventSource.
      if (source.readyState === 2) {
        try { source.close(); } catch { /* ignore */ }
        if (es === source) {
          try { es.close(); } catch { /* ignore */ }
        }
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (closed) return;
          try {
            es = new EventSource(url);
            attach(es);
          } catch (err) {
            if (typeof onError === 'function') onError(err);
          }
        }, 1000);
      }
    });
    for (const name of KNOWN_EVENTS) {
      source.addEventListener(name, (ev: MessageEvent) => {
        let parsed: unknown = ev.data;
        try { parsed = JSON.parse(ev.data); } catch { /* keep raw */ }
        if (typeof onAny === 'function') onAny(name, parsed, ev);
        const handler = handlers[name];
        if (typeof handler === 'function') handler(parsed, ev);
      });
    }
    source.addEventListener('message', (ev: MessageEvent) => {
      let parsed: unknown = ev.data;
      try { parsed = JSON.parse(ev.data); } catch { /* keep raw */ }
      if (typeof onAny === 'function') onAny('message', parsed, ev);
      const handler = handlers['message'];
      if (typeof handler === 'function') handler(parsed, ev);
    });
  };

  try {
    es = new EventSource(url);
    attach(es);
  } catch (err) {
    if (typeof onError === 'function') onError(err);
  }

  return {
    close(): void {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (es) {
        try { es.close(); } catch { /* ignore */ }
        es = null;
      }
    },
    isClosed(): boolean {
      if (closed) return true;
      if (reconnectTimer) return false;
      if (!es) return true;
      return es.readyState === 2;
    },
    readyState(): number { return es ? es.readyState : 2; },
  };
}

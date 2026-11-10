// Per-conversation queued composer payload. Survives switching chats in this tab.

export const PROMPT_QUEUE_KEY = 'grok-remote.prompt-queue.v1';

export interface PromptQueueItem {
  text: string;
  attachments: unknown[];
}

export function hasQueueContent(q: { text?: unknown; attachments?: unknown[] } | null | undefined): boolean {
  if (!q) return false;
  if (String(q.text || '').trim()) return true;
  return Array.isArray(q.attachments) && q.attachments.length > 0;
}

function readMap(): Record<string, PromptQueueItem> {
  try {
    const raw = sessionStorage.getItem(PROMPT_QUEUE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, PromptQueueItem>;
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, PromptQueueItem>): void {
  try {
    sessionStorage.setItem(PROMPT_QUEUE_KEY, JSON.stringify(map));
  } catch {
    // Quota: keep text only.
    try {
      const slim: Record<string, PromptQueueItem> = {};
      for (const [id, q] of Object.entries(map)) {
        slim[id] = { text: String(q && q.text || ''), attachments: [] };
      }
      sessionStorage.setItem(PROMPT_QUEUE_KEY, JSON.stringify(slim));
    } catch { /* ignore */ }
  }
}

export function loadAgentQueue(agentId: string | null | undefined): PromptQueueItem | null {
  const id = String(agentId || '');
  if (!id) return null;
  const q = readMap()[id];
  if (!hasQueueContent(q)) return null;
  return {
    text: String(q.text || ''),
    attachments: Array.isArray(q.attachments) ? q.attachments : [],
  };
}

export function saveAgentQueue(
  agentId: string | null | undefined,
  q: { text?: unknown; attachments?: unknown[] } | null | undefined,
): void {
  const id = String(agentId || '');
  if (!id) return;
  const map = readMap();
  if (!hasQueueContent(q)) {
    if (!(id in map)) return;
    delete map[id];
    writeMap(map);
    return;
  }
  map[id] = {
    text: String(q!.text || ''),
    attachments: Array.isArray(q!.attachments) ? q!.attachments : [],
  };
  writeMap(map);
}

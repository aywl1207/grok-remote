// How many chats a folder shows before "Show N more". Large folders
// must not paint every row into the sidebar.

export const FOLDER_PREVIEW_COUNT = 8;
const EXPANDED_KEY = 'grok-remote.sidebar.folder-preview-expanded';

export function loadPreviewExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

export function savePreviewExpanded(set: Set<string>): void {
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}

export function folderShowMoreLabel(hidden: number): string {
  return hidden === 1 ? 'Show 1 more' : `Show ${hidden} more`;
}

export function previewFolderItems<T extends { id: string }>(opts: {
  items: T[];
  selectedId: string | null;
  expanded: boolean;
  searching: boolean;
  limit?: number;
}): { shown: T[]; hidden: number; scroll: boolean } {
  const limit = opts.limit ?? FOLDER_PREVIEW_COUNT;
  const items = opts.items || [];
  if (opts.searching || opts.expanded || items.length <= limit) {
    return {
      shown: items,
      hidden: 0,
      scroll: items.length > limit,
    };
  }
  const head = items.slice(0, limit);
  const selected = opts.selectedId
    ? items.find((a) => a.id === opts.selectedId)
    : undefined;
  const shown = selected && !head.some((a) => a.id === selected.id)
    ? [...head, selected]
    : head;
  return { shown, hidden: items.length - shown.length, scroll: false };
}

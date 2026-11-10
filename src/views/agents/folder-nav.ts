// Project (folder) navigation for the sidebar. The list is a picker, not
// an accordion: one project is active and only that project's chats render.

export const TOP_LEVEL_ID = '__top__';
export const ARCHIVED_FOLDER_ID = 'archived';
const ACTIVE_KEY = 'grok-remote.sidebar.active-folder';

export function loadActiveFolderId(): string | null {
  try {
    const v = localStorage.getItem(ACTIVE_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function saveActiveFolderId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* ignore */ }
}

export function folderActivity(items: Array<{ lastSeen?: string; createdAt?: string }>): string {
  let best = '';
  for (const a of items) {
    const t = a.lastSeen || a.createdAt || '';
    if (t > best) best = t;
  }
  return best;
}

/** Live turns in a project. Leftover ACP "running" without a turn does not count. */
export function projectLiveWork(items: Array<{
  status?: string | null;
  turnOpen?: boolean;
  inFlight?: number;
}>): { running: number; starting: number } {
  let running = 0;
  let starting = 0;
  for (const a of items) {
    const st = String(a.status || '').toLowerCase();
    if (st === 'starting') { starting += 1; continue; }
    if (a.turnOpen) { running += 1; continue; }
    if (typeof a.inFlight === 'number' && a.inFlight > 0) running += 1;
  }
  return { running, starting };
}

export function sortProjects<T extends { id: string; name: string }>(
  folders: T[],
  activityById: Map<string, string>,
  liveById?: Map<string, number>,
): T[] {
  return folders.slice().sort((a, b) => {
    if (a.id === ARCHIVED_FOLDER_ID && b.id !== ARCHIVED_FOLDER_ID) return 1;
    if (b.id === ARCHIVED_FOLDER_ID && a.id !== ARCHIVED_FOLDER_ID) return -1;
    const la = liveById ? (liveById.get(a.id) || 0) : 0;
    const lb = liveById ? (liveById.get(b.id) || 0) : 0;
    if (la !== lb) return lb - la;
    const ia = activityById.get(a.id) || '';
    const ib = activityById.get(b.id) || '';
    if (ia !== ib) return ib.localeCompare(ia);
    return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
  });
}

export function projectMatchesSearch(opts: {
  name: string;
  search: string;
  chatMatchCount: number;
}): boolean {
  if (!opts.search) return true;
  const needle = opts.search.toLowerCase();
  if ((opts.name || '').toLowerCase().includes(needle)) return true;
  return opts.chatMatchCount > 0;
}

/** Prefer the saved project, then the selected chat's project, then the
 *  most recently active remaining project. */
export function resolveActiveFolderId(opts: {
  saved: string | null;
  folderIds: string[];
  hasTopLevel: boolean;
  selectedFolderId: string | null | undefined;
}): string {
  const ids = new Set(opts.folderIds);
  if (opts.hasTopLevel) ids.add(TOP_LEVEL_ID);
  if (opts.saved && ids.has(opts.saved)) return opts.saved;
  if (opts.selectedFolderId === null && opts.hasTopLevel) return TOP_LEVEL_ID;
  if (opts.selectedFolderId && ids.has(opts.selectedFolderId)) return opts.selectedFolderId;
  const first = opts.folderIds.find((id) => id !== ARCHIVED_FOLDER_ID);
  if (first) return first;
  if (opts.hasTopLevel) return TOP_LEVEL_ID;
  return opts.folderIds[0] || TOP_LEVEL_ID;
}

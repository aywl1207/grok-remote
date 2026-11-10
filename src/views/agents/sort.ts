// Sidebar sort / search / collapsed-folder persistence.

import { SIDEBAR_SORT_KEY, SIDEBAR_SORT_DEFAULT } from '../../lib/sidebar-row.js';

export interface AgentSortable {
  name?: string;
  model?: string;
  cwd?: string;
  createdAt?: string;
  lastSeen?: string;
}

const SORT_KEY = SIDEBAR_SORT_KEY;
const SEARCH_KEY = 'grok-remote.sidebar.search';
const COLLAPSED_KEY = 'grok-remote.sidebar.collapsed-folders';
const SORT_DEFAULT = SIDEBAR_SORT_DEFAULT;

export interface SortConfig { label: string; cmp(a: AgentSortable, b: AgentSortable): number }

export const SORTS: Record<string, SortConfig> = {
  created_desc:    { label: 'Newest first',     cmp: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') },
  created_asc:     { label: 'Oldest first',     cmp: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') },
  activity_desc:   { label: 'Last active',      cmp: (a, b) => (b.lastSeen   || '').localeCompare(a.lastSeen   || '') },
  name_asc:        { label: 'Name (A → Z)',    cmp: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }) },
};

export function loadSort(): string { try { const v = localStorage.getItem(SORT_KEY); return v && SORTS[v] ? v : SORT_DEFAULT; } catch { return SORT_DEFAULT; } }
export function saveSort(v: string): void { try { localStorage.setItem(SORT_KEY, v); } catch { /* ignore */ } }
export function loadSearch(): string { try { return localStorage.getItem(SEARCH_KEY) || ''; } catch { return ''; } }
export function saveSearch(v: string): void { try { localStorage.setItem(SEARCH_KEY, v); } catch { /* ignore */ } }
export function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { return new Set(); }
}
export function saveCollapsed(set: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set))); } catch { /* ignore */ }
}

export function sortAgents<T extends AgentSortable & { starred?: boolean; id?: string }>(list: T[], sortKey: string): T[] {
  const sorter = SORTS[sortKey] || SORTS[SORT_DEFAULT]!;
  return list.slice().sort((a, b) => {
    const s = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
    if (s) return s;
    return sorter.cmp(a, b);
  });
}

export function matchesSearch(a: AgentSortable & { id?: string }, search: string): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return (a.name || '').toLowerCase().includes(needle)
      || (a.id || '').toLowerCase().includes(needle)
      || (a.model || '').toLowerCase().includes(needle);
}

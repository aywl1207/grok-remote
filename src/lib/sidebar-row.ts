// Sidebar list copy + which chips a conversation row should show.
// Keep agents.ts as wiring only.

export const SIDEBAR_COPY = {
  title: 'Conversations',
  newChat: '+ New',
  newChatTitle: 'Start a new conversation in a folder',
  newFolder: '+ Folder',
  empty: 'No conversations yet.',
  noMatch: 'No conversations match your search.',
  search: 'Search chats or projects',
  projects: 'Projects',
  topLevel: 'Top level',
  more: 'More',
  folderNew: 'New',
  folderFork: 'Fork',
  handleNew: '+ New chat',
  handleFork: 'Fork…',
  emptyFolder: 'No chats here yet',
  emptyTop: 'No chats at top level',
  showLess: 'Show less',
} as const;

export const SIDEBAR_SORT_KEY = 'grok-remote.sidebar.sort.v2';
export const SIDEBAR_SORT_DEFAULT = 'activity_desc';

const STATUS_LABEL: Record<string, string> = {
  idle:         'Idle',
  running:      'Running',
  errored:      'Errored',
  killed:       'Killed',
  starting:     'Starting',
  disconnected: 'Disconnected',
  exited:       'Disconnected',
};

/** Status text for a row. Idle and Disconnected stay visible; the color dot is extra. */
export function rowStatusLabel(status: string | null | undefined): string | null {
  const key = String(status || 'idle').toLowerCase();
  return STATUS_LABEL[key] || STATUS_LABEL.idle;
}

export function rowStatusKey(status: string | null | undefined): string {
  const key = String(status || 'idle').toLowerCase();
  return key === 'exited' ? 'disconnected' : (STATUS_LABEL[key] ? key : 'idle');
}

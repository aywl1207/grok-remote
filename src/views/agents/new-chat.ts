// New-conversation dialog. Wired from the sidebar; keep agents.ts as orchestrator.

import { el } from '../../lib/render.js';

interface Folder {
  id: string;
  name: string;
  agentIds: string[];
  system?: boolean;
}

const LAST_FOLDER_KEY = 'grok-remote.new-chat.folderId';

export function loadLastFolderId(): string | null {
  try {
    const v = localStorage.getItem(LAST_FOLDER_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function saveLastFolderId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_FOLDER_KEY, id);
    else localStorage.removeItem(LAST_FOLDER_KEY);
  } catch { /* ignore */ }
}

export function pickDefaultFolderId(
  folders: Folder[],
  preferred?: string | null,
): string | null {
  const usable = folders.filter((f) => f && !f.system);
  if (!usable.length) return null;
  if (preferred && usable.some((f) => f.id === preferred)) return preferred;
  const last = loadLastFolderId();
  if (last && usable.some((f) => f.id === last)) return last;
  return usable[0]!.id;
}

export function siblingCwdsForFolder(
  folder: Folder | null | undefined,
  agents: Array<{ id: string; cwd?: string }>,
): string[] {
  if (!folder) return [];
  const ids = new Set(folder.agentIds || []);
  return agents.filter((a) => ids.has(a.id) && a.cwd).map((a) => String(a.cwd));
}

/** One-click fork source: selected chat in this folder, the only chat, or
 *  the selected chat when the folder is empty (fork-into). Otherwise the
 *  caller should open a picker. */
export function pickForkSourceId(opts: {
  folderAgentIds: string[];
  selectedId: string | null;
  fallbackIds?: string[];
}): string | null {
  const folderIds = (opts.folderAgentIds || []).filter(Boolean);
  const selected = opts.selectedId;
  if (selected && folderIds.includes(selected)) return selected;
  if (folderIds.length === 1) return folderIds[0]!;
  if (folderIds.length === 0) {
    const fallback = (opts.fallbackIds || []).filter(Boolean);
    if (selected && fallback.includes(selected)) return selected;
    if (fallback.length === 1) return fallback[0]!;
  }
  return null;
}

export function openForkChatDialog(opts: {
  agents: Array<{ id: string; name?: string }>;
  folderLabel: string;
  selectedId?: string | null;
  onSubmit: (sourceId: string) => void;
}): void {
  const agents = (opts.agents || []).filter((a) => a && a.id);
  const close = (): void => {
    try { overlay.remove(); } catch { /* ignore */ }
  };

  if (!agents.length) {
    window.alert('No chats to fork yet.');
    return;
  }

  const pick = (sourceId: string): void => {
    close();
    opts.onSubmit(sourceId);
  };

  const list = el('div', { class: 'new-chat-modal__list' },
    ...agents.map((a) => el('button', {
      class: `new-chat-modal__pick${a.id === opts.selectedId ? ' is-selected' : ''}`,
      type: 'button',
      onclick: () => pick(a.id),
    }, a.name || a.id.slice(0, 8))),
  ) as HTMLElement;

  const overlay = el('div', { class: 'new-chat-modal', role: 'dialog', 'aria-label': 'Fork chat' },
    el('div', { class: 'new-chat-modal__backdrop', onclick: close }),
    el('div', { class: 'new-chat-modal__card' },
      el('div', { class: 'new-chat-modal__head' },
        el('div', { class: 'new-chat-modal__title' }, `Fork into ${opts.folderLabel}`),
        el('button', { type: 'button', class: 'new-chat-modal__close', onclick: close, 'aria-label': 'Close' }, '×'),
      ),
      el('div', { class: 'new-chat-modal__hint' }, 'Pick a conversation to copy into this folder.'),
      list,
      el('div', { class: 'new-chat-modal__actions' },
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: close }, 'Cancel'),
      ),
    ),
  ) as HTMLElement;

  overlay.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  });
  document.body.appendChild(overlay);
  const first = list.querySelector<HTMLButtonElement>('button');
  setTimeout(() => (first || overlay).focus(), 0);
}

export interface NewChatValues {
  folderId: string | null;
  name: string;
}

export function openNewChatDialog(opts: {
  folders: Folder[];
  presetFolderId?: string | null;
  onSubmit: (values: NewChatValues) => void;
}): void {
  const usable = (opts.folders || []).filter((f) => f && !f.system);
  const initial = pickDefaultFolderId(usable, opts.presetFolderId);

  const close = (): void => {
    try { overlay.remove(); } catch { /* ignore */ }
  };

  const nameInput = el('input', {
    class: 'new-chat-modal__input',
    type: 'text',
    placeholder: 'Optional name (otherwise named from the first message)',
    autocomplete: 'off',
  }) as HTMLInputElement;

  const folderSelect = el('select', {
    class: 'new-chat-modal__input',
    'aria-label': 'Folder',
  },
    el('option', { value: '' }, 'Top level'),
    ...usable.map((f) => el('option', {
      value: f.id,
      ...(f.id === initial ? { selected: '' } : {}),
    }, f.name)),
  ) as HTMLSelectElement;

  const create = (): void => {
    const folderId = (folderSelect.value || '').trim() || null;
    saveLastFolderId(folderId);
    const name = (nameInput.value || '').trim();
    close();
    opts.onSubmit({ folderId, name });
  };

  const overlay = el('div', { class: 'new-chat-modal', role: 'dialog', 'aria-label': 'New chat' },
    el('div', { class: 'new-chat-modal__backdrop', onclick: close }),
    el('div', { class: 'new-chat-modal__card' },
      el('div', { class: 'new-chat-modal__head' },
        el('div', { class: 'new-chat-modal__title' }, 'New chat'),
        el('button', { type: 'button', class: 'new-chat-modal__close', onclick: close, 'aria-label': 'Close' }, '×'),
      ),
      el('label', { class: 'new-chat-modal__label' }, 'Folder', folderSelect),
      el('label', { class: 'new-chat-modal__label' }, 'Name', nameInput),
      el('div', { class: 'new-chat-modal__actions' },
        el('button', { type: 'button', class: 'btn btn--ghost', onclick: close }, 'Cancel'),
        el('button', { type: 'button', class: 'btn btn--primary', onclick: create }, 'Create'),
      ),
    ),
  ) as HTMLElement;

  overlay.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    if (ev.key === 'Enter') { ev.preventDefault(); create(); }
  });
  document.body.appendChild(overlay);
  setTimeout(() => nameInput.focus(), 0);
}

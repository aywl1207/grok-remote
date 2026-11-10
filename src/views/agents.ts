// Conversation sidebar: project picker + chats for the active project.
//
// Folders are a flat selectable list (no expand/collapse). Only the
// active project's chats are painted. Drag a chat onto a project row to
// move it.

import { api } from '../lib/api.js';
import { el } from '../lib/render.js';
import { fmtTokens } from '../lib/format.js';
import { computeSelection } from './agents-selection.js';
import {
  SIDEBAR_COPY,
  rowStatusLabel,
  rowStatusKey,
} from '../lib/sidebar-row.js';
import { sidebarDisplayStatus, applyWorkingOverlayRow, LOCAL_TURN_HOLD_MS } from '../../lib/agent-status.js';
import {
  SORTS,
  loadSort, saveSort, loadSearch, saveSearch,
  sortAgents, matchesSearch,
} from './agents/sort.js';
import { inferCwdForFolder } from '../lib/conversation-folder.js';
import {
  openNewChatDialog,
  openForkChatDialog,
  pickForkSourceId,
  siblingCwdsForFolder,
  saveLastFolderId,
} from './agents/new-chat.js';
import {
  TOP_LEVEL_ID,
  ARCHIVED_FOLDER_ID,
  loadActiveFolderId,
  saveActiveFolderId,
  folderActivity,
  sortProjects,
  projectLiveWork,
  projectMatchesSearch,
  resolveActiveFolderId,
} from './agents/folder-nav.js';
// Touch needs a long-press because vertical drag is reserved for scrolling.
// Mouse/pen activate drag immediately past a small horizontal move threshold.
const LONG_PRESS_MS    = 450;
const MOUSE_DRAG_THRESH = 6;
const TOUCH_MOVE_THRESH = 8;
// A pointerup within this window with no movement counts as a plain click.
const CLICK_MAX_MS = 250;

export interface Agent {
  id: string;
  name?: string;
  model?: string;
  status?: string;
  cwd?: string;
  createdAt?: string;
  lastSeen?: string;
  starred?: boolean;
  archived?: boolean;
  totalTokens?: number;
  inFlight?: number;
  turnOpen?: boolean;
  [k: string]: unknown;
}

export interface Folder {
  id: string;
  name: string;
  agentIds: string[];
  createdAt: string;
  // System folders ("Archived") can't be deleted or renamed.
  system?: boolean;
}

export interface AgentsSidebarOptions {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;
}

export class AgentsSidebar {
  onSelect?: (id: string) => void;
  onCreate?: (created: Agent) => void;
  onDelete?: (id: string) => void;

  agents: Agent[];
  folders: Folder[];
  selectedId: string | null;
  // Multi-selection (Ctrl/Cmd-click + Shift-click) is independent of selectedId,
  // which still tracks the currently-open conversation.
  multiSelection: Set<string>;
  selectionAnchor: string | null;
  pollHandle: ReturnType<typeof setInterval> | null;
  sortKey: string;
  search: string;
  activeFolderId: string;

  activeList: HTMLElement;
  multiSelectFooter: HTMLElement;
  multiSelectLabel: HTMLElement;
  empty: HTMLElement;
  noMatch: HTMLElement;
  error: HTMLElement;
  newBtn: HTMLButtonElement;
  newFolderBtn: HTMLButtonElement;
  closeDrawerBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  searchClearBtn: HTMLButtonElement;
  sortSelect: HTMLSelectElement;
  root: HTMLElement;

  private _creating?: boolean;
  private _spawnHandlerWired?: boolean;
  private _bootReady = false;
  private _agentsStream?: EventSource | null;
  private _sseAlive?: boolean;
  private _workingUntil: Map<string, number> = new Map();
  private _agentsRaw: Agent[] = [];
  private _onVisibility?: () => void;

  // Drag state (pointer-events based).
  private _drag: {
    agentId: string;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    startTime: number;
    sourceEl: HTMLElement;
    ghost: HTMLElement | null;
    active: boolean;
    captured: boolean;
    pressTimer: number | null;
    moved: boolean;
  } | null = null;

  private _ctxMenu: HTMLElement | null = null;
  private _ctxCleanup: (() => void) | null = null;

  constructor({ onSelect, onCreate, onDelete }: AgentsSidebarOptions) {
    this.onSelect = onSelect;
    this.onCreate = onCreate;
    this.onDelete = onDelete;
    this.agents = [];
    this.folders = [];
    this.selectedId = null;
    this.multiSelection = new Set();
    this.selectionAnchor = null;
    this.pollHandle = null;
    this.sortKey = loadSort();
    this.search  = loadSearch();
    this.activeFolderId = loadActiveFolderId() || TOP_LEVEL_ID;

    this.activeList = el('div', { class: 'agents-list' }) as HTMLElement;
    // Drop-target highlight should clear if the user drags out of the list.
    this.activeList.addEventListener('pointerleave', () => {
      this.activeList.querySelectorAll('.project-row--drop').forEach((n) =>
        n.classList.remove('project-row--drop'),
      );
    });

    this.empty = el('div', { class: 'agents-empty' }, SIDEBAR_COPY.empty) as HTMLElement;
    this.noMatch = el('div', { class: 'agents-empty' }, SIDEBAR_COPY.noMatch) as HTMLElement;
    this.error = el('div', { class: 'agents-empty agents-empty--err' }) as HTMLElement;
    this.error.hidden = true;

    this.newBtn = el('button', {
      class: 'agents-new-btn',
      title: SIDEBAR_COPY.newChatTitle,
      onclick: () => this.openNewChat(),
    }, SIDEBAR_COPY.newChat) as HTMLButtonElement;

    this.newFolderBtn = el('button', {
      class: 'agents-new-folder-btn',
      type: 'button',
      title: 'Create a new folder',
      onclick: () => void this.promptNewFolder(),
    }, SIDEBAR_COPY.newFolder) as HTMLButtonElement;

    this.closeDrawerBtn = el('button', {
      class: 'sidebar-close',
      type: 'button',
      title: 'Close menu',
      'aria-label': 'Close menu',
      onclick: () => document.dispatchEvent(new CustomEvent('grok-remote:close-drawer')),
    }, '×') as HTMLButtonElement;

    this.searchInput = el('input', {
      class: 'sidebar-search-input',
      type: 'search',
      placeholder: SIDEBAR_COPY.search,
      value: this.search,
      'aria-label': 'Search chats or projects',
      oninput: (ev: Event) => {
        const target = ev.target as HTMLInputElement;
        this.search = (target.value || '').trim();
        saveSearch(this.search);
        this.renderList();
      },
    }) as HTMLInputElement;
    this.searchClearBtn = el('button', {
      class: 'sidebar-search-clear',
      type: 'button',
      title: 'Clear search',
      'aria-label': 'Clear search',
      onclick: () => {
        this.search = '';
        this.searchInput.value = '';
        saveSearch('');
        this.renderList();
        this.searchInput.focus();
      },
    }, '×') as HTMLButtonElement;

    this.sortSelect = el('select', {
      class: 'sidebar-sort',
      'aria-label': 'Sort conversations',
      onchange: (ev: Event) => {
        const target = ev.target as HTMLSelectElement;
        this.sortKey = target.value;
        saveSort(this.sortKey);
        this.renderList();
      },
    },
      ...Object.entries(SORTS).map(([k, s]) =>
        el('option', { value: k, ...(k === this.sortKey ? { selected: '' } : {}) }, s.label),
      ),
    ) as HTMLSelectElement;

    this.multiSelectLabel = el('span', { class: 'sidebar-multi__label' }, '') as HTMLElement;
    const clearBtn = el('button', {
      class: 'sidebar-multi__clear',
      type: 'button',
      title: 'Clear selection (Esc)',
      onclick: (ev: MouseEvent) => { ev.stopPropagation(); this.clearMultiSelection(); },
    }, 'Clear') as HTMLButtonElement;
    this.multiSelectFooter = el('div', { class: 'sidebar-multi', hidden: '' },
      this.multiSelectLabel,
      clearBtn,
    ) as HTMLElement;

    this.root = el('aside', { class: 'sidebar' },
      el('div', { class: 'sidebar-head' },
        el('span', { class: 'sidebar-title' }, SIDEBAR_COPY.title),
        this.newBtn,
        this.newFolderBtn,
        this.closeDrawerBtn,
      ),
      el('div', { class: 'sidebar-tools' },
        el('div', { class: 'sidebar-search' },
          this.searchInput,
          this.searchClearBtn,
        ),
        this.sortSelect,
      ),
      this.error,
      el('div', { class: 'sidebar-body' },
        this.activeList,
      ),
      this.multiSelectFooter,
    ) as HTMLElement;

    // Esc clears the multi-selection. Scoped to the sidebar root so we don't
    // intercept Esc inside the chat composer or other modals.
    this.root.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && this.multiSelection.size > 0) {
        ev.preventDefault();
        this.clearMultiSelection();
      }
    });
    // Make the root focusable for the Escape handler to fire.
    if (!this.root.hasAttribute('tabindex')) this.root.setAttribute('tabindex', '-1');
  }

  clearMultiSelection(): void {
    if (this.multiSelection.size === 0 && this.selectionAnchor == null) return;
    this.multiSelection = new Set();
    this.selectionAnchor = null;
    this.renderList();
  }

  private _updateMultiFooter(): void {
    const n = this.multiSelection.size;
    if (n <= 1) {
      this.multiSelectFooter.hidden = true;
      return;
    }
    this.multiSelectFooter.hidden = false;
    this.multiSelectLabel.textContent = `${n} selected`;
  }

  // Visible, sorted, search-filtered agent IDs in their on-screen order.
  // Used as the ordering universe for shift-click range selection.
  private _visibleOrderedIds(): string[] {
    return this._chatsForActivePane().map((a) => a.id);
  }

  private _setActiveFolder(id: string): void {
    this.activeFolderId = id || TOP_LEVEL_ID;
    saveActiveFolderId(this.activeFolderId === TOP_LEVEL_ID ? TOP_LEVEL_ID : this.activeFolderId);
  }

  private _folderIdForAgent(agentId: string): string {
    const agent = this.agents.find((a) => a.id === agentId);
    if (agent && agent.archived) return ARCHIVED_FOLDER_ID;
    for (const f of this.folders) {
      if (f.agentIds.includes(agentId)) return f.id;
    }
    return TOP_LEVEL_ID;
  }

  private _projectLabel(folderId: string): string {
    if (folderId === TOP_LEVEL_ID) return SIDEBAR_COPY.topLevel;
    const f = this.folders.find((x) => x.id === folderId);
    return f ? f.name : SIDEBAR_COPY.topLevel;
  }

  private _chatsForActivePane(): Agent[] {
    const sorted = this._sortAgents(this.agents);
    if (this.folders.length === 0) {
      return sorted.filter((a) => this._matchesSearch(a));
    }
    const inProject = sorted.filter((a) => this._folderIdForAgent(a.id) === this.activeFolderId);
    if (!this.search) return inProject;
    const needle = this.search.toLowerCase();
    if (this._projectLabel(this.activeFolderId).toLowerCase().includes(needle)) return inProject;
    return inProject.filter((a) => this._matchesSearch(a));
  }

  private _sortAgents(list: Agent[]): Agent[] {
    return sortAgents(list, this.sortKey);
  }

  private _matchesSearch(a: Agent): boolean {
    return matchesSearch(a, this.search);
  }

  openNewChat(presetFolderId?: string | null): void {
    const fromActive = this.activeFolderId && this.activeFolderId !== TOP_LEVEL_ID
      ? this.activeFolderId
      : null;
    openNewChatDialog({
      folders: this.folders,
      presetFolderId: presetFolderId ?? fromActive,
      onSubmit: (values) => { void this.spawnNew(values); },
    });
  }

  async spawnNew(opts?: { folderId?: string | null; name?: string }): Promise<void> {
    if (this._creating) return;
    this._creating = true;
    this.newBtn.disabled = true;
    this.error.hidden = true;
    const prevLabel = this.newBtn.textContent;
    this.newBtn.textContent = 'Creating…';
    const folderId = opts && opts.folderId ? opts.folderId : null;
    const folder = folderId ? this.folders.find((f) => f.id === folderId) : null;
    const cwd = folder
      ? inferCwdForFolder({
          folderName: folder.name,
          siblingCwds: siblingCwdsForFolder(folder, this.agents),
        })
      : '';
    try {
      const created = await api.createAgent({
        ...(opts && opts.name ? { name: opts.name } : {}),
        ...(cwd ? { cwd } : {}),
        ...(folderId ? { folderId } : {}),
      }) as Agent;
      if (folderId) {
        saveLastFolderId(folderId);
        this._setActiveFolder(folderId);
      } else {
        this._setActiveFolder(TOP_LEVEL_ID);
      }
      if (typeof this.onCreate === 'function') this.onCreate(created);
      await this.refresh();
      await this.refreshFolders();
      this.renderList();
      if (created && created.id) this.select(created.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to spawn agent';
      this.error.textContent = msg;
      this.error.hidden = false;
    } finally {
      this._creating = false;
      this.newBtn.disabled = false;
      this.newBtn.textContent = prevLabel;
    }
  }

  private _forkCandidates(folderItems: Agent[]): Agent[] {
    const inFolder = folderItems.filter((a) => !a.archived);
    if (inFolder.length > 0) return inFolder;
    return this.agents.filter((a) => !a.archived);
  }

  forkIntoFolder(folderId: string | null, folderItems: Agent[]): void {
    const candidates = this._forkCandidates(folderItems);
    const autoId = pickForkSourceId({
      folderAgentIds: folderItems.filter((a) => !a.archived).map((a) => a.id),
      selectedId: this.selectedId,
      fallbackIds: candidates.map((a) => a.id),
    });
    if (autoId) {
      void this._forkAgent(autoId, folderId);
      return;
    }
    const folderLabel = folderId
      ? (this.folders.find((f) => f.id === folderId)?.name || 'folder')
      : 'top level';
    openForkChatDialog({
      agents: candidates,
      folderLabel,
      selectedId: this.selectedId,
      onSubmit: (sourceId) => { void this._forkAgent(sourceId, folderId); },
    });
  }

  async _forkAgent(sourceId: string, folderId: string | null): Promise<void> {
    if (this._creating) return;
    this._creating = true;
    this.error.hidden = true;
    try {
      const created = await api.fork(sourceId, { folderId }) as Agent;
      if (folderId) {
        saveLastFolderId(folderId);
        this._setActiveFolder(folderId);
      } else {
        this._setActiveFolder(TOP_LEVEL_ID);
      }
      if (typeof this.onCreate === 'function') this.onCreate(created);
      await this.refresh();
      await this.refreshFolders();
      this.renderList();
      if (created && created.id) this.select(created.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to fork';
      this.error.textContent = msg;
      this.error.hidden = false;
    } finally {
      this._creating = false;
    }
  }

  async promptNewFolder(): Promise<void> {
    const name = window.prompt('New folder name:');
    if (!name || !name.trim()) return;
    try {
      await api.folders.create(name.trim());
      await this.refreshFolders();
      this.renderList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`create folder failed: ${msg}`);
    }
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    void this._boot();
    this.startPolling();
    if (!this._spawnHandlerWired) {
      document.addEventListener('grok-remote:spawn-agent', () => this.openNewChat());
      document.addEventListener('grok-remote:agent-working', (ev: Event) => {
        const d = (ev as CustomEvent).detail || {};
        this.markAgentWorking(String(d.id || ''), !!d.working);
      });
      document.addEventListener('grok-remote:agent-tokens', (ev: Event) => {
        const d = (ev as CustomEvent).detail || {};
        if (!d.id || typeof d.totalTokens !== 'number') return;
        this.applyTokenCount(String(d.id), d.totalTokens);
      });
      document.addEventListener('grok-remote:open-drawer', () => {
        if (!this._bootReady) return;
        this.renderList();
        requestAnimationFrame(() => this.renderList());
      });
      this._spawnHandlerWired = true;
    }
  }

  private async _boot(): Promise<void> {
    try {
      await Promise.all([this.refresh(), this.refreshFolders()]);
    } finally {
      this._bootReady = true;
      this.renderList();
      // Split.js sizes the pane after mount; paint again once it has a height.
      requestAnimationFrame(() => this.renderList());
      this._startSseStream();
    }
  }

  private _startSseStream(): void {
    if (this._agentsStream) return;
    try {
      const es = new EventSource(api.agentsStreamUrl());
      this._agentsStream = es;
      es.addEventListener('open', () => {
        this._sseAlive = true;
        // Snapshot can be missed on iPad reconnect; pull Idle/Running from GET.
        void this.refresh();
      });
      es.addEventListener('agents_snapshot', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data);
          if (d && Array.isArray(d.agents)) {
            this._setAgents(d.agents);
            if (this._bootReady) this.renderList();
            document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
          }
        } catch { /* ignore */ }
      });
      const onMutation = (): void => { void this.refresh(); };
      es.addEventListener('agent_added',   onMutation);
      es.addEventListener('agent_removed', onMutation);
      es.addEventListener('agent_updated', onMutation);
      es.addEventListener('folders_changed', () => { void this.refreshFolders().then(() => this.renderList()); });
      const patchAgent = (id: string, patch: Partial<Agent>): void => {
        const idx = this._agentsRaw.findIndex((a) => a && a.id === id);
        if (idx < 0) { void this.refresh(); return; }
        this._agentsRaw[idx] = { ...this._agentsRaw[idx]!, ...patch };
        this.agents = this._applyWorkingOverlay(this._agentsRaw);
        this._scheduleRenderList();
        document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
      };
      es.addEventListener('agent_status', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data) as { id?: string; status?: unknown; turnOpen?: unknown; inFlight?: unknown };
          if (!d || !d.id || d.status == null) return;
          const patch: Partial<Agent> = { status: String(d.status) };
          if (typeof d.turnOpen === 'boolean') patch.turnOpen = d.turnOpen;
          if (typeof d.inFlight === 'number') patch.inFlight = d.inFlight;
          patchAgent(d.id, patch);
        } catch { /* ignore */ }
      });
      es.addEventListener('agent_tokens', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data) as { id?: string; totalTokens?: unknown };
          if (!d || !d.id || typeof d.totalTokens !== 'number') return;
          patchAgent(d.id, { totalTokens: d.totalTokens });
        } catch { /* ignore */ }
      });
      es.addEventListener('agent_inflight', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data) as { id?: string; inFlight?: unknown };
          if (!d || !d.id || typeof d.inFlight !== 'number') return;
          patchAgent(d.id, { inFlight: d.inFlight });
        } catch { /* ignore */ }
      });
      es.addEventListener('error', () => { this._sseAlive = false; });
    } catch {
      this._agentsStream = null;
    }
  }

  private _stopSseStream(): void {
    if (this._agentsStream) {
      try { this._agentsStream.close(); } catch { /* ignore */ }
      this._agentsStream = null;
    }
  }

  startPolling(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    this.pollHandle = setInterval(() => {
      if (document.hidden) return;
      // SSE patches can miss the Idle event after a hold recreate, then
      // skip polling forever while the row stays Running.
      if (this._sseAlive) {
        const stuck = this.agents.some((a) => a && sidebarDisplayStatus(a) === 'running');
        if (!stuck) return;
      }
      void this.refresh();
    }, 4000);
    if (!this._onVisibility) {
      this._onVisibility = (): void => {
        if (!document.hidden) void this.refresh();
      };
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
      this._onVisibility = undefined;
    }
    this._stopSseStream();
  }

  _applyWorkingOverlay(agents: Agent[]): Agent[] {
    if (!this._workingUntil.size) return agents;
    const now = Date.now();
    for (const [id, until] of [...this._workingUntil.entries()]) {
      if (until <= now) this._workingUntil.delete(id);
    }
    if (!this._workingUntil.size) return agents;
    return agents.map((a) => {
      if (!a) return a;
      return applyWorkingOverlayRow(a, this._workingUntil.get(a.id), now);
    });
  }

  private _setAgents(agents: Agent[]): void {
    this._agentsRaw = Array.isArray(agents) ? agents : [];
    this.agents = this._applyWorkingOverlay(this._agentsRaw);
  }

  applyTokenCount(id: string, totalTokens: number): void {
    if (!id || typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) return;
    const idx = this._agentsRaw.findIndex((a) => a && a.id === id);
    if (idx < 0) return;
    if (this._agentsRaw[idx]!.totalTokens === totalTokens) return;
    this._agentsRaw[idx] = { ...this._agentsRaw[idx]!, totalTokens };
    this.agents = this._applyWorkingOverlay(this._agentsRaw);
    this._scheduleRenderList();
  }

  markAgentWorking(id: string, working: boolean): void {
    if (!id) return;
    if (working) this._workingUntil.set(id, Date.now() + LOCAL_TURN_HOLD_MS);
    else this._workingUntil.delete(id);
    this.agents = this._applyWorkingOverlay(this._agentsRaw);
    this.renderList();
    document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
  }

  async refresh(): Promise<void> {
    try {
      const data = await api.listAgents();
      const agents: Agent[] = Array.isArray(data)
        ? data as Agent[]
        : (data && typeof data === 'object' && Array.isArray((data as { agents?: unknown }).agents)
            ? (data as { agents: Agent[] }).agents
            : []);
      this._setAgents(agents);
      if (this._bootReady) this.renderList();
      document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh', { detail: this.agents }));
    } catch (e) {
      this._setAgents([]);
      const msg = e instanceof Error ? e.message : String(e);
      if (this._bootReady) this.renderList(msg);
    }
  }

  async refreshFolders(): Promise<void> {
    try {
      const data = await api.folders.list() as unknown;
      this.folders = Array.isArray(data) ? data as Folder[] : [];
    } catch {
      this.folders = [];
    }
    if (this._bootReady) this.renderList();
  }

  private _renderListRaf = 0;
  private _scheduleRenderList(): void {
    if (this._renderListRaf) return;
    this._renderListRaf = requestAnimationFrame(() => {
      this._renderListRaf = 0;
      this.renderList();
    }) as unknown as number;
  }

  renderList(errorMessage?: string): void {
    this._closeContextMenu();
    // If an SSE-triggered re-render lands mid-drag, kill the drag so we don't
    // leave a ghost stranded against a recycled source element.
    if (this._drag) this._cancelDrag();
    this.activeList.replaceChildren();
    this.activeList.classList.remove('agents-list--split');
    if (this.searchClearBtn) this.searchClearBtn.hidden = !this.search;
    // Drop stale ids from multi-selection so the footer count stays accurate.
    if (this.multiSelection.size > 0) {
      const liveIds = new Set(this.agents.map((a) => a.id));
      const before = this.multiSelection.size;
      for (const id of [...this.multiSelection]) {
        if (!liveIds.has(id)) this.multiSelection.delete(id);
      }
      if (before !== this.multiSelection.size && this.selectionAnchor && !liveIds.has(this.selectionAnchor)) {
        this.selectionAnchor = null;
      }
    }
    this._updateMultiFooter();

    if (errorMessage) {
      this.activeList.appendChild(el('div', { class: 'agents-empty agents-empty--err' },
        'Backend unreachable'));
      return;
    }

    if (!this.agents.length && this.folders.length === 0) {
      this.activeList.appendChild(this.empty);
      return;
    }

    const chatsByFolder = new Map<string, Agent[]>();
    const topLevelAll: Agent[] = [];
    for (const a of this.agents) {
      const fid = this._folderIdForAgent(a.id);
      if (fid === TOP_LEVEL_ID) topLevelAll.push(a);
      else {
        if (!chatsByFolder.has(fid)) chatsByFolder.set(fid, []);
        chatsByFolder.get(fid)!.push(a);
      }
    }

    const activityById = new Map<string, string>();
    const liveById = new Map<string, number>();
    for (const f of this.folders) {
      const chats = chatsByFolder.get(f.id) || [];
      activityById.set(f.id, folderActivity(chats));
      const live = projectLiveWork(chats);
      liveById.set(f.id, live.running + live.starting);
    }
    const ordered = sortProjects(this.folders, activityById, liveById);
    const hasTopLevel = topLevelAll.length > 0;
    if (hasTopLevel) activityById.set(TOP_LEVEL_ID, folderActivity(topLevelAll));

    const selectedFolderId = this.selectedId ? this._folderIdForAgent(this.selectedId) : undefined;
    this.activeFolderId = resolveActiveFolderId({
      saved: this.activeFolderId,
      folderIds: ordered.map((f) => f.id),
      hasTopLevel,
      selectedFolderId: selectedFolderId === undefined
        ? undefined
        : (selectedFolderId === TOP_LEVEL_ID ? null : selectedFolderId),
    });
    saveActiveFolderId(this.activeFolderId);

    const projectEntries: Array<{ id: string; name: string; count: number; folder: Folder | null }> = [];
    if (hasTopLevel) {
      projectEntries.push({
        id: TOP_LEVEL_ID,
        name: SIDEBAR_COPY.topLevel,
        count: topLevelAll.length,
        folder: null,
      });
    }
    for (const f of ordered) {
      projectEntries.push({
        id: f.id,
        name: f.name,
        count: (chatsByFolder.get(f.id) || []).length,
        folder: f,
      });
    }

    const visibleProjects = projectEntries.filter((p) => {
      const inFolder = p.id === TOP_LEVEL_ID ? topLevelAll : (chatsByFolder.get(p.id) || []);
      const chatMatchCount = this.search
        ? inFolder.filter((a) => this._matchesSearch(a)).length
        : inFolder.length;
      return projectMatchesSearch({ name: p.name, search: this.search, chatMatchCount });
    });
    if (visibleProjects.every((p) => p.id !== this.activeFolderId)) {
      const active = projectEntries.find((p) => p.id === this.activeFolderId);
      if (active) visibleProjects.unshift(active);
    }

    this.activeList.classList.add('agents-list--split');
    const navList = el('div', { class: 'project-nav__list' }) as HTMLElement;
    for (const p of visibleProjects) {
      const chats = p.id === TOP_LEVEL_ID ? topLevelAll : (chatsByFolder.get(p.id) || []);
      navList.appendChild(this.renderProjectRow(p.id, p.name, p.count, p.folder, chats));
    }
    if (!visibleProjects.length) {
      navList.appendChild(el('div', { class: 'folder-empty' }, SIDEBAR_COPY.noMatch));
    }

    this.activeList.appendChild(el('div', { class: 'project-nav' },
      el('div', { class: 'project-nav__label' }, SIDEBAR_COPY.projects),
      navList,
    ));
    this.activeList.appendChild(this.renderChatPane());
  }

  private renderProjectRow(
    id: string,
    name: string,
    count: number,
    folder: Folder | null,
    chats: Agent[],
  ): HTMLElement {
    const isActive = id === this.activeFolderId;
    const isSystem = !!(folder && folder.system);
    const live = projectLiveWork(chats);
    const liveN = live.running + live.starting;
    const liveKind = live.running > 0 ? 'running' : (live.starting > 0 ? 'starting' : '');
    const nameEl = el('span', { class: 'project-row__name' }, name);
    const liveTitle = live.running > 0
      ? `${name} — ${live.running} running`
      : (live.starting > 0 ? `${name} — starting` : name);
    const children: Array<HTMLElement | string | null> = [];
    if (liveKind) {
      children.push(el('span', {
        class: `project-row__dot agent-dot agent-dot--${liveKind}`,
        title: liveTitle,
      }));
    }
    children.push(nameEl);
    if (liveN > 1) {
      children.push(el('span', {
        class: `project-row__live project-row__live--${liveKind}`,
        title: liveTitle,
      }, String(liveN)));
    }
    children.push(el('span', { class: 'project-row__count' }, String(count)));
    const row = el('button', {
      class: [
        'project-row',
        isActive ? 'project-row--active' : '',
        isSystem ? 'project-row--system' : '',
        liveKind ? `project-row--${liveKind}` : '',
      ].filter(Boolean).join(' '),
      type: 'button',
      'data-folder-id': id,
      title: liveTitle,
      onclick: () => {
        this._setActiveFolder(id);
        this.renderList();
      },
      ondblclick: (ev: MouseEvent) => {
        if (!folder || isSystem) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.beginInlineRenameFolder(folder, nameEl as HTMLElement);
      },
    }, ...children) as HTMLElement;
    return row;
  }

  private renderChatPane(): HTMLElement {
    const isTopLevel = this.activeFolderId === TOP_LEVEL_ID;
    const folder = isTopLevel ? null : (this.folders.find((f) => f.id === this.activeFolderId) || null);
    const isArchived = this.activeFolderId === ARCHIVED_FOLDER_ID;
    const isSystem = !!(folder && folder.system);
    const label = this._projectLabel(this.activeFolderId);
    const items = this._chatsForActivePane();
    const folderId = isTopLevel ? null : this.activeFolderId;

    const actions = el('div', { class: 'folder-actions' }) as HTMLElement;
    if (!isArchived) {
      actions.appendChild(el('button', {
        class: 'folder-action folder-action--new',
        type: 'button',
        title: isTopLevel ? 'New chat at top level' : `New chat in ${label}`,
        onclick: () => { void this.spawnNew({ folderId }); },
      }, SIDEBAR_COPY.folderNew) as HTMLButtonElement);
      actions.appendChild(el('button', {
        class: 'folder-action folder-action--fork',
        type: 'button',
        title: isTopLevel ? 'Fork a chat into top level' : `Fork a chat into ${label}`,
        onclick: () => {
          const allIn = this.agents.filter((a) => this._folderIdForAgent(a.id) === this.activeFolderId);
          this.forkIntoFolder(folderId, allIn);
        },
      }, SIDEBAR_COPY.folderFork) as HTMLButtonElement);
    }
    if (!isTopLevel && !isSystem && folder) {
      actions.appendChild(el('button', {
        class: 'folder-delete',
        type: 'button',
        title: 'Delete folder (agents move back to top level)',
        onclick: async () => {
          if (!confirm(`Delete folder "${label}"?\nIts agents move back to the top level.`)) return;
          try {
            await api.folders.remove(folder.id);
            this._setActiveFolder(TOP_LEVEL_ID);
            await this.refreshFolders();
            this.renderList();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`Delete folder failed: ${msg}`);
          }
        },
      }, '×') as HTMLButtonElement);
    }

    const cwds = Array.from(new Set(items.map((a) => String(a.cwd || '').trim()).filter(Boolean)));
    const pathText = cwds.length === 1 ? cwds[0] : '';
    const countText = `${items.length} chat${items.length === 1 ? '' : 's'}`;
    const head = el('div', { class: 'project-chats__head' },
      el('div', { class: 'project-chats__id' },
        el('span', { class: 'project-chats__title' }, label),
        el('div', { class: 'project-chats__sub' },
          pathText ? el('span', { class: 'project-chats__path', title: pathText }, pathText) : null,
          el('span', { class: 'project-chats__count' }, countText),
        ),
      ),
      actions,
    ) as HTMLElement;

    const list = el('div', { class: 'project-chats__list' }) as HTMLElement;
    if (!items.length) {
      list.appendChild(el('div', { class: 'folder-empty' },
        this.search ? SIDEBAR_COPY.noMatch
          : (isTopLevel ? SIDEBAR_COPY.emptyTop : SIDEBAR_COPY.emptyFolder)));
      if (!isArchived && !this.search) {
        list.appendChild(this.renderFolderHandle(folderId, label, items));
      }
    } else {
      for (const a of items) list.appendChild(this.renderItem(a, isArchived));
    }

    return el('div', { class: 'project-chats' }, head, list) as HTMLElement;
  }

  private renderFolderHandle(folderId: string | null, label: string, items: Agent[]): HTMLElement {
    const newBtn = el('button', {
      class: 'folder-handle__btn folder-handle__btn--new',
      type: 'button',
      title: folderId ? `New chat in ${label}` : 'New chat at top level',
      onclick: (ev: MouseEvent) => {
        ev.stopPropagation();
        void this.spawnNew({ folderId });
      },
    }, SIDEBAR_COPY.handleNew) as HTMLButtonElement;
    const forkBtn = el('button', {
      class: 'folder-handle__btn folder-handle__btn--fork',
      type: 'button',
      title: folderId ? `Fork a chat into ${label}` : 'Fork a chat to top level',
      onclick: (ev: MouseEvent) => {
        ev.stopPropagation();
        this.forkIntoFolder(folderId, items);
      },
    }, SIDEBAR_COPY.handleFork) as HTMLButtonElement;
    return el('div', { class: 'folder-handle' }, newBtn, forkBtn) as HTMLElement;
  }

  private beginInlineRenameFolder(folder: Folder, labelEl: HTMLElement): void {
    const parent = labelEl.parentElement;
    if (!parent) return;
    const input = el('input', {
      class: 'folder-rename-input',
      type: 'text',
      value: folder.name,
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); (input as HTMLInputElement).value = folder.name; (ev.target as HTMLInputElement).blur(); }
      },
      onblur: async (ev: FocusEvent) => {
        const next = ((ev.target as HTMLInputElement).value || '').trim();
        if (!next || next === folder.name) { this.renderList(); return; }
        try {
          await api.folders.update(folder.id, { name: next });
          await this.refreshFolders();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`Rename folder failed: ${msg}`);
        }
        this.renderList();
      },
    }) as HTMLInputElement;
    parent.replaceChild(input, labelEl);
    input.focus();
    input.select();
  }

  private beginInlineRenameAgent(a: Agent, nameEl: HTMLElement): void {
    const parent = nameEl.parentElement;
    if (!parent) return;
    const input = el('input', {
      class: 'agent-rename-input',
      type: 'text',
      value: a.name || '',
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); (ev.target as HTMLInputElement).blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); (input as HTMLInputElement).value = a.name || ''; (input as HTMLInputElement).dataset['cancel'] = '1'; (ev.target as HTMLInputElement).blur(); }
      },
      onblur: async (ev: FocusEvent) => {
        const target = ev.target as HTMLInputElement;
        const cancel = target.dataset['cancel'] === '1';
        const next = (target.value || '').trim();
        if (cancel || !next || next === a.name) { this.renderList(); return; }
        try {
          await api.updateAgent(a.id, { name: next });
          await this.refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`rename failed: ${msg}`);
          this.renderList();
        }
      },
    }) as HTMLInputElement;
    parent.replaceChild(input, nameEl);
    input.focus();
    input.select();
  }

  renderItem(a: Agent, isArchived: boolean): HTMLElement {
    const isSelected = a.id === this.selectedId;
    const status = sidebarDisplayStatus(a);
    const isDisconnected = status === 'disconnected' || status === 'exited';
    const dot = el('span', { class: `agent-dot agent-dot--${status}` });

    const starBtn = el('button', {
      class: `agent-star agent-row-action${a.starred ? ' is-on' : ''}`,
      title: a.starred ? 'Unstar' : 'Star',
      type: 'button',
      onclick: async (ev: MouseEvent) => {
        ev.stopPropagation();
        starBtn.disabled = true;
        try {
          await api.updateAgent(a.id, { starred: !a.starred });
          await this.refresh();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`Star failed: ${msg}`);
        } finally {
          starBtn.disabled = false;
        }
      },
    }, a.starred ? '★' : '☆') as HTMLButtonElement;

    const nameEl = el('span', {
      class: 'agent-name',
      ondblclick: (ev: MouseEvent) => {
        if (isArchived) return;
        ev.preventDefault();
        ev.stopPropagation();
        this.beginInlineRenameAgent(a, nameEl as HTMLElement);
      },
    }, a.name || a.id.slice(0, 8)) as HTMLElement;

    const moreBtn = el('button', {
      class: 'agent-more agent-row-action',
      type: 'button',
      title: SIDEBAR_COPY.more,
      'aria-label': SIDEBAR_COPY.more,
      onclick: (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        const r = moreBtn.getBoundingClientRect();
        this._showContextMenu(a, r.right - 4, r.bottom + 4);
      },
    }, '⋯') as HTMLButtonElement;

    let closeArea: HTMLElement | null;
    if (!isArchived) {
      closeArea = moreBtn;
    } else {
      const restoreBtn = el('button', {
        class: 'agent-restore agent-row-action',
        type: 'button',
        title: 'Restore from archive',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          restoreBtn.disabled = true;
          try {
            await api.updateAgent(a.id, { archived: false });
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`Restore failed: ${msg}`);
          } finally {
            restoreBtn.disabled = false;
          }
        },
      }, 'Restore') as HTMLButtonElement;
      const deleteBtn = el('button', {
        class: 'agent-delete-forever agent-row-action',
        type: 'button',
        title: 'Delete forever (removes history and uploads)',
        onclick: async (ev: MouseEvent) => {
          ev.stopPropagation();
          if (!confirm(`Delete "${a.name || a.id}" forever?\nThis removes its history and uploaded files. Cannot be undone.`)) return;
          try {
            await api.deleteAgent(a.id);
            if (typeof this.onDelete === 'function') this.onDelete(a.id);
            if (this.selectedId === a.id) this.selectedId = null;
            await this.refresh();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`Delete failed: ${msg}`);
          }
        },
      }, 'Delete') as HTMLButtonElement;
      closeArea = el('div', { class: 'agent-archived-actions' }, restoreBtn, deleteBtn, moreBtn) as HTMLElement;
    }

    const statusText = rowStatusLabel(status);
    const metaChildren: (HTMLElement | null)[] = [];
    if (statusText) {
      metaChildren.push(el('span', { class: `agent-status agent-status--${rowStatusKey(status)}` }, statusText));
    }
    if (typeof a.inFlight === 'number' && a.inFlight > 0) {
      metaChildren.push(el('span', {
        class: 'agent-inflight',
        title: `${a.inFlight} tool call${a.inFlight === 1 ? '' : 's'} in flight`,
      },
        el('span', { class: 'agent-inflight-dot' }),
        `${a.inFlight} tool${a.inFlight === 1 ? '' : 's'}`,
      ));
    }
    if (typeof a.totalTokens === 'number' && a.totalTokens > 0) {
      metaChildren.push(el('span', {
        class: 'agent-tokens',
        title: `${a.totalTokens.toLocaleString()} tokens in context`,
      }, fmtTokens(a.totalTokens)));
    }

    const isMulti = this.multiSelection.has(a.id);
    const item = el('div', {
      class: [
        'agent-item',
        isSelected     ? 'agent-item--selected' : '',
        isMulti        ? 'agent-item--multi' : '',
        isDisconnected ? 'agent-item--off' : '',
        isArchived     ? 'agent-item--archived' : '',
        a.starred      ? 'agent-item--starred' : '',
      ].filter(Boolean).join(' '),
      'data-agent-id': a.id,
      oncontextmenu: (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._showContextMenu(a, ev.clientX, ev.clientY);
      },
    },
      el('div', { class: 'agent-item-top' },
        dot,
        starBtn,
        nameEl,
        closeArea,
      ),
      metaChildren.length ? el('div', { class: 'agent-item-meta' }, ...metaChildren) : null,
    ) as HTMLElement;

    // Treat genuinely-archived agents as non-draggable regardless of the
    // legacy parameter (the folder system handles archived now).
    const treatAsArchived = isArchived || !!a.archived;
    this._attachDragHandlers(item, a, treatAsArchived);
    return item;
  }

  // Pointer-events drag/drop. Mouse/pen drag activates as soon as horizontal
  // motion crosses MOUSE_DRAG_THRESH; touch uses a long-press so vertical
  // scroll still works. We do NOT setPointerCapture until drag actually
  // activates: capturing on pointerdown was breaking the row's own click-to-
  // select because pointer capture redirects subsequent events away from any
  // ancestor click target until release.
  private _attachDragHandlers(item: HTMLElement, agent: Agent, isArchived: boolean): void {
    const agentId = agent.id;

    const onPointerDown = (ev: PointerEvent): void => {
      const target = ev.target as HTMLElement | null;
      const tgtTag = target ? `${target.tagName.toLowerCase()}.${target.className || ''}` : '(none)';
      const matchedAction = target?.closest('.agent-row-action, input, select, textarea')?.tagName || null;
      console.debug(`[drag] pointerdown id=${agentId} button=${ev.button} type=${ev.pointerType} target=${tgtTag} actionMatch=${matchedAction}`);
      if (ev.button !== undefined && ev.button !== 0) {
        console.debug(`[drag] press-skipped reason=not-primary-button button=${ev.button}`);
        return;
      }
      // Only the explicit action buttons (star, archive, restore, delete-forever)
      // and any input/select inside the row (rename) opt out of drag. The rest
      // of the row body, including the name text, should drag freely.
      if (target && target.closest('.agent-row-action, input, select, textarea')) {
        console.debug(`[drag] press-skipped reason=action-or-form-field match=${matchedAction}`);
        return;
      }
      this._cancelDrag();
      const drag = {
        agentId,
        pointerId: ev.pointerId,
        pointerType: ev.pointerType || 'mouse',
        startX: ev.clientX,
        startY: ev.clientY,
        startTime: performance.now(),
        sourceEl: item,
        ghost: null as HTMLElement | null,
        active: false,
        captured: false,
        pressTimer: null as number | null,
        moved: false,
      };
      this._drag = drag;
      if (isArchived) {
        // Archived rows don't drag (drop targets are non-archived folders),
        // but we still want click-to-select to work via pointerup below.
        return;
      }
      if (drag.pointerType === 'touch') {
        // Touch: wait for the long-press; mouse skips the timer entirely so
        // click-and-drag feels immediate.
        drag.pressTimer = window.setTimeout(() => {
          if (this._drag === drag) this._activateDrag(drag.startX, drag.startY);
        }, LONG_PRESS_MS);
      }
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      const moved = Math.hypot(dx, dy);
      if (!drag.active) {
        if (isArchived) {
          if (moved > MOUSE_DRAG_THRESH) drag.moved = true;
          return;
        }
        if (drag.pointerType === 'touch') {
          if (moved > TOUCH_MOVE_THRESH) {
            console.debug(`[drag] cancel reason=touch-scroll-intent moved=${moved.toFixed(1)}`);
            this._cancelDrag();
          }
          return;
        }
        if (Math.abs(dx) >= MOUSE_DRAG_THRESH || moved >= MOUSE_DRAG_THRESH * 2) {
          drag.moved = true;
          console.debug(`[drag] activate id=${drag.agentId} startX=${drag.startX} startY=${drag.startY} dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
          this._activateDrag(ev.clientX, ev.clientY);
        }
        return;
      }
      ev.preventDefault();
      this._moveGhost(ev.clientX, ev.clientY);
      this._highlightDropTarget(ev.clientX, ev.clientY);
    };

    const onPointerUp = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      if (drag.captured) {
        try { item.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      }
      if (drag.active) {
        const target = this._findDropTarget(ev.clientX, ev.clientY);
        console.debug(`[drag] up dropOn=${target} id=${drag.agentId}`);
        this._endDrag();
        if (target) void this._assignAgentToFolder(drag.agentId, target);
        return;
      }
      const dt = performance.now() - drag.startTime;
      const dx = Math.abs(ev.clientX - drag.startX);
      const dy = Math.abs(ev.clientY - drag.startY);
      this._cancelDrag();
      const isClick = dt < CLICK_MAX_MS * 4
        && dx < MOUSE_DRAG_THRESH
        && dy < MOUSE_DRAG_THRESH;
      if (isClick) {
        const tgt = ev.target as HTMLElement | null;
        if (tgt && tgt.closest('.agent-row-action, input, select, textarea')) {
          console.debug(`[drag] click-skipped reason=action-control`);
          return;
        }
        console.debug(`[drag] click-select id=${agentId} dt=${dt.toFixed(0)}ms`);
        this._handleRowClick(agentId, ev);
      }
    };

    const onPointerCancel = (ev: PointerEvent): void => {
      const drag = this._drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      console.debug(`[drag] cancel reason=pointercancel id=${drag.agentId}`);
      this._cancelDrag();
    };

    item.addEventListener('pointerdown', onPointerDown);
    item.addEventListener('pointermove', onPointerMove);
    item.addEventListener('pointerup', onPointerUp);
    item.addEventListener('pointercancel', onPointerCancel);
  }

  private _activateDrag(clientX: number, clientY: number): void {
    const drag = this._drag;
    if (!drag || drag.active) return;
    drag.active = true;
    if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
    // Capture only now. Capturing on pointerdown was breaking taps because
    // the captured pointer's events bypass the row's click semantics.
    try {
      drag.sourceEl.setPointerCapture(drag.pointerId);
      drag.captured = true;
    } catch { /* ignore */ }
    const rect = drag.sourceEl.getBoundingClientRect();
    const ghost = drag.sourceEl.cloneNode(true) as HTMLElement;
    ghost.classList.add('agent-drag-ghost');
    ghost.style.position = 'fixed';
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '9999';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.sourceEl.classList.add('agent-item--dragging');
    document.body.classList.add('agents-dragging');
    this._moveGhost(clientX, clientY);
    this._highlightDropTarget(clientX, clientY);
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch { /* ignore */ } }
  }

  private _moveGhost(clientX: number, clientY: number): void {
    const drag = this._drag;
    if (!drag || !drag.ghost) return;
    const rect = drag.sourceEl.getBoundingClientRect();
    const offsetX = drag.startX - rect.left;
    const offsetY = drag.startY - rect.top;
    drag.ghost.style.left = `${clientX - offsetX}px`;
    drag.ghost.style.top  = `${clientY - offsetY}px`;
  }

  private _highlightDropTarget(clientX: number, clientY: number): void {
    const all = this.activeList.querySelectorAll<HTMLElement>('.project-row');
    let hit: HTMLElement | null = null;
    for (const h of all) {
      const r = h.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        hit = h;
        break;
      }
    }
    for (const h of all) h.classList.toggle('project-row--drop', h === hit);
  }

  private _findDropTarget(clientX: number, clientY: number): string | null {
    const all = this.activeList.querySelectorAll<HTMLElement>('.project-row');
    for (const h of all) {
      const r = h.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return h.getAttribute('data-folder-id');
      }
    }
    return null;
  }

  private _endDrag(): void {
    const drag = this._drag;
    if (!drag) return;
    if (drag.pressTimer) { clearTimeout(drag.pressTimer); drag.pressTimer = null; }
    if (drag.captured) {
      try { drag.sourceEl.releasePointerCapture(drag.pointerId); } catch { /* ignore */ }
    }
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    drag.sourceEl.classList.remove('agent-item--dragging');
    document.body.classList.remove('agents-dragging');
    this.activeList.querySelectorAll('.project-row--drop').forEach((n) => n.classList.remove('project-row--drop'));
    this._drag = null;
  }

  private _cancelDrag(): void {
    if (!this._drag) return;
    this._endDrag();
  }

  private async _assignAgentToFolder(agentId: string, groupId: string): Promise<void> {
    const folderId = groupId === TOP_LEVEL_ID ? null : groupId;
    console.debug(`[drag] assign id=${agentId} folder=${folderId}`);
    try {
      await api.agents.setFolder(agentId, folderId);
      console.debug(`[drag] assign-ok id=${agentId} folder=${folderId}`);
      this._setActiveFolder(groupId);
      await this.refreshFolders();
      this.renderList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.debug(`[drag] assign-fail id=${agentId} folder=${folderId} err=${msg}`);
      alert(`move failed: ${msg}`);
    }
  }

  select(id: string): void {
    this.selectedId = id;
    this._setActiveFolder(this._folderIdForAgent(id));
    this.renderList();
    document.dispatchEvent(new CustomEvent('grok-remote:close-drawer'));
    if (typeof this.onSelect === 'function') this.onSelect(id);
  }

  private _handleRowClick(agentId: string, ev: PointerEvent | MouseEvent): void {
    const modified = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    if (!modified) {
      // Plain click: clear any multi-selection, then navigate.
      if (this.multiSelection.size > 0) {
        this.multiSelection = new Set();
      }
      this.selectionAnchor = agentId;
      this.select(agentId);
      return;
    }
    // Modifier click: extend/toggle multi-selection without navigating.
    const order = this._visibleOrderedIds();
    const seed = this.multiSelection.size > 0
      ? this.multiSelection
      : (this.selectedId ? new Set([this.selectedId]) : new Set<string>());
    const { next, anchor } = computeSelection(
      seed,
      this.selectionAnchor || this.selectedId,
      agentId,
      { ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, shiftKey: ev.shiftKey },
      order,
    );
    this.multiSelection = next;
    this.selectionAnchor = anchor;
    // If the user collapsed back to exactly one row, treat it like a normal
    // selection so the chat opens it.
    if (this.multiSelection.size === 1) {
      const only = [...this.multiSelection][0]!;
      this.multiSelection = new Set();
      this.selectedId = only;
      this.renderList();
      if (typeof this.onSelect === 'function') this.onSelect(only);
      return;
    }
    this.renderList();
  }

  private _showContextMenu(a: Agent, clientX: number, clientY: number): void {
    this._closeContextMenu();

    // Decide whether this menu acts on a single row or the multi-selection.
    // Right-clicking outside the current multi-selection clears it and acts
    // on the single clicked row, matching every familiar file manager.
    let targetIds: string[];
    if (this.multiSelection.size > 1 && this.multiSelection.has(a.id)) {
      targetIds = [...this.multiSelection];
    } else {
      if (this.multiSelection.size > 0) {
        this.multiSelection = new Set();
        this.renderList();
      }
      targetIds = [a.id];
    }
    const targetAgents = targetIds
      .map((id) => this.agents.find((x) => x.id === id))
      .filter((x): x is Agent => !!x);
    const bulk = targetAgents.length > 1;

    const items: HTMLElement[] = [];

    const mkItem = (label: string, run: () => void, opts?: { danger?: boolean }): HTMLElement => {
      const btn = el('button', {
        class: `ctx-menu__item${opts && opts.danger ? ' ctx-menu__danger' : ''}`,
        type: 'button',
        onclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          this._closeContextMenu();
          run();
        },
      }, label) as HTMLElement;
      return btn;
    };

    const mkSep = (): HTMLElement => el('div', { class: 'ctx-menu__sep' }) as HTMLElement;

    // Majority-vote on the current starred / archived state so the action
    // label reads naturally for the bulk case ("Star all" if most aren't
    // already starred).
    const starredCount   = targetAgents.filter((x) => !!x.starred).length;
    const archivedCount  = targetAgents.filter((x) => !!x.archived).length;
    const majorityStarred  = starredCount  > targetAgents.length / 2;
    const majorityArchived = archivedCount > targetAgents.length / 2;

    const starLabel = bulk
      ? (majorityStarred ? `Unstar ${targetAgents.length}` : `Star ${targetAgents.length}`)
      : (a.starred ? 'Unstar' : 'Star');
    items.push(mkItem(starLabel, async () => {
      const nextStarred = bulk ? !majorityStarred : !a.starred;
      try {
        await Promise.all(targetAgents.map((x) => api.updateAgent(x.id, { starred: nextStarred })));
        await this.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`Star failed: ${msg}`);
      }
    }));

    if (!bulk) {
      items.push(mkItem('Rename', () => {
        const node = this.activeList.querySelector<HTMLElement>(
          `.agent-item[data-agent-id="${CSS.escape(a.id)}"] .agent-name`,
        );
        if (node) this.beginInlineRenameAgent(a, node);
      }));
      if (!a.archived) {
        items.push(mkItem('Fork', () => {
          let dest: string | null = null;
          for (const f of this.folders) {
            if (!f.system && f.agentIds.includes(a.id)) { dest = f.id; break; }
          }
          void this._forkAgent(a.id, dest);
        }));
      }
    }

    items.push(mkSep());

    // Move to folder. Inline the candidate folders right in the menu (a single
    // flat list keeps the implementation small + works fine on touch). System
    // folders (Archived) are excluded; "Archive" handles that case.
    const moveTargets = this.folders.filter((f) => !f.system);
    const currentFolder = (() => {
      // For single-row, indicate the folder the row currently lives in.
      if (bulk) return null;
      for (const f of this.folders) if (f.agentIds.includes(a.id)) return f.id;
      return null;
    })();

    if (moveTargets.length > 0 || currentFolder) {
      const heading = bulk ? `Move ${targetAgents.length} to` : 'Move to';
      items.push(el('div', { class: 'ctx-menu__heading' }, heading) as HTMLElement);
      items.push(mkItem(`(no folder)${!bulk && !currentFolder ? '  •' : ''}`, async () => {
        try {
          await Promise.all(targetAgents.map((x) => api.agents.setFolder(x.id, null)));
          await this.refreshFolders();
          this.renderList();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          alert(`move failed: ${msg}`);
        }
      }));
      for (const f of moveTargets) {
        const label = (!bulk && currentFolder === f.id) ? `${f.name}  •` : f.name;
        items.push(mkItem(label, async () => {
          try {
            await Promise.all(targetAgents.map((x) => api.agents.setFolder(x.id, f.id)));
            await this.refreshFolders();
            this.renderList();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            alert(`move failed: ${msg}`);
          }
        }));
      }
      items.push(mkSep());
    }

    const archiveLabel = bulk
      ? (majorityArchived ? `Unarchive ${targetAgents.length}` : `Archive ${targetAgents.length}`)
      : (a.archived ? 'Unarchive' : 'Archive');
    items.push(mkItem(archiveLabel, async () => {
      const nextArchived = bulk ? !majorityArchived : !a.archived;
      try {
        await Promise.all(targetAgents.map((x) => api.updateAgent(x.id, { archived: nextArchived })));
        if (nextArchived) {
          for (const x of targetAgents) {
            if (this.selectedId === x.id) this.selectedId = null;
          }
        }
        await this.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`Archive failed: ${msg}`);
      }
    }));

    if (!bulk) {
      items.push(mkItem('Copy ID', async () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(a.id);
          } else {
            const ta = document.createElement('textarea');
            ta.value = a.id;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* ignore */ }
            document.body.removeChild(ta);
          }
        } catch {
          alert('Copy failed');
        }
      }));
    }

    items.push(mkSep());

    const deleteLabel = bulk ? `Delete ${targetAgents.length}…` : 'Delete…';
    items.push(mkItem(deleteLabel, async () => {
      const prompt = bulk
        ? `Delete ${targetAgents.length} conversations?\nThis removes their history and uploaded files. Cannot be undone.`
        : `Delete "${a.name || a.id}" forever?\nThis removes its history and uploaded files. Cannot be undone.`;
      if (!confirm(prompt)) return;
      try {
        await Promise.all(targetAgents.map((x) => api.deleteAgent(x.id)));
        if (typeof this.onDelete === 'function') {
          for (const x of targetAgents) this.onDelete(x.id);
        }
        for (const x of targetAgents) {
          if (this.selectedId === x.id) this.selectedId = null;
        }
        if (bulk) this.multiSelection = new Set();
        await this.refresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`Delete failed: ${msg}`);
      }
    }, { danger: true }));

    const menu = el('div', {
      class: 'ctx-menu',
      role: 'menu',
      // Stop bubbling so the document-level dismiss listener does not fire
      // when clicking inside the menu itself.
      onclick: (ev: MouseEvent) => ev.stopPropagation(),
      oncontextmenu: (ev: MouseEvent) => { ev.preventDefault(); this._closeContextMenu(); },
    }, ...items) as HTMLElement;

    // Position offscreen first so we can measure and clamp.
    menu.style.position = 'fixed';
    menu.style.left = '-9999px';
    menu.style.top  = '-9999px';
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const margin = 6;
    const maxX = window.innerWidth  - rect.width  - margin;
    const maxY = window.innerHeight - rect.height - margin;
    const x = Math.max(margin, Math.min(clientX, maxX));
    const y = Math.max(margin, Math.min(clientY, maxY));
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
    this._ctxMenu = menu;

    const onDocPointerDown = (ev: PointerEvent): void => {
      const tgt = ev.target as Node | null;
      if (tgt && menu.contains(tgt)) return;
      this._closeContextMenu();
    };
    const onDocContextMenu = (ev: MouseEvent): void => {
      const tgt = ev.target as Node | null;
      if (tgt && menu.contains(tgt)) return;
      // Let a fresh contextmenu open the new one; just close this one now.
      this._closeContextMenu();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') { ev.preventDefault(); this._closeContextMenu(); }
    };
    // Fire on the *next* tick so the contextmenu event that opened us does
    // not immediately close it.
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('contextmenu', onDocContextMenu, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    this._ctxCleanup = () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('contextmenu', onDocContextMenu, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  private _closeContextMenu(): void {
    if (this._ctxCleanup) { try { this._ctxCleanup(); } catch { /* ignore */ } this._ctxCleanup = null; }
    if (this._ctxMenu && this._ctxMenu.parentNode) this._ctxMenu.parentNode.removeChild(this._ctxMenu);
    this._ctxMenu = null;
  }
}

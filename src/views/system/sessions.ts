// Sessions page.

import { api } from '../../lib/api.js';

interface SessionItem {
  sessionId: string;
  created?: string;
  status?: string;
  summary?: string;
}

interface SessionsState {
  q: string;
  limit: number;
  loading: boolean;
  error: string | null;
  raw: string;
  items: SessionItem[];
  agentIds: Set<string>;
  agentBySession: Map<string, string>;
  toast: string;
  toastTimer: number;
}

let activeContainer: HTMLElement | null = null;
let state: SessionsState = freshState();

function freshState(): SessionsState {
  return {
    q: '',
    limit: 20,
    loading: false,
    error: null,
    raw: '',
    items: [],
    agentIds: new Set(),
    agentBySession: new Map(),
    toast: '',
    toastTimer: 0,
  };
}

export function mount(container: HTMLElement): void {
  activeContainer = container;
  state = freshState();
  render();
  void loadAgents();
  void load();
}

export function unmount(): void {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = 0;
  }
  if (activeContainer) {
    activeContainer.replaceChildren();
    activeContainer = null;
  }
}

async function loadAgents(): Promise<void> {
  try {
    const list = await api.listAgents() as Array<{ id?: string; sessionId?: string }> | null;
    const ids = new Set<string>();
    const bySession = new Map<string, string>();
    if (Array.isArray(list)) {
      for (const a of list) {
        if (a && typeof a.id === 'string' && a.id) {
          ids.add(a.id);
          if (typeof a.sessionId === 'string' && a.sessionId) bySession.set(a.sessionId, a.id);
        }
      }
    }
    state.agentIds = ids;
    state.agentBySession = bySession;
    if (activeContainer) render();
  } catch {
    /* non-fatal */
  }
}

async function load(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    const data = await api.sessions.list({ q: state.q, limit: state.limit }) as { raw?: string; items?: SessionItem[] };
    state.raw = (data && data.raw) || '';
    state.items = (data && Array.isArray(data.items)) ? data.items : [];
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.raw = '';
    state.items = [];
  } finally {
    state.loading = false;
    if (activeContainer) render();
  }
}

function showToast(msg: string): void {
  state.toast = msg;
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toast = '';
    state.toastTimer = 0;
    if (activeContainer) render();
  }, 1800) as unknown as number;
  render();
}

async function copyId(sid: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(sid);
    showToast(`Copied ${sid.slice(0, 8)}…`);
  } catch {
    showToast('Copy failed');
  }
}

function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncId(sid: string | null | undefined): string {
  if (!sid) return '';
  if (sid.length <= 18) return sid;
  return `${sid.slice(0, 8)}...${sid.slice(-4)}`;
}

function render(): void {
  if (!activeContainer) return;
  const rowsHtml = state.items.length
    ? state.items.map((it) => {
        const agentId = state.agentBySession.get(it.sessionId) || (state.agentIds.has(it.sessionId) ? it.sessionId : "");
        const hasAgent = !!agentId;
        const btnHtml = hasAgent
          ? `<button class="sessions-use" data-sid="${escapeHtml(agentId)}" type="button">Use in Dashboard</button>`
          : `<button class="sessions-use sessions-use--disabled" data-sid="${escapeHtml(it.sessionId)}" type="button"
                   title="This session was created in the Grok TUI, not in this dashboard. Import it first.">
               Import First
             </button>`;
        return `
          <tr class="sessions-row" data-sid="${escapeHtml(it.sessionId)}">
            <td class="sessions-id"  title="${escapeHtml(it.sessionId)}"><code>${escapeHtml(truncId(it.sessionId))}</code></td>
            <td class="sessions-cre">${escapeHtml(it.created)}</td>
            <td class="sessions-st">${escapeHtml(it.status)}</td>
            <td class="sessions-sum">${escapeHtml(it.summary)}</td>
            <td class="sessions-act">${btnHtml}</td>
          </tr>
        `;
      }).join('')
    : '';

  const empty = !state.loading && !state.error && state.items.length === 0;
  const hasRaw = !!(state.raw && state.raw.trim());

  activeContainer.innerHTML = `
    <section class="system-page sessions-page">
      <h2 class="system-page-title">Sessions</h2>
      <p class="system-page-sub">
        Wraps <code>grok sessions list</code> and <code>grok sessions search</code>.
        Click a row to copy its session ID.
      </p>

      <div class="sessions-controls">
        <input
          type="text"
          class="sessions-q"
          placeholder="Search sessions…"
          value="${escapeHtml(state.q)}"
        />
        <input
          type="number"
          class="sessions-limit"
          min="1"
          max="200"
          step="1"
          value="${escapeHtml(String(state.limit))}"
          title="Max rows to return"
        />
        <button class="sessions-refresh" type="button">${state.loading ? 'Loading…' : 'Refresh'}</button>
        ${state.toast ? `<span class="sessions-toast">${escapeHtml(state.toast)}</span>` : ''}
      </div>

      ${state.error ? `<div class="sessions-error">${escapeHtml(state.error)}</div>` : ''}

      <div class="sessions-table-wrap">
        <table class="sessions-table">
          <thead>
            <tr>
              <th>Session ID</th>
              <th>Created</th>
              <th>Status</th>
              <th>Summary</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${empty ? `
          <div class="sessions-empty">
            No sessions matched. Try a broader query, or check
            <code>grok sessions list</code> in a terminal.
          </div>
        ` : ''}
      </div>

      ${hasRaw ? `
        <details class="sessions-raw">
          <summary>Raw output</summary>
          <pre>${escapeHtml(state.raw)}</pre>
        </details>
      ` : ''}
    </section>
  `;

  wire();
}

function wire(): void {
  if (!activeContainer) return;
  const qInput     = activeContainer.querySelector('.sessions-q') as HTMLInputElement | null;
  const limitInput = activeContainer.querySelector('.sessions-limit') as HTMLInputElement | null;
  const refreshBtn = activeContainer.querySelector('.sessions-refresh') as HTMLButtonElement | null;

  if (qInput) {
    qInput.addEventListener('input', (e: Event) => { state.q = (e.target as HTMLInputElement).value; });
    qInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void load();
      }
    });
  }
  if (limitInput) {
    limitInput.addEventListener('input', (e: Event) => {
      const n = parseInt((e.target as HTMLInputElement).value, 10);
      state.limit = Number.isFinite(n) && n > 0 ? n : 20;
    });
    limitInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void load();
      }
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => void load());
  }

  const rows = activeContainer.querySelectorAll('.sessions-row');
  rows.forEach((row) => {
    row.addEventListener('click', (e: Event) => {
      const target = e.target as Element | null;
      if (target && target.closest && target.closest('.sessions-use')) return;
      const sid = row.getAttribute('data-sid');
      if (sid) void copyId(sid);
    });
  });

  const useBtns = activeContainer.querySelectorAll('.sessions-use');
  useBtns.forEach((btn) => {
    btn.addEventListener('click', (e: Event) => {
      e.stopPropagation();
      const sid = btn.getAttribute('data-sid');
      if (!sid) return;
      if (btn.classList.contains('sessions-use--disabled')) {
        showToast('session lives in the grok TUI. open the Import page first.');
        return;
      }
      window.location.hash = `#/agents/${sid}`;
    });
  });
}

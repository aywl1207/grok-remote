// Saved workflow catalog (*.rhai). Run inserts /workflow <name> into chat.

import { api } from '../../lib/api.js';

interface WorkflowItem {
  name: string;
  path: string;
  scope: 'user' | 'project';
  cwd?: string;
  description: string;
  whenToUse: string;
}

let active: HTMLElement | null = null;
let items: WorkflowItem[] = [];
let error = '';
let loading = false;

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function mount(container: HTMLElement): Promise<void> {
  active = container;
  container.replaceChildren();
  container.innerHTML = `
    <section class="system-page workflows-page">
      <header class="system-page-header">
        <h2 class="system-page-title">Workflows</h2>
        <p class="system-page-sub">
          Saved scripts in <code>~/.grok/workflows</code> and each conversation's
          <code>.grok/workflows</code>. <strong>Run</strong> sends
          <code>/workflow &lt;name&gt;</code> to the open chat. This lists
          definitions, not live runs.
        </p>
      </header>
      <div class="workflows-toolbar">
        <button type="button" class="btn btn--ghost" data-act="refresh">Refresh</button>
      </div>
      <div class="workflows-body" data-role="body"></div>
    </section>
  `;
  container.querySelector('[data-act=refresh]')?.addEventListener('click', () => { void load(); });
  await load();
}

export function unmount(): void {
  active = null;
  items = [];
}

async function load(): Promise<void> {
  if (!active) return;
  loading = true;
  error = '';
  paint();
  try {
    const data = await api.workflows.list() as { items?: WorkflowItem[] };
    items = Array.isArray(data && data.items) ? data.items : [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    items = [];
  }
  loading = false;
  paint();
}

function paint(): void {
  const body = active && active.querySelector<HTMLElement>('[data-role=body]');
  if (!body) return;
  if (loading) {
    body.innerHTML = '<p class="workflows-empty">Loading…</p>';
    return;
  }
  if (error) {
    body.innerHTML = `<p class="workflows-empty">Could not load workflows: ${esc(error)}</p>`;
    return;
  }
  if (!items.length) {
    body.innerHTML = '<p class="workflows-empty">No saved workflows yet. Add a <code>.rhai</code> file under <code>~/.grok/workflows</code>.</p>';
    return;
  }
  body.innerHTML = `<ul class="workflows-list">${items.map(renderRow).join('')}</ul>`;
  for (const btn of body.querySelectorAll<HTMLButtonElement>('[data-run]')) {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-run') || '';
      if (!name) return;
      document.dispatchEvent(new CustomEvent('grok-remote:run-slash', {
        detail: { text: `/workflow ${name}`, send: true },
      }));
    });
  }
}

function renderRow(w: WorkflowItem): string {
  const hint = w.whenToUse || w.description || '';
  const scope = w.scope === 'user' ? 'User' : 'Project';
  return `<li class="workflows-row">
    <div class="workflows-row__main">
      <div class="workflows-row__name">${esc(w.name)}</div>
      <div class="workflows-row__meta">${scope}${w.cwd ? ' · ' + esc(w.cwd) : ''}</div>
      ${hint ? `<div class="workflows-row__hint">${esc(hint)}</div>` : ''}
    </div>
    <button type="button" class="btn btn--primary" data-run="${esc(w.name)}">Run</button>
  </li>`;
}

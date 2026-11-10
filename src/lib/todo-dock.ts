import { el } from './render';

export interface DockTodo {
  id: string;
  content: string;
  status: string;
}

export interface TodoSummary {
  total: number;
  done: number;
  inProgress: number;
  current: DockTodo | null;
  active: boolean;
}

export function summarizeTodos(items: DockTodo[]): TodoSummary {
  let done = 0;
  let inProgress = 0;
  let current: DockTodo | null = null;
  let nextPending: DockTodo | null = null;
  for (const t of items) {
    const st = String(t.status || '').toLowerCase();
    if (st === 'completed') done += 1;
    else if (st === 'in_progress') {
      inProgress += 1;
      if (!current) current = t;
    } else if (st === 'pending' && !nextPending) {
      nextPending = t;
    }
  }
  if (!current) current = nextPending;
  const total = items.length;
  const active = total > 0 && (inProgress > 0 || done < total);
  return { total, done, inProgress, current, active };
}

/** Newest checklist only. Older leftover lists stay in the timeline. */
export function pickActiveTodoList(lists: DockTodo[][]): DockTodo[] {
  if (!lists.length) return [];
  const latest = lists[lists.length - 1] || [];
  return summarizeTodos(latest).active ? latest : [];
}

function glyph(status: string): string {
  const st = String(status || '').toLowerCase();
  if (st === 'completed') return '✓';
  if (st === 'in_progress') return '◐';
  return '○';
}

export class TodoDock {
  readonly root: HTMLElement;
  private summaryEl: HTMLElement;
  private currentEl: HTMLElement;
  private onOpen: (() => void) | null = null;

  constructor() {
    this.summaryEl = el('span', { class: 'todo-dock__summary' }, '');
    this.currentEl = el('div', { class: 'todo-dock__current' });
    this.root = el('button', {
      type: 'button',
      class: 'todo-dock',
      hidden: true,
      title: 'Open todos',
      onclick: () => { if (this.onOpen) this.onOpen(); },
    },
      el('div', { class: 'todo-dock__head' },
        el('span', { class: 'todo-dock__title' }, 'Todos'),
        this.summaryEl,
      ),
      this.currentEl,
    );
  }

  setOnOpen(fn: () => void): void {
    this.onOpen = fn;
  }

  paint(items: DockTodo[]): void {
    const sum = summarizeTodos(items);
    if (!sum.active) {
      this.root.hidden = true;
      this.currentEl.replaceChildren();
      return;
    }
    this.root.hidden = false;
    this.summaryEl.textContent = sum.inProgress
      ? `${sum.done}/${sum.total} done · ${sum.inProgress} in progress`
      : `${sum.done}/${sum.total} done`;
    if (sum.current) {
      this.currentEl.replaceChildren(
        el('span', { class: 'todo-dock__mark' }, glyph(sum.current.status)),
        el('span', { class: 'todo-dock__label' }, sum.current.content || '(Untitled)'),
      );
    } else {
      this.currentEl.replaceChildren();
    }
  }

  clear(): void {
    this.paint([]);
  }
}

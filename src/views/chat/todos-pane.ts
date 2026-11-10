// Todos / tasks CLI pane (ctrl+t / ctrl+g) and todo dock sync.

import { el } from '../../lib/render';
import { pickActiveTodoList } from '../../lib/todo-dock';

export function toggleCliPane(view: any, mode: string) {
  if (view._cliPaneMode === mode) { view._closeCliPane(); return; }
  view._cliPaneMode = mode;
  view._renderCliPane();
}

export function closeCliPane(view: any) {
  view._cliPaneMode = null;
  if (view.cliPaneEl) {
    view.cliPaneEl.hidden = true;
    view.cliPaneEl.replaceChildren();
  }
  if (view._todosBtn) view._todosBtn.classList.remove('is-on');
  if (view._tasksBtn) view._tasksBtn.classList.remove('is-on');
}

export function renderCliPane(view: any) {
  const pane = view.cliPaneEl;
  if (!pane || !view._cliPaneMode) return;
  pane.hidden = false;
  if (view._todosBtn) view._todosBtn.classList.toggle('is-on', view._cliPaneMode === 'todos');
  if (view._tasksBtn) view._tasksBtn.classList.toggle('is-on', view._cliPaneMode === 'tasks');
  const close = el('button', { type: 'button', class: 'cli-pane__close', onclick: () => view._closeCliPane() }, 'Close');
  if (view._cliPaneMode === 'todos') {
    const items = view._collectTodos();
    const list = el('div', { class: 'cli-pane__list' });
    if (!items.length) {
      list.appendChild(el('div', { class: 'cli-pane__empty' }, 'No todos in this conversation.'));
    } else {
      for (const it of items) {
        const row = el('button', {
          type: 'button',
          class: `cli-pane__row cli-pane__row--${(it.status || 'Pending').replace(/_/g, '-')}`,
          onclick: () => {
            if (it.card && it.card.node && it.card.node.scrollIntoView) {
              it.card.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          },
        },
          el('span', { class: 'cli-pane__mark' }, it.status === 'completed' ? '✓' : (it.status === 'in_progress' ? '◐' : '○')),
          el('span', { class: 'cli-pane__label' }, it.content || '(Untitled)'),
          el('span', { class: 'cli-pane__meta' }, ({
            completed: 'Completed', in_progress: 'In progress', pending: 'Pending',
          } as any)[it.status] || (it.status || 'Pending')),
        );
        list.appendChild(row);
      }
    }
    pane.replaceChildren(
      el('div', { class: 'cli-pane__head' },
        el('span', { class: 'cli-pane__title' }, `Todos · ${items.length}`),
        close,
      ),
      list,
    );
    return;
  }
  const tasks = view._collectTasks();
  const list = el('div', { class: 'cli-pane__list' });
  if (!tasks.length) {
    list.appendChild(el('div', { class: 'cli-pane__empty' }, 'No subagents or background shells.'));
  } else {
    for (const t of tasks) {
      const row = el('button', {
        type: 'button',
        class: 'cli-pane__row' + (t.running ? ' is-running' : ''),
        onclick: () => {
          if (t.kind === 'bg' && t.id) view._openBgTermViewer(t.id);
          else if (t.node && t.node.scrollIntoView) t.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
      },
        el('span', { class: 'cli-pane__mark' }, t.kind === 'bg' ? '▸' : '●'),
        el('span', { class: 'cli-pane__kind' }, t.kind),
        el('span', { class: 'cli-pane__label' }, t.label),
        el('span', { class: 'cli-pane__meta' }, t.status),
      );
      list.appendChild(row);
    }
  }
  pane.replaceChildren(
    el('div', { class: 'cli-pane__head' },
      el('span', { class: 'cli-pane__title' }, `Tasks · ${tasks.length}`),
      close,
    ),
    list,
  );
}

export function collectTodos(view: any) {
  const out: any[] = [];
  for (const list of view._collectTodoLists()) out.push(...list);
  return out;
}

export function collectTodoLists(view: any) {
  const lists: any[] = [];
  const turns = view.turns || [];
  const last = turns.length ? turns[turns.length - 1] : null;
  if (!last) return lists;
  for (const t of (last.tools || [])) {
    if (t && t.card && t.card.isTodo && typeof t.card.getTodos === 'function') {
      lists.push(t.card.getTodos().map((item: any) => ({ ...item, card: t.card })));
    }
  }
  return lists;
}

export function conversationWorking(view: any) {
  const a = view.currentAgent;
  if (!a) return false;
  const st = String(a.status || '');
  if (st === 'disconnected' || st === 'exited' || st === 'errored') return false;
  if (st === 'running' || st === 'starting') return true;
  return typeof a.inFlight === 'number' && a.inFlight > 0;
}

export function syncTodoDock(view: any) {
  if (!view.todoDock) return;
  if (!view._conversationWorking()) {
    view.todoDock.clear();
    return;
  }
  view.todoDock.paint(pickActiveTodoList(view._collectTodoLists()));
}

export function collapseHistoryTodos(view: any) {
  const turns = view.turns || [];
  const last = turns.length ? turns[turns.length - 1] : null;
  const liveLast = !!(last && view._conversationWorking());
  for (const turn of turns) {
    for (const t of (turn.tools || [])) {
      const card = t && t.card;
      if (!card || typeof card.setCollapsed !== 'function') continue;
      let collapse = true;
      if (liveLast && turn === last && typeof card.getTodos === 'function') {
        const items = card.getTodos() || [];
        collapse = !items.some((it: any) => String(it.status || '') === 'in_progress');
      }
      try { card.setCollapsed(collapse); } catch { /* ignore */ }
    }
  }
}

export function collectTasks(view: any) {
  const out: any[] = [];
  for (const turn of (view.turns || [])) {
    for (const t of (turn.tools || [])) {
      const c = t && t.card;
      if (!c || !c.isSubagent) continue;
      const stCanon = String((c.getStatus && c.getStatus()) || 'Running');
      const st = stCanon.toLowerCase();
      const typeName = (c.getType && c.getType()) || '';
      const typeLabel = typeName ? humanizeSubAgentType(typeName) : '';
      const rawLabel = (c.getLabel && c.getLabel()) || 'Subagent';
      out.push({
        kind: 'subagent',
        label: typeLabel ? `${typeLabel} · ${rawLabel}` : rawLabel,
        status: formatSubAgentStatus(stCanon),
        running: st === 'pending' || st === 'running',
        node: c.node,
      });
    }
  }
  for (const term of (view._lastBgTerms || [])) {
    out.push({
      kind: 'bg',
      id: term.id,
      label: term.command || term.id || 'shell',
      status: term.exited ? `exit ${term.exitStatus && (term.exitStatus.exitCode ?? term.exitStatus.signal) || '?'}` : 'Running',
      running: !term.exited,
    });
  }
  return out;
}

// ── @ file search ────────────────────────────────────────────────────


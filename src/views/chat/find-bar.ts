// Scrollback find bar (ctrl+f). Highlights You / thought / reply text.

import { el } from '../../lib/render';

export function toggleFindBar(view: any, forceOpen?: boolean) {
  if (!view.findBarEl) return;
  const open = forceOpen || view.findBarEl.hidden;
  if (!open) { view._closeFindBar(); return; }
  view.findBarEl.hidden = false;
  if (view._findBtn) view._findBtn.classList.add('is-on');
  if (!view.findBarEl.childElementCount) {
    const input = el('input', {
      class: 'find-bar__input',
      type: 'search',
      placeholder: 'Search this conversation',
      oninput: () => view._runFind((input as HTMLInputElement).value),
      onkeydown: (ev: any) => {
        if (ev.key === 'Enter') { ev.preventDefault(); view._stepFind(ev.shiftKey ? -1 : 1); }
        if (ev.key === 'Escape') { ev.preventDefault(); view._closeFindBar(); }
      },
    });
    view._findInput = input;
    view.findBarEl.append(
      input,
      el('button', { type: 'button', class: 'find-bar__nav', onclick: () => view._stepFind(-1) }, '↑'),
      el('button', { type: 'button', class: 'find-bar__nav', onclick: () => view._stepFind(1) }, '↓'),
      view._findCountEl = el('span', { class: 'find-bar__count' }, ''),
      el('button', { type: 'button', class: 'find-bar__close', onclick: () => view._closeFindBar() }, 'Close'),
    );
  }
  const inp = view._findInput;
  if (inp) { inp.focus(); inp.select(); }
}

export function closeFindBar(view: any) {
  if (view.findBarEl) view.findBarEl.hidden = true;
  if (view._findBtn) view._findBtn.classList.remove('is-on');
  view._findHits = [];
  view._findIdx = -1;
  for (const n of (view.streamEl && view.streamEl.querySelectorAll('.find-hit')) || []) {
    n.classList.remove('find-hit', 'find-hit--on');
  }
}

export function runFind(view: any, q: string) {
  const query = String(q || '').trim().toLowerCase();
  view._findHits = [];
  view._findIdx = -1;
  for (const n of (view.streamEl && view.streamEl.querySelectorAll('.find-hit')) || []) {
    n.classList.remove('find-hit', 'find-hit--on');
  }
  if (!query) {
    if (view._findCountEl) view._findCountEl.textContent = '';
    return;
  }
  for (const turn of (view.turns || [])) {
    const blobs: Array<{ node: HTMLElement; text: string }> = [];
    if (turn.user) blobs.push({ node: turn.user, text: String(turn.userText || '') });
    for (const ph of (turn.phases || [])) {
      if (ph && ph.kind === 'thought' && ph.pane) {
        const tx = typeof ph.pane.text === 'function' ? ph.pane.text() : '';
        blobs.push({ node: ph.pane.node, text: tx });
      }
      if (ph && ph.kind === 'reply' && ph.pane) {
        const tx = typeof ph.pane.text === 'function' ? ph.pane.text() : '';
        blobs.push({ node: ph.pane.node, text: tx });
      }
    }
    for (const b of blobs) {
      if (b.text && b.text.toLowerCase().includes(query) && b.node) {
        b.node.classList.add('find-hit');
        view._findHits.push(b.node);
      }
    }
  }
  if (view._findCountEl) view._findCountEl.textContent = view._findHits.length ? `1/${view._findHits.length}` : '0';
  if (view._findHits.length) view._stepFind(1);
}

export function stepFind(view: any, dir: number) {
  if (!view._findHits.length) return;
  for (const n of view._findHits) n.classList.remove('find-hit--on');
  view._findIdx = (view._findIdx + dir + view._findHits.length) % view._findHits.length;
  const node = view._findHits[view._findIdx];
  node.classList.add('find-hit--on');
  try { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* ignore */ }
  if (view._findCountEl) view._findCountEl.textContent = `${view._findIdx + 1}/${view._findHits.length}`;
}

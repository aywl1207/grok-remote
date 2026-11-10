// Composer @ file search. Walks agent files (depth 4, 400 paths).

import { api } from '../../lib/api';
import { el } from '../../lib/render';

export function atQuery(view: any) {
  if (!view.composerTa) return null;
  const v = view.composerTa.value || '';
  const pos = view.composerTa.selectionStart ?? v.length;
  const left = v.slice(0, pos);
  const m = left.match(/(^|[\s])@([^\s]*)$/);
  if (!m) return null;
  return { start: pos - (m[2] || '').length - 1, q: m[2] || '', pos };
}

export async function onAtQuery(view: any) {
  const hit = view._atQuery();
  if (!hit) { view._closeAtPalette(); return; }
  if (!view.agentId) return;
  if (!view._fileIndex.length) await view._buildFileIndex();
  const q = hit.q.toLowerCase();
  const matches = view._fileIndex
    .filter((p: string) => !q || p.toLowerCase().includes(q))
    .slice(0, 12);
  view._renderAtPalette(matches, hit);
}

export async function buildFileIndex(view: any) {
  const acc: string[] = [];
  const walk = async (rel: string, depth: number) => {
    if (acc.length >= 400 || depth > 4) return;
    try {
      const data: any = await api.listFiles(view.agentId, rel || undefined);
      const entries = (data && data.entries) || [];
      for (const e of entries) {
        if (!e || e.isHidden) continue;
        const path = rel ? `${rel.replace(/\/$/, '')}/${e.name}` : e.name;
        if (e.type === 'directory') await walk(path, depth + 1);
        else acc.push(path);
        if (acc.length >= 400) return;
      }
    } catch { /* ignore */ }
  };
  await walk('', 0);
  view._fileIndex = acc;
}

export function renderAtPalette(view: any, matches: string[], hit: any) {
  const pal = view.atPaletteEl;
  if (!pal) return;
  pal.replaceChildren();
  if (!matches.length) {
    pal.classList.add('hidden');
    return;
  }
  pal.classList.remove('hidden');
  matches.forEach((path, i) => {
    const row = el('button', {
      type: 'button',
      class: 'at-palette__row' + (i === 0 ? ' is-on' : ''),
      onclick: () => view._insertAtPath(path, hit),
    }, path);
    pal.appendChild(row);
  });
}

export function closeAtPalette(view: any) {
  if (view.atPaletteEl) {
    view.atPaletteEl.classList.add('hidden');
    view.atPaletteEl.replaceChildren();
  }
}

export function insertAtPath(view: any, path: string, hit: any) {
  if (!view.composerTa) return;
  const v = view.composerTa.value || '';
  const h = hit || view._atQuery();
  if (!h) return;
  const mention = path.startsWith('@') ? path : `@${path}`;
  const next = v.slice(0, h.start) + mention + ' ' + v.slice(h.pos);
  view.composerTa.value = next;
  const caret = h.start + mention.length + 1;
  try { view.composerTa.setSelectionRange(caret, caret); } catch { /* ignore */ }
  view._closeAtPalette();
  view.composerTa.focus();
  view.composerTa.dispatchEvent(new Event('input', { bubbles: true }));
}

export function onAtKey(view: any, ev: any) {
  if (!view.atPaletteEl || view.atPaletteEl.classList.contains('hidden')) return;
  const rows = Array.from(view.atPaletteEl.querySelectorAll('.at-palette__row'));
  if (!rows.length) return;
  const on = view.atPaletteEl.querySelector('.at-palette__row.is-on');
  let idx = Math.max(0, rows.indexOf(on as Element));
  if (ev.key === 'ArrowDown') {
    ev.preventDefault(); ev.stopPropagation();
    rows[idx].classList.remove('is-on');
    idx = (idx + 1) % rows.length;
    rows[idx].classList.add('is-on');
    return;
  }
  if (ev.key === 'ArrowUp') {
    ev.preventDefault(); ev.stopPropagation();
    rows[idx].classList.remove('is-on');
    idx = (idx - 1 + rows.length) % rows.length;
    rows[idx].classList.add('is-on');
    return;
  }
  if (ev.key === 'Enter' || ev.key === 'Tab') {
    ev.preventDefault(); ev.stopPropagation();
    const path = (rows[idx] as HTMLElement).textContent || '';
    view._insertAtPath(path, view._atQuery());
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault(); ev.stopPropagation();
    view._closeAtPalette();
  }
}

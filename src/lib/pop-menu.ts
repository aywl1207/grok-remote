import { el } from './render';

export interface PopItem {
  label: string;
  onSelect: () => void;
  active?: boolean;
}

export function openPopMenu(opts: {
  anchor: HTMLElement;
  items: PopItem[];
  className?: string;
}): () => void {
  const existing = opts.anchor.parentElement && opts.anchor.parentElement.querySelector(':scope > .pop-menu');
  if (existing) existing.remove();

  const menu = el('div', { class: opts.className || 'pop-menu', role: 'menu' },
    ...opts.items.map((it) => el('button', {
      type: 'button',
      role: 'menuitem',
      class: 'pop-menu__item' + (it.active ? ' is-active' : ''),
      onclick: (ev: Event) => {
        ev.stopPropagation();
        close();
        it.onSelect();
      },
    }, it.label)),
  );

  const host = opts.anchor.parentElement || document.body;
  host.appendChild(menu);

  const onDoc = (ev: Event) => {
    const t = ev.target as Node | null;
    if (t && (menu.contains(t) || opts.anchor.contains(t))) return;
    close();
  };
  const close = () => {
    try { menu.remove(); } catch { /* ignore */ }
    document.removeEventListener('click', onDoc);
  };
  window.setTimeout(() => document.addEventListener('click', onDoc), 0);
  return close;
}

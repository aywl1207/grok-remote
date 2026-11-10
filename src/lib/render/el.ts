// Pure-ish DOM helpers + markdown-light renderers.
// No external libraries. All functions return DOM nodes or strings.

type ElChild = Node | string | number | boolean | null | undefined | ElChild[];
type ElAttrs = Record<string, unknown> | null;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: ElAttrs,
  ...children: ElChild[]
): HTMLElementTagNameMap[K];
export function el(tag: string, attrs?: ElAttrs, ...children: ElChild[]): HTMLElement;
export function el(tag: string, attrs?: ElAttrs, ...children: ElChild[]): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class')      node.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v as object);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v as object);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html')  node.innerHTML = String(v);
      else node.setAttribute(k, String(v));
    }
  }
  for (const c of children) appendChild(node, c);
  return node;
}

function appendChild(parent: Node, c: ElChild): void {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { for (const x of c) appendChild(parent, x); return; }
  if (c instanceof Node) { parent.appendChild(c); return; }
  parent.appendChild(document.createTextNode(String(c)));
}

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c] as string));
}

export function fmtClock(d: Date): string {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function basename(p: unknown): string {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

import { el } from './render';

export type LiveKind = 'tool' | 'subagent' | 'shell' | 'skill';

export interface LiveItem {
  id: string;
  kind: LiveKind;
  type?: string;
  label: string;
  title?: string;
  live?: boolean;
  startedAt?: number;
  href?: string;
  onClick?: () => void;
  done?: () => boolean;
}

export function countLiveItems(items: Iterable<{ live?: boolean }>): number {
  let n = 0;
  for (const rec of items) if (rec.live) n += 1;
  return n;
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

export class LiveBar {
  readonly root: HTMLElement;
  private chipsEl: HTMLElement;
  private countEl: HTMLElement;
  private titleEl: HTMLElement;
  private items = new Map<string, { rec: LiveItem; node: HTMLElement }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private onTick: (() => void) | null;

  constructor(opts: { onTick?: () => void } = {}) {
    this.onTick = opts.onTick || null;
    this.countEl = el('span', { class: 'live-bar__count' }, '');
    this.titleEl = el('span', { class: 'live-bar__title' }, 'In progress');
    this.chipsEl = el('div', { class: 'live-bar__chips' });
    this.root = el('div', { class: 'live-bar', hidden: true },
      el('div', { class: 'live-bar__head' },
        el('span', { class: 'live-bar__dots', 'aria-hidden': 'true' }, el('span'), el('span'), el('span')),
        this.titleEl,
        this.countEl,
      ),
      this.chipsEl,
    );
  }

  upsert(item: LiveItem): void {
    const prev = this.items.get(item.id);
    if (prev) {
      prev.rec = { ...prev.rec, ...item };
      this.paintChip(prev.node, prev.rec);
      this.sync();
      return;
    }
    const node = this.makeChip(item);
    this.chipsEl.appendChild(node);
    this.items.set(item.id, { rec: item, node });
    this.sync();
  }

  remove(id: string): void {
    const hit = this.items.get(id);
    if (!hit) return;
    try { hit.node.remove(); } catch { /* ignore */ }
    this.items.delete(id);
    this.sync();
  }

  replaceKind(kind: LiveKind, next: LiveItem[]): void {
    const want = new Set(next.map((item) => item.id));
    for (const [id, hit] of [...this.items.entries()]) {
      if (hit.rec.kind === kind && !want.has(id)) this.remove(id);
    }
    for (const item of next) {
      const prev = this.items.get(item.id);
      if (prev && prev.rec.startedAt && !item.startedAt) item.startedAt = prev.rec.startedAt;
      this.upsert(item);
    }
  }

  clear(): void {
    this.items.clear();
    this.chipsEl.replaceChildren();
    this.sync();
  }

  get size(): number {
    return this.items.size;
  }

  dispose(): void {
    this.stopTimer();
    this.clear();
  }

  private makeChip(item: LiveItem): HTMLElement {
    const tag = item.href ? 'a' : 'button';
    const node = el(tag, {
      type: tag === 'button' ? 'button' : undefined,
      class: `live-bar__chip live-bar__chip--${item.kind}`,
      href: item.href || undefined,
    });
    this.paintChip(node, item);
    node.addEventListener('click', (ev) => {
      if (item.href) return;
      ev.preventDefault();
      const rec = this.items.get(item.id)?.rec;
      if (rec && rec.onClick) rec.onClick();
    });
    return node;
  }

  private paintChip(node: HTMLElement, item: LiveItem): void {
    node.className = `live-bar__chip live-bar__chip--${item.kind}`;
    node.title = item.title || `${item.type || item.kind} · ${item.label}`;
    const kids: HTMLElement[] = [];
    if (item.live) kids.push(el('span', { class: 'live-bar__dot' }));
    if (item.type) kids.push(el('span', { class: 'live-bar__type' }, item.type));
    kids.push(el('span', { class: 'live-bar__label' }, item.label));
    if (item.live) kids.push(el('span', { class: 'live-bar__dur' }, '0s'));
    node.replaceChildren(...kids);
    this.writeDur(node, item);
  }

  private writeDur(node: HTMLElement, item: LiveItem): void {
    const durEl = node.querySelector('.live-bar__dur');
    if (!durEl || !item.live || !item.startedAt) return;
    durEl.textContent = fmtDur(Date.now() - item.startedAt) || '0s';
  }

  private liveCount(): number {
    return countLiveItems([...this.items.values()].map((hit) => hit.rec));
  }

  private sync(): void {
    const live = this.liveCount();
    this.root.hidden = live === 0;
    this.root.classList.toggle('live-bar--live', live > 0);
    this.titleEl.textContent = 'In progress';
    this.countEl.textContent = live === 1 ? '1 Running' : `${live} Running`;
    if (live > 0) this.startTimer();
    else this.stopTimer();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 400);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    for (const [id, hit] of [...this.items.entries()]) {
      if (hit.rec.done && hit.rec.done()) {
        this.remove(id);
        continue;
      }
      this.writeDur(hit.node, hit.rec);
    }
    if (this.onTick) {
      try { this.onTick(); } catch { /* ignore */ }
    }
    if (this.liveCount() === 0) this.stopTimer();
  }
}

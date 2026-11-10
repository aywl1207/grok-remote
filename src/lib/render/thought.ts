// Collapsible Thought pane.

import { el } from './el.js';
import { fmtDur } from '../format.js';
import { createRafPainter } from '../raf-paint.js';

export interface ThinkingPane {
  node: HTMLElement;
  append(text: string): void;
  finalize(): void;
  text(): string;
  isActive(): boolean;
  dispose(): void;
}

export function renderThinkingPane(opts: { open?: boolean; live?: boolean } = {}): ThinkingPane {
  const live = opts.live !== false;
  const startedAt = Date.now();
  const dots = el('span', { class: 'thinking-dots' }, '...');
  const durEl = el('span', { class: 'thinking-dur', hidden: true }, '');
  const summary = el('summary', { class: 'thinking-summary' },
    el('span', { class: 'thinking-label' }, 'Thought'),
    durEl,
    dots,
  );
  const body = el('pre', { class: 'thinking-body' });
  const details = el('details', { class: 'thinking', open: !!opts.open }, summary, body);
  let buf = '';
  let active = true;
  let endedAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const paintDur = (running: boolean): void => {
    const ms = (endedAt || Date.now()) - startedAt;
    const label = fmtDur(ms);
    if (!label) {
      durEl.hidden = true;
      durEl.textContent = '';
      return;
    }
    durEl.hidden = false;
    durEl.textContent = running ? `${label}…` : label;
  };

  if (live) {
    paintDur(true);
    timer = setInterval(() => {
      if (!active) {
        if (timer) { clearInterval(timer); timer = null; }
        return;
      }
      paintDur(true);
    }, 250);
  }

  const stop = (): void => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  const painter = createRafPainter(() => {
    body.textContent = buf;
    if (active) body.scrollTop = body.scrollHeight;
  });
  return {
    node: details,
    append(text: string): void {
      buf += text;
      painter.schedule();
    },
    finalize(): void {
      if (!active) return;
      active = false;
      endedAt = Date.now();
      stop();
      painter.flush();
      dots.textContent = '';
      dots.hidden = true;
      if (live) paintDur(false);
      summary.classList.add('thinking-summary--done');
      details.classList.add('thinking--done');
      body.scrollTop = body.scrollHeight;
    },
    text(): string { return buf; },
    isActive(): boolean { return active; },
    dispose(): void { stop(); painter.cancel(); },
  };
}

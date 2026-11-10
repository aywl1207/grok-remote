// Assistant reply bubble.

import { el, fmtClock } from './el.js';
import { renderMarkdownLight } from './markdown.js';
import { copyToClipboard } from '../copy.js';
import { createRafPainter } from '../raf-paint.js';

export interface AssistantBubble {
  node: HTMLElement;
  append(text: string): void;
  text(): string;
  finalize(): void;
}

export function renderAssistantBubble(ts?: number | string | Date): AssistantBubble {
  const when = ts ? new Date(ts) : new Date();
  const body = el('div', { class: 'msg-body' });
  let buf = '';
  const timeEl = el('span', { class: 'msg-time', title: when.toISOString() }, fmtClock(when));
  const copyBtn = el('button', {
    type: 'button',
    class: 'msg-copy',
    title: 'Copy Reply',
  }, 'Copy') as HTMLButtonElement;
  copyBtn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const ok = await copyToClipboard(buf);
    copyBtn.textContent = ok ? 'Copied' : 'Failed';
    window.setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
  });
  const node = el('div', { class: 'msg msg--assistant' },
    el('div', { class: 'msg-head' },
      el('span', { class: 'msg-role' }, 'grok'),
      timeEl,
      copyBtn,
    ),
    body,
  );
  const painter = createRafPainter(() => {
    body.replaceChildren(renderMarkdownLight(buf));
  });
  return {
    node,
    append(text: string): void {
      buf += text;
      painter.schedule();
    },
    text(): string { return buf; },
    finalize(): void {
      painter.flush();
      node.classList.add('msg--done');
      const now = new Date();
      timeEl.textContent = fmtClock(now);
      timeEl.title = now.toISOString();
    },
  };
}

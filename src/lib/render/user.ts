// User bubble + attachment thumbs.

import { el, fmtClock, basename } from './el.js';
import { renderMarkdownLight } from './markdown.js';

export interface Attachment {
  mimeType?: string;
  dataUrl?: string;
  dataBase64?: string;
  rel?: string;
  name?: string;
  size?: number | null;
}

export interface AttachmentThumb {
  name: string;
  mimeType: string;
  size: number | null;
  src: string;
}

export interface UserAttachmentOpts {
  agentId?: string;
}

export function userAttachmentThumbnails(
  attachments: Attachment[] = [],
  { agentId }: UserAttachmentOpts = {},
): AttachmentThumb[] {
  const out: AttachmentThumb[] = [];
  for (const att of attachments || []) {
    if (!att || typeof att !== 'object') continue;
    const mimeType = String(att.mimeType || '');
    if (!mimeType.startsWith('image/')) continue;

    let src = '';
    if (typeof att.dataUrl === 'string' && att.dataUrl) {
      src = att.dataUrl;
    } else if (typeof att.dataBase64 === 'string' && att.dataBase64) {
      src = `data:${mimeType || 'image/png'};base64,${att.dataBase64}`;
    } else if (agentId && typeof att.rel === 'string' && att.rel) {
      src = `/api/agents/${encodeURIComponent(agentId)}/files/raw?path=${encodeURIComponent(att.rel)}`;
    }
    if (!src) continue;

    out.push({
      name: att.name || basename(att.rel) || 'attached image',
      mimeType,
      size: att.size ?? null,
      src,
    });
  }
  return out;
}

function looksLikeGeneratedAttachmentBlock(text: string): boolean {
  const lines = String(text || '').split('\n');
  if (lines[0] !== 'Attached files:') return false;
  const fileLines = lines.slice(1).filter(Boolean);
  return fileLines.length > 0 && fileLines.every(line => /^- .+ \([^,]+, .+\)$/.test(line));
}

export function stripGeneratedAttachmentBlock(text: string, attachments: Attachment[] = []): string {
  const s = String(text || '');
  if (!attachments || !attachments.length || !s) return s;

  const marker = 'Attached files:\n';
  const withGap = `\n\n${marker}`;
  const gapIdx = s.lastIndexOf(withGap);
  if (gapIdx >= 0) {
    const block = s.slice(gapIdx + 2);
    if (looksLikeGeneratedAttachmentBlock(block)) return s.slice(0, gapIdx);
  }

  if (s.startsWith(marker) && looksLikeGeneratedAttachmentBlock(s)) return '';
  return s;
}

function renderUserAttachments(attachments: Attachment[] | undefined, agentId: string | undefined): HTMLElement | null {
  const thumbs = userAttachmentThumbnails(attachments, { agentId });
  if (!thumbs.length) return null;
  return el('div', { class: 'msg-attachments' }, thumbs.map((att) =>
    el('a', {
      class: 'msg-attachment',
      href: att.src,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: att.name,
      onclick: (ev: MouseEvent) => {
        if (ev.button !== 0) return;
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        void import('../image-lightbox.js').then((m) => m.openImageLightbox(att.src, att.name));
      },
    },
      el('img', {
        class: 'msg-attachment-thumb',
        src: att.src,
        alt: att.name,
        loading: 'lazy',
      }),
      el('span', { class: 'msg-attachment-name' }, att.name),
    )
  ));
}

export interface UserBubbleOpts {
  attachments?: Attachment[];
  agentId?: string;
}

export function renderUserBubble(text: string, ts?: number | string | Date, opts: UserBubbleOpts = {}): HTMLElement {
  const when = ts ? new Date(ts) : new Date();
  const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
  const visibleText = stripGeneratedAttachmentBlock(text, attachments);
  const body = el('div', { class: 'msg-body' });
  if (visibleText) body.appendChild(renderMarkdownLight(visibleText));
  const attachmentGrid = renderUserAttachments(attachments, opts.agentId);
  if (attachmentGrid) body.appendChild(attachmentGrid);
  if (!visibleText && !attachmentGrid) body.appendChild(renderMarkdownLight(''));

  return el('div', { class: 'msg msg--user' },
    el('div', { class: 'msg-head' },
      el('span', { class: 'msg-role' }, 'you'),
      el('span', { class: 'msg-time', title: when.toISOString() }, fmtClock(when)),
    ),
    body,
  );
}

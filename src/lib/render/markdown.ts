// Light markdown for chat bubbles. Text is inserted as DOM text, never HTML.

import { copyToClipboard } from '../copy.js';
import { el } from './el.js';
import {
  splitProseAndTables,
  tableToCsv,
  tableToMarkdown,
  tableToTsv,
  type MdTable,
} from './md-table.js';

export function normalizeNewlines(text: string): string {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function safeLinkUrl(url: string): string | null {
  const u = String(url || '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^mailto:[^\s]+$/i.test(u)) return u;
  return null;
}

export function safeImageUrl(url: string): string | null {
  const http = safeLinkUrl(url);
  if (http && /^https?:\/\//i.test(http)) return http;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(String(url || '').trim())) {
    return String(url).trim();
  }
  return null;
}

export type MdInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'img'; alt: string; src: string | null; fallback: string };

export function parseInline(src: string): MdInline[] {
  const s = String(src || '');
  const out: MdInline[] = [];
  let i = 0;
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };
  while (i < s.length) {
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1 && !s.slice(i + 1, end).includes('\n')) {
        out.push({ kind: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2 && !s.slice(i + 2, end).includes('\n')) {
        out.push({ kind: 'bold', text: s.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (s.startsWith('![', i)) {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        const raw = m[2] || '';
        out.push({ kind: 'img', alt: m[1] || '', src: safeImageUrl(raw), fallback: raw });
        i += m[0].length;
        continue;
      }
    }
    if (s[i] === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i));
      if (m) {
        const href = safeLinkUrl(m[2] || '');
        if (href) out.push({ kind: 'link', text: m[1] || '', href });
        else pushText(m[1] || '');
        i += m[0].length;
        continue;
      }
    }
    if (s[i] === '*' && s[i + 1] && s[i + 1] !== '*' && s[i + 1] !== ' ') {
      const end = s.indexOf('*', i + 1);
      if (end > i + 1 && !s.slice(i + 1, end).includes('\n')) {
        out.push({ kind: 'em', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('http://', i) || s.startsWith('https://', i)) {
      const m = /^https?:\/\/[^\s<]+/.exec(s.slice(i));
      if (m) {
        let raw = m[0];
        let trail = '';
        while (raw && /[.,;:!?)\]]$/.test(raw)) {
          trail = raw.slice(-1) + trail;
          raw = raw.slice(0, -1);
        }
        const href = safeLinkUrl(raw);
        if (href) out.push({ kind: 'link', text: raw, href });
        else pushText(raw);
        pushText(trail);
        i += m[0].length;
        continue;
      }
    }
    pushText(s[i] || '');
    i += 1;
  }
  return out;
}

export type MdProseBlock =
  | { kind: 'p'; lines: MdInline[][] }
  | { kind: 'h'; level: number; inlines: MdInline[] }
  | { kind: 'ul'; items: MdInline[][] }
  | { kind: 'ol'; items: MdInline[][] }
  | { kind: 'quote'; text: string; lines: MdInline[][] };

function isStructural(line: string): boolean {
  return /^(#{1,6}\s+\S)/.test(line)
    || /^>\s?/.test(line)
    || /^[-*]\s+\S/.test(line)
    || /^\d+\.\s+\S/.test(line);
}

export function parseProse(text: string): MdProseBlock[] {
  const lines = normalizeNewlines(text).split('\n');
  const blocks: MdProseBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || '';
    if (!line.trim()) { i += 1; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, (heading[1] || '#').length);
      blocks.push({ kind: 'h', level, inlines: parseInline(heading[2] || '') });
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const raw: string[] = [];
      const parsed: MdInline[][] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] || '')) {
        const body = (lines[i] || '').replace(/^>\s?/, '');
        raw.push(body);
        parsed.push(parseInline(body));
        i += 1;
      }
      blocks.push({ kind: 'quote', text: raw.join('\n'), lines: parsed });
      continue;
    }
    if (/^[-*]\s+\S/.test(line)) {
      const items: MdInline[][] = [];
      while (i < lines.length && /^[-*]\s+\S/.test(lines[i] || '')) {
        items.push(parseInline((lines[i] || '').replace(/^[-*]\s+/, '')));
        i += 1;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }
    if (/^\d+\.\s+\S/.test(line)) {
      const items: MdInline[][] = [];
      while (i < lines.length && /^\d+\.\s+\S/.test(lines[i] || '')) {
        items.push(parseInline((lines[i] || '').replace(/^\d+\.\s+/, '')));
        i += 1;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }
    const para: MdInline[][] = [];
    while (i < lines.length && (lines[i] || '').trim() && !isStructural(lines[i] || '')) {
      para.push(parseInline(lines[i] || ''));
      i += 1;
    }
    if (para.length) blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

function appendInlines(parent: HTMLElement, parts: MdInline[]): void {
  for (const p of parts) {
    if (p.kind === 'text') parent.appendChild(document.createTextNode(p.text));
    else if (p.kind === 'code') parent.appendChild(el('code', { class: 'md-inline-code' }, p.text));
    else if (p.kind === 'bold') parent.appendChild(el('strong', {}, p.text));
    else if (p.kind === 'em') parent.appendChild(el('em', {}, p.text));
    else if (p.kind === 'link') parent.appendChild(el('a', {
      class: 'md-link',
      href: p.href,
      target: '_blank',
      rel: 'noreferrer noopener',
    }, p.text));
    else if (p.src) parent.appendChild(el('img', { class: 'md-img', src: p.src, alt: p.alt || '' }));
    else parent.appendChild(document.createTextNode(p.alt || p.fallback || ''));
  }
}

function renderProseBlock(block: MdProseBlock): HTMLElement {
  if (block.kind === 'h') {
    const node = el(`h${block.level}`, { class: 'md-h' });
    appendInlines(node, block.inlines);
    return node;
  }
  if (block.kind === 'ul' || block.kind === 'ol') {
    const list = el(block.kind, { class: 'md-list' });
    for (const item of block.items) {
      const li = el('li');
      appendInlines(li, item);
      list.appendChild(li);
    }
    return list;
  }
  if (block.kind === 'quote') {
    const body = el('blockquote', { class: 'md-quote' });
    block.lines.forEach((line, idx) => {
      if (idx) body.appendChild(el('br'));
      appendInlines(body, line);
    });
    const quote = block.text;
    const btn = el('button', {
      type: 'button',
      class: 'md-quote__copy md-table__copy',
      onclick: () => { void copyToClipboard(quote); },
    }, 'Copy');
    return el('div', { class: 'md-quote-wrap' }, body, btn);
  }
  const node = el('div', { class: 'md-block' });
  block.lines.forEach((line, idx) => {
    if (idx) node.appendChild(el('br'));
    appendInlines(node, line);
  });
  return node;
}

function renderCode(lang: string, code: string): HTMLElement {
  const body = code.endsWith('\n') ? code.slice(0, -1) : code;
  const codeEl = el('code', { class: lang ? `lang-${lang}` : '' }, body);
  const label = lang ? `Copy ${lang}` : 'Copy';
  const btn = el('button', {
    type: 'button',
    class: 'md-code__copy md-table__copy',
    onclick: () => { void copyToClipboard(codeEl.textContent || ''); },
  }, label);
  return el('div', { class: 'md-code-wrap' },
    btn,
    el('pre', { class: 'md-code' }, codeEl),
  );
}

function renderTable(table: MdTable): HTMLElement {
  const head = el('tr');
  for (const cell of table.headers) head.appendChild(el('th', {}, cell));
  const body = el('tbody');
  for (const row of table.rows) {
    const tr = el('tr');
    for (const cell of row) tr.appendChild(el('td', {}, cell));
    body.appendChild(tr);
  }
  const actions = el('div', { class: 'md-table__actions' });
  const button = (label: string, value: string) => el('button', {
    type: 'button',
    class: 'md-table__copy',
    onclick: () => { void copyToClipboard(value); },
  }, label);
  actions.append(
    button('Copy TSV', tableToTsv(table)),
    button('Copy CSV', tableToCsv(table)),
    button('Copy Markdown', tableToMarkdown(table)),
  );
  return el('div', { class: 'md-table-wrap' },
    actions,
    el('table', { class: 'md-table' }, el('thead', {}, head), body),
  );
}

export function renderMarkdownLight(text: string): HTMLElement {
  if (!text) return el('span');
  const container = el('div', { class: 'md' });
  const src = normalizeNewlines(String(text));
  const segments = src.split(/(```[\s\S]*?```)/g);
  for (const seg of segments) {
    if (!seg) continue;
    if (seg.startsWith('```') && seg.endsWith('```') && seg.length >= 6) {
      const inner = seg.slice(3, -3);
      const nl = inner.indexOf('\n');
      let lang = '';
      let code = inner;
      if (nl >= 0 && /^[a-zA-Z0-9_+.-]*$/.test(inner.slice(0, nl))) {
        lang = inner.slice(0, nl);
        code = inner.slice(nl + 1);
      }
      container.appendChild(renderCode(lang, code));
      continue;
    }
    for (const block of splitProseAndTables(seg)) {
      if (block.kind === 'table') container.appendChild(renderTable(block.table));
      else if (block.text && block.text.trim()) {
        for (const prose of parseProse(block.text)) container.appendChild(renderProseBlock(prose));
      }
    }
  }
  return container;
}

// Token footer, compact pill, error banner, toast.

import { el } from './el.js';

export interface TokenMeta {
  inputTokens?: number; input_tokens?: number;
  outputTokens?: number; output_tokens?: number;
  cachedReadTokens?: number; cached_read_tokens?: number; cachedTokens?: number;
  reasoningTokens?: number; reasoning_tokens?: number;
  totalTokens?: number | null; total_tokens?: number | null;
  modelId?: string | null; model_id?: string | null; model?: string | null;
  stopReason?: string | null; stop_reason?: string | null;
}

export function renderTokenFooter(meta: TokenMeta | null | undefined): HTMLElement {
  if (!meta) return el('div', { class: 'turn-footer' }, 'Turn complete');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const inputT  = num(meta.inputTokens ?? meta.input_tokens);
  const outputT = num(meta.outputTokens ?? meta.output_tokens);
  const cachedT = num(meta.cachedReadTokens ?? meta.cached_read_tokens ?? meta.cachedTokens);
  const reasonT = num(meta.reasoningTokens ?? meta.reasoning_tokens);
  const total   = num(meta.totalTokens ?? meta.total_tokens);
  const model   = meta.modelId ?? meta.model_id ?? meta.model ?? null;
  const effort  = (meta as { effort?: string; reasoningEffort?: string }).effort
    ?? (meta as { reasoningEffort?: string }).reasoningEffort
    ?? null;
  const stop    = meta.stopReason ?? meta.stop_reason ?? null;

  const chips: HTMLElement[] = [];
  if (inputT != null)  chips.push(chip('In', inputT.toLocaleString()));
  if (outputT != null) chips.push(chip('Out', outputT.toLocaleString()));
  if (cachedT != null) chips.push(chip('Cached', cachedT.toLocaleString()));
  if (reasonT != null) chips.push(chip('Think', reasonT.toLocaleString()));
  if (total != null)   chips.push(chip('Ctx', total.toLocaleString()));
  if (model)           chips.push(chip('Model', model));
  if (effort)          chips.push(chip('Effort', effort));
  // ACP always ends a normal reply with end_turn — noise, not a signal.
  if (stop && String(stop).toLowerCase() !== 'end_turn') chips.push(chip('Stop', stop));
  if (!chips.length) return el('div', { class: 'turn-footer' }, 'Turn complete');
  return el('div', { class: 'turn-footer' }, ...chips);
}

function chip(label: string, value: unknown): HTMLElement {
  return el('span', { class: 'chip' },
    el('span', { class: 'chip-label' }, label),
    el('span', { class: 'chip-value' }, String(value)),
  );
}

export function renderCompactedPill(text: string | undefined): HTMLElement {
  const body = String(text || '').trim();
  const preview = body.replace(/\s+/g, ' ').slice(0, 140);
  const sum = el('summary', { class: 'compacted-card__sum' },
    el('span', { class: 'compacted-card__label' }, 'Context Compacted'),
    preview ? el('span', { class: 'compacted-card__preview' }, preview) : null,
  );
  const details = el('details', { class: 'compacted-card' }, sum) as HTMLDetailsElement;
  if (body) {
    details.appendChild(el('pre', { class: 'compacted-card__body' }, body));
  }
  return details;
}

export function renderCompactingCard(preview?: string): HTMLElement {
  return el('div', {
    class: 'compacted-card compacted-card--busy',
    role: 'status',
    'aria-live': 'polite',
  },
    el('div', { class: 'compacted-card__sum' },
      el('span', { class: 'compacted-card__label' }, 'Compacting…'),
      el('span', { class: 'compacted-card__preview' }, preview || 'Compressing conversation history'),
    ),
  );
}

export function paintCompactCard(card: HTMLElement, opts: {
  busy?: boolean;
  label: string;
  preview?: string;
  body?: string;
}): void {
  card.classList.toggle('compacted-card--busy', !!opts.busy);
  const labelEl = card.querySelector('.compacted-card__label');
  if (labelEl) labelEl.textContent = opts.label;
  let previewEl = card.querySelector('.compacted-card__preview');
  const preview = String(opts.preview || '').trim();
  if (preview) {
    if (!previewEl) {
      previewEl = el('span', { class: 'compacted-card__preview' }, preview);
      const sum = card.querySelector('.compacted-card__sum') || card;
      sum.appendChild(previewEl);
    } else {
      previewEl.textContent = preview;
    }
  }
}

export function renderErrorBanner(text: string | undefined): HTMLElement {
  return el('div', { class: 'error-banner' },
    el('span', { class: 'error-banner-label' }, 'Error'),
    el('span', { class: 'error-banner-text' }, text || 'Unknown error'),
  );
}

export function renderToast(text: string, kind?: string): HTMLElement {
  return el('div', { class: `toast toast--${kind || 'info'}` }, text);
}

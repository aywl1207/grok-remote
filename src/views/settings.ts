// Settings view.

import { api, parseModelsPayload } from '../lib/api.js';
import { el } from '../lib/render.js';
import { iconHtml } from '../lib/icons.js';
import { THEMES, getTheme, setTheme } from '../lib/themes.js';
import { SETTINGS_SECTIONS, getSettingsPage } from './system/index';

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

interface SettingsSnapshot {
  defaultModel?: string | null;
  defaultCwd?: string | null;
  autoApprove?: boolean;
  debug?: boolean;
  retentionDays?: number;
  theme?: string;
  defaultContextWindow?: number;
  defaultCompactAtPercent?: number;
}

interface PageModule {
  mount?(parent: HTMLElement, ctx?: unknown): void;
  unmount?(): void;
}

export class SettingsView {
  settings: SettingsSnapshot;
  models: unknown[];

  private _activeArea: string;
  private _mountedModule: PageModule | null;
  private _navButtons: Map<string, HTMLElement>;

  generalForm: HTMLElement;
  contentHost: HTMLElement;
  subnav: HTMLElement;
  root: HTMLElement;

  modelInput!: HTMLInputElement;
  modelSelect: HTMLSelectElement | null = null;
  cwdInput!: HTMLInputElement;
  autoApprove!: HTMLInputElement;
  debugToggle!: HTMLInputElement;
  retentionInput!: HTMLInputElement;
  contextWindowInput!: HTMLInputElement;
  compactPercentInput!: HTMLInputElement;
  themePicker!: HTMLElement;
  statusEl!: HTMLElement;
  saveBtn!: HTMLButtonElement;
  reloadBtn!: HTMLButtonElement;
  modelFieldHost!: HTMLElement;
  themeCards: Record<string, HTMLElement> = {};

  constructor() {
    this.settings = {};
    this.models   = [];

    this._activeArea     = 'general';
    this._mountedModule  = null;
    this._navButtons     = new Map();

    this._buildGeneralFormPieces();
    this.generalForm = this._buildGeneralFormRoot();

    this.contentHost = el('div', { class: 'settings-content' }) as HTMLElement;
    this.subnav = this._buildSubnav();

    this.root = el('section', { class: 'settings-shell' },
      this.subnav,
      this.contentHost,
    ) as HTMLElement;
  }

  mount(parent: HTMLElement): void {
    if (this.root.parentNode !== parent) {
      parent.appendChild(this.root);
    }
  }

  unmount(): void {
    this._teardownMountedModule();
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }

  setActive(area?: string): void {
    const next = area || 'general';
    if (next === this._activeArea && this.contentHost.children.length) return;
    this._activeArea = next;
    this._refreshSubnavActive();
    this._renderActive();
  }

  private _buildSubnav(): HTMLElement {
    const nav = el('nav', { class: 'settings-subnav', 'aria-label': 'Settings sections' }) as HTMLElement;
    for (const section of SETTINGS_SECTIONS) {
      nav.appendChild(el('div', { class: 'settings-subnav__section-title' }, section.title));
      const list = el('ul', { class: 'settings-subnav__list' });
      for (const item of section.items) {
        const btn = el('a', {
          class: 'settings-subnav__item',
          href: `#/settings/${item.area}`,
          'data-area': item.area,
        },
          el('span', { class: 'settings-subnav__ico', innerHTML: iconHtml(item.iconName || 'settings') }),
          el('span', { class: 'settings-subnav__lbl' }, item.label),
        ) as HTMLElement;
        this._navButtons.set(item.area, btn);
        list.appendChild(el('li', {}, btn));
      }
      nav.appendChild(list);
    }
    return nav;
  }

  private _refreshSubnavActive(): void {
    for (const [area, btn] of this._navButtons) {
      btn.classList.toggle('settings-subnav__item--active', area === this._activeArea);
    }
  }

  private _renderActive(): void {
    this._teardownMountedModule();
    this.contentHost.replaceChildren();

    if (this._activeArea === 'general') {
      this.contentHost.appendChild(this.generalForm);
      this.refreshThemePicker();
      void this.load();
      return;
    }

    const page = getSettingsPage(this._activeArea) as (PageModule & { module?: PageModule }) | null;
    const mod: PageModule | undefined = (page && (page as { module?: PageModule }).module) || undefined;
    if (!page || !mod || typeof mod.mount !== 'function') {
      this.contentHost.appendChild(
        el('div', { class: 'pane-empty' }, `No view for "${this._activeArea}"`),
      );
      return;
    }
    mod.mount(this.contentHost, { area: this._activeArea });
    this._mountedModule = mod;
  }

  private _teardownMountedModule(): void {
    if (!this._mountedModule) return;
    if (typeof this._mountedModule.unmount === 'function') {
      try { this._mountedModule.unmount(); } catch { /* ignore */ }
    }
    this._mountedModule = null;
  }

  private _buildGeneralFormPieces(): void {
    this.modelInput   = el('input', { class: 'inp', type: 'text', placeholder: 'grok-build' }) as HTMLInputElement;
    this.modelSelect  = null;
    this.cwdInput     = el('input', { class: 'inp', type: 'text', placeholder: '/path/to/working/dir' }) as HTMLInputElement;
    this.autoApprove  = el('input', { type: 'checkbox' }) as HTMLInputElement;
    this.debugToggle  = el('input', { type: 'checkbox' }) as HTMLInputElement;
    this.retentionInput = el('input', {
      class: 'inp inp--num', type: 'number', min: '0', max: '3650', step: '1', placeholder: '30',
    }) as HTMLInputElement;
    this.contextWindowInput = el('input', {
      class: 'inp inp--num', type: 'number', min: '1000', step: '1000', placeholder: '500000',
    }) as HTMLInputElement;
    this.compactPercentInput = el('input', {
      class: 'inp inp--num', type: 'number', min: '1', max: '100', step: '1', placeholder: '80',
    }) as HTMLInputElement;
    this.themePicker = this._buildThemePicker();
    this.statusEl = el('div', { class: 'settings-status' }) as HTMLElement;

    this.saveBtn = el('button', {
      class: 'btn btn--primary',
      onclick: (ev: MouseEvent) => { ev.preventDefault(); void this.save(); },
    }, 'Save') as HTMLButtonElement;
    this.reloadBtn = el('button', {
      class: 'btn btn--ghost',
      onclick: (ev: MouseEvent) => { ev.preventDefault(); void this.load(); },
    }, 'Reload') as HTMLButtonElement;

    this.modelFieldHost = el('div', { class: 'field-host' }, this.modelInput) as HTMLElement;
  }

  private _buildGeneralFormRoot(): HTMLElement {
    return el('section', { class: 'settings' },
      el('h2', { class: 'settings-title' }, 'General'),
      this.statusEl,

      this.field('Default model', this.modelFieldHost,
        'Used when you spawn a new agent without specifying one.'),
      this.field('Default cwd', this.cwdInput,
        'Fallback working directory for new agents.'),
      this.field('Auto-approve tools',
        el('label', { class: 'toggle' }, this.autoApprove,
          el('span', { class: 'toggle-text' }, 'On')),
        'Server already passes --always-approve. Shown here for visibility.'),
      this.field('Debug controls',
        el('label', { class: 'toggle' }, this.debugToggle,
          el('span', { class: 'toggle-text' }, 'Show developer affordances')),
        'Shows the { payload } button in the composer to inspect the exact JSON sent to the agent.'),
      this.field('History retention (days)', this.retentionInput,
        'Agent history under ~/.grok-remote/agents/ is pruned when last activity exceeds this. Starred agents are never pruned. 0 disables cleanup. Default 30.'),
      this.field('Default context window', this.contextWindowInput,
        'Token window used by the occupancy bar and UI auto-compact. grok-4.6 is 500000. Leave empty to use the model catalog.'),
      this.field('Auto-compact at %', this.compactPercentInput,
        'UI auto-compact line as a percent of the window. grok-4.6 engine compact is 80. Leave empty to use the model catalog.'),
      this.field('Theme', this.themePicker,
        'Applies instantly. Saved in this browser only.'),

      el('div', { class: 'settings-actions' }, this.saveBtn, this.reloadBtn),
    ) as HTMLElement;
  }

  field(label: string, control: HTMLElement, help?: string): HTMLElement {
    return el('div', { class: 'field' },
      el('label', { class: 'field-label' }, label),
      control,
      help ? el('div', { class: 'field-help' }, help) : null,
    ) as HTMLElement;
  }

  refreshThemePicker(): void {
    const current = getTheme();
    for (const [k, card] of Object.entries(this.themeCards || {})) {
      card.classList.toggle('theme-card--selected', k === current);
      const radio = card.querySelector('input[type="radio"]') as HTMLInputElement | null;
      if (radio) radio.checked = (k === current);
    }
  }

  async load(): Promise<void> {
    this.setStatus('Loading…', 'idle');
    try {
      const [settings, modelsResp] = await Promise.allSettled([
        api.getSettings(),
        api.models(),
      ]);
      if (settings.status === 'fulfilled' && settings.value) {
        this.settings = (settings.value || {}) as SettingsSnapshot;
        this.modelInput.value  = this.settings.defaultModel || '';
        this.cwdInput.value    = this.settings.defaultCwd   || '';
        this.autoApprove.checked = !!this.settings.autoApprove;
        this.debugToggle.checked = !!this.settings.debug;
        const rd = (this.settings.retentionDays != null) ? Number(this.settings.retentionDays) : 30;
        this.retentionInput.value = Number.isFinite(rd) ? String(Math.max(0, Math.min(3650, rd))) : '30';
        const cw = Number(this.settings.defaultContextWindow);
        this.contextWindowInput.value = Number.isFinite(cw) && cw > 0 ? String(Math.floor(cw)) : '';
        const pct = Number(this.settings.defaultCompactAtPercent);
        this.compactPercentInput.value = Number.isFinite(pct) && pct > 0 ? String(Math.floor(pct)) : '';
      } else {
        this.setStatus('Settings unreachable · using defaults', 'warn');
      }

      let models: unknown[] = [];
      if (modelsResp.status === 'fulfilled' && modelsResp.value) {
        models = parseModelsPayload(modelsResp.value);
      }
      this.models = models;
      this.swapModelField();
      if (settings.status === 'fulfilled') this.setStatus('Loaded', 'ok');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus(`Load failed: ${msg}`, 'fail');
    }
  }

  swapModelField(): void {
    if (Array.isArray(this.models) && this.models.length) {
      const sel = el('select', { class: 'inp' }) as HTMLSelectElement;
      const cur = this.modelInput.value || this.settings.defaultModel || '';
      sel.appendChild(el('option', { value: '' }, '(unset)'));
      for (const m of this.models) {
        let id: string | undefined;
        if (typeof m === 'string') id = m;
        else if (m && typeof m === 'object') {
          const r = m as { id?: string; name?: string; modelId?: string };
          id = r.id || r.name || r.modelId;
        }
        if (!id) continue;
        const opt = el('option', { value: id }, id) as HTMLOptionElement;
        if (id === cur) opt.selected = true;
        sel.appendChild(opt);
      }
      const customRow = el('div', { class: 'model-custom' },
        el('span', { class: 'model-custom-label' }, 'Or custom:'),
        this.modelInput,
      );
      this.modelSelect = sel;
      this.modelFieldHost.replaceChildren(sel, customRow);
    } else {
      this.modelFieldHost.replaceChildren(this.modelInput);
    }
  }

  async save(): Promise<void> {
    const cwRaw = this.contextWindowInput.value.trim();
    const pctRaw = this.compactPercentInput.value.trim();
    const body = {
      defaultModel: this.modelSelect && this.modelSelect.value
        ? this.modelSelect.value
        : (this.modelInput.value.trim() || null),
      defaultCwd:   this.cwdInput.value.trim() || null,
      autoApprove:  !!this.autoApprove.checked,
      debug:        !!this.debugToggle.checked,
      retentionDays: clampInt(this.retentionInput.value, 0, 3650, 30),
      defaultContextWindow: cwRaw ? clampInt(cwRaw, 1000, 10_000_000, 500000) : null,
      defaultCompactAtPercent: pctRaw ? clampInt(pctRaw, 1, 100, 80) : null,
      theme:        getTheme(),
    };
    this.saveBtn.disabled = true;
    this.setStatus('Saving…', 'idle');
    try {
      const updated = await api.patchSettings(body);
      this.settings = (updated || body) as SettingsSnapshot;
      this.setStatus('Saved', 'ok');
      window.dispatchEvent(new CustomEvent('grok-remote:settings-change', {
        detail: this.settings,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus(`Save failed: ${msg}`, 'fail');
    } finally {
      this.saveBtn.disabled = false;
    }
  }

  setStatus(text: string, kind?: 'ok' | 'fail' | 'warn' | 'idle'): void {
    this.statusEl.replaceChildren(
      el('span', { class: `status-pill status-pill--${kind || 'idle'}` }, '·'),
      el('span', { class: 'settings-status-text' }, text),
    );
  }

  private _buildThemePicker(): HTMLElement {
    const current = getTheme();
    const grid = el('div', { class: 'theme-grid' }) as HTMLElement;
    this.themeCards = {};
    for (const t of THEMES) {
      const isSel = t.name === current;
      const card = el('label', {
        class: `theme-card${isSel ? ' theme-card--selected' : ''}`,
      },
        el('input', {
          type: 'radio',
          name: 'theme',
          value: t.name,
          checked: isSel,
          onchange: () => {
            setTheme(t.name);
            this.refreshThemePicker();
            window.dispatchEvent(new CustomEvent('grok-remote:theme-change', {
              detail: { theme: t.name },
            }));
          },
        }),
        el('span', { class: 'theme-card-swatch', style: `background: ${t.accent}` }),
        el('span', { class: 'theme-card-label' }, t.label),
      ) as HTMLElement;
      this.themeCards[t.name] = card;
      grid.appendChild(card);
    }
    return grid;
  }
}

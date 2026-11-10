// Per-conversation settings drawer. Wired from ChatView; do not paint chat here.

import { api } from '../../lib/api';
import { settingsNeedNewHold, settingsNeedFreshSession } from '../../../lib/settings-hold.js';
import { el } from '../../lib/render';
import { resolveFolderInput } from '../../lib/conversation-folder.js';

// ── settings drawer ─────────────────────────────────────────────────

export function toggleSettingsDrawer(view: any) {
  if (view.settingsDrawerOpen) view.closeSettingsDrawer();
  else view.openSettingsDrawer();
}

export function openSettingsDrawer(view: any) {
  if (!view.agentId) return;
  if (!view.settingsDrawer) view._buildSettingsDrawer();
  view._populateSettingsDrawer(view.currentAgent || {});
  view.settingsDrawer.classList.add('chat-settings-drawer--open');
  view.settingsDrawerOpen = true;
  // Fetch model suggestions lazily on first open. Best-effort.
  if (view._modelSuggestions == null) {
    view._modelSuggestions = [];
    api.systemModels.get()
      .then((r: any) => {
        const items = (r && Array.isArray(r.items)) ? r.items : [];
        view._modelSuggestions = items.map((i: any) => i.id).filter(Boolean);
        view._renderModelDatalist();
      })
      .catch(() => { /* leave list empty */ });
  } else {
    view._renderModelDatalist();
  }
}

export function closeSettingsDrawer(view: any) {
  if (!view.settingsDrawer) return;
  view.settingsDrawer.classList.remove('chat-settings-drawer--open');
  view.settingsDrawerOpen = false;
}

export function buildSettingsDrawer(view: any) {
  // Each field is built once, then stitched into grouped sections. We keep
  // the .value plumbing in a flat `fields` map so save-time collection is
  // just a dictionary walk.
  const fields: any = {};

  // ---- field factory --------------------------------------------------
  const field = (key: any, labelText: any, input: any, hintText?: any) => {
    if (key) fields[key] = input;
    return el('div', { class: 'sd-field' },
      el('label', { class: 'sd-label' }, labelText),
      input,
      hintText ? el('div', { class: 'sd-hint' }, hintText) : null,
    );
  };
  const onDirty = (input: any) => {
    const evt = (input.tagName === 'SELECT' || input.type === 'checkbox') ? 'change' : 'input';
    input.addEventListener(evt, () => view._markSettingsDirty());
  };

  // ---- inputs ---------------------------------------------------------
  const nameInput = el('input', {
    class: 'sd-input',
    type: 'text',
    placeholder: 'Optional agent name',
  });
  const folderInput = el('input', {
    class: 'sd-input',
    type: 'text',
    placeholder: 'my-project or /home/opc/grok-projects/my-project',
  });
  fields.cwd = folderInput;
  const newFolderBtn = el('button', {
    class: 'btn btn--ghost sd-new-folder',
    type: 'button',
    title: 'Create a project folder under /home/opc/grok-projects/',
    onclick: () => {
      const name = window.prompt('New folder name:');
      if (!name || !name.trim()) return;
      folderInput.value = resolveFolderInput(name.trim());
      view._markSettingsDirty();
      folderInput.focus();
    },
  }, 'New Folder');
  const folderRow = el('div', { class: 'sd-folder-row' }, folderInput, newFolderBtn);

  const modelInput = el('input', {
    class: 'sd-input',
    type: 'text',
    list: 'chat-settings-model-list',
    placeholder: 'e.g. grok-code-fast-1',
  });
  const reasoningSelect = el('select', { class: 'sd-input' },
    el('option', { value: '' }, 'Default'),
    el('option', { value: 'none' }, 'None'),
    el('option', { value: 'minimal' }, 'Minimal'),
    el('option', { value: 'low' }, 'Low'),
    el('option', { value: 'medium' }, 'Medium'),
    el('option', { value: 'high' }, 'High'),
    el('option', { value: 'xhigh' }, 'xHigh'),
  );

  const systemPromptTa = el('textarea', {
    class: 'sd-input sd-textarea sd-textarea--lg',
    rows: '5',
    placeholder: 'Leave blank to keep the default.',
  });
  const rulesTa = el('textarea', {
    class: 'sd-input sd-textarea sd-textarea--lg',
    rows: '5',
    placeholder: 'One rule per line.',
  });

  const toolsInput = el('input', {
    class: 'sd-input',
    type: 'text',
    placeholder: 'read_file,grep,list_dir',
  });
  const disallowedInput = el('input', {
    class: 'sd-input',
    type: 'text',
    placeholder: 'web_search,run_terminal_cmd',
  });

  const allowTa = el('textarea', {
    class: 'sd-input sd-textarea',
    rows: '4',
    placeholder: 'Bash(npm*) or run_terminal_command or Shell',
  });
  const denyTa = el('textarea', {
    class: 'sd-input sd-textarea',
    rows: '4',
    placeholder: 'Bash(rm*)',
  });

  const sandboxInput = el('input', {
    class: 'sd-input',
    type: 'text',
    placeholder: 'Sandbox profile',
  });
  const worktreeInput = el('input', {
    class: 'sd-input',
    type: 'text',
    placeholder: 'Worktree path or name',
  });
  fields.worktree = worktreeInput;

  const alwaysApproveCheckbox = el('input', {
    class: 'sd-checkbox',
    type: 'checkbox',
  });
  alwaysApproveCheckbox.checked = true;
  fields.alwaysApprove = alwaysApproveCheckbox;

  const contextWindowInput = el('input', {
    class: 'sd-input',
    type: 'number',
    min: '1000',
    step: '1000',
    placeholder: 'e.g. 500000',
  });
  const compactPercentInput = el('input', {
    class: 'sd-input',
    type: 'number',
    min: '1',
    max: '100',
    step: '1',
    placeholder: 'e.g. 80',
  });
  const uiAutoCompactCheckbox = el('input', {
    class: 'sd-checkbox',
    type: 'checkbox',
  });
  uiAutoCompactCheckbox.checked = true;
  fields.contextWindow = contextWindowInput;
  fields.autoCompactThresholdPercent = compactPercentInput;
  fields.uiAutoCompact = uiAutoCompactCheckbox;

  // Wire dirty tracking on every interactive control.
  for (const inp of [
    nameInput, folderInput, modelInput, reasoningSelect, systemPromptTa, rulesTa,
    toolsInput, disallowedInput, allowTa, denyTa, sandboxInput,
    worktreeInput, alwaysApproveCheckbox,
    contextWindowInput, compactPercentInput, uiAutoCompactCheckbox,
  ]) onDirty(inp);

  const dataList = el('datalist', { id: 'chat-settings-model-list' });
  view._modelDatalist = dataList;

  // ---- buttons --------------------------------------------------------
  const saveBtn = el('button', {
    class: 'btn btn--primary sd-save',
    type: 'button',
    onclick: () => view._submitSettingsDrawer(),
  }, 'Save');
  const resetBtn = el('button', {
    class: 'btn btn--ghost sd-reset',
    type: 'button',
    title: 'Clear all per-conversation settings (revert to defaults)',
    onclick: () => view._clearSettingsDrawer(),
  }, 'Clear All');
  const closeBtn = el('button', {
    class: 'btn btn--ghost sd-close',
    type: 'button',
    onclick: () => view.closeSettingsDrawer(),
  }, 'Cancel');

  const notice = el('div', { class: 'sd-notice hidden' });
  view._sdNotice = notice;
  const dirtyNotice = el('div', { class: 'sd-dirty hidden' },
    'unsaved changes. reconnect required for new flags to apply.');
  view._sdDirtyNotice = dirtyNotice;

  // ---- sections -------------------------------------------------------
  const section = (title: any, ...children: any[]) => el('section', { class: 'sd-section' },
    el('div', { class: 'sd-section-title' }, title),
    ...children,
  );

  const identitySection = section('Identity',
    field('name', 'Name', nameInput,
      'Optional agent name (used in sidebar and tab title).'),
    field(null, 'Folder', folderRow,
      'Name or full path. Save creates /home/opc/grok-projects/<name> if it does not exist. The live Grok session keeps the folder it started with until you start a new conversation.'),
  );

  const modelSection = section('Model',
    el('div', { class: 'sd-grid' },
      field('model', 'Model', modelInput,
        'overrides the global default. blank = use default.'),
      field('reasoningEffort', 'Reasoning effort', reasoningSelect,
        'none | minimal | low | medium | high | xhigh.'),
    ),
    el('label', { class: 'sd-toggle' },
      alwaysApproveCheckbox,
      el('span', { class: 'sd-toggle-text' }, 'Always approve tool calls'),
      el('span', { class: 'sd-toggle-hint' },
        'auto-approve every tool call (default on).'),
    ),
    inheritToggle(view),
  );

  const contextSection = section('Context',
    el('div', { class: 'sd-grid' },
      field('contextWindow', 'Context window (tokens)', contextWindowInput,
        'UI auto-compact uses this window. Blank inherits grok-remote / model defaults.'),
      field('autoCompactThresholdPercent', 'Auto-compact at %', compactPercentInput,
        'Compact after a turn when used ≥ window × this percent. 1–100. Blank inherits default.'),
    ),
    el('label', { class: 'sd-toggle' },
      uiAutoCompactCheckbox,
      el('span', { class: 'sd-toggle-text' }, 'Auto-compact this chat'),
      el('span', { class: 'sd-toggle-hint' },
        'when occupancy hits the line above. Does not need a reconnect.'),
    ),
  );

  const promptSection = section('System prompt',
    field('systemPromptOverride', 'System prompt override', systemPromptTa,
      'replaces the agent system prompt entirely (leave blank to keep default).'),
    field('rules', 'Rules', rulesTa,
      'extra rules appended to the system prompt.'),
  );

  const toolsSection = section('Tools',
    el('div', { class: 'sd-grid' },
      field('tools', 'Allowed tools', toolsInput,
        'comma-separated allowed tools.'),
      field('disallowedTools', 'Disallowed tools', disallowedInput,
        'comma-separated blocked tools.'),
    ),
  );

  const permsSection = section('Permissions',
    el('div', { class: 'sd-grid' },
      field('allow', 'Allow', allowTa,
        'one rule per line. Native names run_terminal_command and Shell are accepted.'),
      field('deny', 'Deny', denyTa,
        'one rule per line; deny wins over allow.'),
    ),
  );

  const envSection = section('Environment',
    el('div', { class: 'sd-grid' },
      field('sandbox', 'Sandbox profile', sandboxInput,
        'sandbox profile name.'),
      field(null, 'Worktree', worktreeInput,
        'Spawn into an existing worktree dir (-w <path>).'),
    ),
  );

  const body = el('div', { class: 'sd-body' },
    identitySection,
    modelSection,
    contextSection,
    promptSection,
    toolsSection,
    permsSection,
    envSection,
    dataList,
  );

  const head = el('header', { class: 'sd-head' },
    el('h3', { class: 'sd-title' }, 'Conversation settings'),
    el('div', { class: 'sd-sub' },
      'Per-conversation overrides for ', el('code', null, 'grok'),
      ' top-level flags. Applied the next time this agent (re)connects.'),
    notice,
  );

  const foot = el('footer', { class: 'sd-foot' },
    dirtyNotice,
    el('span', { class: 'sd-foot-spacer' }),
    resetBtn,
    closeBtn,
    saveBtn,
  );

  const card = el('aside', { class: 'chat-settings-drawer-card' }, head, body, foot);
  const backdrop = el('div', {
    class: 'chat-settings-drawer-backdrop',
    onclick: () => view.closeSettingsDrawer(),
  });
  const drawer = el('div', { class: 'chat-settings-drawer' }, backdrop, card);

  view._sdFields = fields;
  view._sdNameInput = nameInput;
  view.settingsDrawer = drawer;
  view.root.appendChild(drawer);
}

export function renderModelDatalist(view: any) {
  if (!view._modelDatalist) return;
  view._modelDatalist.replaceChildren();
  for (const m of (view._modelSuggestions || [])) {
    view._modelDatalist.appendChild(el('option', { value: m }));
  }
}

function inheritToggle(view: any): HTMLElement {
  const box = el('input', { class: 'sd-checkbox', type: 'checkbox' });
  box.addEventListener('change', () => {
    const on = !!box.checked;
    void api.grokFeatures.set({ subagentModelInheritance: on }).then(() => {
      view.showToast(
        on
          ? 'Subagents use the parent model. Applies to new Grok sessions.'
          : 'Subagents keep their own model. Applies to new Grok sessions.',
        'info',
      );
    }).catch((e: any) => {
      box.checked = !on;
      view.showToast(`Could not save subagent model setting: ${e && e.message ? e.message : e}`, 'warn');
    });
  });
  void api.grokFeatures.get().then((data: any) => {
    box.checked = !!(data && data.subagentModelInheritance);
  }).catch(() => { /* leave unchecked */ });
  return el('label', { class: 'sd-toggle' },
    box,
    el('span', { class: 'sd-toggle-text' }, 'Subagents use the parent model'),
    el('span', { class: 'sd-toggle-hint' },
      'Saved in Grok config. Applies when a new Grok session starts, not to holds already running.'),
  );
}

export function populateSettingsDrawer(view: any, agent: any) {
  if (!view._sdFields) return;
  const s = (agent && agent.settings) || {};
  const f = view._sdFields;
  if (view._sdNameInput) {
    view._sdNameInput.value = typeof (agent && agent.name) === 'string' ? agent.name : '';
  }
  if (f.cwd) {
    f.cwd.value = typeof (agent && agent.cwd) === 'string' ? agent.cwd : '';
  }
  f.model.value                = typeof s.model === 'string' ? s.model : '';
  f.reasoningEffort.value      = typeof s.reasoningEffort === 'string' ? s.reasoningEffort : '';
  f.systemPromptOverride.value = typeof s.systemPromptOverride === 'string' ? s.systemPromptOverride : '';
  f.rules.value                = typeof s.rules === 'string' ? s.rules : '';
  f.tools.value                = typeof s.tools === 'string' ? s.tools : '';
  f.disallowedTools.value      = typeof s.disallowedTools === 'string' ? s.disallowedTools : '';
  f.allow.value                = Array.isArray(s.allow) ? s.allow.join('\n') : '';
  f.deny.value                 = Array.isArray(s.deny)  ? s.deny.join('\n')  : '';
  f.sandbox.value              = typeof s.sandbox === 'string' ? s.sandbox : '';
  if (typeof s.worktree === 'string' && s.worktree.length) {
    f.worktree.value = s.worktree;
  } else {
    f.worktree.value = '';
  }
  // alwaysApprove defaults to true if not set.
  f.alwaysApprove.checked = !(s.alwaysApprove === false);
  if (f.contextWindow) {
    const w = s.contextWindow != null ? s.contextWindow : s.context_window;
    f.contextWindow.value = (typeof w === 'number' && w > 0) ? String(w) : '';
    const inherited = (agent && (agent.contextWindow || agent.context_window)) || '';
    f.contextWindow.placeholder = inherited ? `inherited ${inherited}` : 'e.g. 500000';
  }
  if (f.autoCompactThresholdPercent) {
    const pct = s.autoCompactThresholdPercent != null
      ? s.autoCompactThresholdPercent
      : s.auto_compact_threshold_percent;
    f.autoCompactThresholdPercent.value = (typeof pct === 'number' && pct > 0) ? String(pct) : '';
    const inheritedPct = (agent && agent.compactAtPercent) || '';
    f.autoCompactThresholdPercent.placeholder = inheritedPct ? `inherited ${inheritedPct}` : 'e.g. 80';
  }
  if (f.uiAutoCompact) {
    f.uiAutoCompact.checked = !(s.uiAutoCompact === false || s.ui_auto_compact === false);
  }

  // Reset the dirty flag now that the form mirrors the saved state.
  view._sdDirty = false;
  if (view._sdDirtyNotice) view._sdDirtyNotice.classList.add('hidden');

  // Live-connected agents need a reconnect before the new settings take
  // effect. Show a small banner explaining that. Mirrors the agent state
  // we track via the sidebar refresh event.
  view._updateSettingsNotice(agent);
}

export function markSettingsDirty(view: any) {
  if (view._sdDirty) return;
  view._sdDirty = true;
  if (view._sdDirtyNotice) view._sdDirtyNotice.classList.remove('hidden');
}

export function updateSettingsNotice(view: any, agent: any) {
  if (!view._sdNotice) return;
  const a = agent || view.currentAgent || {};
  const live = !!a.connected && a.status !== 'disconnected' && a.status !== 'exited';
  view._sdNotice.classList.toggle('hidden', !live);
  if (live) {
    view._sdNotice.textContent =
      'Agent is connected. Saving model or effort will restart this session hold so the new flags apply.';
  } else {
    view._sdNotice.textContent = '';
  }
}

export function collectSettings(view: any) {
  const f = view._sdFields;
  const linesToArr = (s: any) => String(s || '')
    .split('\n')
    .map((l: any) => l.trim())
    .filter(Boolean);
  const parsePosInt = (raw: any) => {
    const t = String(raw || '').trim().replace(/_/g, '').replace(/,/g, '');
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  };
  const out: any = {
    model:                f.model.value.trim(),
    reasoningEffort:      f.reasoningEffort.value.trim(),
    systemPromptOverride: f.systemPromptOverride.value,
    rules:                f.rules.value,
    tools:                f.tools.value.trim(),
    disallowedTools:      f.disallowedTools.value.trim(),
    allow:                linesToArr(f.allow.value),
    deny:                 linesToArr(f.deny.value),
    sandbox:              f.sandbox.value.trim(),
    alwaysApprove:        !!f.alwaysApprove.checked,
    contextWindow:        f.contextWindow ? parsePosInt(f.contextWindow.value) : null,
    autoCompactThresholdPercent: f.autoCompactThresholdPercent
      ? parsePosInt(f.autoCompactThresholdPercent.value)
      : null,
    uiAutoCompact:        f.uiAutoCompact ? !!f.uiAutoCompact.checked : true,
  };
  if (out.autoCompactThresholdPercent != null) {
    const pct = out.autoCompactThresholdPercent;
    out.autoCompactThresholdPercent = Math.max(1, Math.min(100, pct));
  }
  const wn = (f.worktree.value || '').trim();
  out.worktree = wn ? wn : null;
  // Drop empty values so the saved payload stays minimal.
  // Keep null on context overrides so Save clears a previous per-chat window.
  const keepNull = new Set(['contextWindow', 'autoCompactThresholdPercent']);
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v == null && keepNull.has(k)) continue;
    if (v == null) { delete out[k]; continue; }
    if (typeof v === 'string' && v.length === 0) { delete out[k]; continue; }
    if (Array.isArray(v) && v.length === 0) { delete out[k]; continue; }
  }
  return out;
}

export async function submitSettingsDrawer(view: any) {
  if (!view.agentId || !view._sdFields) return;
  const settings = view._collectSettings();
  const patch: any = { settings };
  if (view._sdNameInput) {
    const nv = view._sdNameInput.value.trim();
    const current = (view.currentAgent && view.currentAgent.name) || '';
    if (nv !== current) patch.name = nv;
  }
  if (view._sdFields && view._sdFields.cwd) {
    const folder = resolveFolderInput(String(view._sdFields.cwd.value || ''));
    const currentCwd = (view.currentAgent && view.currentAgent.cwd) || '';
    if (folder && folder !== currentCwd) patch.cwd = folder;
  }
  const saveBtn = view.settingsDrawer && view.settingsDrawer.querySelector('.sd-save');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
  }
  try {
    const prev = (view.currentAgent && view.currentAgent.settings) || {};
    const updated = await api.updateAgent(view.agentId, patch);
    view.applyAgentRefresh(updated);
    view._sdDirty = false;
    if (view._sdDirtyNotice) view._sdDirtyNotice.classList.add('hidden');
    view.closeSettingsDrawer();
    const live = !!(updated && updated.connected && updated.status !== 'disconnected' && updated.status !== 'exited');
    const needHold = settingsNeedNewHold(prev, settings);
    const freshSession = settingsNeedFreshSession(prev, settings);
    if (live && needHold && typeof view._reconnectForSettings === 'function') {
      view.showToast('Conversation settings saved — reconnecting…', 'info');
      await view._reconnectForSettings('Settings', { freshSession });
    } else {
      view.showToast('Conversation settings saved.', 'info');
    }
  } catch (e: any) {
    view.showToast(`Save failed: ${e && e.message ? e.message : String(e)}`, 'warn');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }
}

export async function clearSettingsDrawer(view: any) {
  if (!view.agentId) return;
  try {
    const updated = await api.updateAgent(view.agentId, { settings: null });
    view.applyAgentRefresh(updated);
    view._populateSettingsDrawer(updated || {});
    view.showToast('Per-conversation settings cleared.', 'info');
  } catch (e: any) {
    view.showToast(`Clear failed: ${e && e.message ? e.message : String(e)}`, 'warn');
  }
}

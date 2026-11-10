// Registry of pages routed by the dashboard.

import * as mcp       from './mcp.js';
import * as leaders   from './leaders.js';
import * as worktrees from './worktrees.js';
import * as memory    from './memory.js';
import * as models    from './models.js';
import * as health    from './health.js';
import * as sessions  from './sessions.js';
import * as importV   from './import.js';
import * as setup     from './setup.js';
import * as skills    from './skills.js';
import * as hooks        from './hooks.js';
import * as nativeAgents from './agents.js';
import * as plugins      from './plugins.js';
import * as marketplaces from './marketplaces.js';
import * as lsp          from './lsp.js';
import * as access       from './access.js';
import * as workflows    from './workflows.js';

export interface PageModule {
  mount?(container: HTMLElement, ctx?: unknown): void;
  unmount?(): void;
}

export interface PageEntry {
  area: string;
  label: string;
  iconName?: string;
  module?: PageModule;
}

export interface SettingsSection {
  title: string;
  items: PageEntry[];
}

export const SYSTEM_PAGES: PageEntry[] = [
  { area: 'memory',   label: 'Memory',   iconName: 'memory',   module: memory   as PageModule },
  { area: 'leaders',  label: 'Leaders',  iconName: 'leaders',  module: leaders  as PageModule },
  { area: 'sessions', label: 'Sessions', iconName: 'sessions', module: sessions as PageModule },
  { area: 'health',   label: 'Health',   iconName: 'health',   module: health   as PageModule },
];

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    title: 'General',
    items: [
      { area: 'general',  label: 'General',       iconName: 'settings' },
    ],
  },
  {
    title: 'Access',
    items: [
      { area: 'oauth',       label: 'OAuth',       iconName: 'globe',  module: access as PageModule },
      { area: 'basic-auth',  label: 'Basic Auth',  iconName: 'lock',   module: access as PageModule },
    ],
  },
  {
    title: 'Native config',
    items: [
      { area: 'skills',       label: 'Skills',       iconName: 'skills',   module: skills       as PageModule },
      { area: 'subagents',    label: 'Subagents',    iconName: 'leaders',  module: nativeAgents as PageModule },
      { area: 'hooks',        label: 'Hooks',        iconName: 'flow',     module: hooks        as PageModule },
      { area: 'plugins',      label: 'Plugins',      iconName: 'mcp',      module: plugins      as PageModule },
      { area: 'marketplaces', label: 'Marketplaces', iconName: 'import',   module: marketplaces as PageModule },
      { area: 'mcp',          label: 'MCP servers',  iconName: 'mcp',      module: mcp          as PageModule },
      { area: 'lsp',          label: 'LSP servers',  iconName: 'models',   module: lsp          as PageModule },
      { area: 'models',       label: 'Models',       iconName: 'models',   module: models       as PageModule },
    ],
  },
  {
    title: 'Tools',
    items: [
      { area: 'worktrees', label: 'Worktrees', iconName: 'worktrees', module: worktrees as PageModule },
      { area: 'workflows', label: 'Workflows', iconName: 'flow',      module: workflows as PageModule },
      { area: 'import',    label: 'Import',    iconName: 'import',    module: importV   as PageModule },
      { area: 'setup',     label: 'Setup',     iconName: 'setup',     module: setup     as PageModule },
    ],
  },
];

export const SETTINGS_PAGES: PageEntry[] = SETTINGS_SECTIONS.flatMap((s) => s.items);
export const ALL_PAGES: PageEntry[] = [...SYSTEM_PAGES, ...SETTINGS_PAGES];

export function getSystemPage(area: string): PageEntry | null {
  return SYSTEM_PAGES.find((p) => p.area === area) || null;
}

export function getSettingsPage(area: string): PageEntry | null {
  return SETTINGS_PAGES.find((p) => p.area === area) || null;
}

export function getAnyPage(area: string): PageEntry | null {
  return ALL_PAGES.find((p) => p.area === area) || null;
}

// Grok Build commands the TUI advertises but ACP handshake often omits.
// Local entries open grok-remote pages; the rest are sent as `/name` prompts.

export interface GrokBuildCommand {
  name: string;
  description: string;
  kind: 'local' | 'agent';
  href?: string;
  input?: { hint?: string | null } | null;
}

export const GROK_BUILD_COMMANDS: GrokBuildCommand[] = [
  { name: 'imagine',       kind: 'agent', description: 'Generate an image', input: { hint: '<description>' } },
  { name: 'imagine-video', kind: 'agent', description: 'Generate a video', input: { hint: '<description>' } },
  { name: 'plan',          kind: 'agent', description: 'Enter plan mode', input: { hint: '[description]' } },
  { name: 'view-plan',     kind: 'agent', description: 'Preview the current plan' },
  { name: 'model',         kind: 'local', description: 'Switch model or reasoning effort', input: { hint: '<name> [effort label]' } },
  { name: 'effort',        kind: 'local', description: 'Set reasoning effort', input: { hint: 'none|minimal|low|medium|high|xhigh' } },
  { name: 'rewind',        kind: 'local', description: 'Rewind to an earlier turn', input: { hint: '[turn]' } },
  { name: 'undo',          kind: 'local', description: 'Alias for /rewind' },
  { name: 'fork',          kind: 'local', description: 'Fork this session into a new conversation' },
  { name: 'always-approve',kind: 'local', description: 'Toggle always-approve instantly' },
  { name: 'auto',          kind: 'local', description: 'Switch to auto permission mode' },
  { name: 'skills',        kind: 'local', description: 'Open Skills', href: '#/settings/skills' },
  { name: 'hooks',         kind: 'local', description: 'Open Hooks', href: '#/settings/hooks' },
  { name: 'plugins',       kind: 'local', description: 'Open Plugins', href: '#/settings/plugins' },
  { name: 'marketplace',   kind: 'local', description: 'Open Marketplaces', href: '#/settings/marketplaces' },
  { name: 'remember',      kind: 'agent', description: 'Save a memory note', input: { hint: '<note>' } },
  { name: 'memory',        kind: 'local', description: 'Open Memory', href: '#/settings/memory' },
  { name: 'loop',          kind: 'agent', description: 'Recurring prompt', input: { hint: '[interval] <prompt>' } },
  { name: 'usage',         kind: 'agent', description: 'Show usage stats' },
  { name: 'btw',           kind: 'agent', description: 'Side question without changing the task', input: { hint: '<question>' } },
  { name: 'compact',       kind: 'local', description: 'Compress conversation history', input: { hint: '[what to keep]' } },
  { name: 'context',       kind: 'local', description: 'Show context window usage' },
  { name: 'context-window', kind: 'local', description: 'Choose a context window size', input: { hint: '[tokens]' } },
  { name: 'session-info',  kind: 'local', description: 'Show session details' },
  { name: 'deep-research', kind: 'agent', description: 'Bounded research report', input: { hint: '<query>' } },
  { name: 'workflow',      kind: 'agent', description: 'Launch or manage a workflow', input: { hint: '<name>' } },
  { name: 'workflows',     kind: 'local', description: 'Open saved workflows', href: '#/settings/workflows' },
  { name: 'copy',          kind: 'local', description: 'Copy the last reply', input: { hint: '[n]' } },
  { name: 'export',        kind: 'local', description: 'Export this conversation', input: { hint: '[copy|download]' } },
  { name: 'timestamps',    kind: 'local', description: 'Cycle message times: on, minimal, or off', input: { hint: '[on|minimal|off]' } },
  { name: 'goal',          kind: 'agent', description: 'Set or manage an autonomous goal', input: { hint: '<objective>' } },
];

export const SHORTCUT_CHIPS: { name: string; label: string }[] = [
  { name: 'imagine', label: '/imagine' },
  { name: 'plan',    label: '/plan' },
  { name: 'model',   label: '/model' },
  { name: 'skills',  label: '/skills' },
  { name: 'compact', label: '/compact' },
];

/** `/skills` etc. are local pages. Sending them as a prompt is a bug. */
export function localHrefForSlash(
  text: string,
  commands: Array<{ name: string; kind?: string; href?: string }> = GROK_BUILD_COMMANDS,
): string | null {
  const m = String(text || '').trim().match(/^\/([\w-]+)\s*$/);
  if (!m) return null;
  const name = (m[1] || '').toLowerCase();
  for (const c of commands) {
    if (!c || String(c.name || '').toLowerCase() !== name) continue;
    if (c.kind === 'local' && typeof c.href === 'string' && c.href) return c.href;
  }
  return null;
}

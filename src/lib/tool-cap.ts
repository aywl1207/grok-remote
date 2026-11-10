// Keep a small set of tool cards in the DOM. History compact already
// drops older tools; live turns must prune the same way or the chat
// fills with pills.

import { TOOLS_PER_TURN } from './history-collapse.js';

export { TOOLS_PER_TURN };

export interface ToolEntryLike {
  card?: { isTodo?: boolean; node?: { remove?: () => void } };
}

export function pruneTurnToolCards<T extends ToolEntryLike>(
  tools: T[],
  keep = TOOLS_PER_TURN,
): T[] {
  if (!Array.isArray(tools) || tools.length <= keep) return tools;
  const todo: T[] = [];
  const rest: T[] = [];
  for (const entry of tools) {
    if (entry && entry.card && entry.card.isTodo) todo.push(entry);
    else rest.push(entry);
  }
  const drop = rest.length > keep ? rest.slice(0, rest.length - keep) : [];
  const kept = rest.length > keep ? rest.slice(rest.length - keep) : rest;
  for (const entry of drop) {
    try { entry.card && entry.card.node && entry.card.node.remove && entry.card.node.remove(); }
    catch { /* ignore */ }
  }
  tools.length = 0;
  tools.push(...todo, ...kept);
  return tools;
}

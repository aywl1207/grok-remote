// DOM cards for the conversation pane. Implementations live in ./render/*.
// Importers keep using ../lib/render.

export { el, escapeHtml, fmtClock, basename } from './render/el.js';
export { renderMarkdownLight } from './render/markdown.js';
export {
  userAttachmentThumbnails,
  stripGeneratedAttachmentBlock,
  renderUserBubble,
  type Attachment,
  type AttachmentThumb,
  type UserAttachmentOpts,
  type UserBubbleOpts,
} from './render/user.js';
export { renderAssistantBubble, type AssistantBubble } from './render/assistant.js';
export { renderThinkingPane, type ThinkingPane } from './render/thought.js';
export {
  isTodoWriteToolCall,
  isSubAgentCall,
  pickSubAgentLabel,
  pickSubAgentType,
  humanizeSubAgentType,
  subAgentTypeSlug,
  formatSubAgentStatus,
  effectiveSubAgentStatus,
  childSessionEventFinishesSubagent,
  pickCardIndexForChildSession,
  openCardBlocksParentTurn,
  isShellKind,
  shellStatusLabel,
  terminalToolStatus,
  readSubAgentMeta,
  renderSubagentCard,
  renderToolCard,
  renderTodoWriteCard,
  type SubAgentMeta,
  type ToolCard,
} from './render/tools.js';
export {
  renderTokenFooter,
  renderCompactedPill,
  renderCompactingCard,
  paintCompactCard,
  renderErrorBanner,
  renderToast,
  type TokenMeta,
} from './render/chrome.js';

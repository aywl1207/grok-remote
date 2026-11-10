// Per-agent conversation pane with live SSE streaming.
//
// Orchestrator only. Policy lives in src/lib/ — do not copy skip/merge tables here.
//   history-events.ts   replay / two-pass / catch-up skips
//   sse-ring.ts         drop stale SSE-ring events after connect
//   event-id.ts         live timestamp-seq ids
//   stream-text.ts      chunk merge (1-char suffix is new text)
//   conversation-log.ts You-bubble start/ignore
//   ../../lib/agent-status.ts  apply/ignore status
//
// Rendering rules (from PROTOCOL.md, frontend section):
//   per turn, in chronological order:
//   1. user bubble
//   2. thinking pane (collapsed) from agent_thought_chunk
//   3. tool_call cards, patched by tool_call_update + tool_call_delta_chunk
//   4. assistant message from agent_message_chunk
//   5. token-usage footer from prompt_complete
//
// Plus: available_commands_update, session_summary_generated,
//       _x.ai/session_notification (toast), error (red banner).

import { api } from '../lib/api';
import { openStream } from '../lib/sse';
import { mountFilesTab, unmountFilesTab } from './files';
import { mountTraceTab, unmountTraceTab } from './trace';
import { mountScoped as mountFlowTab, unmount as unmountFlowTab } from './system/flow';
import attachSlashPalette from '../lib/slash-palette';
import { GROK_BUILD_COMMANDS, SHORTCUT_CHIPS } from '../lib/grok-commands';
import { setupImageAttach } from '../lib/attach-images';
import {
  el,
  renderUserBubble,
  renderAssistantBubble,
  renderThinkingPane,
  renderToolCard,
  renderTodoWriteCard,
  isTodoWriteToolCall,
  isSubAgentCall,
  renderSubagentCard,
  humanizeSubAgentType,
  formatSubAgentStatus,
  childSessionEventFinishesSubagent,
  pickCardIndexForChildSession,
  openCardBlocksParentTurn,
  renderTokenFooter,
  renderCompactedPill,
  renderCompactingCard,
  paintCompactCard,
  renderErrorBanner,
  renderToast,
  terminalToolStatus,
} from '../lib/render';
import { unwrap, extractText } from '../lib/acp-payload.js';
import { isChildSessionPayload, payloadSessionId } from '../../lib/child-session.js';
import { errorBannerText, shouldClearErrorBanners } from '../lib/error-banner.js';
import { mergeStreamChunk, mergeAfterGap } from '../lib/stream-text.js';
import { parseLiveEventId, alreadyInHistory, maxLiveEventId } from '../lib/event-id.js';
import { pruneTurnToolCards, TOOLS_PER_TURN } from '../lib/tool-cap.js';
import { shouldDropSseEvent } from '../lib/sse-ring.js';
import { scrollFollowAction, liveTurnUsesHistoryPin, applyForceScrollFlags } from '../lib/chat-scroll.js';
import { shouldApplyAgentStatus, isDisplayedWorking, followServerTurnOpen } from '../../lib/agent-status.js';
import { loadAgentQueue, saveAgentQueue } from '../lib/prompt-queue.js';
import { compactUpdateFromPayload, compactPayloadIsReplay, compactingPreview, shouldPaintCompactStarted, shouldIgnoreLateCompactStarted } from '../../lib/compact-status.js';
import {
  applyNewHistoryEvents,
  catchUpHistory,
  showChatLoading,
  hideChatLoading,
  replayHistoryEvent,
  refreshHistory as replayRefreshHistory,
  FIRST_LOAD_TURNS,
  buildLoadEarlierBanner,
} from './chat/history-replay.js';
import {
  toggleSettingsDrawer as toggleSettingsDrawerFn,
  openSettingsDrawer as openSettingsDrawerFn,
  closeSettingsDrawer as closeSettingsDrawerFn,
  buildSettingsDrawer,
  renderModelDatalist,
  populateSettingsDrawer,
  markSettingsDirty,
  updateSettingsNotice,
  collectSettings,
  submitSettingsDrawer,
  clearSettingsDrawer,
} from './chat/settings-drawer.js';
import {
  MODEL_EFFORT_LEVELS,
  parseModelCommand,
  tryLocalModelCommand,
  loadModelChoices,
  currentModelSettings,
  applyModelSettings,
  closeModelPicker,
  openModelPicker,
  openModelPickerUnsafe,
} from './chat/model-picker.js';
import {
  atQuery,
  onAtQuery,
  buildFileIndex,
  renderAtPalette,
  closeAtPalette,
  insertAtPath,
  onAtKey,
} from './chat/at-palette.js';
import { toggleFindBar, closeFindBar, runFind, stepFind } from './chat/find-bar.js';
import {
  CHAT_TOOLS_TAB_KEY, CHAT_TOOLS_FULLSCREEN_KEY,
  CHAT_SPLIT_SIZES_KEY, CHAT_SPLIT_COLLAPSED_KEY, CHAT_SPLIT_MOBILE_COLLAPSED_KEY,
  CHAT_SPLIT_DEFAULT_SIZES, CHAT_SPLIT_MOBILE_MAX,
  scrollToolsToBottom, buildToolsColHeader, readToolsColTab, readToolsColFullscreen,
  setToolsColTab, applyToolsColTab, toggleToolsFullscreen, applyToolsFullscreenClass,
  isValidSizesArray, readAllChatSplitSizes, readChatSplitSizesForTab, writeChatSplitSizesForTab,
  isChatMobile, initChatSplit, destroyChatSplit, applyChatSplitCollapsedClass,
  updateToolsToggleLabel, toggleToolsCol, closeToolsCol,
} from './chat/tools-col.js';
import {
  promptHistKey, loadPromptHist, savePromptHist, rememberPromptOnView, pushPromptHist,
  promptHistOpen, closePromptHist, togglePromptHist, restorePromptDraft,
  applyPromptHistIdx, stepPromptHist, onPromptHistKey, renderPromptHist,
} from './chat/prompt-hist.js';
import {
  toggleCliPane, closeCliPane, renderCliPane, collectTodos, collectTodoLists,
  conversationWorking, syncTodoDock, collapseHistoryTodos, collectTasks,
} from './chat/todos-pane.js';
import {
  isWorking, wantLiveChip, pruneLiveBar, syncSendBtn, renderQueueBar,
  enqueuePrompt, flushQueue, forceSendQueued, steerQueued, sendPrompt, buildPayloadSnapshot,
  scheduleFlushQueue,
  openPayloadInspector, truncateBase64, cancelPrompt,
  shouldSendComposerEnter, localSessionHref, shouldDropChildEvent,
  canStartCompact, applyCompactSettleTimeout, removeRootBlockingCards,
} from './chat/composer.js';

import { rewindKeepTurns } from '../lib/history-events.js';
import { isAutomaticRuntimePrompt } from '../lib/rewind-prompts.js';
import { promptCompleteGate } from '../lib/prompt-complete.js';
import { countWaitingSubagents, waitingSubagentLabel } from '../lib/subagent-wait.js';
import { decideUserMessage, isDuplicateTailTurn, pickTurnForReplyChunk } from '../lib/conversation-log.js';
import { copyToClipboard, serializeConversation, serializeResumeCommand, nthLastAssistant } from '../lib/copy';
import { applyTimestampsAttr, cycleTimestampMode, setTimestampMode, setTimestampsEnabled, timestampMode, timestampModeLabel } from '../lib/timestamps.js';
import {
  paintTokensPill, toggleContextPanel, closeContextPanel, openContextPanel,
  applyContextWindow, clearContextWindow,
  applyOccupancy,
} from './chat/context-panel.js';
import { shouldApplyLiveOccupancy, formatTokensShort } from '../../lib/context-status.js';
import { iconHtml } from '../lib/icons';
import { fmtTokens } from '../lib/format';
import { mountCwdChip, paintCwdChip } from '../lib/cwd-chip';
import { LiveBar } from '../lib/live-bar';
import { TodoDock, pickActiveTodoList } from '../lib/todo-dock';
import { openPopMenu } from '../lib/pop-menu';
import {
  readPermissionMode,
  permissionLabel,
  permissionSettingsPatch,
  permissionNeedsReconnect,
  type PermissionMode,
} from '../lib/session-mode';
import { playIntro } from '../lib/intro-animation';

export class ChatView {
  static _toolsToggleWired: any;
  static _runSlashWired: boolean;
  static _active: any;
  _activeTodoCard!: any;
  _autoScroll!: any;
  _loadPinUntil!: any;
  _quietScroll!: any;
  _userScrollIntent!: any;
  _programmaticScrollUntil!: any;
  _autoScrollTools!: any;
  _bgListViewerEl!: any;
  _bgTermsByCard!: any;
  _bgTermsTimer!: any;
  _bgTermViewerEl!: any;
  _bgTermViewerTimer!: any;
  _chatIntroAbort!: any;
  _chatIntroEl!: any;
  _chatSplit!: any;
  _chatSplitBuild!: any;
  _chatSplitCollapsed!: any;
  _chatSplitLastSizes!: any;
  _convoSkills!: any;
  _detachAutoScroll!: any;
  _detachPalette!: any;
  _easedScrollPending!: any;
  _easedScrollRaf!: any;
  _easedScrollTarget!: any;
  _easedToolsRaf!: any;
  _easedToolsTarget!: any;
  _historyAll!: any;
  _inFlightMap!: any;
  _subagentMap!: any;
  _subagentTimer!: any;
  _subagentStripReady!: any;
  _childSessionIds!: Set<string>;
  _inFlightTimer!: any;
  _isReplaying!: any;
  _jumpToLatestBtn!: any;
  _knownSkills!: any;
  _lastEasedToolsWrite!: any;
  _lastEasedWrite!: any;
  _lastEventTs!: any;
  _lastHistoryEventId!: any;
  _historyGen!: any;
  _historyTotalTurns!: any;
  _lastPayload!: any;
  _lastRenderedTokens!: any;
  _tokenUiTimer!: any;
  _pendingSidebarTokens!: any;
  _lastServerEcho!: any;
  _modelDatalist!: any;
  _modelSuggestions!: any;
  _modelPicker!: any;
  _onAgentsRefresh!: any;
  _onSettingsChange!: any;
  _onVisibility!: any;
  _payloadModal!: any;
  _pendingTodoSeed!: any;
  _promptCapImage!: any;
  _scrollRaf!: any;
  _scrollEndRaf!: any;
  _sdDirty!: any;
  _sdDirtyNotice!: any;
  _sdFields!: any;
  _sdNameInput!: any;
  _sdNotice!: any;
  _skillCommands!: any;
  _skillsPromise!: any;
  _splitFullscreenBtn!: any;
  _splitToggleBtn!: any;
  _toolsColFullscreen!: any;
  _toolsColTab!: any;
  _toolsFilesMounted!: any;
  _toolsTabBtns!: any;
  activeTurn!: any;
  agentId!: any;
  availableCommands!: any;
  chatSplitEl!: any;
  composerAttachBtn!: any;
  composerCancel!: any;
  composerDebugBtn!: any;
  composerEl!: any;
  composerFileInput!: any;
  composerHint!: any;
  composerSend!: any;
  composerTa!: any;
  promptHistEl!: any;
  cliPaneEl!: any;
  atPaletteEl!: any;
  findBarEl!: any;
  _cliPaneMode!: any;
  _lastBgTerms!: any;
  _fileIndex!: any;
  _findHits!: any;
  _findIdx!: any;
  promptHistBtn!: any;
  _promptHist!: any;
  _promptHistIdx!: any;
  _promptHistDraft!: any;
  connectBtn!: any;
  copyConvoBtn!: any;
  exportMenuEl!: any;
  queueBarEl!: any;
  _promptQueue!: any;
  _flushingQueue!: any;
  _flushTimer!: any;
  _compacting!: any;
  _compactFinished!: boolean;
  _compactFinishedAt!: number;
  _compactSucceeded!: boolean;
  _compactWait!: any;
  _compactCard!: any;
  _forceSending!: any;
  _lastEnterAt!: any;
  currentAgent!: any;
  empty!: any;
  filesMounted!: any;
  filesPane!: any;
  flowMounted!: any;
  flowPane!: any;
  imageAttach!: any;
  inflightPill!: any;
  _modelCatalog: any[] | null = null;
  _modelCatalogLoading = false;
  liveBar!: LiveBar;
  todoDock!: TodoDock;
  loadingEl!: HTMLElement;
  cwdChipEl!: HTMLButtonElement;
  modePill!: any;
  moreBtn!: any;
  _planArmed!: boolean;
  infoPane!: any;
  latestTotalTokens!: any;
  _tokensLiveAt!: number;
  _streamOpenedAt!: any;
  palette!: any;
  root!: any;
  settingsBtn!: any;
  settingsDrawer!: any;
  settingsDrawerOpen!: any;
  starBtn!: any;
  statusEl!: any;
  convoTitleEl!: any;
  convoHeadEl!: any;
  stream!: any;
  streamEl!: any;
  tabBtns!: any;
  tabsEl!: any;
  tabsState!: any;
  toastHost!: any;
  tokensPill!: any;
  contextPanelEl!: any;
  _historyLastHasReply!: any;
  _turnOpen!: any;
  _turnOpenHoldUntil!: number;
  _historyInsertBefore!: any;
  _contextWindow!: any;
  modelPill!: any;
  toolsColEl!: any;
  toolsFilesPaneEl!: any;
  toolsStreamEl!: any;
  traceMounted!: any;
  tracePane!: any;
  turns!: any;

  constructor() {
    this.agentId = null;
    this.stream  = null;
    this._tokenUiTimer = null;
    this._pendingSidebarTokens = null;
    this.turns   = []; // each: { user, thinking, tools[], assistant, footer, root }
    this.activeTurn = null;
    this._turnOpen = false;
    this._turnOpenHoldUntil = 0;
    this._lastHistoryEventId = null;
    this.availableCommands = [];
    this.tabsState = 'conversation';

    // Lazy cache of known skill names (set of strings). Populated on first
    // user message that starts with `/`. Drives the "invoked skill" banner
    // we drop above turns that hit a /name match.
    this._knownSkills = null;
    this._skillCommands = [];
    this._skillsPromise = null;

    this.streamEl  = el('div', { class: 'chat-stream' });
    this.toolsColEl = el('div', { class: 'chat-tools-col' });
    this.toolsStreamEl = el('div', { class: 'chat-tools-stream' });
    // Files preview panel that lives inside the tools column. Mounted
    // lazily when the user switches the in-column tab to "files".
    this.toolsFilesPaneEl = el('div', { class: 'chat-tools-files', hidden: true });
    this._toolsColTab = this._readToolsColTab();
    this._toolsColFullscreen = this._readToolsColFullscreen();
    this._toolsFilesMounted = false;
    this._buildToolsColHeader();
    this._promptHist = [];
    this._promptHistIdx = -1;
    this._promptHistDraft = '';
    this._promptQueue = null;
    this._flushingQueue = false;
    this._flushTimer = null;
    this._compacting = false;
    this._compactFinished = false;
    this._compactFinishedAt = 0;
    this._compactSucceeded = false;
    this._compactWait = null;
    this._compactCard = null;
    this._cliPaneMode = null;
    this._lastBgTerms = [];
    this._fileIndex = [];
    this._findHits = [];
    this._findIdx = -1;
    this.composerEl = this.buildComposer();
    this.tabsEl    = this.buildTabs();
    this.convoTitleEl = el('button', {
      class: 'chat-convo-title',
      type: 'button',
      hidden: true,
      title: 'Rename conversation',
      onclick: () => this._beginRenameConvoTitle(),
    }, '');
    this.convoHeadEl = el('div', { class: 'chat-convo-head', hidden: true }, this.convoTitleEl);
    this.statusEl  = el('div', { class: 'chat-status' });

    this.filesPane = el('div', { class: 'pane pane--files hidden' });
    this.filesMounted = false;
    this.infoPane  = el('div', { class: 'pane pane--info hidden' }, el('div', { class: 'pane-empty' }, 'No agent selected'));
    this.tracePane = el('div', { class: 'pane pane--trace hidden' });
    this.traceMounted = false;
    this.flowPane = el('div', { class: 'pane pane--flow hidden' });
    this.flowMounted = false;

    this.toastHost = el('div', { class: 'toast-host' });

    // Settings drawer: slides in from the right of the chat. Built lazily
    // when the user clicks the gear icon so the DOM cost is zero otherwise.
    this.settingsDrawer = null;
    this.settingsDrawerOpen = false;
    this._modelSuggestions = null;

    this.empty = el('div', { class: 'chat-empty' },
      el('div', { class: 'chat-empty-headline' }, 'No conversation selected'),
      el('div', { class: 'chat-empty-sub' }, 'Pick one from the sidebar or start a new one.'),
      el('div', { class: 'chat-empty-actions' },
        el('button', {
          class: 'btn btn--ghost chat-empty-btn',
          type: 'button',
          onclick: () => {
            // Make sure the sidebar is visible (desktop: dispatch toggle if
            // currently collapsed; mobile: open the drawer).
            try {
              const collapsed = (localStorage.getItem('grok-remote.split.sidebar.collapsed') === '1');
              if (collapsed) document.dispatchEvent(new CustomEvent('grok-remote:sidebar-toggle'));
            } catch { /* ignore */ }
            document.body.setAttribute('data-drawer-open', '1');
          },
        }, 'Select conversation'),
        el('button', {
          class: 'btn btn--primary chat-empty-btn',
          type: 'button',
          onclick: () => {
            // Reuse the sidebar's spawn handler so the same id-then-select
            // flow runs (avoids duplicating the createAgent + navigate code).
            document.dispatchEvent(new CustomEvent('grok-remote:spawn-agent'));
          },
        }, 'New conversation'),
      ),
    );

    // Chat-intro animation state. The hole-to-GR figlet plays inside the
    // chat-stream when an agent with zero turns is opened (i.e. a brand
    // new conversation). _chatIntroAbort cancels the running animation
    // when the first user message lands or the user switches away.
    this._chatIntroAbort = null;
    this._chatIntroEl    = null;

    this.liveBar = new LiveBar({ onTick: () => this._pruneLiveBar() });
    this.todoDock = new TodoDock();
    this.todoDock.setOnOpen(() => {
      this._cliPaneMode = 'todos';
      this._renderCliPane();
    });
    this.loadingEl = el('div', {
      class: 'chat-loading',
      hidden: true,
      role: 'status',
      'aria-live': 'polite',
    },
      el('span', { class: 'chat-loading__spin', 'aria-hidden': 'true' }),
      el('span', { class: 'chat-loading__text' }, 'Loading conversation…'),
    ) as HTMLElement;
    this._inFlightMap = new Map();
    this._inFlightTimer = null;
    this._subagentMap = new Map();
    this._subagentTimer = null;
    this._subagentStripReady = false;
    this._childSessionIds = new Set();
    this._planArmed = false;

    this._bgTermsByCard = new Map();
    this._bgTermsTimer = null;
    this._bgTermViewerEl = null;
    this._convoSkills = new Map();

    this.root = el('section', { class: 'chat' },
      this.tabsEl,
      el('div', { class: 'chat-body' },
        el('div', { class: 'pane pane--conversation' },
          this.convoHeadEl,
          this.statusEl,
          this.todoDock.root,
          this.liveBar.root,
          this.findBarEl = el('div', { class: 'find-bar', hidden: true }),
          this.cliPaneEl = el('div', { class: 'cli-pane', hidden: true }),
          this.chatSplitEl = el('div', { class: 'chat-split' },
            this.streamEl,
            this.toolsColEl,
          ),
          this.loadingEl,
          this.composerEl,
        ),
        this.filesPane,
        this.infoPane,
        this.tracePane,
        this.flowPane,
        this.toastHost,
      ),
    );

    this.streamEl.appendChild(this.empty);
    this._setComposerEnabled(false);
    this._attachComposerExtras();
    this._initAutoScroll();

    // visibility change -> refresh history on becoming visible
    this._onVisibility = () => {
      if (document.visibilityState === 'visible' && this.agentId) {
        this._catchUpHistory().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    // Sidebar pushes fresh agent records into the chat view on each poll
    // tick. Pick out the one matching our active agent so the chat header,
    // info tab, and connect/disconnect button reflect live state.
    this._onAgentsRefresh = (ev: any) => {
      if (!this.agentId) return;
      const list = (ev && ev.detail) || [];
      const a = list.find((x: any) => x && x.id === this.agentId);
      if (a) this.applyAgentRefresh(a);
    };
    document.addEventListener('grok-remote:agents-refresh', this._onAgentsRefresh);

    // Settings changes (e.g. debug toggle) come in via this custom event.
    this._onSettingsChange = (ev: any) => this.applySettings((ev && ev.detail) || {});
    window.addEventListener('grok-remote:settings-change', this._onSettingsChange);
    // Pull initial settings so the debug button surfaces if already enabled.
    api.getSettings().then((s) => this.applySettings(s || {})).catch(() => {});
    applyTimestampsAttr();
    if (!ChatView._runSlashWired) {
      document.addEventListener('grok-remote:run-slash', (ev: any) => {
        const text = ev && ev.detail && ev.detail.text;
        const send = !!(ev && ev.detail && ev.detail.send);
        const view = ChatView._active;
        if (!view || !view.agentId) {
          if (view) view.showToast('Open a conversation first.', 'warn');
          return;
        }
        if (location.hash && !location.hash.includes(view.agentId)) {
          location.hash = '#/agents/' + encodeURIComponent(view.agentId);
        }
        if (view.composerTa) view.composerTa.value = String(text || '');
        if (send) void view.send();
      });
      ChatView._runSlashWired = true;
    }
  }

  applySettings(s: any) {
    const debug = !!s.debug;
    if (this.composerDebugBtn) this.composerDebugBtn.hidden = !debug;
  }

  mount(parent: any) {
    parent.appendChild(this.root);
    // Split.js needs the panes to actually be in the DOM to read sizes,
    // so we init the inner chat split here, not in the constructor.
    // Tear down any previous instance first (mount is re-entrant when the
    // user navigates between routes).
    this._destroyChatSplit();
    this._initChatSplit();
    // External topbar button toggles tools panel via this event. Keep one
    // listener for the document lifetime by guarding with a flag.
    if (!ChatView._toolsToggleWired) {
      document.addEventListener('grok-remote:tools-toggle', () => {
        // Ask the active ChatView to toggle; we walk to the one mounted.
        // Simplest path: dispatch a DOM event from the toggle btn the
        // chat view already owns. Use a custom hook on the class.
        if (ChatView._active) ChatView._active._toggleToolsCol();
      });
      ChatView._toolsToggleWired = true;
    }
    ChatView._active = this;
    // Initial state push so the topbar button paints correctly right after
    // mount, before any user toggle happens.
    document.dispatchEvent(new CustomEvent('grok-remote:tools-state', {
      detail: { collapsed: !!this._chatSplitCollapsed },
    }));
  }

  destroy() {
    this._destroyChatSplit();
    this.closeStream();
    this._closeModelPicker();
    this._cancelChatIntro();
    if (this.filesMounted) {
      unmountFilesTab();
      this.filesMounted = false;
    }
    if (this.traceMounted) {
      unmountTraceTab();
      this.traceMounted = false;
    }
    if (this.flowMounted) {
      unmountFlowTab();
      this.flowMounted = false;
    }
    if (this._detachPalette) { try { this._detachPalette(); } catch { /* ignore */ } this._detachPalette = null; }
    if (this._detachAutoScroll) { try { this._detachAutoScroll(); } catch { /* ignore */ } this._detachAutoScroll = null; }
    if (this._inFlightTimer) { try { clearInterval(this._inFlightTimer); } catch { /* ignore */ } this._inFlightTimer = null; }
    try { this.liveBar && this.liveBar.dispose(); } catch { /* ignore */ }
    this._stopBgTerminalsPolling();
    if (this.imageAttach) { try { this.imageAttach.destroy(); } catch { /* ignore */ } this.imageAttach = null; }
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._catchUpTimer) { try { clearInterval(this._catchUpTimer); } catch { /* ignore */ } this._catchUpTimer = null; }
    if (this._onAgentsRefresh) {
      document.removeEventListener('grok-remote:agents-refresh', this._onAgentsRefresh);
      this._onAgentsRefresh = null;
    }
    if (this._onSettingsChange) {
      window.removeEventListener('grok-remote:settings-change', this._onSettingsChange);
      this._onSettingsChange = null;
    }
  }

  buildTabs() {
    const make = (key: any, label: any) => el('button', {
      class: `tab${this.tabsState === key ? ' tab--active' : ''}`,
      dataset: { key },
      onclick: () => this.switchTab(key),
    }, label);
    this.tabBtns = {
      conversation: make('conversation', 'Conversation'),
      files:        make('files',        'Files'),
      info:         make('info',         'Info'),
      trace:        make('trace',        'Trace'),
      flow:         make('flow',         'Flow'),
    };
    this.tabBtns.files.classList.add('tab--wide');
    this.tabBtns.info.classList.add('tab--more-only');
    this.tabBtns.trace.classList.add('tab--more-only');
    this.tabBtns.flow.classList.add('tab--more-only');
    const starBtn = el('button', {
      class: 'chat-star tab-action tab-action--icon-only',
      type: 'button',
      title: 'Star this conversation',
      'aria-label': 'Star conversation',
      onclick: () => this.toggleStar(),
    });
    starBtn.innerHTML = `<span class="tab-action-ico">${iconHtml('star')}</span>`;
    this.starBtn = starBtn;

    const settingsBtn = el('button', {
      class: 'chat-settings tab-action tab-action--icon-only',
      type: 'button',
      title: 'Per-conversation grok settings (model, reasoning effort, rules, ...)',
      'aria-label': 'Open settings drawer',
      onclick: () => this.toggleSettingsDrawer(),
    });
    settingsBtn.innerHTML = `<span class="tab-action-ico">${iconHtml('settings')}</span>`;
    this.settingsBtn = settingsBtn;
    this.connectBtn = el('button', {
      class: 'tab-action tab-action--toggle',
      type: 'button',
      title: 'Disconnect: stop the agent process but keep the conversation.',
      onclick: () => this.toggleConnection(),
    }, 'Disconnect');
    this.copyConvoBtn = el('button', {
      class: 'tab-action tab-action--copy',
      type: 'button',
      hidden: true,
      title: 'Export this conversation',
    }, 'Export');
    this.exportMenuEl = el('div', { class: 'export-menu', hidden: true });
    this._todosBtn = null;
    this._tasksBtn = null;
    this._findBtn = null;
    this.tokensPill = el('button', {
      type: 'button',
      class: 'tab-tokens',
      hidden: true,
      title: 'Context window',
      onclick: (ev: any) => { ev.stopPropagation(); toggleContextPanel(this); },
    });
    this.contextPanelEl = el('div', { class: 'ctx-panel', hidden: true });
    this.cwdChipEl = mountCwdChip();
    this.modePill = el('button', {
      type: 'button',
      class: 'tab-mode',
      hidden: true,
      title: 'Permission and plan mode',
      onclick: (ev: any) => { ev.stopPropagation(); this._openModeMenu(); },
    });
    this.moreBtn = el('button', {
      type: 'button',
      class: 'tab-action tab-action--more',
      title: 'More',
      onclick: (ev: any) => { ev.stopPropagation(); this._openMoreMenu(); },
    }, 'More');
    this.modelPill = el('button', {
      type: 'button',
      class: 'tab-model',
      hidden: true,
      title: 'Current model and reasoning effort — click to change',
      onclick: () => this._openModelPicker(),
    });
    this.inflightPill = el('span', { class: 'tab-inflight', hidden: true });
    return el('nav', { class: 'tabs' },
      this.tabBtns.conversation,
      this.tabBtns.files,
      this.tabBtns.info,
      this.tabBtns.trace,
      this.tabBtns.flow,
      el('span', { class: 'tabs-spacer' }),
      this.cwdChipEl,
      this.modePill,
      this.modelPill,
      this.inflightPill,
      this.tokensPill,
      el('div', { class: 'tab-actions-group' },
        this.moreBtn,
        this.starBtn,
        this.settingsBtn,
        this.connectBtn,
      ),
    );
  }

  _renderInflightPill() {
    const pill = this.inflightPill;
    if (!pill) return;
    const n = typeof this._localInFlightCount === 'function' ? this._localInFlightCount() : 0;
    if (!n) {
      pill.hidden = true;
      pill.replaceChildren();
      return;
    }
    pill.hidden = false;
    pill.replaceChildren(
      el('span', { class: 'tab-inflight-dot', 'aria-hidden': 'true' }),
      document.createTextNode(n === 1 ? '1 running' : `${n} running`),
    );
  }

  _queueSidebarTokens(tt: number) {
    if (!this.agentId || typeof tt !== 'number') return;
    this._pendingSidebarTokens = tt;
    if (this._tokenUiTimer) return;
    this._tokenUiTimer = setTimeout(() => {
      this._tokenUiTimer = null;
      const n = this._pendingSidebarTokens;
      if (typeof n !== 'number') return;
      try {
        document.dispatchEvent(new CustomEvent('grok-remote:agent-tokens', {
          detail: { id: this.agentId, totalTokens: n },
        }));
      } catch { /* ignore */ }
    }, 200);
  }

  _renderTokensPill() {
    paintTokensPill(this);
  }

  _openContextPanel() { return openContextPanel(this); }
  _closeContextPanel() { closeContextPanel(this); }

  _renderModelPill() {
    if (!this.modelPill) return;
    if (!this.agentId) {
      this.modelPill.hidden = true;
      this.modelPill.replaceChildren();
      return;
    }
    const cur = this._currentModelSettings();
    const model = cur.model || 'default';
    const live = cur.liveModel && cur.liveModel !== model ? cur.liveModel : '';
    const effort = cur.effort || 'default';
    const win = (this._contextWindow && this._contextWindow.window) || (this.currentAgent && this.currentAgent.contextWindow);
    const winLabel = typeof win === 'number' && win > 0 ? formatTokensShort(win) : '';
    this.modelPill.hidden = false;
    this.modelPill.replaceChildren(
      el('span', { class: 'tab-model__id' }, model),
      ...(live ? [el('span', { class: 'tab-model__sep' }, '·'), el('span', { class: 'tab-model__live' }, live)] : []),
      ...(winLabel ? [el('span', { class: 'tab-model__sep' }, '·'), el('span', { class: 'tab-model__window' }, winLabel)] : []),
      el('span', { class: 'tab-model__sep' }, '·'),
      el('span', { class: 'tab-model__effort' }, effort),
    );
    this.modelPill.title = [
      `Model ${model}`,
      live ? `live ${live}` : '',
      winLabel ? `window ${winLabel}` : '',
      `Effort ${effort}`,
      'click to change',
    ].filter(Boolean).join(' · ');
    this._paintModelNotice();
    this._ensureModelCatalog();
  }

  _ensureModelCatalog() {
    if (this._modelCatalog || this._modelCatalogLoading) return;
    this._modelCatalogLoading = true;
    void this._loadModelChoices().then((items: any) => {
      this._modelCatalog = items;
      this._modelCatalogLoading = false;
      this._paintModelNotice();
    }).catch(() => { this._modelCatalogLoading = false; });
  }

  _paintModelNotice() {
    const host = this.composerEl;
    if (!host) return;
    const cur = this._currentModelSettings();
    const items = Array.isArray(this._modelCatalog) ? this._modelCatalog : [];
    const hit = items.find((c: any) => c && (c.id === cur.model || c.id === cur.liveModel));
    const text = hit && hit.notice ? String(hit.notice) : '';
    let banner = host.querySelector('.model-notice') as HTMLElement | null;
    if (!text) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = el('div', { class: 'model-notice' });
      host.insertBefore(banner, host.firstChild);
    }
    if (banner.textContent !== text) banner.textContent = text;
  }

  _paintCwdChip() {
    if (!this.cwdChipEl) return;
    paintCwdChip(this.cwdChipEl, this.currentAgent && this.currentAgent.cwd);
  }

  _paintConvoTitle() {
    if (!this.convoTitleEl || !this.convoHeadEl) return;
    const name = String((this.currentAgent && this.currentAgent.name) || '').trim();
    if (!this.agentId || !name) {
      this.convoHeadEl.hidden = true;
      this.convoTitleEl.textContent = '';
      return;
    }
    this.convoHeadEl.hidden = false;
    this.convoTitleEl.hidden = false;
    this.convoTitleEl.textContent = name;
    this.convoTitleEl.title = name + ' — tap to rename';
    try {
      const base = 'Grok Remote';
      document.title = name + ' · ' + base;
    } catch { /* ignore */ }
  }

  _beginRenameConvoTitle() {
    if (!this.agentId || !this.convoHeadEl || !this.convoTitleEl) return;
    const prev = String((this.currentAgent && this.currentAgent.name) || '').trim();
    if (!prev) return;
    const input = el('input', {
      class: 'chat-convo-rename',
      type: 'text',
      value: prev,
      onkeydown: (ev: any) => {
        if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); }
        else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.target.dataset.cancel = '1';
          ev.target.blur();
        }
      },
      onblur: async (ev: any) => {
        const cancel = ev.target.dataset.cancel === '1';
        const next = String(ev.target.value || '').trim();
        this.convoHeadEl.replaceChildren(this.convoTitleEl);
        if (cancel || !next || next === prev) {
          this._paintConvoTitle();
          return;
        }
        try {
          const updated: any = await api.updateAgent(this.agentId, { name: next });
          this.applyAgentRefresh(updated);
          try { document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh')); } catch { /* ignore */ }
        } catch (e: any) {
          this.showToast(`Rename failed: ${e && e.message ? e.message : e}`, 'warn');
          this._paintConvoTitle();
        }
      },
    });
    this.convoHeadEl.replaceChildren(input);
    input.focus();
    input.select();
  }

  _paintModePill() {
    if (!this.modePill) return;
    if (!this.agentId) {
      this.modePill.hidden = true;
      this.modePill.replaceChildren();
      return;
    }
    const plan = !!this._planArmed || !!(this.root && this.root.querySelector('.plan-card:not(.plan-card--q)'));
    const mode = this._permissionMode();
    this.modePill.hidden = false;
    this.modePill.textContent = plan ? 'Plan' : permissionLabel(mode);
    this.modePill.classList.toggle('tab-mode--plan', plan);
    this.modePill.classList.toggle('tab-mode--ask', !plan && mode === 'ask');
    this.modePill.classList.toggle('tab-mode--auto', !plan && mode === 'auto');
    this.modePill.title = plan
      ? 'Plan mode — click to change'
      : `${permissionLabel(mode)} — click to change`;
  }

  _openModeMenu() {
    if (!this.modePill || !this.agentId) return;
    const mode = this._permissionMode();
    const plan = !!this._planArmed || !!(this.root && this.root.querySelector('.plan-card:not(.plan-card--q)'));
    openPopMenu({
      anchor: this.modePill,
      items: [
        { label: 'Ask', active: !plan && mode === 'ask', onSelect: () => { void this._setPermissionMode('ask'); } },
        { label: 'Auto', active: !plan && mode === 'auto', onSelect: () => { void this._setPermissionMode('auto'); } },
        { label: 'Always-Approve', active: !plan && mode === 'always-approve', onSelect: () => { void this._setPermissionMode('always-approve'); } },
        { label: 'Plan', active: plan, onSelect: () => { void this._armPlan(); } },
      ],
    });
  }

  _openMoreMenu() {
    if (!this.moreBtn) return;
    const toolsOpen = !this._chatSplitCollapsed;
    const a = this.currentAgent;
    const disconnected = !!(a && (a.status === 'disconnected' || a.status === 'exited'));
    openPopMenu({
      anchor: this.moreBtn,
      items: [
        { label: 'Files', onSelect: () => this.switchTab('files') },
        { label: 'Info', onSelect: () => this.switchTab('info') },
        { label: 'Trace', onSelect: () => this.switchTab('trace') },
        { label: 'Flow', onSelect: () => this.switchTab('flow') },
        { label: 'Todos', onSelect: () => this._toggleCliPane('todos') },
        { label: 'Tasks', onSelect: () => this._toggleCliPane('tasks') },
        { label: 'Find', onSelect: () => this._toggleFindBar() },
        { label: 'Context', onSelect: () => { void this._openContextPanel(); } },
        { label: 'Copy Last Reply', onSelect: () => { void this.copyLastReply(); } },
        { label: 'Copy Markdown', onSelect: () => { void this.copyConversation(); } },
        { label: 'Download .md', onSelect: () => this.downloadConversation() },
        { label: `Timestamps: ${timestampModeLabel(timestampMode())}`, onSelect: () => this._toggleTimestamps() },
        { label: toolsOpen ? 'Hide Tool Calls' : 'Show Tool Calls', onSelect: () => this._toggleToolsCol() },
        { label: disconnected ? 'Connect' : 'Disconnect', onSelect: () => { void this.toggleConnection(); } },
      ],
    });
  }

  async _armPlan() {
    this._planArmed = true;
    this._paintModePill();
    const prev = this.composerTa ? this.composerTa.value : '';
    if (this.composerTa) this.composerTa.value = '/plan';
    await this.send();
    if (this.composerTa && prev && !this.composerTa.value) this.composerTa.value = prev;
  }

  async toggleStar() {
    if (!this.agentId) return;
    const cur = !!(this.currentAgent && this.currentAgent.starred);
    this.starBtn.disabled = true;
    try {
      const updated = await api.updateAgent(this.agentId, { starred: !cur });
      this.applyAgentRefresh(updated);
    } catch (e: any) {
      this.showToast(`Star failed: ${e.message}`, 'warn');
    } finally {
      this.starBtn.disabled = false;
    }
  }

  _syncStarBtn() {
    if (!this.starBtn) return;
    const on = !!(this.currentAgent && this.currentAgent.starred);
    this.starBtn.classList.toggle('is-on', on);
    // Don't overwrite textContent: the SVG icon lives in the inner
    // .tab-action-ico span. The .is-on class drives the filled vs.
    // outlined visual via CSS.
    this.starBtn.title = on ? 'Unstar this conversation' : 'Star this conversation';
    this.starBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  async toggleConnection() {
    if (!this.agentId) return;
    const a = this.currentAgent;
    const disconnected = !!(a && (a.status === 'disconnected' || a.status === 'exited'));
    this.connectBtn.disabled = true;
    try {
      if (disconnected) {
        await api.connect(this.agentId);
        this.showToast('Connecting…', 'info');
      } else {
        await api.disconnect(this.agentId);
        this.showToast('Disconnected. Sending a message will reconnect.', 'info');
      }
    } catch (e: any) {
      this.showToast(`${disconnected ? 'Connect' : 'Disconnect'} failed: ${e.message}`, 'warn');
    } finally {
      this.connectBtn.disabled = false;
      // The sidebar's 4 s poll will refresh state shortly; force one quick
      // refresh so the chat header label updates immediately.
      setTimeout(() => {
        api.getAgent(this.agentId).then((fresh) => this.applyAgentRefresh(fresh)).catch(() => {});
      }, 500);
    }
  }

  applyAgentRefresh(a: any) {
    if (!a || a.id !== this.agentId) return;
    if (!this._isReplaying) {
      this._turnOpen = followServerTurnOpen({
        local: !!this._turnOpen,
        server: typeof a.turnOpen === 'boolean' ? a.turnOpen : null,
        holdUntil: this._turnOpenHoldUntil,
      });
    }
    const working = !this._isReplaying && isDisplayedWorking({
      turnOpen: !!this._turnOpen,
      inFlight: Math.max(
        typeof a.inFlight === 'number' ? a.inFlight : 0,
        this._localInFlightCount(),
      ),
    });
    if (working && a.status === 'idle') a = { ...a, status: 'running' };
    else if (!working && a.status === 'running') a = { ...a, status: 'idle' };
    if (!working) {
      try {
        document.dispatchEvent(new CustomEvent('grok-remote:agent-working', {
          detail: { id: this.agentId, working: false },
        }));
      } catch { /* ignore */ }
    }
    if (shouldClearErrorBanners(this.currentAgent, a)) this._clearErrorBanners();
    this.currentAgent = a;
    if (typeof a.totalTokens === 'number' && Number.isFinite(a.totalTokens) && a.totalTokens >= 0) {
      const live = this.latestTotalTokens;
      const liveAt = this._tokensLiveAt || 0;
      // A list poll started before compact can still carry the old total.
      // Do not paint that over a live drop that just landed.
      const staleHigher = typeof live === 'number'
        && a.totalTokens > live
        && (Date.now() - liveAt) < 15000;
      if (!staleHigher) this.latestTotalTokens = a.totalTokens;
    }
    applyContextWindow(this, {
      window: a.contextWindow,
      compactAtPercent: a.compactAtPercent,
      compactAtKnown: a.compactAtKnown === true,
      windows: a.contextWindows,
      model: a.model,
    });
    this._syncConnectBtn();
    this._syncStarBtn();
    // Re-render info tab if visible so status/sessionId etc. stay current.
    if (this.tabsState === 'info') this.renderInfo(a);
    // Keep the drawer's "reconnect to apply" notice in sync with status.
    if (this.settingsDrawerOpen) this._updateSettingsNotice(a);
    this._renderTokensPill();
    this._renderModelPill();
    this._paintCwdChip();
    this._paintModePill();
    this._paintLiveStatus();
    this._paintConvoTitle();
  }

  _syncConnectBtn() {
    if (!this.connectBtn) return;
    const a = this.currentAgent;
    const disconnected = !!(a && (a.status === 'disconnected' || a.status === 'exited'));
    this.connectBtn.textContent = disconnected ? 'Connect' : 'Disconnect';
    this.connectBtn.classList.toggle('tab-action--off', disconnected);
    this.connectBtn.title = disconnected
      ? 'Reconnect: resume the conversation in a fresh agent process.'
      : 'Disconnect: stop the agent process but keep the conversation.';
  }

  _conversationMarkdown() {
    return serializeConversation(this.turns, { agent: this.currentAgent || { id: this.agentId } });
  }

  _exportFilename() {
    const raw = String((this.currentAgent && this.currentAgent.name) || this.agentId || 'conversation');
    const slug = raw.replace(/[^\w\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'conversation';
    const day = new Date().toISOString().slice(0, 10);
    return `${slug}-${day}.md`;
  }

  _closeExportMenu() {
    if (this.exportMenuEl) {
      this.exportMenuEl.hidden = true;
      this.exportMenuEl.replaceChildren();
    }
  }

  _toggleExportMenu() {
    if (!this.exportMenuEl) return;
    if (!this.exportMenuEl.hidden) { this._closeExportMenu(); return; }
    const mk = (label: string, run: () => void) => el('button', {
      type: 'button',
      class: 'export-menu__item',
      onclick: async (ev: any) => {
        ev.stopPropagation();
        this._closeExportMenu();
        try { await run(); } catch (e: any) {
          this.showToast(e && e.message ? e.message : String(e), 'warn');
        }
      },
    }, label);
    const items = [
      mk('Copy Markdown', () => this.copyConversation()),
      mk('Download .md', () => this.downloadConversation()),
    ];
    if (typeof navigator !== 'undefined' && typeof (navigator as any).share === 'function') {
      items.push(mk('Share…', () => this.shareConversation()));
    }
    this.exportMenuEl.replaceChildren(...items);
    this.exportMenuEl.hidden = false;
    const host = (this.copyConvoBtn && this.copyConvoBtn.parentElement) || this.root;
    if (host && this.exportMenuEl.parentNode !== host) host.appendChild(this.exportMenuEl);
    const onDoc = (ev: any) => {
      if (this.exportMenuEl && !this.exportMenuEl.contains(ev.target) && ev.target !== this.copyConvoBtn) {
        this._closeExportMenu();
        document.removeEventListener('click', onDoc);
      }
    };
    setTimeout(() => document.addEventListener('click', onDoc), 0);
  }

  _toggleTimestamps() {
    const next = cycleTimestampMode();
    const label = timestampModeLabel(next);
    this.showToast(next === 'minimal' ? 'Timestamps show on hover.' : `Timestamps ${label.toLowerCase()}.`, 'info');
  }

  async copyLastReply(n = 1) {
    const text = nthLastAssistant(this.turns || [], n);
    if (!text) {
      this.showToast('No reply to copy.', 'warn');
      return;
    }
    const ok = await copyToClipboard(text);
    this.showToast(ok ? (n > 1 ? `Copied reply #${n}.` : 'Reply copied.') : 'Copy failed.', ok ? 'info' : 'fail');
  }

  async copyConversation() {
    if (!this.agentId) {
      this.showToast('No conversation selected.', 'warn');
      return;
    }
    const text = this._conversationMarkdown();
    const ok = await copyToClipboard(text);
    if (ok) {
      this.flashBtnLabel(this.copyConvoBtn, 'Copied');
      this.showToast('Conversation copied.', 'info');
    } else {
      this.showToast('Copy failed.', 'fail');
    }
  }

  downloadConversation() {
    if (!this.agentId) {
      this.showToast('No conversation selected.', 'warn');
      return;
    }
    const text = this._conversationMarkdown();
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this._exportFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast('Download started.', 'info');
  }

  async shareConversation() {
    if (!this.agentId) return;
    const text = this._conversationMarkdown();
    const title = String((this.currentAgent && this.currentAgent.name) || 'Conversation');
    try {
      await (navigator as any).share({ title, text });
    } catch (e: any) {
      if (e && e.name === 'AbortError') return;
      const ok = await copyToClipboard(text);
      this.showToast(ok ? 'Share unavailable. Copied instead.' : 'Share failed.', ok ? 'info' : 'warn');
    }
  }

  flashBtnLabel(btn: any, tempLabel: any) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = tempLabel;
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 1200);
  }

  switchTab(key: any) {
    this.tabsState = key;
    for (const [k, btn] of Object.entries(this.tabBtns)) {
      (btn as any).classList.toggle('tab--active', k === key);
    }
    const convo = this.root.querySelector('.pane--conversation');
    if (convo) convo.classList.toggle('hidden', key !== 'conversation');
    this.filesPane.classList.toggle('hidden', key !== 'files');
    this.infoPane.classList.toggle('hidden', key !== 'info');
    this.tracePane.classList.toggle('hidden', key !== 'trace');
    this.flowPane.classList.toggle('hidden', key !== 'flow');

    if (key === 'files') {
      if (this.agentId) {
        mountFilesTab(this.filesPane, { id: this.agentId });
        this.filesMounted = true;
        // The Files singleton just moved into the top-bar pane; clear the
        // tools-column's stale shell so it doesn't look duplicated.
        if (this._toolsFilesMounted) {
          this._toolsFilesMounted = false;
          if (this.toolsFilesPaneEl) this.toolsFilesPaneEl.replaceChildren();
        }
      } else if (!this.filesMounted) {
        this.filesPane.replaceChildren(el('div', { class: 'pane-empty' }, 'No agent selected'));
      }
    } else if (this.filesMounted) {
      unmountFilesTab();
      this.filesMounted = false;
    }

    // Trace tab: always re-fetch and re-render on every open. The mount
    // function unmounts any prior trace state first, so this is safe.
    if (key === 'trace') {
      if (this.agentId) {
        mountTraceTab(this.tracePane, this.currentAgent || { id: this.agentId });
        this.traceMounted = true;
      } else {
        this.tracePane.replaceChildren(el('div', { class: 'pane-empty' }, 'No agent selected'));
      }
    } else if (this.traceMounted) {
      unmountTraceTab();
      this.traceMounted = false;
    }

    // Flow tab: scoped to just this conversation's agent. Lazily mounts
    // the same ReactFlow component as the global #/flow page but with a
    // filterIds prop so only this agent's node + tool-call satellites show.
    if (key === 'flow') {
      if (this.agentId) {
        mountFlowTab(this.flowPane, [this.agentId]);
        this.flowMounted = true;
      } else {
        this.flowPane.replaceChildren(el('div', { class: 'pane-empty' }, 'No agent selected'));
      }
    } else if (this.flowMounted) {
      unmountFlowTab();
      this.flowMounted = false;
    }

    if (key === 'info') {
      this.renderInfo(this.currentAgent);
    }
  }

  // Snap the chat view to the conversation tab with the tools sidebar
  // collapsed. Called by main.js both on a freshly-created conversation
  // (AgentsSidebar.onCreate) and on a sidebar selection
  // (AgentsSidebar.onSelect) so picking any chat from the list always
  // lands the user looking at the messages, not a leftover Files/Flow
  // tab or a wide tools column from a previous agent.
  focusConversation() {
    this.switchTab('conversation');
    if (!this._chatSplitCollapsed) this._toggleToolsCol();
  }

  // Back-compat alias for older call sites. New code should use
  // focusConversation().
  beginNewConversation() { this.focusConversation(); }

  buildComposer() {
    const ta = el('textarea', {
      class: 'composer-input',
      rows: '3',
      placeholder: 'Message the agent. Enter to send, double Enter to send now.',
      title: 'Enter to send · Double Enter to send now · Shift+Enter for a newline · Type / for commands · Type @ to mention a file',
      onkeydown: (ev: any) => {
        if (this._onPromptHistKey(ev)) return;
        if (shouldSendComposerEnter(ev)) {
          ev.preventDefault();
          this.send({ viaEnter: true });
        }
      },
    });
    const sendBtn = el('button', {
      class: 'btn btn--primary composer-send',
      onclick: () => this.send(),
    }, 'Send');
    const cancelBtn = el('button', {
      class: 'btn btn--ghost composer-cancel',
      'data-short': 'Cancel',
      onclick: () => this.cancel(),
    }, 'Cancel Turn');

    // Hidden file input used by the "attach image" button.
    const fileInput = el('input', {
      type: 'file',
      class: 'composer-file-input',
      accept: 'image/*',
      multiple: '',
      style: { display: 'none' },
    });
    const attachBtn = el('button', {
      class: 'btn btn--ghost composer-attach',
      'data-short': 'Image',
      title: 'Attach image (saved to agent uploads/ folder)',
      onclick: (ev: any) => { ev.preventDefault(); fileInput.click(); },
    }, 'Attach Image');

    const debugBtn = el('button', {
      class: 'btn btn--ghost composer-debug',
      type: 'button',
      title: 'Preview the exact JSON payload that will be sent (composer + attachments), plus the last server-composed prompt if one exists.',
      onclick: (ev: any) => { ev.preventDefault(); this.openPayloadInspector(); },
    }, '{ payload }');
    // Hidden by default; surfaced when settings.debug is true.
    debugBtn.hidden = true;
    this.composerDebugBtn = debugBtn;

    // Caption row used to show the slash-command hint after a commit.
    const hintCaption = el('div', { class: 'composer-hint hidden' });

    const histBtn = el('button', {
      class: 'btn btn--ghost composer-hist',
      type: 'button',
      'data-short': 'Hist',
      title: 'Prompt history (↑ / ↓ like the CLI)',
      onclick: (ev: any) => {
        ev.preventDefault();
        this._togglePromptHist();
      },
    }, 'History');
    this.promptHistBtn = histBtn;
    this.promptHistEl = el('div', { class: 'prompt-hist', hidden: true });

    const slashBtn = el('button', {
      class: 'btn btn--ghost composer-slash',
      type: 'button',
      title: 'Open Grok Build commands (/)',
      onclick: (ev: any) => {
        ev.preventDefault();
        if (!this.composerTa || this.composerTa.disabled) return;
        this.composerTa.value = '/';
        this.composerTa.focus();
        this.composerTa.dispatchEvent(new Event('input', { bubbles: true }));
      },
    }, '/');

    const chipRow = el('div', { class: 'shortcut-chips' });
    for (const chip of SHORTCUT_CHIPS) {
      chipRow.appendChild(el('button', {
        class: 'shortcut-chip',
        type: 'button',
        title: '/' + chip.name,
        onclick: (ev: any) => {
          ev.preventDefault();
          this._applyShortcut(chip.name);
        },
      }, chip.label));
    }

    this.queueBarEl = el('div', { class: 'composer-queue', hidden: true });
    this.composerTa        = ta;
    this.composerSend      = sendBtn;
    this.composerCancel    = cancelBtn;
    this.composerFileInput = fileInput;
    this.composerAttachBtn = attachBtn;
    this.composerHint      = hintCaption;
    // Kept around (hidden) for back-compat with any leftover CSS hooks; the
    // new slash-palette module creates its own floating panel.
    this.palette = el('div', { class: 'command-palette hidden' });

    return el('div', { class: 'composer' },
      this.palette,
      this.atPaletteEl || (this.atPaletteEl = el('div', { class: 'at-palette hidden' })),
      this.promptHistEl,
      chipRow,
      this.queueBarEl,
      hintCaption,
      ta,
      el('div', { class: 'composer-actions' },
        slashBtn,
        histBtn,
        attachBtn,
        debugBtn,
        fileInput,
        cancelBtn,
        sendBtn,
      ),
    );
  }

  _attachComposerExtras() {
    if (this._detachPalette) {
      try { this._detachPalette(); } catch { /* ignore */ }
      this._detachPalette = null;
    }
    if (this.imageAttach) {
      try { this.imageAttach.destroy(); } catch { /* ignore */ }
      this.imageAttach = null;
    }
    if (!this.composerTa) return;

    this._detachPalette = attachSlashPalette({
      textarea: this.composerTa,
      getCommands: () => this._mergedCommands(),
      onCommit: ({ command, hint, run }) => {
        const cname = command && command.name ? String(command.name).toLowerCase() : '';
        if (cname === 'rewind' || cname === 'undo') { this._openRewindPicker(); return; }
        if (cname === 'fork') { void this._forkSession(); return; }
        if (cname === 'always-approve') { void this._toggleAlwaysApprove(); return; }
        if (cname === 'auto') { void this._setPermissionMode('auto'); return; }
        if (cname === 'model' || cname === 'm' || cname === 'effort') {
          this._openModelPicker({ effortOnly: cname === 'effort' });
          return;
        }
        if (cname === 'copy') { void this.copyLastReply(1); return; }
        if (cname === 'export') { this.downloadConversation(); return; }
        if (cname === 'timestamps') { this._toggleTimestamps(); return; }
        if (cname === 'context' || cname === 'session-info' || cname === 'context-window') {
          if (cname === 'context-window') this._openModelPicker();
          else void this._openContextPanel();
          return;
        }
        if (cname === 'compact') { void this._runCompact(); return; }
        if (command && command.kind === 'local' && typeof command.href === 'string' && command.href) {
          window.location.hash = command.href;
          if (this.composerHint) {
            this.composerHint.classList.add('hidden');
            this.composerHint.textContent = '';
          }
          return;
        }
        if (run) { void this.send(); return; }
        if (hint && this.composerHint) {
          this.composerHint.textContent = `Usage: /${command.name} ${hint}`;
          this.composerHint.classList.remove('hidden');
        } else if (this.composerHint) {
          this.composerHint.classList.add('hidden');
          this.composerHint.textContent = '';
        }
      },
    });

    this.imageAttach = setupImageAttach({
      container: this.composerEl,
      textarea: this.composerTa,
      fileInput: this.composerFileInput,
      canAttachImages: () => this._canAttachImages(),
      onChange: ({ error }) => {
        if (error) this.showToast(error, 'warn');
        this._syncAttachBtn();
      },
    });
    this._syncAttachBtn();
    if (this.composerTa && !this.composerTa.dataset.atWired) {
      this.composerTa.dataset.atWired = '1';
      this.composerTa.addEventListener('input', () => this._onAtQuery());
      this.composerTa.addEventListener('keydown', (ev: any) => this._onAtKey(ev), true);
    }
    if (!this._cliKeysWired) {
      this._cliKeysWired = true;
      this._onCliKeys = (ev: KeyboardEvent) => {
        const t = ev.target as HTMLElement | null;
        const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === 'T' || ev.key === 't')) {
          ev.preventDefault();
          this._toggleCliPane('todos');
          return;
        }
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && (ev.key === 'G' || ev.key === 'g')) {
          ev.preventDefault();
          this._toggleCliPane('tasks');
          return;
        }
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && (ev.key === 'f' || ev.key === 'F')) {
          if (this.root && this.root.contains(t as Node)) {
            ev.preventDefault();
            this._toggleFindBar(true);
          }
          return;
        }
        if (ev.key === 'Escape' && !inField) {
          this._closeCliPane();
          this._closeFindBar();
        }
      };
      document.addEventListener('keydown', this._onCliKeys);
    }
  }

  _canAttachImages() {
    return !!this._promptCapImage;
  }

  // Lazy-load the set of known skill names. We use it to decorate user
  // messages that start with `/<name>` matching a real skill. Cached for
  // the lifetime of this ChatView instance.
  async _loadSkills() {
    if (this._knownSkills) return this._knownSkills;
    if (this._skillsPromise) return this._skillsPromise;
    this._skillsPromise = (async () => {
      try {
        const data: any = await api.skills.list();
        const set = new Set();
        const palette = [];
        const seenNames = new Set();
        for (const s of ((data && data.skills) || [])) {
          if (!s || typeof s.name !== 'string' || !s.name) continue;
          set.add(s.name);
          // Deduplicate by name so the same skill from multiple scopes only
          // shows once in the palette (scope shadowing: cwd > repo > user).
          if (seenNames.has(s.name)) continue;
          seenNames.add(s.name);
          palette.push({
            name: s.name,
            description: s.description || s.title || '',
            kind: 'skill',
            scope: s.scope || '',
          });
        }
        this._knownSkills = set;
        this._skillCommands = palette;
        return set;
      } catch {
        this._knownSkills = new Set();
        this._skillCommands = [];
        return this._knownSkills;
      }
    })();
    return this._skillsPromise;
  }

  // Attach an "invoked skill" banner to the turn root when the user
  // message starts with /name and `name` matches a known skill. Banner
  // links to #/skills so the user can jump straight to the skill page.
  _decorateSkill(turn: any) {
    if (!turn || !turn.userText) return;
    const m = turn.userText.match(/^\s*\/([A-Za-z][\w-]*)\b/);
    if (!m) return;
    const name = m[1];
    Promise.resolve(this._knownSkills || this._loadSkills()).then((set) => {
      if (!set || !set.has(name)) return;
      // Record into the per-conversation set (idempotent, count via Map).
      const prior = this._convoSkills.get(name) || 0;
      this._convoSkills.set(name, prior + 1);
      this._renderConvoSkillsStrip();
      // Fire-and-forget usage metric bump. Don't block paint.
      try { api.skills.use(name, this.agentId).catch(() => {}); } catch { /* ignore */ }

      if (turn._skillBanner) return;
      const banner = el('div', { class: 'skill-banner', title: 'Invoked skill (click to open the Skills page)' });
      banner.innerHTML = `
        <span class="skill-banner-ico">${iconHtml('skills')}</span>
        <span class="skill-banner-label">Invoked skill</span>
        <a class="skill-banner-name" href="#/settings/skills">/${name}</a>
      `;
      turn._skillBanner = banner;
      // Banner sits ABOVE the user bubble so the chronology reads:
      //   skill chip then user message then assistant turn.
      turn.root.insertBefore(banner, turn.user);
    });
  }

  _renderConvoSkillsStrip() {
    const entries = Array.from(this._convoSkills.entries()) as any[];
    entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    this.liveBar.replaceKind('skill', entries.map(([name, count]) => ({
      id: 'skill:' + name,
      kind: 'skill' as const,
      type: 'Skill',
      label: `/${name}`,
      title: `Invoked ${count}× in this conversation`,
      href: '#/settings/skills',
    })));
  }

  _captureAgentCaps(agent: any) {
    // Images are now always allowed: the backend saves attachments to the
    // agent's uploads/ folder, so any model can use them via its own tools.
    // We still track the model's native image capability for informational
    // purposes (Info tab), but it no longer gates the attach button.
    this._promptCapImage = true;
    void agent;
    this._syncAttachBtn();
    if (this.imageAttach) this.imageAttach.refreshSupport();
  }

  _syncAttachBtn() {
    if (!this.composerAttachBtn) return;
    this.composerAttachBtn.disabled = false;
    this.composerAttachBtn.classList.remove('is-disabled');
  }

  setAvailableCommands(list: any) {
    if (!Array.isArray(list)) return;
    this.availableCommands = list;
  }

  _mergedCommands() {
    // Merge agent-advertised commands, Grok Build builtins, and skills.
    // Agent commands win on name conflict (they're the live API).
    const agentNames = new Set();
    const out = [];
    for (const c of (this.availableCommands || [])) {
      if (!c || typeof c.name !== 'string') continue;
      agentNames.add(c.name);
      out.push(c);
    }
    for (const c of GROK_BUILD_COMMANDS) {
      if (!c || agentNames.has(c.name)) continue;
      agentNames.add(c.name);
      out.push(c);
    }
    for (const s of (this._skillCommands || [])) {
      if (!s || agentNames.has(s.name)) continue;
      out.push(s);
    }
    return out;
  }

  _applyShortcut(name: string) {
    if (!this.composerTa || this.composerTa.disabled) return;
    const cmd = (this._mergedCommands() || []).find((c: any) => c && c.name === name);
    if (name === 'model' || name === 'm' || name === 'effort') {
      if (name === 'effort') {
        this.composerTa.value = '/effort ';
        this.composerTa.focus();
        if (this.composerHint) {
          this.composerHint.textContent = 'Usage: /effort low|medium|high|xhigh';
          this.composerHint.classList.remove('hidden');
        }
        return;
      }
      this._openModelPicker();
      return;
    }
    if (cmd && cmd.kind === 'local' && typeof cmd.href === 'string' && cmd.href) {
      window.location.hash = cmd.href;
      return;
    }
    const insert = '/' + name + ' ';
    this.composerTa.value = insert;
    this.composerTa.focus();
    try {
      const pos = insert.length;
      this.composerTa.setSelectionRange(pos, pos);
    } catch { /* ignore */ }
    this.composerTa.dispatchEvent(new Event('input', { bubbles: true }));
    const hint = cmd && cmd.input && cmd.input.hint ? String(cmd.input.hint) : '';
    if (this.composerHint) {
      if (hint) {
        this.composerHint.textContent = `Usage: /${name} ${hint}`;
        this.composerHint.classList.remove('hidden');
      } else {
        this.composerHint.classList.add('hidden');
        this.composerHint.textContent = '';
      }
    }
  }

  _setComposerEnabled(enabled: any) {
    if (!this.composerTa) return;
    this.composerTa.disabled = !enabled;
    this.composerSend.disabled = !enabled;
    // Cancel is owned by _paintLiveStatus. Enabling the composer used to
    // disable it, so a live turn could not be cancelled after a refresh.
    if (!enabled && this.composerCancel) this.composerCancel.disabled = true;
    else if (typeof this._paintLiveStatus === 'function') this._paintLiveStatus();
  }

  setAgent(agent: any) {
    // Same conversation already on screen: do not wipe and refetch.
    // Hash/sidebar refresh used to rebuild the stream every time, which
    // blinks the chat (loading overlay + SSE restream).
    if (agent && this.agentId === agent.id && this._historyLoaded) {
      this.applyAgentRefresh(agent);
      this._setComposerEnabled(true);
      if (!this.stream || this.stream.isClosed()) this.openStreamForCurrent();
      void this._ensureConnected();
      return;
    }
    if (this.agentId) saveAgentQueue(this.agentId, this._promptQueue);
    // agent: { id, ... } or null
    this.closeStream();
    this._cancelChatIntro();
    this.streamEl.replaceChildren();
    if (this.toolsStreamEl) this.toolsStreamEl.replaceChildren();
    removeRootBlockingCards(this.root);
    this.turns = [];
    this.activeTurn = null;
    this._turnOpen = false;
    this._turnOpenHoldUntil = 0;
    this._quietScroll = false;
    // Fire-and-forget skill cache warmup so the banner can paint as soon
    // as a /name message lands. Harmless if the agent has none.
    this._loadSkills();
    this.statusEl.textContent = '';
    this.palette.classList.add('hidden');
    this.palette.replaceChildren();
    this.toastHost.replaceChildren();
    this.composerTa.value = '';
    if (this.composerHint) {
      this.composerHint.classList.add('hidden');
      this.composerHint.textContent = '';
    }
    this._compacting = false;
    this._compactFinished = false;
    this._compactFinishedAt = 0;
    this._compactSucceeded = false;
    this._compactWait = null;
    this._compactCard = null;
    this._promptQueue = null;
    this._flushingQueue = false;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (agent && agent.id) this._promptQueue = loadAgentQueue(agent.id);
    this._renderQueueBar();
    if (this.imageAttach) this.imageAttach.clear();
    this._promptCapImage = false;
    this._syncAttachBtn();
    if (agent) this._captureAgentCaps(agent);

    if (this.filesMounted) {
      unmountFilesTab();
      this.filesMounted = false;
    }
    // Tools-column files view shares the same singleton as the top-bar
    // Files tab. Unmount before remounting against the new agent.
    if (this._toolsFilesMounted) {
      unmountFilesTab();
      this._toolsFilesMounted = false;
      if (this.toolsFilesPaneEl) this.toolsFilesPaneEl.replaceChildren();
    }
    if (this.traceMounted) {
      unmountTraceTab();
      this.traceMounted = false;
      this.tracePane.replaceChildren();
    }
    if (this.flowMounted) {
      unmountFlowTab();
      this.flowMounted = false;
      this.flowPane.replaceChildren();
    }

    if (!agent || !agent.id) {
      this.agentId = null;
      this.currentAgent = null;
      this.streamEl.appendChild(this.empty);
      this.infoPane.replaceChildren(el('div', { class: 'pane-empty' }, 'No agent selected'));
      this.filesPane.replaceChildren();
      if (this.toolsFilesPaneEl && this._toolsColTab === 'files') {
        this.toolsFilesPaneEl.replaceChildren(
          el('div', { class: 'pane-empty' }, 'No agent selected'),
        );
      }
      this._setComposerEnabled(false);
      // Hide the star + connect buttons until an agent is loaded.
      if (this.starBtn)     this.starBtn.hidden = true;
      if (this.settingsBtn) this.settingsBtn.hidden = true;
      if (this.connectBtn)  this.connectBtn.hidden = true;
      clearContextWindow(this);
      if (this.tokensPill)  this.tokensPill.hidden = true;
      if (this.modelPill)   this.modelPill.hidden = true;
      if (this.modePill)    this.modePill.hidden = true;
      if (this.cwdChipEl)   this.cwdChipEl.hidden = true;
      if (this.inflightPill) this.inflightPill.hidden = true;
      this._paintConvoTitle();
      this.closeSettingsDrawer();
      return;
    }
    if (this.starBtn)     this.starBtn.hidden = false;
    if (this.settingsBtn) this.settingsBtn.hidden = false;
    if (this.connectBtn)  this.connectBtn.hidden = false;

    const switchingAgent = this.agentId !== agent.id;
    if (switchingAgent) {
      clearContextWindow(this);
      this._clearAllInFlight();
      this._clearAllSubagents();
      this._childSessionIds = new Set();
      this._activeTodoCard = null;
      if (this.todoDock) this.todoDock.clear();
      this._stopBgTerminalsPolling();
      this._convoSkills = new Map();
      this._renderConvoSkillsStrip();
    }
    this.agentId = agent.id;
    this.currentAgent = agent;
    api.getAgent(agent.id).then((fresh) => {
      if (this.agentId === agent.id) this.applyAgentRefresh(fresh);
    }).catch(() => {});
    this._fileIndex = [];
    this._closeCliPane();
    this._closeFindBar();
    this._loadPromptHist();
    this.latestTotalTokens = (agent && typeof agent.totalTokens === 'number' && agent.totalTokens >= 0)
      ? agent.totalTokens
      : null;
    if (switchingAgent) this._lastRenderedTokens = 0;
    this._startBgTerminalsPolling();
    this._setComposerEnabled(true);
    this._syncConnectBtn();
    this._renderTokensPill();
    this._renderModelPill();
    this._paintCwdChip();
    this._paintModePill();
    this._paintLiveStatus();
    this._paintConvoTitle();
    this._syncStarBtn();

    if (this.tabsState === 'files') {
      mountFilesTab(this.filesPane, { id: this.agentId });
      this.filesMounted = true;
    }

    // If the tools-column files tab is active, rebind it to the new agent's
    // files. _applyToolsColTab handles the unmount/mount via the shared
    // singleton.
    if (this._toolsColTab === 'files') {
      this._applyToolsColTab();
    }

    const agentIdAtCall = agent.id;
    const openGen = (this._openGen = (this._openGen || 0) + 1);
    this._historyLoaded = false;
    this.showStatus('Loading conversation…', 'idle');
    this._showChatLoading();
    this.refreshHistory({ turns: FIRST_LOAD_TURNS, force: true })
      .then(() => {
        if (this.agentId === agentIdAtCall && this._openGen === openGen) {
          this._paintLiveStatus();
        }
      })
      .catch((e) => {
        if (this._openGen === openGen) this.showStatus(`History load failed: ${e.message}`, 'warn');
      })
      .finally(() => {
        // A stale setAgent (hash + sidebar refresh) must not open a stream
        // or play the empty-state intro over a newer history load.
        if (this.agentId !== agentIdAtCall || this._openGen !== openGen) return;
        if (
          this._historyLoaded &&
          (!this.turns || this.turns.length === 0) &&
          !this.activeTurn &&
          !this._chatIntroAbort
        ) {
          if (this._historyTotalTurns > 0) {
            this.showStatus('Conversation did not render. Reload to try again.', 'warn');
          } else {
            this._playChatIntro();
          }
        }
        this.openStreamForCurrent();
        void this._syncPendingCards();
        void this._ensureConnected();
      });

    this.renderInfo(agent);
  }

  async _ensureConnected() {
    const id = this.agentId;
    if (!id || this._settingsReconnect) return;
    let a = this.currentAgent;
    const down = !a || !a.connected || a.status === 'disconnected' || a.status === 'exited';
    if (!down) {
      await this._catchUpHistory();
      this._paintLiveStatus();
      return;
    }
    this.showStatus('Connecting…', 'idle');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await api.connect(id);
      } catch (e: any) {
        if (attempt === 2) {
          this.showToast(`Connect failed: ${e && e.message ? e.message : String(e)}`, 'warn');
          this._paintLiveStatus();
          return;
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (this.agentId !== id) return;
        try {
          const fresh: any = await api.getAgent(id);
          this.applyAgentRefresh(fresh);
          const st = fresh && fresh.status;
          if (fresh && fresh.connected && st && st !== 'starting' && st !== 'errored') {
            await this._catchUpHistory({ force: true });
            this._paintLiveStatus();
            return;
          }
          if (st === 'errored') break;
        } catch { /* keep waiting */ }
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    this.showToast('Connect is taking longer than expected. Try again, or quit the CLI session if it still holds this conversation.', 'warn');
    this._paintLiveStatus();
  }

  // ── chat intro animation ─────────────────────────────────────────────
  //
  // When a brand-new conversation is opened (zero turns), play the
  // hole-to-GR figlet inside the chat-stream as a welcome moment. The
  // animation cancels the moment the user sends a message or an SSE
  // chunk lands (both flow through startTurn), or the user switches to
  // another agent.

  _playChatIntro() {
    if (this._chatIntroAbort) return;
    const ctrl = new AbortController();
    this._chatIntroAbort = ctrl;

    const figletEl = el('pre', { class: 'chat-intro-figlet figlet' });
    const subEl    = el('div', { class: 'chat-intro-sub' }, 'Ready for your first message');
    const wrapEl   = el('div', { class: 'chat-intro' }, figletEl, subEl);
    this._chatIntroEl = wrapEl;

    // Replace whatever was in the stream (the "no agent selected" empty
    // would only be there if no agent; in the new-conversation case the
    // stream is already empty after the history load).
    this.streamEl.replaceChildren(wrapEl);

    (async () => {
      try {
        await playIntro(figletEl, { signal: ctrl.signal });
      } catch { /* ignore */ }
      // Animation finished naturally: leave the figlet + subtitle in
      // place until a turn lands. The cancel path will tear it down.
    })();
  }

  _cancelChatIntro() {
    if (this._chatIntroAbort) {
      try { this._chatIntroAbort.abort(); } catch { /* ignore */ }
      this._chatIntroAbort = null;
    }
    if (this._chatIntroEl && this._chatIntroEl.parentNode) {
      try { this._chatIntroEl.parentNode.removeChild(this._chatIntroEl); } catch { /* ignore */ }
    }
    this._chatIntroEl = null;
  }

  renderInfo(agent: any) {
    if (!agent) {
      this.infoPane.replaceChildren(el('div', { class: 'pane-empty' }, 'No agent selected'));
      return;
    }
    const sessionId = agent.sessionId || null;
    const cwd       = agent.cwd       || '';
    const totalToks = this.latestTotalTokens != null ? this.latestTotalTokens : (agent.totalTokens != null ? agent.totalTokens : null);

    const copyValueBtn = (val: any, label: any) => {
      const btn = el('button', {
        class: 'info-copy',
        type: 'button',
        title: `Copy ${label}`,
        onclick: async () => {
          if (!val) return;
          const ok = await copyToClipboard(val);
          if (ok) {
            this.flashBtnLabel(btn, 'Copied');
          }
        },
      }, 'Copy');
      if (!val) btn.disabled = true;
      return btn;
    };

    const statusLabel: Record<string, string> = {
      idle: 'Idle', running: 'Running', errored: 'Errored', killed: 'Killed',
      starting: 'Starting', disconnected: 'Disconnected', exited: 'Disconnected',
    };
    const st = String(agent.status || '');
    const rows = [
      ['Name',      agent.name || '·'],
      ['Status',    statusLabel[st] || (st ? st[0].toUpperCase() + st.slice(1) : '·')],
      ['Model',     agent.model || '·'],
      ['Session',   sessionId || 'Pending handshake…', sessionId ? { copy: sessionId } : null],
      ['Cwd',       cwd || '·',                          cwd       ? { copy: cwd       } : null],
      ['Hostname',  agent.hostname || '·'],
      ['Version',   agent.agentVersion || '·'],
      ['Agent ID',  agent.agentId || agent.id || '·'],
      ['Instance',  agent.agentInstanceId || '·'],
      ['Created',   agent.createdAt || agent.created_at || '·'],
      ['Last seen', agent.lastSeen || agent.last_seen || '·'],
      ['Tokens',    totalToks != null ? String(totalToks) : '·'],
    ];

    const grid = el('div', { class: 'info-grid' });
    for (const row of rows) {
      const [k, v, copyOpt] = row;
      grid.appendChild(el('div', { class: 'info-k' }, k));
      if (copyOpt && copyOpt.copy) {
        grid.appendChild(el('div', { class: 'info-v info-v--with-copy' },
          el('span', { class: 'info-v-text' }, String(v)),
          copyValueBtn(copyOpt.copy, k),
        ));
      } else {
        grid.appendChild(el('div', { class: 'info-v' }, String(v)));
      }
    }

    // Resume on CLI block
    const resumeText = serializeResumeCommand({ sessionId, cwd });
    const resumeBody = el('pre', { class: 'info-resume-body' }, resumeText);
    const resumeBtn = el('button', {
      class: 'btn btn--ghost info-resume-copy',
      type: 'button',
      onclick: async () => {
        if (!sessionId) return;
        const ok = await copyToClipboard(resumeText);
        if (ok) {
          this.flashBtnLabel(resumeBtn, 'Copied');
          this.showToast('Resume command copied.', 'info');
        }
      },
    }, 'Copy Resume Command');
    if (!sessionId) resumeBtn.disabled = true;

    const resume = el('div', { class: 'info-resume' },
      el('div', { class: 'info-resume-head' },
        el('span', { class: 'info-resume-title' }, 'Resume on CLI'),
        resumeBtn,
      ),
      resumeBody,
      !sessionId
        ? el('div', { class: 'info-resume-hint' }, 'Session ID not yet assigned. The button enables once the agent finishes its handshake.')
        : null,
    );

    const publishSection = this._buildPublishSection(sessionId);

    this.infoPane.replaceChildren(grid, resume, publishSection);
  }

  // Wraps `grok share <sessionId>` via POST /api/agents/:id/publish. The
  // button is disabled until the agent has a sessionId, mirroring the
  // resume block above. Result + warning text are rendered in-place.
  _buildPublishSection(sessionId: any) {
    const wrap = el('div', { class: 'info-publish' });
    const head = el('div', { class: 'info-publish-head' },
      el('span', { class: 'info-publish-title' }, 'Publish (share)'),
    );
    const warn = el('div', { class: 'info-publish-warn' },
      'This uploads the entire session (prompts, tool calls, assistant messages) to xAI.',
      ' Do not share if it contains secrets, credentials, or private code.',
    );

    const resultHost = el('div', { class: 'info-publish-result' });
    const publishBtn = el('button', {
      class: 'btn btn--ghost info-publish-btn',
      type: 'button',
      onclick: () => this._handlePublish(publishBtn, resultHost),
    }, 'Publish Session');
    if (!sessionId) {
      publishBtn.disabled = true;
      publishBtn.title = 'Session ID not yet assigned.';
    }
    head.appendChild(publishBtn);

    wrap.appendChild(head);
    wrap.appendChild(warn);
    if (!sessionId) {
      wrap.appendChild(el('div', { class: 'info-publish-hint' },
        'Available once the agent finishes its handshake and has a session id.'));
    }
    wrap.appendChild(resultHost);
    return wrap;
  }

  async _handlePublish(btn: any, resultHost: any) {
    if (!this.agentId || !btn) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Publishing…';
    resultHost.replaceChildren();
    try {
      const data: any = await api.share(this.agentId);
      const url = data && data.url;
      if (!url) throw new Error('server did not return a URL');
      const copyBtn = el('button', {
        class: 'info-copy',
        type: 'button',
        title: 'Copy share URL',
        onclick: async () => {
          const ok = await copyToClipboard(url);
          if (ok) {
            this.flashBtnLabel(copyBtn, 'Copied');
            this.showToast('Share URL copied.', 'info');
          }
        },
      }, 'Copy');
      const link = el('a', {
        class: 'info-publish-url',
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, url);
      resultHost.appendChild(el('div', { class: 'info-publish-result-row' }, link, copyBtn));
    } catch (e: any) {
      resultHost.appendChild(el('div', { class: 'info-publish-error' },
        `publish failed: ${e && e.message ? e.message : String(e)}`));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  _applyNewHistoryEvents(events: any[]) {
    return applyNewHistoryEvents(this, events);
  }

  async _catchUpHistory(opts?: { force?: boolean }) {
    return catchUpHistory(this, opts);
  }

  _showChatLoading() {
    showChatLoading(this);
  }

  _hideChatLoading() {
    hideChatLoading(this);
  }

  _replayHistoryEvent(ev: any) {
    return replayHistoryEvent(this, ev);
  }

  async refreshHistory({ all = false, turns = 80, force = false, preserveAnchor = false } = {}) {
    return replayRefreshHistory(this, { all, turns, force, preserveAnchor });
  }

  _buildLoadEarlierBanner(missingCount: any) {
    return buildLoadEarlierBanner(this, missingCount);
  }

  openStreamForCurrent() {
    if (!this.agentId) return;
    this.closeStream();
    this._streamOpenedAt = Date.now();
    this._paintLiveStatus();
    this.stream = openStream(`/api/agents/${encodeURIComponent(this.agentId)}/stream`, {
      onOpen:  () => this._paintLiveStatus(),
      onError: () => this.showStatus('Stream error · reconnecting', 'warn'),
      onAny:   (name, data, ev) => {
        const eid = ev && ev.lastEventId;
        if (shouldDropSseEvent({
          name,
          lastEventId: eid,
          lastHistoryEventId: this._lastHistoryEventId,
          streamOpenedAt: this._streamOpenedAt,
          data,
          turns: this.turns,
        })) return;
        this.handleEvent(name, data);
        if (parseLiveEventId(eid)) this._lastHistoryEventId = maxLiveEventId(this._lastHistoryEventId, eid);
      },
    });
  }

  _paintLiveStatus() {
    const a = this.currentAgent;
    const host = this.root || document;
    const st0 = a && a.status;
    const dead = !a || st0 === 'disconnected' || st0 === 'exited' || st0 === 'errored';
    if (dead && host && typeof host.querySelectorAll === 'function') {
      host.querySelectorAll('.plan-card, .perm-card').forEach((n: Element) => {
        try { n.remove(); } catch { /* ignore */ }
      });
    }
    if (!dead && host.querySelector('.plan-card:not(.plan-card--q)')) {
      this.showStatus('Waiting for plan approval', 'warn');
      if (this.composerCancel) this.composerCancel.disabled = false;
      this._syncSendBtn();
      return;
    }
    if (!dead && host.querySelector('.plan-card--q')) {
      this.showStatus('Waiting for your answer', 'warn');
      if (this.composerCancel) this.composerCancel.disabled = false;
      this._syncSendBtn();
      return;
    }
    if (!dead && host.querySelector('.perm-card')) {
      this.showStatus('Waiting for permission', 'warn');
      if (this.composerCancel) this.composerCancel.disabled = false;
      this._syncSendBtn();
      return;
    }
    if (this._compacting) {
      this.showStatus('Compacting context…', 'warn');
      if (this.composerCancel) this.composerCancel.disabled = false;
      this._syncSendBtn();
      return;
    }
    const st = a && a.status;
    const disconnected = !a || st === 'disconnected' || st === 'exited';
    if (!this._isReplaying) {
      this._turnOpen = followServerTurnOpen({
        local: !!this._turnOpen,
        server: a && typeof a.turnOpen === 'boolean' ? a.turnOpen : null,
        holdUntil: this._turnOpenHoldUntil,
      });
    }
    const turnOpen = !this._isReplaying && !!this._turnOpen;
    const working = !disconnected && (
      !!this._forceSending
      || !!this._flushingQueue
      || isDisplayedWorking({
        status: st,
        turnOpen,
        inFlight: Math.max(
          a && typeof a.inFlight === 'number' ? a.inFlight : 0,
          this._localInFlightCount(),
        ),
      })
    );
    if (disconnected) {
      this.showStatus('Disconnected', 'fail');
      if (this.composerCancel) this.composerCancel.disabled = true;
    } else if (st === 'starting') {
      this.showStatus('Starting…', 'idle');
      if (this.composerCancel) this.composerCancel.disabled = true;
    } else if (st === 'errored') {
      this.showStatus('Errored', 'fail');
      if (this.composerCancel) this.composerCancel.disabled = true;
    } else if (working) {
      const parentTools = this._localInFlightCount();
      const waiting = parentTools > 0 ? 0 : countWaitingSubagents(
        [...(this._subagentMap || new Map()).values()].map((rec: any) => rec && rec.card && rec.card.getStatus && rec.card.getStatus()),
      );
      const waitLabel = waitingSubagentLabel(waiting);
      this.showStatus(waitLabel || 'In progress…', 'warn');
      if (this.composerCancel) this.composerCancel.disabled = false;
      this._renderInflightPill();
    } else {
      this._turnOpen = false;
      this._turnOpenHoldUntil = 0;
      const model = (a && (a.model || (a.settings && a.settings.model))) || '';
      this.showStatus(model ? `Connected · ${model}` : 'Connected', 'ok');
      this._pruneLiveBar();
      if (this.composerCancel) this.composerCancel.disabled = true;
      scheduleFlushQueue(this);
    }
    this._renderInflightPill();
    this._syncSendBtn();
  }

  closeStream() {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  showStatus(text: any, kind?: any) {
    this.statusEl.replaceChildren(
      el('span', {
        class: `status-pill status-pill--${kind || 'idle'}`,
        'aria-hidden': 'true',
      }),
      el('span', { class: 'chat-status-text' }, text),
    );
  }

  showToast(text: any, kind?: any) {
    const toast = renderToast(text, kind);
    this.toastHost.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast--out');
      setTimeout(() => toast.remove(), 250);
    }, 4200);
  }

  // ── turn machinery ───────────────────────────────────────────────────


  _mountTurnInfo(turn: any) {
    if (!turn || !turn.result || turn.timeline) return;
    // Chronological phases. Consecutive same-kind chunks merge;
    // a tool/reply in between starts a new Thought or Reply block.
    turn.timeline = el('div', { class: 'turn-timeline' });
    turn.phases = [];
    turn.result.appendChild(turn.timeline);
  }

  _lastPhase(turn: any) {
    const list = turn && turn.phases;
    return (list && list.length) ? list[list.length - 1] : null;
  }

  _toolId(data: any) {
    if (!data || typeof data !== 'object') return '';
    return data.toolCallId || data.id || (data.update && (data.update.toolCallId || data.update.id)) || '';
  }

  _findReplyPhase(turn: any) {
    const list = (turn && turn.phases) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].kind === 'reply' && list[i].pane) return list[i];
    }
    return null;
  }

  _shownReplyText(pane: any) {
    if (!pane) return '';
    if (typeof pane.text === 'function') return pane.text() || '';
    return pane.buf || '';
  }

  _replyRestreamDelta(turn: any, text: string) {
    const have = turn.replyBuf || '';
    const last = this._findReplyPhase(turn);
    const shown = this._shownReplyText(last && last.pane);
    const prev = shown || have;
    const r = mergeAfterGap(prev, text, turn._restream || '');
    if (r.kind === 'skip') {
      turn._restream = r.acc;
      return '';
    }
    turn._restream = '';
    return r.append;
  }


  _finalizeTurnThoughts(turn: any) {
    if (!turn) return;
    if (turn.thinking && typeof turn.thinking.finalize === 'function') {
      try { turn.thinking.finalize(); } catch { /* ignore */ }
    }
    for (const ph of (turn.phases || [])) {
      if (ph && ph.kind === 'thought' && ph.pane && typeof ph.pane.finalize === 'function') {
        try { ph.pane.finalize(); } catch { /* ignore */ }
      }
    }
  }

  _appendReplyText(turn: any, text: string, opts?: any) {
    if (!text) return;
    const last = this._lastPhase(turn);
    const lastReply = this._findReplyPhase(turn);

    if (last && last.kind === 'reply' && last.pane) {
      const merged = mergeStreamChunk(turn.replyBuf || '', text, turn._replyAcc || '');
      if (!merged) return;
      turn._replyAcc = merged.acc || '';
      if (!merged.append) return;
      turn.replyBuf = merged.next;
      last.pane.append(merged.append);
      return;
    }

    const prev = turn.replyBuf || '';
    const gap = mergeAfterGap(prev, text, turn._restream || '');
    if (gap.kind === 'skip') {
      turn._restream = gap.acc;
      return;
    }
    if (gap.kind === 'reuse' && lastReply && lastReply.pane) {
      turn._restream = '';
      turn._replyAcc = '';
      turn.replyBuf = gap.next;
      lastReply.pane.append(gap.append);
      return;
    }

    turn._restream = '';
    turn._replyAcc = '';
    this._finalizeTurnThoughts(turn);
    const bubble = renderAssistantBubble(this._lastEventTs || Date.now());
    if (!this._isReplaying && !(opts && opts.fromHistory)) {
      bubble.node.classList.add('msg--enter');
    }
    (turn.timeline || turn.result || turn.root).appendChild(bubble.node);
    turn.phases.push({ kind: 'reply', pane: bubble });
    turn.assistant = bubble;
    turn.replyBuf = gap.next;
    bubble.append(gap.append);
  }

  ensureTurn() {
    if (this.activeTurn) return this.activeTurn;
    // Late thought/tool/answer chunks after prompt_complete belong to the
    // last turn. Opening a new one paints an empty "You" bubble.
    const last = this.turns[this.turns.length - 1];
    if (last) {
      this.activeTurn = last;
      return last;
    }
    return this.startTurn('', { ts: this._lastEventTs || Date.now() });
  }

  startTurn(userText: any, opts?: any) {
    // A turn is about to land in the stream. Cancel the welcome animation
    // if it's still running so the figlet doesn't overlap the new bubble.
    this._cancelChatIntro();
    const ts = (opts && opts.ts) || Date.now();
    const attachments = Array.isArray(opts && opts.attachments) ? opts.attachments : [];
    const userBubble = renderUserBubble(userText, ts, {
      attachments,
      agentId: this.agentId,
    });
    const emptyUser = !(String(userText || '').trim()) && !attachments.length;
    if (emptyUser) {
      userBubble.hidden = true;
      userBubble.classList.add('msg--empty');
    }
    // Only animate fresh insertions, never historical replay (that would
    // produce a chaotic shimmer across all replayed turns).
    const animate = !this._isReplaying && !(opts && opts.fromHistory);
    const classes = animate ? 'turn turn--enter' : 'turn';
    const result = el('div', { class: 'turn-result' });
    const root = el('div', { class: classes }, userBubble, result);
    const fromHistory = !!(opts && opts.fromHistory);
    const pinRoot = liveTurnUsesHistoryPin(!!this._isReplaying, fromHistory)
      ? this._historyInsertBefore
      : null;
    if (!pinRoot) {
      this.streamEl.querySelectorAll('.turn--latest').forEach((n) => n.classList.remove('turn--latest'));
      root.classList.add('turn--latest');
    }
    if (pinRoot && pinRoot.parentNode === this.streamEl) {
      this.streamEl.insertBefore(root, pinRoot);
    } else {
      this.streamEl.appendChild(root);
    }
    const turn = {
      user:      userBubble,
      userText:  userText || '',
      userAttachments: attachments,
      thinking:  null,
      tools:     [],
      assistant: null,
      footer:    null,
      result,
      root,
      phases:    [],
    };
    this._mountTurnInfo(turn);
    if (pinRoot) {
      const pinIdx = this.turns.findIndex((t: any) => t && t.root === pinRoot);
      if (pinIdx >= 0) this.turns.splice(pinIdx, 0, turn);
      else this.turns.push(turn);
    } else {
      this.turns.push(turn);
    }
    this.activeTurn = turn;
    // Decorate retroactively once the skill set is loaded. Idempotent.
    this._decorateSkill(turn);
    if (!this._isReplaying) {
      this._ensureLatestSentinel();
      this.scrollToBottom({ force: true });
    }
    return turn;
  }

  _parseLiveEventId(eid: any) {
    return parseLiveEventId(eid);
  }

  _alreadyInHistory(eid: any) {
    return alreadyInHistory(this._lastHistoryEventId, eid);
  }

  _footerMetaScore(meta: any) {
    if (!meta) return 0;
    let n = 0;
    if (meta.inputTokens != null || meta.input_tokens != null) n += 1;
    if (meta.outputTokens != null || meta.output_tokens != null) n += 1;
    if (meta.totalTokens != null || meta.total_tokens != null) n += 2;
    if (meta.stopReason || meta.stop_reason) n += 1;
    return n;
  }

  _toolStatusIsOpen(status: any) {
    const st = String(status || '').toLowerCase();
    return !st || st === 'pending' || st === 'running' || st === 'in_progress' || st === 'inprogress';
  }

  _closeOpenTools(turn: any, finalStatus: 'completed' | 'canceled' = 'completed') {
    if (!turn || !Array.isArray(turn.tools)) return;
    for (const item of turn.tools) {
      const card = item && item.card;
      if (!card) continue;
      if (card.isSubagent) {
        if (typeof card.markChildFinished === 'function') card.markChildFinished();
        this._untrackSubagent(item.id);
        continue;
      }
      if (typeof card.getStatus !== 'function' || typeof card.applyUpdate !== 'function') continue;
      if (!this._toolStatusIsOpen(card.getStatus())) continue;
      try { card.applyUpdate({ status: finalStatus }); } catch { /* ignore */ }
    }
  }

  _finalizePendingTools({ includeActive = false } = {}) {
    for (const turn of (this.turns || [])) {
      if (!includeActive && turn === this.activeTurn) continue;
      this._closeOpenTools(turn);
    }
  }

  endTurn(meta: any) {
    if (!this.activeTurn) return;
    const turn = this.activeTurn;
    for (const ph of (turn.phases || [])) {
      if (ph && ph.pane && typeof ph.pane.finalize === 'function') ph.pane.finalize();
    }
    if (turn.thinking && typeof turn.thinking.finalize === 'function') {
      turn.thinking.finalize();
    }
    if (turn.assistant && typeof turn.assistant.finalize === 'function') {
      turn.assistant.finalize();
    }
    const stopReason = meta && (meta.stopReason || meta.stop_reason);
    this._closeOpenTools(turn, terminalToolStatus(stopReason));
    // prompt_complete can fire twice (history + SSE ring replay, or a late
    // reopen). Never stack a second in/out/cached footer.
    if (turn.footer) {
      if (this._footerMetaScore(meta) > this._footerMetaScore(turn.footerMeta)) {
        const next = renderTokenFooter(meta || {});
        try { turn.footer.replaceWith(next); } catch { /* keep existing */ }
        turn.footer = next;
        turn.footerMeta = meta || {};
      }
    } else {
      const cur = this._currentModelSettings();
      const merged = Object.assign({}, meta || {}, {
        totalTokens: (meta && (meta.totalTokens ?? meta.total_tokens)) != null
          ? (meta.totalTokens ?? meta.total_tokens)
          : this.latestTotalTokens,
        model: (meta && (meta.modelId || meta.model)) || cur.liveModel || cur.model || null,
        effort: cur.effort || null,
      });
      const footer = renderTokenFooter(merged);
      (turn.result || turn.root).appendChild(footer);
      turn.footer = footer;
      turn.footerMeta = merged;
    }
    this.activeTurn = null;
    this.composerCancel.disabled = true;
    this.scrollToBottom();
  }

  _ensureLatestSentinel() {
    if (!this.streamEl) return;
    if (!this._latestSentinel) {
      this._latestSentinel = el('div', {
        class: 'chat-latest-sentinel',
        'aria-hidden': 'true',
      });
    }
    const pin = this._latestSentinel;
    if (pin.parentNode !== this.streamEl || this.streamEl.lastElementChild !== pin) {
      this.streamEl.appendChild(pin);
    }
    const turns = this.streamEl.querySelectorAll('.turn');
    const lastTurn = turns.length ? turns[turns.length - 1] : null;
    this.streamEl.querySelectorAll('.turn--latest').forEach((n) => n.classList.remove('turn--latest'));
    if (lastTurn) lastTurn.classList.add('turn--latest');
  }

  _distanceFromBottom() {
    const el = this.streamEl;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }

  _scrollStreamToEnd() {
    if (this._scrollEndRaf) return;
    this._scrollEndRaf = requestAnimationFrame(() => {
      this._scrollEndRaf = 0;
      this._scrollStreamToEndNow();
    });
  }

  _scrollStreamToEndNow() {
    const el = this.streamEl;
    if (!el) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    if (Math.abs(el.scrollTop - max) <= 1) {
      this._lastEasedWrite = el.scrollTop;
      this._easedScrollTarget = el.scrollTop;
      return;
    }
    el.scrollTop = max;
    this._lastEasedWrite = el.scrollTop;
    this._easedScrollTarget = el.scrollTop;
    this._programmaticScrollUntil = Date.now() + 160;
    if (this._jumpToLatestBtn) this._jumpToLatestBtn.hidden = this._distanceFromBottom() <= 8;
  }

  _snapToLatest() {
    if (!this.streamEl) return;
    applyForceScrollFlags(this);
    this._forceScrollGen = (this._forceScrollGen || 0) + 1;
    const gen = this._forceScrollGen;
    if (this._easedScrollRaf) {
      cancelAnimationFrame(this._easedScrollRaf);
      this._easedScrollRaf = 0;
    }
    this._scrollRaf = 0;
    this._scrollStreamToEnd();
    // One extra frame if layout is still growing. Do not loop or
    // scrollIntoView — that shakes the viewport on mobile.
    requestAnimationFrame(() => {
      if (gen !== this._forceScrollGen) return;
      this._scrollStreamToEnd();
    });
  }

  _latestTurnInView() {
    const stream = this.streamEl;
    const last = this.turns && this.turns.length ? this.turns[this.turns.length - 1] : null;
    if (!stream || !last || !last.root) return this._distanceFromBottom() <= 8;
    if (this._historyLastHasReply) {
      const reply = last.assistant && last.assistant.node;
      if (!reply) return false;
      const box = reply.getBoundingClientRect();
      if (box.height < 8) return false;
      const sr = stream.getBoundingClientRect();
      return box.bottom <= sr.bottom + 24 && box.top < sr.bottom;
    }
    const sr = stream.getBoundingClientRect();
    const tr = last.root.getBoundingClientRect();
    return tr.bottom <= sr.bottom + 12 && tr.top < sr.bottom;
  }

  _snapLatestTurn() {
    this._scrollStreamToEnd();
  }

  _pinToLatestAfterLoad() {
    if (!this.streamEl) return;
    this._userScrollIntent = false;
    this._autoScroll = true;
    if (this._jumpToLatestBtn) this._jumpToLatestBtn.hidden = true;
    this.streamEl.classList.remove('chat-stream--pin-latest');
    this._scrollStreamToEnd();
  }

  scrollToBottom(opts?: any) {
    // Stay pinned to the bottom only when the user hasn't scrolled away.
    // Force-scroll on explicit actions (sending a message, initial load).
    const force = !!(opts && opts.force);
    if (this._quietScroll && !force) return;
    if (this._isReplaying && !force) return;
    if (!force && this._autoScroll === false) return;

    if (force) {
      this._snapToLatest();
      return;
    }

    // Streaming path: eased follow toward the current bottom. Each call just
    // re-arms the target; the single rAF loop in _easedScrollTick handles the
    // animation and self-cancels when it lands within 1px of the target.
    this._scheduleEasedScroll();
  }

  // Mark the stream as wanting to chase the bottom. Starts the rAF loop if
  // not already running. Safe to call repeatedly per chunk arrival.
  _scheduleEasedScroll() {
    this._easedScrollPending = true;
    const coarse = typeof window !== 'undefined'
      && !!window.matchMedia
      && window.matchMedia('(pointer: coarse)').matches;
    if ((typeof document !== 'undefined' && document.hidden) || coarse) {
      // Hidden tab: rAF is throttled. Phone: eased lerp + content-visibility
      // reads as a shake. Snap once.
      this._scrollStreamToEnd();
      this._easedScrollPending = false;
      return;
    }
    if (this._easedScrollRaf) return;
    const tick = () => {
      this._easedScrollRaf = 0;
      // Bail if the user scrolled away or the view got torn down between
      // frames.
      if (!this.streamEl || !this.streamEl.isConnected) return;
      if (this._autoScroll === false) {
        this._easedScrollPending = false;
        return;
      }
      const el = this.streamEl;
      const target = Math.max(0, el.scrollHeight - el.clientHeight);
      this._easedScrollTarget = target;
      const current = el.scrollTop;
      const delta = target - current;
      if (Math.abs(delta) <= 1) {
        // Land exactly and stop the loop.
        el.scrollTop = target;
        this._lastEasedWrite = target;
        this._easedScrollPending = false;
        return;
      }
      // Ease ~0.22 per frame. At 60fps a 200px gap closes in ~10 frames.
      const next = current + delta * 0.22;
      el.scrollTop = next;
      this._lastEasedWrite = next;
      this._easedScrollRaf = requestAnimationFrame(tick);
    };
    this._easedScrollRaf = requestAnimationFrame(tick);
  }

  // Eased follow for the tools column. Mirrors scrollToBottom() above but
  // for this.toolsStreamEl. Cheaper because the tools column doesn't use
  // content-visibility so scrollHeight is always accurate.
  _scrollToolsToBottom(opts?: any) { scrollToolsToBottom(this, opts); }
  _buildToolsColHeader() { return buildToolsColHeader(this); }
  static get CHAT_TOOLS_TAB_KEY() { return CHAT_TOOLS_TAB_KEY; }
  static get CHAT_TOOLS_FULLSCREEN_KEY() { return CHAT_TOOLS_FULLSCREEN_KEY; }
  _readToolsColTab() { return readToolsColTab(this); }
  _readToolsColFullscreen() { return readToolsColFullscreen(this); }
  _setToolsColTab(key: any) { setToolsColTab(this, key); }
  _applyToolsColTab() { applyToolsColTab(this); }
  _toggleToolsFullscreen() { toggleToolsFullscreen(this); }
  _applyToolsFullscreenClass() { applyToolsFullscreenClass(this); }
  static get CHAT_SPLIT_SIZES_KEY() { return CHAT_SPLIT_SIZES_KEY; }
  static get CHAT_SPLIT_COLLAPSED_KEY() { return CHAT_SPLIT_COLLAPSED_KEY; }
  static get CHAT_SPLIT_MOBILE_COLLAPSED_KEY() { return CHAT_SPLIT_MOBILE_COLLAPSED_KEY; }
  static get CHAT_SPLIT_DEFAULT_SIZES() { return CHAT_SPLIT_DEFAULT_SIZES; }
  static get CHAT_SPLIT_MOBILE_MAX() { return CHAT_SPLIT_MOBILE_MAX; }
  _isValidSizesArray(a: any) { return isValidSizesArray(this, a); }
  _readAllChatSplitSizes() { return readAllChatSplitSizes(this); }
  _readChatSplitSizesForTab(tab: any) { return readChatSplitSizesForTab(this, tab); }
  _writeChatSplitSizesForTab(tab: any, sizes: any) { writeChatSplitSizesForTab(this, tab, sizes); }
  _isChatMobile() { return isChatMobile(this); }
  _initChatSplit() { initChatSplit(this); }
  _destroyChatSplit() { destroyChatSplit(this); }
  _applyChatSplitCollapsedClass() { applyChatSplitCollapsedClass(this); }
  _updateToolsToggleLabel() { updateToolsToggleLabel(this); }
  _toggleToolsCol() { toggleToolsCol(this); }
  _closeToolsCol() { closeToolsCol(this); }

  _ensureToolsGroup(turn: any) {
    // Tool pills belong in the Tool Calls column, grouped by turn.
    // Putting them in the chat timeline floods mobile (panel starts
    // collapsed) with one card per execute.
    const host = this.toolsStreamEl;
    if (host) {
      if (turn.toolsGroup && turn.toolsGroup.isConnected) return turn.toolsGroup;
      const preview = String(turn.userText || '').replace(/\s+/g, ' ').slice(0, 72);
      const head = el('div', { class: 'tools-group__head' }, preview || 'Tool Calls');
      turn.toolsGroup = el('div', { class: 'tools-group' }, head);
      const pinRoot = this._historyInsertBefore;
      const pinTurn = pinRoot && (this.turns || []).find((t: any) => t && t.root === pinRoot);
      const pinGroup = pinTurn && pinTurn.toolsGroup;
      if (pinGroup && pinGroup.parentNode === host) host.insertBefore(turn.toolsGroup, pinGroup);
      else host.appendChild(turn.toolsGroup);
      return turn.toolsGroup;
    }
    return turn.timeline || turn.result || turn.root;
  }

  _syncTurnToolSummary(turn: any) {
    if (!turn) return;
    const n = turn.toolTotal || (turn.tools || []).length;
    const host = turn.timeline || turn.result;
    if (!host) return;
    if (!n) {
      if (turn.toolSummary) {
        try { turn.toolSummary.remove(); } catch { /* ignore */ }
        turn.toolSummary = null;
      }
      return;
    }
    const label = n === 1 ? '1 Tool Call' : `${n} Tool Calls`;
    if (!turn.toolSummary || !turn.toolSummary.isConnected) {
      turn.toolSummary = el('button', {
        type: 'button',
        class: 'tool-summary',
        onclick: () => {
          if (this._chatSplitCollapsed) this._toggleToolsCol();
        },
      }, label);
      host.appendChild(turn.toolSummary);
    } else {
      turn.toolSummary.textContent = label;
    }
  }

  _capTurnToolCards(turn: any) {
    if (!turn || !turn.tools) return;
    pruneTurnToolCards(turn.tools, TOOLS_PER_TURN);
    this._syncTurnToolSummary(turn);
  }

  _initAutoScroll() {
    this._autoScroll = true;
    this._autoScrollTools = true;
    const THRESHOLD = 60; // px from bottom counts as "at bottom"
    // Jump-to-latest button, hidden by default. Lives inside the stream so
    // it shows up above the composer without restructuring the layout.
    this._jumpToLatestBtn = el('button', {
      type: 'button',
      class: 'jump-to-latest',
      hidden: true,
      onclick: () => {
        this._autoScroll = true;
        this._snapToLatest();
      },
    }, '↓ Jump to Latest');
    // Append once the user mounts. Defer to a microtask so the button lives
    // inside the conversation pane, not the stream itself.
    requestAnimationFrame(() => {
      const pane = this.streamEl.parentElement;
      if (pane && !pane.contains(this._jumpToLatestBtn)) {
        pane.appendChild(this._jumpToLatestBtn);
      }
    });
    // Track user-initiated scroll. We need to distinguish programmatic
    // eased-scroll writes from real user input; a manual flag set just
    // before each programmatic write would be racy across rAF boundaries,
    // so instead we compare against the most-recent eased target. If the
    // user is meaningfully off-target (more than the threshold), treat it
    // as a manual scroll-away.
    this.streamEl.addEventListener('wheel', () => { this._userScrollIntent = true; }, { passive: true });
    this.streamEl.addEventListener('touchstart', () => { this._userScrollIntent = true; }, { passive: true });
    const onScroll = () => {
      const el = this.streamEl;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = dist <= THRESHOLD;
      if (this._loadPinUntil && Date.now() < this._loadPinUntil && !this._userScrollIntent) {
        return;
      }
      const follow = scrollFollowAction({
        atBottom,
        autoScroll: !!this._autoScroll,
        userScrollIntent: !!this._userScrollIntent,
        lastEasedWrite: this._lastEasedWrite,
        scrollTop: el.scrollTop,
        programmaticUntil: this._programmaticScrollUntil,
      });
      if (follow === 'keep') return;
      if (follow === 'resume') {
        this._autoScroll = true;
        this._jumpToLatestBtn.hidden = true;
        return;
      }
      this._autoScroll = false;
      this._jumpToLatestBtn.hidden = false;
      if (this._easedScrollRaf) {
        cancelAnimationFrame(this._easedScrollRaf);
        this._easedScrollRaf = 0;
      }
    };
    this.streamEl.addEventListener('scroll', onScroll, { passive: true });

    // Same listener for the tools column. No jump-to-latest button there;
    // we just pause the eased follow when the user scrolls up.
    const onToolsScroll = () => {
      const el = this.toolsStreamEl;
      if (!el) return;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = dist <= THRESHOLD;
      if (this._easedToolsRaf && !atBottom) {
        if (this._lastEasedToolsWrite != null && el.scrollTop >= this._lastEasedToolsWrite - 4) {
          return;
        }
      }
      if (atBottom && !this._autoScrollTools) {
        this._autoScrollTools = true;
      } else if (!atBottom && this._autoScrollTools) {
        this._autoScrollTools = false;
        if (this._easedToolsRaf) {
          cancelAnimationFrame(this._easedToolsRaf);
          this._easedToolsRaf = 0;
        }
      }
    };
    if (this.toolsStreamEl) {
      this.toolsStreamEl.addEventListener('scroll', onToolsScroll, { passive: true });
    }

    // rAF is throttled while the tab is hidden, so the eased loop stalls.
    // When the user comes back, snap both streams to their targets so they
    // start aligned for any further easing.
    const onVis = () => {
      if (document.hidden) return;
      if (this._autoScroll !== false) {
        this.streamEl.scrollTop = this.streamEl.scrollHeight;
        this._easedScrollTarget = this.streamEl.scrollTop;
        this._lastEasedWrite = this.streamEl.scrollTop;
      }
      if (this._autoScrollTools !== false && this.toolsStreamEl) {
        this.toolsStreamEl.scrollTop = this.toolsStreamEl.scrollHeight;
        this._easedToolsTarget = this.toolsStreamEl.scrollTop;
        this._lastEasedToolsWrite = this.toolsStreamEl.scrollTop;
      }
    };
    document.addEventListener('visibilitychange', onVis);

    let vvRaf = 0;
    const onViewportResize = () => {
      if (this._autoScroll === false) return;
      if (vvRaf) return;
      vvRaf = requestAnimationFrame(() => {
        vvRaf = 0;
        this._scrollStreamToEnd();
      });
    };
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (vv) vv.addEventListener('resize', onViewportResize);

    this._detachAutoScroll = () => {
      this.streamEl.removeEventListener('scroll', onScroll);
      if (this.toolsStreamEl) this.toolsStreamEl.removeEventListener('scroll', onToolsScroll);
      document.removeEventListener('visibilitychange', onVis);
      if (vv) vv.removeEventListener('resize', onViewportResize);
      if (vvRaf) { cancelAnimationFrame(vvRaf); vvRaf = 0; }
      if (this._scrollEndRaf) { cancelAnimationFrame(this._scrollEndRaf); this._scrollEndRaf = 0; }
      if (this._easedScrollRaf) { cancelAnimationFrame(this._easedScrollRaf); this._easedScrollRaf = 0; }
      if (this._easedToolsRaf)  { cancelAnimationFrame(this._easedToolsRaf);  this._easedToolsRaf  = 0; }
    };
  }

  // ── in-flight strip ──────────────────────────────────────────────────

  _addInFlight(data: any, cardNode: any) {
    if (!data || !data.toolCallId) return;
    if (this._inFlightMap.has(data.toolCallId)) return;
    const label = (data.rawInput && (data.rawInput.command || data.rawInput.path || data.rawInput.file_path || data.rawInput.url))
                || data.title
                || data.kind
                || 'tool';
    const kind = data.kind || 'tool';
    const startedAt = Date.now();
    this._inFlightMap.set(data.toolCallId, { kind, label, startedAt, cardNode });
  }

  _removeInFlight(toolCallId: any) {
    if (!this._inFlightMap.has(toolCallId)) return;
    this._inFlightMap.delete(toolCallId);
    this.liveBar.remove('tool:' + toolCallId);
  }

  _clearAllInFlight() {
    this._inFlightMap.clear();
    this.liveBar.replaceKind('tool', []);
  }

  _localInFlightCount() {
    // Parent-turn occupancy only. Spawned subagents stay visually Running
    // after spawn_subagent returns; counting them here left Invest Bot
    // "In progress" after the parent turn had already ended.
    return (this._inFlightMap && this._inFlightMap.size) || 0;
  }

  _turnHasOpenTools() {
    const turn = this.activeTurn || (this.turns && this.turns[this.turns.length - 1]);
    if (!turn || !Array.isArray(turn.tools)) return false;
    for (const item of turn.tools) {
      const card = item && item.card;
      if (!card || typeof card.getStatus !== 'function') continue;
      if (openCardBlocksParentTurn({
        isSubagent: !!card.isSubagent,
        status: card.getStatus(),
      })) return true;
    }
    return false;
  }

  _finishTurnSubagents() {
    for (const turn of (this.turns || [])) {
      for (const item of (turn.tools || [])) {
        const card = item && item.card;
        if (!card || !card.isSubagent) continue;
        if (typeof card.markChildFinished === 'function') card.markChildFinished();
        this._untrackSubagent(item.id);
      }
    }
    this._clearAllSubagents();
  }

  _trackSubagent(data: any, card: any) {
    if (!card || !card.isSubagent) return;
    const tid = this._toolId(data) || data.toolCallId;
    if (!tid) return;
    const typeName = (card.getType && card.getType())
      || (data.rawInput && data.rawInput.subagent_type)
      || 'general-purpose';
    const typeLabel = humanizeSubAgentType(typeName);
    const label = (card.getLabel && card.getLabel())
      || (data.rawInput && data.rawInput.description)
      || data.title
      || 'Subagent';
    const st = String(card.getStatus && card.getStatus() || '');
    const childId = card.getChildId && card.getChildId();
    if (childId) this._rememberChildSessionId(childId);
    if (st === 'Completed' || st === 'Failed' || st === 'Canceled') {
      this._untrackSubagent(tid);
      return;
    }
    const prev = this._subagentMap.get(tid);
    const startedAt = (prev && prev.startedAt) || Date.now();
    this._subagentMap.set(tid, { card, startedAt });
    this.liveBar.upsert({
      id: 'sa:' + tid,
      kind: 'subagent',
      type: typeLabel,
      label: String(label),
      live: true,
      startedAt,
      done: () => {
        const now = String(card.getStatus && card.getStatus() || '');
        return now === 'Completed' || now === 'Failed' || now === 'Canceled';
      },
      onClick: () => {
        if (card.node && card.node.scrollIntoView) {
          card.node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.node.classList.add('subagent-card--highlight');
          setTimeout(() => card.node.classList.remove('subagent-card--highlight'), 1200);
        }
      },
    });
  }

  _untrackSubagent(tid: any) {
    if (!this._subagentMap.has(tid)) return;
    this._subagentMap.delete(tid);
    this.liveBar.remove('sa:' + tid);
  }

  _clearAllSubagents() {
    this._subagentMap = new Map();
    this.liveBar.replaceKind('subagent', []);
  }

  // ── background terminals strip ───────────────────────────────────────

  _startBgTerminalsPolling() {
    if (this._bgTermsTimer) return;
    const tick = async () => {
      if (!this.agentId) return;
      if (document.hidden) return;
      try {
        const res: any = await api.terminals.list(this.agentId);
        const list = (res && Array.isArray(res.terminals)) ? res.terminals : [];
        this._renderBgTermsStrip(list);
      } catch { /* server may not implement the route yet */ }
    };
    tick();
    this._bgTermsTimer = setInterval(tick, 2000);
  }

  _stopBgTerminalsPolling() {
    if (this._bgTermsTimer) { clearInterval(this._bgTermsTimer); this._bgTermsTimer = null; }
    this._bgTermsByCard.clear();
    this.liveBar.replaceKind('shell', []);
    this._closeBgTermViewer();
  }

  _renderBgTermsStrip(list: any) {
    this._lastBgTerms = Array.isArray(list) ? list : [];
    if (this._cliPaneMode === 'tasks') this._renderCliPane();
    // Foreground ACP shells (the current turn's bash) are not live-bar
    // work. Only keep long-lived grok background shells.
    const running = (list || []).filter((t: any) => !t.exited && t.source !== 'acp');
    this.liveBar.replaceKind('shell', running.map((t: any) => {
      const cmd = String(t.command || '').trim();
      const label = cmd.length > 48 ? cmd.slice(0, 45) + '…' : (cmd || t.id || 'shell');
      return {
        id: 'sh:' + t.id,
        kind: 'shell' as const,
        type: 'Shell',
        label,
        title: `${t.command || ''} — ${t.cwd || ''} — Running`,
        live: true,
        startedAt: t.startedAt || Date.now(),
        onClick: () => this._openBgTermViewer(t.id),
      };
    }));
  }

  // Modal-style overlay listing every bg task (running + exited) for this
  // conversation. Read-only; clicking a row opens the live viewer.
  _openBgListViewer(initial: any) {
    if (this._bgListViewerEl) { this._bgListViewerEl.remove(); this._bgListViewerEl = null; }
    const overlay = el('div', { class: 'bgterm-viewer bgterm-list-viewer' });
    const closeBtn = el('button', { type: 'button', class: 'bgterm-viewer__close',
      onclick: () => { overlay.remove(); this._bgListViewerEl = null; },
    }, '×');
    overlay.appendChild(el('div', { class: 'bgterm-viewer__head' },
      el('div', { class: 'bgterm-viewer__title' }, 'All background shells in this conversation'),
      closeBtn,
    ));
    const body = el('div', { class: 'bgterm-list-viewer__body' });
    overlay.appendChild(body);
    document.body.appendChild(overlay);
    this._bgListViewerEl = overlay;
    const render = (list: any) => {
      body.replaceChildren();
      if (!list.length) {
        body.appendChild(el('div', { class: 'bgterm-list-viewer__empty' }, 'No background shells.'));
        return;
      }
      for (const t of list) {
        const code = t.exitStatus && (t.exitStatus.exitCode ?? t.exitStatus.signal);
        const row = el('button', {
          type: 'button',
          class: `bgterm-list-viewer__row ${t.exited ? 'bgterm-list-viewer__row--exited' : 'bgterm-list-viewer__row--running'}`,
          onclick: () => { overlay.remove(); this._bgListViewerEl = null; this._openBgTermViewer(t.id); },
        },
          el('span', { class: 'bgterm-list-viewer__status' }, t.exited ? `Exit ${code ?? '?'}` : 'Running'),
          el('span', { class: 'bgterm-list-viewer__id' }, t.id.replace(/^term-/, '').slice(0, 8)),
          el('span', { class: 'bgterm-list-viewer__cmd' }, t.command || '(no command)'),
        );
        body.appendChild(row);
      }
    };
    render(initial || []);
    // Keep the list refreshed while open.
    const timer = setInterval(async () => {
      if (!overlay.isConnected) { clearInterval(timer); return; }
      try {
        const r: any = await api.terminals.list(this.agentId);
        if (overlay.isConnected) render(r && r.terminals || []);
      } catch { /* ignore */ }
    }, 1500);
  }

  async _openBgTermViewer(tid: any) {
    // Modal-style overlay with output buffer. Polls every 1s while open.
    this._closeBgTermViewer();
    const overlay = el('div', { class: 'bgterm-viewer' });
    const closeBtn = el('button', {
      type: 'button', class: 'bgterm-viewer__close',
      onclick: () => this._closeBgTermViewer(),
    }, '×');
    const title = el('div', { class: 'bgterm-viewer__title' }, tid);
    const cmd   = el('div', { class: 'bgterm-viewer__cmd' }, '');
    const status= el('div', { class: 'bgterm-viewer__status' }, '');
    const pre   = el('pre', { class: 'bgterm-viewer__body' }, '');
    const killBtn = el('button', {
      type: 'button', class: 'bgterm-viewer__kill',
      onclick: async () => {
        killBtn.disabled = true;
        killBtn.textContent = 'Killing…';
        try {
          await api.terminals.kill(this.agentId, tid);
          // Visible confirmation before the next poll arrives.
          killBtn.textContent = 'Kill sent';
          status.textContent = 'Killing (waiting for exit)';
          status.className = 'bgterm-viewer__status bgterm-viewer__status--killing';
        } catch (err: any) {
          killBtn.disabled = false;
          killBtn.textContent = 'Kill failed; retry';
          status.textContent = `Kill failed: ${err.message}`;
        }
      },
    }, 'kill');
    overlay.appendChild(el('div', { class: 'bgterm-viewer__head' }, title, status, killBtn, closeBtn));
    overlay.appendChild(cmd);
    overlay.appendChild(pre);
    document.body.appendChild(overlay);
    this._bgTermViewerEl = overlay;

    let openLink: any = null;
    const refresh = async () => {
      if (!this._bgTermViewerEl) return;
      try {
        const r: any = await api.terminals.read(this.agentId, tid);
        if (!this._bgTermViewerEl) return;
        cmd.textContent = r.command || '';
        const code = r.exitStatus && (r.exitStatus.exitCode ?? r.exitStatus.signal);
        // Don't clobber an in-flight "killing" state with a stale "running".
        if (status.className.indexOf('--killing') === -1 || r.exited) {
          status.textContent = r.exited ? `Exited (${code ?? '?'})` : 'Running';
          status.className = `bgterm-viewer__status ${r.exited ? 'bgterm-viewer__status--exited' : 'bgterm-viewer__status--running'}`;
        }
        const wasAtBottom = (pre.scrollTop + pre.clientHeight) >= (pre.scrollHeight - 12);
        pre.textContent = (r.truncated ? '[... older output trimmed ...]\n' : '') + (r.output || '');
        if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
        if (r.exited) {
          killBtn.disabled = true;
          killBtn.textContent = 'Killed';
        }
        // Surface the detected local URL once we know it. Mount/unmount
        // the link in-place so we don't re-create it every poll.
        if (r.url && !r.exited) {
          if (!openLink) {
            openLink = el('a', {
              class: 'bgterm-viewer__open',
              href: r.url,
              target: '_blank',
              rel: 'noopener',
              title: `Open ${r.url}`,
            });
            openLink.innerHTML = `<span class="bgterm-viewer__open-ico">${iconHtml('globe')}</span><span class="bgterm-viewer__open-label">Open App</span>`;
            status.parentNode!.insertBefore(openLink, killBtn);
          }
          openLink.href = r.url;
          openLink.title = `Open ${r.url}`;
        } else if (openLink) {
          openLink.remove();
          openLink = null;
        }
      } catch { /* ignore */ }
    };
    await refresh();
    this._bgTermViewerTimer = setInterval(refresh, 1000);
  }

  _closeBgTermViewer() {
    if (this._bgTermViewerTimer) { clearInterval(this._bgTermViewerTimer); this._bgTermViewerTimer = null; }
    if (this._bgTermViewerEl) { this._bgTermViewerEl.remove(); this._bgTermViewerEl = null; }
  }

  // ── event dispatch ──────────────────────────────────────────────────

  _payloadSessionId(payload: any) {
    return payloadSessionId(payload);
  }

  _parentSessionId() {
    const a = this.currentAgent || {};
    return a.sessionId || a.lastSessionId || '';
  }

  _rememberChildSessionId(sid: any) {
    const v = String(sid || '').trim();
    if (!v) return;
    const a = this.currentAgent || {};
    if (v === a.sessionId || v === a.lastSessionId) return;
    if (!this._childSessionIds) this._childSessionIds = new Set();
    this._childSessionIds.add(v);
  }

  _knownChildSessionIds() {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (s: unknown) => {
      const v = String(s || '').trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      out.push(v);
    };
    for (const id of (this._childSessionIds || [])) add(id);
    for (const rec of (this._subagentMap || new Map()).values()) {
      const cid = rec && rec.card && rec.card.getChildId && rec.card.getChildId();
      add(cid);
    }
    return out;
  }

  _isChildSessionPayload(payload: any, opts?: any) {
    const a = this.currentAgent || {};
    const fromHist = !!(this._isReplaying || (opts && opts.fromHistory));
    return isChildSessionPayload({
      payload,
      parentSessionId: a.sessionId,
      lastSessionId: a.lastSessionId,
      knownChildIds: this._knownChildSessionIds(),
      fromHistory: fromHist,
    });
  }

  _applyChildSessionToCards(name: any, payload: any) {
    const sid = this._payloadSessionId(payload);
    if (!sid) return;
    const finish = childSessionEventFinishesSubagent(name, payload);
    const cards: Array<{ card: any; id: any; childId: string; open: boolean }> = [];
    for (const turn of (this.turns || [])) {
      for (const t of (turn.tools || [])) {
        const card = t && t.card;
        if (!card || !card.isSubagent) continue;
        const childId = String((card.getChildId && card.getChildId()) || '');
        const st = String((card.getStatus && card.getStatus()) || '');
        cards.push({
          card,
          id: t.id,
          childId,
          open: this._toolStatusIsOpen(st),
        });
      }
    }
    const idx = pickCardIndexForChildSession(
      cards.map((c) => ({ childId: c.childId, open: c.open })),
      sid,
    );
    if (idx < 0) return;
    const hit = cards[idx];
    if (!hit) return;
    if (!hit.childId && typeof hit.card.setChildId === 'function') hit.card.setChildId(sid);
    this._rememberChildSessionId(sid);
    if (finish && typeof hit.card.markChildFinished === 'function') {
      hit.card.markChildFinished();
    }
    this._trackSubagent({ toolCallId: hit.id, rawOutput: { subagent_id: sid } }, hit.card);
    if (typeof this._paintLiveStatus === 'function') this._paintLiveStatus();
    if (typeof this._syncSendBtn === 'function') this._syncSendBtn();
  }

  handleEvent(name: any, payload: any, opts?: any) {
    // Child subagent thought/tools/replies ride the same SSE / history
    // stream. Never paint them into the parent You/Grok timeline.
    // Compact lifecycle events must still reach the parent even while a
    // subagent is running, or Compacting… never clears.
    const isChild = this._isChildSessionPayload(payload, opts);
    if (isChild) {
      this._rememberChildSessionId(this._payloadSessionId(payload));
      this._applyChildSessionToCards(name, payload);
    }
    if (shouldDropChildEvent(name, payload, isChild)) return;
    if ((this._isReplaying || (opts && opts.fromHistory)) &&
        (name === 'agent_status' || name === 'error' || name === 'plan_approval' || name === 'user_question')) {
      return;
    }
    const liveMeta = payload && payload._meta;
    const fromHist = !!(this._isReplaying || (opts && opts.fromHistory));
    if (shouldApplyLiveOccupancy({
      fromHistory: fromHist,
      replaying: !!this._isReplaying,
      isReplay: !!(liveMeta && liveMeta.isReplay === true),
    })) {
      const tt = liveMeta && (liveMeta.totalTokens ?? liveMeta.total_tokens);
      if (typeof tt === 'number' && Number.isFinite(tt) && tt >= 0) {
        applyOccupancy(this, tt);
        this._queueSidebarTokens(tt);
      }
    }
    const data = unwrap(payload);
    const parentSid = this._payloadSessionId(payload);
    // Never adopt a sessionId from history or from a user bubble — a child
    // chunk can land first and then hide the real parent replies.
    if (parentSid && this.currentAgent && !this.currentAgent.sessionId
        && !fromHist && !this._isReplaying
        && (name === 'prompt_complete' || name === 'handshake')) {
      this.currentAgent.sessionId = parentSid;
    }
    switch (name) {
      case 'user_message':
      case 'user_message_chunk':        return this.onUserMessage(data, opts);
      case 'agent_message_chunk':       return this.onMessageChunk(data, opts);
      case 'agent_thought_chunk':       return this.onThoughtChunk(data, opts);
      case 'tool_call':                 return this.onToolCall(data, opts);
      case 'tool_call_update':          return this.onToolCallUpdate(data, opts);
      case 'tool_call_delta_chunk':     return this.onToolCallDelta(data);
      case 'available_commands_update': return this.onAvailableCommands(data);
      case 'handshake':                 return this.onHandshake(data);
      case 'session_summary_generated': return this.onSessionSummary(data, opts);
      case 'session/update':
      case 'update':
      case 'x.ai/session/update':
      case 'auto_compact_started':
      case 'auto_compact_completed':
      case 'auto_compact_failed':
      case 'auto_compact_cancelled':
      case 'compact_started':
      case 'compact_completed':
      case 'compact_failed':
      case 'compaction_checkpoint':     return this.onCompactUpdate(name, payload, opts);
      case 'prompt_complete':           return this.onPromptComplete(data, opts);
      case 'agent_status':              return this.onAgentStatus(data);
      case 'agent_updated':             return this.onAgentUpdated(data);
      case 'session_notification':      return this.onSessionNotification(data);
      case 'permission_request':        return this._onPermissionRequest(payload);
      case 'plan_approval':             return this._onPlanApproval(payload, opts);
      case 'user_question':             return this._onUserQuestion(payload);
      case 'error':                     return this.onError(data);
      default: return;
    }
  }

  onUserMessage(data: any, opts?: any) {
    const raw = (data && typeof data.text === 'string') ? data.text : extractText(data);
    const attachments = Array.isArray(data && data.attachments) ? data.attachments : [];
    const fromHistory = !!(this._isReplaying || (opts && opts.fromHistory));
    const decision = decideUserMessage(this.turns || [], this.activeTurn, raw, attachments, fromHistory);
    if (decision.action === 'ignore') return;
    const text = decision.text;
    if (decision.action === 'fill-empty' && this.activeTurn && this.activeTurn.user) {
      this.activeTurn.userText = text;
      this.activeTurn.userAttachments = attachments;
      const fresh = renderUserBubble(text, this._lastEventTs || Date.now(), {
        attachments,
        agentId: this.agentId,
      });
      try { this.activeTurn.user.replaceWith(fresh); } catch { /* ignore */ }
      this.activeTurn.user = fresh;
      return;
    }
    this.startTurn(text, {
      ts: this._lastEventTs || Date.now(),
      fromHistory,
      attachments,
    });
  }

  _repairDuplicateTail() {
    const list = this.turns || [];
    if (list.length < 2) return;
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    if (!isDuplicateTailTurn(prev, last)) return;
    try { if (last.root && last.root.remove) last.root.remove(); } catch { /* ignore */ }
    list.pop();
    if (this.activeTurn === last) this.activeTurn = prev;
  }


  _turnForChunk(opts?: any) {
    const fromHistory = !!(this._isReplaying || (opts && opts.fromHistory));
    if (fromHistory) return this.ensureTurn();
    const eventTs = this._lastEventTs || 0;
    const opened = this._streamOpenedAt || 0;
    const stale = !!(opened && eventTs && eventTs < opened - 250);
    return pickTurnForReplyChunk(this.turns || [], this.activeTurn, stale) || this.ensureTurn();
  }

  onMessageChunk(data: any, opts?: any) {
    const text = extractText(data);
    if (text == null) return;
    const turn = this._turnForChunk(opts);
    this._appendReplyText(turn, text, opts);
    this.scrollToBottom();
  }

  _thoughtRestreamDelta(turn: any, text: string) {
    const last = this._findLastThought(turn);
    const shown = last && last.pane && typeof last.pane.text === 'function' ? (last.pane.text() || '') : '';
    if (!shown) return text;
    if (text === shown) return '';
    if (text.startsWith(shown)) return text.slice(shown.length);
    if (shown.startsWith(text)) return '';
    const acc = turn._thoughtRestream || '';
    if (shown.startsWith(acc + text)) {
      turn._thoughtRestream = acc + text;
      if (turn._thoughtRestream.length >= shown.length) turn._thoughtRestream = '';
      return '';
    }
    turn._thoughtRestream = '';
    return text;
  }

  _findLastThought(turn: any) {
    const list = (turn && turn.phases) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].kind === 'thought' && list[i].pane) return list[i];
    }
    return null;
  }

  onThoughtChunk(data: any, opts?: any) {
    const text = extractText(data);
    if (text == null) return;
    const turn = this._turnForChunk(opts);
    const last = this._lastPhase(turn);
    if (last && last.kind === 'thought' && last.pane) {
      const have = typeof last.pane.text === 'function' ? (last.pane.text() || '') : '';
      const merged = mergeStreamChunk(have, text, turn._thoughtAcc || '');
      if (!merged) return;
      turn._thoughtAcc = merged.acc || '';
      if (!merged.append) return;
      last.pane.append(merged.append);
      this.scrollToBottom();
      return;
    }
    const delta = this._thoughtRestreamDelta(turn, text);
    if (!delta) return;
    const fromHistory = !!(this._isReplaying || (opts && opts.fromHistory));
    const pane = renderThinkingPane({ open: true, live: !fromHistory });
    turn._thoughtAcc = '';
    (turn.timeline || turn.result || turn.root).appendChild(pane.node);
    turn.phases.push({ kind: 'thought', pane });
    turn.thinking = pane;
    pane.append(delta);
    this.scrollToBottom();
  }

  // Coalesce TodoWrite tool calls so a checklist evolves in place
  // instead of stacking a new pill per merge=true patch. Returns true
  // when the call was absorbed (caller should NOT also create a pill).
  //
  // Rules:
  //   - rawInput.merge === false (or no prior active card) → start a
  //     fresh card. Falls through to the normal pill path; we just stash
  //     the reference so later merges can find it.
  //   - rawInput.merge === true and we have an active card → patch the
  //     existing card and stop. No new pill, no strip chip.
  _maybeRouteTodoToolCall(data: any, opts?: any) {
    if (!isTodoWriteToolCall(data)) return false;
    const ri = data.rawInput || {};
    const isMerge = !!ri.merge;

    // Merge update with an active todo card already: absorb in place.
    if (isMerge && this._activeTodoCard && typeof this._activeTodoCard.ingestExternal === 'function') {
      this._activeTodoCard.ingestExternal(data);
      this._syncTodoDock();
      if (this._cliPaneMode === 'todos') this._renderCliPane();
      return true;
    }

    // grok often emits the initial tool_call event WITHOUT rawInput,
    // then fills it in on a subsequent tool_call_update. By that point
    // we've already created a regular card. Swap it for a todo card
    // in place so the user sees the checklist, not raw JSON.
    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (turn && data.toolCallId) {
      const entry = turn.tools.find((t: any) => t.id === data.toolCallId);
      if (entry && entry.card && !entry.card.isTodo) {
        const next = renderTodoWriteCard(data);
        if (entry.card.node && entry.card.node.parentNode) {
          entry.card.node.parentNode.replaceChild(next.node, entry.card.node);
        }
        entry.card = next;
        this._activeTodoCard = next;
        this._syncTodoDock();
        // Drop any in-flight chip the old regular card had registered;
        // todo cards don't participate in the strip.
        try { this._removeInFlight(data.toolCallId); } catch { /* ignore */ }
        return true;
      }
      // An existing todo card with the same id getting a non-merge
      // update: just re-ingest. Covers the rare case of grok re-seeding
      // the list mid-conversation.
      if (entry && entry.card && entry.card.isTodo) {
        entry.card.applyUpdate(data);
        this._activeTodoCard = entry.card;
        this._syncTodoDock();
        return true;
      }
    }

    // No existing entry: let the normal creation path run and tag the
    // resulting card as the active todo (renderToolCard will dispatch
    // to renderTodoWriteCard when rawInput.variant is present).
    this._pendingTodoSeed = true;
    return false;
  }

  _isHiddenParentTool(data: any) {
    const title = String((data && data.title) || '');
    return /get_command_or_subagent_output/i.test(title);
  }

  onToolCall(data: any, opts?: any) {
    // TodoWrite tool calls coalesce into a single live-updating card
    // (see _maybeRouteTodoToolCall). Subsequent calls with merge=true
    // are absorbed by the previous card instead of producing siblings.
    if (this._isHiddenParentTool(data)) return;
    if (this._maybeRouteTodoToolCall(data, opts)) return;

    const fromHistory = !!(this._isReplaying || (opts && opts.fromHistory));
    const payload = fromHistory ? { ...data, childFinished: true, fromHistory: true } : data;
    const turn = this.ensureTurn();
    const tid = this._toolId(data);
    const existing = tid && (turn.tools || []).find((x: any) => x.id === tid);
    if (existing) {
      existing.card.applyUpdate(payload);
      this._resyncInFlightStrip();
      return;
    }
    this._finalizeTurnThoughts(turn);
    const card = renderToolCard(payload);
    turn.tools.push({ id: tid || data.toolCallId, card });
    turn.toolTotal = (turn.toolTotal || 0) + 1;
    const live = !this._isReplaying && !(opts && opts.fromHistory);
    if (live) card.node.classList.add('tool-pill--enter');
    this._ensureToolsGroup(turn).appendChild(card.node);
    if (turn.phases) turn.phases.push({ kind: 'execute', card });
    this._capTurnToolCards(turn);
    this._scrollToolsToBottom();
    // Add to the in-flight strip unless this came from history replay
    // (those calls are already terminal and would just flash). Skip
    // entirely for todo cards: they aren't interesting work in flight.
    if (card.isSubagent) {
      const st = String(card.getStatus && card.getStatus() || '');
      if (this._wantLiveChip(live, st)) this._trackSubagent(data, card);
    } else if (live && !card.isTodo) {
      this._addInFlight(data, card.node);
    }
    if (this._pendingTodoSeed) {
      this._activeTodoCard = card; this._syncTodoDock();
      this._pendingTodoSeed = false;
    }
    this.scrollToBottom();
  }

  onToolCallUpdate(data: any, opts?: any) {
    if (this._isHiddenParentTool(data)) return;
    if (this._maybeRouteTodoToolCall(data, opts)) return;

    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (!turn) return;
    let entry = turn.tools.find((t: any) => t.id && t.id === this._toolId(data));
    if (entry) {
      if (!entry.card.isSubagent && isSubAgentCall(data)) {
        const fromHistory = !!(this._isReplaying || (opts && opts.fromHistory));
        const payload = fromHistory ? { ...data, childFinished: true, fromHistory: true } : data;
        const next = renderSubagentCard(payload);
        if (entry.card.node && entry.card.node.parentNode) {
          entry.card.node.parentNode.replaceChild(next.node, entry.card.node);
        }
        try { if (typeof entry.card.dispose === 'function') entry.card.dispose(); } catch { /* ignore */ }
        entry.card = next;
        const live = !this._isReplaying && !(opts && opts.fromHistory);
        const st = String(next.getStatus && next.getStatus() || '');
        if (this._wantLiveChip(live, st)) this._trackSubagent(data, next);
      } else {
        const fromHistory = !!(this._isReplaying || (opts && opts.fromHistory));
        entry.card.applyUpdate(fromHistory ? { ...data, childFinished: true, fromHistory: true } : data);
        if (entry.card.isSubagent) {
          const st = String(entry.card.getStatus && entry.card.getStatus() || '');
          const liveNow = !this._isReplaying && !(opts && opts.fromHistory);
          if (this._wantLiveChip(liveNow, st)) this._trackSubagent(data, entry.card);
        }
      }
    } else {
      // Updates never create cards. Ring replay of completed patches
      // used to flood the UI; live work always starts with tool_call.
      return;
    }
    // Always reconcile the strip against the actual pill statuses. This is
    // robust to wire-format variations: whatever rendered the pill as
    // COMPLETED also drains its chip from the strip.
    this._resyncInFlightStrip();

    // If a file-mutating tool (Write / Edit / MultiEdit, all kind: 'edit')
    // just completed, ping the Files panel so it can re-list. Skipped while
    // replaying history because the disk is already in its final state and
    // a flurry of refreshes during catch-up wastes IO. The event carries
    // the agent id so the listener can ignore updates from a stale mount.
    if (!this._isReplaying && this.agentId) {
      const status = String((data && data.status) || '').toLowerCase();
      const kind   = String((data && data.kind)   || '').toLowerCase();
      if (status === 'completed' && kind === 'edit') {
        document.dispatchEvent(new CustomEvent('grok-remote:files-changed', {
          detail: { agentId: this.agentId, toolCallId: data.toolCallId },
        }));
      }
    }
  }

  // Walk the current turn's tools and drop any strip chips whose card has
  // reached a terminal status. Cheap (small N) and self-healing if an
  // intermediate event was missed.
  _resyncInFlightStrip() {
    if (!this._inFlightMap.size) return;
    const TERMINAL = new Set(['completed','failed','canceled','cancelled','success','succeeded','error','errored']);
    // Collect all currently-rendered tool ids across all turns since strip
    // chips can outlive a single turn boundary.
    const liveByActive = new Map(); // id -> status string (lowercased)
    for (const turn of this.turns) {
      for (const t of (turn.tools || [])) {
        const s = (t.card && t.card.getStatus && t.card.getStatus() || '').toLowerCase();
        liveByActive.set(t.id, s);
      }
    }
    for (const tid of Array.from(this._inFlightMap.keys())) {
      const s = liveByActive.get(tid);
      // Gone from any turn (shouldn't happen, but defensive) or terminal: drop.
      if (s == null || TERMINAL.has(s)) {
        this._removeInFlight(tid);
      }
    }
  }

  onToolCallDelta(data: any) {
    const turn = this.activeTurn || this.turns[this.turns.length - 1];
    if (!turn || !turn.tools.length) return;
    // append to most-recent open tool card
    let target = null;
    for (let i = turn.tools.length - 1; i >= 0; i--) {
      const status = turn.tools[i].card.getStatus();
      if (status !== 'completed' && status !== 'failed') { target = turn.tools[i]; break; }
    }
    if (!target) target = turn.tools[turn.tools.length - 1];
    if (data && data.toolCallId) {
      const exact = turn.tools.find((t: any) => t.id === data.toolCallId);
      if (exact) target = exact;
    }
    target.card.appendDelta(data);
    this.scrollToBottom();
  }

  onAvailableCommands(data: any) {
    const list = (data && data.availableCommands) || data && data.commands || data;
    if (Array.isArray(list)) this.setAvailableCommands(list);
  }

  onHandshake(data: any) {
    this._clearErrorBanners();
    // Agent-manager forwards { meta, agentCapabilities } as the SSE payload.
    const caps = data && (data.agentCapabilities || data.agent_capabilities);
    const pc = caps && caps.promptCapabilities;
    if (pc && typeof pc.image === 'boolean') {
      const before = !!this._promptCapImage;
      this._promptCapImage = !!pc.image;
      if (before !== this._promptCapImage) {
        this._syncAttachBtn();
        if (this.imageAttach) this.imageAttach.refreshSupport();
        // If the new model dropped image support, surface a clear warning.
        const atts = this.imageAttach ? this.imageAttach.getAttachments() : [];
        if (!this._promptCapImage && atts.length) {
          this.showToast('Active model no longer supports image input. Remove attachments to send.', 'warn');
        }
      }
    }
  }

  onCompactUpdate(name: any, payload: any, opts?: any) {
    const upd = compactUpdateFromPayload(String(name || ''), payload);
    if (!upd) return;
    const fromHist = !!(this._isReplaying || (opts && opts.fromHistory));
    if (upd.phase === 'failed') {
      if (fromHist) return;
      this._finishCompact(upd, false);
      this.showToast(upd.reason || 'Compact failed', 'warn');
      return;
    }
    if (upd.phase === 'started' || upd.phase === 'checkpoint') {
      // Compact RPC can echo a late ACP "started" after THIS compact
      // finished. A previous compact (including history) must not hide
      // the next auto-compact's Compacting… card.
      if (shouldIgnoreLateCompactStarted({
        compacting: !!this._compacting,
        compactFinished: !!this._compactFinished,
        finishedAt: this._compactFinishedAt,
      })) return;
      if (!shouldPaintCompactStarted({
        fromHistory: fromHist,
        replaying: !!this._isReplaying,
        isReplay: compactPayloadIsReplay(payload),
        turnOpen: !!this._turnOpen,
      })) return;
      this._compactFinished = false;
      this._compactFinishedAt = 0;
      this._compacting = true;
      const preview = compactingPreview(upd);
      if (this._compactCard && this._compactCard.isConnected) {
        paintCompactCard(this._compactCard, { busy: true, label: 'Compacting…', preview });
      } else {
        const card = renderCompactingCard(preview);
        this._compactCard = card;
        (this.streamEl || this.root).appendChild(card);
      }
      if (upd.tokensUsed != null) applyOccupancy(this, upd.tokensUsed);
      try {
        document.dispatchEvent(new CustomEvent('grok-remote:agent-working', {
          detail: { id: this.agentId, working: true },
        }));
      } catch { /* ignore */ }
      if (typeof this._renderTokensPill === 'function') this._renderTokensPill();
      this._paintLiveStatus();
      this._syncSendBtn();
      if (!this._isReplaying) this.scrollToBottom();
      return;
    }
    const skipNotice = fromHist || (compactPayloadIsReplay(payload) && !this._turnOpen);
    this._finishCompact(upd, skipNotice);
  }

  _finishCompact(upd: any, fromHist: boolean) {
    if (fromHist) {
      const afterHist = upd && typeof upd.tokensAfter === 'number' ? upd.tokensAfter : null;
      if (afterHist != null) {
        applyOccupancy(this, afterHist);
        this._queueSidebarTokens(afterHist);
      }
      if (typeof this._renderTokensPill === 'function') this._renderTokensPill();
      return;
    }
    const alreadyDone = !this._compacting && this._compactFinished;
    this._compacting = false;
    this._compactFinished = true;
    this._compactFinishedAt = Date.now();
    this._compactSucceeded = !(upd && upd.phase === 'failed');
    if (typeof this._compactWait === 'function') {
      const done = this._compactWait;
      this._compactWait = null;
      try { done(); } catch { /* ignore */ }
    }
    if (alreadyDone) {
      const afterDone = upd && typeof upd.tokensAfter === 'number' ? upd.tokensAfter : null;
      if (afterDone != null) {
        applyOccupancy(this, afterDone);
        this._queueSidebarTokens(afterDone);
      }
      if (typeof this._renderTokensPill === 'function') this._renderTokensPill();
      return;
    }
    const preview = compactingPreview(upd);
    const body = String((upd && upd.summaryPreview) || preview || '').trim();
    if (this._compactCard && this._compactCard.isConnected) {
      const pill = renderCompactedPill(body);
      try { this._compactCard.replaceWith(pill); } catch {
        (this.streamEl || this.root).appendChild(pill);
      }
      this._compactCard = pill;
    } else if (!fromHist) {
      const pill = renderCompactedPill(body);
      this._compactCard = pill;
      (this.streamEl || this.root).appendChild(pill);
    }
    const after = upd && typeof upd.tokensAfter === 'number' ? upd.tokensAfter : null;
    if (after != null) {
      applyOccupancy(this, after);
      this._queueSidebarTokens(after);
    }
    if (!this._turnOpen) {
      try {
        document.dispatchEvent(new CustomEvent('grok-remote:agent-working', {
          detail: { id: this.agentId, working: false },
        }));
      } catch { /* ignore */ }
    }
    if (typeof this._renderTokensPill === 'function') this._renderTokensPill();
    this._paintLiveStatus();
    this._syncSendBtn();
    if (!this._isReplaying) this.scrollToBottom();
  }

  onSessionSummary(data: any, opts?: any) {
    // Grok compact rewrites chat_history.jsonl. The grok-remote journal
    // still has the full conversation. Reloading must not re-paint that
    // continuation as a "Context Compacted" card on every visit.
    if (this._compacting && !(this._isReplaying || (opts && opts.fromHistory))) {
      this._finishCompact({
        phase: 'completed',
        summaryPreview: (data && (data.summary || data.text)) || extractText(data) || '',
      }, false);
      return;
    }
    if (this._isReplaying || (opts && opts.fromHistory)) return;
    const text = (data && (data.summary || data.text)) || extractText(data) || '';
    const body = String(text || '').trim();
    if (this.streamEl) {
      const cards = this.streamEl.querySelectorAll('.compacted-card, .compacted-pill');
      for (const card of Array.from(cards)) {
        const have = String(card.textContent || '');
        if (body && have.indexOf(body.slice(0, 60)) >= 0) return;
        if (!body && have.indexOf('Context Compacted') >= 0) return;
      }
    }
    const pill = renderCompactedPill(text);
    (this.streamEl || this.root).appendChild(pill);
    if (!this._isReplaying) this.scrollToBottom();
  }

  onAgentUpdated(data: any) {
    if (!this.currentAgent || !data) return;
    const live = data.liveModel || data.modelId;
    if (typeof live === 'string' && live.trim()) this.currentAgent.liveModel = live.trim();
    const win = data.contextWindow || data.context_window;
    if (typeof win === 'number' && win > 0) this.currentAgent.contextWindow = win;
    if (live || (typeof win === 'number' && win > 0)) clearContextWindow(this);
    this._renderModelPill();
    if (typeof this._renderTokensPill === 'function') this._renderTokensPill();
  }

  onPromptComplete(data: any, opts?: any) {
    const meta = (data && data._meta) || data || {};
    if (meta && (meta.totalTokens != null || meta.total_tokens != null)) {
      applyOccupancy(this, meta.totalTokens ?? meta.total_tokens);
      this._queueSidebarTokens(meta.totalTokens ?? meta.total_tokens);
    }
    this._renderInflightPill();
    // History collapse puts prompt_complete BEFORE the reply. Ending the
    // turn here parked the Grok bubble on a new empty You turn, so it
    // only appeared after a late layout. Finalize after replay instead.
    if (this._isReplaying || (opts && opts.fromHistory)) return;
    this._resyncInFlightStrip();
    const serverFlight = this.currentAgent && typeof this.currentAgent.inFlight === 'number'
      ? this.currentAgent.inFlight : 0;
    const gate = promptCompleteGate({
      localInFlight: this._localInFlightCount(),
      openTools: this._turnHasOpenTools(),
      serverFlight,
    });
    // The server already finished this turn. A card stuck on Pending
    // (missing terminal update) must not hold the queued message.
    if (gate === 'wait') {
      this._paintLiveStatus();
      this._syncSendBtn();
      return;
    }
    if (gate === 'close-and-finish') {
      const stopReason = meta && (meta.stopReason || meta.stop_reason);
      this._closeOpenTools(this.activeTurn, terminalToolStatus(stopReason));
      this._clearAllInFlight();
    }
    this._finishTurnSubagents();
    this._clearAllInFlight();
    // Capture sessionId/cwd from prompt_complete meta if the agent record is
    // missing it (handshake metadata is sometimes delivered out of band).
    if (this.currentAgent) {
      if (meta.sessionId && !this.currentAgent.sessionId) {
        this.currentAgent.sessionId = meta.sessionId;
      }
      if (meta.modelId && !this.currentAgent.model) {
        this.currentAgent.model = meta.modelId;
      }
      // refresh the info pane if visible
      if (this.tabsState === 'info') this.renderInfo(this.currentAgent);
    }
    this.endTurn(meta);
    this._turnOpen = false;
    this._turnOpenHoldUntil = 0;
    try {
      document.dispatchEvent(new CustomEvent('grok-remote:agent-working', {
        detail: { id: this.agentId, working: false },
      }));
    } catch { /* ignore */ }
    if (this.currentAgent && this.currentAgent.status === 'running') {
      this.currentAgent.status = 'idle';
    }
    this._paintLiveStatus();
    this._syncSendBtn();
    void this._flushQueue();
  }

  onAgentStatus(data: any) {
    const status = data && (data.status || data.state);
    if (!status) return;
    const err = data && (data.error || data.message);
    if (!this._isReplaying && typeof data.inFlight === 'number' && this.currentAgent) {
      this.currentAgent.inFlight = data.inFlight;
    }
    if (!this._isReplaying && typeof data.turnOpen === 'boolean') {
      this._turnOpen = followServerTurnOpen({
        local: !!this._turnOpen,
        server: data.turnOpen,
        holdUntil: this._turnOpenHoldUntil,
      });
      if (this.currentAgent) this.currentAgent.turnOpen = this._turnOpen;
    }
    const working = !this._isReplaying && isDisplayedWorking({
      turnOpen: !!this._turnOpen,
      inFlight: Math.max(
        this.currentAgent && typeof this.currentAgent.inFlight === 'number'
          ? this.currentAgent.inFlight : 0,
        this._localInFlightCount(),
      ),
    });
    if (String(status) === 'idle' && working) {
      if (this.currentAgent) this.currentAgent.status = 'running';
      this._paintLiveStatus();
      return;
    }
    if (String(status) === 'running' && !working) {
      if (this.currentAgent) this.currentAgent.status = 'idle';
      this._paintLiveStatus();
      return;
    }
    if (!shouldApplyAgentStatus(this.currentAgent, status, err)) {
      this._paintLiveStatus();
      return;
    }
    if (this.currentAgent) this.currentAgent.status = status;
    this._syncConnectBtn();
    this._paintLiveStatus();
  }

  onSessionNotification(data: any) {
    const text = (data && (data.message || data.text)) || JSON.stringify(data).slice(0, 200);
    this.showToast(text, 'info');
  }

  onError(data: any) {
    const text = errorBannerText(data);
    if (!text) {
      this._paintLiveStatus();
      return;
    }
    const turn = this.activeTurn || this.ensureTurn();
    turn.root.appendChild(renderErrorBanner(text));
    this.scrollToBottom();
  }

  _clearErrorBanners() {
    const hosts = [this.streamEl, this.root].filter(Boolean);
    for (const host of hosts) {
      host.querySelectorAll('.error-banner').forEach((n: Element) => {
        try { n.remove(); } catch { /* ignore */ }
      });
    }
  }

  // ── /model and /effort (CLI-compatible, applied to this conversation) ─

  static get MODEL_EFFORTS() {
    return MODEL_EFFORT_LEVELS.slice();
  }

  _parseModelCommand(rest: string) {
    return parseModelCommand(this, rest);
  }

  async _tryLocalSessionCommand(text: string) {
    const href = localSessionHref(text, this._mergedCommands());
    if (href) {
      window.location.hash = href;
      return true;
    }
    const m = String(text || '').trim().match(/^\/(rewind|undo|fork|always-approve|auto|copy|export|timestamps|context|context-window|session-info|compact)(?:\s+(.*))?$/i);
    if (!m) return false;
    const cmd = (m[1] || '').toLowerCase();
    const rest = (m[2] || '').trim();
    if (cmd === 'rewind' || cmd === 'undo') {
      if (rest && /^\d+$/.test(rest)) await this._rewindTo(parseInt(rest, 10));
      else this._openRewindPicker();
      return true;
    }
    if (cmd === 'fork') { await this._forkSession(rest); return true; }
    if (cmd === 'always-approve') { await this._toggleAlwaysApprove(); return true; }
    if (cmd === 'auto') { await this._setPermissionMode('auto'); return true; }
    if (cmd === 'copy') {
      const n = rest && /^\d+$/.test(rest) ? parseInt(rest, 10) : 1;
      await this.copyLastReply(n);
      return true;
    }
    if (cmd === 'export') {
      const mode = rest.toLowerCase();
      if (mode === 'copy') await this.copyConversation();
      else this.downloadConversation();
      return true;
    }
    if (cmd === 'context' || cmd === 'session-info') { void this._openContextPanel(); return true; }
    if (cmd === 'context-window') {
      const n = Number(String(rest || '').replace(/[,_]/g, ''));
      if (Number.isFinite(n) && n > 0) await this._applyModelSettings({ contextWindow: Math.floor(n) });
      else this._openModelPicker();
      return true;
    }
    if (cmd === 'compact') { void this._runCompact(rest); return true; }
    if (cmd === 'timestamps') {
      const mode = rest.toLowerCase();
      if (mode === 'on' || mode === '1' || mode === 'true') {
        setTimestampMode('on');
        this.showToast('Timestamps on.', 'info');
      } else if (mode === 'off' || mode === '0' || mode === 'false') {
        setTimestampMode('off');
        this.showToast('Timestamps off.', 'info');
      } else if (mode === 'minimal' || mode === 'min') {
        setTimestampMode('minimal');
        this.showToast('Timestamps show on hover.', 'info');
      } else {
        this._toggleTimestamps();
      }
      return true;
    }
    return false;
  }

  _openRewindPicker() {
    const turns = (this.turns || []).filter((t: any) => {
      const text = String(t && t.userText || '').trim();
      return !!text && !isAutomaticRuntimePrompt(text);
    });
    if (!turns.length) { this.showToast('Nothing to rewind.', 'info'); return; }
    this._cliPaneMode = 'rewind';
    const pane = this.cliPaneEl;
    if (!pane) return;
    pane.hidden = false;
    const list = el('div', { class: 'cli-pane__list' });
    const painted = turns.length;
    const total = Math.max(painted, Number(this._historyTotalTurns) || painted);
    turns.forEach((t: any, i: number) => {
      const preview = String(t.userText || '').replace(/\s+/g, ' ').slice(0, 140);
      const keep = rewindKeepTurns(total, painted, i);
      list.appendChild(el('button', {
        type: 'button',
        class: 'cli-pane__row',
        onclick: () => { void this._rewindTo(keep, String(t.userText || '')); },
      },
        el('span', { class: 'cli-pane__kind' }, `#${keep}`),
        el('span', { class: 'cli-pane__label' }, preview || '(empty)'),
      ));
    });
    pane.replaceChildren(
      el('div', { class: 'cli-pane__head' },
        el('span', { class: 'cli-pane__title' }, 'Rewind to turn'),
        el('button', { type: 'button', class: 'cli-pane__close', onclick: () => this._closeCliPane() }, 'Close'),
      ),
      el('div', { class: 'cli-pane__empty' }, 'File changes on disk are kept. Conversation after the chosen turn is dropped.'),
      list,
    );
  }

  async _runCompact(context?: string) {
    if (!canStartCompact(this)) return;
    this._closeCliPane && this._closeCliPane();
    const note = String(context || '').trim();
    this._compactFinished = false;
    this._compactFinishedAt = 0;
    this._compactSucceeded = false;
    this._compacting = true;
    if (typeof this._renderTokensPill === 'function') this._renderTokensPill();
    this.showToast('Compacting context…', 'info');
    try {
      const card = typeof renderCompactingCard === 'function'
        ? renderCompactingCard(note || 'Compressing conversation history')
        : null;
      if (card) {
        this._compactCard = card;
        (this.streamEl || this.root).appendChild(card);
        if (!this._isReplaying) this.scrollToBottom();
      }
    } catch { /* paint is best-effort */ }
    try {
      await api.compact(this.agentId, note ? { context: note } : {});
      await this._awaitCompactSettle(180000);
      if (this._compactSucceeded) {
        this.showToast('Context compacted', 'info');
        return;
      }
      if (this._compactFinished && !this._compactSucceeded) return;
      this.showToast('Compact is still running…', 'info');
      applyCompactSettleTimeout(this);
    } catch (e: any) {
      if (this._compactSucceeded) {
        this.showToast('Context compacted', 'info');
        return;
      }
      if (this._compactFinished && !this._compactSucceeded) return;
      this.showToast(`Compact failed: ${e && e.message ? e.message : String(e)}`, 'warn');
      applyCompactSettleTimeout(this);
      if (this._compactCard && this._compactCard.isConnected && !this._compactSucceeded) {
        try { this._compactCard.remove(); } catch { /* ignore */ }
        this._compactCard = null;
      }
    }
  }

  _awaitCompactSettle(ms: number) {
    if (this._compactFinished) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this._compactWait = null;
        resolve();
      };
      this._compactWait = finish;
      setTimeout(finish, Math.max(1000, Number(ms) || 0));
    });
  }

  async _rewindTo(keepTurns: number, restoreText?: string) {
    if (!this.agentId) return;
    this._closeCliPane();
    try {
      const out: any = await api.rewind(this.agentId, keepTurns);
      this.showToast(`Rewound to turn ${keepTurns}${out && out.rpc ? '' : ' (UI history).'}`, 'info');
      await this.refreshHistory({ turns: 50 });
      const text = String(restoreText || '');
      if (text && this.composerTa) {
        this.composerTa.value = text;
        try { this.composerTa.focus(); } catch { /* ignore */ }
        const n = text.length;
        try { this.composerTa.setSelectionRange(n, n); } catch { /* ignore */ }
      }
    } catch (e: any) {
      this.showToast(`Rewind failed: ${e && e.message ? e.message : String(e)}`, 'warn');
    }
  }

  async _forkSession(directive?: string) {
    if (!this.agentId) return;
    try {
      const child: any = await api.fork(this.agentId, { directive });
      const id = child && (child.id || (child.agent && child.agent.id));
      if (!id) throw new Error('server did not return a fork id');
      this.showToast('Forked into a new conversation.', 'info');
      location.hash = `#/agents/${encodeURIComponent(id)}`;
    } catch (e: any) {
      this.showToast(`Fork failed: ${e && e.message ? e.message : String(e)}`, 'warn');
    }
  }

  _permissionMode(): PermissionMode {
    return readPermissionMode(this.currentAgent && this.currentAgent.settings);
  }

  async _toggleAlwaysApprove() {
    const on = this._permissionMode() === 'always-approve';
    await this._setPermissionMode(on ? 'ask' : 'always-approve');
  }

  async _setPermissionMode(mode: string) {
    if (!this.agentId) return;
    const next = mode as PermissionMode;
    const always = next === 'always-approve';
    const running = !!(this.currentAgent && this.currentAgent.status === 'running');
    try {
      const updated: any = await api.updateAgent(this.agentId, {
        settings: permissionSettingsPatch(next),
      });
      this._planArmed = false;
      this.applyAgentRefresh(updated);
      const label = permissionLabel(next);
      const needReconnect = permissionNeedsReconnect(next);
      if (needReconnect && !running) {
        this.showToast(`${label} — reconnecting so prompts can appear.`, 'info');
        try { await api.disconnect(this.agentId); await api.connect(this.agentId); } catch { /* ignore */ }
      } else if (needReconnect && running) {
        this.showToast(`${label} saved. Reconnect after this turn to show permission cards.`, 'info');
      } else {
        this.showToast(`${label} on.`, 'info');
      }
    } catch (e: any) {
      this.showToast(`Permission mode failed: ${e && e.message ? e.message : String(e)}`, 'warn');
    }
  }

  _onPermissionRequest(payload: any) {
    const req = payload || {};
    const requestId = req.requestId || req.id;
    if (!requestId) return;
    if (this._hasCard(String(requestId))) return;
    const tool = req.toolCall || {};
    const title = String(tool.title || tool.kind || 'Permission');
    const q = (tool.rawInput && (tool.rawInput.question || tool.rawInput.prompt || tool.rawInput.text)) || '';
    const opts = Array.isArray(req.options) && req.options.length ? req.options : [
      { optionId: 'allow_once', name: 'Allow once' },
      { optionId: 'allow_always', name: 'Allow always' },
      { optionId: 'reject_once', name: 'Reject' },
    ];
    const card = el('div', { class: 'perm-card', dataset: { requestId: String(requestId) } },
      el('div', { class: 'perm-card__kicker' }, title.toLowerCase().includes('ask') ? 'Question' : 'Permission'),
      el('div', { class: 'perm-card__title' }, title),
      q ? el('div', { class: 'perm-card__q' }, String(q)) : null,
      el('div', { class: 'perm-card__opts' },
        ...opts.map((o: any) => el('button', {
          type: 'button',
          class: 'btn' + ((String(o.kind || o.optionId).indexOf('reject') >= 0 || String(o.kind || o.optionId).indexOf('cancel') >= 0) ? ' btn--ghost' : ' btn--primary'),
          title: String(o.optionId || o.kind || '').indexOf('allow_once') >= 0 ? 'Applies to the next command only' : '',
          onclick: async () => {
            try {
              await api.permission(this.agentId, requestId, o.optionId || o.id);
              card.remove();
            } catch (e: any) {
              this.showToast(`Could not answer: ${e && e.message ? e.message : String(e)}`, 'warn');
            }
          },
        }, o.name || o.label || o.optionId)),
      ),
    );
    const host = this.cliPaneEl && this.cliPaneEl.parentElement;
    if (host) host.insertBefore(card, this.composerEl || null);
    else if (this.streamEl) this.streamEl.appendChild(card);
    this.scrollToBottom();
  }

  _planTextFromParams(params: any): string {
    const p = params || {};
    const keys = ['planContent', 'plan_content', 'content', 'plan', 'markdown', 'text', 'body'];
    for (const k of keys) {
      if (typeof p[k] === 'string' && p[k].trim()) return p[k];
    }
    if (p.plan && typeof p.plan === 'object') {
      const inner = p.plan as any;
      for (const k of keys) {
        if (typeof inner[k] === 'string' && inner[k].trim()) return inner[k];
      }
    }
    return '';
  }

  _mountInteractiveCard(card: HTMLElement): void {
    const host = this.composerEl && this.composerEl.parentElement;
    const root = this.root || document;
    const rid = card.dataset && card.dataset.requestId;
    root.querySelectorAll('.plan-card, .perm-card').forEach((n) => {
      const eln = n as HTMLElement;
      if (rid && eln.dataset && eln.dataset.requestId === rid) n.remove();
      else if (!rid || n !== card) n.remove();
    });
    if (host && this.composerEl && this.composerEl.parentNode === host) {
      host.insertBefore(card, this.composerEl);
    } else if (this.streamEl) {
      this.streamEl.appendChild(card);
    }
  }

  _hasCard(requestId: string): boolean {
    if (!requestId || !this.root) return false;
    const nodes = this.root.querySelectorAll('[data-request-id]');
    for (const n of Array.from(nodes)) {
      if ((n as HTMLElement).dataset.requestId === requestId) return true;
    }
    return false;
  }

  async _syncPendingCards() {
    if (!this.agentId || this._isReplaying) return;
    try {
      const data: any = await api.pendingInteractions(this.agentId);
      const items = (data && Array.isArray(data.items)) ? data.items : [];
      for (const it of items) {
        if (!it) continue;
        const kind = it.kind;
        if (kind === 'exit_plan_mode') this._onPlanApproval(it);
        else if (kind === 'ask_user_question') this._onUserQuestion(it);
        else if (kind === 'permission') this._onPermissionRequest(it);
      }
    } catch { /* older servers */ }
  }

  async _answerInteraction(requestId: string, result: any, card: HTMLElement): Promise<void> {
    try {
      await api.interaction(this.agentId, requestId, result);
      card.remove();
      if (!card.classList.contains('plan-card--q')) this._planArmed = false;
      this._paintModePill();
      this._paintLiveStatus();
    } catch (e: any) {
      this.showToast(`Could not answer: ${e && e.message ? e.message : String(e)}`, 'warn');
    }
  }

  _onPlanApproval(payload: any, opts?: any) {
    if (this._isReplaying || (opts && opts.fromHistory)) return;

    const req = payload || {};
    const requestId = req.requestId || req.id;
    if (!requestId) return;
    if (this._hasCard(String(requestId))) return;
    const params = req.params || req;
    const text = this._planTextFromParams(params);
    const empty = !text.trim() || params.empty === true || params.emptyPlan === true;
    const preview = empty
      ? 'No plan written yet. You can still approve to start implementing, request changes, or abandon.'
      : text;
    const body = el('pre', { class: 'plan-card__body' }, preview);
    const feedback = el('textarea', {
      class: 'plan-card__feedback',
      rows: '1',
      placeholder: 'Optional feedback if you request changes',
    }) as HTMLTextAreaElement;
    const toggle = el('button', {
      type: 'button',
      class: 'plan-card__toggle',
      onclick: (ev: Event) => {
        ev.preventDefault();
        card.classList.toggle('is-open');
        toggle.textContent = card.classList.contains('is-open') ? 'Collapse' : 'Expand';
      },
    }, 'Expand');
    const card = el('div', { class: 'plan-card', dataset: { requestId: String(requestId) } },
      el('div', { class: 'plan-card__head' },
        el('div', { class: 'plan-card__kicker' }, 'Plan'),
        el('div', { class: 'plan-card__title' }, empty ? 'No Plan Written Yet' : 'Proposed Plan'),
        toggle,
      ),
      body,
      feedback,
      el('div', { class: 'plan-card__opts' },
        el('button', {
          type: 'button', class: 'btn btn--primary',
          onclick: () => void this._answerInteraction(requestId, { type: 'approved' }, card),
        }, 'Approve'),
        el('button', {
          type: 'button', class: 'btn',
          onclick: () => void this._answerInteraction(requestId, {
            type: 'request_changes',
            feedback: (feedback.value || '').trim() || 'Please revise the plan.',
          }, card),
        }, 'Request Changes'),
        el('button', {
          type: 'button', class: 'btn btn--ghost',
          onclick: () => void this._answerInteraction(requestId, { type: 'abandoned' }, card),
        }, 'Abandon'),
      ),
    );
    this._mountInteractiveCard(card);
    this._planArmed = true;
    this._paintModePill();
    this._paintLiveStatus();
  }

  _onUserQuestion(payload: any) {
    if (this._isReplaying) return;
    const req = payload || {};
    const requestId = req.requestId || req.id;
    if (!requestId) return;
    if (this._hasCard(String(requestId))) return;
    const params = req.params || req;
    let questions = params.questions;
    if (!Array.isArray(questions) && params.params && Array.isArray(params.params.questions)) {
      questions = params.params.questions;
    }
    if (!Array.isArray(questions)) questions = [];
    const selected: Record<number, string[]> = {};
    const qNodes = questions.map((q: any, qi: number) => {
      const multi = !!(q && (q.multi_select || q.multiSelect));
      const opts = Array.isArray(q && q.options) ? q.options : [];
      selected[qi] = [];
      const optBtns = opts.map((o: any) => {
        const label = String((o && (o.label || o.name || o.id)) || '');
        const btn = el('button', {
          type: 'button',
          class: 'plan-card__choice',
          onclick: () => {
            if (multi) {
              const i = selected[qi].indexOf(label);
              if (i >= 0) selected[qi].splice(i, 1);
              else selected[qi].push(label);
            } else {
              selected[qi] = [label];
            }
            optBtns.forEach((b: HTMLElement) => {
              const on = selected[qi].includes(b.dataset.label || '');
              b.classList.toggle('is-on', on);
            });
          },
        }, label) as HTMLButtonElement;
        btn.dataset.label = label;
        return btn;
      });
      return el('div', { class: 'plan-card__qblock' },
        el('div', { class: 'plan-card__q' }, String((q && q.question) || `Question ${qi + 1}`)),
        el('div', { class: 'plan-card__opts' }, ...optBtns),
      );
    });
    const card = el('div', { class: 'plan-card plan-card--q', dataset: { requestId: String(requestId) } },
      el('div', { class: 'plan-card__kicker' }, 'Question'),
      el('div', { class: 'plan-card__title' }, questions.length > 1 ? 'Questions' : 'Question'),
      ...qNodes,
      el('div', { class: 'plan-card__opts' },
        el('button', {
          type: 'button', class: 'btn btn--primary',
          onclick: () => {
            const answers = questions.map((_: any, i: number) => selected[i] || []);
            void this._answerInteraction(requestId, { type: 'accepted', answers }, card);
          },
        }, 'Submit'),
        el('button', {
          type: 'button', class: 'btn btn--ghost',
          onclick: () => void this._answerInteraction(requestId, { type: 'skip_interview' }, card),
        }, 'Skip'),
      ),
    );
    this._mountInteractiveCard(card);
  }

  async _tryLocalModelCommand(text: string) {
    return tryLocalModelCommand(this, text);
  }

  async _loadModelChoices() {
    return loadModelChoices(this);
  }

  _currentModelSettings() {
    return currentModelSettings(this);
  }

  async _applyModelSettings(opts: { model?: string; effort?: string; clearEffort?: boolean; contextWindow?: number } = {}) {
    return applyModelSettings(this, opts);
  }

  async _reconnectForSettings(label: string, opts?: { freshSession?: boolean }) {
    const id = this.agentId;
    if (!id) return;
    this._settingsReconnect = true;
    this.showStatus('Reconnecting…', 'idle');
    this.closeStream();
    try {
      await api.connect(id, { recreateHold: true, freshSession: !!(opts && opts.freshSession) });
    } catch (e: any) {
      this._settingsReconnect = false;
      this.openStreamForCurrent();
      this._paintLiveStatus();
      this.showToast(`Reconnect failed: ${e && e.message ? e.message : String(e)}`, 'warn');
      return;
    }
    for (let i = 0; i < 48; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (this.agentId !== id) { this._settingsReconnect = false; return; }
      try {
        const fresh: any = await api.getAgent(id);
        this.applyAgentRefresh(fresh);
        const st = fresh && fresh.status;
        if (fresh && fresh.connected && st && st !== 'starting') {
          this.openStreamForCurrent();
          await this._catchUpHistory();
          this._renderModelPill();
          this._paintModePill();
          this._paintLiveStatus();
          try { document.dispatchEvent(new CustomEvent('grok-remote:agents-refresh')); } catch { /* ignore */ }
          this.showToast(`${label} — applied.`, 'info');
          this._settingsReconnect = false;
          return;
        }
        if (st === 'errored') {
          this._settingsReconnect = false;
          this.openStreamForCurrent();
          this._paintLiveStatus();
          this.showToast(String((fresh && fresh.lastError) || 'Reconnect failed'), 'warn');
          return;
        }
      } catch { /* keep waiting */ }
    }
    this._settingsReconnect = false;
    this.openStreamForCurrent();
    this._paintLiveStatus();
    this.showToast('Reconnect is taking longer than expected. Try Disconnect, then Connect.', 'warn');
  }

  _closeModelPicker() {
    closeModelPicker(this);
  }

  async _openModelPicker(opts?: { effortOnly?: boolean }) {
    return openModelPicker(this, opts);
  }

  async _openModelPickerUnsafe(opts?: { effortOnly?: boolean }) {
    return openModelPickerUnsafe(this, opts);
  }

  // ── prompt history (CLI ↑ / ↓) ───────────────────────────────────────

  _promptHistKey() { return promptHistKey(this); }
  _loadPromptHist() { loadPromptHist(this); }
  _savePromptHist() { savePromptHist(this); }
  _rememberPrompt(text: string, persist: boolean) { rememberPromptOnView(this, text, persist); }
  _pushPromptHist(text: string) { pushPromptHist(this, text); }
  _promptHistOpen() { promptHistOpen(this); }
  _closePromptHist() { closePromptHist(this); }
  _togglePromptHist() { togglePromptHist(this); }
  _restorePromptDraft() { restorePromptDraft(this); }
  _applyPromptHistIdx() { applyPromptHistIdx(this); }
  _stepPromptHist(dir: number) { stepPromptHist(this, dir); }
  _onPromptHistKey(ev: any) { return onPromptHistKey(this, ev); }
  _renderPromptHist() { renderPromptHist(this); }

  _toggleCliPane(mode: string) { toggleCliPane(this, mode); }
  _closeCliPane() { closeCliPane(this); }
  _renderCliPane() { renderCliPane(this); }
  _collectTodos() { return collectTodos(this); }
  _collectTodoLists() { return collectTodoLists(this); }
  _conversationWorking() { return conversationWorking(this); }
  _syncTodoDock() { syncTodoDock(this); }
  _collapseHistoryTodos() { collapseHistoryTodos(this); }
  _collectTasks() { return collectTasks(this); }

  _atQuery() {
    return atQuery(this);
  }

  async _onAtQuery() {
    return onAtQuery(this);
  }

  async _buildFileIndex() {
    return buildFileIndex(this);
  }

  _renderAtPalette(matches: string[], hit: any) {
    renderAtPalette(this, matches, hit);
  }

  _closeAtPalette() {
    closeAtPalette(this);
  }

  _insertAtPath(path: string, hit: any) {
    insertAtPath(this, path, hit);
  }

  _onAtKey(ev: any) {
    onAtKey(this, ev);
  }

  // ── scrollback find ──────────────────────────────────────────────────

  _toggleFindBar(forceOpen?: boolean) {
    toggleFindBar(this, forceOpen);
  }

  _closeFindBar() {
    closeFindBar(this);
  }

  _runFind(q: string) {
    runFind(this, q);
  }

  _stepFind(dir: number) {
    stepFind(this, dir);
  }

  // ── composer actions ────────────────────────────────────────────────

  _isWorking() { return isWorking(this); }
  _wantLiveChip(live: boolean, st: string): boolean { return wantLiveChip(this, live, st); }
  _pruneLiveBar() { pruneLiveBar(this); }
  _syncSendBtn() { syncSendBtn(this); }
  _renderQueueBar() { renderQueueBar(this); }
  _enqueuePrompt(text: string, attachments: any[]) { enqueuePrompt(this, text, attachments); }
  async _flushQueue() { return flushQueue(this); }
  async send(opts?: any) { return sendPrompt(this, opts); }
  async _forceSendQueued() { return forceSendQueued(this); }
  async _steerQueued() { return steerQueued(this); }
  _buildPayloadSnapshot(text: any, attachments: any) { return buildPayloadSnapshot(this, text, attachments); }
  openPayloadInspector() { openPayloadInspector(this); }
  _truncateBase64(pretty: any) { return truncateBase64(this, pretty); }
  async cancel() { return cancelPrompt(this); }

  toggleSettingsDrawer() {
    toggleSettingsDrawerFn(this);
  }

  openSettingsDrawer() {
    openSettingsDrawerFn(this);
  }

  closeSettingsDrawer() {
    closeSettingsDrawerFn(this);
  }

  _buildSettingsDrawer() {
    buildSettingsDrawer(this);
  }

  _renderModelDatalist() {
    renderModelDatalist(this);
  }

  _populateSettingsDrawer(agent: any) {
    populateSettingsDrawer(this, agent);
  }

  _markSettingsDirty() {
    markSettingsDirty(this);
  }

  _updateSettingsNotice(agent: any) {
    updateSettingsNotice(this, agent);
  }

  _collectSettings() {
    return collectSettings(this);
  }

  async _submitSettingsDrawer() {
    return submitSettingsDrawer(this);
  }

  async _clearSettingsDrawer() {
    return clearSettingsDrawer(this);
  }

}

// `unwrap` and `extractText` moved to ../lib/acp-payload.ts so they're
// typed + unit-testable. Imported above.

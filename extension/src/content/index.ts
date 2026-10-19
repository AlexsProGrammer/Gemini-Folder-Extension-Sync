import { ChatRef, Project, RuntimeState, StoredState, SyncStatus } from '../shared/types';
import { debugStep, errorMessage, errorName, errorStack, storageLocalGet, storageLocalSet } from '../shared/webext';
import {
  createDefaultFeatureSettings,
  deleteWorkspaceProject,
  FEATURE_SETTINGS_CHANGED_EVENT,
  getFeatureSettings,
  getWorkspace,
  initDebugLoggingFlag,
  moveWorkspaceChat,
  onWorkspaceSaved,
  setWorkspaceChatPinned,
  setWorkspaceProjectPinned,
  updateWorkspaceUiPrefs,
  upsertWorkspaceChatRefs,
  upsertWorkspaceProject,
  workspaceToStoredState
} from '../shared/storage';
import {
  syncEngine,
  SYNC_CONFLICT_EVENT,
  SYNC_STATUS_EVENT,
  WORKSPACE_UPDATED_EVENT
} from '../shared/syncEngine';
import { getSyncSettings } from '../shared/storage';
import {
  ACCOUNT_CHANGED_EVENT,
  AccountChangeDetail,
  getActiveAccountHash,
  initAccountWatcher,
  resolveActiveAccountHash
} from './accountWatcher';
import {
  findChatRowElement,
  findChatsListContainer,
  findChatsSection,
  findGemsSection,
  findSidebarRoot,
  getConversationId,
  getConversationIdFromChatRow,
  injectProjectsSection
} from './dom/anchors';
import { attachChatMenuEnhancer } from './dom/menus';
import { findChatComposer, initComposerObserver, hasUserTurnsInChat } from './dom/composerObserver';
import { initGeminiResponseFolding } from './gemini/responseFolding';
import * as prompts from './prompts';
import { composerContainsInstructions } from './prompts/composer';
import {
  configureInstructionsButton,
  injectProjectInstructions,
  prependProjectInstructions,
  setInstructionsButtonVisible
} from './prompts/injector';
import { installSidebarInspector } from './sidebarInspector';
import { CHAT_DRAG_MIME, createProjectsPanel } from './ui/projectsPanel';
import { initChatGPT } from './chatgpt';

const BUILD_MARKER = '2.0.7-vault3-fix1';
const HIDDEN_ATTR = 'data-gp-native-hidden';
const RESCAN_DELAY_MS = 350;
const PANEL_READY_RETRY_MS = 120;
const PANEL_READY_RETRY_LIMIT = 40;
const MIN_EXPANDED_SIDEBAR_WIDTH = 180;
const COLLAPSED_FOLDERS_KEY_PREFIX = 'collapsed_folders_';
/** Survives the full page navigation that opening a new chat triggers. */
const PENDING_NEW_CHAT_KEY = 'gp_pending_new_chat_project';

const state: RuntimeState = {
  projects: [],
  chatIndex: new Map(),
  collapsedProjectIds: new Set(),
  nativeConversationIds: new Set(),
  nativeChatsReady: false,
  ui: {
    createModalOpen: false,
    contextMenuOpen: false,
    pendingMoveConversationId: null
  },
  uiPrefs: { projectsCollapsed: false, foldersCollapsed: false }
};

let panel: ReturnType<typeof createProjectsPanel> | null = null;
let panelHost: HTMLElement | null = null;
let sidebarRoot: HTMLElement | null = null;
let chatsHeader: HTMLElement | null = null;
let chatsList: HTMLElement | null = null;
let rootObserver: MutationObserver | null = null;
let sidebarObserver: MutationObserver | null = null;
let chatsObserver: MutationObserver | null = null;
let rescanTimer: number | null = null;
let pendingPanelRetryCount = 0;
let lastRenderKey = '';
let chatMenuHandle: { openNativeChatMenu: (conversationId: string, anchorRect: DOMRect) => Promise<boolean> } | null = null;
let chatMenuOverlayShadow: ShadowRoot | null = null;

/** Project that should receive system-prompt injection for new conversations. */
let activeProjectId: string | null = null;
/** Project awaiting auto-assignment for a freshly created chat. */
let pendingNewChatProjectId: string | null = null;
let composerObserver: { stop: () => void } | null = null;

/**
 * Applies a mutation result (the derived runtime view of the account's
 * workspace) to the in-memory sidebar state.
 */
function applyStoredState(next: StoredState): void {
  state.projects = next.projects;
  state.chatIndex = new Map(Object.entries(next.chatIndex));
  state.uiPrefs = {
    projectsCollapsed: next.uiPrefs.projectsCollapsed === true,
    foldersCollapsed: next.uiPrefs.foldersCollapsed === true
  };
}

function applyVaultLockedNotice(): void {
  console.warn('[gemini-projects] workspace vault is locked for this account; data stays encrypted until its identity is available');
  panel?.showToast('Workspace locked: account identity unavailable');
}

/**
 * Re-derives the account's sync encryption key from the persisted settings
 * (the passphrase never lives in memory across page loads) and reconciles
 * with the server. Without this, sync would stay idle forever after a
 * reload because the engine starts with an empty key cache.
 */
async function ensureSyncUnlocked(accountHash: string): Promise<void> {
  if (!accountHash || syncEngine.hasKey(accountHash)) return;
  try {
    const settings = await getSyncSettings();
    const passphrase = settings.useGlobalPassphrase
      ? settings.globalPassphrase
      : settings.accountPassphrases[accountHash];
    if (!passphrase) return;
    const derived = await syncEngine.setPassphrase(accountHash, passphrase);
    if (derived) {
      await syncEngine.pull(accountHash);
    }
  } catch (error) {
    console.warn('[gemini-projects] sync unlock failed', error);
  }
}

/**
 * Sync engine bootstrap: local workspace writes debounce a background push,
 * window focus / connectivity changes trigger reconciliation pulls, and
 * remote updates refresh the sidebar without a page reload.
 */
function initWorkspaceSync(): void {
  onWorkspaceSaved((accountHash) => syncEngine.schedulePush(accountHash));

  window.addEventListener('focus', () => {
    const accountHash = getActiveAccountHash();
    if (!accountHash) return;
    ensureSyncUnlocked(accountHash)
      .catch((error) => console.warn('[gemini-projects] focus unlock failed', error))
      .then(() => syncEngine.pull(accountHash))
      .catch((error) =>
        console.warn('[gemini-projects] focus pull failed', error)
      );
  });

  window.addEventListener('online', () => {
    syncEngine.setOnlineState(true);
    const accountHash = getActiveAccountHash();
    if (!accountHash) return;
    ensureSyncUnlocked(accountHash)
      .catch((error) => console.warn('[gemini-projects] reconnect unlock failed', error))
      .then(() => syncEngine.pull(accountHash))
      .catch((error) =>
        console.warn('[gemini-projects] reconnect pull failed', error)
      );
  });

  window.addEventListener('offline', () => {
    syncEngine.setOnlineState(false);
  });

  window.addEventListener(WORKSPACE_UPDATED_EVENT, () => {
    loadInitialState()
      .catch(() => undefined)
      .then(() => {
        applyNativeChatVisibility();
        renderPanelIfChanged(true);
        scheduleRescan(0);
      });
  });

  window.addEventListener(SYNC_CONFLICT_EVENT, (event) => {
    const detail = (event as CustomEvent).detail as {
      accountId?: string;
      localState?: unknown;
      remoteState?: unknown;
    };
    console.warn('[gemini-projects] sync conflict awaiting resolution', detail?.accountId);
  });

  window.addEventListener(SYNC_STATUS_EVENT, (event) => {
    const detail = (event as CustomEvent).detail as { accountId?: string; status?: string; message?: string };
    if (detail?.status) {
      panel?.updateSyncStatus(detail.status as SyncStatus);
    }
  });

  window.addEventListener('gemini-workspace:vault-locked', () => {
    applyVaultLockedNotice();
  });
}

/** Re-applies the engine's live status to the header badge (e.g. after account switch). */
function refreshSyncStatusBadge(): void {
  const accountHash = getActiveAccountHash();
  const status = accountHash ? syncEngine.getSyncStatus(accountHash) : 'unconfigured';
  panel?.updateSyncStatus(status);
}

async function bootstrap() {
  document.documentElement.setAttribute('data-gp-build', BUILD_MARKER);
  console.info('[gemini-projects] build', BUILD_MARKER);
  // Load the debug-logging gate from persisted settings before any sync
  // activity can run, so [sync-debug] output matches the checkbox state.
  void initDebugLoggingFlag();

  if (window.location.hostname.includes('chatgpt.com') || window.location.hostname.includes('openai.com')) {
    initChatGPT();
    return;
  }

  installSidebarInspector();
  installNativeHideStyle();
  installChatDragSources();
  initAccountWatcher();
  initWorkspaceSync();
  window.addEventListener(ACCOUNT_CHANGED_EVENT, handleAccountChanged);
  await loadInitialState();
  refreshSyncStatusBadge();
  // Resume server sync for this account (re-derives the key + initial pull).
  resolveActiveAccountHash()
    .then((accountHash) => ensureSyncUnlocked(accountHash))
    .catch((error) => console.warn('[gemini-projects] initial sync unlock failed', error));
  observeDocumentForSidebar();
  installLifecycleRescans();
  runStage('responseFolding', () => initGeminiResponseFolding());
  runStage('prompts', () => prompts.bootstrap());
  runStage('projectInstructions', () => initProjectInstructionInjection());
}

/* ------------------------------------------------------------------ *
 * Project system-prompt & notes injection lifecycle
 * ------------------------------------------------------------------ */

/** Effective instructions resolved for the container a chat lives in. */
interface ProjectInstructions {
  systemPrompt: string;
  notes: string;
  projectName: string;
}

/**
 * Walks the container's ancestor chain (subfolder -> project) and, per field,
 * takes the nearest container that defines a value, so chats inside
 * subfolders inherit their parent project's system prompt and notes. The
 * account workspace is authoritative; the sidebar state is only a fallback.
 */
async function resolveProjectInstructions(projectId: string | null): Promise<ProjectInstructions | null> {
  if (!projectId) return null;

  const byId = new Map(state.projects.map((project) => [project.id, project]));
  const chain: Project[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(projectId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  if (!chain.length) return null;

  let workspaceProjects: Record<string, Project> | null = null;
  const accountHash = getActiveAccountHash();
  if (accountHash) {
    try {
      workspaceProjects = (await getWorkspace(accountHash)).projects ?? null;
    } catch (error) {
      console.warn('[gemini-projects] workspace instruction lookup failed', error);
    }
  }

  const metaOf = (id: string): Project | undefined => workspaceProjects?.[id] ?? byId.get(id);

  let systemPrompt = '';
  let notes = '';
  let sourceName = '';
  for (const node of chain) {
    const meta = metaOf(node.id);
    if (!systemPrompt && (meta?.systemPrompt ?? '').trim()) {
      systemPrompt = (meta?.systemPrompt ?? '').trim();
      sourceName = meta?.name || node.name;
    }
    if (!notes && (meta?.notes ?? '').trim()) {
      notes = (meta?.notes ?? '').trim();
      if (!sourceName) sourceName = meta?.name || node.name;
    }
    if (systemPrompt && notes) break;
  }

  if (!systemPrompt && !notes) return null;
  return { systemPrompt, notes, projectName: sourceName || chain[0].name };
}

/**
 * Conversation whose injected instruction block the user removed via the
 * status pill. `'blank'` covers fresh conversations that do not have an id
 * yet; the dismissal carries over to the conversation created by the first
 * send and resets when a different conversation is opened.
 */
let dismissedInstructionKey: string | null = null;
const DISMISS_KEY_BLANK = 'blank';

/**
 * Synchronous chain check against the sidebar state (kept in sync with the
 * workspace by every save/sync path): true when the chat's container or any
 * of its ancestors defines a system prompt or notes.
 */
function projectChainHasInstructions(projectId: string | null): boolean {
  if (!projectId) return false;
  const byId = new Map(state.projects.map((project) => [project.id, project]));
  let cursor = byId.get(projectId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if ((cursor.systemPrompt ?? '').trim() || (cursor.notes ?? '').trim()) return true;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return false;
}

/** Resolves the container the current conversation (or pending new chat) belongs to. */
function currentInstructionProjectId(): string | null {
  const conversationId = getConversationId(window.location.href);
  const projectId = conversationId
    ? state.chatIndex.get(conversationId)?.projectId ?? null
    : null;
  return projectId ?? activeProjectId ?? pendingNewChatProjectId;
}

/**
 * Shows/hides the composer-toolbar "Add instructions" button: only when the
 * setting is enabled AND the current conversation's project chain has
 * instructions configured.
 */
function refreshInstructionsButton(): void {
  void (async () => {
    try {
      const settings = await getFeatureSettings();
      const visible =
        settings.showInstructionsButton &&
        projectChainHasInstructions(currentInstructionProjectId());
      setInstructionsButtonVisible(visible);
    } catch (error) {
      console.warn('[gemini-projects] instructions button refresh failed', error);
    }
  })();
}

/** Composer-toolbar action: manually add the project instructions to the composer. */
function handleManualInjectInstructions(): void {
  void (async () => {
    try {
      const composer = findChatComposer();
      if (!composer) {
        panel?.showToast('Open a chat to add instructions.');
        return;
      }
      const conversationId = getConversationId(window.location.href);
      const projectId = currentInstructionProjectId();
      if (!projectId) {
        panel?.showToast('This chat is not in a project.');
        return;
      }
      if (composerContainsInstructions(composer)) {
        panel?.showToast('Instructions are already in the message.');
        return;
      }
      const instructions = await resolveProjectInstructions(projectId);
      if (!instructions) {
        panel?.showToast('This project has no system prompt or notes.');
        return;
      }
      const injected = prependProjectInstructions(composer, {
        ...instructions,
        onManualRemove: () => {
          dismissedInstructionKey = conversationId ?? DISMISS_KEY_BLANK;
        }
      });
      if (injected) {
        panel?.showToast('Instructions added to the message');
      }
    } catch (error) {
      console.warn('[gemini-projects] manual instruction injection failed', error);
    }
  })();
}

/**
 * Watches Gemini's chat surface and keeps the active project's system prompt
 * (and notes) in the composer: injected when a project chat is opened or a
 * fresh project conversation becomes ready, and re-applied after every send
 * so each outgoing message carries the instructions. Both behaviors honor the
 * "Automatically add project instructions" setting.
 */
function initProjectInstructionInjection(): void {
  // A "New chat in project" action navigates to a fresh conversation via a full
  // page load; restore the pending project so injection still fires afterwards.
  try {
    const pending = sessionStorage.getItem(PENDING_NEW_CHAT_KEY);
    if (pending) pendingNewChatProjectId = pending;
  } catch {
    // sessionStorage unavailable — rely on the in-memory value only.
  }

  // A reload straight into an existing conversation (e.g. Gemini performed a
  // full navigation when the first message was sent) cancels the pending
  // new-chat assignment; it must not capture an unrelated conversation.
  const currentConversationId = getConversationId(window.location.href);
  if (currentConversationId && pendingNewChatProjectId) {
    pendingNewChatProjectId = null;
    try {
      sessionStorage.removeItem(PENDING_NEW_CHAT_KEY);
    } catch {
      // sessionStorage unavailable — in-memory value already cleared.
    }
  }

  window.addEventListener(FEATURE_SETTINGS_CHANGED_EVENT, () => refreshInstructionsButton());
  configureInstructionsButton(() => handleManualInjectInstructions());

  composerObserver = initComposerObserver({
    onNewChatReady: (composer) => {
      void (async () => {
        const projectId = pendingNewChatProjectId ?? activeProjectId;
        if (!projectId) return;
        // Only inject into genuinely new, blank conversations. A conversation
        // that already carries an id (including a just-sent first message whose
        // turn has not rendered yet) must never be touched here.
        const conversationId = getConversationId(window.location.href);
        if (conversationId && !pendingNewChatProjectId) return;
        const featureSettings = await getFeatureSettings().catch(() => createDefaultFeatureSettings());
        if (!featureSettings.autoApplyProjectInstructions) return;
        if (dismissedInstructionKey === (conversationId ?? DISMISS_KEY_BLANK)) return;
        const instructions = await resolveProjectInstructions(projectId);
        if (!instructions) return;
        if (hasUserTurnsInChat()) return;
        try {
          injectProjectInstructions(composer, {
            ...instructions,
            onManualRemove: () => {
              dismissedInstructionKey = conversationId ?? DISMISS_KEY_BLANK;
            }
          });
        } catch (error) {
          console.warn('[gemini-projects] instruction injection failed', error);
        }
      })();
    },
    onOngoingChatComposerReady: (composer, conversationId) => {
      void (async () => {
        try {
          if (!conversationId) return;
          const featureSettings = await getFeatureSettings().catch(() => createDefaultFeatureSettings());
          if (!featureSettings.autoApplyProjectInstructions) return;
          if (dismissedInstructionKey === conversationId) return;
          const projectId = state.chatIndex.get(conversationId)?.projectId ?? null;
          if (!projectId) return;
          const instructions = await resolveProjectInstructions(projectId);
          if (!instructions) return;
          // The user may have started typing or navigated away while the
          // workspace lookup was in flight; injection only applies to a
          // blank composer in the same conversation.
          if (getConversationId(window.location.href) !== conversationId) return;
          injectProjectInstructions(composer, {
            ...instructions,
            onManualRemove: () => {
              dismissedInstructionKey = conversationId;
            }
          });
        } catch (error) {
          console.warn('[gemini-projects] ongoing instruction injection failed', error);
        }
      })();
    },
    onConversationChanged: (conversationId, previousConversationId) => {
      // Per-conversation instruction dismissal: reset when moving to another
      // conversation, but carry a fresh-chat removal over to the brand-new
      // conversation created by that chat's first send.
      if (!conversationId) {
        dismissedInstructionKey = null;
      } else if (previousConversationId) {
        dismissedInstructionKey = null;
      } else if (dismissedInstructionKey === DISMISS_KEY_BLANK) {
        dismissedInstructionKey = state.chatIndex.has(conversationId) ? null : conversationId;
      }
      if (pendingNewChatProjectId && conversationId) {
        const projectId = pendingNewChatProjectId;
        pendingNewChatProjectId = null;
        try {
          sessionStorage.removeItem(PENDING_NEW_CHAT_KEY);
        } catch {
          // sessionStorage unavailable — in-memory value already cleared.
        }
        if (state.chatIndex.has(conversationId)) {
          // The user opened an existing conversation instead of sending the new
          // chat. Cancel the pending assignment rather than capturing it.
          return;
        }
        handleMoveChat(conversationId, projectId).catch((error) =>
          console.warn('[gemini-projects] auto-assign new chat failed', error)
        );
        panel?.showToast('New chat added to project');
        return;
      }
      if (conversationId) {
        const chat = state.chatIndex.get(conversationId);
        if (chat?.projectId) {
          activeProjectId = chat.projectId;
          panel?.setActiveProject(chat.projectId);
        }
      }
      refreshInstructionsButton();
    }
  });
}

/**
 * Loads the active account's encrypted workspace partition into the sidebar
 * state. The account partition is the single source of truth: switching
 * Google accounts swaps the entire dataset, never sharing one between them.
 */
async function loadInitialState() {
  try {
    const accountHash = await debugStep('load:resolve-account', () => resolveActiveAccountHash());
    const workspace = await debugStep('load:get-workspace', () => getWorkspace(accountHash));
    debugStep('load:apply-state', () => applyStoredState(workspaceToStoredState(workspace)));
  } catch (error) {
    if (errorName(error) === 'VaultLockedError') {
      applyVaultLockedNotice();
    } else {
      console.error('[gemini-projects] workspace load failed; starting empty:',
        errorMessage(error), '\n', errorStack(error));
    }
  }
  await loadCollapsedFolders(getActiveAccountHash());
}

/* ------------------------------------------------------------------ *
 * Persistent per-account folder collapse state
 * ------------------------------------------------------------------ */

async function loadCollapsedFolders(accountHash: string | null): Promise<void> {
  if (!accountHash) {
    state.collapsedProjectIds.clear();
    return;
  }
  const key = `${COLLAPSED_FOLDERS_KEY_PREFIX}${accountHash}`;
  try {
    const result = await storageLocalGet<Record<string, unknown>>([key]);
    const raw = result[key];
    state.collapsedProjectIds = new Set(
      Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []
    );
  } catch (error) {
    console.warn('[gemini-projects] collapsed-folder load failed', error);
    state.collapsedProjectIds.clear();
  }
}

function persistCollapsedFolders(accountHash: string | null): void {
  if (!accountHash) return;
  storageLocalSet({ [`${COLLAPSED_FOLDERS_KEY_PREFIX}${accountHash}`]: Array.from(state.collapsedProjectIds) }).catch(
    (error) => console.warn('[gemini-projects] collapsed-folder persist failed', error)
  );
}

function observeDocumentForSidebar() {
  rootObserver?.disconnect();
  rootObserver = new MutationObserver(() => scheduleRescan());
  rootObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  scheduleRescan(0);
}

function handleAccountChanged(event: Event): void {
  const detail = (event as CustomEvent<AccountChangeDetail>).detail;
  console.info(
    '[gemini-projects] account changed',
    detail?.previousHash ?? '(initial)',
    '->',
    detail?.newHash
  );
  // Drop the previous account's ephemeral sync key from memory so only the
  // logged-in account's material is held at any time.
  if (detail?.previousHash) {
    syncEngine.clearPassphrase(detail.previousHash);
  }
  state.collapsedProjectIds.clear();
  pendingNewChatProjectId = null;
  dismissedInstructionKey = null;
  sessionStorage.removeItem(PENDING_NEW_CHAT_KEY);
  state.ui = {
    createModalOpen: false,
    contextMenuOpen: false,
    pendingMoveConversationId: null
  };
  lastRenderKey = '';
  loadInitialState()
    .catch(() => undefined)
    .then(() => ensureSyncUnlocked(detail?.newHash ?? ''))
    .catch(() => undefined)
    .then(() => {
      applyNativeChatVisibility();
      renderPanelIfChanged(true);
      refreshSyncStatusBadge();
      scheduleRescan(0);
    });
}

function scheduleRescan(delay = RESCAN_DELAY_MS) {
  // Gemini continuously mutates parts of the page (streaming state, badges,
  // focus helpers, etc.). Restarting the timer for every mutation can starve
  // the sidebar scan forever, leaving Projects absent on an otherwise ready
  // page. Keep the first scheduled scan; only an explicit immediate rescan
  // is allowed to pre-empt a delayed one.
  if (rescanTimer !== null) {
    if (delay > 0) return;
    window.clearTimeout(rescanTimer);
  }
  rescanTimer = window.setTimeout(() => {
    rescanTimer = null;
    runStage('rescanSidebar', rescanSidebar);
  }, delay);
}

function rescanSidebar() {
  if (isSparkSurface()) {
    cleanupInjectedProjects();
    return;
  }

  const nextSidebar = findSidebarRoot();
  if (!nextSidebar) {
    if (pendingPanelRetryCount < PANEL_READY_RETRY_LIMIT) {
      pendingPanelRetryCount += 1;
      scheduleRescan(PANEL_READY_RETRY_MS);
    }
    return;
  }

  if (!isExpandedSidebar(nextSidebar)) {
    state.nativeConversationIds = new Set();
    state.nativeChatsReady = false;
    cleanupInjectedProjects();
    return;
  }

  if (sidebarRoot !== nextSidebar) {
    sidebarRoot = nextSidebar;
    sidebarObserver?.disconnect();
    sidebarObserver = new MutationObserver(() => scheduleRescan());
    sidebarObserver.observe(sidebarRoot, { childList: true, subtree: true, characterData: true });
    panel = null;
    panelHost = null;
    chatsList = null;
    pendingPanelRetryCount = 0;
  }

  if (!ensurePanel()) {
    if (pendingPanelRetryCount < PANEL_READY_RETRY_LIMIT) {
      pendingPanelRetryCount += 1;
      scheduleRescan(PANEL_READY_RETRY_MS);
    }
    return;
  }
  pendingPanelRetryCount = 0;
  ensureChatsList();
  ensureNativeRowsDraggable();
  syncNativeChatsFromDom();
  applyNativeChatVisibility();
  renderPanelIfChanged();
}

function installLifecycleRescans() {
  window.addEventListener('pageshow', () => scheduleRescan(0));
  window.addEventListener('focus', () => scheduleRescan(0));
  window.addEventListener('popstate', () => scheduleRescan(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleRescan(0);
    }
  });
}

function ensurePanel() {
  if (!sidebarRoot) return false;
  if (!isExpandedSidebar(sidebarRoot)) return false;
  const chats = findChatsSection(sidebarRoot);
  const gems = findGemsSection(sidebarRoot);
  const { host, shadow, overlayShadow } = injectProjectsSection(sidebarRoot, gems, chats);

  if (!panel || panelHost !== host) {
    panel = createProjectsPanel({
      shadow,
      overlayShadow,
      onSaveProject: handleSaveProject,
      onToggleProjectPin: handleToggleProjectPin,
      onToggleProjectExpand: handleToggleProjectExpand,
      onDeleteProject: handleDeleteProject,
      onToggleCollapse: handleToggleCollapse,
      onRemoveChatFromProject: (conversationId) => handleMoveChat(conversationId, null),
      onMoveChatToProject: (conversationId, projectId) => handleMoveChat(conversationId, projectId),
      onAddSubfolder: (parentId) => {
        state.collapsedProjectIds.delete(parentId);
        renderPanelIfChanged(true);
        panel?.openCreateModal(parentId);
      },
      onEditDetails: (project) => panel?.openDetailsModal(project),
      onAddCurrentChat: (projectId) => {
        handleAddCurrentChat(projectId).catch((error) =>
          console.warn('[gemini-projects] add current chat failed', error)
        );
      },
      onMoveProject: (projectId, targetParentId) => {
        handleMoveProject(projectId, targetParentId).catch((error) =>
          console.warn('[gemini-projects] move project failed', error)
        );
      },
      onNewChat: (projectId) => handleNewChatInProject(projectId),
      onNavigateToChat: (conversationId, projectId) => {
        if (projectId) {
          activeProjectId = projectId;
          panel?.setActiveProject(projectId);
        }
        if (conversationId) {
          const chat = state.chatIndex.get(conversationId);
          if (chat?.projectId) {
            activeProjectId = chat.projectId;
            panel?.setActiveProject(chat.projectId);
          }
        }
      },
      onChatMenuOpen: (conversationId, anchorRect) => {
        handlePanelChatMenu(conversationId, anchorRect).catch((error) =>
          console.warn('[gemini-projects] panel chat menu failed', error)
        );
      }
    });
    panelHost = host;
    // Gemini replaces the sidebar's internal scroll region when switching
    // between Chat and Spark while preserving the outer bard-sidenav node.
    // A new host always needs an initial render even when state is unchanged.
    lastRenderKey = '';
  }

  if (!chatMenuHandle || chatMenuOverlayShadow !== overlayShadow) {
    chatMenuHandle = attachChatMenuEnhancer({
      getChatProjectId: (conversationId) => state.chatIndex.get(conversationId)?.projectId ?? null,
      getProjectName: (projectId) => state.projects.find((item) => item.id === projectId)?.name ?? '',
      onPickTarget: (conversationId, mode) => panel?.openTargetPicker(conversationId, mode),
      onRemoveChat: (conversationId) => {
        handleMoveChat(conversationId, null).catch((error) =>
          console.warn('[gemini-projects] remove from menu failed', error)
        );
      },
      onToggleChatPin: (conversationId, isPinned) => {
        handleSetChatPinned(conversationId, isPinned).catch((error) =>
          console.warn('[gemini-projects] chat pin sync failed', error)
        );
      },
      onMenuClosed: () => scheduleRescan(0),
      onFallbackMenu: (conversationId, anchorRect) => panel?.showChatMenuFallback(conversationId, anchorRect)
    });
    chatMenuOverlayShadow = overlayShadow;
  }
  return true;
}

/**
 * Chat kebab inside the projects panel: reuse Gemini's native context menu
 * (rename / pin / delete / share all keep working) and augment it with the
 * extension's own items. Falls back to the extension menu when the native
 * menu cannot be opened (for example when the native row was deleted).
 */
async function handlePanelChatMenu(conversationId: string, anchorRect: DOMRect): Promise<void> {
  if (chatMenuHandle) {
    try {
      const opened = await chatMenuHandle.openNativeChatMenu(conversationId, anchorRect);
      if (opened) return;
    } catch (error) {
      console.warn('[gemini-projects] native chat menu failed', error);
    }
  }
  panel?.showChatMenuFallback(conversationId, anchorRect);
}

async function handleSetChatPinned(conversationId: string, isPinned: boolean): Promise<void> {
  const existing = state.chatIndex.get(conversationId);
  if (existing && existing.isPinned !== isPinned) {
    state.chatIndex.set(conversationId, { ...existing, isPinned, updatedAt: Date.now() });
    renderPanelIfChanged(true);
  }
  try {
    const accountHash = await resolveActiveAccountHash();
    const next = await setWorkspaceChatPinned(accountHash, conversationId, isPinned);
    applyStoredState(next);
    // Pinning can make Gemini re-render/relocate the row (e.g. into its pinned
    // group); re-apply hiding right away so a chat inside a project/folder
    // never leaves its pin marker behind in the All list.
    applyNativeChatVisibility();
    renderPanelIfChanged(true);
  } catch (error) {
    console.warn('[gemini-projects] setChatPinned failed', error);
  }
}

function ensureChatsList() {
  if (!sidebarRoot) return;
  const header = findChatsSection(sidebarRoot);
  if (!header) {
    chatsHeader = null;
    chatsList = null;
    chatsObserver?.disconnect();
    return;
  }
  chatsHeader = header;

  const list = findChatsListContainer(header);
  if (!list) {
    chatsList = null;
    chatsObserver?.disconnect();
    return;
  }
  if (list === chatsList) return;

  chatsList = list;
  chatsObserver?.disconnect();
  chatsObserver = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => isRelevantChatsMutation(mutation))) {
      scheduleRescan();
    }
  });
  chatsObserver.observe(chatsList, { childList: true, subtree: true });
}

/**
 * Best-effort detection of Gemini's native pin state directly from the row
 * DOM. Two signals, checked in order:
 *
 * 1. Gemini's own pin marker: `<gem-icon fonticonname="push_pin">` rendered
 *    with the `conversation-pin-icon` class (localized aria-labels such as
 *    "Angepinnter Chat" / "Pinned chat" are unreliable to parse, so the icon
 *    identity is matched instead).
 * 2. Fallback: any labelled control exposing an "Unpin"-style label (rows
 *    without a visible pin marker but with an unpin action are pinned).
 */
function detectNativePinned(row: HTMLElement): boolean {
  // Gemini renders the pin badge as a Material "push_pin" font icon inside
  // a gem-icon. Match the icon identity rather than the localized label.
  const pinIcons = row.querySelectorAll<HTMLElement>(
    'gem-icon[fonticonname="push_pin"], mat-icon[fonticon="push_pin"], .conversation-pin-icon'
  );
  if (pinIcons.length > 0) return true;

  const labeled = row.querySelectorAll<HTMLElement>('[aria-label], [title]');
  for (const node of Array.from(labeled)) {
    const label = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`.toLowerCase();
    if (/unpin|un-pin|nicht anpinnen|anpinnen aufheben|loslösen|取消置顶|取消置頂|解除置顶|取消釘選/.test(label)) {
      return true;
    }
  }
  return false;
}

function syncNativeChatsFromDom() {
  if (!chatsList) {
    state.nativeConversationIds = new Set();
    state.nativeChatsReady = false;
    return;
  }

  const updates: ChatRef[] = [];
  const nativeConversationIds = new Set<string>();
  for (const link of collectNativeChatLinks(chatsList)) {
    const row = findChatRowElement(link, chatsList) || link;
    const conversationId = getConversationId(link.href) || getConversationIdFromChatRow(row);
    if (!conversationId) continue;
    nativeConversationIds.add(conversationId);

    const existing = state.chatIndex.get(conversationId);
    const title = normalizeTitle(link.textContent || row.textContent || existing?.title || '');
    const lastUrl = link.href || existing?.lastUrl || `/app/${conversationId}`;
    if (!title && existing?.title) continue;

    updates.push({
      conversationId,
      title: title || existing?.title || 'Untitled chat',
      isPinned: existing?.isPinned === true || detectNativePinned(row as HTMLElement),
      projectId: existing?.projectId ?? null,
      updatedAt: existing?.updatedAt ?? Date.now(),
      lastUrl
    });
  }
  state.nativeConversationIds = nativeConversationIds;
  state.nativeChatsReady = nativeConversationIds.size > 0;

  if (!updates.length) return;

  let changed = false;
  for (const chat of updates) {
    const existing = state.chatIndex.get(chat.conversationId);
    if (
      existing?.title !== chat.title ||
      existing?.lastUrl !== chat.lastUrl ||
      existing?.projectId !== chat.projectId
    ) {
      changed = true;
    }
    state.chatIndex.set(chat.conversationId, {
      ...chat,
      projectId: existing?.projectId ?? chat.projectId,
      updatedAt: existing?.updatedAt ?? Date.now()
    });
  }

  if (changed) {
    resolveActiveAccountHash()
      .then((accountHash) => upsertWorkspaceChatRefs(accountHash, updates))
      .then((next) => applyStoredState(next))
      .catch(() => undefined);
  }
}

function applyNativeChatVisibility() {
  if (!sidebarRoot) return;

  const touchedNodes = new Set<HTMLElement>();
  // Scan the whole sidebar, not just the resolved chats list: Gemini can keep
  // pinned conversations in their own group outside of it, and those rows must
  // disappear from the All list as well once the chat joins a project/folder.
  for (const link of collectNativeChatLinks(sidebarRoot)) {
    const conversationId = getConversationId(link.href);
    if (!conversationId) continue;
    const target = findNativeChatHideTarget(link, conversationId);
    if (!target) continue;

    touchedNodes.add(target);
    target.draggable = true;
    if (state.chatIndex.get(conversationId)?.projectId) {
      target.setAttribute(HIDDEN_ATTR, 'true');
    } else {
      target.removeAttribute(HIDDEN_ATTR);
    }
  }

  sidebarRoot.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach((node) => {
    if (!touchedNodes.has(node)) node.removeAttribute(HIDDEN_ATTR);
  });
}

/**
 * Maximum height/width slack of a wrapper that may still be treated as "one
 * chat row". Guards against hiding oversized containers (section bodies,
 * scroll regions) when Gemini nests a conversation unusually deep.
 */
const MAX_NATIVE_ROW_HEIGHT = 120;
const NATIVE_ROW_SELECTOR =
  '[data-test-id="conversation"], gem-nav-list-item, .conversation-container, [role="listitem"], li';

/**
 * Resolves the element to hide for a conversation that lives inside a
 * project/folder.
 *
 * Gemini renders a pinned conversation's pin marker (and other row chrome) as
 * a sibling of the chat link inside the row wrapper. Hiding only the link
 * leaves that chrome behind as a tiny stray marker floating between the
 * remaining rows of the All list. The hide target is therefore the widest
 * ancestor of the link that still belongs exclusively to this one
 * conversation:
 * - every conversation link inside it resolves to the same chat, and
 * - it stays within row-like geometry so large containers are never hidden.
 */
function findNativeChatHideTarget(link: HTMLAnchorElement, conversationId: string): HTMLElement | null {
  if (!sidebarRoot) return null;
  const projectsHost = document.getElementById('gemini-projects-host');
  const sidebarRect = sidebarRoot.getBoundingClientRect();

  let best: HTMLElement | null = null;
  let current: HTMLElement | null = link.parentElement;
  while (current && current !== document.body) {
    if (current === sidebarRoot) break;
    if (!sidebarRoot.contains(current)) break;
    if (current.id === 'gemini-projects-host' || (projectsHost && current.contains(projectsHost))) break;

    // A wrapper collapsed by an earlier pass measures 0px; keep it hidden
    // because geometry cannot be verified while it is display:none.
    if (current.hasAttribute(HIDDEN_ATTR)) {
      best = current;
      break;
    }

    const chatLinks = Array.from(current.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(
      (candidate) => Boolean(getConversationId(candidate.href))
    );
    // Wrappers that also render other conversations must stay visible.
    if (chatLinks.some((candidate) => getConversationId(candidate.href) !== conversationId)) break;
    if (chatLinks.length === 0) {
      current = current.parentElement;
      continue;
    }

    const rect = current.getBoundingClientRect();
    if (rect.height <= 0 || rect.height > MAX_NATIVE_ROW_HEIGHT) break;
    if (rect.width <= 0 || rect.width > sidebarRect.width + 24) break;

    best = current;
    current = current.parentElement;
  }

  if (best) return best;

  // Fallbacks that still avoid leaving row chrome (pin marker, kebab) behind.
  const rowLike = link.closest<HTMLElement>(NATIVE_ROW_SELECTOR);
  if (
    rowLike &&
    sidebarRoot.contains(rowLike) &&
    !(projectsHost && rowLike.contains(projectsHost))
  ) {
    const rowLinks = Array.from(rowLike.querySelectorAll<HTMLAnchorElement>('a[href]')).filter(
      (candidate) => Boolean(getConversationId(candidate.href))
    );
    if (rowLinks.length && rowLinks.every((candidate) => getConversationId(candidate.href) === conversationId)) {
      return rowLike;
    }
  }
  return link;
}

function collectNativeChatLinks(root: ParentNode): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((link) => {
    if (!getConversationId(link.href)) return false;
    if (link.closest('#gemini-projects-host')) return false;
    return true;
  });
}

function installChatDragSources() {
  document.addEventListener('dragstart', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const conversationId =
      getConversationId(target as Element) || getConversationIdFromChatRow(target);
    if (!conversationId) return;
    try {
      event.dataTransfer?.setData(CHAT_DRAG_MIME, conversationId);
      event.dataTransfer?.setData('text/plain', conversationId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
    } catch {
      // Some engines restrict dataTransfer writes; the drop handler tolerates it.
    }
  }, true);
}

function ensureNativeRowsDraggable() {
  if (!sidebarRoot) return;
  for (const link of collectNativeChatLinks(sidebarRoot)) {
    const row = (chatsList && findChatRowElement(link, chatsList)) || link;
    if (row instanceof HTMLElement) {
      row.draggable = true;
    }
  }
}

async function handleSaveProject(project: Project) {
  try {
    const accountHash = await debugStep('save:resolve-account', () => resolveActiveAccountHash());
    const next = await debugStep('save:upsert-workspace', () => upsertWorkspaceProject(accountHash, project));
    debugStep('save:apply-state', () => applyStoredState(next));
    if (project.parentId) state.collapsedProjectIds.delete(project.parentId);
    if (project.kind === 'folder') state.collapsedProjectIds.delete(project.id);
    debugStep('save:persist-collapsed', () => { persistCollapsedFolders(getActiveAccountHash()); });
    debugStep('save:render', () => renderPanelIfChanged(true));
  } catch (error) {
    if (errorName(error) === 'VaultLockedError') {
      applyVaultLockedNotice();
      return;
    }
    console.error('[gemini-projects] save project failed:', errorMessage(error), '\n', errorStack(error));
    panel?.showToast('Could not save. Details in the console.');
  }
}

async function handleAddCurrentChat(projectId: string) {
  const conversationId = getConversationId(window.location.href);
  if (!conversationId) {
    panel?.showToast('Open a chat first, then use "Add current chat".');
    return;
  }
  state.collapsedProjectIds.delete(projectId);
  persistCollapsedFolders(getActiveAccountHash());
  await handleMoveChat(conversationId, projectId);
  panel?.showToast('Chat added to project');
}

function handleToggleProjectExpand(projectId: string) {
  if (state.collapsedProjectIds.has(projectId)) {
    state.collapsedProjectIds.delete(projectId);
  } else {
    state.collapsedProjectIds.add(projectId);
  }
  persistCollapsedFolders(getActiveAccountHash());
  renderPanelIfChanged(true);
}

async function handleMoveProject(projectId: string, targetParentId: string | null) {
  try {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return;
    if ((project.parentId ?? null) === targetParentId) return;

    if (targetParentId) {
      state.collapsedProjectIds.delete(targetParentId);
    }
    const siblings = state.projects.filter((item) => (item.parentId ?? null) === targetParentId);
    const order = siblings.reduce((max, item) => Math.max(max, item.order), -1) + 1;

    const next: Project = {
      ...project,
      parentId: targetParentId,
      order,
      sortIndex: order,
      updatedAt: Date.now()
    };
    const accountHash = await resolveActiveAccountHash();
    const stored = await upsertWorkspaceProject(accountHash, next);
    applyStoredState(stored);
    persistCollapsedFolders(getActiveAccountHash());
    renderPanelIfChanged(true);
    panel?.showToast('Project moved');
  } catch (error) {
    console.error('[gemini-projects] project move failed:', errorMessage(error), '\n', errorStack(error));
    panel?.showToast('Could not move project. Details in the console.');
  }
}

/** Creates a brand-new chat inside a project; the conversation is auto-assigned. */
function handleNewChatInProject(projectId: string): void {
  pendingNewChatProjectId = projectId;
  try {
    sessionStorage.setItem(PENDING_NEW_CHAT_KEY, projectId);
  } catch {
    // sessionStorage may be unavailable in restricted contexts; injection still
    // works via the in-memory fallback when no full navigation occurs.
  }
  state.collapsedProjectIds.delete(projectId);
  persistCollapsedFolders(getActiveAccountHash());
  renderPanelIfChanged(true);
  navigateToNewChat();
  panel?.showToast('Opening new chat in project…');
}

function navigateToNewChat(): void {
  const url = new URL('/app', window.location.origin);
  if (window.location.href !== url.href) {
    window.location.assign(url.href);
  }
}

async function handleToggleProjectPin(projectId: string, isPinned: boolean) {
  try {
    const accountHash = await resolveActiveAccountHash();
    const next = await setWorkspaceProjectPinned(accountHash, projectId, isPinned);
    applyStoredState(next);
    renderPanelIfChanged(true);
  } catch (error) {
    console.error('[gemini-projects] pin toggle failed:', errorMessage(error), '\n', errorStack(error));
    panel?.showToast('Could not update pin. Details in the console.');
  }
}

function handleToggleCollapse(section: 'projects' | 'folders', collapsed: boolean) {
  if (section === 'projects') {
    state.uiPrefs.projectsCollapsed = collapsed;
  } else {
    state.uiPrefs.foldersCollapsed = collapsed;
  }
  resolveActiveAccountHash()
    .then((accountHash) => updateWorkspaceUiPrefs(accountHash, { [section === 'projects' ? 'projectsCollapsed' : 'foldersCollapsed']: collapsed }))
    .catch((error) => console.warn('[gemini-projects] ui prefs persist failed', error));
  renderPanelIfChanged(true);
}

async function handleDeleteProject(projectId: string) {
  try {
    const accountHash = await resolveActiveAccountHash();
    const next = await deleteWorkspaceProject(accountHash, projectId);
    applyStoredState(next);
    state.collapsedProjectIds.delete(projectId);
    persistCollapsedFolders(getActiveAccountHash());
    applyNativeChatVisibility();
    renderPanelIfChanged(true);
  } catch (error) {
    console.error('[gemini-projects] delete project failed:', errorMessage(error), '\n', errorStack(error));
    panel?.showToast('Could not delete. Details in the console.');
  }
}

async function handleMoveChat(conversationId: string, projectId: string | null) {
  try {
    await ensureChatKnown(conversationId);
    const accountHash = await resolveActiveAccountHash();
    const next = await moveWorkspaceChat(accountHash, conversationId, projectId);
    applyStoredState(next);
    if (projectId) {
      state.collapsedProjectIds.delete(projectId);
      persistCollapsedFolders(getActiveAccountHash());
    }
    applyNativeChatVisibility();
    renderPanelIfChanged(true);
  } catch (error) {
    console.error('[gemini-projects] chat move failed:', errorMessage(error), '\n', errorStack(error));
  }
}

async function ensureChatKnown(conversationId: string) {
  const existing = state.chatIndex.get(conversationId);
  if (existing?.title && existing.lastUrl) return;

  const link = findNativeLinkByConversationId(conversationId);

  if (!link) {
    // The chat is not listed in the sidebar (e.g. it lives under another
    // account context or the sidebar failed to render). Fall back to the
    // current URL and the document title so the assignment still works.
    const fallbackTitle = normalizeTitle(document.title.replace(/\s*[-–—|]\s*Gemini.*$/i, ''));
    const chat: ChatRef = {
      conversationId,
      title: fallbackTitle || existing?.title || 'Untitled chat',
      isPinned: existing?.isPinned ?? false,
      projectId: existing?.projectId ?? null,
      updatedAt: Date.now(),
      lastUrl: existing?.lastUrl || window.location.pathname
    };
    state.chatIndex.set(conversationId, chat);
    const accountHash = await resolveActiveAccountHash();
    applyStoredState(await upsertWorkspaceChatRefs(accountHash, [chat]));
    return;
  }

  const row = chatsList ? findChatRowElement(link, chatsList) : link;
  const chat: ChatRef = {
    conversationId,
    title: normalizeTitle(link.textContent || row?.textContent || existing?.title || '') || 'Untitled chat',
    isPinned: existing?.isPinned ?? false,
    projectId: existing?.projectId ?? null,
    updatedAt: Date.now(),
    lastUrl: link.href
  };
  state.chatIndex.set(conversationId, chat);
  const accountHash = await resolveActiveAccountHash();
  applyStoredState(await upsertWorkspaceChatRefs(accountHash, [chat]));
}

function findNativeLinkByConversationId(conversationId: string): HTMLAnchorElement | null {
  const roots: ParentNode[] = [chatsList, sidebarRoot, document].filter(Boolean) as ParentNode[];
  for (const root of roots) {
    const link = collectNativeChatLinks(root).find((candidate) => getConversationId(candidate.href) === conversationId);
    if (link) return link;
  }
  return null;
}

function normalizeTitle(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*(?:Pinned|宸茬疆椤秥缃《)\s*$/i, '')
    .trim();
}

function installNativeHideStyle() {
  if (document.getElementById('gp-native-hide-style')) return;
  const style = document.createElement('style');
  style.id = 'gp-native-hide-style';
  style.textContent = `[${HIDDEN_ATTR}="true"] { display: none !important; }`;
  document.documentElement.appendChild(style);
}

function isExpandedSidebar(sidebar: HTMLElement): boolean {
  const rect = sidebar.getBoundingClientRect();
  const style = window.getComputedStyle(sidebar);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (rect.width < MIN_EXPANDED_SIDEBAR_WIDTH || rect.height <= 0) return false;
  if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
  return true;
}

function isSparkSurface(): boolean {
  return window.location.pathname === '/spark' || window.location.pathname.startsWith('/spark/');
}

function cleanupInjectedProjects() {
  panel = null;
  panelHost = null;
  chatMenuOverlayShadow = null;
  chatsList = null;
  state.nativeConversationIds = new Set();
  state.nativeChatsReady = false;
  lastRenderKey = '';
  document.getElementById('gemini-projects-host')?.remove();
  document.getElementById('gemini-projects-overlay')?.remove();
  document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach((node) => node.removeAttribute(HIDDEN_ATTR));
}

function isRelevantChatsMutation(mutation: MutationRecord): boolean {
  if (mutation.target instanceof HTMLElement && mutation.target.closest('#gemini-projects-host')) {
    return false;
  }
  return Array.from(mutation.addedNodes).some(nodeHasConversationLink) ||
    Array.from(mutation.removedNodes).some(nodeHasConversationLink);
}

function nodeHasConversationLink(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  if (node.closest('#gemini-projects-host')) return false;
  if (node instanceof HTMLAnchorElement && getConversationId(node.href)) return true;
  return Boolean(Array.from(node.querySelectorAll<HTMLAnchorElement>('a[href]')).find((link) => getConversationId(link.href)));
}

function renderPanelIfChanged(force = false) {
  if (!panel) return;
  const key = getRenderKey();
  if (!force && key === lastRenderKey) return;
  lastRenderKey = key;
  panel.render(state);
  refreshInstructionsButton();
}

function getRenderKey(): string {
  const projects = state.projects
    .map((project) =>
      [
        project.id,
        project.name,
        project.icon,
        project.color || '',
        project.sortIndex,
        project.isPinned === true,
        project.kind,
        project.parentId ?? '',
        project.systemPrompt ? 1 : 0,
        project.notes ? 1 : 0
      ].join(':')
    )
    .join('|');
  const chats = Array.from(state.chatIndex.values())
    .filter((chat) => chat.projectId)
    .map((chat) => {
      const missing = state.nativeChatsReady && !state.nativeConversationIds.has(chat.conversationId);
      return `${chat.conversationId}:${chat.title}:${chat.projectId}:${chat.lastUrl || ''}:${chat.updatedAt}:${chat.isPinned ? 1 : 0}:${missing}`;
    })
    .sort()
    .join('|');
  return `${state.uiPrefs.projectsCollapsed}|${state.uiPrefs.foldersCollapsed}|${Array.from(state.collapsedProjectIds).sort().join(',')}|${projects}|${chats}`;
}

function runStage(name: string, fn: () => void) {
  try {
    fn();
  } catch (error) {
    console.error(`[gemini-projects] stage failed: ${name}`, error);
  }
}

bootstrap().catch((error) => {
  console.error('[gemini-projects] bootstrap failed:', errorMessage(error), '\n', errorStack(error));
});

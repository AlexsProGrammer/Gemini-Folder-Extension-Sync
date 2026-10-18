import { BackgroundRequest, BackgroundResponse, ChatRef, Project, RuntimeState } from '../shared/types';
import { runtimeSendMessage } from '../shared/webext';
import { ACCOUNT_CHANGED_EVENT, AccountChangeDetail, initAccountWatcher } from './accountWatcher';
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
import { initGeminiResponseFolding } from './gemini/responseFolding';
import * as prompts from './prompts';
import { installSidebarInspector } from './sidebarInspector';
import { CHAT_DRAG_MIME, createProjectsPanel } from './ui/projectsPanel';
import { initChatGPT } from './chatgpt';

const BUILD_MARKER = '2.0.6';
const HIDDEN_ATTR = 'data-gp-native-hidden';
const RESCAN_DELAY_MS = 350;
const PANEL_READY_RETRY_MS = 120;
const PANEL_READY_RETRY_LIMIT = 40;
const MIN_EXPANDED_SIDEBAR_WIDTH = 180;

const state: RuntimeState = {
  projects: [],
  chatIndex: new Map(),
  expandedProjectIds: new Set(),
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

function sendMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  return runtimeSendMessage<BackgroundResponse>(message);
}

async function bootstrap() {
  document.documentElement.setAttribute('data-gp-build', BUILD_MARKER);

  if (window.location.hostname.includes('chatgpt.com') || window.location.hostname.includes('openai.com')) {
    initChatGPT();
    return;
  }

  installSidebarInspector();
  installNativeHideStyle();
  installChatDragSources();
  initAccountWatcher();
  window.addEventListener(ACCOUNT_CHANGED_EVENT, handleAccountChanged);
  await loadInitialState();
  observeDocumentForSidebar();
  installLifecycleRescans();
  runStage('responseFolding', () => initGeminiResponseFolding());
  runStage('prompts', () => prompts.bootstrap());
}

async function loadInitialState() {
  try {
    const response = await withTimeout(sendMessage({ type: 'getState' }), 1800);
    if (!response.ok || !response.state) return;
    state.projects = response.state.projects;
    state.chatIndex = new Map(Object.entries(response.state.chatIndex));
    const prefs = response.state.uiPrefs;
    state.uiPrefs = {
      projectsCollapsed: prefs?.projectsCollapsed === true,
      foldersCollapsed: prefs?.foldersCollapsed === true
    };
  } catch (error) {
    console.warn('[gemini-projects] getState failed; starting with local empty state', error);
  }
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
  state.expandedProjectIds.clear();
  state.ui = {
    createModalOpen: false,
    contextMenuOpen: false,
    pendingMoveConversationId: null
  };
  lastRenderKey = '';
  loadInitialState()
    .catch(() => undefined)
    .then(() => {
      applyNativeChatVisibility();
      renderPanelIfChanged(true);
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
        state.expandedProjectIds.add(parentId);
        renderPanelIfChanged(true);
        panel?.openCreateModal(parentId);
      },
      onEditDetails: (project) => panel?.openDetailsModal(project),
      onAddCurrentChat: (projectId) => {
        handleAddCurrentChat(projectId).catch((error) =>
          console.warn('[gemini-projects] add current chat failed', error)
        );
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
    await sendMessage({ type: 'setChatPinned', conversationId, isPinned });
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
 * DOM (rows that expose an "Unpin"-labelled control are pinned).
 */
function detectNativePinned(row: HTMLElement): boolean {
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
    sendMessage({ type: 'upsertChatRefs', chats: updates }).catch(() => undefined);
  }
}

function applyNativeChatVisibility() {
  if (!chatsList) return;

  const touchedRows = new Set<HTMLElement>();
  for (const link of collectNativeChatLinks(chatsList)) {
    const row = findChatRowElement(link, chatsList);
    const conversationId = getConversationId(link.href) || getConversationIdFromChatRow(row);
    const target = getNativeChatVisibilityTarget(row, link, chatsList);
    if (!conversationId || !target) continue;

    touchedRows.add(target);
    target.draggable = true;
    if (state.chatIndex.get(conversationId)?.projectId) {
      target.setAttribute(HIDDEN_ATTR, 'true');
    } else {
      target.removeAttribute(HIDDEN_ATTR);
    }
  }

  chatsList.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach((node) => {
    if (!touchedRows.has(node)) node.removeAttribute(HIDDEN_ATTR);
  });
}

function getNativeChatVisibilityTarget(
  row: HTMLElement | null,
  link: HTMLAnchorElement,
  listRoot: HTMLElement
): HTMLElement | null {
  if (row) {
    const safeRow = getSafeNativeChatRow(row, link, listRoot);
    if (safeRow) return safeRow;
  }
  return listRoot.contains(link) ? link : null;
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

function getSafeNativeChatRow(
  row: HTMLElement,
  link: HTMLAnchorElement,
  listRoot: HTMLElement
): HTMLElement | null {
  if (!listRoot.contains(row)) return null;
  if (row === listRoot || row === sidebarRoot || row === document.body || row === document.documentElement) return null;
  if (!row.contains(link)) return null;
  if (row.contains(document.getElementById('gemini-projects-host'))) return null;
  if (row.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]').length !== 1) return null;

  const rect = row.getBoundingClientRect();
  const listRect = listRoot.getBoundingClientRect();
  if (rect.height <= 0 || rect.height > 96) return null;
  if (rect.width <= 0 || rect.width > listRect.width + 16) return null;

  const tag = row.tagName.toLowerCase();
  const role = row.getAttribute('role') || '';
  if (tag === 'li' || role === 'listitem') return row;

  const parentConversationCount = row.parentElement
    ? collectNativeChatLinks(row.parentElement).length
    : Number.POSITIVE_INFINITY;
  return parentConversationCount > 1 ? row : null;
}

async function handleSaveProject(project: Project) {
  const response = await sendMessage({ type: 'upsertProject', project });
  if (!response.ok || !response.state) return;
  state.projects = response.state.projects;
  if (project.parentId) state.expandedProjectIds.add(project.parentId);
  if (project.kind === 'folder') state.expandedProjectIds.add(project.id);
  renderPanelIfChanged(true);
}

async function handleAddCurrentChat(projectId: string) {
  const conversationId = getConversationId(window.location.href);
  if (!conversationId) {
    panel?.showToast('Open a chat first, then use "Add current chat".');
    return;
  }
  state.expandedProjectIds.add(projectId);
  await handleMoveChat(conversationId, projectId);
  panel?.showToast('Chat added to project');
}

function handleToggleProjectExpand(projectId: string) {
  if (state.expandedProjectIds.has(projectId)) {
    state.expandedProjectIds.delete(projectId);
  } else {
    state.expandedProjectIds.add(projectId);
  }
  renderPanelIfChanged(true);
}

async function handleToggleProjectPin(projectId: string, isPinned: boolean) {
  const response = await sendMessage({ type: 'setProjectPinned', projectId, isPinned });
  if (!response.ok) throw new Error(response.error);
  if (!response.state) throw new Error('Project state was not returned');
  state.projects = response.state.projects;
  renderPanelIfChanged(true);
}

function handleToggleCollapse(section: 'projects' | 'folders', collapsed: boolean) {
  if (section === 'projects') {
    state.uiPrefs.projectsCollapsed = collapsed;
    sendMessage({ type: 'updateUiPrefs', prefs: { projectsCollapsed: collapsed } }).catch(() => undefined);
  } else {
    state.uiPrefs.foldersCollapsed = collapsed;
    sendMessage({ type: 'updateUiPrefs', prefs: { foldersCollapsed: collapsed } }).catch(() => undefined);
  }
  renderPanelIfChanged(true);
}

async function handleDeleteProject(projectId: string) {
  const response = await sendMessage({ type: 'deleteProject', projectId });
  if (!response.ok || !response.state) return;
  state.projects = response.state.projects;
  state.chatIndex = new Map(Object.entries(response.state.chatIndex));
  state.expandedProjectIds.delete(projectId);
  applyNativeChatVisibility();
  renderPanelIfChanged(true);
}

async function handleMoveChat(conversationId: string, projectId: string | null) {
  await ensureChatKnown(conversationId);
  const response = await sendMessage({ type: 'moveChat', conversationId, projectId });
  if (!response.ok || !response.state) return;
  state.projects = response.state.projects ?? state.projects;
  state.chatIndex = new Map(Object.entries(response.state.chatIndex));
  if (projectId) state.expandedProjectIds.add(projectId);
  applyNativeChatVisibility();
  renderPanelIfChanged(true);
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
    await sendMessage({ type: 'upsertChatRefs', chats: [chat] }).catch(() => undefined);
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
  await sendMessage({ type: 'upsertChatRefs', chats: [chat] }).catch(() => undefined);
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
  return `${state.uiPrefs.projectsCollapsed}|${state.uiPrefs.foldersCollapsed}|${Array.from(state.expandedProjectIds).sort().join(',')}|${projects}|${chats}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: number | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`timeout(${timeoutMs}ms)`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== null) window.clearTimeout(timer);
  });
}

function runStage(name: string, fn: () => void) {
  try {
    fn();
  } catch (error) {
    console.error(`[gemini-projects] stage failed: ${name}`, error);
  }
}

bootstrap().catch((error) => {
  console.error('[gemini-projects] bootstrap failed', error);
});

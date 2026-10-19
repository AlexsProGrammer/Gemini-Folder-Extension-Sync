import {
  findChatsListContainer,
  findChatsSection,
  findChatRowElement,
  findSidebarRoot,
  getConversationId,
  getConversationIdFromChatRow
} from './anchors';
import { isMobileEnvironment } from '../../shared/env';

const DEBUG = false;
const ACTIVE_ROW_ATTR = 'data-gp-active-row';
const ACTIVE_ROW_ID_ATTR = 'data-gp-conversation-id';
const MENU_ITEM_ATTR = 'data-gp-item';
const MENU_OBSERVER_ATTR = 'data-gp-menu-observer';
/**
 * Gemini's native conversation menu buttons expose stable, language-independent
 * data-test-id attributes (share-button, pin-button, rename-button,
 * delete-button). They are preferred over text heuristics wherever possible.
 */
const MENU_TEST_IDS = ['share-button', 'pin-button', 'rename-button', 'delete-button'] as const;
// Menu labels are localized (e.g. German "Anpinnen"/"Umbenennen"/"Löschen" do
// not contain the English words), so token lists cover English, Simplified /
// Traditional Chinese and German.
const MENU_TOKENS = [
  'share conversation', 'share', 'pin', 'rename', 'delete',
  '分享', '置顶', '重命名', '删除',
  'teilen', 'anpinnen', 'umbenennen', 'löschen', 'loeschen'
];
const PIN_ACTION_TOKENS = ['pin', 'anpinnen', '置顶', '置頂', '固定'];
const RENAME_ACTION_TOKENS = ['rename', 'umbenennen', '重命名', '重新命名'];
const DELETE_ACTION_TOKENS = ['delete', 'löschen', 'loeschen', '删除', '刪除'];
const SHARE_ACTION_TOKENS = ['share', 'teilen', '分享'];
/** Tokens that identify the native "Unpin" action (checked before "pin"). */
const UNPIN_TOKENS = [
  'unpin', 'un-pin', 'nicht anpinnen', 'anpinnen aufheben', 'loslösen',
  '取消置顶', '取消置頂', '解除置顶', '取消釘選'
];
/** Tokens that identify the native "Pin" action. */
const PIN_SYNC_TOKENS = ['pin', 'anpinnen', '置顶', '釘選', '固定'];
/** Labels that identify the native chat kebab ("more options") trigger. */
const KEBAB_LABEL_TOKENS = [
  'more',
  'menu',
  'options',
  'open menu',
  'conversation actions',
  'open menu for conversation actions',
  '更多',
  '菜单',
  '选项',
  '菜單',
  '選單',
  '選項',
  'menü',
  'optionen',
  'mehr'
];

export type TargetPickerMode = 'project' | 'folder' | 'all';

export interface ChatMenuEnhancerOptions {
  getChatProjectId: (conversationId: string) => string | null;
  getProjectName: (projectId: string) => string;
  onPickTarget: (conversationId: string, mode: TargetPickerMode) => void;
  onRemoveChat: (conversationId: string) => void;
  onToggleChatPin: (conversationId: string, isPinned: boolean) => void;
  onMenuClosed: () => void;
  onFallbackMenu: (conversationId: string, anchorRect: DOMRect) => void;
}

export interface ChatMenuHandle {
  openNativeChatMenu: (conversationId: string, anchorRect: DOMRect) => Promise<boolean>;
}

const ITEM_FONT_STACK = '"Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif';

// Touch-first mobile devices get taller injected rows so they match Material
// touch targets and the spacing of Gemini's mobile menu sheets. Desktop stays
// at the compact 36px rows that mirror Gemini's desktop context menu.
const MOBILE_TOUCH = isMobileEnvironment();
const ITEM_HEIGHT = MOBILE_TOUCH ? '44px' : '36px';
const ITEM_FONT_SIZE = MOBILE_TOUCH ? '14px' : '12px';
const ITEM_LINE_HEIGHT = MOBILE_TOUCH ? '20px' : '16px';

const ITEM_ICONS = {
  addToProject:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M12 11v5"/><path d="M9.5 13.5h5"/>',
  addToFolder:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="m12 10 3 3-3 3"/><path d="M15 13H8"/>',
  move:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M8 13h8"/><path d="m13 10 3 3-3 3"/><path d="m11 16-3-3 3-3"/>',
  remove:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="M9.5 13.5h5"/>'
} as const;

let enhancerOptions: ChatMenuEnhancerOptions | null = null;
let listenersAttached = false;
let currentMenuRoot: HTMLElement | null = null;
let menuObserver: MutationObserver | null = null;
let menuActionSyncHandler: ((event: MouseEvent) => void) | null = null;
let activeRowTimeout: number | null = null;
let observedMenuRoot: HTMLElement | null = null;

function log(...args: unknown[]) {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[gp-menu]', ...args);
  }
}

function describeEl(el: HTMLElement | null): string {
  if (!el) return 'null';
  const label = el.getAttribute('aria-label') || '';
  const role = el.getAttribute('role') || '';
  const text = (el.textContent || '').trim().slice(0, 24);
  return `${el.tagName.toLowerCase()} role=${role} label=${label} text="${text}"`;
}

function menuRectInfo(el: HTMLElement): string {
  const rect = el.getBoundingClientRect();
  return `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
}

function hasMenuToken(container: HTMLElement, tokens: string[]): boolean {
  const nodes = container.querySelectorAll<HTMLElement>('div, button, [role="menuitem"]');
  for (const node of Array.from(nodes)) {
    const text = (node.textContent || '').toLowerCase();
    if (tokens.some((token) => text.includes(token))) {
      return true;
    }
  }
  return false;
}

/** Returns the stable menu button test ids present inside the container. */
function menuTestIdHits(container: HTMLElement): Set<string> {
  const hits = new Set<string>();
  for (const id of MENU_TEST_IDS) {
    if (container.querySelector(`[data-test-id="${id}"]`)) {
      hits.add(id);
    }
  }
  return hits;
}

function hasRequiredChatActions(container: HTMLElement): boolean {
  // Two or more stable test ids unambiguously identify the conversation menu,
  // regardless of the UI language.
  if (menuTestIdHits(container).size >= 2) {
    return true;
  }
  return (
    hasMenuToken(container, PIN_ACTION_TOKENS) &&
    hasMenuToken(container, RENAME_ACTION_TOKENS) &&
    hasMenuToken(container, DELETE_ACTION_TOKENS)
  );
}

function summarizeChatMenu(container: HTMLElement): {
  pin: boolean;
  rename: boolean;
  delete: boolean;
  share: boolean;
  recognizedActionCount: number;
} {
  const testIds = menuTestIdHits(container);
  const pin = testIds.has('pin-button') || hasMenuToken(container, PIN_ACTION_TOKENS);
  const rename = testIds.has('rename-button') || hasMenuToken(container, RENAME_ACTION_TOKENS);
  const deleteAction = testIds.has('delete-button') || hasMenuToken(container, DELETE_ACTION_TOKENS);
  const share = testIds.has('share-button') || hasMenuToken(container, SHARE_ACTION_TOKENS);
  return {
    pin,
    rename,
    delete: deleteAction,
    share,
    recognizedActionCount: [pin, rename, deleteAction, share].filter(Boolean).length
  };
}

function isRowInChatsList(row: HTMLElement | null): boolean {
  if (!row) return false;
  const sidebarRoot = findSidebarRoot();
  if (!sidebarRoot) return false;
  const chatsHeader = findChatsSection(sidebarRoot);
  if (!chatsHeader) return false;
  const chatsList = findChatsListContainer(chatsHeader);
  if (!chatsList) return false;
  return chatsList.contains(row);
}

function isRowInSidebar(row: HTMLElement | null): boolean {
  if (!row) return false;
  const sidebarRoot = findSidebarRoot();
  return Boolean(sidebarRoot && sidebarRoot.contains(row));
}

function clearActiveRow() {
  const prev = document.querySelector<HTMLElement>(`[${ACTIVE_ROW_ATTR}="true"]`);
  if (prev) {
    prev.removeAttribute(ACTIVE_ROW_ATTR);
    prev.removeAttribute(ACTIVE_ROW_ID_ATTR);
  }
  if (activeRowTimeout) {
    window.clearTimeout(activeRowTimeout);
    activeRowTimeout = null;
  }
}

function setActiveRow(row: HTMLElement | null) {
  clearActiveRow();
  if (!row) return;
  row.setAttribute(ACTIVE_ROW_ATTR, 'true');
  activeRowTimeout = window.setTimeout(() => clearActiveRow(), 2000);
}

log('menus.ts debug enabled');

/**
 * Finds the native sidebar row for a conversation id, even when the row is
 * hidden because its chat lives inside a project.
 */
function findNativeChatRow(conversationId: string): HTMLElement | null {
  const sidebarRoot = findSidebarRoot();
  if (!sidebarRoot) return null;
  const chatsHeader = findChatsSection(sidebarRoot);
  const chatsList = findChatsListContainer(chatsHeader);
  const roots: ParentNode[] = [chatsList, sidebarRoot].filter(Boolean) as ParentNode[];
  for (const root of roots) {
    const link = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).find(
      (candidate) => getConversationId(candidate.href) === conversationId
    );
    if (link) {
      return findChatRowElement(link, chatsList) || link;
    }
  }
  return null;
}

function kebabScore(button: HTMLElement): number {
  const labelRaw = button.getAttribute('aria-label') || button.getAttribute('title') || '';
  const label = labelRaw.toLowerCase();
  const hasMenuAttr = button.getAttribute('aria-haspopup') === 'menu' || button.getAttribute('aria-expanded') === 'true';
  const text = (button.textContent || '').trim();
  const hasDots = text === '⋮' || text === '...' || text === '…';
  const labelHit = KEBAB_LABEL_TOKENS.some((token) => label.includes(token));
  if (hasMenuAttr) return 3;
  if (labelHit) return 2;
  if (hasDots) return 1;
  return 0;
}

function findChatKebabButton(row: HTMLElement): HTMLButtonElement | null {
  const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('button'));
  const scored = buttons
    .map((button) => ({ button, score: kebabScore(button) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.button ?? null;
}

export function attachChatMenuEnhancer(options: ChatMenuEnhancerOptions): ChatMenuHandle {
  enhancerOptions = options;

  if (listenersAttached) {
    return { openNativeChatMenu };
  }
  listenersAttached = true;

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const inSidebar = !!target.closest('nav, aside, [role="navigation"], [role="complementary"]');
      if (inSidebar) {
        log('pointerdown', describeEl(target));
      }
      if (!isChatKebabButton(target)) {
        if (inSidebar) {
          log('not a kebab', describeEl(target.closest('button,[role="button"],div,[aria-label]') as HTMLElement));
        }
        return;
      }

      cleanupMenuArtifacts('new menu');

      const row = findChatRowFromTarget(target);
      setActiveRow(row);
      log('kebab click captured');
      const conversationId = getConversationIdFromActiveRow(target);
      log('conversationId', conversationId);
      if (!conversationId) {
        log('conversationId missing at click');
      } else if (row) {
        row.setAttribute(ACTIVE_ROW_ID_ATTR, conversationId);
      }

      waitForMenuRoot(target).then((menuRoot) => {
        if (!menuRoot) {
          log('menu root not found');
          return;
        }
        log('menuRoot found:', menuRoot.tagName.toLowerCase(), 'rect=', menuRectInfo(menuRoot), 'hits=', countMenuTokens(menuRoot, MENU_TOKENS));
        const resolvedId = conversationId || getConversationIdFromActiveRow(target);
        if (!resolvedId) {
          log('conversationId missing at inject time');
          return;
        }
        tryInjectWithRetries(menuRoot, resolvedId, target, 0);
      });
    },
    true
  );

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const inMenu = currentMenuRoot?.contains(target) ?? false;
    const isKebab = isChatKebabButton(target);

    if (!inMenu && !isKebab) {
      cleanupMenuArtifacts('outside click');
    }
  });

  document.addEventListener('scroll', () => cleanupMenuArtifacts('scroll'), true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      cleanupMenuArtifacts('esc');
    }
  });

  // Right-click on any sidebar chat row: reuse Gemini's own context menu and
  // augment it with the extension items. Falls back to the extension picker
  // when the native menu cannot be opened.
  document.addEventListener('contextmenu', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || !enhancerOptions) return;
    const row = findChatRowFromTarget(target);
    if (!row || !isRowInSidebar(row)) return;
    const conversationId = getConversationIdFromActiveRow(target) || getConversationIdFromChatRow(row);
    if (!conversationId) return;
    event.preventDefault();
    cleanupMenuArtifacts('context menu');
    void openNativeChatMenu(conversationId, row.getBoundingClientRect()).then((opened) => {
      if (!opened && !currentMenuRoot) {
        enhancerOptions?.onFallbackMenu(conversationId, row.getBoundingClientRect());
      }
    });
  }, true);

  return { openNativeChatMenu };
}

/**
 * Opens Gemini's native chat menu for a conversation from an arbitrary anchor
 * (for example a kebab button inside the projects panel). The native row may
 * be hidden (`display: none`) because the chat lives inside a project; the
 * click is dispatched programmatically and the opened menu is repositioned
 * next to the anchor so rename/pin/delete/share keep working natively.
 */
export async function openNativeChatMenu(conversationId: string, anchorRect: DOMRect): Promise<boolean> {
  if (!enhancerOptions) return false;
  cleanupMenuArtifacts('programmatic open');

  const row = findNativeChatRow(conversationId);
  const kebab = row ? findChatKebabButton(row) : null;
  if (!row || !kebab) {
    log('native row or kebab missing for', conversationId);
    return false;
  }

  setActiveRow(row);
  row.setAttribute(ACTIVE_ROW_ID_ATTR, conversationId);

  const rect = kebab.getBoundingClientRect();
  const clickInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    button: 0,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2
  };
  try {
    kebab.dispatchEvent(new PointerEvent('pointerdown', clickInit));
    kebab.dispatchEvent(new MouseEvent('mousedown', clickInit));
    kebab.dispatchEvent(new MouseEvent('mouseup', clickInit));
    kebab.dispatchEvent(new MouseEvent('click', clickInit));
  } catch {
    kebab.click();
  }

  const menuRoot = await waitForMenuRoot(kebab, 90);
  if (!menuRoot) {
    log('native menu did not open for', conversationId);
    return false;
  }

  positionMenuToAnchor(menuRoot, anchorRect);

  await new Promise<boolean>((resolve) => {
    if (injectChatMenuItems(menuRoot, conversationId)) {
      resolve(true);
      return;
    }
    let attempts = 0;
    const tick = () => {
      attempts += 1;
      if (injectChatMenuItems(menuRoot, conversationId)) {
        resolve(true);
        return;
      }
      if (attempts >= 6) {
        resolve(false);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // The native menu is open and fully usable (rename / pin / delete / share
  // keep working natively); the extension items are best-effort. Returning
  // true keeps the native menu instead of stacking the fallback menu on top.
  return true;
}

/**
 * Repositions a CDK/Material overlay menu (opened from a hidden trigger) so it
 * appears next to the requested anchor rectangle.
 */
function positionMenuToAnchor(menuRoot: HTMLElement, anchorRect: DOMRect): void {
  const place = () => {
    const pane = (menuRoot.closest('.cdk-overlay-pane') as HTMLElement | null) || menuRoot;
    const rect = pane.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
      requestAnimationFrame(place);
      return;
    }
    const width = rect.width || 240;
    const height = rect.height || 160;
    let left = anchorRect.right + 4;
    if (left + width > window.innerWidth - 8) {
      left = anchorRect.left - width - 4;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = anchorRect.bottom + 4;
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, anchorRect.top - height - 4);
    }
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    pane.style.setProperty('position', 'fixed', 'important');
    pane.style.setProperty('left', `${left}px`, 'important');
    pane.style.setProperty('top', `${top}px`, 'important');
    pane.style.setProperty('right', 'auto', 'important');
    pane.style.setProperty('bottom', 'auto', 'important');
    pane.style.setProperty('transform', 'none', 'important');
  };
  requestAnimationFrame(place);
}

export function isChatKebabButton(el: HTMLElement): boolean {
  const button = el.closest('button,[role="button"],div,[aria-label]') as HTMLElement | null;
  if (!button) return false;
  const row = findChatRowFromTarget(button);
  const rowHasConversation = Boolean(getConversationIdFromChatRow(row));
  if (!isRowInChatsList(row)) {
    // Fallback for newer sidebar layouts where the chats list container cannot
    // be resolved: accept any row inside the sidebar that carries a chat id.
    if (!rowHasConversation || !isRowInSidebar(row)) {
      return false;
    }
  }
  if (!rowHasConversation) {
    return false;
  }
  const labelRaw = button.getAttribute('aria-label') || button.getAttribute('title') || '';
  const label = labelRaw.toLowerCase();
  const hasMenuAttr = button.getAttribute('aria-haspopup') === 'menu' || button.getAttribute('aria-expanded') === 'true';
  const text = (button.textContent || '').trim();
  const hasDots = text === '⋮' || text === '...' || text === '…';
  const labelHit = KEBAB_LABEL_TOKENS.some((token) => label.includes(token));
  return hasMenuAttr || hasDots || labelHit;
}

export function waitForMenuRoot(targetEl?: HTMLElement, maxFrames = 30): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let done = false;
    const resolveOnce = (menu: HTMLElement | null) => {
      if (done) return;
      done = true;
      observer.disconnect();
      resolve(menu);
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          const menu = findMenuFromNode(node);
          if (menu) {
            resolveOnce(menu);
            return;
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    let frame = 0;
    const tick = () => {
      if (done) return;
      const menuRoot = findBestMenuRoot(targetEl);
      if (menuRoot) {
        resolveOnce(menuRoot);
        return;
      }
      frame += 1;
      if (frame >= maxFrames) {
        resolveOnce(null);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function findMenuFromNode(node: Node): HTMLElement | null {
  if (!(node instanceof HTMLElement)) {
    return null;
  }
  if (isGeminiChatMenu(node)) {
    return node;
  }
  const roleMenu = node.querySelector<HTMLElement>('[role="menu"], [role="listbox"]');
  if (roleMenu && isGeminiChatMenu(roleMenu)) {
    return roleMenu;
  }
  const menuItem = node.querySelector<HTMLElement>('[role="menuitem"]');
  if (menuItem) {
    const root = menuItem.closest<HTMLElement>('[role="menu"], [role="listbox"]') || menuItem.parentElement;
    if (root && isGeminiChatMenu(root)) {
      return root;
    }
  }
  return null;
}

function collectSearchRoots(): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [document];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let current = walker.currentNode as Element | null;
  while (current) {
    const element = current as HTMLElement;
    if (element.shadowRoot) {
      roots.push(element.shadowRoot);
    }
    current = walker.nextNode() as Element | null;
  }
  return roots;
}

function findBestMenuRoot(targetEl?: HTMLElement): HTMLElement | null {
  const roots = collectSearchRoots();
  const candidates: HTMLElement[] = [];

  roots.forEach((root) => {
    candidates.push(...Array.from(root.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]')));
  });

  const visibleCandidates = candidates.filter((menu) => isMenuRootVisible(menu) && isGeminiChatMenu(menu));
  if (!visibleCandidates.length) return null;

  const byHits = visibleCandidates
    .map((menu) => {
      const rect = menu.getBoundingClientRect();
      const area = rect.width * rect.height;
      return { menu, hits: countMenuTokens(menu, MENU_TOKENS), area };
    })
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.area - b.area;
    });

  if (byHits[0]?.hits >= 2) {
    return byHits[0].menu;
  }

  if (targetEl) {
    const fromPoint = findMenuFromPoint(targetEl);
    if (fromPoint) return fromPoint;
    return pickClosestMenu(visibleCandidates, targetEl);
  }

  return pickTopmostMenu(visibleCandidates);
}

function findMenuFromPoint(targetEl: HTMLElement): HTMLElement | null {
  const rect = targetEl.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 4, Math.max(0, rect.right + 8));
  const y = Math.min(window.innerHeight - 4, Math.max(0, rect.top + 8));
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const menu = el.closest<HTMLElement>('[role="menu"], [role="listbox"]');
  if (menu && isMenuRootVisible(menu) && isGeminiChatMenu(menu)) {
    return menu;
  }
  return null;
}

function pickClosestMenu(menus: HTMLElement[], targetEl: HTMLElement): HTMLElement | null {
  const targetRect = targetEl.getBoundingClientRect();
  let bestMenu: HTMLElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  menus.forEach((menu) => {
    const rect = menu.getBoundingClientRect();
    const dx = rect.left - targetRect.right;
    const dy = rect.top - targetRect.top;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMenu = menu;
    }
  });
  return bestMenu;
}

function pickTopmostMenu(menus: HTMLElement[]): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestZ = -Infinity;
  menus.forEach((menu) => {
    const z = getZIndex(menu);
    if (z > bestZ) {
      bestZ = z;
      best = menu;
    }
  });
  return best || menus[0] || null;
}

function getZIndex(element: HTMLElement): number {
  const z = window.getComputedStyle(element).zIndex;
  const parsed = Number(z);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isGeminiChatMenu(root: HTMLElement): boolean {
  if (hasRequiredChatActions(root)) {
    return true;
  }
  const summary = summarizeChatMenu(root);
  return summary.recognizedActionCount >= 2 && (summary.pin || summary.rename || summary.delete);
}

export function getConversationIdFromActiveRow(targetEl: HTMLElement): string | null {
  const active = document.querySelector<HTMLElement>(`[${ACTIVE_ROW_ATTR}="true"]`);
  const row = active || findChatRowFromTarget(targetEl);
  const link = row?.querySelector<HTMLAnchorElement>('a[href]') || targetEl.closest<HTMLAnchorElement>('a[href]');
  const hrefId = link?.href ? getConversationId(link.href) : null;
  if (hrefId) return hrefId;
  if (row) {
    const cached = row.getAttribute(ACTIVE_ROW_ID_ATTR);
    if (cached) return cached;
  }
  return getConversationIdFromChatRow(row);
}

/**
 * Injects the extension's own items into Gemini's native chat menu:
 * - chats without a project get "Add to project" and "Add to folder";
 * - chats inside a project/folder get "Move to project or folder…" and
 *   "Remove from <name>".
 * All remaining items (rename, pin, delete, share, ...) stay native.
 */
export function injectChatMenuItems(root: HTMLElement, conversationId: string): boolean {
  if (!enhancerOptions) return false;

  let menuRoot = findMenuContainer(root);
  menuRoot = findActualMenuRoot(menuRoot);
  if (menuRoot === document.body || menuRoot === document.documentElement || !isGeminiChatMenu(menuRoot)) {
    return false;
  }
  currentMenuRoot = menuRoot;

  // Clean stale items outside menuRoot
  queryAllInRoots(`[${MENU_ITEM_ATTR}]`).forEach((node) => {
    if (!menuRoot.contains(node)) {
      node.remove();
    }
  });
  menuRoot.querySelectorAll(`[${MENU_ITEM_ATTR}]`).forEach((node) => node.remove());

  const { container, deleteItem } = findMenuListContainer(menuRoot);
  if (!container || container === document.body || container === document.documentElement) {
    return false;
  }

  const projectId = enhancerOptions.getChatProjectId(conversationId);
  const projectName = projectId ? enhancerOptions.getProjectName(projectId) : '';

  const specs: { action: string; icon: string; label: string; arrow: boolean }[] = projectId
    ? [
        { action: 'move-container', icon: ITEM_ICONS.move, label: 'Move to project or folder…', arrow: true },
        {
          action: 'remove-from-container',
          icon: ITEM_ICONS.remove,
          label: projectName ? `Remove from ${projectName}` : 'Remove from project',
          arrow: false
        }
      ]
    : [
        { action: 'add-to-project', icon: ITEM_ICONS.addToProject, label: 'Add to project', arrow: true },
        { action: 'add-to-folder', icon: ITEM_ICONS.addToFolder, label: 'Add to folder', arrow: true }
      ];

  const items = specs.map((spec) => {
    const item = createInjectedMenuItem(spec.action, spec.icon, spec.label, spec.arrow);
    attachInjectedItemHandlers(item, spec.action, conversationId);
    return item;
  });

  let anchor: Node | null = deleteItem?.parentNode ? deleteItem.nextSibling : null;
  const parent: HTMLElement = deleteItem?.parentNode && menuRoot.contains(deleteItem.parentNode)
    ? (deleteItem.parentNode as HTMLElement)
    : container;
  items.forEach((item) => {
    parent.insertBefore(item, anchor);
    anchor = item.nextSibling;
  });

  const ok = validateInjection(items[0], container);
  log('injected ok:', `inRoot=${menuRoot.contains(items[0])}`, `overlap=${ok.overlap.toFixed(2)}`, `container=${describeEl(container)}`);

  if (!ok.passed) {
    items.forEach((item) => item.remove());
    return false;
  }

  observeMenuRoot(menuRoot, conversationId);
  return true;
}

function createInjectedMenuItem(action: string, iconPaths: string, label: string, withArrow: boolean): HTMLElement {
  const item = document.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.setAttribute(MENU_ITEM_ATTR, action);

  // Match Gemini's native menu rows: compact 36px items on desktop, 44px
  // touch targets on mobile, 0 12px padding, icon, "Google Sans Flex",
  // pill radius (50% of item height).
  item.style.setProperty('display', 'flex', 'important');
  item.style.setProperty('align-items', 'center', 'important');
  item.style.setProperty('gap', '12px', 'important');
  item.style.setProperty('height', ITEM_HEIGHT, 'important');
  item.style.setProperty('min-height', ITEM_HEIGHT, 'important');
  item.style.setProperty('max-height', ITEM_HEIGHT, 'important');
  item.style.setProperty('padding', '0 12px', 'important');
  item.style.setProperty('box-sizing', 'border-box', 'important');
  item.style.setProperty('cursor', 'pointer', 'important');
  item.style.setProperty('border-radius', MOBILE_TOUCH ? '22px' : '18px', 'important');
  item.style.setProperty('background', 'transparent', 'important');
  item.style.setProperty('color', 'inherit', 'important');
  item.style.setProperty('border', 'none', 'important');
  item.style.setProperty('outline', 'none', 'important');
  item.style.setProperty('font-family', `${ITEM_FONT_STACK}`, 'important');
  item.style.setProperty('font-size', ITEM_FONT_SIZE, 'important');
  item.style.setProperty('font-weight', '300', 'important');
  item.style.setProperty('line-height', ITEM_LINE_HEIGHT, 'important');

  const icon = document.createElement('span');
  icon.style.setProperty('width', '16px', 'important');
  icon.style.setProperty('height', '16px', 'important');
  icon.style.setProperty('flex', '0 0 16px', 'important');
  icon.style.display = 'inline-flex';
  icon.style.alignItems = 'center';
  icon.style.justifyContent = 'center';
  icon.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      ${iconPaths}
    </svg>
  `;

  const labelSpan = document.createElement('span');
  labelSpan.textContent = label;
  labelSpan.style.flex = '1';
  labelSpan.style.whiteSpace = 'nowrap';
  labelSpan.style.overflow = 'hidden';
  labelSpan.style.textOverflow = 'ellipsis';

  item.appendChild(icon);
  item.appendChild(labelSpan);

  if (withArrow) {
    const arrow = document.createElement('span');
    arrow.style.display = 'flex';
    arrow.style.alignItems = 'center';
    arrow.style.opacity = '0.6';
    arrow.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 17l5-5-5-5"/>
      </svg>
    `;
    item.appendChild(arrow);
  }

  item.addEventListener('mouseenter', () => {
    const isDark = document.body.classList.contains('dark') || document.body.classList.contains('dark-theme');
    item.style.setProperty('background', isDark ? 'rgba(255, 255, 255, 0.08)' : '#f1f3f4', 'important');
  });
  item.addEventListener('mouseleave', () => {
    item.style.setProperty('background', 'transparent', 'important');
  });

  return item;
}

function attachInjectedItemHandlers(item: HTMLElement, action: string, conversationId: string): void {
  item.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!enhancerOptions) return;
    if (action === 'add-to-project') {
      enhancerOptions.onPickTarget(conversationId, 'project');
    } else if (action === 'add-to-folder') {
      enhancerOptions.onPickTarget(conversationId, 'folder');
    } else if (action === 'move-container') {
      enhancerOptions.onPickTarget(conversationId, 'all');
    } else if (action === 'remove-from-container') {
      enhancerOptions.onRemoveChat(conversationId);
    } else {
      return;
    }
    cleanupMenuArtifacts('injected action');
  });
}

function validateInjection(item: HTMLElement, menuRoot: HTMLElement): { passed: boolean; overlap: number } {
  const menuRect = menuRoot.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const overlapArea = intersectionArea(menuRect, itemRect);
  const itemArea = Math.max(1, itemRect.width * itemRect.height);
  const overlap = overlapArea / itemArea;
  const passed = menuRoot.contains(item) && overlap >= 0.5;
  return { passed, overlap };
}

function intersectionArea(a: DOMRect, b: DOMRect): number {
  const x1 = Math.max(a.left, b.left);
  const y1 = Math.max(a.top, b.top);
  const x2 = Math.min(a.right, b.right);
  const y2 = Math.min(a.bottom, b.bottom);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  return w * h;
}

function observeMenuRoot(menuRoot: HTMLElement, conversationId: string) {
  if (menuRoot.getAttribute(MENU_OBSERVER_ATTR) === 'true') {
    return;
  }
  menuRoot.setAttribute(MENU_OBSERVER_ATTR, 'true');
  observedMenuRoot = menuRoot;
  let reinjectCount = 0;

  if (menuObserver) {
    menuObserver.disconnect();
  }

  menuObserver = new MutationObserver(() => {
    if (!document.contains(menuRoot) || !isMenuRootVisible(menuRoot)) {
      menuObserver?.disconnect();
      menuRoot.removeAttribute(MENU_OBSERVER_ATTR);
      cleanupMenuArtifacts('menu root gone');
      return;
    }
    const exists = menuRoot.querySelector(`[${MENU_ITEM_ATTR}]`);
    if (!exists && reinjectCount < 3) {
      reinjectCount += 1;
      log('reinjected (observer) count=', reinjectCount);
      injectChatMenuItems(menuRoot, conversationId);
    }
  });

  menuObserver.observe(menuRoot, { childList: true, subtree: true });

  // Sync our own pin flag when the user triggers Gemini's native Pin/Unpin so
  // pinned chats can be sorted to the top of their project/folder section.
  // The handler stays attached for the whole menu lifetime and is removed by
  // cleanupMenuArtifacts when the menu closes.
  menuActionSyncHandler = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target || !menuRoot.contains(target)) return;
    const item = target.closest('button, [role="menuitem"], div, a') as HTMLElement | null;
    if (!item || item.hasAttribute(MENU_ITEM_ATTR)) return;
    const text = (item.textContent || '').toLowerCase().trim();
    // Inside the pin button these words can only mean the "Unpin" variant
    // (e.g. German "Nicht (mehr) anpinnen" / "Anpinnen aufheben").
    const readsAsUnpin = /unpin|un-pin|nicht|aufheben|entfernen|lösen|loesen|取消/.test(text);
    // The pin button carries a stable test id; only the label switches
    // between "Pin" and "Unpin" across locales.
    if (item.getAttribute('data-test-id') === 'pin-button') {
      enhancerOptions?.onToggleChatPin(conversationId, !readsAsUnpin);
      return;
    }
    if (!text || text.length > 48) return;
    if (UNPIN_TOKENS.some((token) => text.includes(token))) {
      enhancerOptions?.onToggleChatPin(conversationId, false);
    } else if (PIN_SYNC_TOKENS.some((token) => text.includes(token))) {
      enhancerOptions?.onToggleChatPin(conversationId, true);
    }
  };
  menuRoot.addEventListener('click', menuActionSyncHandler, true);

  window.setTimeout(() => {
    menuObserver?.disconnect();
    menuRoot.removeAttribute(MENU_OBSERVER_ATTR);
  }, 1500);
}

function isMenuRootVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const inViewport =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight;
  const withinBounds = rect.width < window.innerWidth * 0.9 && rect.height < window.innerHeight * 0.9;
  const area = rect.width * rect.height;
  const style = window.getComputedStyle(element);
  return (
    inViewport &&
    withinBounds &&
    area > 2000 &&
    style.pointerEvents !== 'none' &&
    style.display !== 'none' &&
    style.visibility !== 'hidden'
  );
}

function findMenuContainer(root: HTMLElement): HTMLElement {
  if (isMenuRootVisible(root) && isGeminiChatMenu(root)) {
    return root;
  }
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('div, button, [role="menuitem"]'));
  for (const node of candidates) {
    const text = (node.textContent || '').toLowerCase();
    if (!MENU_TOKENS.some((token) => text.includes(token))) {
      continue;
    }
    let current: HTMLElement | null = node.parentElement;
    while (current && current !== document.body) {
      if (isGeminiChatMenu(current) && isMenuRootVisible(current)) {
        return current;
      }
      current = current.parentElement;
    }
  }
  return root;
}

function countMenuTokens(container: HTMLElement, tokens: string[]): number {
  let count = 0;
  const nodes = container.querySelectorAll<HTMLElement>('div, button, [role="menuitem"]');
  nodes.forEach((node) => {
    const text = (node.textContent || '').toLowerCase();
    if (tokens.some((token) => text.includes(token))) {
      count += 1;
    }
  });
  return count;
}

function cleanupMenuArtifacts(reason: string) {
  const moveItems = Array.from(queryAllInRoots(`[${MENU_ITEM_ATTR}]`));
  moveItems.forEach((node) => node.remove());

  const hadMenu = currentMenuRoot !== null;
  if (menuObserver) {
    menuObserver.disconnect();
    menuObserver = null;
  }
  if (observedMenuRoot) {
    if (menuActionSyncHandler) {
      observedMenuRoot.removeEventListener('click', menuActionSyncHandler, true);
      menuActionSyncHandler = null;
    }
    observedMenuRoot.removeAttribute(MENU_OBSERVER_ATTR);
    observedMenuRoot = null;
  }
  if (currentMenuRoot) {
    currentMenuRoot.removeAttribute(MENU_OBSERVER_ATTR);
    currentMenuRoot = null;
  }

  log('cleanup removed:', `moveItem=${moveItems.length}`, reason);

  if (hadMenu) {
    enhancerOptions?.onMenuClosed();
  }
}

function findChatRowFromTarget(target: HTMLElement): HTMLElement | null {
  const sidebarRoot = findSidebarRoot();
  const chatsHeader = sidebarRoot ? findChatsSection(sidebarRoot) : null;
  const chatsList = findChatsListContainer(chatsHeader);
  const resolved = findChatRowElement(target, chatsList);
  if (resolved) return resolved;

  const anchor = target.closest('a[href]') as HTMLElement | null;
  if (anchor) {
    return (anchor.closest('[role="listitem"], li') as HTMLElement | null) ?? anchor;
  }
  let current: HTMLElement | null = target;
  while (current && current !== document.body) {
    if (current.querySelector('a[href]')) {
      return current;
    }
    current = current.parentElement;
  }
  return target.closest('[role="listitem"], li, div') as HTMLElement | null;
}

function matchesAnyToken(item: HTMLElement, tokens: string[]): boolean {
  const text = (item.textContent || '').toLowerCase();
  return text.length > 0 && tokens.some((token) => text.includes(token));
}

function findMenuListContainer(menuRoot: HTMLElement): { container: HTMLElement; deleteItem?: HTMLElement } {
  const items = Array.from(menuRoot.querySelectorAll<HTMLElement>('[role="menuitem"], button, div'));
  // Prefer the stable test id; the text fallback picks the shortest match so
  // a wrapper element is never mistaken for the delete item itself.
  const deleteItem =
    items.find((item) => item.getAttribute('data-test-id') === 'delete-button') ??
    items
      .filter((item) => matchesAnyToken(item, DELETE_ACTION_TOKENS))
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
  if (deleteItem?.parentElement && menuRoot.contains(deleteItem.parentElement)) {
    return { container: deleteItem.parentElement, deleteItem };
  }
  const innerMenu = menuRoot.querySelector<HTMLElement>('[role="menu"], [role="listbox"]');
  if (innerMenu && innerMenu !== menuRoot && isMenuRootVisible(innerMenu)) {
    return { container: innerMenu };
  }
  const firstItem = items.find((item) => {
    const text = (item.textContent || '').trim();
    if (!text) return false;
    if (text.length > 48) return false;
    const rect = item.getBoundingClientRect();
    return rect.height > 20 && rect.height < 80;
  });
  if (firstItem?.parentElement && menuRoot.contains(firstItem.parentElement)) {
    return { container: firstItem.parentElement };
  }
  return { container: menuRoot };
}

function findActualMenuRoot(root: HTMLElement): HTMLElement {
  if (root.getAttribute('role') === 'menu' || root.getAttribute('role') === 'listbox') {
    if (isGeminiChatMenu(root)) {
      return root;
    }
  }
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]'));
  const visible = candidates.filter((menu) => isMenuRootVisible(menu) && isGeminiChatMenu(menu));
  if (!visible.length) return root;

  const best = visible
    .map((menu) => {
      const rect = menu.getBoundingClientRect();
      return { menu, hits: countMenuTokens(menu, MENU_TOKENS), area: rect.width * rect.height };
    })
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.area - b.area;
    })[0];

  if (best && best.hits >= 1) {
    return best.menu;
  }
  return root;
}

function queryAllInRoots(selector: string): HTMLElement[] {
  const roots = collectSearchRoots();
  const results: HTMLElement[] = [];
  roots.forEach((root) => {
    results.push(...Array.from(root.querySelectorAll<HTMLElement>(selector)));
  });
  return results;
}

function tryInjectWithRetries(menuRoot: HTMLElement, conversationId: string, targetEl: HTMLElement, attempt: number) {
  const ok = injectChatMenuItems(menuRoot, conversationId);
  if (ok) return;
  if (attempt >= 2) {
    log('inject failed after retries');
    return;
  }
  const nextRoot = findBestMenuRoot(targetEl) || menuRoot;
  requestAnimationFrame(() => tryInjectWithRetries(nextRoot, conversationId, targetEl, attempt + 1));
}

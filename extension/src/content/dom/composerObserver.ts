import { getConversationId } from './anchors';

export interface ComposerObserverCallbacks {
  /**
   * Fired once per blank conversation whose composer is ready. Never fired for
   * conversations that already contain user turns.
   */
  onNewChatReady: (composer: HTMLElement) => void;
  /** Fired when the current conversation id changes (or becomes blank). */
  onConversationChanged?: (conversationId: string | null) => void;
}

export interface ComposerObserverHandle {
  stop: () => void;
}

/** Selectors that identify a user message turn inside the chat transcript. */
const USER_TURN_SELECTORS = [
  '.user-query-container',
  'user-query-container',
  'user-query',
  '.user-message',
  'user-message',
  '[data-role="user"]',
  '[data-message-author-role="user"]',
  '[data-test-id="user-query"]',
  '[data-testid="user-query"]',
  '.query-container'
] as const;

const EXCLUDED_ROOTS =
  'nav, aside, [role="navigation"], [role="complementary"], #gemini-projects-host, #gemini-projects-overlay, #gp-prompt-picker-root';

const CHECK_DEBOUNCE_MS = 280;
const FIRE_DELAY_MS = 360;

function isVisibleElement(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

export function hasUserTurnsInChat(): boolean {
  for (const selector of USER_TURN_SELECTORS) {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    for (const node of nodes) {
      if (node.closest(EXCLUDED_ROOTS)) continue;
      if (!isVisibleElement(node)) continue;
      if (!(node.textContent || '').trim()) continue;
      return true;
    }
  }
  return false;
}

export function findChatComposer(): HTMLElement | null {
  const selectors = [
    'rich-textarea div[contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[aria-label*="Message"]',
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="Ask"]'
  ];
  for (const selector of selectors) {
    const candidate = document.querySelector<HTMLElement>(selector);
    if (candidate && isVisibleElement(candidate) && !candidate.closest('#gp-prompt-picker-root')) {
      return candidate;
    }
  }
  return null;
}

export function isComposerBlank(composer: HTMLElement): boolean {
  return !(composer.textContent || '').trim();
}

/**
 * Monitors Gemini's chat surface and reports blank conversations. The observer
 * deliberately only fires `onNewChatReady` for conversations that never had a
 * user turn, so system prompts are never injected into ongoing multi-turn chats.
 */
export function initComposerObserver(callbacks: ComposerObserverCallbacks): ComposerObserverHandle {
  let lastConversationKey: string | null = null;
  let lastHandledComposer: HTMLElement | null = null;
  let usedConversations = new Set<string>();
  let fireTimer: number | null = null;
  let debounceTimer: number | null = null;
  let disposed = false;

  const historyPatch = (method: 'pushState' | 'replaceState') => {
    const original = history[method].bind(history);
    const wrapped: typeof history.pushState = (...args: Parameters<typeof history.pushState>) => {
      const result = original(...args);
      scheduleCheck();
      return result;
    };
    history[method] = wrapped;
  };

  function check(): void {
    if (disposed) return;

    const composer = findChatComposer();
    const conversationId = getConversationId(window.location.href);
    const conversationKey = conversationId ?? 'blank';

    if (conversationKey !== lastConversationKey) {
      const hadKey = lastConversationKey !== null;
      lastConversationKey = conversationKey;
      lastHandledComposer = null;
      if (fireTimer !== null) {
        window.clearTimeout(fireTimer);
        fireTimer = null;
      }
      if (hadKey) {
        callbacks.onConversationChanged?.(conversationId);
      }
    }

    if (!composer) return;

    const hasTurns = hasUserTurnsInChat();
    if (hasTurns) {
      usedConversations.add(conversationKey);
    }

    const isBlank = !hasTurns && isComposerBlank(composer) && !usedConversations.has(conversationKey);
    if (isBlank && composer !== lastHandledComposer) {
      if (fireTimer !== null) {
        window.clearTimeout(fireTimer);
      }
      fireTimer = window.setTimeout(() => {
        fireTimer = null;
        if (disposed) return;
        if (composer !== findChatComposer()) {
          lastHandledComposer = null;
          return;
        }
        if (hasUserTurnsInChat() || !isComposerBlank(composer)) return;
        lastHandledComposer = composer;
        callbacks.onNewChatReady(composer);
      }, FIRE_DELAY_MS);
    } else if (!isBlank && fireTimer !== null) {
      window.clearTimeout(fireTimer);
      fireTimer = null;
    }
  }

  function scheduleCheck(): void {
    if (debounceTimer !== null) return;
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      check();
    }, CHECK_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(scheduleCheck);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  window.addEventListener('popstate', scheduleCheck);
  window.addEventListener('hashchange', scheduleCheck);
  window.addEventListener('focus', scheduleCheck);
  historyPatch('pushState');
  historyPatch('replaceState');

  check();

  return {
    stop: () => {
      disposed = true;
      observer.disconnect();
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      if (fireTimer !== null) window.clearTimeout(fireTimer);
    }
  };
}
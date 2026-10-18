import { getConversationId } from './anchors';

export interface ComposerObserverCallbacks {
  /**
   * Fired once per blank conversation whose composer is ready. Never fired for
   * conversations that already contain user turns.
   */
  onNewChatReady: (composer: HTMLElement) => void;
  /**
   * Fired whenever a blank composer is ready inside a conversation that
   * already has user turns — for example right after a message is sent, or
   * when an ongoing project chat is opened. Lets the caller re-apply project
   * instructions to the next outgoing message.
   */
  onOngoingChatComposerReady?: (composer: HTMLElement, conversationId: string | null) => void;
  /**
   * Fired when the current conversation id changes (or becomes blank).
   * `previousConversationId` is null when the previous surface was a fresh
   * chat without a conversation id.
   */
  onConversationChanged?: (conversationId: string | null, previousConversationId: string | null) => void;
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
 * Monitors Gemini's chat surface and reports blank composers. Fresh
 * conversations (no user turns yet) fire `onNewChatReady`; ongoing
 * conversations fire `onOngoingChatComposerReady` every time their composer
 * becomes blank again (typically right after a send), which lets the caller
 * re-apply project instructions to the next outgoing message.
 */
export function initComposerObserver(callbacks: ComposerObserverCallbacks): ComposerObserverHandle {
  let lastConversationKey: string | null = null;
  let lastHandledComposer: HTMLElement | null = null;
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
      const previousConversationId =
        hadKey && lastConversationKey !== 'blank' ? lastConversationKey : null;
      lastConversationKey = conversationKey;
      lastHandledComposer = null;
      if (fireTimer !== null) {
        window.clearTimeout(fireTimer);
        fireTimer = null;
      }
      if (hadKey) {
        callbacks.onConversationChanged?.(conversationId, previousConversationId);
      }
    }

    if (!composer) return;

    // An occupied composer (user typing) ends the current blank cycle: forget
    // the handled marker so the next blank state — typically right after a
    // send — can trigger another ready callback for the following message.
    if (!isComposerBlank(composer)) {
      if (composer === lastHandledComposer) {
        lastHandledComposer = null;
      }
      if (fireTimer !== null) {
        window.clearTimeout(fireTimer);
        fireTimer = null;
      }
      return;
    }

    if (composer === lastHandledComposer) return;

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
      if (!isComposerBlank(composer)) {
        lastHandledComposer = null;
        return;
      }
      lastHandledComposer = composer;
      if (hasUserTurnsInChat()) {
        callbacks.onOngoingChatComposerReady?.(composer, getConversationId(window.location.href));
      } else {
        callbacks.onNewChatReady(composer);
      }
    }, FIRE_DELAY_MS);
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
import { getAccountIdHash, resolveStableAccountRawIdentifier } from '../shared/account';
import { debugStep } from '../shared/webext';

export const ACCOUNT_CHANGED_EVENT = 'gemini-workspace:account-changed';

export interface AccountChangeDetail {
  previousHash: string | null;
  newHash: string;
}

const REEVALUATE_DELAY_MS = 150;

let currentHash: string | null = null;
let hasResolved = false;
let initialized = false;
let historyPatched = false;
let profileObserver: MutationObserver | null = null;
let reevaluateTimer: number | null = null;

export function getActiveAccountHash(): string | null {
  return currentHash;
}

function dispatchAccountChanged(previousHash: string | null, newHash: string): void {
  window.dispatchEvent(
    new CustomEvent<AccountChangeDetail>(ACCOUNT_CHANGED_EVENT, {
      detail: { previousHash, newHash }
    })
  );
}

export async function resolveActiveAccountHash(): Promise<string> {
  const rawIdentifier = await debugStep('account:resolve-identity', () => resolveStableAccountRawIdentifier());
  const hash = await debugStep('account:hash-identity', () => getAccountIdHash(rawIdentifier));

  if (hash !== currentHash) {
    const previous = currentHash;
    currentHash = hash;
    if (hasResolved) {
      dispatchAccountChanged(previous, hash);
    }
  }
  hasResolved = true;
  return hash;
}

function scheduleReevaluate(): void {
  if (reevaluateTimer !== null) return;
  reevaluateTimer = window.setTimeout(() => {
    reevaluateTimer = null;
    void resolveActiveAccountHash().catch((error) =>
      console.warn('[gemini-projects] account re-evaluation failed', error)
    );
  }, REEVALUATE_DELAY_MS);
}

type HistoryStateSetter = (data: unknown, unused: string, url?: string | URL | null) => void;

function patchHistoryApi(): void {
  if (historyPatched) return;
  historyPatched = true;

  const patch = (name: 'pushState' | 'replaceState') => {
    const original = history[name].bind(history) as HistoryStateSetter;
    const wrapped: HistoryStateSetter = (...args) => {
      const result = original(...args);
      scheduleReevaluate();
      return result;
    };
    history[name] = wrapped as typeof history.pushState;
  };

  patch('pushState');
  patch('replaceState');
}

function observeProfileContainers(): void {
  profileObserver?.disconnect();
  profileObserver = new MutationObserver(() => scheduleReevaluate());
  // The account switcher lives inside Gemini's persistent header; observing
  // the body subtree catches it in both header layouts and during re-mounts.
  profileObserver.observe(document.body, { childList: true, subtree: true });
}

export function initAccountWatcher(): void {
  if (initialized) return;
  initialized = true;

  patchHistoryApi();
  window.addEventListener('popstate', () => scheduleReevaluate());
  observeProfileContainers();
  void resolveActiveAccountHash().catch((error) =>
    console.warn('[gemini-projects] initial account resolution failed', error)
  );
}
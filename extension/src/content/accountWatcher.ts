import { getAccountIdHash, resolveStableAccountRawIdentifier } from '../shared/account';
import { onSpaNavigation } from './dom/spaNavigation';

export const ACCOUNT_CHANGED_EVENT = 'gemini-workspace:account-changed';

export interface AccountChangeDetail {
  previousHash: string | null;
  newHash: string;
}

const REEVALUATE_DELAY_MS = 500;
const PROFILE_OBSERVER_TIMEOUT_MS = 15_000;

let currentHash: string | null = null;
let hasResolved = false;
let initialized = false;
let profileObserver: MutationObserver | null = null;
let profileObserverTimeout: number | null = null;
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

function stopProfileObserver(): void {
  profileObserver?.disconnect();
  profileObserver = null;
  if (profileObserverTimeout !== null) {
    window.clearTimeout(profileObserverTimeout);
    profileObserverTimeout = null;
  }
}

export async function resolveActiveAccountHash(): Promise<string> {
  const rawIdentifier = await resolveStableAccountRawIdentifier();
  if (!rawIdentifier.startsWith('account_index_')) {
    stopProfileObserver();
  }
  const hash = await getAccountIdHash(rawIdentifier);

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

function observeProfileContainers(): void {
  stopProfileObserver();
  profileObserver = new MutationObserver(() => scheduleReevaluate());
  // The account switcher lives inside Gemini's persistent header; observing
  // the body subtree during boot catches it until a real email resolves.
  profileObserver.observe(document.body, { childList: true, subtree: true });
  profileObserverTimeout = window.setTimeout(() => {
    stopProfileObserver();
  }, PROFILE_OBSERVER_TIMEOUT_MS);
}

export function initAccountWatcher(): void {
  if (initialized) return;
  initialized = true;

  onSpaNavigation(() => scheduleReevaluate());
  window.addEventListener('focus', () => scheduleReevaluate());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleReevaluate();
    }
  });
  observeProfileContainers();
  void resolveActiveAccountHash().catch((error) =>
    console.warn('[gemini-projects] initial account resolution failed', error)
  );
}
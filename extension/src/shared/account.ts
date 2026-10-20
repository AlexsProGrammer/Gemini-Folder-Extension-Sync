import { storageLocalGet, storageLocalSet } from './webext';

const ACCOUNT_INDEX_PATTERN = /\/u\/(\d+)/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const PROFILE_BADGE_SELECTORS = [
  'a[aria-label*="@"]',
  'button[aria-label*="@"]',
  'img[alt*="@"]'
] as const;

/**
 * Additional identity probes: Google renders the account email in the
 * one-google-bar avatar button under several shapes; scanning these keeps
 * identity resolution working when the primary badge selectors miss.
 */
const EXTENDED_IDENTITY_SELECTORS = [
  '[data-ogsr-email]',
  'a.gb_B[aria-label]',
  'a.gb_d[aria-label]',
  '[aria-label][data-identity-email]'
] as const;

/**
 * Persistent account identity registry.
 *
 * - `byHash` is authoritative for the local vault: the workspace partition of
 *   an account can only be decrypted with that account's raw identifier, so
 *   the mapping must survive browser restarts even when the profile badge is
 *   not currently rendered in the DOM.
 * - `byIndex` keeps identity sticky for the URL-index fallback (`/u/N`): when
 *   the email badge cannot be read, the index reuses the last email seen at
 *   that index instead of minting an unstable `account_index_N` identity.
 */
const IDENTITY_REGISTRY_KEY = 'gemini_account_identity_registry';

interface AccountIdentityRegistry {
  byHash: Record<string, string>;
  byIndex: Record<string, string>;
}

const memoryByHash = new Map<string, string>();

function emptyRegistry(): AccountIdentityRegistry {
  return { byHash: {}, byIndex: {} };
}

function asRegistry(raw: unknown): AccountIdentityRegistry {
  if (!raw || typeof raw !== 'object') return emptyRegistry();
  const candidate = raw as Partial<AccountIdentityRegistry>;
  const byHash: Record<string, string> = {};
  const byIndex: Record<string, string> = {};
  if (candidate.byHash && typeof candidate.byHash === 'object') {
    Object.entries(candidate.byHash as Record<string, unknown>).forEach(([hash, raw2]) => {
      if (typeof raw2 === 'string' && /^[0-9a-f]{64}$/.test(hash)) byHash[hash] = raw2;
    });
  }
  if (candidate.byIndex && typeof candidate.byIndex === 'object') {
    Object.entries(candidate.byIndex as Record<string, unknown>).forEach(([index, raw2]) => {
      if (typeof raw2 === 'string' && /^\d+$/.test(index)) byIndex[index] = raw2;
    });
  }
  return { byHash, byIndex };
}

/**
 * Records a resolved identity so the vault can re-derive the workspace key
 * later and the index fallback stays sticky. Best-effort: failures never
 * break account resolution.
 */
export async function rememberAccountIdentity(
  rawIdentifier: string,
  accountHash: string,
  accountIndex?: string
): Promise<void> {
  memoryByHash.set(accountHash, rawIdentifier);
  try {
    const result = await storageLocalGet<Record<string, unknown>>([IDENTITY_REGISTRY_KEY]);
    const registry = asRegistry(result[IDENTITY_REGISTRY_KEY]);
    registry.byHash[accountHash] = rawIdentifier;
    if (accountIndex !== undefined) {
      registry.byIndex[accountIndex] = rawIdentifier;
    }
    await storageLocalSet({ [IDENTITY_REGISTRY_KEY]: registry });
  } catch (error) {
    console.warn('[gemini-projects] identity registry write failed', error);
  }
}

/**
 * Resolves the raw identifier that owns a workspace partition hash. Returns
 * null when the identity is unknown in this context — the caller must then
 * treat the partition as locked rather than fabricating a new one.
 */
export async function getRawIdentifierForHash(accountHash: string): Promise<string | null> {
  const memory = memoryByHash.get(accountHash);
  if (memory) return memory;

  try {
    const result = await storageLocalGet<Record<string, unknown>>([IDENTITY_REGISTRY_KEY]);
    const registry = asRegistry(result[IDENTITY_REGISTRY_KEY]);
    const registered = registry.byHash[accountHash];
    if (registered) {
      memoryByHash.set(accountHash, registered);
      return registered;
    }
  } catch (error) {
    console.warn('[gemini-projects] identity registry read failed', error);
  }

  // Last resort: resolve from the live DOM and accept only when the derived
  // hash matches the requested partition exactly.
  const domIdentifier = resolveAccountRawIdentifier();
  const domHash = await getAccountIdHash(domIdentifier);
  if (domHash === accountHash) {
    void rememberAccountIdentity(domIdentifier, accountHash, getAccountIndex());
    return domIdentifier;
  }
  return null;
}

export function getAccountIndex(): string {
  if (typeof window === 'undefined' || !window.location) return '0';
  const match = window.location.pathname.match(ACCOUNT_INDEX_PATTERN);
  return match?.[1] ?? '0';
}

/**
 * Re-applies the `/u/<index>/` account scope of the page that is currently
 * rendering to an extension-generated navigation target.
 *
 * Gemini serves every signed-in Google account under a `/u/<index>/` URL
 * prefix. A URL without the prefix is resolved by Google to the browser's
 * *default* account, so hard-navigating to one (e.g. `window.location.assign`
 * on a new-chat target) performs a full page reload and silently switches the
 * active Google account. Gemini's own links avoid this via SPA navigation;
 * any URL the extension assigns or renders as an href must carry the prefix
 * of the account the user is currently working in.
 */
export function withActiveAccountScope(href: string): string {
  if (typeof window === 'undefined' || !window.location) return href;
  const prefix = window.location.pathname.match(ACCOUNT_INDEX_PATTERN)?.[0];
  if (!prefix) return href;

  if (/^https?:\/\//i.test(href)) {
    // Absolute URL: only augment same-origin targets that lack a prefix.
    try {
      const url = new URL(href);
      if (url.origin !== window.location.origin) return href;
      if (ACCOUNT_INDEX_PATTERN.test(url.pathname)) return href;
      url.pathname = `${prefix}${url.pathname}`;
      return url.href;
    } catch {
      return href;
    }
  }

  if (href.startsWith(prefix) || ACCOUNT_INDEX_PATTERN.test(href)) return href;
  return `${prefix}${href.startsWith('/') ? '' : '/'}${href}`;
}

function extractEmailFromText(text: string): string | null {
  if (!text) return null;
  const match = text.match(EMAIL_PATTERN);
  return match?.[0] ?? null;
}

function extractEmailFromAttributes(node: Element): string | null {
  const attributes = ['aria-label', 'alt', 'title', 'data-ogsr-email', 'data-identity-email'];
  for (const attribute of attributes) {
    const email = extractEmailFromText(node.getAttribute(attribute) || '');
    if (email) return email;
  }
  return null;
}

export function resolveAccountRawIdentifierCandidates(): string[] {
  const candidates: string[] = [];
  if (typeof document === 'undefined') return candidates;

  for (const selector of [...PROFILE_BADGE_SELECTORS, ...EXTENDED_IDENTITY_SELECTORS]) {
    let nodes: NodeListOf<Element>;
    try {
      nodes = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const node of Array.from(nodes)) {
      const email = extractEmailFromAttributes(node);
      if (email && !candidates.includes(email)) candidates.push(email);
    }
  }
  return candidates;
}

export function resolveAccountRawIdentifier(): string {
  const candidates = resolveAccountRawIdentifierCandidates();
  if (candidates.length > 0) return candidates[0];
  return `account_index_${getAccountIndex()}`;
}

/** Reads the sticky identity recorded for a /u/<index>/ URL scope, if any. */
async function readStickyIdentity(accountIndex: string): Promise<string | null> {
  try {
    const result = await storageLocalGet<Record<string, unknown>>([IDENTITY_REGISTRY_KEY]);
    const registry = asRegistry(result[IDENTITY_REGISTRY_KEY]);
    const sticky = registry.byIndex[accountIndex];
    if (sticky && !sticky.startsWith('account_index_')) return sticky;
  } catch (error) {
    console.warn('[gemini-projects] sticky identity lookup failed', error);
  }
  return null;
}

/**
 * Resolves the raw identifier with the sticky index map: when the profile
 * badge cannot be read right now, the last email observed at this URL index
 * is reused so the account keeps the same workspace partition.
 *
 * With several Google accounts signed in, the header and account switcher can
 * expose more than one email at once; first-match DOM order is NOT guaranteed
 * to reflect the active account. When the scan is ambiguous, the identity
 * already confirmed for this /u/<index>/ scope wins over an arbitrary first
 * candidate, so a background account's email can never silently hijack the
 * active account's workspace partition.
 */
export async function resolveStableAccountRawIdentifier(): Promise<string> {
  const accountIndex = getAccountIndex();
  const candidates = resolveAccountRawIdentifierCandidates();

  if (candidates.length > 0) {
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const sticky = await readStickyIdentity(accountIndex);
      if (sticky) {
        chosen = sticky;
        console.info(
          `[gemini-projects] ambiguous identity scan; using sticky identity for /u/${accountIndex}`,
          JSON.stringify({ candidates, chosen })
        );
      } else {
        console.info(
          '[gemini-projects] ambiguous identity scan without a sticky identity; using first candidate',
          JSON.stringify({ candidates, chosen })
        );
      }
    }
    void rememberAccountIdentity(chosen, await getAccountIdHash(chosen), accountIndex);
    return chosen;
  }

  const sticky = await readStickyIdentity(accountIndex);
  if (sticky) {
    console.info('[gemini-projects] using sticky identity for account index', accountIndex);
    void rememberAccountIdentity(sticky, await getAccountIdHash(sticky), accountIndex);
    return sticky;
  }

  return `account_index_${accountIndex}`;
}

export interface AccountIdentityDebugInfo {
  accountIndex: string;
  /** All distinct emails the current DOM exposes, in scan order. */
  candidates: string[];
  resolvedRawIdentifier: string;
  accountHash: string;
  registry: AccountIdentityRegistry;
}

/** Diagnostic snapshot for comparing identity resolution across windows/devices. */
export async function debugAccountIdentity(): Promise<AccountIdentityDebugInfo> {
  const accountIndex = getAccountIndex();
  const candidates = resolveAccountRawIdentifierCandidates();
  const resolvedRawIdentifier = await resolveStableAccountRawIdentifier();
  const accountHash = await getAccountIdHash(resolvedRawIdentifier);
  let registry = emptyRegistry();
  try {
    const result = await storageLocalGet<Record<string, unknown>>([IDENTITY_REGISTRY_KEY]);
    registry = asRegistry(result[IDENTITY_REGISTRY_KEY]);
  } catch {
    // Registry unreadable: report the empty shape, resolution still worked.
  }
  return { accountIndex, candidates, resolvedRawIdentifier, accountHash, registry };
}

/**
 * Clears the sticky per-index identity map so identity is re-resolved from the
 * page. `byHash` is deliberately kept: it is required to decrypt existing
 * local vault partitions and deleting it would lock the user out of data.
 */
export async function resetStickyAccountIdentities(): Promise<void> {
  try {
    const result = await storageLocalGet<Record<string, unknown>>([IDENTITY_REGISTRY_KEY]);
    const registry = asRegistry(result[IDENTITY_REGISTRY_KEY]);
    registry.byIndex = {};
    await storageLocalSet({ [IDENTITY_REGISTRY_KEY]: registry });
    console.info('[gemini-projects] sticky per-index identities cleared; identity will be re-resolved from the page');
  } catch (error) {
    console.warn('[gemini-projects] sticky identity reset failed', error);
  }
}

export async function getAccountIdHash(rawIdentifier: string): Promise<string> {
  const normalized = rawIdentifier.toLowerCase().trim();
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function resolveAccountHash(): Promise<string> {
  return getAccountIdHash(resolveAccountRawIdentifier());
}

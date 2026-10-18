const ACCOUNT_INDEX_PATTERN = /\/u\/(\d+)/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const PROFILE_BADGE_SELECTORS = [
  'a[aria-label*="@"]',
  'button[aria-label*="@"]',
  'img[alt*="@"]'
] as const;

export function getAccountIndex(): string {
  if (typeof window === 'undefined' || !window.location) return '0';
  const match = window.location.pathname.match(ACCOUNT_INDEX_PATTERN);
  return match?.[1] ?? '0';
}

function extractEmailFromText(text: string): string | null {
  if (!text) return null;
  const match = text.match(EMAIL_PATTERN);
  return match?.[0] ?? null;
}

export function resolveAccountRawIdentifier(): string {
  const accountIndex = getAccountIndex();

  if (typeof document !== 'undefined') {
    for (const selector of PROFILE_BADGE_SELECTORS) {
      const nodes = document.querySelectorAll<HTMLElement>(selector);
      for (const node of nodes) {
        const label = node.getAttribute('aria-label') || node.getAttribute('alt') || '';
        const email = extractEmailFromText(label);
        if (email) return email;
      }
    }
  }

  return `account_index_${accountIndex}`;
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
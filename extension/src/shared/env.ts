/**
 * Mobile environment detection for touch-first browsers.
 *
 * Detects Android/Chromium forks with extension support (Kiwi, Lemur, Mises,
 * Edge Canary, ...), Firefox for Android, and tablets. Desktop browsers never
 * match — a touch-screen desktop or a narrow desktop window must not flip the
 * UI into mobile mode ("everything stays the same on desktop").
 */

/** Viewport width cap used together with touch/UA signals. */
const MOBILE_MAX_LAYOUT_WIDTH = 720;

function matchesMedia(query: string): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches
    );
  } catch {
    return false;
  }
}

/** Primary input is coarse/finger-driven (also true on touch-only phones). */
function hasCoarsePointer(): boolean {
  return matchesMedia('(pointer: coarse)') || matchesMedia('(hover: none)');
}

/** UA-based mobile probe: Android, iOS, Mobi hints (Firefox Android included). */
function uaReportsMobile(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.userAgent !== 'string') return false;
  const ua = navigator.userAgent;
  return /\b(Android|iPhone|iPad|iPod|Mobile|Tablet)\b/i.test(ua) || /\bMobi\b/.test(ua);
}

/** Narrow layout viewport (phone-sized CSS pixels). */
export function isMobileLayout(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth > 0 && window.innerWidth <= MOBILE_MAX_LAYOUT_WIDTH;
}

/** Any touch hardware present in this browser session. */
export function hasTouchInput(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (navigator.maxTouchPoints ?? 0) > 0;
}

/**
 * True on genuine touch-first mobile devices. Requires touch hardware plus
 * either a mobile UA or a coarse pointer in a narrow viewport, so desktop
 * environments (even with a touchscreen) are never misclassified.
 */
export function isMobileEnvironment(): boolean {
  const coarse = hasCoarsePointer();
  const uaMobile = uaReportsMobile();
  if (uaMobile && coarse) return true;
  if (coarse && hasTouchInput() && isMobileLayout()) return true;
  return false;
}
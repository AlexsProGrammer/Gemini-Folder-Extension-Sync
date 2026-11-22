export const SPA_NAVIGATION_EVENT = 'gp-spa-navigation';

/**
 * Subscribes to MAIN-world SPA route transitions (dispatched by `pageBridge.js`
 * on `history.pushState`/`replaceState`) as well as `popstate` and `hashchange`.
 * Returns an unsubscribe function.
 */
export function onSpaNavigation(callback: (href: string) => void): () => void {
  const handleSpaEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ href?: string }>).detail;
    callback(detail?.href || window.location.href);
  };
  const handleWindowNav = () => {
    callback(window.location.href);
  };

  window.addEventListener(SPA_NAVIGATION_EVENT, handleSpaEvent);
  window.addEventListener('popstate', handleWindowNav);
  window.addEventListener('hashchange', handleWindowNav);

  return () => {
    window.removeEventListener(SPA_NAVIGATION_EVENT, handleSpaEvent);
    window.removeEventListener('popstate', handleWindowNav);
    window.removeEventListener('hashchange', handleWindowNav);
  };
}

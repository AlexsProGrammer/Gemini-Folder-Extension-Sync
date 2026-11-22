(() => {
  const SPA_EVENT = 'gp-spa-navigation';
  if (window.__gpSpaNavigationBridge) {
    return;
  }
  window.__gpSpaNavigationBridge = true;

  let lastHref = window.location.href;
  const notifyIfChanged = () => {
    const nextHref = window.location.href;
    if (nextHref === lastHref) return;
    lastHref = nextHref;
    window.dispatchEvent(new CustomEvent(SPA_EVENT, { detail: { href: nextHref } }));
  };

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function wrappedHistoryState(...args) {
      const result = original.apply(this, args);
      notifyIfChanged();
      return result;
    };
  }

  const syncLastHref = () => {
    lastHref = window.location.href;
  };
  window.addEventListener('popstate', syncLastHref);
  window.addEventListener('hashchange', syncLastHref);
})();

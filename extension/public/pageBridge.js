(() => {
  const REQUEST_EVENT = 'gp-sidebar-inspection-request';
  const RESPONSE_EVENT = 'gp-sidebar-inspection-response';

  if (window.__gpInspectSidebar && window.__gpInspectSidebar.__gpPageBridge) {
    return;
  }

  window.__gpLastSidebarInspection = null;
  window.__gpInspectSidebar = function __gpInspectSidebar() {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        document.removeEventListener(RESPONSE_EVENT, onResponse);
        reject(new Error('Gemini Projects inspector did not respond. Reload the extension and page.'));
      }, 3000);

      function onResponse(event) {
        const detail = event.detail || {};
        if (detail.requestId !== requestId) return;
        window.clearTimeout(timeout);
        document.removeEventListener(RESPONSE_EVENT, onResponse);
        try {
          const report = JSON.parse(detail.json);
          window.__gpLastSidebarInspection = report;
          resolve(report);
        } catch (error) {
          reject(error);
        }
      }

      document.addEventListener(RESPONSE_EVENT, onResponse);
      document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: { requestId } }));
    });
  };
  window.__gpInspectSidebar.__gpPageBridge = true;
})();

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

import { errorMessage, permissionsContains } from './shared/webext';

type PermissionsRequestFn = (perms: { origins: string[] }) => Promise<boolean> | void;

const globalApi = globalThis as typeof globalThis & {
  browser?: { permissions?: { request?: PermissionsRequestFn }; runtime?: { lastError?: { message?: string } } };
  chrome?: { permissions?: { request?: PermissionsRequestFn }; runtime?: { lastError?: { message?: string } } };
};

function parseTargetOrigin(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('origin');
    if (!raw) return null;
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Calls `permissions.request` synchronously inside the user-gesture handler
 * without any intervening `await`, preserving user activation in both
 * Firefox and Chrome MV3.
 */
function requestOriginPermissionSync(originPattern: string): Promise<boolean> {
  const api = globalApi.browser ?? globalApi.chrome;
  const permissions = api?.permissions;
  if (!permissions || typeof permissions.request !== 'function') {
    return Promise.reject(new Error('Permissions API is not available in this context.'));
  }

  try {
    const maybePromise = permissions.request({ origins: [originPattern] });
    if (maybePromise && typeof (maybePromise as Promise<boolean>).then === 'function') {
      return maybePromise as Promise<boolean>;
    }
  } catch {
    // Fall through to callback form for Chrome MV3 if needed.
  }

  return new Promise<boolean>((resolve, reject) => {
    const fn = permissions.request as unknown as (
      perms: { origins: string[] },
      cb: (granted: boolean) => void
    ) => void;
    fn({ origins: [originPattern] }, (granted: boolean) => {
      const runtimeError = globalApi.chrome?.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'Permission request failed.'));
        return;
      }
      resolve(Boolean(granted));
    });
  });
}

function init(): void {
  const originEl = document.getElementById('gp-origin');
  const grantBtn = document.getElementById('gp-grant-btn') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('gp-close-btn') as HTMLButtonElement | null;
  const statusEl = document.getElementById('gp-status');

  const setStatus = (message: string, tone: 'ok' | 'error' | ''): void => {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = tone ? `status ${tone}` : 'status';
  };

  closeBtn?.addEventListener('click', () => {
    window.close();
  });

  const origin = parseTargetOrigin();
  if (!origin || !originEl || !grantBtn) {
    if (originEl) originEl.textContent = 'Invalid or missing server origin.';
    setStatus('Open this page from the Sync Settings modal in Gemini.', 'error');
    return;
  }

  const originPattern = `${origin}/*`;
  originEl.textContent = originPattern;
  grantBtn.disabled = false;

  void permissionsContains([originPattern])
    .then((alreadyGranted) => {
      if (alreadyGranted) {
        grantBtn.disabled = true;
        setStatus('Permission is already granted. You can close this window and return to Gemini.', 'ok');
      }
    })
    .catch(() => undefined);

  grantBtn.addEventListener('click', () => {
    setStatus('', '');
    // Synchronous call first — no `await` before `permissions.request()`.
    const requestPromise = requestOriginPermissionSync(originPattern);
    grantBtn.disabled = true;

    void requestPromise
      .then((granted) => {
        if (granted) {
          setStatus('Permission granted! Closing this window…', 'ok');
          setTimeout(() => window.close(), 900);
        } else {
          grantBtn.disabled = false;
          setStatus('Permission was not granted. Click Grant Permission to try again.', 'error');
        }
      })
      .catch((error) => {
        grantBtn.disabled = false;
        setStatus(`Permission request failed: ${errorMessage(error)}`, 'error');
      });
  });
}

init();

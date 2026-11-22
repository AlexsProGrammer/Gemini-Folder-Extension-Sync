import type {
  EncryptedSyncEnvelope,
  RemoteSyncBlob,
  SyncApiResponse,
  SyncCheckPermissionMessage,
  SyncMessage,
  SyncOpenPermissionPageMessage,
  SyncOpenPermissionPageResult,
  SyncPermissionResult,
  SyncPullMessage,
  SyncPushMessage
} from './shared/types';
import { RemoteSyncBlobSchema, SyncConfirmationSchema } from './shared/schemas';
import { errorMessage, errorName, webext } from './shared/webext';

/**
 * The background service worker owns only privileged cross-origin network
 * access for the sync protocol. All workspace state lives in the
 * account-partitioned, locally encrypted vault (`workspace_${accountHash}`)
 * and is mutated directly by the content script that resolved the active
 * account — the browser-global legacy state was removed so data can never
 * leak across Google accounts.
 */

/* ------------------------------------------------------------------ *
 * Background CORS proxy: content scripts on gemini.google.com cannot
 * dispatch cross-origin requests to the user's self-hosted VPS, so all
 * sync HTTP traffic is proxied through this privileged context.
 * ------------------------------------------------------------------ */

const SYNC_FETCH_TIMEOUT_MS = 10_000;
const PULL_RETRY_DELAYS_MS = [400, 1200] as const;
const RETRYABLE_PULL_STATUSES = new Set([502, 503, 504]);
const ACCOUNT_ID_RE = /^[0-9a-f]{64}$/;

type SyncHandlerResponse = SyncApiResponse<unknown>;
type SyncHandlerFailure = Extract<SyncHandlerResponse, { success: false }>;

function isSyncMessage(message: unknown): message is SyncPullMessage | SyncPushMessage {
  if (!message || typeof message !== 'object') return false;
  const action = (message as { action?: unknown }).action;
  return action === 'SYNC_PULL' || action === 'SYNC_PUSH';
}

function isCheckPermissionMessage(message: unknown): message is SyncCheckPermissionMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_CHECK_PERMISSION';
}

function isOpenPermissionPageMessage(message: unknown): message is SyncOpenPermissionPageMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_OPEN_PERMISSION_PAGE';
}

function getExtensionOrigin(): string | null {
  try {
    const url = webext.runtime?.getURL?.('');
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

function isAuthorizedSender(sender: chrome.runtime.MessageSender): boolean {
  const ownId = webext.runtime?.id;
  if (!ownId || sender.id !== ownId) {
    return false;
  }
  if (!sender.url) {
    return true;
  }
  if (sender.url.startsWith('https://gemini.google.com/')) {
    return true;
  }
  const extOrigin = getExtensionOrigin();
  if (extOrigin && sender.url.startsWith(`${extOrigin}/`)) {
    return true;
  }
  return false;
}

function parseHttpOrigin(serverUrl: string): string | null {
  try {
    const parsed = new URL(serverUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function validateSyncEndpoint(serverUrl: string, accountId: string): { origin: string; endpoint: string } | null {
  if (!ACCOUNT_ID_RE.test(accountId)) {
    return null;
  }
  const origin = parseHttpOrigin(serverUrl);
  if (!origin) {
    return null;
  }
  const normalizedBase = serverUrl.trim().replace(/\/+$/, '');
  return {
    origin,
    endpoint: `${normalizedBase}/api/v1/sync/${accountId}`
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

function mapHttpErrorResponse(response: Response): SyncHandlerResponse {
  const status = response.status;
  if (status === 401) {
    return { success: false, error: 'unauthorized', status, message: 'Invalid API key (401).' };
  }
  if (status === 403) {
    return { success: false, error: 'forbidden', status, message: 'API key is not authorized for this account (403).' };
  }
  if (status === 404) {
    return { success: false, error: 'not_found', status, message: 'No sync data found on server (404).' };
  }
  if (status === 413) {
    return { success: false, error: 'payload_too_large', status, message: 'Sync payload exceeds server size limit (413).' };
  }
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers?.get('Retry-After') ?? null);
    const suffix = retryAfterSeconds !== undefined ? ` Retry after ${retryAfterSeconds}s.` : '';
    return {
      success: false,
      error: 'rate_limited',
      status,
      message: `Rate limited by sync server (429).${suffix}`,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {})
    };
  }
  if (status >= 500 && status < 600) {
    return { success: false, error: 'server_error', status, message: `Sync server error (${status}).` };
  }
  return { success: false, error: 'network_error', status, message: `Unexpected HTTP status (${status}).` };
}

async function hasHostPermission(origin: string): Promise<boolean> {
  const api = await webextPermissions();
  if (!api) return true;
  try {
    return Boolean(await api.permissions.contains({ origins: [`${origin}/*`] }));
  } catch {
    return false;
  }
}

function permissionDeniedResponse(): SyncHandlerFailure {
  return {
    success: false,
    error: 'permission_denied',
    message: 'Host permission for sync server is not granted.'
  };
}

async function mapFetchException(error: unknown, origin: string): Promise<SyncHandlerFailure> {
  if (errorName(error) === 'AbortError') {
    return {
      success: false,
      error: 'timeout',
      message: 'Sync server request timed out.'
    };
  }
  if (errorName(error) === 'TypeError' && !(await hasHostPermission(origin))) {
    return permissionDeniedResponse();
  }
  return {
    success: false,
    error: 'network_error',
    message: errorMessage(error)
  };
}

async function handleSyncPull(
  accountId: string,
  serverUrl: string,
  apiKey: string
): Promise<SyncHandlerResponse> {
  const target = validateSyncEndpoint(serverUrl, accountId);
  if (!target) {
    return { success: false, error: 'network_error', message: 'Invalid sync endpoint parameters.' };
  }
  if (!(await hasHostPermission(target.origin))) {
    return permissionDeniedResponse();
  }

  for (let attempt = 0; attempt <= PULL_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetchWithTimeout(target.endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (response.status === 200) {
        const body = await parseJsonResponse(response);
        const parsed = RemoteSyncBlobSchema.safeParse(body);
        if (!parsed.success) {
          return { success: false, error: 'network_error', status: 200, message: 'Malformed sync blob.' };
        }
        return { success: true, data: parsed.data as RemoteSyncBlob };
      }

      if (RETRYABLE_PULL_STATUSES.has(response.status) && attempt < PULL_RETRY_DELAYS_MS.length) {
        await delay(PULL_RETRY_DELAYS_MS[attempt]);
        continue;
      }

      return mapHttpErrorResponse(response);
    } catch (error) {
      const failure = await mapFetchException(error, target.origin);
      if (failure.error === 'permission_denied' || attempt >= PULL_RETRY_DELAYS_MS.length) {
        return failure;
      }
      await delay(PULL_RETRY_DELAYS_MS[attempt]);
    }
  }

  return { success: false, error: 'network_error', message: 'Sync pull failed.' };
}

async function handleSyncPush(message: SyncPushMessage): Promise<SyncHandlerResponse> {
  const { accountId, serverUrl, apiKey, data } = message;
  const target = validateSyncEndpoint(serverUrl, accountId);
  if (!target) {
    return { success: false, error: 'network_error', message: 'Invalid sync endpoint parameters.' };
  }
  if (!(await hasHostPermission(target.origin))) {
    return permissionDeniedResponse();
  }

  try {
    const response = await fetchWithTimeout(target.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data satisfies EncryptedSyncEnvelope)
    });

    if (response.status === 200 || response.status === 201) {
      const body = await parseJsonResponse(response);
      const parsed = SyncConfirmationSchema.safeParse(body);
      if (parsed.success) {
        return { success: true, data: { version: parsed.data.version } };
      }
      return { success: true, data: { version: data.version } };
    }
    if (response.status === 409) {
      const body = await parseJsonResponse(response);
      const serverState = (body as { serverState?: unknown } | null)?.serverState;
      const parsedServerState = RemoteSyncBlobSchema.safeParse(serverState);
      return {
        success: false,
        error: 'conflict',
        status: 409,
        message: 'Sync conflict detected (409).',
        ...(parsedServerState.success ? { serverState: parsedServerState.data as RemoteSyncBlob } : {})
      };
    }
    return mapHttpErrorResponse(response);
  } catch (error) {
    return mapFetchException(error, target.origin);
  }
}

function handleSyncMessage(message: SyncPullMessage | SyncPushMessage): Promise<SyncHandlerResponse> {
  if (message.action === 'SYNC_PULL') {
    return handleSyncPull(message.accountId, message.serverUrl, message.apiKey);
  }
  return handleSyncPush(message);
}

async function handleCheckPermission(message: SyncCheckPermissionMessage): Promise<SyncPermissionResult> {
  const origin = parseHttpOrigin(message.origin);
  if (!origin) {
    return { granted: false, error: 'Invalid server URL.' };
  }
  const origins = [`${origin}/*`];
  const api = await webextPermissions();
  if (!api) {
    return { granted: false, error: 'Permissions API unavailable.' };
  }
  try {
    const granted = Boolean(await api.permissions.contains({ origins }));
    return granted ? { granted: true, requested: false } : { granted: false, requested: false };
  } catch (error) {
    return { granted: false, error: errorMessage(error) };
  }
}

async function handleOpenPermissionPage(
  message: SyncOpenPermissionPageMessage
): Promise<SyncOpenPermissionPageResult> {
  const origin = parseHttpOrigin(message.origin);
  if (!origin) {
    return { opened: false, error: 'Invalid server URL.' };
  }
  const getUrl = webext.runtime?.getURL;
  if (typeof getUrl !== 'function') {
    return { opened: false, error: 'runtime.getURL is unavailable.' };
  }
  const pageUrl = getUrl(`grant-permission.html?origin=${encodeURIComponent(origin)}`);

  try {
    if (typeof webext.windows?.create === 'function') {
      await webext.windows.create({
        url: pageUrl,
        type: 'popup',
        width: 480,
        height: 360
      });
      return { opened: true };
    }
  } catch {
    // Fall back to opening a regular tab if popup creation is blocked.
  }

  try {
    if (typeof webext.tabs?.create === 'function') {
      await webext.tabs.create({ url: pageUrl });
      return { opened: true };
    }
  } catch (error) {
    return { opened: false, error: errorMessage(error) };
  }

  return { opened: false, error: 'Unable to open permission page.' };
}

/** Resolves browser.permissions from the global API, or null. */
async function webextPermissions(): Promise<{
  permissions: {
    contains: (p: { origins: string[] }) => Promise<boolean>;
    request: (p: { origins: string[] }) => Promise<boolean>;
  };
} | null> {
  const api = (globalThis as { browser?: { permissions?: unknown }; chrome?: { permissions?: unknown } }).browser
    ?? (globalThis as { chrome?: { permissions?: unknown } }).chrome;
  const permissions = api?.permissions;
  if (permissions && typeof (permissions as { contains?: unknown }).contains === 'function'
    && typeof (permissions as { request?: unknown }).request === 'function') {
    return {
      permissions: permissions as {
        contains: (p: { origins: string[] }) => Promise<boolean>;
        request: (p: { origins: string[] }) => Promise<boolean>;
      }
    };
  }
  return null;
}

webext.runtime.onMessage.addListener((
  message: SyncMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (
    response: SyncApiResponse<unknown> | SyncPermissionResult | SyncOpenPermissionPageResult
  ) => void
) => {
  if (!isAuthorizedSender(sender)) {
    sendResponse({ success: false, error: 'forbidden', message: 'Unauthorized message sender.' });
    return false;
  }

  if (isCheckPermissionMessage(message)) {
    handleCheckPermission(message)
      .then((result) => sendResponse(result))
      .catch((error: Error) => sendResponse({ granted: false, error: error.message }));
    return true;
  }

  if (isOpenPermissionPageMessage(message)) {
    handleOpenPermissionPage(message)
      .then((result) => sendResponse(result))
      .catch((error: Error) => sendResponse({ opened: false, error: error.message }));
    return true;
  }

  if (!isSyncMessage(message)) return false;

  handleSyncMessage(message)
    .then((response) => sendResponse(response))
    .catch((error: Error) => sendResponse({
      success: false,
      error: 'network_error',
      message: error.message
    }));
  return true;
});

import type {
  EncryptedSyncEnvelope,
  RemoteSyncBlob,
  SessionPassphrasePayload,
  SyncApiResponse,
  SyncCancelPushMessage,
  SyncCheckPermissionMessage,
  SyncEnqueuePushMessage,
  SyncFlushPushMessage,
  SyncMessage,
  SyncOpenPermissionPageMessage,
  SyncOpenPermissionPageResult,
  SyncPermissionResult,
  SyncPullMessage,
  SyncPushMessage,
  SyncSessionClearMessage,
  SyncSessionGetMessage,
  SyncSessionGetResult,
  SyncSessionSetMessage,
  SyncSessionWriteResult
} from './shared/types';
import { RemoteSyncBlobSchema, SyncConfirmationSchema } from './shared/schemas';
import {
  errorMessage,
  errorName,
  storageLocalGet,
  storageLocalRemove,
  storageLocalSet,
  storageSessionGet,
  storageSessionRemove,
  storageSessionSet,
  webext
} from './shared/webext';

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
const SYNC_SESSION_PASSPHRASE_KEY = 'gemini_sync_session_passphrases';
const SYNC_SETTINGS_KEY = 'gemini_sync_settings';
const PENDING_PUSH_KEY_PREFIX = 'gp_pending_push_';
const DEFAULT_PUSH_DEBOUNCE_MS = 750;
const MAX_ENQUEUE_DELAY_MS = 5000;
const MAX_PASSPHRASE_LENGTH = 4096;
const MAX_PASSPHRASE_ACCOUNTS = 64;

/**
 * Fallback used only when `storage.session` is unavailable in the background
 * context; primary persistence is `storage.session` so passphrases survive
 * MV3 service worker sleep/wake cycles.
 */
let fallbackSessionPassphrases: SessionPassphrasePayload | null = null;

type SyncHandlerResponse = SyncApiResponse<unknown>;
type SyncHandlerFailure = Extract<SyncHandlerResponse, { success: false }>;

function isSyncMessage(message: unknown): message is SyncPullMessage | SyncPushMessage {
  if (!message || typeof message !== 'object') return false;
  const action = (message as { action?: unknown }).action;
  return action === 'SYNC_PULL' || action === 'SYNC_PUSH';
}

function isEnqueuePushMessage(message: unknown): message is SyncEnqueuePushMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_ENQUEUE_PUSH';
}

function isFlushPushMessage(message: unknown): message is SyncFlushPushMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_FLUSH_PUSH';
}

function isCancelPushMessage(message: unknown): message is SyncCancelPushMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_CANCEL_PUSH';
}

function isCheckPermissionMessage(message: unknown): message is SyncCheckPermissionMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_CHECK_PERMISSION';
}

function isOpenPermissionPageMessage(message: unknown): message is SyncOpenPermissionPageMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_OPEN_PERMISSION_PAGE';
}

function isSessionGetMessage(message: unknown): message is SyncSessionGetMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_SESSION_GET';
}

function isSessionSetMessage(message: unknown): message is SyncSessionSetMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_SESSION_SET';
}

function isSessionClearMessage(message: unknown): message is SyncSessionClearMessage {
  if (!message || typeof message !== 'object') return false;
  return (message as { action?: unknown }).action === 'SYNC_SESSION_CLEAR';
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
  apiKey: string,
  ifNoneMatch?: string
): Promise<SyncHandlerResponse> {
  const target = validateSyncEndpoint(serverUrl, accountId);
  if (!target) {
    return { success: false, error: 'network_error', message: 'Invalid sync endpoint parameters.' };
  }
  if (!(await hasHostPermission(target.origin))) {
    return permissionDeniedResponse();
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`
  };
  if (ifNoneMatch) {
    headers['If-None-Match'] = ifNoneMatch;
  }

  for (let attempt = 0; attempt <= PULL_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetchWithTimeout(target.endpoint, {
        method: 'GET',
        headers
      });

      if (response.status === 304) {
        const etag = response.headers?.get('ETag') ?? ifNoneMatch;
        return { success: true, notModified: true, ...(etag ? { etag } : {}) };
      }

      if (response.status === 200) {
        const body = await parseJsonResponse(response);
        const parsed = RemoteSyncBlobSchema.safeParse(body);
        if (!parsed.success) {
          return { success: false, error: 'network_error', status: 200, message: 'Malformed sync blob.' };
        }
        const etag = response.headers?.get('ETag') ?? undefined;
        return { success: true, data: parsed.data as RemoteSyncBlob, ...(etag ? { etag } : {}) };
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

const syncMetaWriteQueues = new Map<string, Promise<void>>();

function persistPushSyncMeta(
  accountId: string,
  pushedVersion: number,
  etag?: string
): Promise<void> {
  const prev = syncMetaWriteQueues.get(accountId) ?? Promise.resolve();
  const next = prev
    .then(() => runPersistPushSyncMeta(accountId, pushedVersion, etag))
    .catch(() => undefined);
  syncMetaWriteQueues.set(accountId, next);
  return next;
}

async function runPersistPushSyncMeta(
  accountId: string,
  pushedVersion: number,
  etag?: string
): Promise<void> {
  const key = `sync_meta_${accountId}`;
  try {
    const result = await storageLocalGet<Record<string, unknown>>([key]);
    const raw = result[key];
    const existing = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const prevLastSynced =
      typeof existing.lastSyncedVersion === 'number' && Number.isFinite(existing.lastSyncedVersion)
        ? existing.lastSyncedVersion
        : 0;
    const localVersion =
      typeof existing.localVersion === 'number' && Number.isFinite(existing.localVersion)
        ? existing.localVersion
        : undefined;
    const nextLastSynced = Math.max(prevLastSynced, pushedVersion);
    const nextLocalVersion = localVersion !== undefined ? Math.max(localVersion, pushedVersion) : undefined;
    const stillDirty = localVersion !== undefined ? localVersion > pushedVersion : existing.dirty === true;
    const nextEtag = etag ?? (!stillDirty && typeof existing.etag === 'string' && existing.etag ? existing.etag : undefined);
    await storageLocalSet({
      [key]: {
        lastSyncedVersion: nextLastSynced,
        dirty: stillDirty,
        ...(nextLocalVersion !== undefined ? { localVersion: nextLocalVersion } : {}),
        ...(nextEtag ? { etag: nextEtag } : {})
      }
    });
  } catch (error) {
    console.warn('[gemini-projects] background sync_meta update failed', error);
  }
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

  for (let attempt = 0; attempt <= PULL_RETRY_DELAYS_MS.length; attempt++) {
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
        const pushedVersion = parsed.success ? parsed.data.version : data.version;
        const etag = response.headers?.get('ETag') ?? undefined;
        await persistPushSyncMeta(accountId, pushedVersion, etag);
        return {
          success: true,
          data: { version: pushedVersion },
          ...(etag ? { etag } : {})
        };
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

  return { success: false, error: 'network_error', message: 'Sync push failed.' };
}

function handleSyncMessage(message: SyncPullMessage | SyncPushMessage): Promise<SyncHandlerResponse> {
  if (message.action === 'SYNC_PULL') {
    return handleSyncPull(message.accountId, message.serverUrl, message.apiKey, message.ifNoneMatch);
  }
  return handleSerializedDirectPush(message);
}

interface PendingPushEntry {
  message: SyncPushMessage;
  timer: ReturnType<typeof setTimeout> | null;
  resolvers: Array<(res: SyncHandlerResponse) => void>;
}

const pendingPushes = new Map<string, PendingPushEntry>();
const inFlightAccountPushes = new Map<string, Promise<void>>();
const inFlightPushVersions = new Map<string, number>();
const lastCommittedPush = new Map<string, { version: number; baseVersion?: number }>();
const pendingPushStorageQueues = new Map<string, Promise<void>>();

function serializePendingPushStorage(accountId: string, op: () => Promise<void>): Promise<void> {
  const prev = pendingPushStorageQueues.get(accountId) ?? Promise.resolve();
  const next = prev.then(op, op).catch(() => undefined);
  pendingPushStorageQueues.set(accountId, next);
  void next.finally(() => {
    if (pendingPushStorageQueues.get(accountId) === next) {
      pendingPushStorageQueues.delete(accountId);
    }
  });
  return next;
}

function shouldClearPersistedPush(response: SyncHandlerResponse): boolean {
  return (
    response.success ||
    response.error === 'unauthorized' ||
    response.error === 'forbidden' ||
    response.error === 'conflict' ||
    response.error === 'payload_too_large' ||
    response.error === 'permission_denied'
  );
}

/**
 * Advances `baseVersion` only for linear follow-up edits built locally on top
 * of a push committed by this browser's background worker.
 */
function advanceLinearBaseVersion(
  accountId: string,
  envelope: EncryptedSyncEnvelope
): EncryptedSyncEnvelope {
  const lastCommit = lastCommittedPush.get(accountId);
  if (
    lastCommit &&
    envelope.version > lastCommit.version &&
    envelope.baseVersion !== undefined &&
    envelope.baseVersion < lastCommit.version &&
    (lastCommit.baseVersion === undefined || envelope.baseVersion >= lastCommit.baseVersion)
  ) {
    return { ...envelope, baseVersion: lastCommit.version };
  }
  return envelope;
}

function resolveSupersededEntry(entry: PendingPushEntry, version: number): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  for (const resolve of entry.resolvers) {
    try {
      resolve({ success: true, superseded: true, data: { version } });
    } catch {
      // Ignore closed caller
    }
  }
}

function persistPendingPushEntry(accountId: string, entry: PendingPushEntry): void {
  void serializePendingPushStorage(accountId, async () => {
    const current = pendingPushes.get(accountId);
    if (current && current !== entry) return;
    try {
      await storageLocalSet({
        [`${PENDING_PUSH_KEY_PREFIX}${accountId}`]: {
          accountId,
          serverUrl: entry.message.serverUrl,
          data: entry.message.data,
          queuedAt: Date.now()
        }
      });
    } catch (error) {
      console.warn('[gemini-projects] failed to persist pending push', error);
    }
  });
}

function extractPushedVersion(response: SyncHandlerResponse, fallbackVersion: number): number {
  if (
    'data' in response &&
    response.data &&
    typeof (response.data as { version?: unknown }).version === 'number'
  ) {
    return (response.data as { version: number }).version;
  }
  return fallbackVersion;
}

function reconcileCommittedPush(
  accountId: string,
  pushedVersion: number,
  baseVersion: number | undefined
): void {
  lastCommittedPush.set(accountId, { version: pushedVersion, baseVersion });
  const queued = pendingPushes.get(accountId);
  if (!queued) return;
  if (queued.message.data.version <= pushedVersion) {
    pendingPushes.delete(accountId);
    resolveSupersededEntry(queued, pushedVersion);
    return;
  }
  const nextData = advanceLinearBaseVersion(accountId, queued.message.data);
  if (nextData !== queued.message.data) {
    queued.message.data = nextData;
    persistPendingPushEntry(accountId, queued);
  }
}

async function clearPersistedPushIfIdle(accountId: string, response: SyncHandlerResponse): Promise<void> {
  if (!shouldClearPersistedPush(response) || pendingPushes.has(accountId)) {
    return;
  }
  await serializePendingPushStorage(accountId, async () => {
    if (pendingPushes.has(accountId)) return;
    try {
      await storageLocalRemove(`${PENDING_PUSH_KEY_PREFIX}${accountId}`);
    } catch {
      // Best-effort cleanup
    }
  });
}

async function executeTrackedPush(accountId: string, pushMessage: SyncPushMessage): Promise<SyncHandlerResponse> {
  const adjustedData = advanceLinearBaseVersion(accountId, pushMessage.data);
  const effectiveMessage =
    adjustedData === pushMessage.data ? pushMessage : { ...pushMessage, data: adjustedData };

  inFlightPushVersions.set(accountId, effectiveMessage.data.version);
  let response: SyncHandlerResponse;
  try {
    response = await handleSyncPush(effectiveMessage);
  } catch (error) {
    response = {
      success: false,
      error: 'network_error',
      message: errorMessage(error)
    };
  } finally {
    inFlightPushVersions.delete(accountId);
  }

  if (response.success) {
    const pushedVersion = extractPushedVersion(response, effectiveMessage.data.version);
    reconcileCommittedPush(accountId, pushedVersion, effectiveMessage.data.baseVersion);
  }
  await clearPersistedPushIfIdle(accountId, response);
  return response;
}

async function handleSerializedDirectPush(message: SyncPushMessage): Promise<SyncHandlerResponse> {
  const { accountId } = message;
  while (inFlightAccountPushes.has(accountId)) {
    await inFlightAccountPushes.get(accountId);
  }

  const queued = pendingPushes.get(accountId);
  if (queued) {
    if (queued.message.data.version > message.data.version) {
      if (queued.timer !== null) {
        clearTimeout(queued.timer);
        queued.timer = null;
      }
      void drainPendingPush(accountId);
      return { success: true, superseded: true, data: { version: queued.message.data.version } };
    }
    pendingPushes.delete(accountId);
    resolveSupersededEntry(queued, message.data.version);
  }

  let response!: SyncHandlerResponse;
  const task = (async () => {
    response = await executeTrackedPush(accountId, message);
  })().finally(() => {
    inFlightAccountPushes.delete(accountId);
  });

  inFlightAccountPushes.set(accountId, task);
  await task;
  return response;
}

async function drainPendingPush(accountId: string): Promise<void> {
  const existing = inFlightAccountPushes.get(accountId);
  if (existing) {
    await existing;
    const next = pendingPushes.get(accountId);
    if (!next || next.timer !== null) {
      return;
    }
  }
  if (inFlightAccountPushes.has(accountId)) {
    return drainPendingPush(accountId);
  }

  const task = (async () => {
    while (true) {
      const entry = pendingPushes.get(accountId);
      if (!entry || entry.timer !== null) break;
      pendingPushes.delete(accountId);

      const response = await executeTrackedPush(accountId, entry.message);

      for (const resolve of entry.resolvers) {
        try {
          resolve(response);
        } catch {
          // Originating tab may have already closed
        }
      }
    }
  })().finally(() => {
    inFlightAccountPushes.delete(accountId);
  });

  inFlightAccountPushes.set(accountId, task);
  await task;
}

async function handleEnqueuePush(message: SyncEnqueuePushMessage): Promise<SyncHandlerResponse> {
  if (!validateSyncEndpoint(message.serverUrl, message.accountId)) {
    return { success: false, error: 'network_error', message: 'Invalid sync endpoint parameters.' };
  }

  const inFlightVersion = inFlightPushVersions.get(message.accountId);
  if (inFlightVersion !== undefined && message.data.version < inFlightVersion) {
    return { success: true, superseded: true, data: { version: inFlightVersion } };
  }

  const prev = pendingPushes.get(message.accountId);
  if (prev) {
    if (message.data.version < prev.message.data.version) {
      return { success: true, superseded: true, data: { version: prev.message.data.version } };
    }
    pendingPushes.delete(message.accountId);
    resolveSupersededEntry(prev, message.data.version);
  }

  const adjustedData = advanceLinearBaseVersion(message.accountId, message.data);
  const pushMessage: SyncPushMessage = {
    action: 'SYNC_PUSH',
    accountId: message.accountId,
    serverUrl: message.serverUrl,
    apiKey: message.apiKey,
    data: adjustedData
  };

  const rawDelay = Number.isFinite(message.delayMs) ? message.delayMs : DEFAULT_PUSH_DEBOUNCE_MS;
  const delayMs = Math.max(0, Math.min(rawDelay, MAX_ENQUEUE_DELAY_MS));

  return new Promise<SyncHandlerResponse>((resolve) => {
    const entry: PendingPushEntry = {
      message: pushMessage,
      timer: null,
      resolvers: [resolve]
    };
    if (delayMs === 0) {
      pendingPushes.set(message.accountId, entry);
      persistPendingPushEntry(message.accountId, entry);
      void drainPendingPush(message.accountId);
    } else {
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void drainPendingPush(message.accountId);
      }, delayMs);
      pendingPushes.set(message.accountId, entry);
      persistPendingPushEntry(message.accountId, entry);
    }
  });
}

async function handleCancelPush(accountId: string): Promise<void> {
  lastCommittedPush.delete(accountId);
  const queued = pendingPushes.get(accountId);
  if (queued) {
    pendingPushes.delete(accountId);
    resolveSupersededEntry(queued, 0);
  }
  await serializePendingPushStorage(accountId, async () => {
    if (pendingPushes.has(accountId)) return;
    try {
      await storageLocalRemove(`${PENDING_PUSH_KEY_PREFIX}${accountId}`);
    } catch {
      // Best-effort cleanup
    }
  });
}

function handleFlushPush(message: SyncFlushPushMessage): SyncHandlerResponse {
  const keys = message.accountId ? [message.accountId] : Array.from(pendingPushes.keys());
  let flushed = 0;
  for (const accountId of keys) {
    const entry = pendingPushes.get(accountId);
    if (!entry) continue;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    flushed += 1;
    void drainPendingPush(accountId);
  }
  return { success: true, data: { flushed } };
}

async function recoverPendingPushes(): Promise<void> {
  try {
    const all = await storageLocalGet<Record<string, unknown>>(null);
    const settingsRaw = all[SYNC_SETTINGS_KEY];
    const settings = settingsRaw && typeof settingsRaw === 'object' ? (settingsRaw as Record<string, unknown>) : null;
    const serverUrl = typeof settings?.serverUrl === 'string' ? settings.serverUrl.trim() : '';
    const apiKey = typeof settings?.apiKey === 'string' ? settings.apiKey.trim() : '';
    if (!serverUrl || !apiKey) return;

    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(PENDING_PUSH_KEY_PREFIX)) continue;
      const accountId = key.slice(PENDING_PUSH_KEY_PREFIX.length);
      if (!ACCOUNT_ID_RE.test(accountId) || pendingPushes.has(accountId)) continue;
      if (!value || typeof value !== 'object') continue;
      const record = value as { serverUrl?: unknown; data?: unknown };
      if (record.serverUrl !== serverUrl || !record.data || typeof record.data !== 'object') continue;

      const entry: PendingPushEntry = {
        message: {
          action: 'SYNC_PUSH',
          accountId,
          serverUrl,
          apiKey,
          data: record.data as EncryptedSyncEnvelope
        },
        timer: null,
        resolvers: []
      };
      pendingPushes.set(accountId, entry);
      void drainPendingPush(accountId);
    }
  } catch (error) {
    console.warn('[gemini-projects] pending push recovery failed', error);
  }
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

function sanitizeSessionPayload(raw: unknown): SessionPassphrasePayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as { globalPassphrase?: unknown; accountPassphrases?: unknown };

  if (candidate.globalPassphrase !== undefined) {
    if (typeof candidate.globalPassphrase !== 'string' || candidate.globalPassphrase.length > MAX_PASSPHRASE_LENGTH) {
      return null;
    }
  }

  const accountPassphrases: Record<string, string> = {};
  if (candidate.accountPassphrases !== undefined) {
    if (!candidate.accountPassphrases || typeof candidate.accountPassphrases !== 'object' || Array.isArray(candidate.accountPassphrases)) {
      return null;
    }
    const entries = Object.entries(candidate.accountPassphrases as Record<string, unknown>);
    if (entries.length > MAX_PASSPHRASE_ACCOUNTS) {
      return null;
    }
    for (const [accountId, value] of entries) {
      if (typeof value !== 'string' || value.length > MAX_PASSPHRASE_LENGTH) {
        return null;
      }
      accountPassphrases[accountId] = value;
    }
  }

  return {
    ...(typeof candidate.globalPassphrase === 'string' && candidate.globalPassphrase
      ? { globalPassphrase: candidate.globalPassphrase }
      : {}),
    accountPassphrases
  };
}

async function handleSessionGet(): Promise<SyncSessionGetResult> {
  const result = await storageSessionGet<Record<string, unknown>>([SYNC_SESSION_PASSPHRASE_KEY]);
  if (result === null) {
    return { ok: true, data: fallbackSessionPassphrases };
  }
  const raw = result[SYNC_SESSION_PASSPHRASE_KEY];
  return { ok: true, data: raw ? sanitizeSessionPayload(raw) : null };
}

async function handleSessionSet(message: SyncSessionSetMessage): Promise<SyncSessionWriteResult> {
  const sanitized = sanitizeSessionPayload(message.payload);
  if (!sanitized) {
    return { ok: false, error: 'Invalid session passphrase payload.' };
  }
  const persistedInSession = await storageSessionSet({ [SYNC_SESSION_PASSPHRASE_KEY]: sanitized });
  if (persistedInSession) {
    fallbackSessionPassphrases = null;
    return { ok: true, persistedInSession: true };
  }
  fallbackSessionPassphrases = sanitized;
  return { ok: true, persistedInSession: false };
}

async function handleSessionClear(): Promise<SyncSessionWriteResult> {
  fallbackSessionPassphrases = null;
  lastCommittedPush.clear();
  await storageSessionRemove(SYNC_SESSION_PASSPHRASE_KEY);

  pendingPushes.forEach((entry) => {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    for (const resolve of entry.resolvers) {
      try {
        resolve({ success: false, error: 'network_error', message: 'Sync session cleared.' });
      } catch {
        // Ignore closed caller
      }
    }
  });
  pendingPushes.clear();

  try {
    const all = await storageLocalGet<Record<string, unknown>>(null);
    const pendingKeys = Object.keys(all).filter((k) => k.startsWith(PENDING_PUSH_KEY_PREFIX));
    if (pendingKeys.length > 0) {
      await storageLocalRemove(pendingKeys);
    }
  } catch {
    // Best-effort cleanup
  }

  return { ok: true, persistedInSession: true };
}

webext.runtime.onMessage.addListener((
  message: SyncMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (
    response:
      | SyncApiResponse<unknown>
      | SyncPermissionResult
      | SyncOpenPermissionPageResult
      | SyncSessionGetResult
      | SyncSessionWriteResult
  ) => void
) => {
  if (!isAuthorizedSender(sender)) {
    sendResponse({ success: false, error: 'forbidden', message: 'Unauthorized message sender.' });
    return false;
  }

  if (isSessionGetMessage(message)) {
    handleSessionGet()
      .then((result) => sendResponse(result))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (isSessionSetMessage(message)) {
    handleSessionSet(message)
      .then((result) => sendResponse(result))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (isSessionClearMessage(message)) {
    handleSessionClear()
      .then((result) => sendResponse(result))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
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

  if (isEnqueuePushMessage(message)) {
    handleEnqueuePush(message)
      .then((response) => sendResponse(response))
      .catch((error: Error) => sendResponse({
        success: false,
        error: 'network_error',
        message: error.message
      }));
    return true;
  }

  if (isFlushPushMessage(message)) {
    sendResponse(handleFlushPush(message));
    return false;
  }

  if (isCancelPushMessage(message)) {
    handleCancelPush(message.accountId)
      .then(() => sendResponse({ success: true, data: { cancelled: true } }))
      .catch((error: Error) => sendResponse({
        success: false,
        error: 'network_error',
        message: error.message
      }));
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

void recoverPendingPushes();

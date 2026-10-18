import type {
  EncryptedSyncEnvelope,
  RemoteSyncBlob,
  SyncApiResponse,
  SyncMessage,
  SyncPushMessage
} from './shared/types';
import { RemoteSyncBlobSchema, SyncConfirmationSchema } from './shared/schemas';
import { errorMessage, webext } from './shared/webext';

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

type SyncHandlerResponse = SyncApiResponse<unknown>;

function isSyncMessage(message: unknown): message is SyncMessage {
  if (!message || typeof message !== 'object') return false;
  const action = (message as { action?: unknown }).action;
  return action === 'SYNC_PULL' || action === 'SYNC_PUSH';
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, '');
}

function syncEndpoint(serverUrl: string, accountId: string): string {
  return `${normalizeServerUrl(serverUrl)}/api/v1/sync/${accountId}`;
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

function networkFailure(error: unknown): SyncHandlerResponse {
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
  try {
    const response = await fetchWithTimeout(syncEndpoint(serverUrl, accountId), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
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
    if (response.status === 404) {
      return { success: false, error: 'not_found', status: 404 };
    }
    if (response.status === 401) {
      return { success: false, error: 'unauthorized', status: 401 };
    }
    return { success: false, error: 'network_error', status: response.status };
  } catch (error) {
    return networkFailure(error);
  }
}

async function handleSyncPush(message: SyncPushMessage): Promise<SyncHandlerResponse> {
  const { accountId, serverUrl, apiKey, data } = message;
  try {
    const response = await fetchWithTimeout(syncEndpoint(serverUrl, accountId), {
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
        ...(parsedServerState.success ? { serverState: parsedServerState.data as RemoteSyncBlob } : {})
      };
    }
    if (response.status === 401) {
      return { success: false, error: 'unauthorized', status: 401 };
    }
    return { success: false, error: 'network_error', status: response.status };
  } catch (error) {
    return networkFailure(error);
  }
}

function handleSyncMessage(message: SyncMessage): Promise<SyncHandlerResponse> {
  if (message.action === 'SYNC_PULL') {
    return handleSyncPull(message.accountId, message.serverUrl, message.apiKey);
  }
  return handleSyncPush(message);
}

webext.runtime.onMessage.addListener((
  message: SyncMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: SyncApiResponse<unknown>) => void
) => {
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

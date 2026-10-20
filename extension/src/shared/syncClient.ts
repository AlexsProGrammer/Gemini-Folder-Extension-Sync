import { RemoteSyncBlobSchema } from './schemas';
import type {
  EncryptedSyncEnvelope,
  RemoteSyncBlob,
  SyncApiResponse,
  SyncConfig,
  SyncMessage,
  SyncPermissionMessage,
  SyncPermissionResult,
  SyncPullMessage,
  SyncPushMessage
} from './types';
import { errorMessage, permissionsContains, permissionsRequest, runtimeSendMessage } from './webext';

/**
 * Client-side bridge to the background CORS proxy. Content scripts never
 * touch `fetch` for sync traffic; every request is forwarded through
 * `webext.runtime.sendMessage` to `src/background.ts`, which owns the
 * privileged cross-origin context.
 */

function transportFailure(error: unknown): SyncApiResponse<never> {
  return {
    success: false,
    error: 'network_error',
    message: errorMessage(error)
  };
}

export type HostPermissionResult =
  | { granted: true; requested: false }
  | { granted: true; requested: true }
  | { granted: true; unavailable: true }
  | { granted: false; requested: true; error?: string };

/**
 * Ensures the extension holds host permission for the given server URL's
 * origin. MV3 does not grant `optional_host_permissions` automatically, and a
 * cross-origin fetch from the background script without that permission fails
 * with a browser-level `NetworkError`. This must be called from a user gesture
 * (button click).
 *
 * Firefox does not expose the permissions API to content scripts, so the
 * check/request is proxied to the background worker via `SYNC_ENSURE_PERMISSION`
 * whenever the API is unavailable locally (Firefox content-script context).
 */
export async function ensureServerHostPermission(serverUrl: string): Promise<HostPermissionResult> {
  let origin: string;
  try {
    origin = new URL(serverUrl.trim()).origin;
  } catch {
    return { granted: true, requested: false };
  }
  const origins = [`${origin}/*`];
  const contains = await permissionsContains(origins);
  if (contains === null) {
    // Permissions API unavailable in this context (Firefox content script):
    // ask the background worker, which owns the API, to check and request.
    try {
      const result = await runtimeSendMessage<SyncPermissionResult>({
        action: 'SYNC_ENSURE_PERMISSION',
        origin
      });
      if (result && typeof result === 'object' && 'granted' in result) {
        if (result.granted) {
          return { granted: true, requested: true };
        }
        const detail = 'error' in result && result.error ? result.error : undefined;
        if (detail) console.warn('[gemini-projects] sync host permission request failed:', detail);
        return { granted: false, requested: true, error: detail };
      }
      return { granted: true, unavailable: true };
    } catch {
      return { granted: true, unavailable: true };
    }
  }
  if (contains) {
    return { granted: true, requested: false };
  }
  const granted = await permissionsRequest(origins);
  if (granted === null) {
    return { granted: true, unavailable: true };
  }
  return { granted, requested: true };
}

export async function requestRemotePull(
  config: SyncConfig,
  accountId: string
): Promise<SyncApiResponse<RemoteSyncBlob>> {
  const message: SyncPullMessage = {
    action: 'SYNC_PULL',
    accountId,
    serverUrl: config.serverUrl,
    apiKey: config.apiKey
  };

  try {
    const response = await runtimeSendMessage<SyncApiResponse<RemoteSyncBlob> | null>(message as SyncMessage);
    if (!response) {
      return { success: false, error: 'network_error', message: 'Background worker returned no response.' };
    }

    if (response.success) {
      const validated = RemoteSyncBlobSchema.safeParse(response.data);
      if (!validated.success) {
        return { success: false, error: 'network_error', message: 'Malformed remote sync blob.' };
      }
      return { success: true, data: validated.data as RemoteSyncBlob };
    }
    return response;
  } catch (error) {
    return transportFailure(error);
  }
}

export async function requestRemotePush(
  config: SyncConfig,
  accountId: string,
  payload: EncryptedSyncEnvelope
): Promise<SyncApiResponse<{ version: number }>> {
  const message: SyncPushMessage = {
    action: 'SYNC_PUSH',
    accountId,
    serverUrl: config.serverUrl,
    apiKey: config.apiKey,
    data: payload
  };

  try {
    const response = await runtimeSendMessage<SyncApiResponse<{ version: number }> | null>(message as SyncMessage);
    if (!response) {
      return { success: false, error: 'network_error', message: 'Background worker returned no response.' };
    }
    return response;
  } catch (error) {
    return transportFailure(error);
  }
}

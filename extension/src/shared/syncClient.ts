import { RemoteSyncBlobSchema } from './schemas';
import type {
  EncryptedSyncEnvelope,
  RemoteSyncBlob,
  SyncApiResponse,
  SyncCheckPermissionMessage,
  SyncConfig,
  SyncEnqueuePushMessage,
  SyncFlushPushMessage,
  SyncMessage,
  SyncOpenPermissionPageMessage,
  SyncOpenPermissionPageResult,
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
  | { granted: false; requested: boolean; error?: string };

function parseServerOrigin(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Checks whether the extension holds host permission for the given server
 * URL's origin. MV3 does not grant `optional_host_permissions` automatically,
 * and a cross-origin fetch from the background script without that permission
 * fails with a browser-level `NetworkError`.
 *
 * Content scripts cannot call `permissions.request()` directly (and proxying it
 * through `runtime.sendMessage` forfeits user activation), so when permission
 * is missing from a content script this returns `{ granted: false, requested: false }`
 * and callers should open the extension-origin permission page via
 * `openServerHostPermissionPage()`.
 */
export async function ensureServerHostPermission(serverUrl: string): Promise<HostPermissionResult> {
  const origin = parseServerOrigin(serverUrl);
  if (!origin) {
    return { granted: false, requested: false, error: 'Invalid server URL.' };
  }
  const origins = [`${origin}/*`];
  let contains: boolean | null;
  try {
    contains = await permissionsContains(origins);
  } catch (error) {
    return { granted: false, requested: false, error: errorMessage(error) };
  }

  if (contains === null) {
    // Permissions API unavailable in content scripts: ask background to check.
    try {
      const message: SyncCheckPermissionMessage = {
        action: 'SYNC_CHECK_PERMISSION',
        origin
      };
      const result = await runtimeSendMessage<SyncPermissionResult | null>(message);
      if (result && typeof result === 'object' && 'granted' in result) {
        if (result.granted) {
          return { granted: true, requested: false };
        }
        return {
          granted: false,
          requested: false,
          ...(result.error ? { error: result.error } : {})
        };
      }
      return { granted: false, requested: false, error: 'Permission check returned an invalid response.' };
    } catch (error) {
      return { granted: false, requested: false, error: errorMessage(error) };
    }
  }

  if (contains) {
    return { granted: true, requested: false };
  }

  try {
    const granted = await permissionsRequest(origins);
    if (granted === null) {
      return { granted: false, requested: false, error: 'Permissions API is unavailable in this context.' };
    }
    return { granted, requested: true };
  } catch (error) {
    return { granted: false, requested: true, error: errorMessage(error) };
  }
}

/**
 * Asks the background worker to open the extension-origin permission helper
 * page so the user can grant host access with a direct user gesture.
 */
export async function openServerHostPermissionPage(serverUrl: string): Promise<SyncOpenPermissionPageResult> {
  const origin = parseServerOrigin(serverUrl);
  if (!origin) {
    return { opened: false, error: 'Invalid server URL.' };
  }
  try {
    const message: SyncOpenPermissionPageMessage = {
      action: 'SYNC_OPEN_PERMISSION_PAGE',
      origin
    };
    const result = await runtimeSendMessage<SyncOpenPermissionPageResult | null>(message);
    if (result && typeof result === 'object' && 'opened' in result) {
      return result;
    }
    return { opened: false, error: 'Background worker returned an invalid response.' };
  } catch (error) {
    return { opened: false, error: errorMessage(error) };
  }
}

export async function requestRemotePull(
  config: SyncConfig,
  accountId: string,
  ifNoneMatch?: string
): Promise<SyncApiResponse<RemoteSyncBlob>> {
  const message: SyncPullMessage = {
    action: 'SYNC_PULL',
    accountId,
    serverUrl: config.serverUrl,
    apiKey: config.apiKey,
    ...(ifNoneMatch ? { ifNoneMatch } : {})
  };

  try {
    const response = await runtimeSendMessage<SyncApiResponse<RemoteSyncBlob> | null>(message as SyncMessage);
    if (!response) {
      return { success: false, error: 'network_error', message: 'Background worker returned no response.' };
    }

    if (response.success) {
      if ('notModified' in response && response.notModified) {
        return {
          success: true,
          notModified: true,
          ...(response.etag ? { etag: response.etag } : {})
        };
      }
      if (!('data' in response)) {
        return { success: false, error: 'network_error', message: 'Malformed remote sync response.' };
      }
      const validated = RemoteSyncBlobSchema.safeParse(response.data);
      if (!validated.success) {
        return { success: false, error: 'network_error', message: 'Malformed remote sync blob.' };
      }
      return {
        success: true,
        data: validated.data as RemoteSyncBlob,
        ...(response.etag ? { etag: response.etag } : {})
      };
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

export async function requestEnqueuedPush(
  config: SyncConfig,
  accountId: string,
  payload: EncryptedSyncEnvelope,
  delayMs: number
): Promise<SyncApiResponse<{ version: number }>> {
  const message: SyncEnqueuePushMessage = {
    action: 'SYNC_ENQUEUE_PUSH',
    accountId,
    serverUrl: config.serverUrl,
    apiKey: config.apiKey,
    data: payload,
    delayMs
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

export async function requestFlushPendingPushes(accountId?: string): Promise<void> {
  const message: SyncFlushPushMessage = {
    action: 'SYNC_FLUSH_PUSH',
    ...(accountId ? { accountId } : {})
  };
  try {
    await runtimeSendMessage<unknown>(message as SyncMessage);
  } catch {
    // Best-effort flush during pagehide / visibilitychange.
  }
}

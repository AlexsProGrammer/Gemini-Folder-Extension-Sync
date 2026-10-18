import { RemoteSyncBlobSchema } from './schemas';
import type {
  EncryptedSyncEnvelope,
  RemoteSyncBlob,
  SyncApiResponse,
  SyncConfig,
  SyncMessage,
  SyncPullMessage,
  SyncPushMessage
} from './types';
import { runtimeSendMessage } from './webext';

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
    message: error instanceof Error ? error.message : String(error)
  };
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

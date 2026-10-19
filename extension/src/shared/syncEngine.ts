import {
  decryptWorkspace,
  encryptWorkspace,
  deriveWorkspaceKey
} from './crypto';
import {
  debugLog,
  debugWarn,
  getSyncConfig,
  getWorkspace,
  hasWorkspace,
  putWorkspace,
  WORKSPACE_SCHEMA_VERSION
} from './storage';
import { requestRemotePull, requestRemotePush } from './syncClient';
import { promptFingerprint } from './promptFingerprint';
import { errorMessage } from './webext';
import type {
  ChatRef,
  PromptTemplate,
  Project,
  SyncConflictDetail,
  SyncResolution,
  SyncStatus,
  SyncStatusDetail,
  WorkspacePayload
} from './types';

export const SYNC_STATUS_EVENT = 'gemini-workspace:sync-status';
export const SYNC_CONFLICT_EVENT = 'gemini-workspace:sync-conflict';
export const WORKSPACE_UPDATED_EVENT = 'gemini-workspace:workspace-updated';

/** Coalesces rapid local modifications into a single remote push. */
const PUSH_DEBOUNCE_MS = 750;

function dispatchWindowEvent<T>(name: string, detail: T): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<T>(name, { detail }));
}

function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

function newerPrompt(local: PromptTemplate, remote: PromptTemplate): PromptTemplate {
  return remote.updatedAt > local.updatedAt ? remote : local;
}

function mergePromptLibraries(
  localPrompts: PromptTemplate[],
  remotePrompts: PromptTemplate[]
): PromptTemplate[] {
  // Phase 1: merge by id (same prompt synced between devices), newest wins.
  const byId = new Map<string, PromptTemplate>();
  remotePrompts.forEach((prompt) => byId.set(prompt.id, prompt));
  localPrompts.forEach((prompt) => {
    const existing = byId.get(prompt.id);
    byId.set(prompt.id, existing ? newerPrompt(existing, prompt) : prompt);
  });

  // Phase 2: collapse content duplicates. The same prompt created
  // independently on two devices carries different UUIDs, so both survive the
  // id merge. The fingerprint (title + content hash) identifies them; keep
  // the newest revision and drop the loser's id from the result.
  const kept = new Map<string, PromptTemplate>();
  const fingerprints = new Map<string, string>();
  byId.forEach((prompt) => {
    const fingerprint = promptFingerprint(prompt);
    const keptId = fingerprints.get(fingerprint);
    if (keptId === undefined) {
      kept.set(prompt.id, prompt);
      fingerprints.set(fingerprint, prompt.id);
      return;
    }
    const winner = newerPrompt(kept.get(keptId)!, prompt);
    if (winner.id !== keptId) {
      kept.delete(keptId);
      kept.set(winner.id, winner);
      fingerprints.set(fingerprint, winner.id);
    }
    // winner.id === keptId: the entry is already stored under its own id.
  });
  return Array.from(kept.values());
}

/** Newest revision wins per conversation; assignments travel with the chat. */
function mergeChats(
  localChats: Record<string, ChatRef> | undefined,
  remoteChats: Record<string, ChatRef> | undefined
): Record<string, ChatRef> {
  const merged: Record<string, ChatRef> = {};
  const ids = new Set([...Object.keys(localChats ?? {}), ...Object.keys(remoteChats ?? {})]);
  ids.forEach((conversationId) => {
    const localChat = localChats?.[conversationId];
    const remoteChat = remoteChats?.[conversationId];
    if (localChat && remoteChat) {
      merged[conversationId] = remoteChat.updatedAt > localChat.updatedAt ? remoteChat : localChat;
      return;
    }
    const winner = localChat ?? remoteChat;
    if (winner) merged[conversationId] = winner;
  });
  return merged;
}

function mergeProjects(
  localProjects: Record<string, Project>,
  remoteProjects: Record<string, Project>
): Record<string, Project> {
  const merged: Record<string, Project> = {};
  const ids = new Set([...Object.keys(localProjects), ...Object.keys(remoteProjects)]);

  ids.forEach((id) => {
    const localProject = localProjects[id];
    const remoteProject = remoteProjects[id];

    if (localProject && remoteProject) {
      // Preserve the newest metadata revision, then union both chat sets.
      const base = remoteProject.updatedAt > localProject.updatedAt ? remoteProject : localProject;
      const chatIds = Array.from(new Set([
        ...(localProject.chatIds ?? []),
        ...(remoteProject.chatIds ?? [])
      ]));
      merged[id] = { ...base, ...(chatIds.length > 0 ? { chatIds } : {}) };
      return;
    }

    merged[id] = localProject ?? remoteProject;
  });

  return merged;
}

export class SyncEngine {
  /** Ephemeral CryptoKey cache, keyed by account hash. Never persisted. */
  private keys = new Map<string, CryptoKey>();
  private statuses = new Map<string, SyncStatus>();
  private pushTimers = new Map<string, number>();
  private inFlightPushes = new Map<string, Promise<void>>();
  private pendingRepush = new Set<string>();
  private inFlightPulls = new Map<string, Promise<void>>();
  private online = isOnline();

  /**
   * Derives the AES-GCM-256 workspace key for the account from a passphrase
   * and holds it exclusively in transient memory (ephemeral key lifecycle).
   * The SHA-256 account hash doubles as the PBKDF2 salt.
   */
  async setPassphrase(accountId: string, passphrase: string): Promise<boolean> {
    try {
      const key = await deriveWorkspaceKey(passphrase, accountId);
      this.keys.set(accountId, key);
      return true;
    } catch (error) {
      console.warn('[gemini-projects] key derivation failed', error);
      return false;
    }
  }

  /** Drops the ephemeral key so the plaintext-equivalent secret becomes garbage-collectable. */
  clearPassphrase(accountId: string): void {
    this.keys.delete(accountId);
  }

  hasKey(accountId: string): boolean {
    return this.keys.has(accountId);
  }

  getSyncStatus(accountId: string): SyncStatus {
    return this.statuses.get(accountId) ?? 'idle';
  }

  /** Updates connectivity state; going offline freezes all pending network work. */
  setOnlineState(isConnected: boolean): void {
    this.online = isConnected;
    if (isConnected) return;
    this.statuses.forEach((status, accountId) => {
      if (status !== 'conflict') {
        this.setStatus(accountId, 'offline');
      }
    });
  }

  /**
   * Debounced push entry point: every local workspace save funnels through
   * here; rapid modifications within 750ms coalesce into a single remote push.
   */
  schedulePush(accountHash: string): void {
    if (!accountHash) return;

    const existingTimer = this.pushTimers.get(accountHash);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(() => {
      this.pushTimers.delete(accountHash);
      void this.executePush(accountHash);
    }, PUSH_DEBOUNCE_MS);
    this.pushTimers.set(accountHash, timer);
  }

  /**
   * Executes every pending debounced push immediately. Mobile browsers freeze
   * or discard page timers when the tab is backgrounded, so the pagehide /
   * visibilitychange handlers flush here instead of losing the last edits.
   */
  flushPendingPushes(): void {
    const pending = Array.from(this.pushTimers.keys());
    this.pushTimers.clear();
    pending.forEach((accountHash) => {
      void this.executePush(accountHash);
    });
  }

  private async executePush(accountHash: string): Promise<void> {
    const inFlight = this.inFlightPushes.get(accountHash);
    if (inFlight) {
      // A push is already running; coalesce this trigger into a follow-up.
      this.pendingRepush.add(accountHash);
      return;
    }

    const task = this.runPush(accountHash).finally(() => {
      this.inFlightPushes.delete(accountHash);
      if (this.pendingRepush.delete(accountHash)) {
        this.schedulePush(accountHash);
      }
    });
    this.inFlightPushes.set(accountHash, task);
    await task;
  }

  private async runPush(accountHash: string): Promise<void> {
    const key = this.keys.get(accountHash);
    if (!key) {
      debugWarn('runPush: no key in memory; push aborted (status=idle). Passphrase not unlocked for', accountHash.slice(0, 8));
      this.setStatus(accountHash, 'idle', 'No passphrase available; push aborted.');
      return;
    }
    if (!this.online) {
      debugWarn('runPush: offline; push aborted');
      this.setStatus(accountHash, 'offline');
      return;
    }

    const config = await getSyncConfig();
    if (!config) {
      debugWarn('runPush: no sync config; push aborted');
      this.setStatus(accountHash, 'idle', 'Sync is not configured.');
      return;
    }

    this.setStatus(accountHash, 'syncing');
    debugLog(
      `runPush: starting push (account: ${accountHash.slice(0, 8)}…, endpoint: ${config.serverUrl}, apiKey len: ${config.apiKey.length}, apiKey…${config.apiKey.slice(-4)})`
    );

    try {
      const localState = await getWorkspace(accountHash);
      const { ciphertext, iv } = await encryptWorkspace(localState, key);

      debugLog(`runPush: sending payload (version: ${localState.version}, updatedAt: ${localState.updatedAt})`);
      const response = await requestRemotePush(config, accountHash, {
        version: localState.version,
        ciphertext,
        iv,
        updatedAt: localState.updatedAt
      });
      debugLog('runPush: response received:', JSON.stringify(response));

      if (response.success) {
        this.setStatus(accountHash, 'synced');
        return;
      }

      if (response.error === 'conflict' && response.serverState) {
        debugWarn('runPush: conflict detected; server state is newer');
        try {
          const remoteState = await decryptWorkspace(
            response.serverState.ciphertext,
            response.serverState.iv,
            key
          );
          await this.handleConflict(accountHash, localState, remoteState);
        } catch (error) {
          console.warn('[gemini-projects] conflict payload decryption failed', error);
          this.setStatus(accountHash, 'error', 'Conflicting remote state could not be decrypted.');
        }
        return;
      }

      debugWarn('runPush: push failed with error:', response.error, response.message);
      if (response.error === 'unauthorized') {
        this.setStatus(accountHash, 'error', 'Invalid API key (401). Re-enter your key in sync settings.');
        return;
      }
      this.setStatus(accountHash, 'error', response.message ?? `Push failed (${response.error}).`);
    } catch (error) {
      debugWarn('runPush: push failed (exception)', error);
      this.setStatus(
        accountHash,
        this.online ? 'error' : 'offline',
        errorMessage(error)
      );
    }
  }

  /**
   * Auto-pull: fetches the remote envelope, decrypts it and reconciles
   * version ordering. Aborts gracefully when offline or no key is unlocked.
   */
  async pull(accountHash: string): Promise<void> {
    if (!accountHash) return;
    if (!this.online) {
      this.setStatus(accountHash, 'offline');
      return;
    }
    if (!this.keys.has(accountHash)) {
      return;
    }
    const existingPull = this.inFlightPulls.get(accountHash);
    if (existingPull) {
      return existingPull;
    }

    const task = this.runPull(accountHash).finally(() => {
      this.inFlightPulls.delete(accountHash);
    });
    this.inFlightPulls.set(accountHash, task);
    await task;
  }

  private async runPull(accountHash: string): Promise<void> {
    const config = await getSyncConfig();
    if (!config) {
      this.setStatus(accountHash, 'idle', 'Sync is not configured.');
      return;
    }
    debugLog(
      `runPull: using config (account: ${accountHash.slice(0, 8)}…, endpoint: ${config.serverUrl}, apiKey len: ${config.apiKey.length}, apiKey…${config.apiKey.slice(-4)})`
    );

    this.setStatus(accountHash, 'syncing');

    try {
      const response = await requestRemotePull(config, accountHash);
      debugLog('runPull: response received:', JSON.stringify(response));

      if (!response.success) {
        if (response.error === 'not_found') {
          // Server has no state yet: seed it from the local workspace.
          const localExists = await hasWorkspace(accountHash);
          debugLog(`runPull: 404 not_found; local workspace exists: ${localExists}. ${localExists ? 'Scheduling initial push (seed).' : 'Nothing to seed.'}`);
          if (localExists) {
            this.schedulePush(accountHash);
          } else {
            this.setStatus(accountHash, 'synced');
          }
          return;
        }
        debugWarn('runPull: pull failed:', response.error, response.message);
        if (response.error === 'unauthorized') {
          this.setStatus(accountHash, 'error', 'Invalid API key (401). Re-enter your key in sync settings.');
          return;
        }
        this.setStatus(accountHash, 'error', response.message ?? `Pull failed (${response.error}).`);
        return;
      }

      const key = this.keys.get(accountHash);
      if (!key) {
        debugWarn('runPull: no key in memory; pull aborted');
        this.setStatus(accountHash, 'idle', 'No passphrase available; pull aborted.');
        return;
      }

      const remoteState = await decryptWorkspace(response.data.ciphertext, response.data.iv, key);
      const localState = await getWorkspace(accountHash);
      debugLog(`runPull: version comparison — remote: ${remoteState.version}, local: ${localState.version}`);

      if (remoteState.version > localState.version) {
        debugLog('runPull: remote is newer; adopting remote state');
        await putWorkspace(accountHash, remoteState);
        dispatchWindowEvent(WORKSPACE_UPDATED_EVENT, { accountId: accountHash });
        this.setStatus(accountHash, 'synced');
        return;
      }

      if (localState.version > remoteState.version) {
        debugLog('runPull: local is newer; scheduling push');
        this.schedulePush(accountHash);
        return;
      }

      debugLog('runPull: versions in sync');
      this.setStatus(accountHash, 'synced');
    } catch (error) {
      debugWarn('runPull: pull failed (exception)', error);
      this.setStatus(
        accountHash,
        this.online ? 'error' : 'offline',
        errorMessage(error)
      );
    }
  }

  /**
   * Applies the user's conflict verdict. Both mutating resolutions bump the
   * version past the server state and push immediately.
   */
  async resolveConflictResolution(
    resolution: SyncResolution,
    conflict: SyncConflictDetail,
    accountHash: string
  ): Promise<void> {
    if (resolution === 'keep_remote') {
      await putWorkspace(accountHash, conflict.remoteState);
      dispatchWindowEvent(WORKSPACE_UPDATED_EVENT, { accountId: accountHash });
      this.setStatus(accountHash, 'synced');
      return;
    }

    if (resolution === 'keep_local') {
      const next: WorkspacePayload = {
        ...conflict.localState,
        version: conflict.remoteState.version + 1,
        updatedAt: Date.now()
      };
      await putWorkspace(accountHash, next);
      await this.executePush(accountHash);
      return;
    }

    const merged = mergeWorkspaces(conflict.localState, conflict.remoteState, accountHash);
    await putWorkspace(accountHash, merged);
    await this.executePush(accountHash);
  }

  private async handleConflict(
    accountHash: string,
    localState: WorkspacePayload,
    remoteState: WorkspacePayload
  ): Promise<void> {
    this.setStatus(accountHash, 'conflict');
    dispatchWindowEvent<SyncConflictDetail & { accountId: string }>(SYNC_CONFLICT_EVENT, {
      accountId: accountHash,
      localState,
      remoteState
    });
  }

  private setStatus(accountId: string, status: SyncStatus, message?: string): void {
    this.statuses.set(accountId, status);
    const detail: SyncStatusDetail = { accountId, status, ...(message ? { message } : {}) };
    dispatchWindowEvent(SYNC_STATUS_EVENT, detail);
  }
}

function mergeWorkspaces(
  localState: WorkspacePayload,
  remoteState: WorkspacePayload,
  accountHash: string
): WorkspacePayload {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    accountId: accountHash,
    version: remoteState.version + 1,
    updatedAt: Date.now(),
    projects: mergeProjects(localState.projects, remoteState.projects),
    prompts: mergePromptLibraries(localState.prompts, remoteState.prompts),
    tagMeta: { ...(remoteState.tagMeta ?? {}), ...(localState.tagMeta ?? {}) },
    chats: mergeChats(localState.chats, remoteState.chats),
    // Sidebar preferences are device-local; the local view wins on merge.
    uiPrefs: localState.uiPrefs ?? remoteState.uiPrefs
  };
}

export const syncEngine = new SyncEngine();

import {
  decryptWorkspace,
  encryptWorkspace,
  deriveWorkspaceKey
} from './crypto';
import {
  getSyncConfig,
  getWorkspace,
  hasWorkspace,
  putWorkspace,
  WORKSPACE_SCHEMA_VERSION
} from './storage';
import { requestRemotePull, requestRemotePush } from './syncClient';
import type {
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
  const merged = new Map<string, PromptTemplate>();
  remotePrompts.forEach((prompt) => merged.set(prompt.id, prompt));
  localPrompts.forEach((prompt) => {
    const existing = merged.get(prompt.id);
    merged.set(prompt.id, existing ? newerPrompt(prompt, existing) : prompt);
  });
  return Array.from(merged.values());
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
      this.setStatus(accountHash, 'idle', 'No passphrase available; push aborted.');
      return;
    }
    if (!this.online) {
      this.setStatus(accountHash, 'offline');
      return;
    }

    const config = await getSyncConfig();
    if (!config) {
      this.setStatus(accountHash, 'idle', 'Sync is not configured.');
      return;
    }

    this.setStatus(accountHash, 'syncing');

    try {
      const localState = await getWorkspace(accountHash);
      const { ciphertext, iv } = await encryptWorkspace(localState, key);

      const response = await requestRemotePush(config, accountHash, {
        version: localState.version,
        ciphertext,
        iv,
        updatedAt: localState.updatedAt
      });

      if (response.success) {
        this.setStatus(accountHash, 'synced');
        return;
      }

      if (response.error === 'conflict' && response.serverState) {
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

      this.setStatus(accountHash, 'error', response.message ?? `Push failed (${response.error}).`);
    } catch (error) {
      console.warn('[gemini-projects] push failed', error);
      this.setStatus(
        accountHash,
        this.online ? 'error' : 'offline',
        error instanceof Error ? error.message : String(error)
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

    this.setStatus(accountHash, 'syncing');

    try {
      const response = await requestRemotePull(config, accountHash);

      if (!response.success) {
        if (response.error === 'not_found') {
          // Server has no state yet: seed it from the local workspace.
          if (await hasWorkspace(accountHash)) {
            this.schedulePush(accountHash);
          } else {
            this.setStatus(accountHash, 'synced');
          }
          return;
        }
        this.setStatus(accountHash, 'error', response.message ?? `Pull failed (${response.error}).`);
        return;
      }

      const key = this.keys.get(accountHash);
      if (!key) {
        this.setStatus(accountHash, 'idle', 'No passphrase available; pull aborted.');
        return;
      }

      const remoteState = await decryptWorkspace(response.data.ciphertext, response.data.iv, key);
      const localState = await getWorkspace(accountHash);

      if (remoteState.version > localState.version) {
        await putWorkspace(accountHash, remoteState);
        dispatchWindowEvent(WORKSPACE_UPDATED_EVENT, { accountId: accountHash });
        this.setStatus(accountHash, 'synced');
        return;
      }

      if (localState.version > remoteState.version) {
        this.schedulePush(accountHash);
        return;
      }

      this.setStatus(accountHash, 'synced');
    } catch (error) {
      console.warn('[gemini-projects] pull failed', error);
      this.setStatus(
        accountHash,
        this.online ? 'error' : 'offline',
        error instanceof Error ? error.message : String(error)
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
    tagMeta: { ...(remoteState.tagMeta ?? {}), ...(localState.tagMeta ?? {}) }
  };
}

export const syncEngine = new SyncEngine();

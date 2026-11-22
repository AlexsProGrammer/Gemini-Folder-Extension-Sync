import {
  decryptWorkspace,
  encryptWorkspace,
  deriveWorkspaceKey,
  PayloadTooLargeError
} from './crypto';
import {
  debugLog,
  debugWarn,
  getSyncConfig,
  getSyncMeta,
  getWorkspace,
  hasWorkspace,
  putWorkspace,
  setSyncMeta,
  WORKSPACE_SCHEMA_VERSION
} from './storage';
import { requestRemotePull, requestRemotePush } from './syncClient';
import { promptFingerprint } from './promptFingerprint';
import { errorMessage, errorName } from './webext';
import type {
  ChatRef,
  PromptTemplate,
  Project,
  SyncConflictDetail,
  SyncErrorKind,
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

/**
 * True when a workspace payload carries no user-visible content at all
 * (no projects/folders, no chat assignments, no prompts). Sidebar prefs and
 * tag colors alone do not count as content.
 */
function workspaceHasContent(state: WorkspacePayload): boolean {
  return (
    Object.keys(state.projects ?? {}).length > 0 ||
    Object.keys(state.chats ?? {}).length > 0 ||
    (state.prompts ?? []).length > 0
  );
}

const AUTH_CIRCUIT_BREAKER_ERRORS = new Set<SyncErrorKind>([
  'unauthorized',
  'forbidden',
  'permission_denied',
  'decryption_failed'
]);

const TRANSIENT_PUSH_ERRORS = new Set<SyncErrorKind>([
  'network_error',
  'timeout',
  'server_error',
  'rate_limited'
]);

const MAX_PUSH_RETRIES = 3;

function formatSyncErrorMessage(error: SyncErrorKind, status?: number, message?: string): string {
  switch (error) {
    case 'unauthorized':
      return 'Invalid API key (401). Re-enter your key in sync settings.';
    case 'forbidden':
      return 'API key is not authorized for this account (403). Check the key binding on the server.';
    case 'permission_denied':
      return message ?? 'Host permission for sync server is not granted. Open Sync settings to grant access.';
    case 'rate_limited':
      return message ?? 'Rate limited by sync server (429).';
    case 'payload_too_large':
      return message ?? 'Sync payload exceeds server size limit (413).';
    case 'server_error':
      return message ?? `Sync server error (${status ?? 500}).`;
    case 'timeout':
      return message ?? 'Sync server request timed out.';
    case 'decryption_failed':
      return 'Wrong encryption passphrase — update it in Sync settings.';
    case 'network_error':
      return message ?? 'Server unreachable.';
    default:
      return message ?? `Sync failed (${error}).`;
  }
}

export class SyncEngine {
  /** Ephemeral CryptoKey cache, keyed by account hash. Never persisted. */
  private keys = new Map<string, CryptoKey>();
  private statuses = new Map<string, SyncStatus>();
  private statusMessages = new Map<string, string>();
  private pausedAccounts = new Set<string>();
  private unresolvedConflicts = new Map<string, SyncConflictDetail>();
  private pushTimers = new Map<string, number>();
  private pushRetryTimers = new Map<string, number>();
  private pushRetryAttempts = new Map<string, number>();
  private inFlightPushes = new Map<string, Promise<void>>();
  private pendingRepush = new Set<string>();
  private inFlightPulls = new Map<string, Promise<void>>();
  private online = isOnline();
  private coordChannel: BroadcastChannel | null = null;

  constructor() {
    if (typeof BroadcastChannel === 'function') {
      try {
        this.coordChannel = new BroadcastChannel('gp-sync-coord');
        this.coordChannel.onmessage = (event) => {
          const msg = event.data as { type?: string; detail?: SyncStatusDetail } | null;
          if (msg?.type === 'status' && msg.detail?.accountId && msg.detail?.status) {
            this.applyRemoteStatus(msg.detail);
          }
        };
      } catch {
        this.coordChannel = null;
      }
    }
  }

  private applyRemoteStatus(detail: SyncStatusDetail): void {
    this.statuses.set(detail.accountId, detail.status);
    if (detail.message) {
      this.statusMessages.set(detail.accountId, detail.message);
    } else {
      this.statusMessages.delete(detail.accountId);
    }
    dispatchWindowEvent(SYNC_STATUS_EVENT, detail);
  }

  private withSyncLock<T>(
    accountHash: string,
    ifAvailable: boolean,
    fn: () => Promise<T>
  ): Promise<T | undefined> {
    const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!lockManager || typeof lockManager.request !== 'function') {
      return fn();
    }
    return lockManager.request(
      `gp_sync_${accountHash}`,
      { ifAvailable },
      (lock) => {
        if (!lock) return undefined;
        return fn();
      }
    ) as Promise<T | undefined>;
  }

  /**
   * Derives the AES-GCM-256 workspace key for the account from a passphrase
   * and holds it exclusively in transient memory (ephemeral key lifecycle).
   * The SHA-256 account hash doubles as the PBKDF2 salt.
   */
  async setPassphrase(accountId: string, passphrase: string): Promise<boolean> {
    try {
      const key = await deriveWorkspaceKey(passphrase, accountId);
      this.keys.set(accountId, key);
      this.clearCircuitBreaker(accountId);
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

  clearCircuitBreaker(accountId: string): void {
    this.pausedAccounts.delete(accountId);
    this.pushRetryAttempts.delete(accountId);
    this.clearPushRetryTimer(accountId);
  }

  hasKey(accountId: string): boolean {
    return this.keys.has(accountId);
  }

  getSyncStatus(accountId: string): SyncStatus {
    return this.statuses.get(accountId) ?? 'idle';
  }

  getSyncStatusMessage(accountId: string): string | undefined {
    return this.statusMessages.get(accountId);
  }

  getUnresolvedConflict(accountId: string): SyncConflictDetail | undefined {
    return this.unresolvedConflicts.get(accountId);
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
    if (!accountHash || this.pausedAccounts.has(accountHash)) return;

    this.clearPushRetryTimer(accountHash);
    this.pushRetryAttempts.delete(accountHash);

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

  /** Immediately executes a push for the given account (canceling any pending debounce/retry timers). */
  async pushNow(accountHash: string): Promise<void> {
    if (!accountHash) return;
    const existingTimer = this.pushTimers.get(accountHash);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      this.pushTimers.delete(accountHash);
    }
    this.clearPushRetryTimer(accountHash);
    await this.executePush(accountHash);
  }

  /** Schedules a push if local dirty edits remain unsynced and the account is not paused/conflicted. */
  async pushIfDirty(accountHash: string): Promise<void> {
    if (!accountHash || !this.online || !this.keys.has(accountHash) || this.pausedAccounts.has(accountHash)) {
      return;
    }
    const status = this.getSyncStatus(accountHash);
    if (status === 'conflict' || status === 'error') return;
    const meta = await getSyncMeta(accountHash);
    if (meta.dirty) {
      this.schedulePush(accountHash);
    }
  }

  private clearPushRetryTimer(accountHash: string): void {
    const timer = this.pushRetryTimers.get(accountHash);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.pushRetryTimers.delete(accountHash);
    }
  }

  private schedulePushRetry(accountHash: string, retryAfterSeconds?: number): void {
    if (!this.online || this.pausedAccounts.has(accountHash)) return;
    const attempt = this.pushRetryAttempts.get(accountHash) ?? 0;
    if (attempt >= MAX_PUSH_RETRIES) return;

    this.pushRetryAttempts.set(accountHash, attempt + 1);
    const backoffMs = Math.min(60_000, 2000 * (2 ** attempt));
    const delayMs = retryAfterSeconds !== undefined
      ? Math.min(120_000, Math.max(backoffMs, retryAfterSeconds * 1000))
      : backoffMs;

    this.clearPushRetryTimer(accountHash);
    const timer = window.setTimeout(() => {
      this.pushRetryTimers.delete(accountHash);
      void this.executePush(accountHash);
    }, delayMs);
    this.pushRetryTimers.set(accountHash, timer);
  }

  /**
   * Executes every pending debounced push immediately. Mobile browsers freeze
   * or discard page timers when the tab is backgrounded, so the pagehide /
   * visibilitychange handlers flush here instead of losing the last edits.
   */
  async flushPendingPushes(): Promise<void> {
    const pending = Array.from(this.pushTimers.keys());
    this.pushTimers.forEach((timer) => window.clearTimeout(timer));
    this.pushTimers.clear();
    const tasks = pending.map((accountHash) => this.executePush(accountHash));
    await Promise.all([
      ...tasks,
      ...Array.from(this.inFlightPushes.values())
    ]);
  }

  private async executePush(accountHash: string): Promise<void> {
    const inFlight = this.inFlightPushes.get(accountHash);
    if (inFlight) {
      // A push is already running; coalesce this trigger into a follow-up.
      this.pendingRepush.add(accountHash);
      return;
    }

    const task = this.withSyncLock(accountHash, false, () => this.runPush(accountHash))
      .then(() => undefined)
      .finally(() => {
        this.inFlightPushes.delete(accountHash);
        if (this.pendingRepush.delete(accountHash)) {
          this.schedulePush(accountHash);
        }
      });
    this.inFlightPushes.set(accountHash, task);
    await task;
  }

  private handleErrorOutcome(
    accountHash: string,
    error: SyncErrorKind,
    status?: number,
    message?: string,
    retryAfterSeconds?: number,
    isPush = false
  ): void {
    const formatted = formatSyncErrorMessage(error, status, message);
    if (AUTH_CIRCUIT_BREAKER_ERRORS.has(error)) {
      this.pausedAccounts.add(accountHash);
      this.setStatus(accountHash, 'error', formatted);
      return;
    }
    if (isPush && TRANSIENT_PUSH_ERRORS.has(error)) {
      this.setStatus(accountHash, this.online ? 'error' : 'offline', formatted);
      this.schedulePushRetry(accountHash, retryAfterSeconds);
      return;
    }
    if (!isPush && (error === 'network_error' || error === 'timeout')) {
      this.setStatus(
        accountHash,
        this.online ? 'error' : 'offline',
        `Server unreachable — using the locally saved data. (${formatted})`
      );
      return;
    }
    this.setStatus(accountHash, 'error', formatted);
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
      `runPush: starting push (account: ${accountHash.slice(0, 8)}…, endpoint: ${config.serverUrl}, apiKeyPresent: ${Boolean(config.apiKey)})`
    );

    try {
      const [localState, meta] = await Promise.all([
        getWorkspace(accountHash),
        getSyncMeta(accountHash)
      ]);
      if (!meta.dirty && localState.version <= meta.lastSyncedVersion) {
        debugLog('runPush: workspace already synced by another tab; skipping redundant push');
        this.setStatus(accountHash, 'synced');
        return;
      }
      const { ciphertext, iv } = await encryptWorkspace(localState, key);

      debugLog(`runPush: sending payload (version: ${localState.version}, baseVersion: ${meta.lastSyncedVersion}, updatedAt: ${localState.updatedAt})`);
      const response = await requestRemotePush(config, accountHash, {
        version: localState.version,
        baseVersion: meta.lastSyncedVersion,
        ciphertext,
        iv,
        updatedAt: localState.updatedAt
      });
      debugLog('runPush: response received:', JSON.stringify(response));

      if (response.success) {
        this.pushRetryAttempts.delete(accountHash);
        this.pausedAccounts.delete(accountHash);
        await setSyncMeta(accountHash, {
          lastSyncedVersion: localState.version,
          dirty: false
        });
        this.setStatus(accountHash, 'synced');
        return;
      }

      if (response.error === 'conflict' && response.serverState) {
        debugWarn('runPush: conflict detected; server state is newer');
        this.pushRetryAttempts.delete(accountHash);
        try {
          const remoteState = await decryptWorkspace(
            response.serverState.ciphertext,
            response.serverState.iv,
            key
          );
          await this.handleConflict(accountHash, localState, remoteState);
        } catch (error) {
          console.warn('[gemini-projects] conflict payload decryption failed', error);
          if (errorName(error) === 'OperationError') {
            this.handleErrorOutcome(accountHash, 'decryption_failed');
          } else {
            this.setStatus(accountHash, 'error', 'Conflicting remote state could not be decrypted.');
          }
        }
        return;
      }

      debugWarn('runPush: push failed with error:', response.error, response.status, response.message);
      this.handleErrorOutcome(
        accountHash,
        response.error,
        response.status,
        response.message,
        response.retryAfterSeconds,
        true
      );
    } catch (error) {
      if (error instanceof PayloadTooLargeError || errorName(error) === 'PayloadTooLargeError') {
        this.handleErrorOutcome(accountHash, 'payload_too_large', 413, errorMessage(error), undefined, true);
        return;
      }
      debugWarn('runPush: push failed (exception)', error);
      this.setStatus(
        accountHash,
        this.online ? 'error' : 'offline',
        errorMessage(error)
      );
      this.schedulePushRetry(accountHash);
    }
  }

  /**
   * Auto-pull: fetches the remote envelope, decrypts it and reconciles
   * version ordering. Aborts gracefully when offline or no key is unlocked.
   */
  async pull(accountHash: string, options?: { force?: boolean }): Promise<void> {
    if (!accountHash) return;
    if (!options?.force && this.pausedAccounts.has(accountHash)) {
      return;
    }
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

    const ifAvailable = !options?.force;
    const task = this.withSyncLock(accountHash, ifAvailable, () => this.runPull(accountHash))
      .then(() => undefined)
      .finally(() => {
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
      `runPull: using config (account: ${accountHash.slice(0, 8)}…, endpoint: ${config.serverUrl}, apiKeyPresent: ${Boolean(config.apiKey)})`
    );

    this.setStatus(accountHash, 'syncing');

    try {
      const [preMeta, localExists] = await Promise.all([
        getSyncMeta(accountHash),
        hasWorkspace(accountHash)
      ]);
      const ifNoneMatch = localExists && preMeta.etag ? preMeta.etag : undefined;
      const response = await requestRemotePull(config, accountHash, ifNoneMatch);
      debugLog('runPull: response received:', JSON.stringify(response));

      if (!response.success) {
        if (response.error === 'not_found') {
          // Server has no state yet: seed it from the local workspace.
          debugLog(`runPull: 404 not_found; local workspace exists: ${localExists}. ${localExists ? 'Scheduling initial push (seed).' : 'Nothing to seed.'}`);
          if (localExists) {
            this.schedulePush(accountHash);
          } else {
            this.setStatus(accountHash, 'synced');
          }
          return;
        }
        debugWarn('runPull: pull failed:', response.error, response.status, response.message);
        this.handleErrorOutcome(
          accountHash,
          response.error,
          response.status,
          response.message,
          response.retryAfterSeconds,
          false
        );
        return;
      }

      if ('notModified' in response && response.notModified) {
        debugLog('runPull: 304 Not Modified; skipping decryption');
        if (response.etag && response.etag !== preMeta.etag) {
          await setSyncMeta(accountHash, { ...preMeta, etag: response.etag });
        }
        if (preMeta.dirty) {
          this.schedulePush(accountHash);
        } else {
          this.setStatus(accountHash, 'synced');
        }
        return;
      }

      if (!('data' in response)) {
        this.setStatus(accountHash, 'error', 'Malformed remote sync response.');
        return;
      }

      const key = this.keys.get(accountHash);
      if (!key) {
        debugWarn('runPull: no key in memory; pull aborted');
        this.setStatus(accountHash, 'idle', 'No passphrase available; pull aborted.');
        return;
      }

      let remoteState: WorkspacePayload;
      try {
        remoteState = await decryptWorkspace(response.data.ciphertext, response.data.iv, key);
      } catch (error) {
        if (errorName(error) === 'OperationError') {
          this.handleErrorOutcome(accountHash, 'decryption_failed');
          return;
        }
        throw error;
      }

      const [localState, meta] = await Promise.all([
        getWorkspace(accountHash),
        getSyncMeta(accountHash)
      ]);
      const nextEtag = response.etag ?? meta.etag;
      debugLog(`runPull: version comparison — remote: ${remoteState.version}, local: ${localState.version}, dirty: ${meta.dirty}`);

      if (remoteState.version > localState.version) {
        if (meta.dirty) {
          debugWarn('runPull: remote is newer while local has unsynced edits; raising conflict');
          await this.handleConflict(accountHash, localState, remoteState);
          return;
        }
        // Local-first guard: a remote payload without any content (fresh,
        // reset or mis-bound server partition) must never wipe a populated
        // local workspace — that is how a briefly unreachable/empty server
        // turned into an empty sidebar with no way back. Keep the locally
        // saved folders/projects and re-seed the server from this device
        // instead. (Intentional "delete everything" still propagates: the
        // re-seed push then conflicts and the conflict modal decides.)
        if (!workspaceHasContent(remoteState) && workspaceHasContent(localState)) {
          debugWarn('runPull: remote is newer but carries no content; keeping local data and re-seeding the server');
          this.schedulePush(accountHash);
          this.setStatus(accountHash, 'synced', 'Server state was empty; kept the locally saved data.');
          return;
        }
        debugLog('runPull: remote is newer; adopting remote state');
        await putWorkspace(accountHash, remoteState);
        await setSyncMeta(accountHash, {
          lastSyncedVersion: remoteState.version,
          dirty: false,
          ...(nextEtag ? { etag: nextEtag } : {})
        });
        dispatchWindowEvent(WORKSPACE_UPDATED_EVENT, { accountId: accountHash });
        this.setStatus(accountHash, 'synced');
        return;
      }

      if (localState.version > remoteState.version) {
        debugLog('runPull: local is newer; scheduling push');
        this.schedulePush(accountHash);
        return;
      }

      if (meta.dirty) {
        debugWarn('runPull: equal versions with local dirty edits; raising conflict');
        await this.handleConflict(accountHash, localState, remoteState);
        return;
      }

      if (meta.lastSyncedVersion !== remoteState.version || (nextEtag && meta.etag !== nextEtag)) {
        await setSyncMeta(accountHash, {
          lastSyncedVersion: remoteState.version,
          dirty: false,
          ...(nextEtag ? { etag: nextEtag } : {})
        });
      }
      debugLog('runPull: versions in sync');
      this.setStatus(accountHash, 'synced');
    } catch (error) {
      debugWarn('runPull: pull failed (exception)', error);
      // Local-first: a failed pull never touches the local workspace — the
      // panel keeps showing the locally saved folders/projects.
      this.setStatus(
        accountHash,
        this.online ? 'error' : 'offline',
        `Pull failed — continuing with the locally saved data (${errorMessage(error)}).`
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
    this.unresolvedConflicts.delete(accountHash);

    if (resolution === 'keep_remote') {
      await putWorkspace(accountHash, conflict.remoteState);
      await setSyncMeta(accountHash, {
        lastSyncedVersion: conflict.remoteState.version,
        dirty: false
      });
      dispatchWindowEvent(WORKSPACE_UPDATED_EVENT, { accountId: accountHash });
      this.setStatus(accountHash, 'synced');
      return;
    }

    if (resolution === 'keep_local') {
      const next: WorkspacePayload = {
        ...conflict.localState,
        version: Math.max(conflict.localState.version, conflict.remoteState.version) + 1,
        updatedAt: Date.now()
      };
      await putWorkspace(accountHash, next);
      await setSyncMeta(accountHash, {
        lastSyncedVersion: conflict.remoteState.version,
        dirty: true
      });
      await this.executePush(accountHash);
      return;
    }

    const merged = mergeWorkspaces(conflict.localState, conflict.remoteState, accountHash);
    await putWorkspace(accountHash, merged);
    await setSyncMeta(accountHash, {
      lastSyncedVersion: conflict.remoteState.version,
      dirty: true
    });
    dispatchWindowEvent(WORKSPACE_UPDATED_EVENT, { accountId: accountHash });
    await this.executePush(accountHash);
  }

  private async handleConflict(
    accountHash: string,
    localState: WorkspacePayload,
    remoteState: WorkspacePayload
  ): Promise<void> {
    const conflict: SyncConflictDetail = { localState, remoteState };
    this.unresolvedConflicts.set(accountHash, conflict);
    this.setStatus(accountHash, 'conflict');
    dispatchWindowEvent<SyncConflictDetail & { accountId: string }>(SYNC_CONFLICT_EVENT, {
      accountId: accountHash,
      localState,
      remoteState
    });
  }

  private setStatus(accountId: string, status: SyncStatus, message?: string): void {
    this.statuses.set(accountId, status);
    if (message) {
      this.statusMessages.set(accountId, message);
    } else {
      this.statusMessages.delete(accountId);
    }
    const detail: SyncStatusDetail = { accountId, status, ...(message ? { message } : {}) };
    dispatchWindowEvent(SYNC_STATUS_EVENT, detail);
    try {
      this.coordChannel?.postMessage({ type: 'status', detail });
    } catch {
      // BroadcastChannel closed or unavailable.
    }
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
    version: Math.max(localState.version, remoteState.version) + 1,
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

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
  getWorkspaceInLock,
  hasWorkspace,
  putWorkspace,
  reconcileSyncMetaAfterPush,
  setSyncMeta,
  withWorkspaceLock,
  WORKSPACE_SCHEMA_VERSION
} from './storage';
import { breakProjectParentCycles } from './schemas';
import {
  requestCancelPendingPush,
  requestEnqueuedPush,
  requestFlushPendingPushes,
  requestRemotePull,
  requestRemotePush
} from './syncClient';
import { promptFingerprint } from './promptFingerprint';
import { errorMessage, errorName } from './webext';
import type {
  ChatRef,
  EncryptedSyncEnvelope,
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

  breakProjectParentCycles(merged);
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

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        sorted[key] = canonicalizeValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

function areWorkspacesEquivalent(a: WorkspacePayload, b: WorkspacePayload): boolean {
  const normalize = (w: WorkspacePayload) => ({
    schemaVersion: w.schemaVersion,
    accountId: w.accountId,
    version: w.version,
    updatedAt: w.updatedAt,
    projects: w.projects ?? {},
    prompts: w.prompts ?? [],
    tagMeta: w.tagMeta ?? {},
    chats: w.chats ?? {}
  });
  return (
    JSON.stringify(canonicalizeValue(normalize(a))) ===
    JSON.stringify(canonicalizeValue(normalize(b)))
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
  private enqueueSeq = new Map<string, number>();
  private activeEnqueueSeqs = new Map<string, Set<number>>();
  private pendingEncryptDispatches = new Set<Promise<void>>();
  private activeEnqueuePromises = new Set<Promise<void>>();
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

  setLockedState(accountHash: string): void {
    if (!accountHash || this.keys.has(accountHash)) return;
    this.setStatus(accountHash, 'locked', 'Sync is locked — click to enter your encryption passphrase.');
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
   * here; rapid modifications within 750ms coalesce into a single remote push
   * owned by the background worker so tab-close does not drop the edit.
   */
  schedulePush(accountHash: string, snapshot?: WorkspacePayload): void {
    if (!accountHash || this.pausedAccounts.has(accountHash)) return;

    this.clearPushRetryTimer(accountHash);
    this.pushRetryAttempts.delete(accountHash);

    const existingTimer = this.pushTimers.get(accountHash);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      this.pushTimers.delete(accountHash);
    }

    if (snapshot && this.keys.has(accountHash) && this.online) {
      void this.enqueueSnapshotPush(accountHash, snapshot, PUSH_DEBOUNCE_MS);
      return;
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
    // Dispatch background flush synchronously before any await so unloading tabs
    // signal background.ts to drain already-enqueued encrypted envelopes.
    void requestFlushPendingPushes();

    // Wait for any in-flight snapshot encryption to dispatch SYNC_ENQUEUE_PUSH
    // (e.g. immediately after backup importData() -> saveWorkspace()), then
    // trigger a second flush so background.ts drains those immediately too.
    if (this.pendingEncryptDispatches.size > 0) {
      await Promise.all(Array.from(this.pendingEncryptDispatches));
      await requestFlushPendingPushes();
    }

    const pending = Array.from(this.pushTimers.keys());
    this.pushTimers.forEach((timer) => window.clearTimeout(timer));
    this.pushTimers.clear();
    const tasks = pending.map((accountHash) => this.executePush(accountHash));
    await Promise.all([
      ...tasks,
      ...Array.from(this.inFlightPushes.values()),
      ...Array.from(this.activeEnqueuePromises)
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

  private async enqueueSnapshotPush(
    accountHash: string,
    snapshot: WorkspacePayload,
    delayMs: number
  ): Promise<void> {
    const seq = (this.enqueueSeq.get(accountHash) ?? 0) + 1;
    this.enqueueSeq.set(accountHash, seq);

    let seqSet = this.activeEnqueueSeqs.get(accountHash);
    if (!seqSet) {
      seqSet = new Set<number>();
      this.activeEnqueueSeqs.set(accountHash, seqSet);
    }
    seqSet.add(seq);

    let resolveDispatch!: () => void;
    const dispatchPromise = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });
    this.pendingEncryptDispatches.add(dispatchPromise);

    const markDispatched = () => {
      if (this.pendingEncryptDispatches.delete(dispatchPromise)) {
        resolveDispatch();
      }
    };

    const removeActiveSeq = () => {
      const current = this.activeEnqueueSeqs.get(accountHash);
      if (!current) return;
      current.delete(seq);
      if (current.size === 0) {
        this.activeEnqueueSeqs.delete(accountHash);
      }
    };

    const task = (async () => {
      try {
        const key = this.keys.get(accountHash);
        if (!key) return;
        if (!this.online) {
          this.setStatus(accountHash, 'offline');
          return;
        }

        const config = await getSyncConfig();
        if (!config) {
          this.setStatus(accountHash, 'idle', 'Sync is not configured.');
          return;
        }

        const meta = await getSyncMeta(accountHash);
        const { ciphertext, iv } = await encryptWorkspace(snapshot, key);
        if (this.enqueueSeq.get(accountHash) !== seq) {
          return;
        }

        const envelope: EncryptedSyncEnvelope = {
          version: snapshot.version,
          baseVersion: meta.lastSyncedVersion,
          ciphertext,
          iv,
          updatedAt: snapshot.updatedAt
        };

        this.setStatus(accountHash, 'syncing');
        const responsePromise = requestEnqueuedPush(config, accountHash, envelope, delayMs);
        markDispatched();
        const response = await responsePromise;
        removeActiveSeq();

        if (response.success && 'superseded' in response && response.superseded) {
          return;
        }

        await this.withSyncLock(accountHash, false, () =>
          this.handlePushResponse(accountHash, snapshot, envelope, key, response)
        );
      } catch (error) {
        if (error instanceof PayloadTooLargeError || errorName(error) === 'PayloadTooLargeError') {
          this.handleErrorOutcome(accountHash, 'payload_too_large', 413, errorMessage(error), undefined, true);
          return;
        }
        debugWarn('enqueueSnapshotPush: failed (exception)', error);
        this.setStatus(
          accountHash,
          this.online ? 'error' : 'offline',
          errorMessage(error)
        );
        this.schedulePushRetry(accountHash);
      } finally {
        markDispatched();
        removeActiveSeq();
      }
    })();

    this.activeEnqueuePromises.add(task);
    try {
      await task;
    } finally {
      this.activeEnqueuePromises.delete(task);
    }
  }

  private async handlePushResponse(
    accountHash: string,
    localState: WorkspacePayload,
    envelope: EncryptedSyncEnvelope,
    key: CryptoKey,
    response: Awaited<ReturnType<typeof requestRemotePush>>
  ): Promise<void> {
    if (response.success) {
      const pushedVersion = 'data' in response ? response.data.version : localState.version;
      await this.finalizeSuccessfulPush(accountHash, pushedVersion, response.etag);
      return;
    }

    if (response.error === 'conflict' && response.serverState) {
      if (
        response.serverState.version === envelope.version &&
        response.serverState.updatedAt === envelope.updatedAt &&
        response.serverState.iv === envelope.iv &&
        response.serverState.ciphertext === envelope.ciphertext
      ) {
        debugLog('runPush: 409 matched exact pushed envelope; treating as idempotent success');
        await this.finalizeSuccessfulPush(
          accountHash,
          envelope.version,
          `"v${envelope.version}-${envelope.updatedAt}"`
        );
        return;
      }
      debugWarn('runPush: conflict detected; server state is newer');
      this.pushRetryAttempts.delete(accountHash);
      try {
        const remoteState = await decryptWorkspace(
          response.serverState.ciphertext,
          response.serverState.iv,
          key
        );
        if (
          remoteState.version === localState.version &&
          remoteState.updatedAt === localState.updatedAt &&
          areWorkspacesEquivalent(localState, remoteState)
        ) {
          debugLog('runPush: 409 matched equivalent workspace payload; treating as idempotent success');
          await this.finalizeSuccessfulPush(
            accountHash,
            remoteState.version,
            `"v${remoteState.version}-${remoteState.updatedAt}"`
          );
          return;
        }
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
      const envelope: EncryptedSyncEnvelope = {
        version: localState.version,
        baseVersion: meta.lastSyncedVersion,
        ciphertext,
        iv,
        updatedAt: localState.updatedAt
      };

      debugLog(`runPush: sending payload (version: ${localState.version}, baseVersion: ${meta.lastSyncedVersion}, updatedAt: ${localState.updatedAt})`);
      const response = await requestRemotePush(config, accountHash, envelope);
      debugLog('runPush: response received:', JSON.stringify(response));
      if (response.success && 'superseded' in response && response.superseded) {
        return;
      }
      await this.handlePushResponse(accountHash, localState, envelope, key, response);
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

  private async finalizeSuccessfulPush(
    accountHash: string,
    pushedVersion: number,
    etag?: string
  ): Promise<void> {
    this.pushRetryAttempts.delete(accountHash);
    this.pausedAccounts.delete(accountHash);
    const { stillDirty } = await reconcileSyncMetaAfterPush(
      accountHash,
      pushedVersion,
      etag
    );
    if (stillDirty) {
      const hasActiveEnqueue = (this.activeEnqueueSeqs.get(accountHash)?.size ?? 0) > 0;
      if (!hasActiveEnqueue) {
        this.schedulePush(accountHash);
      }
      this.setStatus(accountHash, 'syncing');
    } else {
      this.setStatus(accountHash, 'synced');
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
          this.pausedAccounts.delete(accountHash);
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
        this.pausedAccounts.delete(accountHash);
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

      this.pausedAccounts.delete(accountHash);

      const outcome = await withWorkspaceLock(accountHash, async () => {
        const [localState, meta] = await Promise.all([
          getWorkspaceInLock(accountHash),
          getSyncMeta(accountHash)
        ]);
        const nextEtag = response.etag ?? meta.etag;
        debugLog(`runPull: version comparison — remote: ${remoteState.version}, local: ${localState.version}, dirty: ${meta.dirty}`);

        if (remoteState.version > localState.version) {
          if (meta.dirty) {
            return { kind: 'conflict' as const, localState };
          }
          // Local-first guard: a remote payload without any content (e.g.
          // intentional deletion on another device or an unexpected server
          // reset) must never silently wipe a populated local workspace.
          // Raise an explicit conflict so the user chooses whether to keep
          // local data or adopt the empty remote state.
          if (!workspaceHasContent(remoteState) && workspaceHasContent(localState)) {
            return { kind: 'conflict' as const, localState };
          }
          debugLog('runPull: remote is newer; adopting remote state');
          await putWorkspace(accountHash, remoteState);
          await setSyncMeta(accountHash, {
            lastSyncedVersion: remoteState.version,
            dirty: false,
            localVersion: remoteState.version,
            ...(nextEtag ? { etag: nextEtag } : {})
          });
          return { kind: 'adopted' as const };
        }

        if (localState.version > remoteState.version) {
          return { kind: 'push_local' as const };
        }

        if (meta.dirty) {
          return { kind: 'conflict' as const, localState };
        }

        if (meta.lastSyncedVersion === 0 && workspaceHasContent(remoteState)) {
          const localHasProjectsOrChats =
            Object.keys(localState.projects ?? {}).length > 0 ||
            Object.keys(localState.chats ?? {}).length > 0;
          if (localHasProjectsOrChats) {
            return { kind: 'conflict' as const, localState };
          }
          debugLog('runPull: initial sync at equal version; adopting remote state');
          await putWorkspace(accountHash, remoteState);
          await setSyncMeta(accountHash, {
            lastSyncedVersion: remoteState.version,
            dirty: false,
            localVersion: remoteState.version,
            ...(nextEtag ? { etag: nextEtag } : {})
          });
          return { kind: 'adopted' as const };
        }

        if (meta.lastSyncedVersion !== remoteState.version || (nextEtag && meta.etag !== nextEtag)) {
          await setSyncMeta(accountHash, {
            lastSyncedVersion: remoteState.version,
            dirty: false,
            localVersion: localState.version,
            ...(nextEtag ? { etag: nextEtag } : {})
          });
        }
        return { kind: 'in_sync' as const };
      });

      if (outcome.kind === 'conflict') {
        debugWarn('runPull: conflicting local and remote state; raising conflict');
        await this.handleConflict(accountHash, outcome.localState, remoteState);
        return;
      }
      if (outcome.kind === 'adopted') {
        dispatchWindowEvent(WORKSPACE_UPDATED_EVENT, { accountId: accountHash });
        this.setStatus(accountHash, 'synced');
        return;
      }
      if (outcome.kind === 'push_local') {
        debugLog('runPull: local is newer; scheduling push');
        this.schedulePush(accountHash);
        return;
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
      this.enqueueSeq.set(accountHash, (this.enqueueSeq.get(accountHash) ?? 0) + 1);
      const existingTimer = this.pushTimers.get(accountHash);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        this.pushTimers.delete(accountHash);
      }
      this.clearPushRetryTimer(accountHash);
      this.pendingRepush.delete(accountHash);
      await requestCancelPendingPush(accountHash);

      await withWorkspaceLock(accountHash, async () => {
        await putWorkspace(accountHash, conflict.remoteState);
        await setSyncMeta(accountHash, {
          lastSyncedVersion: conflict.remoteState.version,
          dirty: false,
          localVersion: conflict.remoteState.version
        });
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
      await withWorkspaceLock(accountHash, async () => {
        await putWorkspace(accountHash, next);
        await setSyncMeta(accountHash, {
          lastSyncedVersion: conflict.remoteState.version,
          dirty: true,
          localVersion: next.version
        });
      });
      await this.executePush(accountHash);
      return;
    }

    const merged = mergeWorkspaces(conflict.localState, conflict.remoteState, accountHash);
    await withWorkspaceLock(accountHash, async () => {
      await putWorkspace(accountHash, merged);
      await setSyncMeta(accountHash, {
        lastSyncedVersion: conflict.remoteState.version,
        dirty: true,
        localVersion: merged.version
      });
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

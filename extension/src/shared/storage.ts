import {
  ChatRef,
  Project,
  PromptTemplate,
  SessionPassphrasePayload,
  StoredState,
  SyncConfig,
  SyncMeta,
  SyncSessionGetResult,
  SyncSessionWriteResult,
  SyncSettings,
  TagMeta,
  UiPrefs,
  WorkspacePayload
} from './types';
import {
  errorName,
  runtimeSendMessage,
  sanitizeStorageValue,
  storageLocalGet,
  storageLocalRemove,
  storageLocalSet
} from './webext';
import { normalizeChatIndex, parseWorkspace } from './schemas';
import { getRawIdentifierForHash, normalizeCanonicalChatUrl } from './account';
import { isLocalVaultEnvelope, openWorkspaceEnvelope, sealWorkspaceEnvelope, VaultLockedError, type VaultMeta } from './vault';

export const STORAGE_KEY = 'gemini_projects_v1';
export const CURRENT_SCHEMA_VERSION = 1;

/** Schema version of the hierarchical, account-partitioned workspace model. */
export const WORKSPACE_SCHEMA_VERSION = 3;
/** Legacy prompt library key used by schema v1. */
export const LEGACY_PROMPTS_KEY = 'gp_prompts_store';
/** Legacy unpartitioned active-project pointer. */
export const LEGACY_ACTIVE_PROJECT_KEY = 'activeProjectId';
/** Generic legacy keys supported for cross-source migration. */
export const LEGACY_GENERIC_PROJECTS_KEY = 'projects';
export const LEGACY_GENERIC_PROMPTS_KEY = 'gemini_prompts';
/**
 * Global one-time gate: the first account that migrates claims the legacy
 * unpartitioned data; every other account starts with an isolated workspace.
 */
export const LEGACY_MIGRATION_GATE_KEY = 'gemini_workspace_legacy_migrated';

export function getWorkspaceKey(accountHash: string): string {
  return `workspace_${accountHash}`;
}

export function getSyncMetaKey(accountHash: string): string {
  return `sync_meta_${accountHash}`;
}

export async function getSyncMeta(accountHash: string): Promise<SyncMeta> {
  const key = getSyncMetaKey(accountHash);
  const result = await storageLocalGet<Record<string, unknown>>([key]);
  const raw = result[key];
  if (!raw || typeof raw !== 'object') {
    return { lastSyncedVersion: 0, dirty: false };
  }
  const candidate = raw as Partial<SyncMeta>;
  return {
    lastSyncedVersion:
      typeof candidate.lastSyncedVersion === 'number' && Number.isFinite(candidate.lastSyncedVersion)
        ? candidate.lastSyncedVersion
        : 0,
    dirty: candidate.dirty === true,
    ...(typeof candidate.etag === 'string' && candidate.etag ? { etag: candidate.etag } : {}),
    ...(typeof candidate.localVersion === 'number' && Number.isFinite(candidate.localVersion)
      ? { localVersion: candidate.localVersion }
      : {})
  };
}

export async function setSyncMeta(accountHash: string, meta: SyncMeta): Promise<void> {
  await storageLocalSet({
    [getSyncMetaKey(accountHash)]: {
      lastSyncedVersion: meta.lastSyncedVersion,
      dirty: meta.dirty,
      ...(typeof meta.etag === 'string' && meta.etag ? { etag: meta.etag } : {}),
      ...(typeof meta.localVersion === 'number' && Number.isFinite(meta.localVersion)
        ? { localVersion: meta.localVersion }
        : {})
    }
  });
}

export async function markSyncDirty(accountHash: string, localVersion?: number): Promise<void> {
  const current = await getSyncMeta(accountHash);
  const nextLocalVersion =
    typeof localVersion === 'number' && Number.isFinite(localVersion)
      ? localVersion
      : current.localVersion;
  if (!current.dirty || nextLocalVersion !== current.localVersion) {
    await setSyncMeta(accountHash, {
      ...current,
      dirty: true,
      ...(nextLocalVersion !== undefined ? { localVersion: nextLocalVersion } : {})
    });
  }
}

export function getLegacyMigrationFlagKey(accountHash: string): string {
  return `gemini_workspace_legacy_migrated_${accountHash}`;
}

export function createEmptyWorkspace(accountHash: string): WorkspacePayload {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    accountId: accountHash,
    version: 1,
    updatedAt: Date.now(),
    projects: {},
    prompts: [],
    tagMeta: {}
  };
}

export function createEmptyState(): StoredState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    chatIndex: {},
    uiPrefs: { projectsCollapsed: false, foldersCollapsed: false }
  };
}

export function normalizeUiPrefs(raw: unknown): { projectsCollapsed: boolean; foldersCollapsed: boolean } {
  const candidate = raw && typeof raw === 'object' ? (raw as Partial<UiPrefs>) : {};
  return {
    projectsCollapsed: candidate.projectsCollapsed === true,
    foldersCollapsed: candidate.foldersCollapsed === true
  };
}

/**
 * Normalizes a raw chat index (legacy or synced) into validated ChatRefs.
 * The Xray-safe implementation lives in schemas.ts alongside parseWorkspace;
 * re-exported here for the legacy migration path.
 */
export { normalizeChatIndex };

interface LegacyPromptRecord {
  id?: unknown;
  title?: unknown;
  content?: unknown;
  tags?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  usageCount?: unknown;
  lastUsedAt?: unknown;
  isFavorite?: unknown;
}

interface LegacyPromptsStore {
  prompts?: Record<string, LegacyPromptRecord>;
  tagMeta?: Record<string, TagMeta>;
  version?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractLegacyProjects(storage: Record<string, unknown>): unknown[] {
  const legacyState = asRecord(storage[STORAGE_KEY]);
  const fromLegacyState = legacyState && Array.isArray(legacyState.projects)
    ? legacyState.projects
    : [];
  const fromGenericKey = Array.isArray(storage[LEGACY_GENERIC_PROJECTS_KEY])
    ? (storage[LEGACY_GENERIC_PROJECTS_KEY] as unknown[])
    : [];

  return fromLegacyState.length > 0 ? fromLegacyState : fromGenericKey;
}

function extractLegacyPrompts(storage: Record<string, unknown>): {
  prompts: LegacyPromptRecord[];
  tagMeta: Record<string, TagMeta> | null;
} {
  const promptsStore = asRecord(storage[LEGACY_PROMPTS_KEY]) as LegacyPromptsStore | null;
  const fromPromptsStore = promptsStore?.prompts && typeof promptsStore.prompts === 'object'
    ? Object.values(promptsStore.prompts)
    : [];
  const fromGenericKey = Array.isArray(storage[LEGACY_GENERIC_PROMPTS_KEY])
    ? (storage[LEGACY_GENERIC_PROMPTS_KEY] as LegacyPromptRecord[])
    : [];

  return {
    prompts: fromPromptsStore.length > 0 ? fromPromptsStore : fromGenericKey,
    tagMeta: promptsStore?.tagMeta && typeof promptsStore.tagMeta === 'object'
      ? promptsStore.tagMeta
      : null
  };
}

function toWorkspaceProject(raw: unknown, index: number): Project {
  const record = asRecord(raw) ?? {};
  const now = Date.now();
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : now;
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : now;
  const sortIndex = typeof record.sortIndex === 'number' ? record.sortIndex : index;
  const chatIds = Array.isArray(record.chatIds)
    ? (record.chatIds as unknown[]).filter((id): id is string => typeof id === 'string')
    : undefined;

  return {
    id: typeof record.id === 'string' && record.id ? record.id : `legacy_project_${index}`,
    name: typeof record.name === 'string' && record.name ? record.name : 'Untitled',
    kind: 'project',
    parentId: null,
    icon: (typeof record.icon === 'string' ? record.icon : 'default') as Project['icon'],
    color: typeof record.color === 'string' ? record.color : undefined,
    ...(chatIds ? { chatIds } : {}),
    isPinned: record.isPinned === true || record.pinned === true,
    createdAt,
    updatedAt,
    sortIndex,
    order: index
  };
}

function toPromptTemplate(raw: LegacyPromptRecord, index: number): PromptTemplate {
  const now = Date.now();
  const tags = Array.isArray(raw.tags)
    ? (raw.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string')
    : [];

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `legacy_prompt_${index}`,
    title: typeof raw.title === 'string' && raw.title ? raw.title : 'Untitled',
    content: typeof raw.content === 'string' ? raw.content : '',
    tags,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    ...(typeof raw.usageCount === 'number' ? { usageCount: raw.usageCount } : {}),
    ...(typeof raw.lastUsedAt === 'number' ? { lastUsedAt: raw.lastUsedAt } : {}),
    ...(typeof raw.isFavorite === 'boolean' ? { isFavorite: raw.isFavorite } : {})
  };
}

const workspaceMutationQueues = new Map<string, Promise<unknown>>();

/**
 * Serializes read-modify-write workspace operations per account hash using
 * navigator.locks when available, falling back to an in-memory promise queue.
 */
export function withWorkspaceLock<T>(accountHash: string, fn: () => Promise<T>): Promise<T> {
  const lockManager = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (lockManager && typeof lockManager.request === 'function') {
    return lockManager.request(`gp_ws_${accountHash}`, () => fn()) as Promise<T>;
  }

    const previous = workspaceMutationQueues.get(accountHash) ?? Promise.resolve();
    const run = previous.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  workspaceMutationQueues.set(accountHash, tail);
  void tail.finally(() => {
    if (workspaceMutationQueues.get(accountHash) === tail) {
      workspaceMutationQueues.delete(accountHash);
    }
  });
  return run;
}

/**
 * Converts unpartitioned schema v1 data (flat projects, chat index, prompt
 * store) into a validated hierarchical WorkspacePayload for the given account
 * hash and persists it — already vault-sealed — under
 * `workspace_${accountHash}`. Legacy keys are flagged (never deleted) so
 * migration never destroys user data.
 */
async function migrateLegacyDataUnlocked(accountHash: string): Promise<WorkspacePayload> {
  const gateResult = await storageLocalGet<Record<string, unknown>>([
    LEGACY_MIGRATION_GATE_KEY,
    STORAGE_KEY,
    LEGACY_PROMPTS_KEY,
    LEGACY_ACTIVE_PROJECT_KEY,
    LEGACY_GENERIC_PROJECTS_KEY,
    LEGACY_GENERIC_PROMPTS_KEY
  ]);

  const legacyAlreadyClaimed = gateResult[LEGACY_MIGRATION_GATE_KEY] !== undefined;
  const legacyProjects = legacyAlreadyClaimed ? [] : extractLegacyProjects(gateResult);
  const legacyPrompts = legacyAlreadyClaimed
    ? { prompts: [] as LegacyPromptRecord[], tagMeta: null as Record<string, TagMeta> | null }
    : extractLegacyPrompts(gateResult);
  const legacyState = legacyAlreadyClaimed ? null : asRecord(gateResult[STORAGE_KEY]);

  const projects: Record<string, Project> = {};
  legacyProjects.forEach((raw, index) => {
    const project = toWorkspaceProject(raw, index);
    projects[project.id] = project;
  });

  const prompts = legacyPrompts.prompts.map(toPromptTemplate);

  const payload = normalizeWorkspacePayload({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    accountId: accountHash,
    version: 1,
    updatedAt: Date.now(),
    projects,
    prompts,
    ...(legacyPrompts.tagMeta ? { tagMeta: legacyPrompts.tagMeta } : {}),
    // Chat assignments and sidebar preferences from the legacy unpartitioned
    // store follow their projects into the claiming account's partition.
    chats: legacyState ? normalizeChatIndex(legacyState.chatIndex) : {},
    uiPrefs: legacyState ? normalizeUiPrefs(legacyState.uiPrefs) : undefined
  }, accountHash);

  await writeWorkspaceEnvelope(accountHash, payload);
  await storageLocalSet({
    [getLegacyMigrationFlagKey(accountHash)]: {
      migratedAt: Date.now(),
      sourceProjects: legacyProjects.length,
      sourcePrompts: legacyPrompts.prompts.length
    }
  });
  if (!legacyAlreadyClaimed) {
    await storageLocalSet({
      [LEGACY_MIGRATION_GATE_KEY]: { migratedAt: Date.now(), claimedBy: accountHash }
    });
  }

  return payload;
}

export function migrateLegacyData(accountHash: string): Promise<WorkspacePayload> {
  return withWorkspaceLock(accountHash, () => migrateLegacyDataUnlocked(accountHash));
}

/** Fills schema-v3 defaults so callers never see missing chats/uiPrefs. */
function normalizeWorkspacePayload(payload: WorkspacePayload, accountHash: string): WorkspacePayload {
  return {
    ...payload,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    accountId: accountHash,
    chats: payload.chats && typeof payload.chats === 'object' ? payload.chats : {},
    uiPrefs: normalizeUiPrefs(payload.uiPrefs)
  };
}

const vaultLockedNotified = new Set<string>();

function notifyVaultLocked(accountHash: string): void {
  if (vaultLockedNotified.has(accountHash)) return;
  vaultLockedNotified.add(accountHash);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('gemini-workspace:vault-locked', { detail: { accountId: accountHash } }));
  }
}

async function getWorkspaceUnlocked(accountHash: string, insideLock: boolean): Promise<WorkspacePayload> {
  const key = getWorkspaceKey(accountHash);
  const result = await storageLocalGet<Record<string, unknown>>([key]);
  const raw = result[key];

  if (raw !== undefined && raw !== null) {
    try {
      const rawIdentifier = await requireRawIdentifier(accountHash);
      const opened = await openWorkspaceEnvelope(accountHash, rawIdentifier, raw);
      if (opened) {
        return normalizeWorkspacePayload(opened.payload, accountHash);
      }
      throw new Error('Workspace partition was empty.');
    } catch (error) {
      if (errorName(error) === 'VaultLockedError') {
        notifyVaultLocked(accountHash);
        throw error;
      }
      // Never fall back to migration here: the partition holds real user
      // data that failed to open, and migrateLegacyData would overwrite it.
      console.warn('[gemini-projects] workspace partition failed to open', error);
      throw error;
    }
  }

  return insideLock ? migrateLegacyDataUnlocked(accountHash) : migrateLegacyData(accountHash);
}

/**
 * Loads the account-partitioned workspace. The stored form is always an
 * encrypted vault envelope; plaintext payloads from before this update are
 * accepted once and sealed on the next write.
 */
export function getWorkspace(accountHash: string): Promise<WorkspacePayload> {
  return getWorkspaceUnlocked(accountHash, false);
}

/** Reads the workspace when the caller already holds `withWorkspaceLock(accountHash, ...)`. */
export function getWorkspaceInLock(accountHash: string): Promise<WorkspacePayload> {
  return getWorkspaceUnlocked(accountHash, true);
}

/**
 * Resolves the raw account identity that owns a workspace partition. Without
 * it the vault key cannot be derived, so a missing identity is fatal for
 * encrypted partitions (plaintext/legacy partitions can still migrate).
 */
async function requireRawIdentifier(accountHash: string): Promise<string> {
  const rawIdentifier = await getRawIdentifierForHash(accountHash);
  if (!rawIdentifier) {
    throw new VaultLockedError(accountHash);
  }
  return rawIdentifier;
}

/** Cheap salt lookup: the salt is not secret, so no decryption is needed. */
async function existingVaultMeta(accountHash: string): Promise<VaultMeta | undefined> {
  const key = getWorkspaceKey(accountHash);
  const result = await storageLocalGet<Record<string, unknown>>([key]);
  const raw = result[key];
  if (isLocalVaultEnvelope(raw)) return raw.vault;
  return undefined;
}

/** Seals and persists the encrypted workspace envelope for an account. */
async function writeWorkspaceEnvelope(accountHash: string, payload: WorkspacePayload): Promise<void> {
  // parseWorkspace is the Xray-safe validator: it never touches the
  // prototype chain of the (possibly cross-compartment) input.
  const validated = parseWorkspace(payload);
  const rawIdentifier = await requireRawIdentifier(accountHash);
  const meta = await existingVaultMeta(accountHash);
  const envelope = await sealWorkspaceEnvelope(accountHash, rawIdentifier, validated, meta);
  await storageLocalSet({ [getWorkspaceKey(accountHash)]: envelope });
}

export function getLocalUiPrefsKey(accountHash: string): string {
  return `gp_ui_prefs_${accountHash}`;
}

export async function getLocalUiPrefs(accountHash: string): Promise<UiPrefs | null> {
  const key = getLocalUiPrefsKey(accountHash);
  const result = await storageLocalGet<Record<string, unknown>>([key]);
  const raw = result[key];
  if (!raw || typeof raw !== 'object') return null;
  return normalizeUiPrefs(raw);
}

export async function setLocalUiPrefs(accountHash: string, prefs: Partial<UiPrefs>): Promise<UiPrefs> {
  const existing = await getLocalUiPrefs(accountHash);
  const next = normalizeUiPrefs({ ...(existing ?? {}), ...prefs });
  await storageLocalSet({ [getLocalUiPrefsKey(accountHash)]: next });
  return next;
}

/**
 * Drops unassigned, unpinned chats from persisted workspace state and
 * normalizes `lastUrl` to an account-index-independent canonical path.
 */
function pruneWorkspaceChats(chats: Record<string, ChatRef> | undefined): Record<string, ChatRef> {
  const pruned: Record<string, ChatRef> = {};
  if (!chats || typeof chats !== 'object') return pruned;
  Object.entries(chats).forEach(([conversationId, chat]) => {
    if (!chat) return;
    if (!chat.projectId && chat.isPinned !== true) return;
    pruned[conversationId] = {
      ...chat,
      lastUrl: normalizeCanonicalChatUrl(chat.lastUrl, chat.conversationId)
    };
  });
  return pruned;
}

export async function saveWorkspace(accountHash: string, data: WorkspacePayload): Promise<void> {
  const next: WorkspacePayload = {
    ...data,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    accountId: accountHash,
    version: (typeof data.version === 'number' ? data.version : 0) + 1,
    updatedAt: Date.now(),
    chats: pruneWorkspaceChats(data.chats)
  };
  const validated = normalizeWorkspacePayload(next, accountHash);
  await writeWorkspaceEnvelope(accountHash, validated);
  await markSyncDirty(accountHash, validated.version);
  notifyWorkspaceSaved(accountHash);
}

/**
 * Reconciles sync metadata after a push succeeds while holding the workspace
 * lock, preserving `dirty: true` if a concurrent local edit bumped the
 * workspace version while the network request was in flight.
 */
export function reconcileSyncMetaAfterPush(
  accountHash: string,
  pushedVersion: number,
  etag?: string
): Promise<{ stillDirty: boolean; currentVersion: number }> {
  return withWorkspaceLock(accountHash, async () => {
    const [currentWorkspace, currentMeta] = await Promise.all([
      getWorkspaceUnlocked(accountHash, true),
      getSyncMeta(accountHash)
    ]);
    const stillDirty = currentWorkspace.version > pushedVersion;
    const nextEtag = etag ?? (!stillDirty ? currentMeta.etag : undefined);
    await setSyncMeta(accountHash, {
      lastSyncedVersion: Math.max(currentMeta.lastSyncedVersion, pushedVersion),
      dirty: stillDirty,
      localVersion: currentWorkspace.version,
      ...(nextEtag ? { etag: nextEtag } : {})
    });
    return { stillDirty, currentVersion: currentWorkspace.version };
  });
}

/**
 * Seeds default prompts on a brand-new v1 workspace without bumping the
 * revision counter, marking sync dirty, or scheduling a push.
 */
export function seedWorkspacePrompts(
  accountHash: string,
  prompts: PromptTemplate[],
  tagMeta?: Record<string, TagMeta>
): Promise<boolean> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    if (workspace.version !== 1 || workspace.prompts.length > 0) {
      return false;
    }
    const seeded = normalizeWorkspacePayload({
      ...workspace,
      prompts,
      ...(tagMeta !== undefined ? { tagMeta } : {})
    }, accountHash);
    await writeWorkspaceEnvelope(accountHash, seeded);
    return true;
  });
}

/**
 * Persists a workspace payload exactly as provided, without bumping the
 * revision counter. Used by the sync engine when adopting a remote state
 * (auto-pull and conflict resolution) so server versions stay authoritative.
 * Deliberately does NOT fire the saved-listener: adopting remote data must
 * never schedule a redundant re-push.
 */
export async function putWorkspace(accountHash: string, data: WorkspacePayload): Promise<void> {
  const validated = normalizeWorkspacePayload({
    ...data,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    accountId: accountHash
  }, accountHash);
  await writeWorkspaceEnvelope(accountHash, validated);
}

/** True when a workspace partition already exists on disk (no migration side effects). */
export async function hasWorkspace(accountHash: string): Promise<boolean> {
  const key = getWorkspaceKey(accountHash);
  const result = await storageLocalGet<Record<string, unknown>>([key]);
  return result[key] !== undefined;
}

type WorkspaceSavedListener = (accountHash: string) => void;

const workspaceSavedListeners = new Set<WorkspaceSavedListener>();

function notifyWorkspaceSaved(accountHash: string): void {
  workspaceSavedListeners.forEach((listener) => {
    try {
      listener(accountHash);
    } catch (error) {
      console.warn('[gemini-projects] workspace saved listener failed', error);
    }
  });
}

/**
 * Registers a callback fired after every workspace partition write. The sync
 * engine uses this hook to debounce a remote push whenever local data changes.
 * Returns an unsubscribe function.
 */
export function onWorkspaceSaved(listener: WorkspaceSavedListener): () => void {
  workspaceSavedListeners.add(listener);
  return () => {
    workspaceSavedListeners.delete(listener);
  };
}

/* ------------------------------------------------------------------ *
 * Sync connection settings (user-configured VPS endpoint)
 * ------------------------------------------------------------------ */

export const SYNC_CONFIG_KEY = 'gemini_sync_config';

export async function getSyncConfig(): Promise<SyncConfig | null> {
  const result = await storageLocalGet<Record<string, unknown>>([SYNC_SETTINGS_KEY, SYNC_CONFIG_KEY]);
  const fromSettings = normalizeSyncConfig(result[SYNC_SETTINGS_KEY]);
  if (fromSettings) return fromSettings;

  // Fall back to the legacy pre-settings config key — but migrate it forward
  // immediately so a stale legacy entry can never shadow the user's newer
  // settings again (this shadowing caused persistent 401s after re-saving).
  const legacy = normalizeSyncConfig(result[SYNC_CONFIG_KEY]);
  if (!legacy) return null;

  const settingsRaw = result[SYNC_SETTINGS_KEY];
  if (settingsRaw && typeof settingsRaw === 'object') {
    await saveSyncSettings({
      ...(settingsRaw as Partial<SyncSettings>),
      ...legacy
    } as SyncSettings);
  } else {
    await saveSyncSettings({ ...createDefaultSyncSettings(), ...legacy });
  }
  await storageLocalRemove(SYNC_CONFIG_KEY);
  return legacy;
}

function normalizeSyncConfig(raw: unknown): SyncConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<SyncConfig>;
  const serverUrl = typeof candidate.serverUrl === 'string' ? candidate.serverUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof candidate.apiKey === 'string' ? candidate.apiKey.trim() : '';
  if (!serverUrl || !apiKey) return null;
  return { serverUrl, apiKey };
}

export async function saveSyncConfig(config: SyncConfig): Promise<void> {
  const normalized: SyncConfig = {
    serverUrl: config.serverUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey
  };
  await storageLocalSet({ [SYNC_CONFIG_KEY]: normalized });
}

/* ------------------------------------------------------------------ *
 * Sync settings (server connection + per-account passphrase map)
 * ------------------------------------------------------------------ */

export const SYNC_SETTINGS_KEY = 'gemini_sync_settings';
export const SYNC_SESSION_PASSPHRASE_KEY = 'gemini_sync_session_passphrases';

let lastLocalSettingsWriteId: string | null = null;

function generateSettingsWriteId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Returns true when a `SYNC_SETTINGS_KEY` `storage.onChanged` event matches
 * the write most recently performed by this tab, so the tab does not clear
 * and re-derive its own freshly derived encryption key.
 */
export function isOwnSyncSettingsChange(newValue: unknown): boolean {
  if (!lastLocalSettingsWriteId || !newValue || typeof newValue !== 'object') return false;
  try {
    const sanitized = sanitizeStorageValue(newValue) as { settingsWriteId?: unknown };
    return sanitized.settingsWriteId === lastLocalSettingsWriteId;
  } catch {
    return false;
  }
}

async function readSessionPassphrases(): Promise<SessionPassphrasePayload | null> {
  try {
    const result = await runtimeSendMessage<SyncSessionGetResult>({ action: 'SYNC_SESSION_GET' });
    if (result?.ok) {
      return result.data ?? null;
    }
    console.warn('[gemini-projects] failed to read session passphrases', result?.error);
    return null;
  } catch (error) {
    console.warn('[gemini-projects] session passphrase IPC read failed', error);
    return null;
  }
}

async function writeSessionPassphrases(payload: SessionPassphrasePayload): Promise<SyncSessionWriteResult> {
  const result = await runtimeSendMessage<SyncSessionWriteResult>({
    action: 'SYNC_SESSION_SET',
    payload
  });
  if (!result?.ok) {
    throw new Error(result?.error || 'Failed to store session passphrase.');
  }
  return result;
}

/** Clears session-scoped sync passphrases held in the trusted background context. */
export async function clearSessionPassphrases(): Promise<void> {
  try {
    await runtimeSendMessage<SyncSessionWriteResult>({ action: 'SYNC_SESSION_CLEAR' });
  } catch (error) {
    console.warn('[gemini-projects] failed to clear session passphrases', error);
  }
}

function extractPassphraseMap(raw: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return result;
  Object.entries(raw as Record<string, unknown>).forEach(([accountId, value]) => {
    if (typeof value === 'string') result[accountId] = value;
  });
  return result;
}

export function createDefaultSyncSettings(): SyncSettings {
  return {
    serverUrl: '',
    apiKey: '',
    useGlobalPassphrase: true,
    accountPassphrases: {},
    rememberPassphraseOnDisk: false
  };
}

export async function getSyncSettings(): Promise<SyncSettings> {
  const [localResult, sessionRaw] = await Promise.all([
    storageLocalGet<Record<string, unknown>>([SYNC_SETTINGS_KEY]),
    readSessionPassphrases()
  ]);
  const raw = localResult[SYNC_SETTINGS_KEY];

  const sessionGlobal = typeof sessionRaw?.globalPassphrase === 'string' ? sessionRaw.globalPassphrase : undefined;
  const sessionAccounts = extractPassphraseMap(sessionRaw?.accountPassphrases);

  if (!raw || typeof raw !== 'object') {
    const defaults = createDefaultSyncSettings();
    return {
      ...defaults,
      ...(sessionGlobal !== undefined ? { globalPassphrase: sessionGlobal } : {}),
      accountPassphrases: sessionAccounts
    };
  }

  const candidate = raw as Partial<SyncSettings>;
  const serverUrl = typeof candidate.serverUrl === 'string' ? candidate.serverUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof candidate.apiKey === 'string' ? candidate.apiKey : '';
  const localGlobal = typeof candidate.globalPassphrase === 'string' ? candidate.globalPassphrase : undefined;
  const localAccounts = extractPassphraseMap(candidate.accountPassphrases);
  const globalPassphrase = sessionGlobal ?? localGlobal;

  return {
    serverUrl,
    apiKey,
    useGlobalPassphrase: candidate.useGlobalPassphrase !== false,
    ...(globalPassphrase !== undefined ? { globalPassphrase } : {}),
    accountPassphrases: { ...localAccounts, ...sessionAccounts },
    rememberPassphraseOnDisk: candidate.rememberPassphraseOnDisk === true
  };
}

export async function saveSyncSettings(settings: SyncSettings): Promise<void> {
  const rememberOnDisk = settings.rememberPassphraseOnDisk === true;
  const accountPassphrases = { ...(settings.accountPassphrases ?? {}) };
  const sessionPayload: SessionPassphrasePayload = {
    ...(settings.globalPassphrase ? { globalPassphrase: settings.globalPassphrase } : {}),
    accountPassphrases
  };

  try {
    await writeSessionPassphrases(sessionPayload);
  } catch (error) {
    if (!rememberOnDisk) {
      throw error;
    }
    console.warn('[gemini-projects] session passphrase write failed while disk persistence is enabled', error);
  }

  const writeId = generateSettingsWriteId();
  lastLocalSettingsWriteId = writeId;

  const normalized: SyncSettings = {
    serverUrl: settings.serverUrl.trim().replace(/\/+$/, ''),
    apiKey: settings.apiKey,
    useGlobalPassphrase: settings.useGlobalPassphrase === true,
    rememberPassphraseOnDisk: rememberOnDisk,
    ...(rememberOnDisk && settings.globalPassphrase ? { globalPassphrase: settings.globalPassphrase } : {}),
    accountPassphrases: rememberOnDisk ? accountPassphrases : {},
    passphraseUpdatedAt: Date.now(),
    settingsWriteId: writeId
  };
  await storageLocalSet({ [SYNC_SETTINGS_KEY]: normalized });
}

/* ------------------------------------------------------------------ *
 * Feature settings (local behavior toggles, never synced)
 * ------------------------------------------------------------------ */

export const FEATURE_SETTINGS_KEY = 'gp_feature_settings';
/** Fired (with the new settings as detail) after they are persisted. */
export const FEATURE_SETTINGS_CHANGED_EVENT = 'gemini-projects:feature-settings-changed';

export interface FeatureSettings {
  /** Automatically prepend the project's system prompt & notes to messages. */
  autoApplyProjectInstructions: boolean;
  /** Show the manual "Add instructions" header button in project chats. */
  showInstructionsButton: boolean;
  /** Print [sync-debug] diagnostics to the console (default: off). */
  debugLogging: boolean;
}

export function createDefaultFeatureSettings(): FeatureSettings {
  return { autoApplyProjectInstructions: true, showInstructionsButton: false, debugLogging: false };
}

export async function getFeatureSettings(): Promise<FeatureSettings> {
  const result = await storageLocalGet<Record<string, unknown>>([FEATURE_SETTINGS_KEY]);
  const raw = result[FEATURE_SETTINGS_KEY];
  if (!raw || typeof raw !== 'object') return createDefaultFeatureSettings();
  const candidate = raw as Partial<FeatureSettings>;
  return {
    autoApplyProjectInstructions: candidate.autoApplyProjectInstructions !== false,
    showInstructionsButton: candidate.showInstructionsButton === true,
    debugLogging: candidate.debugLogging === true
  };
}

export async function saveFeatureSettings(settings: FeatureSettings): Promise<void> {
  const normalized: FeatureSettings = {
    autoApplyProjectInstructions: settings.autoApplyProjectInstructions === true,
    showInstructionsButton: settings.showInstructionsButton === true,
    debugLogging: settings.debugLogging === true
  };
  await storageLocalSet({ [FEATURE_SETTINGS_KEY]: normalized });
  setDebugLoggingEnabled(normalized.debugLogging);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FEATURE_SETTINGS_CHANGED_EVENT, { detail: normalized }));
  }
}

/* ------------------------------------------------------------------ *
 * Debug logging gate: every [sync-debug] console statement in the
 * extension runs through these helpers and stays silent unless the
 * user enabled the debug checkbox in the settings dialog.
 * ------------------------------------------------------------------ */

let debugLoggingEnabled = false;

export function setDebugLoggingEnabled(value: boolean): void {
  debugLoggingEnabled = value;
}

export function isDebugLoggingEnabled(): boolean {
  return debugLoggingEnabled;
}

/** Console.log behind the debug checkbox. */
export function debugLog(...args: unknown[]): void {
  if (debugLoggingEnabled) console.log('[sync-debug]', ...args);
}

/** Console.warn behind the debug checkbox. */
export function debugWarn(...args: unknown[]): void {
  if (debugLoggingEnabled) console.warn('[sync-debug]', ...args);
}

/**
 * Loads the debug flag from persisted feature settings (and keeps it live on
 * changes). Called once during content-script bootstrap so the gate reflects
 * the checkbox state without waiting for the settings dialog to be opened.
 */
export async function initDebugLoggingFlag(): Promise<void> {
  try {
    const settings = await getFeatureSettings();
    setDebugLoggingEnabled(settings.debugLogging);
  } catch {
    // Storage unavailable (e.g. during extension reload): keep current state.
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(FEATURE_SETTINGS_CHANGED_EVENT, (event) => {
    const detail = (event as CustomEvent).detail as Partial<FeatureSettings> | undefined;
    setDebugLoggingEnabled(detail?.debugLogging === true);
  });
}

function nextSiblingOrder(workspace: WorkspacePayload, parentId: string | null): number {
  return Object.values(workspace.projects)
    .filter((project) => project.parentId === parentId)
    .reduce((max, project) => Math.max(max, project.order), -1) + 1;
}

export function addFolder(
  accountHash: string,
  parentId: string | null,
  name: string
): Promise<Project> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    const now = Date.now();
    const order = nextSiblingOrder(workspace, parentId);

    const folder: Project = {
      id: crypto.randomUUID(),
      name,
      kind: 'folder',
      parentId,
      icon: 'default',
      chatIds: [],
      createdAt: now,
      updatedAt: now,
      sortIndex: order,
      order
    };

    workspace.projects[folder.id] = folder;
    await saveWorkspace(accountHash, workspace);
    return folder;
  });
}

const MUTABLE_PROJECT_FIELDS = [
  'name',
  'parentId',
  'systemPrompt',
  'notes',
  'color',
  'icon',
  'chatIds',
  'isPinned',
  'sortIndex',
  'order'
] as const;

export function updateProjectMetadata(
  accountHash: string,
  id: string,
  updates: Partial<Project>
): Promise<void> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    const existing = workspace.projects[id];
    if (!existing) {
      throw new Error(`Project not found: ${id}`);
    }

    const merged: Project = { ...existing };
    for (const field of MUTABLE_PROJECT_FIELDS) {
      if (field in updates && updates[field] !== undefined) {
        (merged as unknown as Record<string, unknown>)[field] = updates[field];
      }
    }
    merged.updatedAt = Date.now();

    workspace.projects[id] = merged;
    await saveWorkspace(accountHash, workspace);
  });
}

/* ------------------------------------------------------------------ *
 * Account-partitioned mutation helpers
 *
 * Every workspace mutation lives in the content script that resolved the
 * active account, so the browser-global legacy state is gone: all data is
 * written to (and read from) the encrypted per-account vault partition.
 * Each helper returns the derived runtime view so callers can refresh the
 * sidebar without a second read.
 * ------------------------------------------------------------------ */

/** Derives the flat runtime view the sidebar renders from a workspace. */
export function workspaceToStoredState(workspace: WorkspacePayload): StoredState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: Object.values(workspace.projects),
    chatIndex: { ...(workspace.chats ?? {}) },
    uiPrefs: normalizeUiPrefs(workspace.uiPrefs)
  };
}

export function upsertWorkspaceProject(
  accountHash: string,
  project: Project
): Promise<StoredState> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    const existing = workspace.projects[project.id];
    workspace.projects[project.id] = existing
      ? { ...existing, ...project, updatedAt: project.updatedAt ?? Date.now() }
      : project;
    await saveWorkspace(accountHash, workspace);
    return workspaceToStoredState(workspace);
  });
}

export function setWorkspaceProjectPinned(
  accountHash: string,
  projectId: string,
  isPinned: boolean
): Promise<StoredState> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    const project = workspace.projects[projectId];
    if (!project) {
      throw new Error('Project not found');
    }
    workspace.projects[projectId] = { ...project, isPinned, updatedAt: Date.now() };
    await saveWorkspace(accountHash, workspace);
    return workspaceToStoredState(workspace);
  });
}

export function deleteWorkspaceProject(
  accountHash: string,
  projectId: string
): Promise<StoredState> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    const doomed = new Set<string>([projectId]);
    let grew = true;
    while (grew) {
      grew = false;
      Object.values(workspace.projects).forEach((item) => {
        if (item.parentId && doomed.has(item.parentId) && !doomed.has(item.id)) {
          doomed.add(item.id);
          grew = true;
        }
      });
    }

    doomed.forEach((id) => {
      delete workspace.projects[id];
    });

    const chats = workspace.chats ?? {};
    Object.keys(chats).forEach((conversationId) => {
      const chat = chats[conversationId];
      if (chat.projectId && doomed.has(chat.projectId)) {
        if (chat.isPinned) {
          chats[conversationId] = { ...chat, projectId: null };
        } else {
          delete chats[conversationId];
        }
      }
    });

    await saveWorkspace(accountHash, workspace);
    return workspaceToStoredState(workspace);
  });
}

export function moveWorkspaceChat(
  accountHash: string,
  conversationId: string,
  projectId: string | null
): Promise<StoredState> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    const chats = workspace.chats ?? (workspace.chats = {});
    const existing = chats[conversationId];
    if (projectId === null && existing?.isPinned !== true) {
      delete chats[conversationId];
    } else {
      chats[conversationId] = {
        conversationId,
        title: existing?.title ?? '',
        isPinned: existing?.isPinned ?? false,
        projectId,
        updatedAt: Date.now(),
        lastUrl: normalizeCanonicalChatUrl(existing?.lastUrl, conversationId)
      };
    }
    await saveWorkspace(accountHash, workspace);
    return workspaceToStoredState(workspace);
  });
}

export function setWorkspaceChatPinned(
  accountHash: string,
  conversationId: string,
  isPinned: boolean
): Promise<StoredState> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    const chats = workspace.chats ?? (workspace.chats = {});
    const existing = chats[conversationId];
    if (!isPinned && !existing?.projectId) {
      delete chats[conversationId];
    } else {
      // A chat can be pinned before it ever gets a workspace record (e.g. pinned
      // in Gemini's sidebar and then moved into a project): create the record so
      // the pin state survives instead of being silently dropped.
      chats[conversationId] = {
        conversationId,
        title: existing?.title ?? '',
        isPinned,
        projectId: existing?.projectId ?? null,
        updatedAt: Date.now(),
        lastUrl: normalizeCanonicalChatUrl(existing?.lastUrl, conversationId)
      };
    }
    await saveWorkspace(accountHash, workspace);
    return workspaceToStoredState(workspace);
  });
}

export function upsertWorkspaceChatRefs(
  accountHash: string,
  chats: ChatRef[]
): Promise<StoredState> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    const index = workspace.chats ?? (workspace.chats = {});
    chats.forEach((chat) => {
      const existing = index[chat.conversationId];
      const nextProjectId = chat.projectId ?? existing?.projectId ?? null;
      const nextPinned = typeof chat.isPinned === 'boolean' ? chat.isPinned : (existing?.isPinned ?? false);
      if (!nextProjectId && !nextPinned) {
        delete index[chat.conversationId];
        return;
      }
      index[chat.conversationId] = {
        conversationId: chat.conversationId,
        title: chat.title || existing?.title || '',
        isPinned: nextPinned,
        projectId: nextProjectId,
        updatedAt: chat.updatedAt ?? existing?.updatedAt ?? Date.now(),
        lastUrl: normalizeCanonicalChatUrl(chat.lastUrl ?? existing?.lastUrl, chat.conversationId)
      };
    });
    await saveWorkspace(accountHash, workspace);
    return workspaceToStoredState(workspace);
  });
}

export function updateWorkspaceUiPrefs(
  accountHash: string,
  prefs: Partial<UiPrefs>
): Promise<StoredState> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    workspace.uiPrefs = { ...normalizeUiPrefs(workspace.uiPrefs), ...prefs };
    await saveWorkspace(accountHash, workspace);
    return workspaceToStoredState(workspace);
  });
}

export function updateWorkspacePrompts(
  accountHash: string,
  prompts: PromptTemplate[],
  tagMeta?: Record<string, TagMeta>
): Promise<void> {
  return withWorkspaceLock(accountHash, async () => {
    const workspace = await getWorkspaceUnlocked(accountHash, true);
    workspace.schemaVersion = WORKSPACE_SCHEMA_VERSION;
    workspace.prompts = prompts;
    workspace.tagMeta = tagMeta;
    await saveWorkspace(accountHash, workspace);
  });
}

/** Builds the per-project JSON export (project metadata + chat listing). */
export async function exportWorkspaceProject(
  accountHash: string,
  projectId: string
): Promise<{ json: string; filename: string } | null> {
  const workspace = await getWorkspace(accountHash);
  const project = workspace.projects[projectId];
  if (!project) return null;

  const chats = Object.values(workspace.chats ?? {})
    .filter((chat) => chat.projectId === project.id)
    .map((chat) => ({ conversationId: chat.conversationId, title: chat.title }));
  const payload = {
    project: {
      id: project.id,
      name: project.name,
      icon: project.icon,
      color: project.color ?? null,
      isPinned: project.isPinned === true,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      sortIndex: project.sortIndex
    },
    chats
  };
  const filename = `${sanitizeWorkspaceFilename(project.name)}.json`;
  return { json: JSON.stringify(payload, null, 2), filename };
}

function sanitizeWorkspaceFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/^_+|_+$/g, '') || 'project';
}
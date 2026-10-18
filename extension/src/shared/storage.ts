import { ChatRef, Project, PromptTemplate, StoredState, SyncConfig, SyncSettings, TagMeta, UiPrefs, WorkspacePayload } from './types';
import { debugStep, errorName, storageLocalGet, storageLocalSet } from './webext';
import { normalizeChatIndex, parseWorkspace } from './schemas';
import { getRawIdentifierForHash } from './account';
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

/**
 * Converts unpartitioned schema v1 data (flat projects, chat index, prompt
 * store) into a validated hierarchical WorkspacePayload for the given account
 * hash and persists it — already vault-sealed — under
 * `workspace_${accountHash}`. Legacy keys are flagged (never deleted) so
 * migration never destroys user data.
 */
export async function migrateLegacyData(accountHash: string): Promise<WorkspacePayload> {
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

/**
 * Loads the account-partitioned workspace. The stored form is always an
 * encrypted vault envelope; plaintext payloads from before this update are
 * accepted once and sealed on the next write.
 */
export async function getWorkspace(accountHash: string): Promise<WorkspacePayload> {
  const key = getWorkspaceKey(accountHash);
  const result = await debugStep('getWorkspace:storage-read', () => storageLocalGet<Record<string, unknown>>([key]));
  const raw = result[key];

  if (raw !== undefined && raw !== null) {
    try {
      const rawIdentifier = await debugStep('getWorkspace:identity', () => requireRawIdentifier(accountHash));
      const opened = await debugStep('getWorkspace:open-envelope', () => openWorkspaceEnvelope(accountHash, rawIdentifier, raw));
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

  return migrateLegacyData(accountHash);
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
  const validated = await debugStep('seal:validate', () => parseWorkspace(payload));
  const rawIdentifier = await debugStep('seal:identity', () => requireRawIdentifier(accountHash));
  const meta = await debugStep('seal:read-meta', () => existingVaultMeta(accountHash));
  const envelope = await debugStep('seal:encrypt', () => sealWorkspaceEnvelope(accountHash, rawIdentifier, validated, meta));
  await debugStep('seal:persist', () => storageLocalSet({ [getWorkspaceKey(accountHash)]: envelope }));
}

export async function saveWorkspace(accountHash: string, data: WorkspacePayload): Promise<void> {
  const next: WorkspacePayload = {
    ...data,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    accountId: accountHash,
    version: (typeof data.version === 'number' ? data.version : 0) + 1,
    updatedAt: Date.now()
  };
  const validated = normalizeWorkspacePayload(next, accountHash);
  await writeWorkspaceEnvelope(accountHash, validated);
  notifyWorkspaceSaved(accountHash);
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
  const result = await storageLocalGet<Record<string, unknown>>([SYNC_CONFIG_KEY, SYNC_SETTINGS_KEY]);
  const legacy = normalizeSyncConfig(result[SYNC_CONFIG_KEY]);
  if (legacy) return legacy;
  return normalizeSyncConfig(result[SYNC_SETTINGS_KEY]);
}

function normalizeSyncConfig(raw: unknown): SyncConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<SyncConfig>;
  const serverUrl = typeof candidate.serverUrl === 'string' ? candidate.serverUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof candidate.apiKey === 'string' ? candidate.apiKey : '';
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

export function createDefaultSyncSettings(): SyncSettings {
  return {
    serverUrl: '',
    apiKey: '',
    useGlobalPassphrase: true,
    accountPassphrases: {}
  };
}

export async function getSyncSettings(): Promise<SyncSettings> {
  const result = await storageLocalGet<Record<string, unknown>>([SYNC_SETTINGS_KEY]);
  const raw = result[SYNC_SETTINGS_KEY];
  if (!raw || typeof raw !== 'object') return createDefaultSyncSettings();

  const candidate = raw as Partial<SyncSettings>;
  const serverUrl = typeof candidate.serverUrl === 'string' ? candidate.serverUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof candidate.apiKey === 'string' ? candidate.apiKey : '';
  const accountPassphrases: Record<string, string> = {};
  if (candidate.accountPassphrases && typeof candidate.accountPassphrases === 'object') {
    Object.entries(candidate.accountPassphrases as Record<string, unknown>).forEach(([accountId, value]) => {
      if (typeof value === 'string') accountPassphrases[accountId] = value;
    });
  }

  return {
    serverUrl,
    apiKey,
    useGlobalPassphrase: candidate.useGlobalPassphrase !== false,
    ...(typeof candidate.globalPassphrase === 'string' ? { globalPassphrase: candidate.globalPassphrase } : {}),
    accountPassphrases
  };
}

export async function saveSyncSettings(settings: SyncSettings): Promise<void> {
  const normalized: SyncSettings = {
    serverUrl: settings.serverUrl.trim().replace(/\/+$/, ''),
    apiKey: settings.apiKey,
    useGlobalPassphrase: settings.useGlobalPassphrase === true,
    ...(settings.globalPassphrase ? { globalPassphrase: settings.globalPassphrase } : {}),
    accountPassphrases: { ...(settings.accountPassphrases ?? {}) }
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
}

export function createDefaultFeatureSettings(): FeatureSettings {
  return { autoApplyProjectInstructions: true, showInstructionsButton: false };
}

export async function getFeatureSettings(): Promise<FeatureSettings> {
  const result = await storageLocalGet<Record<string, unknown>>([FEATURE_SETTINGS_KEY]);
  const raw = result[FEATURE_SETTINGS_KEY];
  if (!raw || typeof raw !== 'object') return createDefaultFeatureSettings();
  const candidate = raw as Partial<FeatureSettings>;
  return {
    autoApplyProjectInstructions: candidate.autoApplyProjectInstructions !== false,
    showInstructionsButton: candidate.showInstructionsButton === true
  };
}

export async function saveFeatureSettings(settings: FeatureSettings): Promise<void> {
  const normalized: FeatureSettings = {
    autoApplyProjectInstructions: settings.autoApplyProjectInstructions === true,
    showInstructionsButton: settings.showInstructionsButton === true
  };
  await storageLocalSet({ [FEATURE_SETTINGS_KEY]: normalized });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FEATURE_SETTINGS_CHANGED_EVENT, { detail: normalized }));
  }
}

function nextSiblingOrder(workspace: WorkspacePayload, parentId: string | null): number {
  return Object.values(workspace.projects)
    .filter((project) => project.parentId === parentId)
    .reduce((max, project) => Math.max(max, project.order), -1) + 1;
}

export async function addFolder(
  accountHash: string,
  parentId: string | null,
  name: string
): Promise<Project> {
  const workspace = await getWorkspace(accountHash);
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

export async function updateProjectMetadata(
  accountHash: string,
  id: string,
  updates: Partial<Project>
): Promise<void> {
  const workspace = await getWorkspace(accountHash);
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

export async function upsertWorkspaceProject(
  accountHash: string,
  project: Project
): Promise<StoredState> {
  const workspace = await debugStep('upsert:get-workspace', () => getWorkspace(accountHash));
  const existing = workspace.projects[project.id];
  workspace.projects[project.id] = existing
    ? { ...existing, ...project, updatedAt: project.updatedAt ?? Date.now() }
    : project;
  await debugStep('upsert:save-workspace', () => saveWorkspace(accountHash, workspace));
  return workspaceToStoredState(workspace);
}

export async function setWorkspaceProjectPinned(
  accountHash: string,
  projectId: string,
  isPinned: boolean
): Promise<StoredState> {
  const workspace = await getWorkspace(accountHash);
  const project = workspace.projects[projectId];
  if (!project) {
    throw new Error('Project not found');
  }
  workspace.projects[projectId] = { ...project, isPinned, updatedAt: Date.now() };
  await saveWorkspace(accountHash, workspace);
  return workspaceToStoredState(workspace);
}

export async function deleteWorkspaceProject(
  accountHash: string,
  projectId: string
): Promise<StoredState> {
  const workspace = await getWorkspace(accountHash);
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
      chats[conversationId] = { ...chat, projectId: null };
    }
  });

  await saveWorkspace(accountHash, workspace);
  return workspaceToStoredState(workspace);
}

export async function moveWorkspaceChat(
  accountHash: string,
  conversationId: string,
  projectId: string | null
): Promise<StoredState> {
  const workspace = await getWorkspace(accountHash);
  const chats = workspace.chats ?? (workspace.chats = {});
  const existing = chats[conversationId];
  chats[conversationId] = {
    conversationId,
    title: existing?.title ?? '',
    isPinned: existing?.isPinned ?? false,
    projectId,
    updatedAt: Date.now(),
    lastUrl: existing?.lastUrl
  };
  await saveWorkspace(accountHash, workspace);
  return workspaceToStoredState(workspace);
}

export async function setWorkspaceChatPinned(
  accountHash: string,
  conversationId: string,
  isPinned: boolean
): Promise<StoredState> {
  const workspace = await getWorkspace(accountHash);
  const chats = workspace.chats ?? (workspace.chats = {});
  const existing = chats[conversationId];
  // A chat can be pinned before it ever gets a workspace record (e.g. pinned
  // in Gemini's sidebar and then moved into a project): create the record so
  // the pin state survives instead of being silently dropped.
  chats[conversationId] = {
    conversationId,
    title: existing?.title ?? '',
    isPinned,
    projectId: existing?.projectId ?? null,
    updatedAt: Date.now(),
    lastUrl: existing?.lastUrl
  };
  await saveWorkspace(accountHash, workspace);
  return workspaceToStoredState(workspace);
}

export async function upsertWorkspaceChatRefs(
  accountHash: string,
  chats: ChatRef[]
): Promise<StoredState> {
  const workspace = await getWorkspace(accountHash);
  const index = workspace.chats ?? (workspace.chats = {});
  chats.forEach((chat) => {
    const existing = index[chat.conversationId];
    index[chat.conversationId] = {
      conversationId: chat.conversationId,
      title: chat.title || existing?.title || '',
      isPinned: typeof chat.isPinned === 'boolean' ? chat.isPinned : (existing?.isPinned ?? false),
      projectId: chat.projectId ?? existing?.projectId ?? null,
      updatedAt: chat.updatedAt ?? existing?.updatedAt ?? Date.now(),
      lastUrl: chat.lastUrl ?? existing?.lastUrl
    };
  });
  await saveWorkspace(accountHash, workspace);
  return workspaceToStoredState(workspace);
}

export async function updateWorkspaceUiPrefs(
  accountHash: string,
  prefs: Partial<UiPrefs>
): Promise<StoredState> {
  const workspace = await getWorkspace(accountHash);
  workspace.uiPrefs = { ...normalizeUiPrefs(workspace.uiPrefs), ...prefs };
  await saveWorkspace(accountHash, workspace);
  return workspaceToStoredState(workspace);
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
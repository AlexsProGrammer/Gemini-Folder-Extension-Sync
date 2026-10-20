export const PROJECT_ICONS = [
  'investing',
  'homework',
  'writing',
  'travel',
  'health',
  'coding',
  'research',
  'default',
  'phone',
  'pen',
  'terminal',
  'music',
  'popcorn',
  'palette',
  'flower',
  'lotus',
  'briefcase',
  'chart',
  'apple',
  'dumbbell',
  'notebook',
  'scale',
  'globe',
  'airplane',
  'world',
  'paw',
  'people',
  'beaker',
  'clover',
  'heart'
] as const;

export type ProjectIcon = (typeof PROJECT_ICONS)[number];

export type ProjectKind = 'project' | 'folder';

export interface Project {
  id: string;
  name: string;
  /** Distinguishes root projects from nested subfolders. */
  kind: ProjectKind;
  /** null indicates a top-level container; a UUID points to the parent project or folder. */
  parentId: string | null;
  /** Custom instructions injected for chats in this project (ChatGPT/Claude-style). */
  systemPrompt?: string;
  /** Freeform markdown notes attached to the workspace. */
  notes?: string;
  icon: ProjectIcon;
  color?: string;
  /** Chat ids attached directly to this project/folder (hierarchical model). */
  chatIds?: string[];
  isPinned?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Legacy flat sort position; kept for backward compatibility with schema v1 data. */
  sortIndex: number;
  /** Sort position within the current hierarchy level. */
  order: number;
}

export interface TagMeta {
  name: string;
  color: string;
}

export interface PromptTemplate {
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  usageCount?: number;
  lastUsedAt?: number;
  isFavorite?: boolean;
}

export interface WorkspacePayload {
  /** 2 = hierarchical project model; 3 = adds the per-account chat index + UI prefs. */
  schemaVersion: number;
  /** SHA-256 hash of the raw Google account identifier. */
  accountId: string;
  /** Monotonic revision counter for sync concurrency. */
  version: number;
  /** Epoch timestamp in milliseconds. */
  updatedAt: number;
  /** Dictionary of projects and subfolders keyed by id. */
  projects: Record<string, Project>;
  /** Prompt library items synced in the same envelope. */
  prompts: PromptTemplate[];
  /** Presentation metadata (tag colors) for the prompt library. */
  tagMeta?: Record<string, TagMeta>;
  /**
   * Per-account chat index (schema v3). Keyed by conversation id so chat
   * titles, pin state and project assignments travel inside the same synced
   * envelope. Optional so schema v2 payloads keep validating.
   */
  chats?: Record<string, ChatRef>;
  /** Sidebar section collapse preferences (schema v3). */
  uiPrefs?: UiPrefs;
}

export interface ChatRef {
  conversationId: string;
  title: string;
  isPinned?: boolean;
  projectId?: string | null;
  updatedAt: number;
  lastUrl?: string;
}

export interface UiPrefs {
  projectsCollapsed: boolean;
  foldersCollapsed: boolean;
}

export interface StoredState {
  schemaVersion: number;
  projects: Project[];
  chatIndex: Record<string, ChatRef>;
  uiPrefs: UiPrefs;
}

export interface UiState {
  createModalOpen: boolean;
  contextMenuOpen: boolean;
  pendingMoveConversationId: string | null;
}

export interface RuntimeState {
  projects: Project[];
  chatIndex: Map<string, ChatRef>;
  /**
   * Ids of projects/folders the user has explicitly collapsed. A node is
   * expanded by default and collapses when its id is present in this set.
   * Persisted per account under `collapsed_folders_${accountHash}`.
   */
  collapsedProjectIds: Set<string>;
  nativeConversationIds: Set<string>;
  nativeChatsReady: boolean;
  ui: UiState;
  uiPrefs: UiPrefs;
}

/* ------------------------------------------------------------------ *
 * Sync protocol (routed through the background CORS proxy)
 * ------------------------------------------------------------------ */

/** Connection settings for the user's self-hosted VPS sync server. */
export interface SyncConfig {
  serverUrl: string;
  apiKey: string;
}

/** Full sync configuration incl. the per-account encryption passphrase map. */
export interface SyncSettings {
  serverUrl: string;
  apiKey: string;
  /** When true every account shares one master passphrase. */
  useGlobalPassphrase: boolean;
  globalPassphrase?: string;
  /** Account-hash -> passphrase map for per-account encryption. */
  accountPassphrases: Record<string, string>;
}

/** Encrypted envelope pushed to / received from the server. */
export interface EncryptedSyncEnvelope {
  version: number;
  ciphertext: string;
  iv: string;
  updatedAt: number;
}

/** Full server-side blob row (GET /api/v1/sync/:accountId response). */
export interface RemoteSyncBlob extends EncryptedSyncEnvelope {
  accountId: string;
}

export interface SyncPullMessage {
  action: 'SYNC_PULL';
  accountId: string;
  serverUrl: string;
  apiKey: string;
}

export interface SyncPushMessage {
  action: 'SYNC_PUSH';
  accountId: string;
  serverUrl: string;
  apiKey: string;
  data: EncryptedSyncEnvelope;
}

export type SyncMessage = SyncPullMessage | SyncPushMessage | SyncPermissionMessage;

/** Ask the background worker (which owns the permissions API) to grant host access for a custom sync server origin. */
export interface SyncPermissionMessage {
  action: 'SYNC_ENSURE_PERMISSION';
  origin: string;
}

export type SyncPermissionResult =
  | { granted: true; requested: false }
  | { granted: true; requested: true }
  | { granted: false }
  | { granted: false; error: string };

export type SyncErrorKind = 'unauthorized' | 'not_found' | 'conflict' | 'network_error';

export type SyncApiResponse<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: SyncErrorKind;
      serverState?: RemoteSyncBlob;
      status?: number;
      message?: string;
    };

/* ------------------------------------------------------------------ *
 * Sync engine state
 * ------------------------------------------------------------------ */

export type SyncStatus = 'idle' | 'unconfigured' | 'syncing' | 'synced' | 'conflict' | 'error' | 'offline';

export type SyncResolution = 'keep_local' | 'keep_remote' | 'merge';

export interface SyncConflictDetail {
  localState: WorkspacePayload;
  remoteState: WorkspacePayload;
}

export interface SyncStatusDetail {
  accountId: string;
  status: SyncStatus;
  message?: string;
}

/**
 * The background service worker owns only the sync CORS proxy; all workspace
 * state lives in the account-partitioned (and locally encrypted) workspace and
 * is mutated directly by the content script that resolved the active account.
 */
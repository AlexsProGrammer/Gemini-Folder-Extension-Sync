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
  /** 2 = hierarchical project model with an integrated prompt library. */
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
  expandedProjectIds: Set<string>;
  nativeConversationIds: Set<string>;
  nativeChatsReady: boolean;
  ui: UiState;
  uiPrefs: UiPrefs;
}

export type BackgroundRequest =
  | { type: 'getState' }
  | { type: 'upsertProject'; project: Project }
  | { type: 'renameProject'; projectId: string; name: string }
  | { type: 'setProjectPinned'; projectId: string; isPinned: boolean }
  | { type: 'deleteProject'; projectId: string }
  | { type: 'moveChat'; conversationId: string; projectId: string | null }
  | { type: 'upsertChatRefs'; chats: ChatRef[] }
  | { type: 'exportProject'; projectId: string }
  | { type: 'updateUiPrefs'; prefs: Partial<UiPrefs> }
  | { type: 'refreshStateCache' };

export type BackgroundResponse =
  | { ok: true; state?: StoredState; json?: string; filename?: string }
  | { ok: false; error: string };
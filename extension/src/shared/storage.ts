import { ChatRef, Project, PromptTemplate, StoredState, TagMeta, UiPrefs, WorkspacePayload } from './types';
import { storageLocalGet, storageLocalSet } from './webext';
import { WorkspacePayloadSchema } from './schemas';

export const STORAGE_KEY = 'gemini_projects_v1';
export const CURRENT_SCHEMA_VERSION = 1;

/** Schema version of the hierarchical, account-partitioned workspace model. */
export const WORKSPACE_SCHEMA_VERSION = 2;
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

export function migrateState(raw: unknown): StoredState {
  if (!raw || typeof raw !== 'object') {
    return createEmptyState();
  }

  const candidate = raw as Partial<StoredState>;
  if (candidate.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return createEmptyState();
  }

  const projects = Array.isArray(candidate.projects) ? candidate.projects : [];
  const rawChatIndex =
    candidate.chatIndex && typeof candidate.chatIndex === 'object'
      ? (candidate.chatIndex as Record<string, ChatRef & { lastSeenAt?: number; lastUrl?: string }>)
      : {};
  const chatIndex: Record<string, ChatRef> = {};

  const normalizeStoredTitle = (title: string): { title: string; isPinned: boolean } => {
    const source = (title || '').trim();
    if (!source) return { title: '', isPinned: false };

    const hasPinnedToken = /(?:\bpinned\b|已置顶|置顶)/i.test(source);
    const cleaned = source
      .replace(/\s*(?:[-–—|·•]?\s*)?(?:pinned)(?:\.{3}|…)?\s*$/i, '')
      .replace(/\s*(?:[-–—|·•]?\s*)?(?:已置顶|置顶)(?:\.{3}|…)?\s*$/i, '')
      .trim();

    return {
      title: cleaned || source,
      isPinned: hasPinnedToken
    };
  };

  Object.entries(rawChatIndex).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const conversationId = value.conversationId || key;
    const normalized = normalizeStoredTitle(value.title || '');
    chatIndex[conversationId] = {
      conversationId,
      title: normalized.title,
      isPinned: typeof value.isPinned === 'boolean' ? value.isPinned : normalized.isPinned,
      projectId: value.projectId ?? null,
      updatedAt:
        typeof value.updatedAt === 'number'
          ? value.updatedAt
          : typeof value.lastSeenAt === 'number'
            ? value.lastSeenAt
            : Date.now(),
      lastUrl: typeof value.lastUrl === 'string' ? value.lastUrl : undefined
    };
  });

  const uiPrefs = normalizeUiPrefs(candidate.uiPrefs);

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects,
    chatIndex,
    uiPrefs
  };
}

export async function loadState(): Promise<StoredState> {
  const result = await storageLocalGet<Record<string, unknown>>(STORAGE_KEY);
  return migrateState(result[STORAGE_KEY]);
}

export async function saveState(state: StoredState): Promise<void> {
  await storageLocalSet({ [STORAGE_KEY]: state });
}

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
 * Converts unpartitioned schema v1 data (flat projects + prompt store) into a
 * validated hierarchical WorkspacePayload for the given account hash and
 * persists it under `workspace_${accountHash}`. Legacy keys are flagged (never
 * deleted) so migration never destroys user data.
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

  const projects: Record<string, Project> = {};
  legacyProjects.forEach((raw, index) => {
    const project = toWorkspaceProject(raw, index);
    projects[project.id] = project;
  });

  const prompts = legacyPrompts.prompts.map(toPromptTemplate);

  const payload: WorkspacePayload = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    accountId: accountHash,
    version: 1,
    updatedAt: Date.now(),
    projects,
    prompts,
    ...(legacyPrompts.tagMeta ? { tagMeta: legacyPrompts.tagMeta } : {})
  };

  const validated = WorkspacePayloadSchema.parse(payload) as WorkspacePayload;
  const updates: Record<string, unknown> = {
    [getWorkspaceKey(accountHash)]: validated,
    [getLegacyMigrationFlagKey(accountHash)]: {
      migratedAt: Date.now(),
      sourceProjects: legacyProjects.length,
      sourcePrompts: legacyPrompts.prompts.length
    }
  };
  if (!legacyAlreadyClaimed) {
    updates[LEGACY_MIGRATION_GATE_KEY] = { migratedAt: Date.now(), claimedBy: accountHash };
  }
  await storageLocalSet(updates);

  return validated;
}

export async function getWorkspace(accountHash: string): Promise<WorkspacePayload> {
  const key = getWorkspaceKey(accountHash);
  const result = await storageLocalGet<Record<string, unknown>>([key]);
  const raw = result[key];

  if (raw) {
    try {
      return WorkspacePayloadSchema.parse(raw) as WorkspacePayload;
    } catch (error) {
      console.warn('[gemini-projects] workspace failed validation; re-migrating', error);
    }
  }

  return migrateLegacyData(accountHash);
}

export async function saveWorkspace(accountHash: string, data: WorkspacePayload): Promise<void> {
  const next: WorkspacePayload = {
    ...data,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    accountId: accountHash,
    version: (typeof data.version === 'number' ? data.version : 0) + 1,
    updatedAt: Date.now()
  };
  const validated = WorkspacePayloadSchema.parse(next) as WorkspacePayload;
  await storageLocalSet({ [getWorkspaceKey(accountHash)]: validated });
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
import { z } from 'zod';
import { ChatRef, PROJECT_ICONS, Project, PromptTemplate, TagMeta, UiPrefs, WorkspacePayload } from './types';

export const ProjectKindSchema = z.enum(['project', 'folder']);

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().default('Untitled'),
  kind: ProjectKindSchema.default('project'),
  parentId: z.string().nullable().default(null),
  systemPrompt: z.string().optional(),
  notes: z.string().optional(),
  icon: z.enum(PROJECT_ICONS).default('default'),
  color: z.string().optional(),
  chatIds: z.array(z.string()).default([]),
  isPinned: z.boolean().optional(),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(Date.now()),
  sortIndex: z.number().default(0),
  order: z.number().default(0)
});

export const TagMetaSchema = z.object({
  name: z.string().min(1),
  color: z.string().default('gray')
});

export const PromptTemplateSchema = z.object({
  id: z.string().min(1),
  title: z.string().default('Untitled'),
  content: z.string().default(''),
  tags: z.array(z.string()).default([]),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(Date.now()),
  usageCount: z.number().default(0),
  lastUsedAt: z.number().default(0),
  isFavorite: z.boolean().default(false)
});

export const ChatRefSchema = z.object({
  conversationId: z.string().min(1),
  title: z.string().default(''),
  isPinned: z.boolean().optional(),
  projectId: z.string().nullable().optional(),
  updatedAt: z.number().default(0),
  lastUrl: z.string().optional()
});

export const UiPrefsSchema = z.object({
  projectsCollapsed: z.boolean().default(false),
  foldersCollapsed: z.boolean().default(false)
});

/**
 * Schema v3 adds the per-account chat index and UI prefs. They stay optional
 * so schema v2 envelopes keep validating (missing fields are normalized to
 * defaults by storage.ts before use).
 */
export const WorkspacePayloadSchema = z.object({
  schemaVersion: z.number().int().min(2),
  accountId: z.string().min(1),
  version: z.number().int().min(0).default(1),
  updatedAt: z.number().default(Date.now()),
  projects: z.record(z.string(), ProjectSchema).default({}),
  prompts: z.array(PromptTemplateSchema).default([]),
  tagMeta: z.record(z.string(), TagMetaSchema).optional(),
  chats: z.record(z.string(), ChatRefSchema).optional(),
  uiPrefs: UiPrefsSchema.optional()
});

export type ProjectSchemaOutput = z.infer<typeof ProjectSchema>;
export type TagMetaSchemaOutput = z.infer<typeof TagMetaSchema>;
export type PromptTemplateSchemaOutput = z.infer<typeof PromptTemplateSchema>;
export type WorkspacePayloadSchemaOutput = z.infer<typeof WorkspacePayloadSchema>;

/** Encrypted envelope accepted by the backend POST /api/v1/sync/:accountId. */
export const EncryptedSyncEnvelopeSchema = z.object({
  version: z.number().int().min(1),
  ciphertext: z.string().min(1),
  iv: z.string().min(1),
  updatedAt: z.number().int().min(1)
});

/** Full server blob row returned by GET /api/v1/sync/:accountId and by 409 conflicts. */
export const RemoteSyncBlobSchema = EncryptedSyncEnvelopeSchema.extend({
  accountId: z.string().min(1)
});

/** Server confirmation body for a successful push. */
export const SyncConfirmationSchema = z.object({
  status: z.literal('success'),
  version: z.number().int().min(1),
  updatedAt: z.number().int().min(1)
});

/* ------------------------------------------------------------------ *
 * Xray-safe workspace validation
 *
 * zod v4's `isPlainObject` reads `value.constructor`, which throws
 * `Permission denied to access property "constructor"` in Firefox when the
 * value arrived through a security wrapper (e.g. storage.local values handed
 * to content scripts). Workspace payloads therefore go through the manual
 * normalizer below instead: it performs ONLY own-property reads and typeof
 * checks on the input, so it is safe on wrapped, plain, or partial data and
 * never throws on the data itself.
 * ------------------------------------------------------------------ */

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a property while tolerating security-wrapper semantics: on Firefox
 * Xray wrappers even a *missing* property read falls through to the blocked
 * prototype chain and throws. Swallowing that turns the field into
 * `undefined`, which every normalizer below maps to its schema default.
 */
function safeGet(source: Record<string, unknown>, key: string): unknown {
  try {
    return source[key];
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeProjectRecord(raw: unknown, fallbackId: string): Project {
  const source = isRecordLike(raw) ? raw : {};
  const now = Date.now();
  const iconCandidate = asString(safeGet(source, 'icon'));
  const project: Project = {
    id: asString(safeGet(source, 'id')) || fallbackId,
    name: asString(safeGet(source, 'name')) || 'Untitled',
    kind: safeGet(source, 'kind') === 'folder' ? 'folder' : 'project',
    parentId: asString(safeGet(source, 'parentId')) ?? null,
    icon: (iconCandidate && (PROJECT_ICONS as readonly string[]).includes(iconCandidate)
      ? iconCandidate
      : 'default') as Project['icon'],
    chatIds: Array.isArray(safeGet(source, 'chatIds'))
      ? (safeGet(source, 'chatIds') as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [],
    createdAt: asFiniteNumber(safeGet(source, 'createdAt')) ?? 0,
    updatedAt: asFiniteNumber(safeGet(source, 'updatedAt')) ?? now,
    sortIndex: asFiniteNumber(safeGet(source, 'sortIndex')) ?? 0,
    order: asFiniteNumber(safeGet(source, 'order')) ?? 0
  };
  const systemPrompt = asString(safeGet(source, 'systemPrompt'));
  if (systemPrompt !== undefined) project.systemPrompt = systemPrompt;
  const notes = asString(safeGet(source, 'notes'));
  if (notes !== undefined) project.notes = notes;
  const color = asString(safeGet(source, 'color'));
  if (color !== undefined) project.color = color;
  const isPinned = asBoolean(safeGet(source, 'isPinned'));
  if (isPinned !== undefined) project.isPinned = isPinned;
  return project;
}

function normalizePromptRecord(raw: unknown, index: number): PromptTemplate {
  const source = isRecordLike(raw) ? raw : {};
  const now = Date.now();
  return {
    id: asString(safeGet(source, 'id')) || `prompt_${index}`,
    title: asString(safeGet(source, 'title')) || 'Untitled',
    content: asString(safeGet(source, 'content')) || '',
    tags: Array.isArray(safeGet(source, 'tags'))
      ? (safeGet(source, 'tags') as unknown[]).filter((entry): entry is string => typeof entry === 'string')
      : [],
    createdAt: asFiniteNumber(safeGet(source, 'createdAt')) ?? 0,
    updatedAt: asFiniteNumber(safeGet(source, 'updatedAt')) ?? now,
    usageCount: asFiniteNumber(safeGet(source, 'usageCount')) ?? 0,
    lastUsedAt: asFiniteNumber(safeGet(source, 'lastUsedAt')) ?? 0,
    isFavorite: safeGet(source, 'isFavorite') === true
  };
}

/** Normalizes a raw chat index into validated ChatRefs (own-prop reads only). */
export function normalizeChatIndex(raw: unknown): Record<string, ChatRef> {
  const rawChatIndex = isRecordLike(raw) ? raw : {};
  const chatIndex: Record<string, ChatRef> = {};

  Object.entries(rawChatIndex).forEach(([key, value]) => {
    if (!isRecordLike(value)) return;
    const conversationId = asString(safeGet(value, 'conversationId')) || key;
    const titleSource = asString(safeGet(value, 'title')) || '';
    const pinnedToken = /(?:\bpinned\b|已置顶|置顶)/i.test(titleSource);
    const cleanedTitle = titleSource
      .replace(/\s*(?:[-–—|·•]?\s*)?(?:pinned)(?:\.{3}|…)?\s*$/i, '')
      .replace(/\s*(?:[-–—|·•]?\s*)?(?:已置顶|置顶)(?:\.{3}|…)?\s*$/i, '')
      .trim();
    const isPinned = asBoolean(safeGet(value, 'isPinned'));
    const lastUrl = asString(safeGet(value, 'lastUrl'));
    const lastSeenAt = asFiniteNumber(safeGet(value, 'lastSeenAt'));
    const chat: ChatRef = {
      conversationId,
      title: cleanedTitle || titleSource,
      projectId: asString(safeGet(value, 'projectId')) ?? null,
      updatedAt: asFiniteNumber(safeGet(value, 'updatedAt')) ?? lastSeenAt ?? Date.now(),
      ...(lastUrl !== undefined ? { lastUrl } : {})
    };
    if (isPinned !== undefined) {
      chat.isPinned = isPinned;
    } else if (pinnedToken) {
      chat.isPinned = true;
    }
    chatIndex[conversationId] = chat;
  });

  return chatIndex;
}

function normalizeTagMeta(raw: unknown): Record<string, TagMeta> {
  const source = isRecordLike(raw) ? raw : {};
  const tagMeta: Record<string, TagMeta> = {};
  Object.entries(source).forEach(([tag, value]) => {
    if (!isRecordLike(value)) return;
    const name = asString(safeGet(value, 'name'));
    if (!name) return;
    tagMeta[tag] = { name, color: asString(safeGet(value, 'color')) || 'gray' };
  });
  return tagMeta;
}

function normalizeUiPrefsRecord(raw: unknown): UiPrefs {
  const source = isRecordLike(raw) ? raw : {};
  return {
    projectsCollapsed: safeGet(source, 'projectsCollapsed') === true,
    foldersCollapsed: safeGet(source, 'foldersCollapsed') === true
  };
}

/**
 * Validates and normalizes an untrusted workspace payload into a plain,
 * fully-populated WorkspacePayload. Safe on cross-compartment (Xray-wrapped)
 * values: every input read goes through safeGet, so neither own-property
 * reads nor missing-property prototype fallthroughs can throw.
 */
export function parseWorkspace(raw: unknown): WorkspacePayload {
  const source = isRecordLike(raw) ? raw : {};

  const projects: Record<string, Project> = {};
  const rawProjects = isRecordLike(safeGet(source, 'projects')) ? (safeGet(source, 'projects') as Record<string, unknown>) : {};
  Object.entries(rawProjects).forEach(([key, value]) => {
    const fallbackId = asString(isRecordLike(value) ? safeGet(value, 'id') : undefined) || key || `project_${Object.keys(projects).length}`;
    projects[fallbackId] = normalizeProjectRecord(value, fallbackId);
  });

  const rawPrompts = safeGet(source, 'prompts');
  const prompts = Array.isArray(rawPrompts)
    ? rawPrompts.map((entry, index) => normalizePromptRecord(entry, index))
    : [];

  const rawSchemaVersion = asFiniteNumber(safeGet(source, 'schemaVersion'));
  const payload: WorkspacePayload = {
    schemaVersion: rawSchemaVersion !== undefined && rawSchemaVersion >= 2 ? rawSchemaVersion : 3,
    accountId: asString(safeGet(source, 'accountId')) || '',
    version: asFiniteNumber(safeGet(source, 'version')) ?? 1,
    updatedAt: asFiniteNumber(safeGet(source, 'updatedAt')) ?? Date.now(),
    projects,
    prompts
  };

  if (safeGet(source, 'tagMeta') !== undefined) payload.tagMeta = normalizeTagMeta(safeGet(source, 'tagMeta'));
  if (safeGet(source, 'chats') !== undefined) payload.chats = normalizeChatIndex(safeGet(source, 'chats'));
  if (safeGet(source, 'uiPrefs') !== undefined) payload.uiPrefs = normalizeUiPrefsRecord(safeGet(source, 'uiPrefs'));
  return payload;
}

export function safeParseWorkspace(raw: unknown): { success: true; data: WorkspacePayload } | { success: false; error: unknown } {
  try {
    return { success: true, data: parseWorkspace(raw) };
  } catch (error) {
    return { success: false, error };
  }
}

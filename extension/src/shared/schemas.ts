import { z } from 'zod';
import { PROJECT_ICONS } from './types';

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

export const WorkspacePayloadSchema = z.object({
  schemaVersion: z.number().int().min(2),
  accountId: z.string().min(1),
  version: z.number().int().min(0).default(1),
  updatedAt: z.number().default(Date.now()),
  projects: z.record(z.string(), ProjectSchema).default({}),
  prompts: z.array(PromptTemplateSchema).default([]),
  tagMeta: z.record(z.string(), TagMetaSchema).optional()
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

export function parseWorkspace(raw: unknown): WorkspacePayloadSchemaOutput {
  return WorkspacePayloadSchema.parse(raw);
}

export function safeParseWorkspace(raw: unknown) {
  return WorkspacePayloadSchema.safeParse(raw);
}
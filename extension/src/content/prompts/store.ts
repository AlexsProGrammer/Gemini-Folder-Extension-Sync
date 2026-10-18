// import { v4 as uuidv4 } from 'uuid';

import { getAccountIdHash, resolveAccountRawIdentifier } from '../../shared/account';
import {
  getWorkspace,
  saveWorkspace,
  getWorkspaceKey,
  WORKSPACE_SCHEMA_VERSION
} from '../../shared/storage';
import { PromptTemplate, TagMeta, WorkspacePayload } from '../../shared/types';
import { webext } from '../../shared/webext';
import { ACCOUNT_CHANGED_EVENT, getActiveAccountHash } from '../accountWatcher';

function uuidv4() {
    return crypto.randomUUID();
}

export interface Prompt {
    id: string;
    title: string;
    content: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
    usageCount: number;
    lastUsedAt: number;
    isFavorite: boolean;
}

export type { TagMeta } from '../../shared/types';

// Notion 棰滆壊棰勮锛屼繚鎸佷笌鍘熸湁 UI 涓€鑷?/
export const TAG_COLORS = [
    { name: 'gray', bg: 'rgba(31,31,31,0.14)', fg: '#1f1f1f' },
    { name: 'red', bg: 'rgba(232,92,92,0.15)', fg: '#E85C5C' },
    { name: 'orange', bg: 'rgba(249,115,22,0.15)', fg: '#F97316' },
    { name: 'yellow', bg: 'rgba(245,158,11,0.15)', fg: '#F59E0B' },
    { name: 'green', bg: 'rgba(34,197,94,0.15)', fg: '#22C55E' },
    { name: 'blue', bg: 'rgba(59,130,246,0.15)', fg: '#3B82F6' },
    { name: 'purple', bg: 'rgba(139,92,246,0.15)', fg: '#8B5CF6' },
    { name: 'pink', bg: 'rgba(236,72,153,0.15)', fg: '#EC4899' },
];

export interface PromptsData {
    prompts: Record<string, Prompt>;
    tagMeta: Record<string, TagMeta>;
    version: number;
}

const TAG_COLOR_NAMES = new Set(TAG_COLORS.map((item) => item.name));
const DEFAULT_DATA: PromptsData = {
    prompts: {},
    tagMeta: {},
    version: 1,
};

// Seed data for first run
const SEED_PROMPTS: Partial<Prompt>[] = [
    {
        title: 'Summarize',
        content: 'Please summarize the following text into bullet points, capturing the key insights and main arguments:',
        tags: ['writing', 'summary'],
    },
    {
        title: 'Code Review',
        content: 'Review the following code for bugs, performance issues, and best practices. Suggest improvements with code examples:',
        tags: ['coding', 'review'],
    },
    {
        title: 'Bug Fix',
        content: 'I am encountering a bug. Here is the error message: "{{error}}". Here is the relevant code snippet: "{{code}}". Please analyze the root cause and provide a fix.',
        tags: ['coding', 'debug'],
    },
    {
        title: 'Email Polish',
        content: 'Rewrite the following email to be more professional and concise, while maintaining a friendly tone:',
        tags: ['writing', 'email'],
    }
];

function decodeTagEntities(value: string): string {
    return value
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}

function normalizeTagName(rawTag: string): string {
    if (!rawTag) return '';
    let value = decodeTagEntities(rawTag).trim();

    // Clean known artifacts introduced by broken template strings.
    value = value
        .replace(/<\s*span\s*>/gi, ' ')
        .replace(/<\s*\/\s*span\s*>/gi, ' ')
        .replace(/<\s*span[^>]*>/gi, ' ')
        .replace(/<\/\s*span\s*>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return value;
}

function normalizePromptTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    const normalized: string[] = [];
    const seen = new Set<string>();
    tags.forEach((tag) => {
        const clean = normalizeTagName(typeof tag === 'string' ? tag : String(tag || ''));
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        normalized.push(clean);
    });
    return normalized;
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function toPrompt(template: PromptTemplate): Prompt {
    return {
        id: template.id,
        title: template.title,
        content: template.content,
        tags: Array.isArray(template.tags) ? [...template.tags] : [],
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
        usageCount: template.usageCount ?? 0,
        lastUsedAt: template.lastUsedAt ?? 0,
        isFavorite: template.isFavorite === true
    };
}

function toPromptTemplates(data: PromptsData): PromptTemplate[] {
    return Object.values(data.prompts).map((prompt) => ({
        id: prompt.id,
        title: prompt.title,
        content: prompt.content,
        tags: [...prompt.tags],
        createdAt: prompt.createdAt,
        updatedAt: prompt.updatedAt,
        usageCount: prompt.usageCount,
        lastUsedAt: prompt.lastUsedAt,
        isFavorite: prompt.isFavorite
    }));
}

function sanitizePromptsData(data: PromptsData): { data: PromptsData; dirty: boolean } {
    let dirty = false;

    if (!data.prompts || typeof data.prompts !== 'object') {
        data.prompts = {};
        dirty = true;
    }
    if (!data.tagMeta || typeof data.tagMeta !== 'object') {
        data.tagMeta = {};
        dirty = true;
    }

    Object.values(data.prompts).forEach((prompt) => {
        const currentTags = Array.isArray(prompt.tags) ? prompt.tags : [];
        const normalizedTags = normalizePromptTags(currentTags);
        if (!areStringArraysEqual(currentTags, normalizedTags)) {
            prompt.tags = normalizedTags;
            dirty = true;
        }
    });

    const nextTagMeta: Record<string, TagMeta> = {};
    Object.entries(data.tagMeta).forEach(([rawName, meta]) => {
        const normalizedName = normalizeTagName(rawName);
        if (!normalizedName) {
            dirty = true;
            return;
        }

        const metaColor =
            meta && typeof meta.color === 'string' && TAG_COLOR_NAMES.has(meta.color)
                ? meta.color
                : 'gray';

        const existing = nextTagMeta[normalizedName];
        if (!existing) {
            nextTagMeta[normalizedName] = { name: normalizedName, color: metaColor };
        } else if (existing.color === 'gray' && metaColor !== 'gray') {
            existing.color = metaColor;
            dirty = true;
        }

        if (normalizedName !== rawName) {
            dirty = true;
        }
    });

    Object.values(data.prompts).forEach((prompt) => {
        prompt.tags.forEach((tag) => {
            if (!nextTagMeta[tag]) {
                nextTagMeta[tag] = { name: tag, color: 'gray' };
                dirty = true;
            }
        });
    });

    data.tagMeta = nextTagMeta;
    return { data, dirty };
}

class PromptStore {
    private cache: PromptsData | null = null;
    private listeners: Set<() => void> = new Set();
    private accountHash: string | null = null;
    private accountHashPromise: Promise<string> | null = null;
    private loadGeneration = 0;

    constructor() {
        this.refresh();
        // Listen for workspace changes belonging to the active account.
        webext.storage?.onChanged?.addListener((
            changes: { [key: string]: { newValue?: unknown } },
            area: string
        ) => {
            if (area !== 'local' || !this.accountHash) return;
            const workspaceKey = getWorkspaceKey(this.accountHash);
            if (changes[workspaceKey]) {
                this.refresh();
            }
        });
        // Re-partition the library when the active Google account changes.
        window.addEventListener(ACCOUNT_CHANGED_EVENT, () => {
            this.accountHash = null;
            this.accountHashPromise = null;
            this.refresh();
        });
    }

    private async ensureAccountHash(): Promise<string> {
        if (this.accountHash) return this.accountHash;
        if (!this.accountHashPromise) {
            const cached = getActiveAccountHash();
            if (cached) {
                this.accountHash = cached;
                return cached;
            }
            const raw = resolveAccountRawIdentifier();
            this.accountHashPromise = getAccountIdHash(raw)
                .then((hash) => {
                    this.accountHash = hash;
                    return hash;
                })
                .catch(() => {
                    this.accountHashPromise = null;
                    throw new Error('Failed to resolve active account identity.');
                });
        }
        return this.accountHashPromise;
    }

    private seed(data: PromptsData): PromptsData {
        // Only seed if empty
        if (Object.keys(data.prompts).length === 0) {
            const now = Date.now();
            SEED_PROMPTS.forEach(p => {
                const id = uuidv4();
                data.prompts[id] = {
                    id,
                    title: p.title || 'Untitled',
                    content: p.content || '',
                    tags: p.tags || [],
                    createdAt: now,
                    updatedAt: now,
                    usageCount: 0,
                    lastUsedAt: 0,
                    isFavorite: false
                };
            });
        }
        return data;
    }

    private toPromptsData(workspace: WorkspacePayload): PromptsData {
        const prompts: Record<string, Prompt> = {};
        (workspace.prompts || []).forEach((template) => {
            const prompt = toPrompt(template);
            prompts[prompt.id] = prompt;
        });
        return {
            prompts,
            tagMeta: { ...(workspace.tagMeta || {}) },
            version: workspace.version
        };
    }

    private async loadFromStorage(): Promise<PromptsData> {
        const accountHash = await this.ensureAccountHash();
        const workspace = await getWorkspace(accountHash);
        let data = this.toPromptsData(workspace);

        // First activation under the workspace schema: seed the library once.
        // version === 1 marks a workspace that saveWorkspace has never revised.
        if (Object.keys(data.prompts).length === 0 && workspace.version === 1) {
            data = this.seed(data);
            await this.writeWorkspace(data);
        } else {
            const { data: sanitized, dirty } = sanitizePromptsData(data);
            data = sanitized;
            if (dirty) {
                await this.writeWorkspace(data);
            }
        }
        return data;
    }

    private async writeWorkspace(data: PromptsData): Promise<void> {
        const accountHash = await this.ensureAccountHash();
        const workspace = await getWorkspace(accountHash);
        workspace.schemaVersion = WORKSPACE_SCHEMA_VERSION;
        workspace.prompts = toPromptTemplates(data);
        workspace.tagMeta = data.tagMeta;
        await saveWorkspace(accountHash, workspace);
    }

    public async refresh() {
        const generation = ++this.loadGeneration;
        try {
            const data = await this.loadFromStorage();
            if (generation !== this.loadGeneration) return;
            this.cache = data;
        } catch (error) {
            console.warn('[gemini-projects] prompt store refresh failed', error);
            if (generation === this.loadGeneration) {
                this.cache = this.cache ?? this.seed(DEFAULT_DATA);
            }
        }
        this.notify();
    }

    public getAll(): Prompt[] {
        if (!this.cache) return [];
        return Object.values(this.cache.prompts).sort((a, b) => {
            // Favorite first, then last used, then title
            if (a.isFavorite !== b.isFavorite) return b.isFavorite ? 1 : -1;
            if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
            return 0; // a.title.localeCompare(b.title);
        });
    }

    public get(id: string): Prompt | undefined {
        return this.cache?.prompts[id];
    }

    public async save(prompt: Partial<Prompt> & { title: string; content: string }) {
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        const now = Date.now();
        const normalizedTags = normalizePromptTags(prompt.tags || []);

        let entry: Prompt;
        if (prompt.id && data.prompts[prompt.id]) {
            // Update
            entry = {
                ...data.prompts[prompt.id],
                ...prompt,
                tags: normalizedTags,
                updatedAt: now
            };
        } else {
            // Create
            const id = uuidv4();
            entry = {
                id,
                title: prompt.title,
                content: prompt.content,
                tags: normalizedTags,
                createdAt: now,
                updatedAt: now,
                usageCount: 0,
                lastUsedAt: 0,
                isFavorite: prompt.isFavorite || false
            };
        }

        data.prompts[entry.id] = entry;
        if (!data.tagMeta) data.tagMeta = {};
        normalizedTags.forEach((tag) => {
            if (!data.tagMeta[tag]) {
                data.tagMeta[tag] = { name: tag, color: 'gray' };
            }
        });
        this.cache = data;
        await this.writeWorkspace(data);
    }

    public async delete(id: string) {
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        if (data.prompts[id]) {
            delete data.prompts[id];
            this.cache = data;
            await this.writeWorkspace(data);
        }
    }

    public async trackUsage(id: string) {
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        if (data.prompts[id]) {
            data.prompts[id].usageCount++;
            data.prompts[id].lastUsedAt = Date.now();
            this.cache = data;
            await this.writeWorkspace(data);
        }
    }

    public async toggleFavorite(id: string) {
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        if (data.prompts[id]) {
            data.prompts[id].isFavorite = !data.prompts[id].isFavorite;
            this.cache = data;
            await this.writeWorkspace(data);
        }
    }

    public subscribe(callback: () => void) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    private notify() {
        this.listeners.forEach(cb => cb());
    }

    // ========== Tag management ==========

    public getAllTags(): { name: string; count: number; color: string }[] {
        if (!this.cache) return [];
        const tagCounts: Record<string, number> = {};

        Object.values(this.cache.prompts).forEach(p => {
            p.tags.forEach(t => tagCounts[t] = (tagCounts[t] || 0) + 1);
        });

        const tagMeta = this.cache.tagMeta || {};
        Object.keys(tagMeta).forEach(t => {
            if (tagCounts[t] === undefined) {
                tagCounts[t] = 0;
            }
        });

        return Object.entries(tagCounts)
            .map(([name, count]) => ({
                name,
                count,
                color: tagMeta[name]?.color || this.getRandomColor()
            }))
            .sort((a, b) => b.count - a.count);
    }

    public getTagColor(tagName: string): string {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag) return 'gray';
        return this.cache?.tagMeta[normalizedTag]?.color || 'gray';
    }

    private getRandomColor(): string {
        const colors = TAG_COLORS.map(c => c.name);
        return colors[Math.floor(Math.random() * colors.length)];
    }

    public async ensureTagColor(tagName: string): Promise<string> {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag) return 'gray';
        if (!this.cache) await this.refresh();
        const data = this.cache!;

        if (!data.tagMeta) data.tagMeta = {};

        if (!data.tagMeta[normalizedTag]) {
            const color = this.getRandomColor();
            data.tagMeta[normalizedTag] = { name: normalizedTag, color };
            this.cache = data;
            await this.writeWorkspace(data);
            return color;
        }
        return data.tagMeta[normalizedTag].color;
    }

    public async setTagColor(tagName: string, color: string) {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag) return;
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        if (!data.tagMeta) data.tagMeta = {};

        data.tagMeta[normalizedTag] = { name: normalizedTag, color };
        this.cache = data;
        await this.writeWorkspace(data);
    }

    public async renameTag(oldName: string, newName: string) {
        const oldTag = normalizeTagName(oldName);
        const nextTag = normalizeTagName(newName);
        if (!oldTag || !nextTag) return;
        if (oldTag === nextTag) return;

        if (!this.cache) await this.refresh();
        const data = this.cache!;

        Object.values(data.prompts).forEach(p => {
            p.tags = normalizePromptTags(p.tags.map((tag) => (tag === oldTag ? nextTag : tag)));
        });

        if (!data.tagMeta) data.tagMeta = {};
        if (data.tagMeta[oldTag]) {
            const oldColor = data.tagMeta[oldTag].color;
            if (!data.tagMeta[nextTag]) {
                data.tagMeta[nextTag] = { name: nextTag, color: oldColor };
            }
            delete data.tagMeta[oldTag];
        } else if (!data.tagMeta[nextTag]) {
            data.tagMeta[nextTag] = { name: nextTag, color: 'gray' };
        }

        this.cache = data;
        await this.writeWorkspace(data);
        this.notify();
    }

    public async deleteTagGlobal(tagName: string) {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag) return;
        if (!this.cache) await this.refresh();
        const data = this.cache!;

        Object.values(data.prompts).forEach(p => {
            p.tags = p.tags.filter(t => t !== normalizedTag);
        });

        if (data.tagMeta) {
            delete data.tagMeta[normalizedTag];
        }

        this.cache = data;
        await this.writeWorkspace(data);
        this.notify();
    }
}

export const promptStore = new PromptStore();
import { WorkspacePayloadSchema } from './schemas';
import {
  getWorkspaceKey,
  LEGACY_PROMPTS_KEY,
  LEGACY_GENERIC_PROMPTS_KEY,
  LEGACY_GENERIC_PROJECTS_KEY,
  STORAGE_KEY,
  WORKSPACE_SCHEMA_VERSION
} from './storage';
import { WorkspacePayload } from './types';
import { storageLocalGet, storageLocalSet } from './webext';

const BACKUP_VERSION = 2;
const WORKSPACE_KEY_PREFIX = 'workspace_';

export interface BackupData {
  version: number;
  exportedAt: string;
  /** Account-partitioned workspaces keyed by SHA-256 account hash. */
  accounts?: Record<string, WorkspacePayload>;
  /** Legacy schema v1 snapshot kept for downgrade compatibility. */
  projects?: unknown;
  prompts?: unknown;
}

function buildFilename(): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `gemini-workspace-backup-${yyyy}-${mm}-${dd}.json`;
}

export async function exportAllData(): Promise<void> {
  const everything = await storageLocalGet<Record<string, unknown>>(null);

  const accounts: Record<string, WorkspacePayload> = {};
  Object.entries(everything).forEach(([key, value]) => {
    if (!key.startsWith(WORKSPACE_KEY_PREFIX)) return;
    const accountHash = key.slice(WORKSPACE_KEY_PREFIX.length);
    if (!accountHash) return;
    try {
      accounts[accountHash] = WorkspacePayloadSchema.parse(value) as WorkspacePayload;
    } catch {
      // Export raw so no user data is silently dropped; import re-validates.
      accounts[accountHash] = value as WorkspacePayload;
    }
  });

  const payload: BackupData = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    accounts,
    projects: everything[STORAGE_KEY] ?? everything[LEGACY_GENERIC_PROJECTS_KEY] ?? null,
    prompts: everything[LEGACY_PROMPTS_KEY] ?? everything[LEGACY_GENERIC_PROMPTS_KEY] ?? null
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildFilename();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseBackupText(text: string): BackupData | null {
  const data = JSON.parse(text) as BackupData;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.version !== 'number') return null;
  if (data.version > BACKUP_VERSION) return null;
  return data;
}

export async function importData(file: File): Promise<{ success: boolean; message: string }> {
  try {
    const text = await file.text();
    const data = parseBackupText(text);
    if (!data) {
      return { success: false, message: 'Invalid backup file format.' };
    }

    const updates: Record<string, unknown> = {};
    let importedAccounts = 0;
    let skippedAccounts = 0;

    if (data.accounts && typeof data.accounts === 'object' && data.version >= WORKSPACE_SCHEMA_VERSION) {
      Object.entries(data.accounts).forEach(([accountHash, workspace]) => {
        try {
          const validated = WorkspacePayloadSchema.parse(workspace) as WorkspacePayload;
          updates[getWorkspaceKey(accountHash)] = validated;
          importedAccounts += 1;
        } catch {
          skippedAccounts += 1;
        }
      });
    }

    if (data.projects !== null && data.projects !== void 0) {
      updates[STORAGE_KEY] = data.projects;
    }
    if (data.prompts !== null && data.prompts !== void 0) {
      updates[LEGACY_PROMPTS_KEY] = data.prompts;
    }

    if (!Object.keys(updates).length) {
      return { success: false, message: 'No restorable data found in backup file.' };
    }

    await storageLocalSet(updates);

    const parts: string[] = [];
    if (importedAccounts > 0) {
      parts.push(`${importedAccounts} account workspace${importedAccounts === 1 ? '' : 's'}`);
    }
    if (skippedAccounts > 0) {
      parts.push(`${skippedAccounts} skipped (invalid)`);
    }
    if (data.projects !== null && data.projects !== void 0) {
      parts.push('legacy projects');
    }
    if (data.prompts !== null && data.prompts !== void 0) {
      parts.push('legacy prompts');
    }

    const summary = parts.length > 0 ? ` Restored: ${parts.join(', ')}.` : '';
    return {
      success: true,
      message: data.exportedAt
        ? `Restore completed. Backup timestamp: ${data.exportedAt}.${summary}`
        : `Restore completed.${summary}`
    };
  } catch (error) {
    console.error('[Backup] import failed', error);
    return { success: false, message: 'Failed to read or parse the backup file.' };
  }
}

export function triggerImport(
  onComplete?: (result: { success: boolean; message: string }) => void
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const result = await importData(file);
    onComplete?.(result);
  };
  input.click();
}
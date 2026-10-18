import { parseWorkspace } from './schemas';
import {
  getWorkspaceKey,
  LEGACY_PROMPTS_KEY,
  LEGACY_GENERIC_PROMPTS_KEY,
  LEGACY_GENERIC_PROJECTS_KEY,
  STORAGE_KEY
} from './storage';
import { getRawIdentifierForHash } from './account';
import { isLocalVaultEnvelope, openWorkspaceEnvelope, type LocalVaultEnvelope } from './vault';
import { WorkspacePayload } from './types';
import { storageLocalGet, storageLocalSet } from './webext';

const BACKUP_VERSION = 3;
const WORKSPACE_KEY_PREFIX = 'workspace_';

export interface BackupData {
  version: number;
  exportedAt: string;
  /** Account-partitioned workspaces keyed by SHA-256 account hash. */
  accounts?: Record<string, WorkspacePayload>;
  /** Locked vault envelopes whose account identity was unavailable at export. */
  lockedAccounts?: Record<string, LocalVaultEnvelope>;
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
  const lockedAccounts: Record<string, LocalVaultEnvelope> = {};
  for (const [key, value] of Object.entries(everything)) {
    if (!key.startsWith(WORKSPACE_KEY_PREFIX)) continue;
    const accountHash = key.slice(WORKSPACE_KEY_PREFIX.length);
    if (!accountHash) continue;

    if (!isLocalVaultEnvelope(value)) {
      // Legacy plaintext partition (not yet re-sealed): export directly.
      try {
        accounts[accountHash] = parseWorkspace(value);
      } catch {
        // Export raw so no user data is silently dropped; import re-validates.
        accounts[accountHash] = value as WorkspacePayload;
      }
      continue;
    }

    try {
      const rawIdentifier = await getRawIdentifierForHash(accountHash);
      if (!rawIdentifier) throw new Error('account identity unavailable');
      const opened = await openWorkspaceEnvelope(accountHash, rawIdentifier, value);
      if (!opened) throw new Error('empty partition');
      accounts[accountHash] = opened.payload;
    } catch {
      // The vault key could not be derived here; keep the opaque envelope so
      // the data is still restorable on a machine that owns the identity.
      lockedAccounts[accountHash] = value;
    }
  }

  const payload: BackupData = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    ...(Object.keys(accounts).length > 0 ? { accounts } : {}),
    ...(Object.keys(lockedAccounts).length > 0 ? { lockedAccounts } : {}),
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
    let restoredLocked = 0;
    let preservedExisting = 0;

    // Never clobber live encrypted partitions: restoring must not downgrade
    // an existing sealed vault back to plaintext or overwrite newer data.
    const existingWorkspaces = await storageLocalGet<Record<string, unknown>>(
      Object.keys({ ...(data.accounts ?? {}), ...(data.lockedAccounts ?? {}) }).map(getWorkspaceKey)
    );

    if (data.accounts && typeof data.accounts === 'object') {
      Object.entries(data.accounts).forEach(([accountHash, workspace]) => {
        try {
          if (existingWorkspaces[getWorkspaceKey(accountHash)] !== undefined) {
            preservedExisting += 1;
            return;
          }
          const validated = parseWorkspace(workspace);
          // Written in legacy plaintext form on purpose: the partition is
          // sealed into its vault envelope on the account's next save, when
          // its identity is available in this browser.
          updates[getWorkspaceKey(accountHash)] = validated;
          importedAccounts += 1;
        } catch {
          skippedAccounts += 1;
        }
      });
    }

    if (data.lockedAccounts && typeof data.lockedAccounts === 'object') {
      Object.entries(data.lockedAccounts).forEach(([accountHash, envelope]) => {
        if (
          isLocalVaultEnvelope(envelope) &&
          /^[0-9a-f]{64}$/.test(accountHash) &&
          existingWorkspaces[getWorkspaceKey(accountHash)] === undefined
        ) {
          updates[getWorkspaceKey(accountHash)] = envelope;
          restoredLocked += 1;
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
    if (restoredLocked > 0) {
      parts.push(`${restoredLocked} locked envelope${restoredLocked === 1 ? '' : 's'}`);
    }
    if (preservedExisting > 0) {
      parts.push(`${preservedExisting} kept (already present)`);
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

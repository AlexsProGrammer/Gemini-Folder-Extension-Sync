import {
  VAULT_CHECK_PLAINTEXT,
  VAULT_SALT_BYTES,
  decryptString,
  deriveVaultKey,
  encryptString,
  randomBase64
} from './crypto';
import { parseWorkspace } from './schemas';
import type { WorkspacePayload } from './types';

/**
 * Local vault: zero-knowledge storage for account workspaces at rest.
 *
 * Every workspace partition is written to `chrome.storage.local` exclusively
 * as an AES-GCM-256 envelope. The encryption key is derived with PBKDF2
 * (SHA-256, 310k iterations) from the raw account identifier (the Google
 * account email or its stable fallback) plus a random per-account salt, so
 * plaintext project names, chat titles and prompt contents never touch disk.
 * A reader without the logged-in account's identity cannot reconstruct the
 * key, and the envelope carries no readable references to the data inside.
 *
 * When a sync passphrase is configured it protects the SERVER copy; the local
 * vault intentionally keys off the account identity alone so changing the
 * sync passphrase can never lock the user out of locally cached data.
 */

export interface VaultCheckChunk {
  iv: string;
  ciphertext: string;
}

export interface VaultMeta {
  v: 1;
  /** Base64 PBKDF2 salt, unique per account partition. */
  salt: string;
  /** AES-GCM seal of a fixed constant; proves a derived key is correct. */
  check: VaultCheckChunk;
}

export interface LocalVaultEnvelope {
  /** Envelope format marker; plain (legacy) workspaces never carry this. */
  gpv: 3;
  iv: string;
  ciphertext: string;
  vault: VaultMeta;
}

export function isLocalVaultEnvelope(raw: unknown): raw is LocalVaultEnvelope {
  if (!raw || typeof raw !== 'object') return false;
  const candidate = raw as Partial<LocalVaultEnvelope>;
  return (
    candidate.gpv === 3 &&
    typeof candidate.iv === 'string' &&
    typeof candidate.ciphertext === 'string' &&
    Boolean(candidate.vault && typeof candidate.vault === 'object')
  );
}

/** Thrown when an envelope exists but no derivable key can open it. */
export class VaultLockedError extends Error {
  readonly accountHash: string;

  constructor(accountHash: string) {
    super('Workspace vault is locked: the account identity could not open this partition.');
    this.name = 'VaultLockedError';
    this.accountHash = accountHash;
  }
}

/** Ephemeral, non-extractable CryptoKeys; never persisted. */
const keyCache = new Map<string, CryptoKey>();

export function invalidateVaultCache(accountHash: string): void {
  const prefix = `${accountHash}|`;
  Array.from(keyCache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) keyCache.delete(key);
  });
}

async function resolveVaultKey(accountHash: string, rawIdentifier: string, salt: string): Promise<CryptoKey> {
  const cacheKey = `${accountHash}|${salt}|${rawIdentifier.toLowerCase().trim()}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  // Binding the PBKDF2 secret to the account hash prevents a vault belonging
  // to one account from being opened with another account's identifier even
  // if the salts happened to collide.
  const key = await deriveVaultKey(`${rawIdentifier}::${accountHash}`, salt);
  keyCache.set(cacheKey, key);
  return key;
}

async function sealCheck(key: CryptoKey): Promise<VaultCheckChunk> {
  const sealed = await encryptString(VAULT_CHECK_PLAINTEXT, key);
  return { iv: sealed.iv, ciphertext: sealed.ciphertext };
}

async function openCheck(key: CryptoKey, check: VaultCheckChunk): Promise<boolean> {
  try {
    const plaintext = await decryptString(check.ciphertext, check.iv, key);
    return plaintext === VAULT_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

export interface VaultOpenResult {
  payload: WorkspacePayload;
  /** Metadata to hand back into sealWorkspaceEnvelope for salt continuity. */
  meta: VaultMeta;
  /** True when the stored value was a legacy plaintext workspace. */
  legacyPlaintext?: boolean;
}

/**
 * Opens a raw storage value for an account partition.
 *
 * - Legacy plaintext workspaces (pre-vault) are parsed and returned as-is;
 *   the next save seals them into an envelope.
 * - Envelopes are decrypted; a key mismatch (wrong account identity) throws
 *   VaultLockedError instead of fabricating an empty workspace, so locked
 *   data is never silently destroyed by an overwrite.
 */
export async function openWorkspaceEnvelope(
  accountHash: string,
  rawIdentifier: string,
  raw: unknown
): Promise<VaultOpenResult | null> {
  if (raw === undefined || raw === null) return null;

  if (!isLocalVaultEnvelope(raw)) {
    // Legacy plaintext payload: validate and hand through; the next write
    // seals it. A fresh salt is minted here and adopted by the first seal.
    const payload = parseWorkspace(raw);
    return { payload, meta: createPlaceholderMeta(), legacyPlaintext: true };
  }

  const meta = raw.vault;
  const key = await resolveVaultKey(accountHash, rawIdentifier, meta.salt);
  if (!(await openCheck(key, meta.check))) {
    throw new VaultLockedError(accountHash);
  }

  const plaintext = await decryptString(raw.ciphertext, raw.iv, key);
  const parsed = JSON.parse(plaintext) as unknown;
  const payload = parseWorkspace(parsed);
  return { payload, meta };
}

function createPlaceholderMeta(): VaultMeta {
  // Placeholder meta; sealWorkspaceEnvelope always replaces the check chunk
  // under the real key before anything is persisted.
  return {
    v: 1,
    salt: randomBase64(VAULT_SALT_BYTES),
    check: { iv: '', ciphertext: '' }
  };
}

/**
 * Serializes and encrypts a workspace payload into the on-disk envelope.
 * Reuses the existing salt when present so the derived key stays stable
 * across saves (keeping the in-memory key cache effective).
 */
export async function sealWorkspaceEnvelope(
  accountHash: string,
  rawIdentifier: string,
  payload: WorkspacePayload,
  existingMeta?: VaultMeta
): Promise<LocalVaultEnvelope> {
  const salt = existingMeta?.salt ?? randomBase64(VAULT_SALT_BYTES);
  const key = await resolveVaultKey(accountHash, rawIdentifier, salt);
  const sealed = await encryptString(JSON.stringify(payload), key);
  return {
    gpv: 3,
    iv: sealed.iv,
    ciphertext: sealed.ciphertext,
    vault: {
      v: 1,
      salt,
      check: await sealCheck(key)
    }
  };
}


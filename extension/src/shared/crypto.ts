import { WorkspacePayload } from './types';
import { WorkspacePayloadSchema } from './schemas';

/**
 * OWASP-aligned PBKDF2 budget: 310,000 SHA-256 iterations resist offline
 * dictionary attacks on user passphrases while keeping derivation below ~500ms
 * on commodity hardware (AES-NI accelerated).
 */
const PBKDF2_ITERATIONS = 310_000;
const AES_GCM_KEY_LENGTH = 256;
/** 96-bit initialization vector, the recommended size for AES-GCM. */
const IV_BYTE_LENGTH = 12;

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available in this context.');
  }
  return subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Derives an ephemeral AES-GCM-256 CryptoKey from a user passphrase via
 * PBKDF2 (SHA-256, 310k iterations). The account identifier hash doubles as
 * the salt, binding keys to a single workspace partition. The resulting key
 * lives exclusively in transient memory and must never be persisted.
 */
export async function deriveWorkspaceKey(passphrase: string, saltHex: string): Promise<CryptoKey> {
  const subtle = getSubtle();
  const encoder = new TextEncoder();

  const baseKey = await subtle.importKey(
    'raw',
    encoder.encode(passphrase) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(saltHex) as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: AES_GCM_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Serializes the unified workspace payload to JSON, encrypts it with AES-GCM
 * using a fresh 12-byte random IV, and returns Base64-encoded ciphertext and
 * IV. Only ciphertext ever leaves the browser (zero-knowledge guarantee).
 */
export async function encryptWorkspace(
  payload: WorkspacePayload,
  key: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  const subtle = getSubtle();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload)) as unknown as BufferSource;

  const buffer = await subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, plaintext);
  return {
    ciphertext: bytesToBase64(new Uint8Array(buffer)),
    iv: bytesToBase64(iv)
  };
}

/**
 * Decrypts a Base64 AES-GCM envelope and re-validates the JSON structure via
 * the workspace Zod schema, guaranteeing no corrupted partial objects are ever
 * surfaced. Throws a DOMException on authentication failure (wrong passphrase
 * or tampered ciphertext tag).
 */
export async function decryptWorkspace(
  ciphertextB64: string,
  ivB64: string,
  key: CryptoKey
): Promise<WorkspacePayload> {
  const subtle = getSubtle();
  const buffer = await subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) as unknown as BufferSource },
    key,
    base64ToBytes(ciphertextB64) as unknown as BufferSource
  );

  const json = new TextDecoder().decode(buffer);
  const raw = JSON.parse(json) as unknown;
  return WorkspacePayloadSchema.parse(raw) as WorkspacePayload;
}

/**
 * Cheap cryptographic authentication probe: returns true only when the
 * envelope decrypts cleanly under the given key (correct passphrase), false
 * on tag mismatch or corruption without materializing any plaintext.
 */
export async function testPassphrase(
  ciphertextB64: string,
  ivB64: string,
  key: CryptoKey
): Promise<boolean> {
  const subtle = getSubtle();
  try {
    await subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(ivB64) as unknown as BufferSource },
      key,
      base64ToBytes(ciphertextB64) as unknown as BufferSource
    );
    return true;
  } catch {
    return false;
  }
}

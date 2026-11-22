import { WorkspacePayload } from './types';
import { parseWorkspace } from './schemas';
import { debugLog } from './storage';

/**
 * OWASP-aligned PBKDF2 budget: 310,000 SHA-256 iterations resist offline
 * dictionary attacks on user passphrases while keeping derivation below ~500ms
 * on commodity hardware (AES-NI accelerated).
 */
const PBKDF2_ITERATIONS = 310_000;
const AES_GCM_KEY_LENGTH = 256;
/** 96-bit initialization vector, the recommended size for AES-GCM. */
const IV_BYTE_LENGTH = 12;
/** 1-byte plaintext envelope format markers for pre-encryption compression. */
const PAYLOAD_FORMAT_RAW = 0x00;
const PAYLOAD_FORMAT_GZIP = 0x01;
/** Client-side guard before hitting the 10 MB backend body limit. */
export const MAX_SYNC_CIPHERTEXT_BYTES = 9_500_000;

export class PayloadTooLargeError extends Error {
  constructor(bytes: number) {
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    super(`Sync payload is too large (${mb} MB). Remove unused items or large notes before syncing.`);
    this.name = 'PayloadTooLargeError';
  }
}

async function readStreamToUint8Array(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      const local = new Uint8Array(Array.from(value));
      chunks.push(local);
      total += local.byteLength;
    }
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function compressPayloadBytes(jsonBytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'function') {
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      const writePromise = writer.write(jsonBytes as unknown as BufferSource).then(() => writer.close());
      const [compressed] = await Promise.all([readStreamToUint8Array(cs.readable), writePromise]);
      if (compressed.byteLength + 1 < jsonBytes.byteLength) {
        const out = new Uint8Array(compressed.byteLength + 1);
        out[0] = PAYLOAD_FORMAT_GZIP;
        out.set(compressed, 1);
        return out;
      }
    } catch {
      // Fall back to uncompressed envelope if CompressionStream fails.
    }
  }
  const out = new Uint8Array(jsonBytes.byteLength + 1);
  out[0] = PAYLOAD_FORMAT_RAW;
  out.set(jsonBytes, 1);
  return out;
}

async function decompressPayloadBytes(rawBuffer: ArrayBuffer): Promise<string> {
  // Copy out of any Firefox Xray-wrapped ArrayBuffer into current compartment first.
  const bytes = new Uint8Array(Array.from(new Uint8Array(rawBuffer)));
  if (bytes.byteLength === 0) {
    throw new Error('Decrypted payload is empty.');
  }

  const marker = bytes[0];
  let jsonBytes: Uint8Array;

  if (marker === PAYLOAD_FORMAT_GZIP) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('DecompressionStream is unavailable to read gzip sync payload.');
    }
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const compressed = bytes.slice(1);
    const writePromise = writer.write(compressed as unknown as BufferSource).then(() => writer.close());
    [jsonBytes] = await Promise.all([readStreamToUint8Array(ds.readable), writePromise]);
  } else if (marker === PAYLOAD_FORMAT_RAW) {
    jsonBytes = bytes.slice(1);
  } else if (marker === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const writePromise = writer.write(bytes as unknown as BufferSource).then(() => writer.close());
    [jsonBytes] = await Promise.all([readStreamToUint8Array(ds.readable), writePromise]);
  } else {
    // Legacy uncompressed UTF-8 JSON (starts with '{' = 0x7b).
    jsonBytes = bytes;
  }

  return new TextDecoder().decode(jsonBytes);
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available in this context.');
  }
  return subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Firefox content scripts see crypto.subtle through an Xray wrapper, so the
  // ArrayBuffers it returns live in the page realm. Calling typed-array
  // prototype methods (.subarray/.slice) on views over such buffers throws
  // 'Permission denied to access property "constructor"' at the engine's
  // security check. Element/index reads ARE safe, so copy the bytes into this
  // compartment with Array.from first, then chunk over the plain array.
  // Verified on Firefox 158: subarray/slice throw, Array.from + slice works.
  const local = Array.from(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < local.length; offset += chunkSize) {
    binary += String.fromCharCode(...local.slice(offset, offset + chunkSize));
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
  debugLog(`deriveWorkspaceKey: attempt (salt length: ${saltHex?.length ?? 'invalid'}, passphrase present: ${passphrase?.length > 0})`);

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
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  const plaintext = await compressPayloadBytes(jsonBytes);

  try {
    const buffer = await subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      plaintext as unknown as BufferSource
    );
    const ciphertext = bytesToBase64(new Uint8Array(buffer));
    if (ciphertext.length > MAX_SYNC_CIPHERTEXT_BYTES) {
      throw new PayloadTooLargeError(ciphertext.length);
    }
    debugLog(
      `encryptWorkspace: success (raw: ${jsonBytes.byteLength}B, packed: ${plaintext.byteLength}B, b64: ${ciphertext.length}B, version: ${payload.version})`
    );
    return {
      ciphertext,
      iv: bytesToBase64(iv)
    };
  } catch (error) {
    console.error('[gemini-projects] encryptWorkspace failed', error);
    throw error;
  }
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
  try {
    const buffer = await subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(ivB64) as unknown as BufferSource },
      key,
      base64ToBytes(ciphertextB64) as unknown as BufferSource
    );

    const json = await decompressPayloadBytes(buffer);
    const raw = JSON.parse(json) as unknown;
    debugLog('decryptWorkspace: success (payload decrypted and validated)');
    return parseWorkspace(raw);
  } catch (error) {
    console.error('[gemini-projects] decryptWorkspace failed (wrong passphrase, corrupted payload, or schema mismatch)', error);
    throw error;
  }
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

/* ------------------------------------------------------------------ *
 * Local vault primitives (zero-knowledge storage at rest)
 * ------------------------------------------------------------------ */

/** 128-bit random salt for the per-account local vault KDF. */
export const VAULT_SALT_BYTES = 16;
/** Fixed plaintext used to verify a derived vault key without touching data. */
export const VAULT_CHECK_PLAINTEXT = 'gp-vault-check-v3';

export function randomBase64(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes);
}

export function base64ToUint8Array(value: string): Uint8Array {
  return base64ToBytes(value);
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}

/** Derives the local vault AES-GCM-256 key from an arbitrary secret + salt. */
export async function deriveVaultKey(secret: string, saltB64: string): Promise<CryptoKey> {
  return deriveWorkspaceKey(secret, saltB64);
}

/** Encrypts a UTF-8 string under the given key with a fresh IV. */
export async function encryptString(
  plaintext: string,
  key: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  const subtle = getSubtle();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const buffer = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as unknown as BufferSource
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(buffer)),
    iv: bytesToBase64(iv)
  };
}

/** Decrypts a Base64 AES-GCM envelope back into a UTF-8 string. */
export async function decryptString(
  ciphertextB64: string,
  ivB64: string,
  key: CryptoKey
): Promise<string> {
  const subtle = getSubtle();
  const buffer = await subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(ivB64) as unknown as BufferSource },
    key,
    base64ToBytes(ciphertextB64) as unknown as BufferSource
  );
  return new TextDecoder().decode(buffer);
}

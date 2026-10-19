/**
 * Content fingerprint for prompt deduplication.
 *
 * Sync merges used to key prompts solely by their UUID. The same prompt
 * created independently on two devices carries two different UUIDs, so both
 * copies survived every merge and the library duplicated itself after sync.
 * The fingerprint hashes the prompt's title + content (whitespace-normalized)
 * so identical prompts collapse into one entry regardless of which device
 * created them.
 */

function normalizeForFingerprint(value: string): string {
  return value.replace(/\r?\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

/**
 * Deterministic 64-bit hash (two mixed 32-bit FNV-1a lanes). Synchronous and
 * dependency-free so it can run inside the merge functions; collision risk
 * across realistic prompt libraries is negligible.
 */
function hash64(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (code + i) | 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function promptFingerprint(prompt: { title: string; content: string }): string {
  return hash64(`${normalizeForFingerprint(prompt.title)}\n${normalizeForFingerprint(prompt.content)}`);
}

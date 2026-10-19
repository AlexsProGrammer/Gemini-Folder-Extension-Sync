import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

const KEY_ENV_PATTERN = /^API_KEY_([A-Z0-9_]+)$/;
const ACCOUNTS_ENV_PATTERN = /^API_KEY_([A-Z0-9_]+)_ACCOUNTS$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{64}$/;
const WILDCARD = '*';
const LEGACY_NAME = 'default';
const MIN_SECRET_LENGTH = 16;

export interface ApiKeyIdentity {
  readonly name: string;
  readonly allowsAllAccounts: boolean;
  readonly allowedAccounts: ReadonlySet<string>;
}

interface RegistryEntry extends ApiKeyIdentity {
  readonly digest: Buffer;
}

/**
 * Scans the environment for API keys at startup and validates tokens against
 * them in constant time (SHA-256 digest lookup, never a string comparison).
 *
 * Supported variables:
 *   API_KEY                      legacy single key, allowed on all accounts
 *   API_KEY_<NAME>=<secret>      per-person key; the label is operator
 *                                bookkeeping only and is never sent by clients
 *   API_KEY_<NAME>_ACCOUNTS      "*" for all accounts, or a comma-separated
 *                                list of 64-char hex account hashes
 *
 * Fail-closed: startup aborts if a named key lacks _ACCOUNTS, a secret is too
 * short, an account id is malformed, or the same secret is assigned twice.
 */
@Injectable()
export class ApiKeyRegistry {
  private readonly logger = new Logger(ApiKeyRegistry.name);
  private readonly entriesByDigest = new Map<string, RegistryEntry>();
  private readonly entriesByName = new Map<string, RegistryEntry>();

  constructor() {
    this.registerFromEnvironment();
  }

  resolve(token: string): ApiKeyIdentity | null {
    if (token.length === 0) {
      return null;
    }
    const digest = createHash('sha256').update(token).digest();
    return this.entriesByDigest.get(digest.toString('hex')) ?? null;
  }

  private registerFromEnvironment(): void {
    const secrets = new Map<string, string>();
    const accountLists = new Map<string, string>();

    const legacy = process.env.API_KEY;
    if (legacy !== undefined && legacy.length > 0) {
      secrets.set(LEGACY_NAME, legacy);
    }

    for (const [envName, value] of Object.entries(process.env)) {
      const keyMatch = KEY_ENV_PATTERN.exec(envName);
      if (keyMatch !== null && !keyMatch[1].endsWith('_ACCOUNTS')) {
        secrets.set(keyMatch[1], value ?? '');
      }

      const accountsMatch = ACCOUNTS_ENV_PATTERN.exec(envName);
      if (accountsMatch !== null) {
        accountLists.set(accountsMatch[1], value ?? '');
      }
    }

    for (const [name, secret] of secrets) {
      this.register(name, secret, accountLists.get(name));
    }

    if (this.entriesByDigest.size === 0) {
      this.logger.warn('No API keys configured (API_KEY or API_KEY_<NAME>) — every request will be rejected.');
    } else {
      const summary = [...this.entriesByName.values()]
        .map((entry) => (entry.allowsAllAccounts ? `${entry.name} (all accounts)` : `${entry.name} (${entry.allowedAccounts.size} account(s))`))
        .join(', ');
      this.logger.log(`Registered ${this.entriesByDigest.size} API key(s): ${summary}`);
    }
  }

  private register(name: string, secret: string, accountList: string | undefined): void {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `API key "${name}" is too short (${secret.length} chars); use at least ${MIN_SECRET_LENGTH} characters, e.g. \`openssl rand -base64 32\`.`
      );
    }

    const digestHex = createHash('sha256').update(secret).digest('hex');
    if (this.entriesByDigest.has(digestHex)) {
      throw new Error(`The same API key secret is assigned more than once (e.g. "${name}"); each key must be unique.`);
    }

    let allowsAllAccounts: boolean;
    let allowedAccounts: ReadonlySet<string>;

    if (accountList === undefined) {
      if (name === LEGACY_NAME) {
        allowsAllAccounts = true;
        allowedAccounts = new Set();
      } else {
        throw new Error(
          `API_KEY_${name} has no API_KEY_${name}_ACCOUNTS variable. Add one with "*" (all accounts) or a comma-separated list of 64-char hex account hashes.`
        );
      }
    } else {
      const trimmed = accountList.trim();
      if (trimmed === WILDCARD) {
        allowsAllAccounts = true;
        allowedAccounts = new Set();
      } else {
        allowsAllAccounts = false;
        const mutable = new Set<string>();
        for (const part of trimmed.split(',')) {
          const accountId = part.trim();
          if (accountId.length === 0) {
            continue;
          }
          if (!ACCOUNT_ID_PATTERN.test(accountId)) {
            throw new Error(
              `API_KEY_${name}_ACCOUNTS contains an invalid account hash: "${accountId}". Use "*" or 64-character lowercase hex hashes (from the extension's sync settings).`
            );
          }
          mutable.add(accountId);
        }
        if (mutable.size === 0) {
          throw new Error(`API_KEY_${name}_ACCOUNTS is empty; use "*" for all accounts or list at least one account hash.`);
        }
        allowedAccounts = mutable;
      }
    }

    const entry: RegistryEntry = {
      name,
      allowsAllAccounts,
      allowedAccounts,
      digest: Buffer.from(digestHex, 'hex')
    };
    this.entriesByDigest.set(digestHex, entry);
    this.entriesByName.set(name, entry);
  }
}

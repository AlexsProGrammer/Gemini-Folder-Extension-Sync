import { describe, expect, it } from 'vitest';
import { ApiKeyRegistry } from './api-key.registry';

const withEnv = (env: Record<string, string | undefined>, run: () => void): void => {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const ACCOUNT = 'a'.repeat(64);

describe('ApiKeyRegistry', () => {
  it('resolves the legacy API_KEY as an unrestricted key', () => {
    withEnv({ API_KEY: 'legacy_secret_for_testing_only', API_KEY_ALICE: undefined, API_KEY_ALICE_ACCOUNTS: undefined }, () => {
      const registry = new ApiKeyRegistry();
      const identity = registry.resolve('legacy_secret_for_testing_only');
      expect(identity).toEqual({ name: 'default', allowsAllAccounts: true, allowedAccounts: new Set() });
      expect(registry.resolve('nope')).toBeNull();
    });
  });

  it('registers a named key bound to specific accounts', () => {
    withEnv(
      {
        API_KEY: undefined,
        API_KEY_ALICE: 'named_secret_for_testing_only',
        API_KEY_ALICE_ACCOUNTS: `${ACCOUNT}, ${'b'.repeat(64)}`
      },
      () => {
        const registry = new ApiKeyRegistry();
        const identity = registry.resolve('named_secret_for_testing_only');
        expect(identity).toEqual({
          name: 'ALICE',
          allowsAllAccounts: false,
          allowedAccounts: new Set([ACCOUNT, 'b'.repeat(64)])
        });
      }
    );
  });

  it('registers a named key with the * wildcard', () => {
    withEnv({ API_KEY: undefined, API_KEY_ALICE: 'wildcard_secret_for_testing', API_KEY_ALICE_ACCOUNTS: '*' }, () => {
      const registry = new ApiKeyRegistry();
      const identity = registry.resolve('wildcard_secret_for_testing');
      expect(identity).toEqual({ name: 'ALICE', allowsAllAccounts: true, allowedAccounts: new Set() });
    });
  });

  it('rejects a named key without an _ACCOUNTS variable', () => {
    withEnv({ API_KEY: undefined, API_KEY_ALICE: 'orphan_secret_for_testing', API_KEY_ALICE_ACCOUNTS: undefined }, () => {
      expect(() => new ApiKeyRegistry()).toThrow(/has no API_KEY_ALICE_ACCOUNTS/);
    });
  });

  it('rejects secrets shorter than 16 characters', () => {
    withEnv({ API_KEY: undefined, API_KEY_ALICE: 'short', API_KEY_ALICE_ACCOUNTS: '*' }, () => {
      expect(() => new ApiKeyRegistry()).toThrow(/too short/);
    });
  });

  it('rejects malformed account hashes in _ACCOUNTS', () => {
    withEnv({ API_KEY: undefined, API_KEY_ALICE: 'valid_secret_for_testing', API_KEY_ALICE_ACCOUNTS: 'not-a-hash' }, () => {
      expect(() => new ApiKeyRegistry()).toThrow(/invalid account hash/);
    });
  });

  it('rejects the same secret assigned to two keys', () => {
    withEnv(
      {
        API_KEY: undefined,
        API_KEY_ALICE: 'shared_secret_for_testing_x',
        API_KEY_ALICE_ACCOUNTS: '*',
        API_KEY_BOB: 'shared_secret_for_testing_x',
        API_KEY_BOB_ACCOUNTS: '*'
      },
      () => {
        expect(() => new ApiKeyRegistry()).toThrow(/assigned more than once/);
      }
    );
  });

  it('does not treat _ACCOUNTS variables as keys themselves', () => {
    withEnv(
      {
        API_KEY: undefined,
        API_KEY_ALICE: 'only_real_secret_testing',
        API_KEY_ALICE_ACCOUNTS: ACCOUNT
      },
      () => {
        const registry = new ApiKeyRegistry();
        expect(registry.resolve(ACCOUNT)).toBeNull();
        expect(registry.resolve('only_real_secret_testing')).not.toBeNull();
      }
    );
  });

  it('warns but does not throw when no keys are configured', () => {
    withEnv({ API_KEY: undefined }, () => {
      const registry = new ApiKeyRegistry();
      expect(registry.resolve('anything')).toBeNull();
    });
  });
});

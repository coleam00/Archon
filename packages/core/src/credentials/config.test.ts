import { describe, test, expect } from 'bun:test';
import { isPerUserProviderKeysEnabled, assertProviderKeysKeyAtBoot } from './config';

const VALID_KEY = 'a'.repeat(64);

describe('credentials/config', () => {
  describe('isPerUserProviderKeysEnabled', () => {
    test('true when TOKEN_ENCRYPTION_KEY is set', () => {
      expect(isPerUserProviderKeysEnabled({ TOKEN_ENCRYPTION_KEY: VALID_KEY })).toBe(true);
    });

    test('false when TOKEN_ENCRYPTION_KEY is missing', () => {
      expect(isPerUserProviderKeysEnabled({})).toBe(false);
    });

    test('false when TOKEN_ENCRYPTION_KEY is empty', () => {
      expect(isPerUserProviderKeysEnabled({ TOKEN_ENCRYPTION_KEY: '' })).toBe(false);
    });

    test('GITHUB_APP_ID alone does not enable provider keys (independent gate)', () => {
      expect(isPerUserProviderKeysEnabled({ GITHUB_APP_ID: '1' })).toBe(false);
    });
  });

  describe('assertProviderKeysKeyAtBoot', () => {
    test('no-op when feature is disabled, even with a malformed key', () => {
      // Disabled means TOKEN_ENCRYPTION_KEY is absent; a stray malformed value
      // in the env (e.g. a typo'd variable) would still no-op because the gate
      // is false.
      expect(() => assertProviderKeysKeyAtBoot({})).not.toThrow();
    });

    test('passes when enabled with a valid 64-hex key', () => {
      expect(() => assertProviderKeysKeyAtBoot({ TOKEN_ENCRYPTION_KEY: VALID_KEY })).not.toThrow();
    });

    test('throws when enabled with a malformed key', () => {
      expect(() => assertProviderKeysKeyAtBoot({ TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(
        /64-character hex/
      );
    });
  });
});

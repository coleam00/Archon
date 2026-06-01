import { describe, test, expect } from 'bun:test';
import { isPerUserGitHubEnabled, loadDeviceFlowConfig, assertEncryptionKeyAtBoot } from './config';

const VALID_KEY = 'a'.repeat(64);

describe('github-auth/config', () => {
  describe('isPerUserGitHubEnabled', () => {
    test('true only when both GITHUB_APP_ID and TOKEN_ENCRYPTION_KEY are set', () => {
      expect(isPerUserGitHubEnabled({ GITHUB_APP_ID: '1', TOKEN_ENCRYPTION_KEY: VALID_KEY })).toBe(
        true
      );
    });

    test('false when GITHUB_APP_ID is missing', () => {
      expect(isPerUserGitHubEnabled({ TOKEN_ENCRYPTION_KEY: VALID_KEY })).toBe(false);
    });

    test('false when TOKEN_ENCRYPTION_KEY is missing', () => {
      expect(isPerUserGitHubEnabled({ GITHUB_APP_ID: '1' })).toBe(false);
    });

    test('false when both are missing', () => {
      expect(isPerUserGitHubEnabled({})).toBe(false);
    });
  });

  describe('loadDeviceFlowConfig', () => {
    test('returns the trimmed client id', () => {
      expect(loadDeviceFlowConfig({ GITHUB_APP_CLIENT_ID: '  Iv1.abc  ' })).toEqual({
        clientId: 'Iv1.abc',
      });
    });

    test('throws an actionable error when GITHUB_APP_CLIENT_ID is absent', () => {
      expect(() => loadDeviceFlowConfig({})).toThrow(/GITHUB_APP_CLIENT_ID is required/);
    });

    test('throws when GITHUB_APP_CLIENT_ID is blank', () => {
      expect(() => loadDeviceFlowConfig({ GITHUB_APP_CLIENT_ID: '   ' })).toThrow(
        /GITHUB_APP_CLIENT_ID is required/
      );
    });
  });

  describe('assertEncryptionKeyAtBoot', () => {
    test('no-op when per-user GitHub is disabled, even with a malformed key', () => {
      expect(() => assertEncryptionKeyAtBoot({ TOKEN_ENCRYPTION_KEY: 'short' })).not.toThrow();
    });

    test('passes when enabled with a valid 64-hex key', () => {
      expect(() =>
        assertEncryptionKeyAtBoot({ GITHUB_APP_ID: '1', TOKEN_ENCRYPTION_KEY: VALID_KEY })
      ).not.toThrow();
    });

    test('throws when enabled with a malformed key', () => {
      expect(() =>
        assertEncryptionKeyAtBoot({ GITHUB_APP_ID: '1', TOKEN_ENCRYPTION_KEY: 'short' })
      ).toThrow(/64-character hex/);
    });
  });
});

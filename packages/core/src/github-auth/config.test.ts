// @archon-test-isolated
import { describe, test, expect } from 'bun:test';
import {
  isPerUserGitHubEnabled,
  loadDeviceFlowConfig,
  assertEncryptionKeyAtBoot,
  resolveGitHubHost,
  resolveGitHubTokenFromEnv,
} from './config';

const VALID_KEY = 'a'.repeat(64);

describe('github-auth/config', () => {
  test.each([
    [{ GITHUB_TOKEN: 'github-token', GH_TOKEN: 'gh-token' }, 'gh-token'],
    [{ GH_TOKEN: 'gh-token' }, 'gh-token'],
    [{ GITHUB_TOKEN: 'github-token' }, 'github-token'],
    [{}, undefined],
    [{ GH_TOKEN: '', GITHUB_TOKEN: 'github-token' }, 'github-token'],
    [{ GH_TOKEN: 'gh-token', GITHUB_TOKEN: '' }, 'gh-token'],
    [{ GH_TOKEN: '', GITHUB_TOKEN: '' }, undefined],
  ])('resolves GH_TOKEN before GITHUB_TOKEN: %j', (env, expected) => {
    expect(resolveGitHubTokenFromEnv(env)).toBe(expected);
  });

  describe('resolveGitHubHost', () => {
    const githubCom = {
      host: 'github.com',
      webUrl: 'https://github.com',
      apiBaseUrl: 'https://api.github.com',
    };

    test.each([{}, { GITHUB_URL: '' }, { GITHUB_URL: 'https://github.com' }])(
      'resolves github.com for %j',
      env => {
        expect(resolveGitHubHost(env)).toEqual(githubCom);
      }
    );

    test.each([
      [
        'https://github.example.com/',
        {
          host: 'github.example.com',
          webUrl: 'https://github.example.com',
          apiBaseUrl: 'https://github.example.com/api/v3',
        },
      ],
      [
        'http://GHE.internal:8080',
        {
          host: 'ghe.internal:8080',
          webUrl: 'http://ghe.internal:8080',
          apiBaseUrl: 'http://ghe.internal:8080/api/v3',
        },
      ],
    ])('resolves the Enterprise host for GITHUB_URL=%s', (value, expected) => {
      expect(resolveGitHubHost({ GITHUB_URL: value })).toEqual(expected);
    });

    test.each([
      'not a url',
      'github.example.com',
      'ftp://github.example.com',
      'https://github.example.com/api/v3',
      'https://user:pass@github.example.com',
      'https://github.example.com/?x=1',
    ])('rejects GITHUB_URL=%s', value => {
      expect(() => resolveGitHubHost({ GITHUB_URL: value })).toThrow('GITHUB_URL');
    });
  });

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

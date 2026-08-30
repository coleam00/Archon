import { describe, test, expect } from 'bun:test';
import { isPerUserGitHubEnabled, loadDeviceFlowConfig, assertEncryptionKeyAtBoot } from './config';
import {
  startDeviceFlow,
  pollDeviceFlowOnce,
  refreshUserToken,
  fetchGithubUser,
  DeviceFlowError,
} from './device-flow';
import { installCredentialHelper } from './credential-helper-install';

describe('github-auth module exports & stubs', () => {
  describe('OAuth device flow configuration & gates', () => {
    test('isPerUserGitHubEnabled gates on GITHUB_CLIENT_ID and TOKEN_ENCRYPTION_KEY', () => {
      expect(isPerUserGitHubEnabled({})).toBe(false);
      expect(
        isPerUserGitHubEnabled({
          GITHUB_CLIENT_ID: 'Iv1.test',
          TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
        })
      ).toBe(true);
    });

    test('loadDeviceFlowConfig extracts trimmed client id', () => {
      expect(loadDeviceFlowConfig({ GITHUB_CLIENT_ID: '  Iv1.test  ' })).toEqual({
        clientId: 'Iv1.test',
      });
      expect(() => loadDeviceFlowConfig({})).toThrow('GITHUB_CLIENT_ID is required');
    });

    test('assertEncryptionKeyAtBoot validates key format when enabled', () => {
      expect(() =>
        assertEncryptionKeyAtBoot({
          GITHUB_CLIENT_ID: 'Iv1.test',
          TOKEN_ENCRYPTION_KEY: 'too-short',
        })
      ).toThrow();
    });
  });

  describe('OAuth device flow exports', () => {
    test('exports DeviceFlowError and API functions', () => {
      expect(typeof startDeviceFlow).toBe('function');
      expect(typeof pollDeviceFlowOnce).toBe('function');
      expect(typeof refreshUserToken).toBe('function');
      expect(typeof fetchGithubUser).toBe('function');
      expect(typeof installCredentialHelper).toBe('function');

      const err = new DeviceFlowError('access_denied', 'User denied');
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe('access_denied');
      expect(err.message).toBe('User denied');
    });
  });
});

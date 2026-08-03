import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { isPerUserProviderKeysEnabled, assertProviderKeysKeyAtBoot } from './config';
import { isPerUserGitHubEnabled } from '../github-auth/config';
import { clearLocalKeyCache } from '../utils/token-crypto';

const VALID_KEY = 'a'.repeat(64);

// A temp ARCHON_HOME lets assertProviderKeysKeyAtBoot() write the auto-generated
// key file without polluting the real ~/.archon/credential-key on a dev machine.
let tmpDir: string;
let origHome: string | undefined;
let tmpCounter = 0;

beforeEach(() => {
  origHome = process.env.ARCHON_HOME;
  tmpDir = join(tmpdir(), `archon-config-test-${process.pid}-${tmpCounter++}`);
  mkdirSync(tmpDir, { recursive: true });
  process.env.ARCHON_HOME = tmpDir;
  clearLocalKeyCache();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = origHome;
  clearLocalKeyCache();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('credentials/config', () => {
  describe('isPerUserProviderKeysEnabled', () => {
    test('true when TOKEN_ENCRYPTION_KEY is set', () => {
      expect(isPerUserProviderKeysEnabled({ TOKEN_ENCRYPTION_KEY: VALID_KEY })).toBe(true);
    });

    test('true without TOKEN_ENCRYPTION_KEY (auto-key enabled by default)', () => {
      expect(isPerUserProviderKeysEnabled({})).toBe(true);
    });

    test('true with an empty TOKEN_ENCRYPTION_KEY (auto-key fallback)', () => {
      expect(isPerUserProviderKeysEnabled({ TOKEN_ENCRYPTION_KEY: '' })).toBe(true);
    });

    test('GITHUB_APP_ID alone does not gate the AI vault (independent gate)', () => {
      expect(isPerUserProviderKeysEnabled({ GITHUB_APP_ID: '1' })).toBe(true);
    });
  });

  describe('assertProviderKeysKeyAtBoot', () => {
    test('succeeds on a fresh install (auto-generates the local key file)', () => {
      expect(() => assertProviderKeysKeyAtBoot({})).not.toThrow();
    });

    test('succeeds with a valid 64-hex TOKEN_ENCRYPTION_KEY', () => {
      expect(() => assertProviderKeysKeyAtBoot({ TOKEN_ENCRYPTION_KEY: VALID_KEY })).not.toThrow();
    });

    test('throws when TOKEN_ENCRYPTION_KEY is set but malformed', () => {
      expect(() => assertProviderKeysKeyAtBoot({ TOKEN_ENCRYPTION_KEY: 'short' })).toThrow(
        /64-character hex/
      );
    });
  });

  describe('per-user GitHub independence', () => {
    test('auto-key does NOT enable per-user GitHub (needs GITHUB_APP_ID + TOKEN_ENCRYPTION_KEY)', () => {
      expect(isPerUserGitHubEnabled({})).toBe(false);
      expect(isPerUserGitHubEnabled({ GITHUB_APP_ID: '1' })).toBe(false);
      expect(isPerUserGitHubEnabled({ TOKEN_ENCRYPTION_KEY: VALID_KEY })).toBe(false);
      expect(isPerUserGitHubEnabled({ GITHUB_APP_ID: '1', TOKEN_ENCRYPTION_KEY: VALID_KEY })).toBe(
        true
      );
    });
  });
});

import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

const mockRefresh = mock(async () => ({
  access_token: 'ghu_refreshed',
  token_type: 'bearer',
  scope: '',
  expires_in: 28800,
  refresh_token: 'ghr_new',
  refresh_token_expires_in: 15897600,
}));
mock.module('../github-auth/device-flow', () => ({ refreshUserToken: mockRefresh }));
mock.module('../github-auth/config', () => ({
  loadDeviceFlowConfig: () => ({ clientId: 'Iv1.test' }),
}));

import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';
import {
  saveUserGithubToken,
  getUserGithubTokenRecord,
  getDecryptedAccessToken,
  deleteUserGithubToken,
  getUserGithubNoreplyEmail,
} from './user-github-token-store';
import type { UserGithubTokenRow } from '../schemas/user-github-token-row';

function tokenRow(overrides: Partial<UserGithubTokenRow> = {}): UserGithubTokenRow {
  const key = getEncryptionKey();
  return {
    id: 'tok-1',
    user_id: 'user-1',
    github_user_id: 42,
    github_login: 'alice',
    access_token_encrypted: encryptToken('ghu_access', key),
    refresh_token_encrypted: encryptToken('ghr_refresh', key),
    access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    refresh_token_expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 180),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('user-github-token-store', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockRefresh.mockClear();
  });

  describe('saveUserGithubToken', () => {
    test('encrypts the tokens before persisting (plaintext never stored)', async () => {
      await saveUserGithubToken({
        userId: 'user-1',
        githubUserId: 42,
        githubLogin: 'alice',
        accessToken: 'ghu_plaintext',
        refreshToken: 'ghr_plaintext',
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      const accessEnc = params[3] as string;
      const refreshEnc = params[4] as string;
      expect(accessEnc).not.toBe('ghu_plaintext');
      expect(refreshEnc).not.toBe('ghr_plaintext');
      // ...and they decrypt back to the originals
      const key = getEncryptionKey();
      expect(decryptToken(accessEnc, key)).toBe('ghu_plaintext');
      expect(decryptToken(refreshEnc, key)).toBe('ghr_plaintext');
    });

    test('stores null refresh token when none provided', async () => {
      await saveUserGithubToken({
        userId: 'user-1',
        githubUserId: 42,
        githubLogin: 'alice',
        accessToken: 'ghu_x',
      });
      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(params[4]).toBeNull();
    });
  });

  describe('getDecryptedAccessToken', () => {
    test('returns the decrypted access token when not near expiry', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([tokenRow()]));
      expect(await getDecryptedAccessToken('user-1')).toBe('ghu_access');
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    test('returns null when the user has no token row', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      expect(await getDecryptedAccessToken('user-x')).toBeNull();
    });

    test('refreshes when within the expiry buffer and returns the fresh token', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([tokenRow({ access_token_expires_at: new Date(Date.now() + 60 * 1000) })])
      );
      // saveUserGithubToken (the persist after refresh) consumes the next query
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      const result = await getDecryptedAccessToken('user-1');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(result).toBe('ghu_refreshed');
    });

    test('returns null when expired with no refresh token', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          tokenRow({
            access_token_expires_at: new Date(Date.now() - 1000),
            refresh_token_encrypted: null,
          }),
        ])
      );
      expect(await getDecryptedAccessToken('user-1')).toBeNull();
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    test('concurrent reads share a single refresh (per-user in-flight mutex)', async () => {
      // Both callers see a near-expiry row, but the second must reuse the first's
      // in-flight promise so the single-use refresh token is consumed only once.
      const nearExpiry = tokenRow({ access_token_expires_at: new Date(Date.now() + 60 * 1000) });
      mockQuery.mockResolvedValueOnce(createQueryResult([nearExpiry])); // one SELECT
      mockQuery.mockResolvedValueOnce(createQueryResult([])); // one save after refresh

      const [a, b] = await Promise.all([
        getDecryptedAccessToken('user-1'),
        getDecryptedAccessToken('user-1'),
      ]);

      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(a).toBe('ghu_refreshed');
      expect(b).toBe('ghu_refreshed');
    });

    test('refresh failure re-reads and returns a token another writer already rotated', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([tokenRow({ access_token_expires_at: new Date(Date.now() + 60 * 1000) })])
      );
      mockRefresh.mockRejectedValueOnce(new Error('bad_refresh_token'));
      // Re-read finds a freshly-rotated (far-from-expiry) row → use it.
      mockQuery.mockResolvedValueOnce(createQueryResult([tokenRow()]));
      expect(await getDecryptedAccessToken('user-1')).toBe('ghu_access');
    });

    test('refresh failure returns null when the re-read row is still near expiry', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([tokenRow({ access_token_expires_at: new Date(Date.now() + 60 * 1000) })])
      );
      mockRefresh.mockRejectedValueOnce(new Error('bad_refresh_token'));
      mockQuery.mockResolvedValueOnce(
        createQueryResult([tokenRow({ access_token_expires_at: new Date(Date.now() + 60 * 1000) })])
      );
      expect(await getDecryptedAccessToken('user-1')).toBeNull();
    });

    test('persist failure after a successful refresh still returns the fresh token', async () => {
      // refresh succeeds (mockRefresh → ghu_refreshed) but the save throws; the
      // caller must still get a usable token rather than a mislabeled null.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([tokenRow({ access_token_expires_at: new Date(Date.now() + 60 * 1000) })])
      );
      mockQuery.mockRejectedValueOnce(new Error('db write failed')); // saveUserGithubToken
      expect(await getDecryptedAccessToken('user-1')).toBe('ghu_refreshed');
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });

  describe('getUserGithubNoreplyEmail', () => {
    test('formats <id>+<login>@users.noreply.github.com', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([tokenRow()]));
      expect(await getUserGithubNoreplyEmail('user-1')).toBe('42+alice@users.noreply.github.com');
    });

    test('returns null when not connected', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      expect(await getUserGithubNoreplyEmail('user-x')).toBeNull();
    });
  });

  describe('getUserGithubTokenRecord / deleteUserGithubToken', () => {
    test('getUserGithubTokenRecord returns the row', async () => {
      const row = tokenRow();
      mockQuery.mockResolvedValueOnce(createQueryResult([row]));
      expect(await getUserGithubTokenRecord('user-1')).toEqual(row);
    });

    test('deleteUserGithubToken issues a DELETE', async () => {
      await deleteUserGithubToken('user-1');
      const sql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sql).toContain('DELETE FROM remote_agent_user_github_tokens');
    });
  });
});

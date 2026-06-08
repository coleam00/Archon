import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

import { encryptToken, getEncryptionKey } from '../utils/token-crypto';
import {
  saveUserProviderKey,
  getUserProviderKeyRecord,
  listUserProviderKeys,
  deleteUserProviderKey,
  getDecryptedProviderCredential,
  listDecryptedUserProviderCredentials,
} from './user-provider-key-store';
import type { UserProviderKeyRow } from '../schemas/user-provider-key-row';

function apiKeyRow(overrides: Partial<UserProviderKeyRow> = {}): UserProviderKeyRow {
  const key = getEncryptionKey();
  return {
    id: 'pk-1',
    user_id: 'user-1',
    provider: 'openrouter',
    kind: 'api_key',
    api_key_encrypted: encryptToken('sk-or-test', key),
    oauth_creds_encrypted: null,
    label: 'Personal OpenRouter key',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function oauthRow(overrides: Partial<UserProviderKeyRow> = {}): UserProviderKeyRow {
  const key = getEncryptionKey();
  return {
    id: 'pk-2',
    user_id: 'user-1',
    provider: 'codex',
    kind: 'oauth',
    api_key_encrypted: null,
    oauth_creds_encrypted: encryptToken(JSON.stringify({ access: 'oauth-bearer' }), key),
    label: 'ChatGPT subscription',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('user-provider-key-store', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  describe('saveUserProviderKey', () => {
    test('encrypts the api key before persisting (plaintext never stored)', async () => {
      await saveUserProviderKey({
        userId: 'user-1',
        provider: 'openrouter',
        kind: 'api_key',
        apiKey: 'sk-or-plaintext',
      });
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      const apiKeyEnc = params[3] as string;
      const oauthEnc = params[4] as string | null;
      expect(apiKeyEnc).not.toBe('sk-or-plaintext');
      expect(oauthEnc).toBeNull();
    });

    test('encrypts the oauth blob before persisting', async () => {
      await saveUserProviderKey({
        userId: 'user-1',
        provider: 'codex',
        kind: 'oauth',
        oauthCreds: { access: 'tok-xyz', refresh: 'rfk-abc' },
      });
      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      const apiKeyEnc = params[3] as string | null;
      const oauthEnc = params[4] as string;
      expect(apiKeyEnc).toBeNull();
      expect(oauthEnc).not.toContain('tok-xyz');
      expect(oauthEnc).not.toContain('rfk-abc');
    });

    test("throws when kind='api_key' but apiKey is missing", async () => {
      await expect(
        saveUserProviderKey({ userId: 'user-1', provider: 'openrouter', kind: 'api_key' })
      ).rejects.toThrow(/requires apiKey/);
    });

    test("throws when kind='oauth' but oauthCreds is missing", async () => {
      await expect(
        saveUserProviderKey({ userId: 'user-1', provider: 'codex', kind: 'oauth' })
      ).rejects.toThrow(/requires oauthCreds/);
    });
  });

  describe('listUserProviderKeys', () => {
    test('returns provider/kind/label only — no encrypted fields', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { provider: 'claude', kind: 'api_key', label: 'Anthropic key' },
          { provider: 'openrouter', kind: 'api_key', label: null },
        ])
      );
      const rows = await listUserProviderKeys('user-1');
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r).not.toHaveProperty('api_key_encrypted');
        expect(r).not.toHaveProperty('oauth_creds_encrypted');
      }
      // SQL should select only metadata columns.
      const sql = mockQuery.mock.calls[0]?.[0] as string;
      expect(sql).toContain('SELECT provider, kind, label');
      expect(sql).not.toContain('api_key_encrypted');
      expect(sql).not.toContain('oauth_creds_encrypted');
    });
  });

  describe('getUserProviderKeyRecord / deleteUserProviderKey', () => {
    test('returns the row when present', async () => {
      const row = apiKeyRow();
      mockQuery.mockResolvedValueOnce(createQueryResult([row]));
      expect(await getUserProviderKeyRecord('user-1', 'openrouter')).toEqual(row);
    });

    test('returns null when not present', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      expect(await getUserProviderKeyRecord('user-x', 'openrouter')).toBeNull();
    });

    test('issues a DELETE scoped by user and provider', async () => {
      await deleteUserProviderKey('user-1', 'openrouter');
      const sql = mockQuery.mock.calls[0]?.[0] as string;
      const params = mockQuery.mock.calls[0]?.[1] as unknown[];
      expect(sql).toContain('DELETE FROM remote_agent_user_provider_keys');
      expect(params).toEqual(['user-1', 'openrouter']);
    });
  });

  describe('getDecryptedProviderCredential', () => {
    test('returns decrypted api_key credential', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([apiKeyRow()]));
      const cred = await getDecryptedProviderCredential('user-1', 'openrouter');
      expect(cred).toEqual({ kind: 'api_key', apiKey: 'sk-or-test' });
    });

    test('returns null for unconnected provider', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      expect(await getDecryptedProviderCredential('user-x', 'openrouter')).toBeNull();
    });

    test('returns null when api_key ciphertext is missing (corrupt row)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([apiKeyRow({ api_key_encrypted: null })]));
      expect(await getDecryptedProviderCredential('user-1', 'openrouter')).toBeNull();
    });

    test('returns null when ciphertext fails to decrypt (wrong key / tampered)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([apiKeyRow({ api_key_encrypted: 'not-a-valid-ciphertext' })])
      );
      expect(await getDecryptedProviderCredential('user-1', 'openrouter')).toBeNull();
    });

    test('OAuth read path is deferred to G4 — returns null even when row exists', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
      expect(await getDecryptedProviderCredential('user-1', 'codex')).toBeNull();
    });
  });

  describe('listDecryptedUserProviderCredentials', () => {
    test('decrypts api_key rows and skips OAuth rows (G4 pending)', async () => {
      // First call: list metadata (api_key + oauth).
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { provider: 'openrouter', kind: 'api_key', label: null },
          { provider: 'codex', kind: 'oauth', label: 'sub' },
        ])
      );
      // Second call: getDecryptedProviderCredential for openrouter → api_key row.
      mockQuery.mockResolvedValueOnce(createQueryResult([apiKeyRow()]));
      // Third call: getDecryptedProviderCredential for codex → oauth row (returns null).
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));

      const out = await listDecryptedUserProviderCredentials('user-1');
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({
        provider: 'openrouter',
        cred: { kind: 'api_key', apiKey: 'sk-or-test' },
      });
    });

    test('returns empty array (does not throw) when the list query fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('db down'));
      const out = await listDecryptedUserProviderCredentials('user-1');
      expect(out).toEqual([]);
    });

    test('returns partial results (does not throw) when a per-provider fetch fails', async () => {
      // List query: two providers.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { provider: 'openrouter', kind: 'api_key', label: null },
          { provider: 'claude', kind: 'api_key', label: null },
        ])
      );
      // openrouter individual fetch → transient DB failure.
      mockQuery.mockRejectedValueOnce(new Error('db transient'));
      // claude individual fetch → valid api_key row.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          apiKeyRow({
            provider: 'claude',
            api_key_encrypted: encryptToken('sk-claude-test', getEncryptionKey()),
          }),
        ])
      );
      const out = await listDecryptedUserProviderCredentials('user-1');
      expect(out).toHaveLength(1);
      expect(out[0]!.provider).toBe('claude');
      expect(out[0]!.cred).toEqual({ kind: 'api_key', apiKey: 'sk-claude-test' });
    });
  });
});

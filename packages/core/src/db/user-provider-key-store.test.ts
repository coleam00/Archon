import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

// Pi OAuth wrapper: mint a bearer from the stored blob (echoing the creds so the
// store sees "no rotation" by default). Provider singletons stubbed with `.id`.
const mockGetOAuthApiKey = mock(
  async (_providerId: string, creds: Record<string, unknown>) =>
    ({ newCredentials: Object.values(creds)[0] ?? {}, apiKey: 'minted-oauth-key' }) as {
      newCredentials: Record<string, unknown>;
      apiKey: string;
    } | null
);
mock.module('@archon/providers/oauth', () => ({
  getOAuthApiKey: mockGetOAuthApiKey,
  anthropicOAuthProvider: { id: 'anthropic' },
  openaiCodexOAuthProvider: { id: 'openaiCodex' },
  githubCopilotOAuthProvider: { id: 'github-copilot' },
}));

// The openai vendor refreshes through the Archon-owned flow (NOT Pi's
// getOAuthApiKey — it would drop id_token on rotation, #1924). Same contract.
const mockMintOpenAi = mock(
  async (creds: Record<string, unknown>) =>
    ({ newCredentials: creds, apiKey: 'openai-minted-key' }) as {
      newCredentials: Record<string, unknown>;
      apiKey: string;
    } | null
);
mock.module('../credentials/openai-oauth', () => ({
  mintOpenAiOAuthApiKey: mockMintOpenAi,
}));

import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';
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
    provider: 'claude',
    kind: 'oauth',
    api_key_encrypted: null,
    oauth_creds_encrypted: encryptToken(JSON.stringify({ access: 'oauth-bearer' }), key),
    label: 'Claude subscription',
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

    test('oauth row → mints a usable bearer via getOAuthApiKey', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
      const cred = await getDecryptedProviderCredential('user-1', 'claude');
      expect(cred).toEqual({
        kind: 'oauth',
        oauthApiKey: 'minted-oauth-key',
        rawCreds: { access: 'oauth-bearer' },
      });
      expect(mockGetOAuthApiKey).toHaveBeenCalled();
    });

    test('oauth row → null when getOAuthApiKey yields no key', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
      mockGetOAuthApiKey.mockResolvedValueOnce(null);
      expect(await getDecryptedProviderCredential('user-1', 'claude')).toBeNull();
    });

    test('oauth row → null on corrupt ciphertext (decrypt/parse fails), no refresh attempt', async () => {
      mockGetOAuthApiKey.mockClear();
      mockQuery.mockResolvedValueOnce(
        createQueryResult([oauthRow({ oauth_creds_encrypted: 'not-a-valid-ciphertext' })])
      );
      expect(await getDecryptedProviderCredential('user-1', 'claude')).toBeNull();
      expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
    });

    test('oauth row → null when oauth ciphertext is missing (corrupt row)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([oauthRow({ oauth_creds_encrypted: null })])
      );
      expect(await getDecryptedProviderCredential('user-1', 'claude')).toBeNull();
    });

    test('oauth rotation → re-saves the new blob', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()])); // record SELECT
      mockGetOAuthApiKey.mockResolvedValueOnce({
        newCredentials: { access: 'ROTATED', refresh: 'r2', expires: 999 },
        apiKey: 'minted-after-rotate',
      });
      const cred = await getDecryptedProviderCredential('user-1', 'claude');
      expect(cred).toMatchObject({ kind: 'oauth', oauthApiKey: 'minted-after-rotate' });
      // 1 SELECT (record) + 1 INSERT (resave of the rotated blob).
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const insertParams = mockQuery.mock.calls[1]?.[1] as unknown[];
      expect(insertParams[2]).toBe('oauth');
      expect(insertParams[4]).not.toContain('ROTATED'); // re-encrypted, not plaintext
    });

    test('coalesces concurrent oauth reads → a single refresh (inflight Map)', async () => {
      mockGetOAuthApiKey.mockClear();
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
      const [a, b] = await Promise.all([
        getDecryptedProviderCredential('user-1', 'claude'),
        getDecryptedProviderCredential('user-1', 'claude'),
      ]);
      expect(a).toEqual(b);
      expect(mockGetOAuthApiKey).toHaveBeenCalledTimes(1);
    });

    // ---- openai: Archon-owned refresh path (#1924) ----

    function openaiBlob(): Record<string, unknown> {
      return { access: 'oa', refresh: 'or', expires: 1, accountId: 'acct-1', id_token: 'idt-1' };
    }
    function openaiOauthRow(provider = 'openai'): UserProviderKeyRow {
      return oauthRow({
        provider,
        oauth_creds_encrypted: encryptToken(JSON.stringify(openaiBlob()), getEncryptionKey()),
        label: 'ChatGPT subscription',
      });
    }

    test('openai oauth row → routes through the Archon flow, NOT Pi getOAuthApiKey (#1924)', async () => {
      mockGetOAuthApiKey.mockClear();
      mockMintOpenAi.mockClear();
      mockQuery.mockResolvedValueOnce(createQueryResult([openaiOauthRow()]));
      const cred = await getDecryptedProviderCredential('user-1', 'openai');
      expect(cred).toEqual({
        kind: 'oauth',
        oauthApiKey: 'openai-minted-key',
        rawCreds: openaiBlob(),
      });
      expect(mockMintOpenAi).toHaveBeenCalledTimes(1);
      expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
    });

    test("legacy 'codex' rows normalize onto the openai path", async () => {
      mockGetOAuthApiKey.mockClear();
      mockMintOpenAi.mockClear();
      mockQuery.mockResolvedValueOnce(createQueryResult([openaiOauthRow('codex')]));
      const cred = await getDecryptedProviderCredential('user-1', 'codex');
      expect(cred).toMatchObject({ kind: 'oauth', oauthApiKey: 'openai-minted-key' });
      expect(mockMintOpenAi).toHaveBeenCalledTimes(1);
      expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
    });

    test('openai rotation → re-saves a blob that still carries the id_token', async () => {
      mockMintOpenAi.mockResolvedValueOnce({
        newCredentials: {
          access: 'ROTATED',
          refresh: 'or-2',
          expires: 999,
          accountId: 'acct-1',
          id_token: 'idt-rotated',
        },
        apiKey: 'ROTATED',
      });
      mockQuery.mockResolvedValueOnce(createQueryResult([openaiOauthRow()]));
      const cred = await getDecryptedProviderCredential('user-1', 'openai');
      expect(cred).toMatchObject({ kind: 'oauth', oauthApiKey: 'ROTATED' });
      // 1 SELECT (record) + 1 INSERT (resave). The re-encrypted blob must keep
      // id_token — the exact field a Pi-driven rotation would have dropped.
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const insertParams = mockQuery.mock.calls[1]?.[1] as unknown[];
      const resaved = JSON.parse(
        decryptToken(insertParams[4] as string, getEncryptionKey())
      ) as Record<string, unknown>;
      expect(resaved.id_token).toBe('idt-rotated');
      expect(resaved.access).toBe('ROTATED');
    });

    test('openai refresh failure → null (never throws into the inject path)', async () => {
      mockMintOpenAi.mockRejectedValueOnce(new Error('refresh failed (401)'));
      mockQuery.mockResolvedValueOnce(createQueryResult([openaiOauthRow()]));
      expect(await getDecryptedProviderCredential('user-1', 'openai')).toBeNull();
    });
  });

  describe('listDecryptedUserProviderCredentials', () => {
    test('decrypts api_key rows AND oauth rows (oauth minted via getOAuthApiKey)', async () => {
      // First call: list metadata (api_key + oauth).
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { provider: 'openrouter', kind: 'api_key', label: null },
          { provider: 'claude', kind: 'oauth', label: 'sub' },
        ])
      );
      // Second call: getDecryptedProviderCredential for openrouter → api_key row.
      mockQuery.mockResolvedValueOnce(createQueryResult([apiKeyRow()]));
      // Third call: getDecryptedProviderCredential for claude → oauth row (resolves now).
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));

      const out = await listDecryptedUserProviderCredentials('user-1');
      expect(out).toHaveLength(2);
      expect(out.find(o => o.provider === 'openrouter')?.cred).toEqual({
        kind: 'api_key',
        apiKey: 'sk-or-test',
      });
      expect(out.find(o => o.provider === 'claude')?.cred).toMatchObject({
        kind: 'oauth',
        oauthApiKey: 'minted-oauth-key',
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

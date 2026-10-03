import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import { createMockLogger } from '../test/mocks/logger';

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCredentialKeyPath: mock(() => '/mock/.archon/credential-key'),
}));

const mockQuery = createMockQuery();
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
class MockOpenAiTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}
mock.module('../credentials/openai-oauth', () => ({
  mintOpenAiOAuthApiKey: mockMintOpenAi,
  OpenAiTokenError: MockOpenAiTokenError,
}));

import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';
import {
  saveUserProviderKey,
  getUserProviderKeyRecord,
  listUserProviderKeys,
  deleteUserProviderKey,
  getDecryptedProviderCredential,
  getStoredCredentialStatus,
  listDecryptedUserProviderCredentials,
} from './user-provider-key-store';
import type { UserProviderKeyRow } from '../schemas/user-provider-key-row';
import { checkCredentialStatuses } from '@archon/provider-contract/conformance';

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

/** Fixed future expiry so exact-equality assertions on rawCreds stay stable. */
const OAUTH_BLOB_EXPIRES = 4102444800000; // 2100-01-01

function oauthRow(overrides: Partial<UserProviderKeyRow> = {}): UserProviderKeyRow {
  const key = getEncryptionKey();
  return {
    id: 'pk-2',
    user_id: 'user-1',
    provider: 'claude',
    kind: 'oauth',
    api_key_encrypted: null,
    // Well-formed blob: `expires` must be numeric — the store rejects rows
    // without it before calling the Pi mint path (oauth_malformed_expires).
    oauth_creds_encrypted: encryptToken(
      JSON.stringify({ access: 'oauth-bearer', expires: OAUTH_BLOB_EXPIRES }),
      key
    ),
    label: 'Claude subscription',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const UNREADABLE = {
  state: 'unusable',
  source: 'archon',
  evidence: 'The stored credential cannot be read. Reconnect it.',
} as const;

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
      expect(cred).toEqual({
        state: 'usable',
        source: 'archon',
        credential: { kind: 'api_key', apiKey: 'sk-or-test' },
      });
    });

    test('no row → not_connected', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([]));
      expect(await getDecryptedProviderCredential('user-x', 'openrouter')).toEqual({
        state: 'not_connected',
        source: 'archon',
      });
    });

    test('missing api_key ciphertext (corrupt row) → unusable', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([apiKeyRow({ api_key_encrypted: null })]));
      expect(await getDecryptedProviderCredential('user-1', 'openrouter')).toEqual(UNREADABLE);
    });

    test('ciphertext that fails to decrypt (wrong key / tampered) → unusable', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([apiKeyRow({ api_key_encrypted: 'not-a-valid-ciphertext' })])
      );
      expect(await getDecryptedProviderCredential('user-1', 'openrouter')).toEqual(UNREADABLE);
    });

    test('oauth row → mints a usable bearer via getOAuthApiKey', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
      const cred = await getDecryptedProviderCredential('user-1', 'claude');
      expect(cred).toEqual({
        state: 'usable',
        source: 'archon',
        credential: {
          kind: 'oauth',
          oauthApiKey: 'minted-oauth-key',
          rawCreds: { access: 'oauth-bearer', expires: OAUTH_BLOB_EXPIRES },
        },
      });
      expect(mockGetOAuthApiKey).toHaveBeenCalled();
    });

    test('oauth row → unusable on missing/non-numeric expires, no mint attempt', async () => {
      // The Pi mint path decides refresh purely by `Date.now() >= expires`
      // (Archon-owned since pi-ai 0.84 — toAuth never checks expiry). A blob
      // without a numeric `expires` would make that comparison silently
      // false and serve a stale token as success; the store must reject it
      // at the deserialization boundary instead (oauth_malformed_expires).
      mockGetOAuthApiKey.mockClear();
      const key = getEncryptionKey();
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          oauthRow({
            oauth_creds_encrypted: encryptToken(JSON.stringify({ access: 'oauth-bearer' }), key),
          }),
        ])
      );
      expect(await getDecryptedProviderCredential('user-1', 'claude')).toEqual(UNREADABLE);
      expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
    });

    test('oauth row → unusable when getOAuthApiKey yields no key', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
      mockGetOAuthApiKey.mockResolvedValueOnce(null);
      expect(await getDecryptedProviderCredential('user-1', 'claude')).toMatchObject({
        state: 'unusable',
        source: 'archon',
      });
    });

    test('Pi refresh throws → check_failed with fixed evidence (cause unknown)', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
      mockGetOAuthApiKey.mockRejectedValueOnce(new Error('Anthropic token refresh failed'));
      expect(await getDecryptedProviderCredential('user-1', 'claude')).toEqual({
        state: 'check_failed',
        source: 'archon',
        evidence: "The vendor's token refresh failed.",
      });
    });

    test('oauth row → unusable on corrupt ciphertext (decrypt/parse fails), no refresh attempt', async () => {
      mockGetOAuthApiKey.mockClear();
      mockQuery.mockResolvedValueOnce(
        createQueryResult([oauthRow({ oauth_creds_encrypted: 'not-a-valid-ciphertext' })])
      );
      expect(await getDecryptedProviderCredential('user-1', 'claude')).toEqual(UNREADABLE);
      expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
    });

    test('oauth row → unusable when oauth ciphertext is missing (corrupt row)', async () => {
      mockQuery.mockResolvedValueOnce(
        createQueryResult([oauthRow({ oauth_creds_encrypted: null })])
      );
      expect(await getDecryptedProviderCredential('user-1', 'claude')).toEqual(UNREADABLE);
    });

    test('oauth rotation → re-saves the new blob', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()])); // record SELECT
      mockGetOAuthApiKey.mockResolvedValueOnce({
        newCredentials: { access: 'ROTATED', refresh: 'r2', expires: 999 },
        apiKey: 'minted-after-rotate',
      });
      const cred = await getDecryptedProviderCredential('user-1', 'claude');
      expect(cred).toMatchObject({
        state: 'usable',
        credential: { kind: 'oauth', oauthApiKey: 'minted-after-rotate' },
      });
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
        state: 'usable',
        source: 'archon',
        credential: { kind: 'oauth', oauthApiKey: 'openai-minted-key', rawCreds: openaiBlob() },
      });
      expect(mockMintOpenAi).toHaveBeenCalledTimes(1);
      expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
    });

    test('openai oauth row → unusable on malformed expires, no mint attempt', async (): Promise<void> => {
      const malformedExpires = [
        { label: 'null payload', raw: 'null', type: 'undefined' },
        { label: 'missing', raw: '{"access":"oa"}', type: 'undefined' },
        { label: 'non-numeric', raw: '{"access":"oa","expires":"soon"}', type: 'string' },
        { label: 'non-finite', raw: '{"access":"oa","expires":1e400}', type: 'number' },
      ];

      for (const { label, raw, type } of malformedExpires) {
        mockMintOpenAi.mockClear();
        mockLogger.error.mockClear();
        mockQuery.mockResolvedValueOnce(
          createQueryResult([
            oauthRow({
              provider: 'openai',
              oauth_creds_encrypted: encryptToken(raw, getEncryptionKey()),
            }),
          ])
        );

        expect(await getDecryptedProviderCredential('user-1', 'openai'), label).toEqual(UNREADABLE);
        expect(mockMintOpenAi, label).not.toHaveBeenCalled();
        expect(mockLogger.error, label).toHaveBeenCalledWith(
          { userId: 'user-1', provider: 'openai', expiresType: type },
          'user_provider_key.oauth_malformed_expires'
        );
      }
    });

    test("legacy 'codex' rows normalize onto the openai path", async () => {
      mockGetOAuthApiKey.mockClear();
      mockMintOpenAi.mockClear();
      mockQuery.mockResolvedValueOnce(createQueryResult([openaiOauthRow('codex')]));
      const cred = await getDecryptedProviderCredential('user-1', 'codex');
      expect(cred).toMatchObject({
        state: 'usable',
        credential: { kind: 'oauth', oauthApiKey: 'openai-minted-key' },
      });
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
      expect(cred).toMatchObject({
        state: 'usable',
        credential: { kind: 'oauth', oauthApiKey: 'ROTATED' },
      });
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

    test.each<[string, Error, string]>([
      ['a rejected grant (400)', new MockOpenAiTokenError('refresh failed (400)', 400), 'unusable'],
      ['a revoked token (401)', new MockOpenAiTokenError('refresh failed (401)', 401), 'unusable'],
      ['an outage (503)', new MockOpenAiTokenError('refresh failed (503)', 503), 'check_failed'],
      [
        'rate limiting (429)',
        new MockOpenAiTokenError('refresh failed (429)', 429),
        'check_failed',
      ],
      [
        'a network failure',
        new MockOpenAiTokenError('request failed: fetch failed'),
        'check_failed',
      ],
    ])('openai refresh failure from %s is reported, never thrown', async (_label, error, state) => {
      mockMintOpenAi.mockRejectedValueOnce(error);
      mockQuery.mockResolvedValueOnce(createQueryResult([openaiOauthRow()]));
      expect(await getDecryptedProviderCredential('user-1', 'openai')).toEqual({
        state,
        source: 'archon',
        evidence: error.message,
      } as never);
    });
  });

  describe('getStoredCredentialStatus', () => {
    test('conforms: the status never carries the decrypted credential', async () => {
      const violations = await checkCredentialStatuses([
        {
          name: 'api key',
          expected: 'usable',
          secret: 'sk-or-test',
          check: async () => {
            mockQuery.mockResolvedValueOnce(createQueryResult([apiKeyRow()]));
            return getStoredCredentialStatus('user-1', 'openrouter');
          },
        },
        {
          name: 'oauth',
          expected: 'usable',
          secret: 'minted-oauth-key',
          check: async () => {
            mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
            return getStoredCredentialStatus('user-1', 'claude');
          },
        },
        {
          // Pi's refresh errors embed the vendor response body, which can carry tokens.
          name: 'refresh failure',
          expected: 'check_failed',
          secret: 'sk-ant-ort01-PLANTED',
          check: async () => {
            mockQuery.mockResolvedValueOnce(createQueryResult([oauthRow()]));
            mockGetOAuthApiKey.mockRejectedValueOnce(
              new Error(
                'HTTP request failed. status=400; body={"refresh_token":"sk-ant-ort01-PLANTED"}'
              )
            );
            return getStoredCredentialStatus('user-1', 'claude');
          },
        },
      ]);
      expect(violations).toEqual([]);
    });

    test('a failing credential reports the store status unchanged', async () => {
      mockQuery.mockResolvedValueOnce(createQueryResult([apiKeyRow({ api_key_encrypted: null })]));
      expect(await getStoredCredentialStatus('user-1', 'openrouter')).toEqual(UNREADABLE);
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

    test('logs ERROR (not WARN) when ALL per-provider fetches fail (mass_decrypt_failure)', async () => {
      mockLogger.error.mockClear();
      mockLogger.warn.mockClear();

      // List query: two providers.
      mockQuery.mockResolvedValueOnce(
        createQueryResult([
          { provider: 'openrouter', kind: 'api_key', label: null },
          { provider: 'anthropic', kind: 'api_key', label: null },
        ])
      );
      // Both individual fetches fail — simulates key-rotation/deletion.
      mockQuery.mockRejectedValueOnce(new Error('decrypt fail'));
      mockQuery.mockRejectedValueOnce(new Error('decrypt fail'));

      const out = await listDecryptedUserProviderCredentials('user-1');

      expect(out).toHaveLength(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', total: 2, resolved: 0 }),
        'user_provider_key.mass_decrypt_failure'
      );
      // Must NOT also emit a WARN for the same event.
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('partial_decrypt_failure')
      );
    });
  });
});

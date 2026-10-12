// @archon-test-isolated
import { afterEach, expect, mock, test } from 'bun:test';
import { createMockQuery, createQueryResult, mockPostgresDialect } from '../test/mocks/database';
import { createMockLogger } from '../test/mocks/logger';
import { encryptToken, decryptToken, getEncryptionKey } from '../utils/token-crypto';
import type { UserProviderKeyRow } from '../schemas/user-provider-key-row';

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
const paths = await import('@archon/paths');
const logger = createMockLogger();
mock.module('@archon/paths', () => ({ ...paths, createLogger: () => logger }));
const query = createMockQuery();
mock.module('./connection', () => ({ pool: { query }, getDialect: () => mockPostgresDialect }));
const { getDecryptedProviderCredential } = await import('./user-provider-key-store');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  query.mockReset();
});

for (const provider of ['anthropic', 'github-copilot']) {
  test(`${provider}: encrypted legacy blob refreshes through real core flow and saves the rotation`, async () => {
    const key = getEncryptionKey();
    const legacy = {
      access: 'legacy-access',
      refresh: 'legacy-refresh',
      expires: 1,
      extra: 'keep-me',
    };
    const row: UserProviderKeyRow = {
      id: 'row',
      user_id: 'u',
      provider,
      kind: 'oauth',
      api_key_encrypted: null,
      oauth_creds_encrypted: encryptToken(JSON.stringify(legacy), key),
      label: null,
      created_at: 'now',
      updated_at: 'now',
    };
    query.mockResolvedValueOnce(createQueryResult([row]));
    query.mockResolvedValueOnce(createQueryResult([]));
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        if (String(input).endsWith('/models')) return Response.json({ data: [] });
        return Response.json(
          provider === 'anthropic'
            ? { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 }
            : { token: 'rotated-access', expires_at: Math.floor(Date.now() / 1000) + 3600 }
        );
      },
      { preconnect: realFetch.preconnect }
    );
    const result = await getDecryptedProviderCredential('u', provider);
    expect(result).toMatchObject({
      state: 'usable',
      credential: { oauthApiKey: 'rotated-access', rawCreds: { extra: 'keep-me' } },
    });
    expect(query).toHaveBeenCalledTimes(2);
    const params = query.mock.calls[1]?.[1];
    const encrypted: unknown = Array.isArray(params) ? params[4] : undefined;
    expect(typeof encrypted).toBe('string');
    const saved: unknown = JSON.parse(decryptToken(String(encrypted), key));
    expect(saved).toMatchObject({
      access: 'rotated-access',
      refresh: provider === 'anthropic' ? 'rotated-refresh' : 'legacy-refresh',
      extra: 'keep-me',
    });
  });
}

test('a model catalog rejection leaves Copilot credential health unknown', async () => {
  const row: UserProviderKeyRow = {
    id: 'row',
    user_id: 'u',
    provider: 'github-copilot',
    kind: 'oauth',
    api_key_encrypted: null,
    oauth_creds_encrypted: encryptToken(
      JSON.stringify({ access: 'old', refresh: 'github', expires: 1 }),
      getEncryptionKey()
    ),
    label: null,
    created_at: 'now',
    updated_at: 'now',
  };
  query.mockResolvedValueOnce(createQueryResult([row]));
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith('/models')
        ? new Response('secret', { status: 401 })
        : Response.json({ token: 'current', expires_at: 2000000000 }),
    { preconnect: realFetch.preconnect }
  );
  expect(await getDecryptedProviderCredential('u', 'github-copilot')).toMatchObject({
    state: 'check_failed',
  });
});

test('invalid decrypted JSON never reaches logs as a parser error', async () => {
  const row: UserProviderKeyRow = {
    id: 'row',
    user_id: 'u',
    provider: 'anthropic',
    kind: 'oauth',
    api_key_encrypted: null,
    oauth_creds_encrypted: encryptToken('secret-credential-invalid-json', getEncryptionKey()),
    label: null,
    created_at: 'now',
    updated_at: 'now',
  };
  query.mockResolvedValueOnce(createQueryResult([row]));
  expect(await getDecryptedProviderCredential('u', 'anthropic')).toMatchObject({
    state: 'unusable',
  });
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-credential');
});

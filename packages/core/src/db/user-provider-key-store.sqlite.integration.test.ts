// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
}));

const subscriptionOAuth = await import('../credentials/subscription-oauth');
mock.module('../credentials/subscription-oauth', () => ({
  ...subscriptionOAuth,
  mintOAuthApiKey: async () => ({
    newCredentials: {
      access: 'ROTATED',
      refresh: 'r2',
      expires: 4102444800000,
    },
    apiKey: 'minted-after-rotate',
  }),
}));

const { persistProviderOAuth } = await import('../credentials/connect-service');
const { getDecryptedProviderCredential, getUserProviderKeyRecord, listUserProviderKeys } =
  await import('./user-provider-key-store');
const { decryptToken, getEncryptionKey } = await import('../utils/token-crypto');
afterAll(async () => await db.close());

test('a rotation save keeps the label the connect stored', async () => {
  await db.query("INSERT INTO remote_agent_users (id) VALUES ('user-1')", []);
  await persistProviderOAuth('user-1', 'anthropic', { access: 'a1', refresh: 'r1', expires: 0 });

  expect(await getDecryptedProviderCredential('user-1', 'anthropic')).toMatchObject({
    state: 'usable',
    credential: { oauthApiKey: 'minted-after-rotate' },
  });

  expect(await listUserProviderKeys('user-1')).toEqual([
    { provider: 'anthropic', kind: 'oauth', label: 'subscription' },
  ]);
  const row = await getUserProviderKeyRecord('user-1', 'anthropic');
  const stored = JSON.parse(decryptToken(row?.oauth_creds_encrypted ?? '', getEncryptionKey()));
  expect(stored).toMatchObject({ access: 'ROTATED', refresh: 'r2' });
});

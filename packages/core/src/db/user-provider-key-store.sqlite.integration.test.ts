// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

process.env.TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);

const db = new SqliteAdapter(':memory:');
const connection = await import('./connection');
mock.module('./connection', () => ({
  ...connection,
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
}));

const rotated = { access: 'ROTATED', refresh: 'r2', expires: 4102444800000 };
const mint = mock(async (_provider: unknown, creds: Record<string, unknown>) => ({
  newCredentials: creds.expires === 0 ? rotated : creds,
  apiKey: String(creds.expires === 0 ? 'minted-after-rotate' : creds.access),
}));

const subscriptionOAuth = await import('../credentials/subscription-oauth');
mock.module('../credentials/subscription-oauth', () => ({
  ...subscriptionOAuth,
  mintOAuthApiKey: mint,
}));

const { persistProviderOAuth } = await import('../credentials/connect-service');
const {
  getDecryptedProviderCredential,
  getStoredCredentialStatus,
  getUserProviderKeyRecord,
  listUserProviderKeys,
  saveUserProviderKey,
  deleteUserProviderKey,
} = await import('./user-provider-key-store');
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

for (const replacement of ['reconnect', 'identical reconnect', 'deletion', 'api key'] as const) {
  test(`an in-flight rotation preserves ${replacement}`, async () => {
    const userId = `user-${replacement}`;
    const original = { access: 'a1', refresh: 'r1', expires: 0 };
    const reconnect =
      replacement === 'identical reconnect'
        ? original
        : { access: 'b1', refresh: 'b-refresh', expires: 4102444800000 };
    await db.query('INSERT INTO remote_agent_users (id) VALUES ($1)', [userId]);
    await saveUserProviderKey({
      userId,
      provider: 'anthropic',
      kind: 'oauth',
      oauthCreds: original,
      label: 'original',
    });
    const before = await getUserProviderKeyRecord(userId, 'anthropic');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    mint.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { newCredentials: rotated, apiKey: 'minted-after-rotate' };
    });
    const pending = getStoredCredentialStatus(userId, 'anthropic');
    try {
      await entered.promise;
      if (replacement === 'deletion') {
        await deleteUserProviderKey(userId, 'anthropic');
      } else if (replacement === 'api key') {
        await saveUserProviderKey({
          userId,
          provider: 'anthropic',
          kind: 'api_key',
          apiKey: 'replacement-key',
          label: 'replacement',
        });
      } else {
        await saveUserProviderKey({
          userId,
          provider: 'anthropic',
          kind: 'oauth',
          oauthCreds: reconnect,
          label: 'replacement',
        });
      }
      const expected = await getUserProviderKeyRecord(userId, 'anthropic');
      if (replacement === 'identical reconnect') {
        expect(expected?.oauth_creds_encrypted).not.toBe(before?.oauth_creds_encrypted);
      }
      release.resolve();
      expect(await pending).toEqual({
        state: 'check_failed',
        source: 'archon',
        evidence: expect.any(String),
      });
      expect(await getUserProviderKeyRecord(userId, 'anthropic')).toEqual(expected);
      if (replacement === 'reconnect' || replacement === 'identical reconnect') {
        expect(
          JSON.parse(decryptToken(expected?.oauth_creds_encrypted ?? '', getEncryptionKey()))
        ).toEqual(reconnect);
      }
      expect(await getStoredCredentialStatus(userId, 'anthropic')).toEqual({
        state: replacement === 'deletion' ? 'not_connected' : 'usable',
        source: 'archon',
      });
      if (replacement === 'reconnect') {
        expect(await getDecryptedProviderCredential(userId, 'anthropic')).toMatchObject({
          state: 'usable',
          credential: { oauthApiKey: 'b1' },
        });
      }
    } finally {
      release.resolve();
      await pending;
    }
  });
}

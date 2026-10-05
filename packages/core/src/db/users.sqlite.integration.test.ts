import { afterAll, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
}));
const { findOrCreateUserByPlatformIdentity, getUserById } = await import('./users');
afterAll(async () => await db.close());

test('older writers retain admin and identity resolution preserves the stored role', async () => {
  await db.query("INSERT INTO remote_agent_users (id) VALUES ('legacy')", []);
  await db.query(
    "INSERT INTO remote_agent_user_identities (user_id, platform, platform_user_id) VALUES ('legacy', 'web', 'legacy-login')",
    []
  );
  expect((await getUserById('legacy'))?.role).toBe('admin');
  expect((await findOrCreateUserByPlatformIdentity('web', 'legacy-login', 'Legacy'))?.role).toBe(
    'admin'
  );
});

test('first-seen identities create members', async () => {
  const user = await findOrCreateUserByPlatformIdentity('slack', 'new-login', 'New');
  expect(user.role).toBe('member');
  expect((await getUserById(user.id))?.role).toBe('member');
});

test('role management persists changes and lists all identities including users without one', async () => {
  const { listUsersWithIdentities, setUserRole } = await import('./users');
  await db.query(
    "INSERT INTO remote_agent_users (id, updated_at) VALUES ('unlinked', '2000-01-01')",
    []
  );
  await setUserRole('unlinked', 'member');
  const promoted = await getUserById('unlinked');
  expect(promoted?.role).toBe('member');
  expect(new Date(promoted?.updated_at ?? '').getFullYear()).toBeGreaterThan(2000);
  await setUserRole('legacy', 'member');
  expect((await findOrCreateUserByPlatformIdentity('web', 'legacy-login')).role).toBe('member');
  await db.query(
    "INSERT INTO remote_agent_user_identities (user_id, platform, platform_user_id) VALUES ('legacy', 'github', 'legacy-gh')",
    []
  );
  const users = await listUsersWithIdentities();
  expect(
    users.find(user => user.id === 'legacy')?.identities.map(identity => identity.platform)
  ).toEqual(['github', 'web']);
  expect(users.find(user => user.id === 'unlinked')?.identities).toEqual([]);
  await expect(setUserRole('missing', 'admin')).rejects.toThrow('Unknown user id: missing');
});

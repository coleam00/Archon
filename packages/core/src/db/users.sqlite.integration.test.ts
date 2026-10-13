// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
}));
const {
  findOrCreateUserByPlatformIdentity,
  getUserById,
  linkPlatformIdentity,
  linkGithubIdentity,
  GithubIdentityConflictError,
} = await import('./users');
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

test('link, relink and move preserve users and their roles', async () => {
  const owner = await findOrCreateUserByPlatformIdentity('cli', 'owner');
  const previous = await findOrCreateUserByPlatformIdentity('matrix-chat', 'chat:123', 'Chat');
  await linkPlatformIdentity(owner.id, 'matrix-chat', 'new-id', 'New name');
  expect(await findOrCreateUserByPlatformIdentity('matrix-chat', 'new-id')).toEqual(owner);
  await linkPlatformIdentity(owner.id, 'matrix-chat', 'new-id');
  const unchanged = await db.query<{ platform_display_name: string }>(
    "SELECT platform_display_name FROM remote_agent_user_identities WHERE platform_user_id = 'new-id'",
    []
  );
  expect(unchanged.rows[0]?.platform_display_name).toBe('New name');
  await expect(linkPlatformIdentity(owner.id, 'matrix-chat', 'chat:123')).rejects.toThrow(
    `user ${previous.id}; linking it to user ${owner.id} requires moving it`
  );
  expect((await findOrCreateUserByPlatformIdentity('matrix-chat', 'chat:123')).id).toBe(
    previous.id
  );
  await linkPlatformIdentity(owner.id, 'matrix-chat', 'chat:123', undefined, true);
  expect((await findOrCreateUserByPlatformIdentity('matrix-chat', 'chat:123')).id).toBe(owner.id);
  expect(await getUserById(previous.id)).toEqual(previous);
  expect(await getUserById(owner.id)).toEqual(owner);
});

test('concurrent links select one owner and refuse the other', async () => {
  const first = await findOrCreateUserByPlatformIdentity('cli', 'first');
  const second = await findOrCreateUserByPlatformIdentity('cli', 'second');
  const results = await Promise.allSettled([
    linkPlatformIdentity(first.id, 'matrix', 'raced'),
    linkPlatformIdentity(second.id, 'matrix', 'raced'),
  ]);
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  const winner = await findOrCreateUserByPlatformIdentity('matrix', 'raced');
  expect([first.id, second.id]).toContain(winner.id);
  await Promise.all([
    linkPlatformIdentity(winner.id, 'matrix', 'raced'),
    linkPlatformIdentity(winner.id, 'matrix', 'raced'),
  ]);
});

test('GitHub connect links and relinks without moving a contested identity', async () => {
  const user = await findOrCreateUserByPlatformIdentity('cli', 'github-owner');
  const other = await findOrCreateUserByPlatformIdentity('cli', 'github-other');
  await linkGithubIdentity(user.id, 'alice');
  await linkGithubIdentity(user.id, 'alice');
  expect((await findOrCreateUserByPlatformIdentity('github', 'alice')).id).toBe(user.id);
  await expect(linkGithubIdentity(other.id, 'alice')).rejects.toBeInstanceOf(
    GithubIdentityConflictError
  );
  expect((await findOrCreateUserByPlatformIdentity('github', 'alice')).id).toBe(user.id);
});

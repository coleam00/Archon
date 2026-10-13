// @archon-test-isolated
import { expect, mock, test } from 'bun:test';
import { Pool } from 'pg';
import { PostgresAdapter, postgresDialect } from './adapters/postgres';

const baseUrl = process.env.ARCHON_TEST_PG_URL;

test.skipIf(!baseUrl)(
  'PostgreSQL identity links enforce ownership and preserve users on explicit moves',
  async () => {
    if (!baseUrl) throw new Error('ARCHON_TEST_PG_URL is required');
    const admin = new Pool({ connectionString: baseUrl });
    const scratchName = `archon_user_links_${crypto.randomUUID().replaceAll('-', '')}`;
    let db: PostgresAdapter | undefined;
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${scratchName}"`);
      created = true;
      const scratchUrl = new URL(baseUrl);
      scratchUrl.pathname = `/${scratchName}`;
      db = new PostgresAdapter(scratchUrl.toString());
      const adapter = db;
      mock.module('./connection', () => ({
        pool: adapter,
        getDatabase: () => adapter,
        getDialect: () => postgresDialect,
      }));
      const {
        findOrCreateUserByPlatformIdentity,
        getUserById,
        linkPlatformIdentity,
        linkGithubIdentity,
        GithubIdentityConflictError,
      } = await import('./users');
      const owner = await findOrCreateUserByPlatformIdentity('cli', 'owner');
      const previous = await findOrCreateUserByPlatformIdentity('matrix-chat', 'chat:123', 'Chat');
      const usersBefore = await db.query('SELECT * FROM remote_agent_users ORDER BY id');

      await linkPlatformIdentity(owner.id, 'matrix-chat', 'new-id', 'New name');
      expect(await findOrCreateUserByPlatformIdentity('matrix-chat', 'new-id')).toEqual(owner);
      await linkPlatformIdentity(owner.id, 'matrix-chat', 'new-id');
      const identity = await db.query<{ platform_display_name: string }>(
        'SELECT platform_display_name FROM remote_agent_user_identities WHERE platform = $1 AND platform_user_id = $2',
        ['matrix-chat', 'new-id']
      );
      expect(identity.rows[0]?.platform_display_name).toBe('New name');

      await expect(linkPlatformIdentity(owner.id, 'matrix-chat', 'chat:123')).rejects.toThrow(
        `user ${previous.id}; linking it to user ${owner.id} requires moving it`
      );
      expect(await findOrCreateUserByPlatformIdentity('matrix-chat', 'chat:123')).toEqual(previous);
      await linkPlatformIdentity(owner.id, 'matrix-chat', 'chat:123', undefined, true);
      expect(await findOrCreateUserByPlatformIdentity('matrix-chat', 'chat:123')).toEqual(owner);
      expect(await getUserById(previous.id)).toEqual(previous);
      expect(await getUserById(owner.id)).toEqual(owner);

      const competing = await Promise.allSettled([
        linkPlatformIdentity(owner.id, 'matrix', 'raced'),
        linkPlatformIdentity(previous.id, 'matrix', 'raced'),
      ]);
      expect(competing.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      const winner = await findOrCreateUserByPlatformIdentity('matrix', 'raced');
      expect([owner.id, previous.id]).toContain(winner.id);
      await Promise.all([
        linkPlatformIdentity(winner.id, 'matrix', 'raced'),
        linkPlatformIdentity(winner.id, 'matrix', 'raced'),
      ]);

      await linkGithubIdentity(owner.id, 'alice');
      await linkGithubIdentity(owner.id, 'alice');
      await expect(linkGithubIdentity(previous.id, 'alice')).rejects.toBeInstanceOf(
        GithubIdentityConflictError
      );
      expect(await findOrCreateUserByPlatformIdentity('github', 'alice')).toEqual(owner);
      expect((await db.query('SELECT * FROM remote_agent_users ORDER BY id')).rows).toEqual(
        usersBefore.rows
      );
    } finally {
      await db?.close();
      if (created) await admin.query(`DROP DATABASE "${scratchName}"`);
      await admin.end();
    }
  },
  30_000
);

import { toBranchName } from '@archon/git';
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { clearPlatformPolicies, registerPlatformPolicy } from '../platforms/registry';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { findStaleEnvironments, create } = await import('./isolation-environments');
await db.query(
  "INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ('cb', 'repo', '/tmp/repo')",
  []
);

beforeEach(async () => {
  clearPlatformPolicies();
  await db.query('DELETE FROM remote_agent_conversations', []);
  await db.query('DELETE FROM remote_agent_isolation_environments', []);
});
afterAll(async () => {
  clearPlatformPolicies();
  await db.close();
});

async function seed(platform: string | null, age: number) {
  const row = await create({
    codebase_id: 'cb',
    workflow_type: 'thread',
    workflow_id: platform ?? 'null',
    provider: 'worktree',
    working_path: '/tmp/repo',
    branch_name: toBranchName('task'),
    created_by_platform: platform ?? undefined,
  });
  await db.query(
    "UPDATE remote_agent_isolation_environments SET created_at = datetime('now', $1) WHERE id = $2",
    [`-${age} days`, row.id]
  );
  return row;
}

test('bound retention exclusions work alongside activity and creation thresholds', async () => {
  registerPlatformPolicy({ id: 'retain-test', workspaceRetention: 'retain' });
  registerPlatformPolicy({ id: 'matrix-chat', workspaceRetention: 'retain' });
  registerPlatformPolicy({ id: 'new-forge', workspaceRetention: 'age-based' });
  await seed('retain-test', 30);
  await seed('matrix-chat', 30);
  const stale = await seed('new-forge', 30);
  await seed(null, 30);
  await seed('young', 2);
  const active = await seed('active', 30);
  await db.query(
    "INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, isolation_env_id, last_activity_at) VALUES ('conv', 'active', 'conv', $1, datetime('now', '-2 days'))",
    [active.id]
  );
  expect((await findStaleEnvironments()).map(row => row.id)).toEqual([stale.id]);
  expect((await findStaleEnvironments(1)).map(row => row.created_by_platform).sort()).toEqual([
    'active',
    'new-forge',
    'young',
  ]);
});

test('empty registry has valid SQL and preserves NULL exclusion', async () => {
  const stale = await seed('retain-test', 30);
  await seed(null, 30);
  expect((await findStaleEnvironments()).map(row => row.id)).toEqual([stale.id]);
});

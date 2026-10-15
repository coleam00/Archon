// @archon-test-isolated
import { afterAll, expect, mock, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import type { IDatabase } from './adapters/types';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const root = await mkdtemp(join(tmpdir(), 'archon-codebase-delete-'));
const db = new SqliteAdapter(join(root, 'test.db'));
const registrar = new SqliteAdapter(join(root, 'test.db'));
await registrar.query('SELECT 1');
let afterContainerRead: (() => Promise<void>) | undefined;
const withTransaction: IDatabase['withTransaction'] = fn =>
  db.withTransaction(query =>
    fn(async <U>(sql: string, params?: unknown[]) => {
      const result = await query<U>(sql, params);
      if (sql.includes("provider = 'container'") && afterContainerRead) {
        const hook = afterContainerRead;
        afterContainerRead = undefined;
        await hook();
      }
      return result;
    })
  );
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => ({ withTransaction }),
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
afterAll(async () => {
  await registrar.close();
  await db.close();
  await removeTempTree(root);
});

test('deletion refuses a container registered after the caller snapshot and preserves references', async () => {
  const { createCodebase, deleteCodebase, getCodebase } = await import('./codebases');
  const project = await createCodebase({ name: 'delete-test', default_cwd: '/repos/delete-test' });
  await db.query(
    `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id, codebase_id)
     VALUES ('conversation', 'cli', 'delete-test', $1)`,
    [project.id]
  );
  await db.query(
    `INSERT INTO remote_agent_sessions (id, conversation_id, codebase_id, ai_assistant_type)
     VALUES ('session', 'conversation', $1, 'claude')`,
    [project.id]
  );
  expect(
    (
      await db.query('SELECT id FROM remote_agent_isolation_environments WHERE codebase_id = $1', [
        project.id,
      ])
    ).rows
  ).toHaveLength(0);
  await db.query(
    `INSERT INTO remote_agent_isolation_environments
     (id, codebase_id, workflow_id, workflow_type, provider, working_path, branch_name, status)
     VALUES ('container', $1, 'test', 'workflow', 'container', '/missing', '', 'active')`,
    [project.id]
  );
  await expect(deleteCodebase(project.id)).rejects.toThrow('container');
  expect(await getCodebase(project.id)).not.toBeNull();
  for (const table of ['remote_agent_sessions', 'remote_agent_conversations']) {
    expect(
      (await db.query<{ codebase_id: string }>(`SELECT codebase_id FROM ${table}`)).rows[0]
        ?.codebase_id
    ).toBe(project.id);
  }
  expect(
    (
      await db.query<{ status: string }>(
        "SELECT status FROM remote_agent_isolation_environments WHERE id = 'container'"
      )
    ).rows[0]?.status
  ).toBe('active');
  await db.query(
    "UPDATE remote_agent_isolation_environments SET status = 'destroyed' WHERE id = 'container'"
  );
  await deleteCodebase(project.id);
  expect(await getCodebase(project.id)).toBeNull();
});

test('a concurrent registration invalidates the SQLite snapshot and deletion retries the guard', async () => {
  const { createCodebase, deleteCodebase, getCodebase } = await import('./codebases');
  const project = await createCodebase({
    name: 'concurrent-delete',
    default_cwd: '/repos/concurrent-delete',
  });
  afterContainerRead = async () => {
    await registrar.query(
      `INSERT INTO remote_agent_isolation_environments
       (id, codebase_id, workflow_id, workflow_type, provider, working_path, branch_name, status)
       VALUES ('concurrent-container', $1, 'test', 'workflow', 'container', '/missing', '', 'active')`,
      [project.id]
    );
  };
  await expect(deleteCodebase(project.id)).rejects.toThrow('concurrent-container');
  expect(afterContainerRead).toBeUndefined();
  expect(await getCodebase(project.id)).not.toBeNull();
  expect(
    (
      await registrar.query<{ status: string }>(
        "SELECT status FROM remote_agent_isolation_environments WHERE id = 'concurrent-container'"
      )
    ).rows[0]?.status
  ).toBe('active');
});

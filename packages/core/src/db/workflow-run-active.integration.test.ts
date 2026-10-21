// @archon-test-isolated
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { getActiveWorkflowRun } = await import('./workflow-run-reads');
afterAll(() => db.close());

await db.query(
  `INSERT INTO remote_agent_codebases (id, name, default_cwd)
   VALUES ('project-a', 'a', '/a'), ('project-b', 'b', '/b'), ('project-empty', 'empty', '/empty')`,
  []
);
await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('chat', 'telegram', 'chat'), ('child', 'telegram', 'child'), ('other', 'telegram', 'other')`,
  []
);
await db.query(
  `INSERT INTO remote_agent_workflow_runs
   (id, workflow_name, conversation_id, parent_conversation_id, codebase_id, status, user_message, started_at)
   VALUES
   ('older-b', 'b', 'chat', NULL, 'project-b', 'running', 'test', '2026-10-21 10:00:00'),
   ('newer-a', 'a', 'chat', NULL, 'project-a', 'running', 'test', '2026-10-21 11:00:00'),
   ('child-b', 'b', 'child', 'chat', 'project-b', 'running', 'test', '2026-10-21 10:30:00'),
   ('other-b', 'b', 'other', NULL, 'project-b', 'running', 'test', '2026-10-21 12:00:00'),
   ('completed-b', 'b', 'chat', NULL, 'project-b', 'completed', 'test', '2026-10-21 13:00:00')`,
  []
);

describe('active conversation run selection', () => {
  test('selects within the project before limiting, including child runs', async () => {
    expect((await getActiveWorkflowRun('chat', 'project-b'))?.id).toBe('child-b');
    expect((await getActiveWorkflowRun('chat', 'project-a'))?.id).toBe('newer-a');
  });

  test('returns no run when the selected project has none', async () => {
    expect(await getActiveWorkflowRun('chat', 'project-empty')).toBeNull();
  });

  test('projectless selection keeps the newest running conversation run', async () => {
    expect((await getActiveWorkflowRun('chat'))?.id).toBe('newer-a');
  });
});

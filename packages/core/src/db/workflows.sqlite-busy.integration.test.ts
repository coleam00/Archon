/**
 * Integration test: a wait completion against a REAL on-disk SQLite database whose
 * write lock another connection holds for longer than the adapter's busy timeout.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with workflows.test.ts's fake.
 */
import { describe, test, expect, mock, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const trackTempRoot = trackTempRoots();
const dbPath = join(trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-sqlite-busy-'))), 'a.db');
const db = new SqliteAdapter(dbPath);
// The adapter's own 5 s busy_timeout would make this test slow, not different.
await db.query('PRAGMA busy_timeout = 20');
afterAll(() => db.close());

mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { clearWorkflowWaitContext } = await import('./workflows');

describe('clearWorkflowWaitContext — real SQLite under a held write lock', () => {
  test('waits for the lock and persists the completion once', async () => {
    const wait = {
      owner: 'node' as const,
      nodeId: 'await-checks',
      sessionId: null,
      sessionProvider: null,
      kind: 'event' as const,
      event: 'checks.complete',
      waitingSince: '2026-10-05T10:00:00.000Z',
      resumeAt: '2099-10-06T10:00:00.000Z',
    };
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ('conv-1', 'web', 'conv-1-platform')`
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, workflow_name, conversation_id, user_message, status, metadata)
       VALUES ('busy-run', 'wf', 'conv-1', 'msg', 'running', $1)`,
      [JSON.stringify({ wait })]
    );

    const holder = new Database(dbPath);
    holder.run('BEGIN IMMEDIATE');
    // Several 20 ms busy timeouts elapse before the holder lets go.
    const released = Bun.sleep(150).then(() => holder.run('COMMIT'));

    const result = await clearWorkflowWaitContext('busy-run', wait, {
      stepName: 'await-checks',
      result: { status: 'satisfied', waited_ms: 1, event: wait.event },
    });
    await released;
    holder.close();

    expect(result).toMatchObject({ cleared: true });
    const completed = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM remote_agent_workflow_events
       WHERE workflow_run_id = 'busy-run' AND event_type = 'node_completed'`
    );
    expect(Number(completed.rows[0]?.cnt)).toBe(1);
  });
});

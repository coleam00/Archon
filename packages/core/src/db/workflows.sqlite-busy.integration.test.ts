// @archon-test-isolated
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
import { removeTempTree } from '@archon/paths/test-utils';

// failWorkflowRun reports terminal telemetry; keep this test off the network.
process.env.ARCHON_TELEMETRY_DISABLED = '1';

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
// One database for the file: trackTempRoots would delete it after the first test.
const root = await mkdtemp(join(tmpdir(), 'archon-sqlite-busy-'));
const dbPath = join(root, 'a.db');
const db = new SqliteAdapter(dbPath);
// The adapter's own 5 s busy_timeout would make this test slow, not different.
await db.query('PRAGMA busy_timeout = 20');
afterAll(async () => {
  await db.close();
  await removeTempTree(root);
});

mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { clearWorkflowWaitContext, failWorkflowRun, getWorkflowRun } = await import('./workflows');

await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`
);

async function seedRunningRun(id: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status, metadata)
     VALUES ($1, 'wf', 'conv-1', 'msg', 'running', $2)`,
    [id, JSON.stringify(metadata)]
  );
}

/** Hold the write lock on a second connection; several 20 ms busy timeouts elapse before it lets go. */
function holdWriteLock(): Promise<void> {
  const holder = new Database(dbPath);
  holder.run('BEGIN IMMEDIATE');
  return Bun.sleep(150).then(() => {
    holder.run('COMMIT');
    holder.close();
  });
}

async function countEvents(runId: string, eventType: string): Promise<number> {
  const result = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1 AND event_type = $2`,
    [runId, eventType]
  );
  return Number(result.rows[0]?.cnt);
}

describe('run-state writes — real SQLite under a held write lock', () => {
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
    await seedRunningRun('busy-wait-run', { wait });
    const released = holdWriteLock();

    const result = await clearWorkflowWaitContext('busy-wait-run', wait, {
      stepName: 'await-checks',
      result: { status: 'satisfied', waited_ms: 1, event: wait.event },
    });
    await released;

    expect(result).toMatchObject({ cleared: true });
    expect(await countEvents('busy-wait-run', 'node_completed')).toBe(1);
  });

  test('a terminal failure write waits for the lock instead of leaving the run running', async () => {
    await seedRunningRun('busy-fail-run');
    const released = holdWriteLock();

    await failWorkflowRun('busy-fail-run', 'node write failed');
    await released;

    expect((await getWorkflowRun('busy-fail-run'))?.status).toBe('failed');
    expect(await countEvents('busy-fail-run', 'workflow_failed')).toBe(1);
  });
});

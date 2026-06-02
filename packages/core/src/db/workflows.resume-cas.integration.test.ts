/**
 * Integration test: resumeWorkflowRun against a REAL bun:sqlite database.
 *
 * The mock-based workflows.test.ts asserts SQL substrings but cannot catch a
 * mis-bound parameter or the dialect-specific date arithmetic — which is exactly
 * how the CAS `$2`-unbound bug (PR #1830 review C1) slipped through. This runs
 * the actual function against a real SqliteAdapter so the orphan-recovery arm and
 * the `datetime('now','-N days')` comparison are executed end-to-end.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with workflows.test.ts's fake.
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { resumeWorkflowRun } = await import('./workflows');

// workflow_runs.conversation_id is NOT NULL with an enforced FK — seed a parent.
await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);

/** Insert a run with an explicit status and a SQL expression for last_activity_at. */
async function seed(id: string, status: string, lastActivityExpr: string): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status, started_at, last_activity_at)
     VALUES ($1, 'wf', 'conv-1', 'msg', $2, datetime('now'), ${lastActivityExpr})`,
    [id, status]
  );
}

describe('resumeWorkflowRun — real SQLite (CAS + orphan recovery)', () => {
  test('resumes a stale running orphan — binds the day param + dialect date SQL (catches C1)', async () => {
    // With the day param unbound ($2 → NULL), `last_activity_at < NULL` is false
    // and this orphan would never match — the bug this test exists to prevent.
    await seed('orphan', 'running', "datetime('now', '-10 days')");
    const run = await resumeWorkflowRun('orphan');
    expect(run.status).toBe('running');
  });

  test('resumes a failed run', async () => {
    await seed('failed', 'failed', "datetime('now')");
    expect((await resumeWorkflowRun('failed')).status).toBe('running');
  });

  test('resumes a paused run', async () => {
    await seed('paused', 'paused', "datetime('now')");
    expect((await resumeWorkflowRun('paused')).status).toBe('running');
  });

  test('refuses a fresh running run (CAS miss — no double-claim)', async () => {
    await seed('fresh', 'running', "datetime('now')");
    await expect(resumeWorkflowRun('fresh')).rejects.toThrow(/not resumable.*status: running/);
  });

  test('refuses a completed run', async () => {
    await seed('done', 'completed', "datetime('now')");
    await expect(resumeWorkflowRun('done')).rejects.toThrow(/not resumable.*status: completed/);
  });

  test('throws not-found for a missing run', async () => {
    await expect(resumeWorkflowRun('ghost')).rejects.toThrow('Workflow run not found (id: ghost)');
  });
});

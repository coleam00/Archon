/**
 * Integration test: a `null` in a run-metadata patch clears the key on a REAL Postgres
 * server, the way SQLite's json_patch already does.
 *
 * The unit suite mocks the pg driver and the other real-database suites run SQLite, so
 * the Postgres merge operator only executes here. Plain `||` stores the null instead of
 * removing the key, which leaves `metadata.stop_reason: null` on a resumed run and
 * breaks the API contract that declares the key absent-or-object.
 *
 * Opt-in via ARCHON_TEST_PG_URL (postgres://user:pass@host:port/db). The test creates
 * and drops its own scratch database; the database named in the URL is only used to
 * reach the server.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { Pool as PgPool } from 'pg';

mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: false,
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
  // Named imports of ./workflows; unused by the paths under test.
  captureApprovalResolved: () => undefined,
  isTelemetryDisabled: () => true,
  captureWorkflowTerminal: () => undefined,
}));

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const SCRATCH_DB = 'archon_pg_metadata_merge_test';

describe.skipIf(!baseUrl)('run metadata merge — real Postgres behavior', () => {
  let admin: PgPool;
  let db: import('./adapters/postgres').PostgresAdapter;
  let workflows: typeof import('./workflows');
  let conversationId: string;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    admin = new Pool({ connectionString: baseUrl });
    // SCRATCH_DB is a compile-time constant, safe to inline as an identifier.
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    const scratchUrl = new URL(baseUrl!);
    scratchUrl.pathname = `/${SCRATCH_DB}`;

    const { PostgresAdapter, postgresDialect } = await import('./adapters/postgres');
    db = new PostgresAdapter(scratchUrl.toString());

    mock.module('./connection', () => ({
      pool: db,
      getDatabase: () => db,
      getDialect: () => postgresDialect,
      getDatabaseType: () => 'postgresql',
    }));

    workflows = await import('./workflows');
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id)
       VALUES ('test', 'metadata-merge') RETURNING id`
    );
    conversationId = rows[0].id;
  });

  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function seed(status: string, metadata: Record<string, unknown>): Promise<string> {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, workflow_name, user_message, status, metadata)
       VALUES ($1, $2, 'test', '', $3, $4::jsonb)`,
      [id, conversationId, status, JSON.stringify(metadata)]
    );
    return id;
  }

  async function storedMetadata(id: string): Promise<Record<string, unknown>> {
    const { rows } = await db.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM remote_agent_workflow_runs WHERE id = $1',
      [id]
    );
    return rows[0].metadata;
  }

  test('resuming an interrupted run removes its stop reason and error keys', async () => {
    const id = await seed('failed', {
      error: 'Process terminated (SIGINT)',
      stop_reason: { reason: 'process_terminated', signal: 'SIGINT' },
      unrelated: 'keep me',
    });

    expect((await workflows.resumeWorkflowRun(id)).status).toBe('running');

    const metadata = await storedMetadata(id);
    expect(Object.keys(metadata)).not.toContain('stop_reason');
    expect(Object.keys(metadata)).not.toContain('error');
    expect(Object.keys(metadata)).not.toContain('continuation_retry_at');
    expect(metadata.unrelated).toBe('keep me');
  });

  test('releasing a write-back claim removes the key and lets it be claimed again', async () => {
    const id = await seed('running', {});

    expect(await workflows.claimWriteback(id)).toEqual({ claimed: true });
    await workflows.releaseWritebackClaim(id);

    expect(Object.keys(await storedMetadata(id))).not.toContain('writeback_apply_claimed');
    expect(await workflows.claimWriteback(id)).toEqual({ claimed: true });
  });
  test('concurrent gate pauses keep one owner and an undelivered prompt cannot fail its successor', async () => {
    const id = await seed('running', { unrelated: 'keep' });
    const first = { nodeId: 'first', type: 'approval' as const, message: 'Review first' };
    const second = { ...first, nodeId: 'second', message: 'Review second' };
    const results = await Promise.allSettled([
      ...[first, second].map(context =>
        workflows.pauseWorkflowRun(id, context, undefined, {
          workflow_run_id: id,
          step_name: context.nodeId,
          event_type: 'node_suspended',
          data: { suspend_point: 'approval' },
        })
      ),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const [active, next] = results[0].status === 'fulfilled' ? [first, second] : [second, first];
    expect((await workflows.getWorkflowRun(id))!.metadata.approval).toEqual(active);
    const suspended = await db.query<{ step_name: string }>(
      "SELECT step_name FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'node_suspended'",
      [id]
    );
    expect(suspended.rows.map(row => row.step_name)).toEqual([active.nodeId]);
    expect((await storedMetadata(id)).unrelated).toBe('keep');
    expect(
      await workflows.resolveApprovalGate(id, { approval: { ...active, resolved: 'approved' } }, [])
    ).toEqual({ resolved: true });
    expect(await workflows.failPausedApproval(id, active, 'late failure')).toEqual({
      failed: false,
    });
    await workflows.resumeWorkflowRun(id);
    await workflows.pauseWorkflowRun(id, next);
    expect(await workflows.failPausedApproval(id, active, 'wrong owner')).toEqual({
      failed: false,
    });
    expect(await workflows.failPausedApproval(id, next, 'undelivered')).toEqual({ failed: true });
    expect((await workflows.getWorkflowRun(id))?.status).toBe('failed');
    expect(await storedMetadata(id)).toMatchObject({
      error: 'undelivered',
      unrelated: 'keep',
      stop_reason: { reason: 'node_error' },
    });
    const audit = await db.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'workflow_failed'",
      [id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].data).toMatchObject({ error: 'undelivered', exit_reason: 'node_error' });
  });
});

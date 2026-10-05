/**
 * Integration tests: workflow-run queries that behave differently on a REAL Postgres
 * server than on SQLite.
 *
 * The unit suite mocks the pg driver and the other real-database suites run SQLite, so
 * Postgres-only semantics execute only here:
 * - a `null` in a run-metadata patch must clear the key, as SQLite's json_patch does.
 *   Plain `||` stores the null, which leaves `metadata.stop_reason: null` on a resumed
 *   run and breaks the API contract that declares the key absent-or-object.
 * - run ids are a uuid column, so a short-id prefix lookup must compare them as text;
 *   Postgres has no LIKE operator for uuid.
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
const SCRATCH_DB = 'archon_pg_workflows_test';

describe.skipIf(!baseUrl)('workflow runs — real Postgres behavior', () => {
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

  test.each(['resolve', 'cancel'] as const)(
    '%s checks the expected occurrence atomically',
    async mode => {
      const approval = { nodeId: 'later', pauseId: 'current', message: 'Choose', type: 'approval' };
      const id = await seed('paused', { approval });
      const resolve = (expectedNodeId: string | { nodeId: string; pauseId: string }) =>
        mode === 'resolve'
          ? workflows.resolveApprovalGate(
              id,
              { approval: { ...approval, resolved: 'approved' } },
              [],
              expectedNodeId
            )
          : workflows.resolveAndCancelApprovalGate(id, [], { step_name: 'later' }, expectedNodeId);
      expect(await resolve('earlier')).toEqual({ resolved: false });
      expect((await workflows.getWorkflowRun(id))?.metadata.approval).toEqual(approval);
      expect((await workflows.getWorkflowRun(id))?.status).toBe('paused');
      expect(await resolve('later')).toEqual({ resolved: false });
      expect(await resolve({ nodeId: 'later', pauseId: 'old' })).toEqual({ resolved: false });
      expect(await resolve({ nodeId: 'later', pauseId: 'current' })).toEqual({ resolved: true });
      expect((await workflows.getWorkflowRun(id))?.status).toBe(
        mode === 'resolve' ? 'paused' : 'cancelled'
      );
    }
  );

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

  test('a run is found by the short id shown in listings', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_codebases (name, default_cwd) VALUES ('prefix', '/tmp') RETURNING id`
    );
    const id = await seed('paused', {});
    await db.query('UPDATE remote_agent_workflow_runs SET codebase_id = $1 WHERE id = $2', [
      rows[0].id,
      id,
    ]);

    const runs = await workflows.findWorkflowRunsByIdPrefix(id.slice(0, 8), rows[0].id);

    expect(runs.map(r => r.id)).toEqual([id]);
  });
});

/**
 * Integration test: finding a run by the short id shown in listings works on a REAL
 * Postgres server.
 *
 * Run ids are `uuid` columns on Postgres, which has no `uuid LIKE text` operator, so a bare
 * `id LIKE $1` fails with "operator does not exist: uuid ~~ unknown" and `/workflow approve
 * <id>` can never resolve a run. SQLite stores ids as text, so the unit suite and the SQLite
 * suites cannot see it.
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
const SCRATCH_DB = 'archon_pg_run_id_prefix_test';

describe.skipIf(!baseUrl)('run lookup by id prefix — real Postgres behavior', () => {
  let admin: PgPool;
  let db: import('./adapters/postgres').PostgresAdapter;
  let workflows: typeof import('./workflows');
  let conversationId: string;
  let codebaseId: string;
  let otherCodebaseId: string;

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

    const conversation = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id)
       VALUES ('test', 'id-prefix') RETURNING id`
    );
    conversationId = conversation.rows[0].id;
    const codebases = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_codebases (name, default_cwd)
       VALUES ('test/one', '/tmp/one'), ('test/two', '/tmp/two') RETURNING id`
    );
    codebaseId = codebases.rows[0].id;
    otherCodebaseId = codebases.rows[1].id;
  });

  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function seed(id: string, forCodebase: string): Promise<void> {
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, conversation_id, codebase_id, workflow_name, user_message, status)
       VALUES ($1, $2, $3, 'test', '', 'paused')`,
      [id, conversationId, forCodebase]
    );
  }

  test('the 8-character short id from a listing finds its run', async () => {
    const id = '11111111-aaaa-4aaa-8aaa-000000000001';
    await seed(id, codebaseId);

    const found = await workflows.findWorkflowRunsByIdPrefix('11111111', codebaseId);

    expect(found.map(run => run.id)).toEqual([id]);
  });

  test('a full id also resolves', async () => {
    const id = '22222222-aaaa-4aaa-8aaa-000000000001';
    await seed(id, codebaseId);

    const found = await workflows.findWorkflowRunsByIdPrefix(id, codebaseId);

    expect(found.map(run => run.id)).toEqual([id]);
  });

  test('a prefix never crosses projects', async () => {
    await seed('33333333-aaaa-4aaa-8aaa-000000000001', codebaseId);

    expect(await workflows.findWorkflowRunsByIdPrefix('33333333', otherCodebaseId)).toEqual([]);
  });

  test('an ambiguous prefix returns two matches so the caller can refuse it', async () => {
    await seed('44444444-aaaa-4aaa-8aaa-000000000001', codebaseId);
    await seed('44444444-aaaa-4aaa-8aaa-000000000002', codebaseId);

    expect(await workflows.findWorkflowRunsByIdPrefix('44444444', codebaseId)).toHaveLength(2);
  });
});

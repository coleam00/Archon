/**
 * Integration test: resource-slot holder release against a REAL Postgres server.
 *
 * Holder IDs are text and run IDs are UUID on Postgres, so the release join is shaped
 * per dialect. Only a real server proves the Postgres branch runs and that the
 * continuation scheduler's every-tick release uses the runs primary key.
 *
 * Opt-in via ARCHON_TEST_PG_URL (postgres://user:pass@host:port/db). The test creates
 * and drops its own scratch database; the database named in the URL is only used to
 * reach the server.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import type { Pool as PgPool } from 'pg';

// The barrel is fully replaced (no partial merge), so re-export the constants the
// real module graph needs.
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
}));

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const SCRATCH_DB = 'archon_pg_resource_slots_test';

describe.skipIf(!baseUrl)('resource slot holders — real Postgres behavior', () => {
  let admin: PgPool;
  let db: import('./adapters/postgres').PostgresAdapter;
  let slots: typeof import('./resource-slots');

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

    slots = await import('./resource-slots');
  });

  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  test('release follows the run state and looks the run up by its primary key', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id)
       VALUES ('test', 'slots') RETURNING id`
    );
    const conversationId = rows[0].id;
    const live = crypto.randomUUID();
    const ended = crypto.randomUUID();
    const vanished = crypto.randomUUID();
    for (const [id, status] of [
      [live, 'running'],
      [ended, 'completed'],
    ] as const) {
      await db.query(
        `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, user_message, status)
         VALUES ($1, $2, 'test', '', $3)`,
        [id, conversationId, status]
      );
    }

    const { holders, plan } = await db.withTransaction(async query => {
      await slots.lockResourceSlot(query, 'slot');
      for (const id of [live, ended, vanished]) {
        await slots.addResourceSlotHolder(query, 'slot', { kind: 'run', id });
      }
      const statements: { sql: string; params?: unknown[] }[] = [];
      const recording: typeof query = (sql, params) => {
        statements.push({ sql, params });
        return query(sql, params);
      };
      const remaining = await slots.liveResourceSlotHolders(recording, 'slot');
      const release = statements.find(statement => statement.sql.includes('DELETE'));
      if (!release) throw new Error('no release statement');
      // A tiny table is cheapest to scan; disabling that choice leaves the planner a
      // scan only when the predicate cannot use the index at all.
      await query('SET LOCAL enable_seqscan = off');
      const explained = await query<{ 'QUERY PLAN': string }>(
        `EXPLAIN ${release.sql}`,
        release.params
      );
      return { holders: remaining, plan: explained.rows.map(row => row['QUERY PLAN']).join('\n') };
    });

    expect(holders).toEqual([{ kind: 'run', id: live }]);
    expect(plan).toContain('remote_agent_workflow_runs_pkey');
    expect(plan).not.toMatch(/Seq Scan on remote_agent_workflow_runs/);
  });
});

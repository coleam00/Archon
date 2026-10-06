// @archon-test-isolated
/**
 * Integration test: the provider-event reader against a REAL Postgres server, where
 * `data` is jsonb. Same contract as the SQLite suite
 * (`workflow-events.provider-events.integration.test.ts`).
 *
 * Opt-in via ARCHON_TEST_PG_URL (postgres://user:pass@host:port/db). The test creates
 * and drops its own scratch database; the database named in the URL is only used to
 * reach the server.
 */
import { describe, beforeAll, afterAll, mock } from 'bun:test';
import type { Pool as PgPool } from 'pg';
import { providerEventReaderContract } from './provider-events.reader-contract';

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
const SCRATCH_DB = 'archon_pg_provider_events_test';

describe.skipIf(!baseUrl)('listProviderEvents — real Postgres', () => {
  let admin: PgPool;
  let db: import('./adapters/postgres').PostgresAdapter;
  let workflowEvents: typeof import('./workflow-events');

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

    workflowEvents = await import('./workflow-events');
  });

  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  providerEventReaderContract(
    () => db,
    () => workflowEvents
  );
});

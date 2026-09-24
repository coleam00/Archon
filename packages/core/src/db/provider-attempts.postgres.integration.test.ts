/**
 * Integration test: provider-attempt holders against a REAL Postgres server.
 *
 * Proves the slot lock serializes concurrent admissions on separate pool connections,
 * the owner-process liveness rule, and that a database created with the run-only
 * holder CHECK converges to accept attempt holders.
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
}));

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const SCRATCH_DB = 'archon_pg_provider_attempts_test';

describe.skipIf(!baseUrl)('provider-attempt holders — real Postgres behavior', () => {
  let admin: PgPool;
  let db: import('./adapters/postgres').PostgresAdapter;
  let attempts: typeof import('./provider-attempts');
  let owner: typeof import('./process-owner');

  beforeAll(async () => {
    const { Pool } = await import('pg');
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    const scratchUrl = new URL(baseUrl!);
    scratchUrl.pathname = `/${SCRATCH_DB}`;

    // Shape an unreleased dev database: slot tables with the run-only holder CHECK
    // and one run holder, before the current schema is applied.
    const seed = new Pool({ connectionString: scratchUrl.toString() });
    await seed.query(`CREATE TABLE remote_agent_resource_slots (
      resource_key TEXT PRIMARY KEY,
      capacity INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW())`);
    await seed.query(`CREATE TABLE remote_agent_resource_slot_holders (
      resource_key TEXT NOT NULL REFERENCES remote_agent_resource_slots(resource_key),
      holder_kind VARCHAR(10) NOT NULL CHECK (holder_kind IN ('run')),
      holder_id TEXT NOT NULL,
      acquired_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (resource_key, holder_kind, holder_id))`);
    await seed.query("INSERT INTO remote_agent_resource_slots (resource_key) VALUES ('shared')");
    await seed.query(
      "INSERT INTO remote_agent_resource_slot_holders (resource_key, holder_kind, holder_id) VALUES ('shared', 'run', 'r1')"
    );
    await seed.end();

    const { PostgresAdapter, postgresDialect } = await import('./adapters/postgres');
    db = new PostgresAdapter(scratchUrl.toString());

    mock.module('./connection', () => ({
      pool: db,
      getDatabase: () => db,
      getDialect: () => postgresDialect,
      getDatabaseType: () => 'postgresql',
    }));

    attempts = await import('./provider-attempts');
    owner = await import('./process-owner');
  });

  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  test('a run-only holder CHECK converges and keeps existing run holders', async () => {
    const constraint = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'remote_agent_resource_slot_holders_holder_kind_check'`
    );
    expect(constraint.rows).toHaveLength(1);
    expect(constraint.rows[0].def).toContain("'attempt'");
    const runs = await db.query<{ holder_id: string }>(
      "SELECT holder_id FROM remote_agent_resource_slot_holders WHERE holder_kind = 'run'"
    );
    expect(runs.rows).toEqual([{ holder_id: 'r1' }]);
  });

  test('concurrent admissions on separate connections never exceed the cap', async () => {
    for (const capacity of [1, 3]) {
      const provider = `pg-contention-${String(capacity)}`;
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          attempts.tryAdmitProviderAttempt({
            provider,
            capacity,
            attemptId: crypto.randomUUID(),
          })
        )
      );
      expect(results.filter(r => r.admitted)).toHaveLength(capacity);
    }
  });

  test('owner liveness: gone same-host owners release, other hosts stay held', async () => {
    const provider = 'pg-liveness';
    const child = Bun.spawn(['bun', '-e', '0']);
    await child.exited;
    for (const holderOwner of [
      { ...owner.currentProcessOwner, pid: child.pid },
      { ...owner.currentProcessOwner, instance: crypto.randomUUID() },
      { host: 'another-host', pid: 1, instance: 'x' },
    ]) {
      await attempts.tryAdmitProviderAttempt({
        provider,
        capacity: 99,
        attemptId: crypto.randomUUID(),
        owner: holderOwner,
      });
    }
    const next = await attempts.tryAdmitProviderAttempt({
      provider,
      capacity: 2,
      attemptId: crypto.randomUUID(),
    });
    expect(next).toEqual({ admitted: true, live: 2 });
    const held = (await attempts.listProviderAttemptHolders()).filter(h => h.provider === provider);
    expect(held.map(h => h.owner.host).sort()).toEqual(
      ['another-host', owner.currentProcessOwner.host].sort()
    );
  });
});

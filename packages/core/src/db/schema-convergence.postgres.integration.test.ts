import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { PostgresAdapter } from './adapters/postgres';
import { APP_VERSION } from './schema-version';

const baseUrl = process.env.ARCHON_TEST_PG_URL;

describe.skipIf(!baseUrl)('PostgreSQL schema convergence and conflict retry', () => {
  const scratchName = `archon_schema_convergence_${crypto.randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let scratch: Pool;
  let scratchUrl: string;
  let created = false;

  /** Boots an adapter and closes it once its first query has awaited schema init. */
  async function boot(): Promise<void> {
    const adapter = new PostgresAdapter(scratchUrl);
    try {
      await adapter.query('SELECT 1');
    } finally {
      await adapter.close();
    }
  }

  // DROP/CREATE TRIGGER gives the trigger a new oid, so an unchanged oid proves the
  // boot ran no convergence DDL.
  async function notifyTriggerOid(): Promise<number> {
    const result = await scratch.query<{ oid: number }>(
      "SELECT oid FROM pg_trigger WHERE tgname = 'archon_workflow_event_notify'"
    );
    return result.rows[0].oid;
  }

  beforeAll(async () => {
    if (!baseUrl) throw new Error('ARCHON_TEST_PG_URL is required');
    admin = new Pool({ connectionString: baseUrl });
    await admin.query(`CREATE DATABASE "${scratchName}"`);
    created = true;
    const url = new URL(baseUrl);
    url.pathname = `/${scratchName}`;
    scratchUrl = url.toString();
    scratch = new Pool({ connectionString: scratchUrl });
    await boot();
  });

  afterAll(async () => {
    await scratch?.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin?.end();
  });

  test('a second boot of the same build runs no DDL', async () => {
    const before = await notifyTriggerOid();
    await boot();
    expect(await notifyTriggerOid()).toBe(before);
  });

  test.each([
    [
      'an older build converged since',
      "UPDATE remote_agent_schema_version SET app_version = 'older-build'",
    ],
    [
      'a legacy provider id is waiting for its rename',
      `WITH u AS (INSERT INTO remote_agent_users DEFAULT VALUES RETURNING id)
       INSERT INTO remote_agent_user_provider_keys (user_id, provider, kind)
       SELECT id, 'claude', 'api_key' FROM u`,
    ],
    [
      'the event-sequence head is behind',
      'UPDATE remote_agent_workflow_event_sequence SET value = -1',
    ],
  ])('a boot converges again when %s', async (_reason, invalidate) => {
    await scratch.query(invalidate);
    const before = await notifyTriggerOid();
    await boot();
    expect(await notifyTriggerOid()).not.toBe(before);
    const state = await scratch.query<{ app_version: string; legacy: number; behind: number }>(
      `SELECT
         (SELECT app_version FROM remote_agent_schema_version WHERE id = 1) AS app_version,
         (SELECT count(*)::int FROM remote_agent_user_provider_keys WHERE provider = 'claude') AS legacy,
         (SELECT count(*)::int FROM remote_agent_workflow_event_sequence WHERE value < 0) AS behind`
    );
    expect(state.rows[0]).toEqual({ app_version: APP_VERSION, legacy: 0, behind: 0 });
  });

  test('the victim of a real deadlock reruns its transaction and both commit', async () => {
    const db = new PostgresAdapter(scratchUrl);
    try {
      await db.query('CREATE TABLE deadlock_probe (id INT PRIMARY KEY, n INT NOT NULL)');
      await db.query('INSERT INTO deadlock_probe VALUES (1, 0), (2, 0)');
      let firstLocks = 0;
      let release: () => void = () => {};
      const bothHoldOneRow = new Promise<void>(resolve => {
        release = resolve;
      });
      let runs = 0;
      // Each transaction locks one row, waits until the other holds the second, then
      // reaches for it: a lock cycle Postgres breaks by failing one with 40P01.
      const crossing = (first: number, second: number): Promise<void> =>
        db.withTransaction(async q => {
          runs++;
          await q('UPDATE deadlock_probe SET n = n + 1 WHERE id = $1', [first]);
          if (++firstLocks === 2) release();
          await bothHoldOneRow;
          await q('UPDATE deadlock_probe SET n = n + 1 WHERE id = $1', [second]);
        });

      await Promise.all([crossing(1, 2), crossing(2, 1)]);

      expect(runs).toBe(3);
      const rows = await db.query<{ n: number }>('SELECT n FROM deadlock_probe ORDER BY id');
      expect(rows.rows).toEqual([{ n: 2 }, { n: 2 }]);
    } finally {
      await db.close();
    }
  });
});

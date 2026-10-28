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

  test('waiting boots take no relation locks and converge only once', async () => {
    await scratch.query('UPDATE remote_agent_workflow_event_sequence SET value = -1');
    await scratch.query('CREATE TABLE boot_write_probe (n INT NOT NULL)');
    const reader = await scratch.connect();
    const adapters: PostgresAdapter[] = [];
    const writes: Promise<number>[] = [];
    const before = await notifyTriggerOid();
    try {
      await reader.query('BEGIN');
      await reader.query('SELECT pg_advisory_xact_lock(1796)');
      await reader.query('LOCK TABLE remote_agent_schema_version IN ACCESS SHARE MODE');
      for (let i = 0; i < 8; i++) {
        const db = new PostgresAdapter(scratchUrl);
        adapters.push(db);
        const write = (async () => {
          await db.query('INSERT INTO boot_write_probe VALUES (1)');
          const result = await db.query<{ oid: number }>(
            "SELECT oid FROM pg_trigger WHERE tgname = 'archon_workflow_event_notify'"
          );
          return result.rows[0].oid;
        })();
        void write.catch(() => {});
        writes.push(write);
      }
      let waiting = 0;
      for (let i = 0; i < 200; i++) {
        const locks = await scratch.query<{ waiting: number; relations: number }>(
          `WITH waiters AS (
             SELECT pid FROM pg_locks
             WHERE locktype = 'advisory' AND objid = 1796 AND NOT granted
           ) SELECT (SELECT count(*)::int FROM waiters) AS waiting,
             (SELECT count(*)::int FROM pg_locks
              WHERE pid IN (SELECT pid FROM waiters) AND relation IS NOT NULL) AS relations`
        );
        waiting = locks.rows[0].waiting;
        expect(locks.rows[0].relations).toBe(0);
        if (waiting === 8) break;
        await Bun.sleep(10);
      }
      expect(waiting).toBe(8);
      // This was the second edge of the version/events deadlock. Waiting boots
      // now hold no events lock, so the read completes before we release version.
      await reader.query('SELECT 1 FROM remote_agent_workflow_events');
      await reader.query('COMMIT');
      const oids = await Promise.all(writes);
      expect(new Set(oids).size).toBe(1);
      expect(oids[0]).not.toBe(before);
      const count = await scratch.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM boot_write_probe'
      );
      expect(count.rows[0].n).toBe(8);
      const repaired = await scratch.query<{ value: string }>(
        'SELECT value FROM remote_agent_workflow_event_sequence WHERE id = 1'
      );
      expect(repaired.rows[0].value).toBe('0');
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
      await Promise.allSettled(writes);
      await Promise.all(adapters.map(db => db.close()));
    }
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

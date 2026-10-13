/**
 * Integration test: on PostgreSQL, `event_order` follows commit order, so a reader
 * that has seen order N never later finds a newly committed row below N.
 *
 * A sequence value is taken at insert time, not at commit time. Without the
 * `archon_assign_workflow_event_order` trigger in migrations/000_combined.sql, a
 * transaction that inserts first and commits last lands below a cursor that a
 * reader already passed.
 *
 * Opt-in via ARCHON_TEST_PG_URL (postgres://user:pass@host:port/db). The test creates
 * and drops its own scratch database; the database named in the URL is only used to
 * reach the server.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { getSchemaSQL } from './bundled-schema';

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const SCRATCH_DB = 'archon_pg_event_commit_order_test';

/** Long enough for an unblocked insert to commit; a blocked one stays waiting. */
const SETTLE_MS = 300;

/** The insert the app issues (workflow-events.ts): it never names event_order. */
const INSERT_EVENT = `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, data)
  VALUES ($1, $2, '{}') RETURNING event_order`;

describe.skipIf(!baseUrl)('workflow event order — real Postgres', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl });
    // SCRATCH_DB is a compile-time constant, safe to inline as an identifier.
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    const scratchUrl = new URL(baseUrl!);
    scratchUrl.pathname = `/${SCRATCH_DB}`;
    pool = new Pool({ connectionString: scratchUrl.toString(), max: 4 });
    await pool.query(getSchemaSQL());
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  async function createRun(label: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `WITH conversation AS (
         INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id)
         VALUES ('cli', $1) RETURNING id
       )
       INSERT INTO remote_agent_workflow_runs (workflow_name, conversation_id, user_message)
       SELECT 'commit-order', id, 'test' FROM conversation RETURNING id`,
      [label]
    );
    return result.rows[0].id;
  }

  async function insertEvent(
    client: PoolClient,
    runId: string,
    eventType: string
  ): Promise<number> {
    const result = await client.query<{ event_order: string }>(INSERT_EVENT, [runId, eventType]);
    return Number(result.rows[0].event_order);
  }

  /** Run `fn` on its own connection with a statement timeout, so a lost wake fails fast. */
  async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = '2s'");
      return await fn(client);
    } finally {
      client.release();
    }
  }

  test('the later committer gets the higher event_order', async () => {
    const runId = await createRun('two-transactions');
    const commits: { name: string; order: number }[] = [];

    await withClient(async a => {
      await a.query('BEGIN');
      const aOrder = await insertEvent(a, runId, 'node_started');

      const b = withClient(async client => {
        const order = await insertEvent(client, runId, 'node_completed');
        commits.push({ name: 'B', order });
      });
      await Bun.sleep(SETTLE_MS);

      await a.query('COMMIT');
      commits.push({ name: 'A', order: aOrder });
      await b;
    });

    // B inserted while A was open. B must wait for A's commit, so A commits first
    // and holds the lower order. Without the trigger B commits first with order
    // aOrder + 1, and a reader that saw B would skip A.
    expect(commits.map(c => c.name)).toEqual(['A', 'B']);
    expect(commits[0].order).toBeLessThan(commits[1].order);
  });

  test('an event insert does not deadlock with a transaction holding the run row', async () => {
    // The shape of updateToolCallAttention and persistWorkflowEventIfRunning: lock
    // the run row FOR UPDATE, then insert an event for that run. A concurrent
    // autocommit insert for the same run needs FOR KEY SHARE on the run row for
    // its foreign key. If that insert took the order lock before its row lock,
    // each would wait on the other.
    const runId = await createRun('row-lock-then-insert');
    const commits: string[] = [];

    await withClient(async holder => {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM remote_agent_workflow_runs WHERE id = $1 FOR UPDATE', [
        runId,
      ]);

      const writer = withClient(async client => {
        await insertEvent(client, runId, 'provider_event');
        commits.push('writer');
      });
      await Bun.sleep(SETTLE_MS);

      await insertEvent(holder, runId, 'run_attention_changed');
      await holder.query('COMMIT');
      commits.push('holder');
      await writer;
    });

    expect(commits).toEqual(['holder', 'writer']);
    const rows = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM remote_agent_workflow_events WHERE workflow_run_id = $1 ORDER BY event_order',
      [runId]
    );
    expect(rows.rows.map(r => r.event_type)).toEqual(['run_attention_changed', 'provider_event']);
  });
});

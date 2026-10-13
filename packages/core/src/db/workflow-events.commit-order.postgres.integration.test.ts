/**
 * Integration test: on PostgreSQL, `event_order` follows commit order, so a reader
 * that has seen order N never later finds a newly committed row below N.
 *
 * The column default draws nextval() at insert time. Without the deferred
 * `archon_workflow_event_order` trigger in migrations/000_combined.sql, a
 * transaction that inserts first and commits last lands below an order that a
 * reader has already passed.
 *
 * Every wait is observed in pg_locks rather than slept for, so a case cannot pass
 * without exercising the lock it is about.
 *
 * Opt-in via ARCHON_TEST_PG_URL (postgres://user:pass@host:port/db). The test creates
 * and drops its own scratch database; the database named in the URL is only used to
 * reach the server.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { getSchemaSQL } from './bundled-schema';

const baseUrl = process.env.ARCHON_TEST_PG_URL;
const SCRATCH_DB = 'archon_pg_event_commit_order_test';

/** The insert the app issues (workflow-events.ts): it never names event_order. */
const INSERT_EVENT = `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, data)
  VALUES ($1, $2, '{}') RETURNING id`;

interface Session {
  client: PoolClient;
  pid: number;
}

describe.skipIf(!baseUrl)('workflow event order — real Postgres', () => {
  let admin: Pool;
  let pool: Pool;
  const sessions: Session[] = [];

  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl });
    // SCRATCH_DB is a compile-time constant, safe to inline as an identifier.
    await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${SCRATCH_DB}"`);
    const scratchUrl = new URL(baseUrl!);
    scratchUrl.pathname = `/${SCRATCH_DB}`;
    pool = new Pool({ connectionString: scratchUrl.toString(), max: 6 });
    await pool.query(getSchemaSQL());
  });

  afterEach(async () => {
    // A failed case can leave a transaction open; ROLLBACK is a no-op otherwise.
    for (const session of sessions.splice(0)) {
      await session.client.query('ROLLBACK');
      session.client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
      await admin.end();
    }
  });

  /** A dedicated connection with a statement timeout, so a lost wake fails fast. */
  async function open(): Promise<Session> {
    const client = await pool.connect();
    await client.query("SET statement_timeout = '5s'");
    const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const session = { client, pid: result.rows[0].pid };
    sessions.push(session);
    return session;
  }

  /** Resolves once `pid` is waiting on an ungranted lock of `locktype`. */
  async function blockedOn(pid: number, locktype: 'advisory' | 'transactionid'): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      // pg_locks is server-wide, so the admin pool can see the scratch database's waits.
      const result = await admin.query(
        'SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = $2 AND NOT granted',
        [pid, locktype]
      );
      if (result.rowCount) return;
      await Bun.sleep(10);
    }
    throw new Error(`backend ${String(pid)} never waited on a ${locktype} lock`);
  }

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

  async function insertEvent(session: Session, runId: string, eventType: string): Promise<string> {
    const result = await session.client.query<{ id: string }>(INSERT_EVENT, [runId, eventType]);
    return result.rows[0].id;
  }

  /** Committed event_order values, read after both writers finished. */
  async function ordersOf(...ids: string[]): Promise<number[]> {
    const result = await pool.query<{ id: string; event_order: string }>(
      'SELECT id, event_order FROM remote_agent_workflow_events WHERE id = ANY($1::uuid[])',
      [ids]
    );
    const byId = new Map(result.rows.map(row => [row.id, Number(row.event_order)]));
    return ids.map(id => byId.get(id) ?? Number.NaN);
  }

  test('an event inserted first but committed last gets the higher event_order', async () => {
    const runId = await createRun('insert-first-commit-last');
    const a = await open();
    const b = await open();

    await a.client.query('BEGIN');
    const aId = await insertEvent(a, runId, 'node_started');
    // B inserts and commits while A is still open; A draws its order only at commit.
    const bId = await insertEvent(b, runId, 'node_completed');
    await a.client.query('COMMIT');

    const [aOrder, bOrder] = await ordersOf(aId, bId);
    expect(bOrder).toBeLessThan(aOrder);
  });

  test('a committing writer waits for the order lock and then draws a higher value', async () => {
    const runId = await createRun('order-lock-wait');
    const a = await open();
    const b = await open();

    // Fire A's trigger now instead of at commit, so A holds the order lock while B
    // tries to commit. This freezes the commit-time window the lock protects.
    await a.client.query('BEGIN');
    await a.client.query('SET CONSTRAINTS archon_workflow_event_order IMMEDIATE');
    const aId = await insertEvent(a, runId, 'node_started');

    const bInsert = insertEvent(b, runId, 'node_completed');
    await blockedOn(b.pid, 'advisory');
    await a.client.query('COMMIT');
    const bId = await bInsert;

    const [aOrder, bOrder] = await ordersOf(aId, bId);
    expect(aOrder).toBeLessThan(bOrder);
  });

  test('no deadlock when a writer waits on the run row a transaction holds FOR UPDATE', async () => {
    // updateToolCallAttention and persistWorkflowEventIfRunning lock the run row
    // FOR UPDATE and then insert an event for it. A concurrent autocommit insert
    // for that run waits on the same row through its foreign key.
    const runId = await createRun('row-lock-then-insert');
    const holder = await open();
    const writer = await open();

    await holder.client.query('BEGIN');
    await holder.client.query(
      'SELECT id FROM remote_agent_workflow_runs WHERE id = $1 FOR UPDATE',
      [runId]
    );
    const writerInsert = insertEvent(writer, runId, 'provider_event');
    await blockedOn(writer.pid, 'transactionid');

    const holderId = await insertEvent(holder, runId, 'run_attention_changed');
    await holder.client.query('COMMIT');
    const writerId = await writerInsert;

    const [holderOrder, writerOrder] = await ordersOf(holderId, writerId);
    expect(holderOrder).toBeLessThan(writerOrder);
  });

  test('no deadlock when a transaction updates another run after writing an event', async () => {
    // A writes an event for one run and then updates a second run, the way
    // cancelResumableRunsForConversation covers several runs in one transaction.
    // B holds that second run and writes its own event. A lock taken at insert
    // time would make each wait on the other.
    const first = await createRun('cross-run-first');
    const second = await createRun('cross-run-second');
    const a = await open();
    const b = await open();

    await a.client.query('BEGIN');
    const aId = await insertEvent(a, first, 'node_started');
    await b.client.query('BEGIN');
    await b.client.query(
      'UPDATE remote_agent_workflow_runs SET last_activity_at = NOW() WHERE id = $1',
      [second]
    );

    const aUpdate = a.client.query(
      'UPDATE remote_agent_workflow_runs SET last_activity_at = NOW() WHERE id = $1',
      [second]
    );
    await blockedOn(a.pid, 'transactionid');

    const bId = await insertEvent(b, second, 'node_completed');
    await b.client.query('COMMIT');
    await aUpdate;
    await a.client.query('COMMIT');

    const [aOrder, bOrder] = await ordersOf(aId, bId);
    expect(bOrder).toBeLessThan(aOrder);
  });
});

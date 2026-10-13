/**
 * TEMPORARY (#3334 PR 1): event-insert throughput with and without the event_order
 * trigger, run once on the CI Postgres runner. Logs only; asserts nothing.
 * Usage: ARCHON_TEST_PG_URL=… bun packages/core/src/db/event-order-bench.tmp.ts
 */
import { Pool } from 'pg';
import { getSchemaSQL } from './bundled-schema';

const baseUrl = process.env.ARCHON_TEST_PG_URL ?? '';
if (!baseUrl) throw new Error('ARCHON_TEST_PG_URL is required');
const WRITERS = 8;
const PER_WRITER = 1000;
const DB = 'archon_event_order_bench';

const admin = new Pool({ connectionString: baseUrl });
const INSERT = `INSERT INTO remote_agent_workflow_events (workflow_run_id, event_type, step_name, data)
  VALUES ($1, 'provider_event', 'node', $2)`;
const payload = JSON.stringify({ attemptId: 'a', seq: 1, text: 'x'.repeat(200) });

type Shape = 'autocommit' | 'transaction';

async function once(shape: Shape, withTrigger: boolean): Promise<string> {
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  const url = new URL(baseUrl);
  url.pathname = `/${DB}`;
  const pool = new Pool({ connectionString: url.toString(), max: WRITERS + 2 });
  await pool.query(getSchemaSQL());
  if (!withTrigger) {
    await pool.query('DROP TRIGGER archon_workflow_event_order ON remote_agent_workflow_events');
  }
  const runs: string[] = [];
  for (let i = 0; i < WRITERS; i++) {
    const result = await pool.query<{ id: string }>(
      `WITH c AS (INSERT INTO remote_agent_conversations (platform_type, platform_conversation_id)
                  VALUES ('cli', $1) RETURNING id)
       INSERT INTO remote_agent_workflow_runs (workflow_name, conversation_id, user_message)
       SELECT 'bench', id, 'bench' FROM c RETURNING id`,
      [`bench-${String(i)}`]
    );
    runs.push(result.rows[0].id);
  }
  const latencies: number[] = [];
  const started = performance.now();
  await Promise.all(
    runs.map(async runId => {
      const client = await pool.connect();
      try {
        for (let i = 0; i < PER_WRITER; i++) {
          const t = performance.now();
          if (shape === 'transaction') {
            await client.query('BEGIN');
            await client.query(
              'UPDATE remote_agent_workflow_runs SET last_activity_at = NOW() WHERE id = $1',
              [runId]
            );
            await client.query(INSERT, [runId, payload]);
            await client.query('COMMIT');
          } else {
            await client.query(INSERT, [runId, payload]);
          }
          latencies.push(performance.now() - t);
        }
      } finally {
        client.release();
      }
    })
  );
  const seconds = (performance.now() - started) / 1000;
  const count = await pool.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM remote_agent_workflow_events WHERE event_order IS NOT NULL'
  );
  await pool.end();
  latencies.sort((x, y) => x - y);
  const p = (q: number): string => latencies[Math.floor(latencies.length * q)].toFixed(2);
  return `${shape} trigger=${String(withTrigger)} rows=${String(count.rows[0].n)} events/s=${String(Math.round((WRITERS * PER_WRITER) / seconds))} p50=${p(0.5)}ms p99=${p(0.99)}ms`;
}

for (const shape of ['autocommit', 'transaction'] as const) {
  for (let round = 0; round < 3; round++) {
    for (const withTrigger of [false, true]) {
      console.log(await once(shape, withTrigger));
    }
  }
}
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.end();

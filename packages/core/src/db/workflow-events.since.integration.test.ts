/**
 * Integration test: listWorkflowEventsSince against a REAL bun:sqlite database.
 *
 * The mock-based poller tests stub the query, so they pass while the real SQLite
 * path is dead: SQLite stores `created_at` as `datetime('now')` →
 * "YYYY-MM-DD HH:MM:SS" and compares TEXT lexicographically, but an ISO cursor
 * ("…T…Z") sorts wrong (space at index 10 < 'T'), so `created_at >= cursor` matched
 * nothing. This runs the actual function end-to-end to lock the fix (C1).
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with other db tests' fakes.
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { listWorkflowEventsSince, createWorkflowEvent } = await import('./workflow-events');

// workflow_events.workflow_run_id has an enforced FK (PRAGMA foreign_keys = ON) — seed parents.
await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);
await db.query(
  `INSERT INTO remote_agent_workflow_runs
     (id, workflow_name, conversation_id, user_message, status, started_at)
   VALUES ('run-1', 'wf', 'conv-1', 'msg', 'running', datetime('now'))`,
  []
);

const minuteAgo = (): Date => new Date(Date.now() - 60_000);

describe('listWorkflowEventsSince — real SQLite (catches the C1 datetime mismatch)', () => {
  test('returns an event stored via datetime() when queried with an ISO Date cursor', async () => {
    await createWorkflowEvent({
      workflow_run_id: 'run-1',
      event_type: 'node_completed',
      step_name: 'build',
      data: { node_output: 'x' },
    });

    const rows = await listWorkflowEventsSince(minuteAgo(), 100);

    // Without the dialect-aware cursor, an ISO param ("…T…Z") vs the stored
    // "YYYY-MM-DD HH:MM:SS" returns zero rows — the bug this test prevents.
    const ev = rows.find(r => r.event_type === 'node_completed');
    expect(ev).toBeDefined();
    expect(ev?.workflow_run_id).toBe('run-1');
    expect(ev?.data).toEqual({ node_output: 'x' }); // parsed object, not a string
  });

  test('filters by eventTypes in SQL (keeps tool_* out)', async () => {
    await createWorkflowEvent({ workflow_run_id: 'run-1', event_type: 'tool_called', data: {} });

    const onlyNodes = await listWorkflowEventsSince(minuteAgo(), 100, [
      'node_completed',
      'node_started',
    ]);

    expect(onlyNodes.some(r => r.event_type === 'tool_called')).toBe(false);
    expect(onlyNodes.some(r => r.event_type === 'node_completed')).toBe(true);
  });

  test('a future cursor returns nothing (comparison direction is correct)', async () => {
    const rows = await listWorkflowEventsSince(new Date(Date.now() + 60_000), 100);
    expect(rows).toHaveLength(0);
  });

  test('malformed data degrades to {} instead of throwing the whole batch (I2)', async () => {
    await db.query(
      `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, data, created_at)
       VALUES ('bad-evt', 'run-1', 'workflow_started', '{not json', datetime('now'))`,
      []
    );

    const rows = await listWorkflowEventsSince(minuteAgo(), 100);
    const bad = rows.find(r => r.id === 'bad-evt');
    expect(bad).toBeDefined();
    expect(bad?.data).toEqual({});
  });
});

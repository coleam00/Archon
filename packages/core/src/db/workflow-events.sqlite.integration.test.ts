// @archon-test-isolated
/**
 * Workflow event reads and writes against a REAL bun:sqlite database.
 *
 * Runs in its own `bun test` invocation (declared by @archon-test-isolated) — it mock.module's
 * ./connection with a real adapter, conflicting with other db tests' fakes.
 */
import { describe, test, expect, mock } from 'bun:test';
import type { WorkflowEventRow } from './workflow-events';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
  // Terminal writers report telemetry; covered by workflow-terminal-telemetry tests.
  isTelemetryDisabled: () => true,
  captureWorkflowTerminal: () => undefined,
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const {
  persistWorkflowEvent,
  listWorkflowEvents,
  persistWorkflowEventIfRunning,
  readWorkflowEventsAfter,
} = await import('./workflow-events');
const { cancelWorkflowRun } = await import('./workflows');

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

describe('workflow events — real SQLite', () => {
  test('cancellation cannot interleave between an instance claim check and its insert', async () => {
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, workflow_name, conversation_id, user_message, status, started_at)
       VALUES ('run-claim-race', 'wf', 'conv-1', 'msg', 'running', datetime('now'))`,
      []
    );

    const originalQuery = db.query.bind(db);
    let releaseClaim!: () => void;
    const claimReleased = new Promise<void>(resolve => {
      releaseClaim = resolve;
    });
    let claimReached!: () => void;
    const claimReady = new Promise<void>(resolve => {
      claimReached = resolve;
    });
    let intercepted = false;

    db.query = async <T>(sql: string, params?: unknown[]) => {
      const oldTwoStatementRead =
        sql.includes('SELECT status FROM remote_agent_workflow_runs') &&
        params?.[0] === 'run-claim-race';
      const atomicConditionalInsert =
        sql.includes('INSERT INTO remote_agent_workflow_events') &&
        params?.[1] === 'run-claim-race';

      if (!intercepted && oldTwoStatementRead) {
        intercepted = true;
        const result = await originalQuery<T>(sql, params);
        claimReached();
        await claimReleased;
        return result;
      }
      if (!intercepted && atomicConditionalInsert) {
        intercepted = true;
        claimReached();
        await claimReleased;
      }
      return originalQuery<T>(sql, params);
    };

    try {
      const claim = persistWorkflowEventIfRunning({
        workflow_run_id: 'run-claim-race',
        event_type: 'node_started',
        step_name: 'fan-instance',
      });
      await claimReady;
      await expect(cancelWorkflowRun('run-claim-race')).resolves.toEqual({ cancelled: true });
      releaseClaim();
      await expect(claim).resolves.toEqual({ persisted: false });

      const events = await listWorkflowEvents('run-claim-race');
      expect(events.map(event => event.event_type)).toEqual(['workflow_cancelled']);
    } finally {
      db.query = originalQuery;
      releaseClaim();
    }
  });

  test('preserves insertion chronology for lifecycle events sharing a timestamp', async () => {
    await persistWorkflowEvent({
      workflow_run_id: 'run-1',
      event_type: 'node_started',
      step_name: 'build',
    });
    await persistWorkflowEvent({
      workflow_run_id: 'run-1',
      event_type: 'node_completed',
      step_name: 'build',
    });
    await db.query(
      `UPDATE remote_agent_workflow_events
       SET created_at = '2026-01-01 00:00:01'
       WHERE workflow_run_id = 'run-1' AND step_name = 'build'`,
      []
    );

    const lifecycleTypes = (rows: WorkflowEventRow[]): string[] =>
      rows.filter(row => row.step_name === 'build').map(row => row.event_type);

    const stored = await listWorkflowEvents('run-1');
    expect(lifecycleTypes(stored)).toEqual(['node_started', 'node_completed']);
  });

  test('malformed data degrades to {} instead of throwing the whole batch (I2)', async () => {
    await db.query(
      `INSERT INTO remote_agent_workflow_events (id, workflow_run_id, event_type, data, created_at)
       VALUES ('bad-evt', 'run-1', 'workflow_started', '{not json', datetime('now'))`,
      []
    );

    const rows = await readWorkflowEventsAfter('0', 100);
    const bad = rows.find(r => r.id === 'bad-evt');
    expect(bad).toBeDefined();
    expect(bad?.data).toEqual({});
  });
});

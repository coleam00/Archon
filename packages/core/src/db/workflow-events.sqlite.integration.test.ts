// @archon-test-isolated
/**
 * Workflow event reads and writes against a REAL bun:sqlite database.
 *
 * Runs in its own `bun test` invocation (declared by @archon-test-isolated) — it mock.module's
 * ./connection with a real adapter, conflicting with other db tests' fakes.
 */
import { describe, test, expect, mock } from 'bun:test';
import type { WorkflowEventRow } from './workflow-events';
import { getTerminalRecord } from '@archon/workflows/terminal-record';

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
  listEventsForRuns,
  persistWorkflowEventIfRunning,
  readWorkflowEventsAfter,
  listActiveWorkflowNodeIds,
  getDagResumeSnapshot,
  listProviderEvents,
  listAttentionNotices,
} = await import('./workflow-events');
const { cancelWorkflowRun } = await import('./workflows');
const { insertTerminalWorkflowEvent } = await import('./workflow-terminal-event');

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

  test('batched resume events follow durable order across timestamp reversals and legacy rows', async () => {
    const runId = 'run-resume-event-order';
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, workflow_name, conversation_id, user_message, status)
       VALUES ($1, 'wf', 'conv-1', 'msg', 'failed')`,
      [runId]
    );
    const rows = [
      ['legacy-b', 'node_started', '2030-01-01 00:00:00'],
      ['legacy-a', 'source_released', '2030-01-01 00:00:00'],
      ['legacy-old', 'node_started', '2029-01-01 00:00:00'],
      ['release', 'source_released', '2026-01-02 00:00:00'],
      ['started', 'node_started', '2026-01-01 00:00:00'],
    ];
    for (const [id, type, timestamp] of rows) {
      await db.query(
        `INSERT INTO remote_agent_workflow_events
           (id, workflow_run_id, event_type, created_at)
         VALUES ($1, $2, $3, $4)`,
        [id, runId, type, timestamp]
      );
    }
    await db.query(
      `UPDATE remote_agent_workflow_events SET event_order = NULL
       WHERE workflow_run_id = $1 AND id IN ('legacy-a', 'legacy-b', 'legacy-old')`,
      [runId]
    );

    const events = (await listEventsForRuns([runId], ['source_released', 'node_started'])).get(
      runId
    );
    expect(events?.map(event => event.id)).toEqual([
      'legacy-old',
      'legacy-a',
      'legacy-b',
      'release',
      'started',
    ]);
    expect(events?.at(-1)?.event_type).toBe('node_started');
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

test.each(['events', 'active nodes', 'snapshot', 'terminal record'] as const)(
  '%s follows durable lifecycle order when timestamps disagree',
  async reader => {
    const runId = `order-${reader}`;
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, workflow_name, conversation_id, user_message, status)
       VALUES ($1, 'wf', 'conv-1', 'msg', 'running')`,
      [runId]
    );
    for (const [suffix, type, timestamp] of [
      ['legacy-b', 'node_started', '2030-01-01 00:00:00'],
      ['legacy-a', 'node_completed', '2030-01-01 00:00:00'],
      ['legacy-old', 'node_started', '2029-01-01 00:00:00'],
      ['started', 'node_started', '2026-01-02 00:00:00'],
      ['completed', 'node_completed', '2026-01-01 00:00:00'],
    ]) {
      await db.query(
        `INSERT INTO remote_agent_workflow_events
           (id, workflow_run_id, event_type, step_name, data, created_at)
         VALUES ($1, $2, $3, 'build', $4, $5)`,
        [`${runId}-${suffix}`, runId, type, JSON.stringify({ node_output: suffix }), timestamp]
      );
    }
    await db.query(
      `UPDATE remote_agent_workflow_events SET event_order = NULL
       WHERE workflow_run_id = $1 AND created_at >= '2029-01-01'`,
      [runId]
    );
    switch (reader) {
      case 'events':
        expect((await listWorkflowEvents(runId)).map(row => row.id)).toEqual(
          ['legacy-old', 'legacy-a', 'legacy-b', 'started', 'completed'].map(
            suffix => `${runId}-${suffix}`
          )
        );
        break;
      case 'active nodes':
        expect((await listActiveWorkflowNodeIds([runId])).get(runId)).toEqual([]);
        break;
      case 'snapshot':
        expect((await getDagResumeSnapshot(runId)).completedNodeOutputs.get('build')).toEqual({
          output: 'completed',
        });
        break;
      case 'terminal record': {
        await db.query("UPDATE remote_agent_workflow_runs SET status = 'cancelled' WHERE id = $1", [
          runId,
        ]);
        await insertTerminalWorkflowEvent(db.query.bind(db), {
          workflow_run_id: runId,
          event_type: 'workflow_cancelled',
        });
        const terminal = await db.query<WorkflowEventRow>(
          "SELECT * FROM remote_agent_workflow_events WHERE workflow_run_id = $1 AND event_type = 'workflow_cancelled'",
          [runId]
        );
        expect(getTerminalRecord('cancelled', terminal.rows)?.nodes).toEqual([
          { node_id: 'build', state: 'completed' },
        ]);
      }
    }
  }
);

test.each(['provider events', 'attention notices'] as const)(
  '%s places legacy rows first and sequenced rows in durable order',
  async reader => {
    const runId = `order-${reader}`;
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, workflow_name, conversation_id, user_message, status)
       VALUES ($1, 'wf', 'conv-1', 'msg', 'running')`,
      [runId]
    );
    for (const [suffix, timestamp] of [
      ['legacy-b', '2030-01-01 00:00:00'],
      ['legacy-a', '2030-01-01 00:00:00'],
      ['legacy-old', '2029-01-01 00:00:00'],
      ['first', '2026-01-02 00:00:00'],
      ['last', '2026-01-01 00:00:00'],
    ]) {
      await db.query(
        `INSERT INTO remote_agent_workflow_events
           (id, workflow_run_id, event_type, step_name, data, created_at)
         VALUES ($1, $2, $3, 'build', $4, $5)`,
        [
          `${runId}-${suffix}`,
          runId,
          reader === 'provider events' ? 'tool_called' : 'attention_notice_sent',
          JSON.stringify(
            reader === 'provider events'
              ? { tool_name: 'Bash', tool_input: {}, tool_call_id: suffix }
              : { destination: 'test', key: suffix }
          ),
          timestamp,
        ]
      );
    }
    await db.query(
      `UPDATE remote_agent_workflow_events SET event_order = NULL
       WHERE workflow_run_id = $1 AND created_at >= '2029-01-01'`,
      [runId]
    );
    const values =
      reader === 'provider events'
        ? (await listProviderEvents(runId)).map(row =>
            row.event.type === 'tool_call' ? row.event.toolCallId : undefined
          )
        : (await listAttentionNotices([runId])).map(row => row.data.key);
    expect(values).toEqual(['legacy-old', 'legacy-a', 'legacy-b', 'first', 'last']);
  }
);

test('dashboard reports the latest durable parallel-agent total rather than the latest timestamp', async () => {
  const runId = 'order-dashboard';
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status)
     VALUES ($1, 'wf', 'conv-1', 'msg', 'running')`,
    [runId]
  );
  for (const [id, timestamp, total] of [
    ['old', '2030-01-01 00:00:00', 2],
    ['new', '2026-01-01 00:00:00', 3],
  ] as const) {
    await db.query(
      `INSERT INTO remote_agent_workflow_events
         (id, workflow_run_id, event_type, data, created_at)
       VALUES ($1, $2, 'parallel_agent_started', $3, $4)`,
      [`${runId}-${id}`, runId, JSON.stringify({ totalAgents: total }), timestamp]
    );
  }
  const { listDashboardRuns } = await import('./workflow-run-lists');
  const dashboard = await listDashboardRuns();
  expect(dashboard.runs.find(run => run.id === runId)?.agents_total).toBe(3);
});

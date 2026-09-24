/**
 * Terminal telemetry against a REAL bun:sqlite database: every terminal writer reports
 * its committed transition exactly once, a lost CAS reports nothing, and the projected
 * payload accumulates across resume segments.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with workflows.test.ts's fake.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowTerminalProperties } from '@archon/paths';

const captured: WorkflowTerminalProperties[] = [];
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
  isTelemetryDisabled: () => false,
  captureWorkflowTerminal: (props: WorkflowTerminalProperties) => {
    captured.push(props);
  },
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
  completeWorkflowRun,
  failWorkflowRun,
  cancelWorkflowRun,
  cancelFanOutRun,
  cancelResumableRunsForConversation,
  resolveAndCancelApprovalGate,
  failPausedAttentionWait,
  resumeWorkflowRun,
} = await import('./workflows');

await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);

async function seedRun(
  id: string,
  status: string,
  options: { metadata?: Record<string, unknown>; parentRunId?: string } = {}
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status, parent_run_id, metadata,
        started_at, last_activity_at)
     VALUES ($1, 'implement', 'conv-1', 'msg', $2, $3, $4, datetime('now'), datetime('now'))`,
    [id, status, options.parentRunId ?? null, JSON.stringify(options.metadata ?? {})]
  );
}

/** SQLite `created_at` text for a moment `minutesAgo` before now. */
function ago(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

let eventSeq = 0;
async function seedEvent(
  runId: string,
  eventType: string,
  createdAt: string,
  data: Record<string, unknown> = {},
  stepName: string | null = null
): Promise<void> {
  eventSeq++;
  await db.query(
    `INSERT INTO remote_agent_workflow_events
       (id, workflow_run_id, event_type, step_name, data, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [`evt-${String(eventSeq)}`, runId, eventType, stepName, JSON.stringify(data), createdAt]
  );
}

beforeEach(() => {
  captured.length = 0;
});

describe('terminal writers report each committed transition once', () => {
  test('complete, fail, cancel and fan-out cancel report on the won CAS only', async () => {
    await seedRun('t-complete', 'running');
    await completeWorkflowRun('t-complete', { duration_ms: 5 });
    await expect(completeWorkflowRun('t-complete', { duration_ms: 5 })).rejects.toThrow();

    await seedRun('t-fail', 'running');
    await failWorkflowRun('t-fail', 'boom', { exitReason: 'node_error' });
    await expect(failWorkflowRun('t-fail', 'boom')).rejects.toThrow();

    await seedRun('t-cancel', 'running');
    await cancelWorkflowRun('t-cancel', { cancel_reason: 'operator', reason: 'free text' });
    expect((await cancelWorkflowRun('t-cancel')).cancelled).toBe(false);

    await seedRun('t-fanout', 'running');
    await cancelFanOutRun('t-fanout', 'fan_out_sibling');
    expect((await cancelFanOutRun('t-fanout', 'fan_out_sibling')).cancelled).toBe(false);

    expect(captured.map(p => [p.runId, p.outcome])).toEqual([
      ['t-complete', 'completed'],
      ['t-fail', 'failed'],
      ['t-cancel', 'cancelled'],
      ['t-fanout', 'cancelled'],
    ]);
    expect(captured[1]).toMatchObject({ exitReason: 'node_error' });
    expect(captured[2]).toMatchObject({ cancelReason: 'operator' });
    expect(captured[3]).toMatchObject({ cancelReason: 'fan_out' });
    // Free-text reasons never reach the payload.
    expect(JSON.stringify(captured)).not.toContain('free text');
  });

  test('an approval reject and an undeliverable attention wait report on the won CAS only', async () => {
    await seedRun('t-reject', 'paused', {
      metadata: { approval: { nodeId: 'review', message: 'Approve?', type: 'approval' } },
    });
    const rejection = { step_name: 'review', reason: 'free text' };
    expect((await resolveAndCancelApprovalGate('t-reject', [], rejection)).resolved).toBe(true);
    expect((await resolveAndCancelApprovalGate('t-reject', [], rejection)).resolved).toBe(false);

    const attention = {
      owner: 'node' as const,
      nodeId: 'rerun-ci',
      kind: 'attention' as const,
      waitingSince: '2026-08-24T11:00:00.000Z',
      message: 'Re-run the failing check, then resume.',
    };
    await seedRun('t-attention', 'paused', { metadata: { wait: attention } });
    expect((await failPausedAttentionWait('t-attention', attention, 'undelivered')).failed).toBe(
      true
    );
    expect((await failPausedAttentionWait('t-attention', attention, 'undelivered')).failed).toBe(
      false
    );

    expect(captured.map(p => [p.runId, p.outcome, p.cancelReason])).toEqual([
      ['t-reject', 'cancelled', 'approval_rejected'],
      ['t-attention', 'failed', undefined],
    ]);
  });

  test('a conversation reset reports every run it cancelled', async () => {
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ('conv-reset', 'web', 'conv-reset-platform')`,
      []
    );
    for (const id of ['r-paused', 'r-failed']) {
      await db.query(
        `INSERT INTO remote_agent_workflow_runs
           (id, workflow_name, conversation_id, user_message, status, metadata)
         VALUES ($1, 'implement', 'conv-reset', 'msg', $2, '{}')`,
        [id, id === 'r-paused' ? 'paused' : 'failed']
      );
    }
    await cancelResumableRunsForConversation('conv-reset');
    expect(captured.map(p => [p.runId, p.outcome, p.cancelReason]).sort()).toEqual([
      ['r-failed', 'cancelled', 'conversation_reset'],
      ['r-paused', 'cancelled', 'conversation_reset'],
    ]);
  });
});

describe('the projected payload', () => {
  test('accumulates duration and loop iterations across a failed-then-resumed run', async () => {
    await seedRun('t-resume', 'running', {
      metadata: { dispatch: { base_branch: 'main', source: 'bundled' } },
    });
    await seedEvent('t-resume', 'workflow_started', ago(120), {
      provider: 'claude',
      model: 'opus[1m]',
      origin: 'cli',
    });
    await seedEvent('t-resume', 'loop_iteration_completed', ago(119));
    await seedEvent('t-resume', 'loop_iteration_completed', ago(118));
    await seedEvent(
      't-resume',
      'node_failed',
      ago(117),
      { error: 'Bash node failed', failure_kind: 'exec_failed' },
      'build'
    );
    await failWorkflowRun('t-resume', 'failed', { exitReason: 'node_error' });

    await resumeWorkflowRun('t-resume');
    await seedEvent('t-resume', 'workflow_started', ago(2), { origin: 'api' });
    await seedEvent('t-resume', 'loop_iteration_completed', ago(1));
    await completeWorkflowRun('t-resume', { duration_ms: 60_000 });

    expect(captured).toHaveLength(2);
    const [failed, completed] = captured;
    expect(failed).toMatchObject({
      outcome: 'failed',
      runId: 't-resume',
      isChild: false,
      workflowName: 'implement',
      workflowSource: 'bundled',
      provider: 'claude',
      model: 'opus[1m]',
      platform: 'cli',
      loopIterations: 2,
      exitReason: 'node_error',
      errorClass: 'exec_failed',
    });
    // The resumed segment keeps the original surface and counts every segment.
    expect(completed).toMatchObject({
      outcome: 'completed',
      runId: 't-resume',
      platform: 'cli',
      loopIterations: 3,
    });
    // Wall-clock from the first start (120 minutes ago) to the completion just now.
    expect(completed?.durationMs).toBeGreaterThanOrEqual(119 * 60_000);
    expect(completed?.durationMs).toBeLessThan(122 * 60_000);
    expect(completed).not.toHaveProperty('exitReason');
  });

  test('a child run is marked, and a run without a recorded source stays unattributed', async () => {
    await seedRun('t-parent', 'running');
    await seedRun('t-child', 'running', { parentRunId: 't-parent' });
    await completeWorkflowRun('t-child', { duration_ms: 1 });
    expect(captured[0]).toMatchObject({ runId: 't-child', isChild: true });
    expect(captured[0]).not.toHaveProperty('workflowSource');
  });
});

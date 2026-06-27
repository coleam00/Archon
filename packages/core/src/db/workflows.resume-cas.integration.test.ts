/**
 * Integration test: resumeWorkflowRun against a REAL bun:sqlite database.
 *
 * The mock-based workflows.test.ts asserts SQL substrings but cannot catch a
 * mis-bound parameter or the dialect-specific date arithmetic - which is exactly
 * how the CAS `$2`-unbound bug (PR #1830 review C1) slipped through. This runs
 * the actual function against a real SqliteAdapter so the orphan-recovery arm and
 * the `datetime('now','-N days')` comparison are executed end-to-end.
 *
 * Runs in its own `bun test` invocation (see package.json) - it mock.module's
 * ./connection with a real adapter, conflicting with workflows.test.ts's fake.
 */
import { describe, test, expect, mock } from 'bun:test';
import type { RouteLoopRuntimeMetadata } from '@archon/workflows/schemas/workflow-run';

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
  getArchonWorkspacesPath: () => '/tmp/archon/workspaces',
  getProjectWorktreesPath: (owner: string, repo: string) =>
    `/tmp/archon/workspaces/${owner}/${repo}/worktrees`,
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { routeLoopRuntimeMetadataSchema } = await import('@archon/workflows/schemas/workflow-run');
const { persistRouteDecisionTransition, resumeWorkflowRun } = await import('./workflows');

// workflow_runs.conversation_id is NOT NULL with an enforced FK - seed a parent.
await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);

/** Insert a run with an explicit status and a SQL expression for last_activity_at. */
async function seed(
  id: string,
  status: string,
  lastActivityExpr: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status, metadata, started_at, last_activity_at)
     VALUES ($1, 'wf', 'conv-1', 'msg', $2, $3, datetime('now'), ${lastActivityExpr})`,
    [id, status, JSON.stringify(metadata)]
  );
}

const resumedRouteLoopMetadata = {
  approval: { nodeId: 'human-gate', message: 'Approve final route?' },
  loopCounters: { 'review-router': 2, 'audit-router': 1 },
  nodeAttempts: { 'review-router': 3, 'audit-router': 1 },
  executionSeq: 9,
  routeActivations: {
    fix: {
      route_loop_node_id: 'review-router',
      outcome: 'negative',
      target_node_id: 'fix',
      attempt: 1,
      execution_seq: 4,
    },
    done: {
      route_loop_node_id: 'review-router',
      outcome: 'positive',
      target_node_id: 'done',
      attempt: 3,
      execution_seq: 9,
    },
  },
} satisfies RouteLoopRuntimeMetadata;

const nextRouteLoopMetadata = {
  loopCounters: { 'review-router': 1 },
  nodeAttempts: { 'review-router': 1 },
  executionSeq: 1,
  routeActivations: {
    fix: {
      route_loop_node_id: 'review-router',
      outcome: 'negative',
      target_node_id: 'fix',
      attempt: 1,
      execution_seq: 1,
    },
  },
} satisfies RouteLoopRuntimeMetadata;

const routedEventData = {
  from: 'review',
  outcome: 'negative',
  to: 'fix',
  condition: "$review.output.result == '<redacted>'",
  condition_result: false,
  negative_count: 1,
  max_iterations: 10,
  attempt: 1,
  execution_seq: 1,
};

describe('resumeWorkflowRun - real SQLite (CAS + orphan recovery)', () => {
  test('resumes a stale running orphan - binds the day param + dialect date SQL (catches C1)', async () => {
    // With the day param unbound ($2 -> NULL), `last_activity_at < NULL` is false
    // and this orphan would never match - the bug this test exists to prevent.
    await seed('orphan', 'running', "datetime('now', '-10 days')");
    const run = await resumeWorkflowRun('orphan');
    expect(run.status).toBe('running');
  });

  test('resumes a failed run', async () => {
    await seed('failed', 'failed', "datetime('now')");
    expect((await resumeWorkflowRun('failed')).status).toBe('running');
  });

  test('resumes a paused run', async () => {
    await seed('paused', 'paused', "datetime('now')");
    expect((await resumeWorkflowRun('paused')).status).toBe('running');
  });

  test('refuses a fresh running run (CAS miss - no double-claim)', async () => {
    await seed('fresh', 'running', "datetime('now')");
    await expect(resumeWorkflowRun('fresh')).rejects.toThrow(/not resumable.*status: running/);
  });

  test('refuses a completed run', async () => {
    await seed('done', 'completed', "datetime('now')");
    await expect(resumeWorkflowRun('done')).rejects.toThrow(/not resumable.*status: completed/);
  });

  test('throws not-found for a missing run', async () => {
    await expect(resumeWorkflowRun('ghost')).rejects.toThrow('Workflow run not found (id: ghost)');
  });

  test('preserves route-loop runtime metadata when resuming a failed run', async () => {
    await seed('failed-route-state', 'failed', "datetime('now')", resumedRouteLoopMetadata);

    const run = await resumeWorkflowRun('failed-route-state');
    const metadata = routeLoopRuntimeMetadataSchema.parse(run.metadata);

    expect(metadata.loopCounters).toEqual(resumedRouteLoopMetadata.loopCounters);
    expect(metadata.nodeAttempts).toEqual(resumedRouteLoopMetadata.nodeAttempts);
    expect(metadata.executionSeq).toBe(resumedRouteLoopMetadata.executionSeq);
    expect(metadata.routeActivations).toEqual(resumedRouteLoopMetadata.routeActivations);
  });

  test('preserves route-loop runtime metadata when claiming a stale running orphan', async () => {
    await seed(
      'orphan-route-state',
      'running',
      "datetime('now', '-10 days')",
      resumedRouteLoopMetadata
    );

    const run = await resumeWorkflowRun('orphan-route-state');
    const metadata = routeLoopRuntimeMetadataSchema.parse(run.metadata);

    expect(metadata).toEqual(expect.objectContaining(resumedRouteLoopMetadata));
  });

  test('resumes route-loop state written by the route decision transition', async () => {
    await seed('persisted-route-state', 'running', "datetime('now')", {
      loopCounters: {},
      nodeAttempts: {},
      executionSeq: 0,
      routeActivations: {},
    });

    await persistRouteDecisionTransition({
      workflow_run_id: 'persisted-route-state',
      expected_execution_seq: 0,
      metadata: nextRouteLoopMetadata,
      event: {
        step_name: 'review-router',
        data: routedEventData,
      },
      completed_event: {
        step_name: 'review-router',
        data: { node_output: JSON.stringify(routedEventData) },
      },
    });

    await db.query("UPDATE remote_agent_workflow_runs SET status = 'failed' WHERE id = $1", [
      'persisted-route-state',
    ]);

    const run = await resumeWorkflowRun('persisted-route-state');
    const metadata = routeLoopRuntimeMetadataSchema.parse(run.metadata);

    expect(metadata.loopCounters).toEqual(nextRouteLoopMetadata.loopCounters);
    expect(metadata.nodeAttempts).toEqual(nextRouteLoopMetadata.nodeAttempts);
    expect(metadata.executionSeq).toBe(nextRouteLoopMetadata.executionSeq);
    expect(metadata.routeActivations).toEqual(nextRouteLoopMetadata.routeActivations);

    const events = await db.query<{ event_type: string; step_name: string; data: string }>(
      `SELECT event_type, step_name, data
       FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1`,
      ['persisted-route-state']
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]).toMatchObject({
      event_type: 'node_routed',
      step_name: 'review-router',
      data: JSON.stringify(routedEventData),
    });
    expect(events.rows[1]).toMatchObject({
      event_type: 'node_completed',
      step_name: 'review-router',
      data: JSON.stringify({ node_output: JSON.stringify(routedEventData) }),
    });
  });
});

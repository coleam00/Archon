/**
 * Integration test: resumeWorkflowRun against a REAL bun:sqlite database.
 *
 * The mock-based workflows.test.ts asserts SQL substrings but cannot catch a
 * mis-bound parameter or the dialect-specific date arithmetic — which is exactly
 * how the CAS `$2`-unbound bug (PR #1830 review C1) slipped through. This runs
 * the actual function against a real SqliteAdapter so the orphan-recovery arm and
 * the `datetime('now','-N days')` comparison are executed end-to-end.
 *
 * Runs in its own `bun test` invocation (see package.json) — it mock.module's
 * ./connection with a real adapter, conflicting with workflows.test.ts's fake.
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
  // Consumed by workflow-operations (gate-staging tests below).
  captureApprovalResolved: () => undefined,
}));

const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  pool: db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const {
  resumeWorkflowRun,
  pauseWorkflowRun,
  getWorkflowRun,
  findResumableRun,
  findResumableRunByParentConversation,
  WorkflowNotResumableError,
} = await import('./workflows');
const { approveWorkflow, rejectWorkflow } = await import('../operations/workflow-operations');

// workflow_runs.conversation_id is NOT NULL with an enforced FK — seed a parent.
await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);

/** Insert a run with an explicit status and a SQL expression for last_activity_at. */
async function seed(id: string, status: string, lastActivityExpr: string): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status, started_at, last_activity_at)
     VALUES ($1, 'wf', 'conv-1', 'msg', $2, datetime('now'), ${lastActivityExpr})`,
    [id, status]
  );
}

describe('resumeWorkflowRun — real SQLite (CAS + orphan recovery)', () => {
  test('resumes a stale running orphan — binds the day param + dialect date SQL (catches C1)', async () => {
    // With the day param unbound ($2 → NULL), `last_activity_at < NULL` is false
    // and this orphan would never match — the bug this test exists to prevent.
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

  test('refuses a fresh running run (CAS miss — no double-claim)', async () => {
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
});

// ---------------------------------------------------------------------------
// Gate approve/reject staging (#2075) — the run stays 'paused' after a gate
// resolution instead of masquerading as 'failed'. This exercises the REAL
// SQLite json_patch path end-to-end: staging write, resumable pickup (both the
// parent-conversation query the orchestrator uses and the working-path query
// the CLI uses), the resume CAS, the double-resolution guard, and — critically
// — that a fresh pause clears the previous gate's `resolved` marker despite
// json_patch's deep-merge semantics.
// ---------------------------------------------------------------------------

/**
 * Seed a codebase + paused run with approval context; returns the run id.
 * Distinct workflow names per test group — the latest-run pickup queries
 * order by started_at, which only has second precision in SQLite.
 */
async function seedPausedRun(
  id: string,
  workflowName: string,
  approval: Record<string, unknown>,
  extraMetadata: Record<string, unknown> = {}
): Promise<string> {
  await db.query(
    `INSERT OR IGNORE INTO remote_agent_codebases (id, name, default_cwd)
     VALUES ('cb-1', 'repo', '/repo')`,
    []
  );
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, parent_conversation_id, codebase_id,
        user_message, status, metadata, working_path, started_at, last_activity_at)
     VALUES ($1, $2, 'conv-1', 'conv-1', 'cb-1', 'msg', 'paused', $3, '/repo/wt',
             datetime('now'), datetime('now'))`,
    [id, workflowName, JSON.stringify({ approval, ...extraMetadata })]
  );
  return id;
}

describe('gate approve staging — real SQLite end-to-end (#2075)', () => {
  test('approve keeps the run paused, stages resolution, and the resume machinery picks it up', async () => {
    await seedPausedRun('gate-1', 'wf-gate', {
      nodeId: 'review',
      message: 'Approve?',
      type: 'approval',
      resolved: null,
    });

    await approveWorkflow('gate-1', 'ship it');

    // Status is honest: still paused, not a fake failure; no completion stamp.
    const staged = await getWorkflowRun('gate-1');
    expect(staged?.status).toBe('paused');
    expect(staged?.completed_at).toBeNull();
    const approval = staged?.metadata.approval as Record<string, unknown>;
    expect(approval.resolved).toBe('approved');
    expect(staged?.metadata.approval_response).toBe('approved');

    // Double-approve guard (the status check alone no longer blocks it).
    await expect(approveWorkflow('gate-1', 'again')).rejects.toThrow(
      'already approved and is awaiting resume'
    );

    // Both resumable pickups find the staged run: the orchestrator's
    // parent-conversation query and the CLI's working-path query
    // (approve --json → later `run --resume` contract).
    const byParent = await findResumableRunByParentConversation('wf-gate', 'conv-1', 'cb-1');
    expect(byParent?.id).toBe('gate-1');
    const byPath = await findResumableRun('wf-gate', '/repo/wt');
    expect(byPath?.id).toBe('gate-1');

    // Resume CAS flips it to running; a concurrent second resume loses the race.
    const resumed = await resumeWorkflowRun('gate-1');
    expect(resumed.status).toBe('running');
    await expect(resumeWorkflowRun('gate-1')).rejects.toThrow(WorkflowNotResumableError);
  });

  test('a fresh pause clears the previous resolution despite json_patch deep-merge', async () => {
    // Continue the run from the previous test: it is 'running' with
    // approval.resolved = 'approved' still in metadata (never cleared on
    // resume by design). The next gate's pause MUST reset it — on SQLite
    // json_patch deep-merges the new approval context into the old one, so an
    // omitted key would leak the stale 'approved' and falsely block this gate.
    await pauseWorkflowRun('gate-1', {
      nodeId: 'second-gate',
      message: 'Approve step 2?',
      type: 'approval',
    });

    const repaused = await getWorkflowRun('gate-1');
    expect(repaused?.status).toBe('paused');
    const approval = repaused?.metadata.approval as Record<string, unknown>;
    expect(approval.nodeId).toBe('second-gate');
    // json_patch removes keys patched with null — 'resolved' must be gone/null.
    expect(approval.resolved ?? null).toBeNull();

    // And the second gate is approvable again.
    await approveWorkflow('gate-1', 'step 2 fine');
    const staged = await getWorkflowRun('gate-1');
    expect((staged?.metadata.approval as Record<string, unknown>).resolved).toBe('approved');
    expect(staged?.status).toBe('paused');
  });
});

describe('gate reject staging — real SQLite end-to-end (#2075)', () => {
  test('reject with on_reject stays paused with staged rework and resumes', async () => {
    await seedPausedRun(
      'gate-reject',
      'wf-gate-reject',
      {
        nodeId: 'review',
        message: 'Approve?',
        type: 'approval',
        onRejectPrompt: 'Fix: $REJECTION_REASON',
        onRejectMaxAttempts: 3,
        resolved: null,
      },
      { rejection_count: 0 }
    );

    const result = await rejectWorkflow('gate-reject', 'needs tests');
    expect(result.cancelled).toBe(false);

    const staged = await getWorkflowRun('gate-reject');
    expect(staged?.status).toBe('paused');
    expect(staged?.completed_at).toBeNull();
    const approval = staged?.metadata.approval as Record<string, unknown>;
    expect(approval.resolved).toBe('rejected');
    expect(staged?.metadata.rejection_reason).toBe('needs tests');
    expect(staged?.metadata.rejection_count).toBe(1);

    // Double-reject guard.
    await expect(rejectWorkflow('gate-reject', 'again')).rejects.toThrow(
      'already rejected and is awaiting resume'
    );

    // The staged rework is resumable.
    const byParent = await findResumableRunByParentConversation('wf-gate-reject', 'conv-1', 'cb-1');
    expect(byParent?.id).toBe('gate-reject');
    expect((await resumeWorkflowRun('gate-reject')).status).toBe('running');
  });

  test('reject without on_reject cancels the run', async () => {
    await seedPausedRun('gate-cancel', 'wf-gate-cancel', {
      nodeId: 'review',
      message: 'Approve?',
      type: 'approval',
      resolved: null,
    });

    const result = await rejectWorkflow('gate-cancel', 'no');
    expect(result.cancelled).toBe(true);
    expect((await getWorkflowRun('gate-cancel'))?.status).toBe('cancelled');
  });
});

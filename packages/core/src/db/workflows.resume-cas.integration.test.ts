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
import type { TokenUsage } from '@archon/providers/types';
import { isWorkflowWaitContext } from '@archon/workflows/schemas/workflow-run';
import type { GateResolutionEvent } from './workflows';

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
  // The gate CAS functions run their UPDATE + audit-event INSERT inside one
  // withTransaction (#2146) — hand them the real adapter so the transaction is
  // exercised end-to-end.
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const {
  resumeWorkflowRun,
  recoverCancelledFanOutRun,
  cancelWorkflowRun,
  cancelFanOutRun,
  pauseWorkflowRun,
  pauseWorkflowRunForWait,
  clearWorkflowWaitContext,
  signalWorkflowWait,
  listDueWorkflowContinuations,
  deferWorkflowContinuation,
  getWorkflowRun,
  findResumableRun,
  findResumableRunByParentConversation,
  cancelResumableRunsForConversation,
  resolveApprovalGate,
  resolveAndCancelApprovalGate,
  claimWriteback,
  releaseWritebackClaim,
  completeWorkflowRun,
  failWorkflowRun,
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
async function seed(
  id: string,
  status: string,
  lastActivityExpr: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, user_message, status, started_at, last_activity_at, metadata)
     VALUES ($1, 'wf', 'conv-1', 'msg', $2, datetime('now'), ${lastActivityExpr}, $3)`,
    [id, status, JSON.stringify(metadata)]
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

  test('clears a failed run error when resuming, preserving it as an event', async () => {
    // #2329: a run that failed, resumed and completed kept rendering its old
    // error. #2348: for the motivating run the error lived ONLY in metadata —
    // older CLI SIGTERM handlers could leave only this metadata error — so
    // clearing it silently destroyed the only record that the run ever failed.
    await seed('failed-with-error', 'failed', "datetime('now')", {
      error: 'Process terminated (SIGTERM)',
      unrelated: 'keep me',
    });

    const resumed = await resumeWorkflowRun('failed-with-error');

    expect(resumed.status).toBe('running');
    const after = await getWorkflowRun('failed-with-error');
    expect(after?.metadata.error ?? null).toBeNull();
    // Merge, not replace: unrelated metadata survives the clear.
    expect(after?.metadata.unrelated).toBe('keep me');

    // ...and the cleared error is now recoverable from the audit trail.
    const events = await db.query<{ data: string }>(
      `SELECT data FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type = 'workflow_resumed'`,
      ['failed-with-error']
    );
    expect(events.rows).toHaveLength(1);
    expect(JSON.parse(events.rows[0]?.data ?? '{}')).toEqual({
      error: 'Process terminated (SIGTERM)',
    });
  });

  test('writes no event when the resumed run carried no error', async () => {
    // A paused gate resumes with nothing to preserve — it must not gain a
    // spurious "this run failed once" record.
    await seed('paused-clean', 'paused', "datetime('now')");

    expect((await resumeWorkflowRun('paused-clean')).status).toBe('running');

    const events = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type = 'workflow_resumed'`,
      ['paused-clean']
    );
    expect(Number(events.rows[0]?.cnt ?? -1)).toBe(0);
  });

  test('two concurrent resumes: exactly one wins and exactly one event lands', async () => {
    // The loser read the same error but its CAS matched nothing — it must write
    // nothing, or a lost race still emits an audit event for a clear it never did.
    await seed('resume-race', 'failed', "datetime('now')", { error: 'boom' });

    const outcomes = await Promise.allSettled([
      resumeWorkflowRun('resume-race'),
      resumeWorkflowRun('resume-race'),
    ]);

    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    const events = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type = 'workflow_resumed'`,
      ['resume-race']
    );
    expect(Number(events.rows[0]?.cnt ?? -1)).toBe(1);
  });

  test('rolls back the clear when the audit-event write fails', async () => {
    // The preservation is only worth anything if it cannot be skipped: a failed
    // event INSERT must roll the clear back, leaving the run resumable with its
    // error intact rather than erasing it with no record.
    await seed('resume-atomic', 'failed', "datetime('now')", { error: 'boom' });

    // Break the event INSERT by removing the table for the duration of the call.
    await db.query('ALTER TABLE remote_agent_workflow_events RENAME TO events_stash', []);
    try {
      await expect(resumeWorkflowRun('resume-atomic')).rejects.toThrow(
        /Failed to resume workflow run/
      );
    } finally {
      await db.query('ALTER TABLE events_stash RENAME TO remote_agent_workflow_events', []);
    }

    const after = await getWorkflowRun('resume-atomic');
    expect(after?.status).toBe('failed');
    expect(after?.metadata.error).toBe('boom');
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

describe('cancelResumableRunsForConversation — real SQLite', () => {
  test('cancels paused roots once across a running status gap (#2731 R4)', async () => {
    await db.query(
      `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
       VALUES ('conv-reset-gap', 'web', 'conv-reset-gap-platform')`,
      []
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, workflow_name, conversation_id, user_message, status, started_at, metadata)
       VALUES
         ('reset-a', 'wf', 'conv-reset-gap', 'msg', 'paused', datetime('now', '-3 seconds'), '{}')`,
      []
    );
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, workflow_name, conversation_id, user_message, status, started_at, metadata, parent_run_id)
       VALUES
         ('reset-b', 'wf', 'conv-reset-gap', 'msg', 'running', datetime('now', '-2 seconds'), '{}', 'reset-a'),
         ('reset-c', 'wf', 'conv-reset-gap', 'msg', 'paused', datetime('now', '-1 second'), '{}', 'reset-b')`,
      []
    );

    const cancelled = await cancelResumableRunsForConversation('conv-reset-gap');

    expect(cancelled.map(run => run.id).sort()).toEqual(['reset-a', 'reset-c']);
    const final = await db.query<{ id: string; status: string; completed_at: string | null }>(
      `SELECT id, status, completed_at FROM remote_agent_workflow_runs
       WHERE conversation_id = $1 ORDER BY id`,
      ['conv-reset-gap']
    );
    expect(final.rows).toEqual([
      { id: 'reset-a', status: 'cancelled', completed_at: expect.any(String) },
      { id: 'reset-b', status: 'running', completed_at: null },
      { id: 'reset-c', status: 'cancelled', completed_at: expect.any(String) },
    ]);
    const events = await db.query<{ workflow_run_id: string }>(
      `SELECT workflow_run_id FROM remote_agent_workflow_events
       WHERE workflow_run_id IN ('reset-a', 'reset-b', 'reset-c')
         AND event_type = 'workflow_cancelled'
       ORDER BY workflow_run_id`,
      []
    );
    expect(events.rows).toEqual([{ workflow_run_id: 'reset-a' }, { workflow_run_id: 'reset-c' }]);
  });

  test('rolls back every cancellation when an event cannot be stored', async () => {
    await seed('reset-atomic-a', 'paused', "datetime('now')");
    await seed('reset-atomic-b', 'failed', "datetime('now')");

    await db.query('ALTER TABLE remote_agent_workflow_events RENAME TO events_stash', []);
    try {
      await expect(cancelResumableRunsForConversation('conv-1')).rejects.toThrow(
        'Failed to cancel resumable runs for conversation'
      );
    } finally {
      await db.query('ALTER TABLE events_stash RENAME TO remote_agent_workflow_events', []);
    }

    const runs = await db.query<{ id: string; status: string; completed_at: string | null }>(
      `SELECT id, status, completed_at FROM remote_agent_workflow_runs
       WHERE id IN ('reset-atomic-a', 'reset-atomic-b') ORDER BY id`,
      []
    );
    expect(runs.rows).toEqual([
      { id: 'reset-atomic-a', status: 'paused', completed_at: null },
      { id: 'reset-atomic-b', status: 'failed', completed_at: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// claimWriteback CAS (R2-F4) — retry-safe container write-back apply. Real SQLite
// json_patch: exactly one caller wins the claim; release makes it claimable again.
// ---------------------------------------------------------------------------

describe('claimWriteback — real SQLite CAS', () => {
  test('first caller wins, second loses (no double-apply)', async () => {
    await seed('wb-claim', 'running', "datetime('now')");
    const first = await claimWriteback('wb-claim');
    const second = await claimWriteback('wb-claim');
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
  });

  test('release makes the write-back claimable again (retry after a failed apply)', async () => {
    await seed('wb-release', 'running', "datetime('now')");
    expect((await claimWriteback('wb-release')).claimed).toBe(true);
    expect((await claimWriteback('wb-release')).claimed).toBe(false);
    await releaseWritebackClaim('wb-release');
    // Released → the retrying resume can re-claim.
    expect((await claimWriteback('wb-release')).claimed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gate approve/reject staging (#2075) — the run stays 'paused' after a gate
// resolution instead of masquerading as 'failed'. This exercises the REAL
// SQLite JSON write path end-to-end: staging write, resumable pickup (both the
// parent-conversation query the orchestrator uses and the working-path query
// the CLI uses), the resume CAS, the double-resolution guard, and — critically
// — that a fresh pause carries nothing from the previous gate, which only a
// real engine can prove (the mock suite runs the Postgres dialect).
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

  test('a fresh pause replaces the previous gate context, clearing its resolution', async () => {
    // Continue the run from the previous test: it is 'running' with
    // approval.resolved = 'approved' still in metadata (never cleared on
    // resume by design). The next gate's pause MUST reset it — the write
    // replaces the whole approval object, so a key this gate does not set
    // cannot carry the stale 'approved' over and falsely block it.
    await pauseWorkflowRun('gate-1', {
      nodeId: 'second-gate',
      message: 'Approve step 2?',
      type: 'approval',
    });

    const repaused = await getWorkflowRun('gate-1');
    expect(repaused?.status).toBe('paused');
    const approval = repaused?.metadata.approval as Record<string, unknown>;
    expect(approval.nodeId).toBe('second-gate');
    expect(approval.resolved ?? null).toBeNull();

    // And the second gate is approvable again.
    await approveWorkflow('gate-1', 'step 2 fine');
    const staged = await getWorkflowRun('gate-1');
    expect((staged?.metadata.approval as Record<string, unknown>).resolved).toBe('approved');
    expect(staged?.status).toBe('paused');
  });
});

// ---------------------------------------------------------------------------
// #2673 — a later gate must not inherit an earlier gate's approval data. The
// numeric half is the dangerous one: SQLite's json_patch is RFC 7396 and
// recurses, so before the wholesale-replace write, interior keys of the nested
// `signaledTokens` object survived from the previous gate and became real token
// accounting on resume (readSignaledTokens in dag-executor). Only a real engine
// can catch this; the mock suite runs the Postgres dialect, where `||` already
// replaced the object.
// ---------------------------------------------------------------------------
describe('fresh gate usage is its own — real SQLite end-to-end (#2673)', () => {
  /** Pause `runId` on a gate carrying `signaledTokens` and read the stored object back. */
  async function pauseWithTokens(
    runId: string,
    nodeId: string,
    signaledTokens: TokenUsage
  ): Promise<Record<string, unknown> | undefined> {
    await pauseWorkflowRun(runId, {
      nodeId,
      message: `gate ${nodeId}`,
      type: 'interactive_loop',
      iteration: 1,
      signaledTokens,
    });
    const run = await getWorkflowRun(runId);
    const approval = run?.metadata.approval as Record<string, unknown> | undefined;
    return approval?.signaledTokens as Record<string, unknown> | undefined;
  }

  test('a second gate whose usage omits the cache axes does not inherit them', async () => {
    await seedPausedRun('usage-cache', 'wf-usage-cache', { nodeId: 'seed', message: 'seed' });

    // Gate 1: a provider that reports cache telemetry.
    await resumeWorkflowRun('usage-cache');
    const first = await pauseWithTokens('usage-cache', 'gate-1', {
      input: 40,
      output: 4,
      cacheRead: 20,
      cacheWrite: 3,
    });
    expect(first).toEqual({ input: 40, output: 4, cacheRead: 20, cacheWrite: 3 });

    // Gate 2: a provider with no cache telemetry at all.
    await resumeWorkflowRun('usage-cache');
    const second = await pauseWithTokens('usage-cache', 'gate-2', { input: 90, output: 9 });

    // Exactly the second gate's usage — no fabricated cache counts.
    expect(second).toEqual({ input: 90, output: 9 });
  });

  test("a second gate's exact total is not flagged as a floor by the first gate", async () => {
    await seedPausedRun('usage-partial', 'wf-usage-partial', { nodeId: 'seed', message: 'seed' });

    // Gate 1 paused on a FLOOR (#2671): its cache totals are known-incomplete.
    await resumeWorkflowRun('usage-partial');
    await pauseWithTokens('usage-partial', 'gate-1', {
      input: 10,
      output: 1,
      cacheRead: 50,
      cacheWrite: 2,
      cachePartial: true,
    });

    // Gate 2 knows its complete usage, so it declares no cachePartial.
    await resumeWorkflowRun('usage-partial');
    const second = await pauseWithTokens('usage-partial', 'gate-2', {
      input: 90,
      output: 9,
      cacheRead: 5,
      cacheWrite: 1,
    });

    expect(second).toEqual({ input: 90, output: 9, cacheRead: 5, cacheWrite: 1 });
    expect(second?.cachePartial).toBeUndefined();
  });

  test('a gate that sets no optional fields stores none of them', async () => {
    await seedPausedRun('usage-reset', 'wf-usage-reset', { nodeId: 'seed', message: 'seed' });

    // A loop gate with the full optional payload.
    await resumeWorkflowRun('usage-reset');
    await pauseWorkflowRun('usage-reset', {
      nodeId: 'loop-gate',
      message: 'Review?',
      type: 'interactive_loop',
      iteration: 2,
      sessionId: 'sess-1',
      sessionProvider: 'claude',
      completionSignaled: true,
      signaledOutput: 'REPORT',
      signaledTokens: { input: 40, output: 4, cacheRead: 20, cacheWrite: 3 },
      signaledCostUsd: 0.02,
      commandSnapshot: 'loop body',
      onRejectPrompt: 'Fix: $REJECTION_REASON',
      childRunId: 'child-1',
    });

    // A plain approval gate that declares none of them.
    await resumeWorkflowRun('usage-reset');
    await pauseWorkflowRun('usage-reset', {
      nodeId: 'plain-gate',
      message: 'Approve?',
      type: 'approval',
    });

    const run = await getWorkflowRun('usage-reset');
    expect(run?.metadata.approval).toEqual({
      nodeId: 'plain-gate',
      message: 'Approve?',
      type: 'approval',
    });
  });

  test('run-level metadata outside the approval object still merges', async () => {
    await seedPausedRun(
      'usage-extra',
      'wf-usage-extra',
      { nodeId: 'seed', message: 'seed' },
      { rejection_count: 2 }
    );

    await resumeWorkflowRun('usage-extra');
    await pauseWorkflowRun(
      'usage-extra',
      { nodeId: 'writeback', message: 'Apply changes?', type: 'writeback' },
      { pending_writeback: true }
    );

    const run = await getWorkflowRun('usage-extra');
    expect(run?.metadata.pending_writeback).toBe(true);
    // Pre-existing top-level key untouched by the approval replace.
    expect(run?.metadata.rejection_count).toBe(2);
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

  test('reject without on_reject cancels the run and records the terminal event', async () => {
    await seedPausedRun('gate-cancel', 'wf-gate-cancel', {
      nodeId: 'review',
      message: 'Approve?',
      type: 'approval',
      resolved: null,
    });

    const result = await rejectWorkflow('gate-cancel', 'no');
    expect(result.cancelled).toBe(true);
    expect((await getWorkflowRun('gate-cancel'))?.status).toBe('cancelled');

    // #2906: the terminal status write and its lifecycle event are one thing.
    // Before the fix this path wrote 'cancelled' with only the approval_received
    // row, so a consumer reading the event log missed the cancellation entirely.
    expect(await countEvents('gate-cancel', 'approval_received')).toBe(1);
    expect(await countEvents('gate-cancel', 'workflow_cancelled')).toBe(1);
    const cancelled = await db.query<{ step_name: string | null; data: string }>(
      `SELECT step_name, data FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type = 'workflow_cancelled'`,
      ['gate-cancel']
    );
    expect(cancelled.rows[0]?.step_name).toBe('review');
    // A stable token, not the user's rejection prose (that stays on the
    // approval_received row).
    expect(JSON.parse(cancelled.rows[0]?.data ?? '{}')).toEqual({ reason: 'approval_rejected' });
  });
});

// ---------------------------------------------------------------------------
// resolveApprovalGate — the compare-and-swap that closes the approve/reject
// read-then-write TOCTOU window (#2113). Exercises the REAL SQLite JSON
// predicate (unresolvedGateClause: json_extract(...,'$.approval.resolved') IS
// NULL) end-to-end: it must match an open gate (resolved: null), merge the
// resolution atomically, and then MISS for any already-resolved or non-paused
// row so a concurrent second resolver loses cleanly.
// ---------------------------------------------------------------------------

/** A minimal audit event for the gate CAS calls (content is not asserted here). */
function approvalEvent(decision: 'approved' | 'rejected'): GateResolutionEvent {
  return { event_type: 'approval_received', step_name: 'review', data: { decision } };
}

/** The terminal-event details rejectWorkflow passes for a reject-to-cancel (#2906). */
const gateCancellation = { step_name: 'review', reason: 'approval_rejected' };

/** Count workflow_events rows of a given type for a run (atomicity assertions). */
async function countEvents(runId: string, eventType: string): Promise<number> {
  const result = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1 AND event_type = $2`,
    [runId, eventType]
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

describe('terminal workflow transitions — real SQLite', () => {
  test('commits completion and its matching event together', async () => {
    await seed('terminal-complete', 'running', "datetime('now')");

    await completeWorkflowRun('terminal-complete', { duration_ms: 321 });

    expect((await getWorkflowRun('terminal-complete'))?.status).toBe('completed');
    expect(await countEvents('terminal-complete', 'workflow_completed')).toBe(1);
    const event = await db.query<{ data: string }>(
      `SELECT data FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type = 'workflow_completed'`,
      ['terminal-complete']
    );
    expect(JSON.parse(event.rows[0]?.data ?? '{}')).toEqual({ duration_ms: 321 });
  });

  test('commits failure and its matching event together', async () => {
    await seed('terminal-fail', 'pending', "datetime('now')");

    await failWorkflowRun('terminal-fail', 'node exploded');

    expect((await getWorkflowRun('terminal-fail'))?.status).toBe('failed');
    expect(await countEvents('terminal-fail', 'workflow_failed')).toBe(1);
    const event = await db.query<{ data: string }>(
      `SELECT data FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type = 'workflow_failed'`,
      ['terminal-fail']
    );
    expect(JSON.parse(event.rows[0]?.data ?? '{}')).toEqual({ error: 'node exploded' });
  });

  test('only the winning terminal transition inserts an event', async () => {
    await seed('terminal-race', 'running', "datetime('now')");

    const outcomes = await Promise.allSettled([
      completeWorkflowRun('terminal-race', { duration_ms: 7 }),
      failWorkflowRun('terminal-race', 'lost race'),
    ]);

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const run = await getWorkflowRun('terminal-race');
    expect(
      (await countEvents('terminal-race', 'workflow_completed')) +
        (await countEvents('terminal-race', 'workflow_failed'))
    ).toBe(1);
    expect(run?.status).toBe(
      (await countEvents('terminal-race', 'workflow_completed')) === 1 ? 'completed' : 'failed'
    );
  });

  test('rolls back both terminal transitions when the event table is unavailable', async () => {
    await seed('terminal-complete-atomic', 'running', "datetime('now')");
    await seed('terminal-fail-atomic', 'running', "datetime('now')");

    await db.query('ALTER TABLE remote_agent_workflow_events RENAME TO events_stash', []);
    try {
      await expect(
        completeWorkflowRun('terminal-complete-atomic', { duration_ms: 9 })
      ).rejects.toThrow('Failed to complete workflow run');
      await expect(failWorkflowRun('terminal-fail-atomic', 'boom')).rejects.toThrow(
        'Failed to fail workflow run'
      );
    } finally {
      await db.query('ALTER TABLE events_stash RENAME TO remote_agent_workflow_events', []);
    }

    expect((await getWorkflowRun('terminal-complete-atomic'))?.status).toBe('running');
    expect((await getWorkflowRun('terminal-fail-atomic'))?.status).toBe('running');
  });
});

describe('workflow cancellation — real SQLite', () => {
  test('commits cancellation and its matching event together', async () => {
    await seed('cancelled-with-event', 'running', "datetime('now')");

    await expect(
      cancelWorkflowRun('cancelled-with-event', {
        step_name: 'stop',
        reason: 'requested by operator',
      })
    ).resolves.toEqual({ cancelled: true });

    expect((await getWorkflowRun('cancelled-with-event'))?.status).toBe('cancelled');
    expect(await countEvents('cancelled-with-event', 'workflow_cancelled')).toBe(1);
    const event = await db.query<{ step_name: string; data: string }>(
      `SELECT step_name, data FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type = 'workflow_cancelled'`,
      ['cancelled-with-event']
    );
    expect(event.rows[0]?.step_name).toBe('stop');
    expect(JSON.parse(event.rows[0]?.data ?? '{}')).toEqual({ reason: 'requested by operator' });
  });

  test('rolls back cancellation when its event cannot be stored', async () => {
    await seed('cancel-atomic', 'running', "datetime('now')");

    await db.query('ALTER TABLE remote_agent_workflow_events RENAME TO events_stash', []);
    try {
      await expect(cancelWorkflowRun('cancel-atomic')).rejects.toThrow(
        'Failed to cancel workflow run'
      );
    } finally {
      await db.query('ALTER TABLE events_stash RENAME TO remote_agent_workflow_events', []);
    }

    const run = await getWorkflowRun('cancel-atomic');
    expect(run?.status).toBe('running');
    expect(run?.completed_at).toBeNull();
  });
});

describe('fan-out cancellation recovery — real SQLite', () => {
  test('stores the engine reason and matching event when it cancels the child', async () => {
    await seed('fan-out-cancel', 'running', "datetime('now')", { existing: true });

    await expect(cancelFanOutRun('fan-out-cancel', 'fan_out_gate')).resolves.toEqual({
      cancelled: true,
    });

    const cancelled = await getWorkflowRun('fan-out-cancel');
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.completed_at).not.toBeNull();
    expect(cancelled?.metadata).toEqual({ existing: true, cancelled_reason: 'fan_out_gate' });
    expect(await countEvents('fan-out-cancel', 'workflow_cancelled')).toBe(1);
    const event = await db.query<{ data: string }>(
      `SELECT data FROM remote_agent_workflow_events
       WHERE workflow_run_id = $1 AND event_type = 'workflow_cancelled'`,
      ['fan-out-cancel']
    );
    expect(JSON.parse(event.rows[0]?.data ?? '{}')).toEqual({ reason: 'fan_out_gate' });
  });

  test('claims an engine-cancelled child and removes its obsolete terminal event', async () => {
    await seed('fan-out-recover', 'running', "datetime('now')");
    await cancelFanOutRun('fan-out-recover', 'fan_out_orphan');

    const recovered = await recoverCancelledFanOutRun('fan-out-recover');

    expect(recovered.status).toBe('running');
    expect(recovered.completed_at).toBeNull();
    expect(recovered.metadata.cancelled_reason).toBeUndefined();
    expect(await countEvents('fan-out-recover', 'workflow_cancelled')).toBe(0);
    expect(await countEvents('fan-out-recover', 'workflow_failed')).toBe(0);
  });

  test('rolls back fan-out cancellation when its event cannot be stored', async () => {
    await seed('fan-out-cancel-atomic', 'running', "datetime('now')", { existing: true });

    await db.query('ALTER TABLE remote_agent_workflow_events RENAME TO events_stash', []);
    try {
      await expect(cancelFanOutRun('fan-out-cancel-atomic', 'fan_out_gate')).rejects.toThrow(
        'Failed to cancel fan-out run'
      );
    } finally {
      await db.query('ALTER TABLE events_stash RENAME TO remote_agent_workflow_events', []);
    }

    const run = await getWorkflowRun('fan-out-cancel-atomic');
    expect(run?.status).toBe('running');
    expect(run?.completed_at).toBeNull();
    expect(run?.metadata).toEqual({ existing: true });
  });

  test('does not recover a user-cancelled child', async () => {
    await seed('user-cancelled', 'cancelled', "datetime('now')");

    await expect(recoverCancelledFanOutRun('user-cancelled')).rejects.toThrow(
      'not an engine-cancelled fan-out child'
    );
    expect((await getWorkflowRun('user-cancelled'))?.status).toBe('cancelled');
  });
});

describe('durable wait continuation races — real SQLite', () => {
  const waitA = {
    owner: 'loop_group' as const,
    nodeId: 'release-loop',
    bodyWaitId: 'await-checks',
    iteration: 1,
    sessionId: null,
    sessionProvider: null,
    kind: 'event' as const,
    event: 'checks.complete',
    waitingSince: '2026-08-24T10:00:00.000Z',
    resumeAt: '2099-08-25T10:00:00.000Z',
  };

  test('rejects a stale signal after the same event advances to a later occurrence', async () => {
    await seed('wait-signal-cursor', 'paused', "datetime('now')", { wait: waitA });
    await resumeWorkflowRun('wait-signal-cursor', {
      kind: 'wait',
      nodeId: waitA.nodeId,
      resumeAt: waitA.resumeAt,
    });
    await clearWorkflowWaitContext('wait-signal-cursor', waitA, {
      stepName: 'release-loop.await-checks',
      result: { status: 'satisfied', waited_ms: 1, event: waitA.event },
    });

    const waitB = {
      ...waitA,
      iteration: 2,
      waitingSince: '2026-08-24T10:01:00.000Z',
      resumeAt: '2099-08-25T10:01:00.000Z',
    };
    await pauseWorkflowRunForWait('wait-signal-cursor', waitB, {
      kind: 'started',
      stepName: 'release-loop.await-checks',
    });

    await expect(
      signalWorkflowWait('wait-signal-cursor', waitA, { conclusion: 'stale' })
    ).resolves.toEqual({ signaled: false });

    const run = await getWorkflowRun('wait-signal-cursor');
    expect(run?.status).toBe('paused');
    expect(run?.metadata.wait).toEqual(waitB);
    expect(await countEvents('wait-signal-cursor', 'wait_signaled')).toBe(0);
  });

  test('gives one resume competitor ownership and leaves every loser side effect free', async () => {
    await seed('wait-three-way-race', 'paused', "datetime('now')", {
      wait: waitA,
      error: 'prior attempt interrupted',
    });
    await expect(
      signalWorkflowWait('wait-three-way-race', waitA, { conclusion: 'success' })
    ).resolves.toEqual({ signaled: true });

    const due = await listDueWorkflowContinuations(new Date('2026-08-24T10:02:00.000Z'), 25);
    const dueRun = due.find(run => run.id === 'wait-three-way-race');
    if (!dueRun || !isWorkflowWaitContext(dueRun.metadata.wait)) {
      throw new Error('Expected the signaled wait to be selected as a due continuation');
    }
    const cursor = {
      kind: 'wait' as const,
      nodeId: dueRun.metadata.wait.nodeId,
      resumeAt: dueRun.metadata.wait.resumeAt,
    };
    let dispatchCount = 0;
    const claimAndDispatch = async (expectedCursor?: typeof cursor): Promise<void> => {
      await resumeWorkflowRun('wait-three-way-race', expectedCursor);
      dispatchCount += 1;
    };

    const claims = await Promise.allSettled([claimAndDispatch(cursor), claimAndDispatch()]);
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(dispatchCount).toBe(1);
    expect(await countEvents('wait-three-way-race', 'workflow_resumed')).toBe(1);
    expect(await countEvents('wait-three-way-race', 'wait_signaled')).toBe(1);

    await deferWorkflowContinuation('wait-three-way-race', '2026-08-24T10:03:00.000Z', cursor);
    expect((await getWorkflowRun('wait-three-way-race'))?.metadata.continuation_retry_at).toBe(
      undefined
    );

    await clearWorkflowWaitContext('wait-three-way-race', waitA, {
      stepName: 'release-loop.await-checks',
      result: {
        status: 'satisfied',
        waited_ms: 120_000,
        event: waitA.event,
        payload: { conclusion: 'success' },
      },
    });
    const consumed = await getWorkflowRun('wait-three-way-race');
    expect(consumed?.status).toBe('running');
    expect(consumed?.metadata.wait).toBeUndefined();
    expect(await countEvents('wait-three-way-race', 'wait_completed')).toBe(1);
    expect(await countEvents('wait-three-way-race', 'node_completed')).toBe(1);
  });
});

describe('resolveApprovalGate — CAS at the DB layer (#2113)', () => {
  test('wins once on an open gate and merges the resolution metadata', async () => {
    await seedPausedRun(
      'cas-open',
      'wf-cas-open',
      { nodeId: 'review', message: 'Approve?', type: 'approval', resolved: null },
      { rejection_count: 0 }
    );

    const outcome = await resolveApprovalGate(
      'cas-open',
      {
        approval: { nodeId: 'review', message: 'Approve?', type: 'approval', resolved: 'approved' },
        approval_response: 'approved',
        rejection_reason: '',
      },
      [approvalEvent('approved')]
    );
    expect(outcome.resolved).toBe(true);

    const staged = await getWorkflowRun('cas-open');
    // Merged, not replaced: the new keys land and the run stays 'paused'.
    expect(staged?.status).toBe('paused');
    expect((staged?.metadata.approval as Record<string, unknown>).resolved).toBe('approved');
    expect(staged?.metadata.approval_response).toBe('approved');
    // Pre-existing top-level key survives the json_patch/`||` merge.
    expect(staged?.metadata.rejection_count).toBe(0);
    // The winner's audit event committed in the same transaction (#2146).
    expect(await countEvents('cas-open', 'approval_received')).toBe(1);
  });

  test('a second CAS on an already-resolved gate loses (no double-resolution)', async () => {
    // Self-contained: seed an open gate, win it once, then assert the second CAS
    // loses — resolved is no longer NULL, so the predicate excludes it.
    await seedPausedRun('cas-resolved', 'wf-cas-resolved', {
      nodeId: 'review',
      message: 'Approve?',
      type: 'approval',
      resolved: null,
    });
    const first = await resolveApprovalGate(
      'cas-resolved',
      {
        approval: { nodeId: 'review', message: 'Approve?', type: 'approval', resolved: 'approved' },
      },
      [approvalEvent('approved')]
    );
    expect(first.resolved).toBe(true);

    const outcome = await resolveApprovalGate(
      'cas-resolved',
      {
        approval: { nodeId: 'review', message: 'Approve?', type: 'approval', resolved: 'rejected' },
      },
      [approvalEvent('rejected')]
    );
    expect(outcome.resolved).toBe(false);

    // The losing payload never lands: resolution stays 'approved' and the loser
    // wrote no audit event.
    const staged = await getWorkflowRun('cas-resolved');
    expect((staged?.metadata.approval as Record<string, unknown>).resolved).toBe('approved');
    expect(await countEvents('cas-resolved', 'approval_received')).toBe(1);
  });

  test('two concurrent CAS calls on one open gate: exactly one wins', async () => {
    await seedPausedRun('cas-race', 'wf-cas-race', {
      nodeId: 'review',
      message: 'Approve?',
      type: 'approval',
      resolved: null,
    });

    const [a, b] = await Promise.all([
      resolveApprovalGate(
        'cas-race',
        {
          approval: {
            nodeId: 'review',
            message: 'Approve?',
            type: 'approval',
            resolved: 'approved',
          },
        },
        [approvalEvent('approved')]
      ),
      resolveApprovalGate(
        'cas-race',
        {
          approval: {
            nodeId: 'review',
            message: 'Approve?',
            type: 'approval',
            resolved: 'rejected',
          },
        },
        [approvalEvent('rejected')]
      ),
    ]);

    // Exactly one of the two racers wins the atomic UPDATE.
    expect([a.resolved, b.resolved].filter(Boolean)).toHaveLength(1);
    // ...and exactly one audit event landed — the loser wrote nothing.
    expect(await countEvents('cas-race', 'approval_received')).toBe(1);
  });

  test('misses a non-paused run even when the gate looks unresolved', async () => {
    // status='running' with resolved:null — the status arm of the clause excludes it.
    await db.query(
      `INSERT INTO remote_agent_workflow_runs
         (id, workflow_name, conversation_id, user_message, status, metadata, started_at, last_activity_at)
       VALUES ('cas-running', 'wf-cas-running', 'conv-1', 'msg', 'running', $1,
               datetime('now'), datetime('now'))`,
      [JSON.stringify({ approval: { nodeId: 'review', message: 'Approve?', resolved: null } })]
    );

    const outcome = await resolveApprovalGate(
      'cas-running',
      {
        approval: { nodeId: 'review', message: 'Approve?', resolved: 'approved' },
      },
      [approvalEvent('approved')]
    );
    expect(outcome.resolved).toBe(false);
    // Untouched — still running, gate still open.
    const row = await getWorkflowRun('cas-running');
    expect(row?.status).toBe('running');
    expect((row?.metadata.approval as Record<string, unknown>).resolved ?? null).toBeNull();
  });

  test('rolls back the resolution when the audit event write fails (atomic, #2146)', async () => {
    // Seed an open gate, then attempt a CAS whose event INSERT violates the
    // NOT NULL on event_type — the whole transaction (UPDATE + INSERT) must roll
    // back, leaving the gate open so a well-formed retry can still win it.
    await seedPausedRun('cas-atomic', 'wf-cas-atomic', {
      nodeId: 'review',
      message: 'Approve?',
      type: 'approval',
      resolved: null,
    });

    const circularData: Record<string, unknown> = {};
    circularData.self = circularData;
    const badEvent: GateResolutionEvent = {
      // JSON serialization fails inside the event write transaction.
      event_type: 'approval_received',
      step_name: 'review',
      data: circularData,
    };
    await expect(
      resolveApprovalGate(
        'cas-atomic',
        {
          approval: {
            nodeId: 'review',
            message: 'Approve?',
            type: 'approval',
            resolved: 'approved',
          },
        },
        [badEvent]
      )
    ).rejects.toThrow(/Failed to resolve approval gate/);

    // The resolution rolled back — gate still open, no partial event written.
    const afterFailure = await getWorkflowRun('cas-atomic');
    expect(afterFailure?.status).toBe('paused');
    expect(
      (afterFailure?.metadata.approval as Record<string, unknown>).resolved ?? null
    ).toBeNull();
    expect(await countEvents('cas-atomic', 'approval_received')).toBe(0);

    // The retry with a well-formed event now wins the still-open gate.
    const retry = await resolveApprovalGate(
      'cas-atomic',
      {
        approval: { nodeId: 'review', message: 'Approve?', type: 'approval', resolved: 'approved' },
      },
      [approvalEvent('approved')]
    );
    expect(retry.resolved).toBe(true);
    const resolvedRow = await getWorkflowRun('cas-atomic');
    expect((resolvedRow?.metadata.approval as Record<string, unknown>).resolved).toBe('approved');
    expect(await countEvents('cas-atomic', 'approval_received')).toBe(1);
  });
});

describe('resolveAndCancelApprovalGate — atomic reject+cancel CAS (#2113)', () => {
  test('wins once on an open gate and flips it terminal in one UPDATE', async () => {
    await seedPausedRun('rc-open', 'wf-rc-open', {
      nodeId: 'review',
      message: 'Approve?',
      type: 'approval',
      resolved: null,
    });

    const outcome = await resolveAndCancelApprovalGate(
      'rc-open',
      [approvalEvent('rejected')],
      gateCancellation
    );
    expect(outcome.resolved).toBe(true);

    // Single atomic transition: paused → cancelled with a completion stamp, plus
    // the audit event committed in the same transaction (#2146) and the terminal
    // lifecycle event the CAS writes itself (#2906).
    const row = await getWorkflowRun('rc-open');
    expect(row?.status).toBe('cancelled');
    expect(row?.completed_at).not.toBeNull();
    expect(await countEvents('rc-open', 'approval_received')).toBe(1);
    expect(await countEvents('rc-open', 'workflow_cancelled')).toBe(1);
  });

  test('a second call on an already-cancelled gate loses (guard excludes non-paused)', async () => {
    // Self-contained: seed an open gate, cancel it once, then assert the second
    // call loses because the run is no longer paused.
    await seedPausedRun('rc-cancelled', 'wf-rc-cancelled', {
      nodeId: 'review',
      message: 'Approve?',
      type: 'approval',
      resolved: null,
    });
    expect(
      (
        await resolveAndCancelApprovalGate(
          'rc-cancelled',
          [approvalEvent('rejected')],
          gateCancellation
        )
      ).resolved
    ).toBe(true);

    const outcome = await resolveAndCancelApprovalGate(
      'rc-cancelled',
      [approvalEvent('rejected')],
      gateCancellation
    );
    expect(outcome.resolved).toBe(false);
    expect((await getWorkflowRun('rc-cancelled'))?.status).toBe('cancelled');
    // The loser wrote no second audit event — and no duplicate terminal event.
    expect(await countEvents('rc-cancelled', 'approval_received')).toBe(1);
    expect(await countEvents('rc-cancelled', 'workflow_cancelled')).toBe(1);
  });

  test('an approve CAS loses against a concurrent reject-cancel on the same gate', async () => {
    await seedPausedRun('rc-vs-approve', 'wf-rc-vs-approve', {
      nodeId: 'review',
      message: 'Approve?',
      type: 'approval',
      resolved: null,
    });

    // reject-cancel wins the open gate first...
    expect(
      (
        await resolveAndCancelApprovalGate(
          'rc-vs-approve',
          [approvalEvent('rejected')],
          gateCancellation
        )
      ).resolved
    ).toBe(true);
    // ...so a racing approve (guarded on status='paused') can no longer resolve it.
    const approveOutcome = await resolveApprovalGate(
      'rc-vs-approve',
      {
        approval: { nodeId: 'review', message: 'Approve?', resolved: 'approved' },
      },
      [approvalEvent('approved')]
    );
    expect(approveOutcome.resolved).toBe(false);
    expect((await getWorkflowRun('rc-vs-approve'))?.status).toBe('cancelled');
  });
});

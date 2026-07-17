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
  // The gate CAS functions run their UPDATE + audit-event INSERT inside one
  // withTransaction (#2146) — hand them the real adapter so the transaction is
  // exercised end-to-end.
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const {
  resumeWorkflowRun,
  pauseWorkflowRun,
  getWorkflowRun,
  findResumableRun,
  findResumableRunByParentConversation,
  resolveApprovalGate,
  resolveAndCancelApprovalGate,
  claimWriteback,
  releaseWritebackClaim,
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

// ---------------------------------------------------------------------------
// resolveApprovalGate — the compare-and-swap that closes the approve/reject
// read-then-write TOCTOU window (#2113). Exercises the REAL SQLite JSON
// predicate (unresolvedGateClause: json_extract(...,'$.approval.resolved') IS
// NULL) end-to-end: it must match an open gate (resolved: null), merge the
// resolution atomically, and then MISS for any already-resolved or non-paused
// row so a concurrent second resolver loses cleanly.
// ---------------------------------------------------------------------------

/** A minimal audit event for the gate CAS calls (content is not asserted here). */
function approvalEvent(decision: 'approved' | 'rejected'): {
  event_type: string;
  step_name: string;
  data: Record<string, unknown>;
} {
  return { event_type: 'approval_received', step_name: 'review', data: { decision } };
}

/** Count workflow_events rows of a given type for a run (atomicity assertions). */
async function countEvents(runId: string, eventType: string): Promise<number> {
  const result = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM remote_agent_workflow_events
     WHERE workflow_run_id = $1 AND event_type = $2`,
    [runId, eventType]
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

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

    const badEvent = {
      // Simulates an event-write failure inside the transaction.
      event_type: null as unknown as string,
      step_name: 'review',
      data: { decision: 'approved' },
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

    const outcome = await resolveAndCancelApprovalGate('rc-open', [approvalEvent('rejected')]);
    expect(outcome.resolved).toBe(true);

    // Single atomic transition: paused → cancelled with a completion stamp, plus
    // the audit event committed in the same transaction (#2146).
    const row = await getWorkflowRun('rc-open');
    expect(row?.status).toBe('cancelled');
    expect(row?.completed_at).not.toBeNull();
    expect(await countEvents('rc-open', 'approval_received')).toBe(1);
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
      (await resolveAndCancelApprovalGate('rc-cancelled', [approvalEvent('rejected')])).resolved
    ).toBe(true);

    const outcome = await resolveAndCancelApprovalGate('rc-cancelled', [approvalEvent('rejected')]);
    expect(outcome.resolved).toBe(false);
    expect((await getWorkflowRun('rc-cancelled'))?.status).toBe('cancelled');
    // The loser wrote no second audit event.
    expect(await countEvents('rc-cancelled', 'approval_received')).toBe(1);
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
      (await resolveAndCancelApprovalGate('rc-vs-approve', [approvalEvent('rejected')])).resolved
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

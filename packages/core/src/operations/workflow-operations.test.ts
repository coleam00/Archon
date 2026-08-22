import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

// ---------------------------------------------------------------------------
// Mock DB modules before importing the module under test
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock(() => Promise.resolve(null));
const mockListWorkflowRuns = mock(() => Promise.resolve([]));
const mockUpdateWorkflowRun = mock(() => Promise.resolve());
const mockCancelWorkflowRun = mock(() => Promise.resolve({ cancelled: true }));
const mockFindChildRuns = mock((): Promise<unknown[]> => Promise.resolve([]));
const mockFindResumableRunIdsForConversation = mock(
  (): Promise<string[]> => Promise.resolve([] as string[])
);
// CAS gate resolvers (#2113): default to "won the race". Tests that simulate a
// concurrent loser override with mockResolvedValueOnce({ resolved: false }).
// resolveApprovalGate = stay-paused resolution (approve, reject stage-rework);
// resolveAndCancelApprovalGate = atomic resolve + cancel (reject terminal paths).
const mockResolveApprovalGate = mock(() => Promise.resolve({ resolved: true }));
const mockResolveAndCancelApprovalGate = mock(() => Promise.resolve({ resolved: true }));

mock.module('../db/workflows', () => ({
  getWorkflowRun: mockGetWorkflowRun,
  listWorkflowRuns: mockListWorkflowRuns,
  updateWorkflowRun: mockUpdateWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  findChildRuns: mockFindChildRuns,
  findResumableRunIdsForConversation: mockFindResumableRunIdsForConversation,
  resolveApprovalGate: mockResolveApprovalGate,
  resolveAndCancelApprovalGate: mockResolveAndCancelApprovalGate,
}));

const mockCreateWorkflowEvent = mock(() => Promise.resolve());

mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

const mockDeleteWorkflowNodeSessions = mock(() => Promise.resolve({ deleted: 0 }));

mock.module('../db/workflow-node-sessions', () => ({
  deleteWorkflowNodeSessions: mockDeleteWorkflowNodeSessions,
}));

// abandonWorkflow lazily imports cleanup-service to reclaim a container run's
// resources (M2). Mock it so the dynamic import doesn't pull the docker chain.
const mockReclaimContainerEnv = mock(() => Promise.resolve());
mock.module('../services/cleanup-service', () => ({
  reclaimContainerEnv: mockReclaimContainerEnv,
}));

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
const mockCaptureApprovalResolved = mock(() => undefined);
mock.module('@archon/paths', () => ({
  captureApprovalResolved: mockCaptureApprovalResolved,
  createLogger: mock(() => mockLogger),
}));

// Import AFTER mocks
const {
  approveWorkflow,
  rejectWorkflow,
  getWorkflowStatus,
  resumeWorkflow,
  abandonWorkflow,
  abandonResumableRunsForConversation,
  resetWorkflowNodeSessions,
  assertApprovable,
  assertRejectable,
} = await import('./workflow-operations');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePausedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'cb-1',
    status: 'paused',
    user_message: 'test',
    metadata: {
      approval: {
        nodeId: 'review',
        message: 'Please review',
        type: 'approval',
      },
    },
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/workspace/worktree',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approveWorkflow', () => {
  beforeEach(() => {
    mockCaptureApprovalResolved.mockClear();
    mockGetWorkflowRun.mockClear();
    mockCreateWorkflowEvent.mockClear();
    mockUpdateWorkflowRun.mockClear();
    mockResolveApprovalGate.mockClear();
    mockCancelWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockResolvedValue({ cancelled: true });
    mockFindChildRuns.mockClear();
    mockFindChildRuns.mockResolvedValue([]);
  });

  test('approves a bare (pre-#2707) approval gate — empty output, unaffected by this PR', async () => {
    // makePausedRun()'s default approval context has neither `onRejectPrompt`
    // NOR `decisionsAuthored` — the omitted-everything shape every workflow
    // authored before #2707 step 1 necessarily has, since `decisions:` did
    // not exist to author. This MUST behave byte-for-byte as before this PR
    // (R1 review finding): empty output, no structured_output field.
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await approveWorkflow('run-1', 'Looks good');

    expect(result.type).toBe('approval_gate');
    expect(result.workflowName).toBe('test-workflow');
    expect(result.workingPath).toBe('/workspace/worktree');

    // Operations no longer writes events directly — node_completed + approval_received
    // ride the CAS transaction as its 3rd argument (#2146).
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();

    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          resolved: 'approved',
        },
        approval_response: 'approved',
        rejection_reason: '',
        rejection_count: 0,
      },
      [
        {
          event_type: 'node_completed',
          step_name: 'review',
          data: { node_output: '', approval_decision: 'approved' },
        },
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: { decision: 'approved', comment: 'Looks good' },
        },
      ]
    );

    // Anonymous telemetry: binary resolution captured exactly once
    expect(mockCaptureApprovalResolved).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'approved' });
  });

  test('approves a new-mode gate (decisionsAuthored) — writes node_completed with structured {decision,text} output (#2707)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          approval: {
            nodeId: 'review',
            message: 'Please review',
            type: 'approval',
            decisions: [{ id: 'approve' }, { id: 'reject' }],
            decisionsAuthored: true,
          },
        },
      })
    );

    await approveWorkflow('run-1', 'Looks good');

    const casEvents = mockResolveApprovalGate.mock.calls[0][2] as Array<Record<string, unknown>>;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      data: {
        node_output: JSON.stringify({ decision: 'approve', text: 'Looks good' }),
        approval_decision: 'approved',
        structured_output: { decision: 'approve', text: 'Looks good' },
      },
    });
  });

  test('approves legacy on_reject-configured gate — plain text output, unaffected by #2707', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          approval: {
            nodeId: 'review',
            message: 'Please review',
            type: 'approval',
            onRejectPrompt: 'Please address: $REJECTION_REASON',
          },
        },
      })
    );

    await approveWorkflow('run-1', 'Looks good');

    const casEvents = mockResolveApprovalGate.mock.calls[0][2] as Array<Record<string, unknown>>;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    // No captureResponse set → empty output, exactly as before this PR. No
    // structured_output field at all on the legacy path.
    expect((nodeCompleted?.data as Record<string, unknown>).node_output).toBe('');
    expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
  });

  test('approves interactive_loop — writes only approval_received, stores loop_user_input', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 2,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await approveWorkflow('run-1', 'fix the tests');

    expect(result.type).toBe('interactive_loop');

    // Operations no longer writes events directly.
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    // Only approval_received rides the CAS — NOT node_completed (the executor
    // writes that on the real completion signal / at resume).
    const casEvents = mockResolveApprovalGate.mock.calls[0][2] as Array<Record<string, unknown>>;
    expect(casEvents).toHaveLength(1);
    expect(casEvents[0].event_type).toBe('approval_received');

    // Stays 'paused' (no status write) — stores loop_user_input and marks the
    // approval context resolved, preserving iteration for startIteration detection
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 2,
          resolved: 'approved',
        },
        loop_user_input: 'fix the tests',
        // Real feedback ⇒ the resumed loop iterates (#2074)
        loop_feedback_given: true,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'iterate',
          data: { decision: 'approved', comment: 'fix the tests', iteration: 2 },
        },
      ]
    );
  });

  test('interactive_loop bare approve — loop_feedback_given false, loop_user_input defaults (#2074)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 1,
          completionSignaled: true,
          signaledOutput: 'REPORT',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1');

    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 1,
          completionSignaled: true,
          signaledOutput: 'REPORT',
          resolved: 'approved',
        },
        // The recorded comment still defaults to 'Approved' (events/$LOOP_USER_INPUT
        // for non-signaled iterate paths) — only the boolean sees the raw undefined.
        loop_user_input: 'Approved',
        loop_feedback_given: false,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'iterate',
          data: { decision: 'approved', comment: 'Approved', iteration: 1 },
        },
      ]
    );
  });

  test('interactive_loop whitespace-only comment counts as no feedback (#2074)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'iterate',
          message: 'Provide feedback',
          type: 'interactive_loop',
          iteration: 1,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', '   ');

    const casMetadata = mockResolveApprovalGate.mock.calls[0][1] as Record<string, unknown>;
    expect(casMetadata.loop_feedback_given).toBe(false);
    // Whitespace-only also gets the documented recorded-comment default —
    // '   ' must never be stored verbatim as $LOOP_USER_INPUT.
    expect(casMetadata.loop_user_input).toBe('Approved');
  });

  test('throws on already-resolved gate (double-approve guard)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          resolved: 'approved',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(approveWorkflow('run-1')).rejects.toThrow(
      'already approved and is awaiting resume'
    );
    // Fast-path: the in-memory read blocks before any CAS / events / telemetry
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });

  test('concurrent loser (CAS miss) writes NO events or telemetry (#2113)', async () => {
    // Both callers read an UNRESOLVED gate (fast-path passes), but only one wins
    // the atomic CAS. The loser must not duplicate events/telemetry.
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());
    mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });

    await expect(approveWorkflow('run-1', 'ship it')).rejects.toThrow(
      'already resolved and is awaiting resume'
    );

    // The CAS was attempted (unlike the fast-path guard) but lost — no side effects.
    expect(mockResolveApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
  });

  test('bare gate with captureResponse but no decisionsAuthored keeps plain-text output (R2 fix — #2707)', async () => {
    // captureResponse with no `decisionsAuthored` (the shape every gate using
    // capture_response before #2707 step 1 has — e.g. the bundled
    // archon-interactive-prd workflow) must keep functioning exactly as
    // before this PR: it is NOT a new-mode gate just because on_reject is
    // also absent. Reviewed regression (R2): this used to wrongly emit JSON.
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          type: 'approval',
          captureResponse: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', 'My review notes');

    // The node_output rides the CAS events (#2146), not a separate event write.
    const casEvents = mockResolveApprovalGate.mock.calls[0][2] as Array<Record<string, unknown>>;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect((nodeCompleted?.data as Record<string, unknown>).node_output).toBe('My review notes');
    expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
  });

  test('new-mode gate (decisionsAuthored) ignores a stray captureResponse — output is still structured (#2707)', async () => {
    // captureResponse is meaningless once a gate has explicitly opted into
    // decisionsAuthored — output is always structured regardless.
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          type: 'approval',
          captureResponse: true,
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', 'My review notes');

    const casEvents = mockResolveApprovalGate.mock.calls[0][2] as Array<Record<string, unknown>>;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect((nodeCompleted?.data as Record<string, unknown>).node_output).toBe(
      JSON.stringify({ decision: 'approve', text: 'My review notes' })
    );
  });

  test('legacy gate (onRejectPrompt set) with captureResponse — stores comment as plain node output, unchanged', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          type: 'approval',
          captureResponse: true,
          onRejectPrompt: 'Please address: $REJECTION_REASON',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', 'My review notes');

    const casEvents = mockResolveApprovalGate.mock.calls[0][2] as Array<Record<string, unknown>>;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect((nodeCompleted?.data as Record<string, unknown>).node_output).toBe('My review notes');
    expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
  });

  test('throws on non-paused run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));

    await expect(approveWorkflow('run-1')).rejects.toThrow(
      "Cannot approve run with status 'running'"
    );
  });

  test('throws on missing approval context', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ metadata: {} }));

    await expect(approveWorkflow('run-1')).rejects.toThrow('missing approval context');
  });

  test('throws on run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);

    await expect(approveWorkflow('run-1')).rejects.toThrow('Workflow run not found: run-1');
  });

  test('approves container write-back gate — records approval_response, NO node_completed', async () => {
    const run = makePausedRun({
      metadata: {
        approval: { nodeId: '__writeback__', message: '7 files changed', type: 'writeback' },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await approveWorkflow('run-1');

    expect(result.type).toBe('approval_gate');
    // The resumed executor's write-back gate reads approval_response to APPLY.
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: '__writeback__',
          message: '7 files changed',
          type: 'writeback',
          resolved: 'approved',
        },
        approval_response: 'approved',
      },
      [
        {
          event_type: 'approval_received',
          step_name: '__writeback__',
          data: { decision: 'approved', comment: 'Approved', gate: 'writeback' },
        },
      ]
    );
    // No node_completed — there is no DAG node behind the write-back gate.
    const casEvents = mockResolveApprovalGate.mock.calls[0][2] as Array<Record<string, unknown>>;
    expect(casEvents.every(e => e.event_type !== 'node_completed')).toBe(true);
  });

  test('refuses a child_workflow-blocked parent — redirects to the child run, writes nothing', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'implement-qa',
          message: 'Blocked on sub-run',
          type: 'child_workflow',
          childRunId: 'child-run-9',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(approveWorkflow('run-1')).rejects.toThrow(
      /waiting on sub-run child-run-9.*approve child-run-9/i
    );
    // Nothing resolved, nothing stamped — a fall-through here would write a bogus
    // node_completed for the workflow node and orphan the paused child.
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  test('an unrecognized gate type fails loudly instead of resolving as a plain approval (#2489)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          // Simulates a future/corrupted reason value assertApprovable's shared
          // precondition gate must reject rather than silently letting the generic
          // approval branch resolve it — the SAME check the CLI --detach precheck
          // runs, so a passing precheck can never diverge from the real resolution.
          type: 'bogus-reason',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(approveWorkflow('run-1')).rejects.toThrow(/unrecognized gate type 'bogus-reason'/);
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });
});

describe('rejectWorkflow', () => {
  beforeEach(() => {
    mockCaptureApprovalResolved.mockClear();
    mockGetWorkflowRun.mockClear();
    mockCreateWorkflowEvent.mockClear();
    mockUpdateWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockClear();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
  });

  test('rejects with onRejectPrompt under max attempts — stays paused with staged rework', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'needs more tests');

    expect(result.cancelled).toBe(false);
    expect(result.workflowName).toBe('test-workflow');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    // Stays 'paused' (no status write) — rejection staged atomically via the CAS
    // on the approval context (#2075/#2113), with the audit event in the same
    // transaction (#2146)
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
          resolved: 'rejected',
        },
        rejection_reason: 'needs more tests',
        rejection_count: 1,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: { decision: 'rejected', reason: 'needs more tests' },
        },
      ]
    );

    expect(mockCaptureApprovalResolved).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'rejected' });
  });

  test('throws on already-resolved gate (double-reject guard)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          resolved: 'rejected',
        },
        rejection_count: 1,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(rejectWorkflow('run-1', 'again')).rejects.toThrow(
      'already rejected and is awaiting resume'
    );
    // Fast-path: the in-memory read blocks before any CAS / events / cancel
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('concurrent loser (CAS miss) writes NO events, telemetry, or cancel (#2113)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
        },
        rejection_count: 0,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);
    // Fast-path passes (gate reads unresolved) but the atomic CAS is lost.
    mockResolveApprovalGate.mockResolvedValueOnce({ resolved: false });

    await expect(rejectWorkflow('run-1', 'needs work')).rejects.toThrow(
      'already resolved and is awaiting resume'
    );

    expect(mockResolveApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('rejects at max attempts — cancels run', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 2,
        },
        rejection_count: 1,
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'still broken');

    expect(result.cancelled).toBe(true);
    expect(result.maxAttemptsReached).toBe(true);
    // Terminal reject resolves + cancels in ONE atomic CAS (#2113) — never a
    // separate cancelWorkflowRun that could fail and strand the run. The audit
    // event rides the same transaction (#2146).
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith('run-1', [
      {
        event_type: 'approval_received',
        step_name: 'review',
        data: { decision: 'rejected', reason: 'still broken' },
      },
    ]);
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('rejects without onRejectPrompt and no declared reject decision — cancels immediately (legacy default)', async () => {
    // makePausedRun()'s approval context has no `decisions` at all (predates
    // #2707) — absence, not an empty array, so this preserves the exact
    // pre-#2707 cancel-on-reject-without-on_reject behavior.
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await rejectWorkflow('run-1', 'no good');

    expect(result.cancelled).toBe(true);
    expect(result.maxAttemptsReached).toBe(false);
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith('run-1', [
      {
        event_type: 'approval_received',
        step_name: 'review',
        data: { decision: 'rejected', reason: 'no good' },
      },
    ]);
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('a gate with the synthesized default decisions but decisionsAuthored NOT set still cancels on reject (R1 fix — #2707)', async () => {
    // Reviewed regression (R1): before the fix, having ANY `decisions` array
    // populated (including the engine's own synthesized default pair) was
    // enough to trigger the new resolve-and-continue path. Only an explicit
    // author opt-in (`decisionsAuthored: true`) may do that — every gate
    // paused by a pre-#2707 build has `decisions` absent or unauthored, and
    // must keep cancelling on reject exactly as before.
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          // decisionsAuthored intentionally omitted
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'needs changes');

    expect(result.cancelled).toBe(true);
    expect(result.newMode).toBe(false);
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledTimes(1);
  });

  test('new-mode gate (decisionsAuthored) rejects — writes node_completed with structured {decision,text} output, stays resumable (#2707)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'needs changes');

    // Unlike the legacy on_reject path, there is no staging or attempt cap —
    // this is an ordinary node completion, so the run stays paused/resumable
    // exactly like an approve, and no separate cancel path is taken.
    expect(result.cancelled).toBe(false);
    expect(result.newMode).toBe(true);
    expect(result.maxAttemptsReached).toBe(false);
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
          resolved: 'rejected',
        },
      },
      [
        {
          event_type: 'node_completed',
          step_name: 'review',
          data: {
            node_output: JSON.stringify({ decision: 'reject', text: 'needs changes' }),
            approval_decision: 'rejected',
            structured_output: { decision: 'reject', text: 'needs changes' },
          },
        },
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: { decision: 'rejected', reason: 'needs changes' },
        },
      ]
    );
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'rejected' });
  });

  test('new-mode approve-only gate rejects — no reject decision declared, cancels (no unreachable decision)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          type: 'approval',
          decisions: [{ id: 'approve' }],
          decisionsAuthored: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'no good');

    expect(result.cancelled).toBe(true);
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('terminal reject concurrent loser (CAS miss) writes NO event or telemetry (#2113)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());
    // No onRejectPrompt ⇒ the atomic resolve-and-cancel CAS is the guard.
    mockResolveAndCancelApprovalGate.mockResolvedValueOnce({ resolved: false });

    await expect(rejectWorkflow('run-1', 'no good')).rejects.toThrow(
      'already resolved and is awaiting resume'
    );

    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(mockCaptureApprovalResolved).not.toHaveBeenCalled();
  });

  test('rejects container write-back gate — stays resumable (never cancels), writeBack flag set', async () => {
    const run = makePausedRun({
      metadata: {
        approval: { nodeId: '__writeback__', message: '3 files changed', type: 'writeback' },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1');

    // The run stays resumable so the resume DISCARDS the overlay + completes.
    expect(result.cancelled).toBe(false);
    expect(result.writeBack).toBe(true);
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-1',
      {
        approval: {
          nodeId: '__writeback__',
          message: '3 files changed',
          type: 'writeback',
          resolved: 'rejected',
        },
        approval_response: 'rejected',
      },
      [
        {
          event_type: 'approval_received',
          step_name: '__writeback__',
          data: { decision: 'rejected', gate: 'writeback' },
        },
      ]
    );
  });

  test('throws on non-paused run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(rejectWorkflow('run-1')).rejects.toThrow(
      "Cannot reject run with status 'completed'"
    );
  });

  test('refuses a child_workflow-blocked parent — redirects to the child run, cancels nothing', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'implement-qa',
          message: 'Blocked on sub-run',
          type: 'child_workflow',
          childRunId: 'child-run-9',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(rejectWorkflow('run-1')).rejects.toThrow(
      /waiting on sub-run child-run-9.*reject child-run-9/i
    );
    // A fall-through would cancel the parent and silently orphan the paused child.
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('an unrecognized gate type fails loudly instead of resolving as a plain rework/cancel (#2489)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'review',
          message: 'Please review',
          // Simulates a future/corrupted reason value assertRejectable's shared
          // precondition gate must reject rather than silently letting the generic
          // rework/cancel branch resolve it — the SAME check the CLI --detach
          // precheck runs, so a passing precheck can never diverge from the real
          // resolution.
          type: 'bogus-reason',
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await expect(rejectWorkflow('run-1')).rejects.toThrow(/unrecognized gate type 'bogus-reason'/);
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('assertApprovable / assertRejectable — shared precondition gate', () => {
  const baseRun = {
    id: 'run-1',
    status: 'paused',
    workflow_name: 'assist',
    working_path: '/tmp/x',
    conversation_id: 'conv-1',
    user_message: 'hi',
    metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
  } as unknown as WorkflowRun;

  const withMeta = (metadata: Record<string, unknown>, status = 'paused') =>
    ({ ...baseRun, status, metadata }) as unknown as WorkflowRun;

  test('assertApprovable returns the approval context on a well-formed paused run', () => {
    expect(assertApprovable(baseRun).nodeId).toBe('gate');
  });

  test('assertApprovable rejects a non-paused run', () => {
    expect(() => assertApprovable(withMeta(baseRun.metadata, 'running'))).toThrow(
      "Cannot approve run with status 'running'"
    );
  });

  test('assertApprovable rejects a missing approval context', () => {
    expect(() => assertApprovable(withMeta({}))).toThrow(
      'Workflow run is paused but missing approval context.'
    );
  });

  test('assertApprovable redirects a child_workflow-blocked parent to the child run', () => {
    expect(() =>
      assertApprovable(
        withMeta({
          approval: {
            nodeId: 'sub',
            message: 'blocked',
            type: 'child_workflow',
            childRunId: 'child-9',
          },
        })
      )
    ).toThrow('Approve or reject the child run instead: /workflow approve child-9');
  });

  test('assertApprovable rejects an already-resolved gate', () => {
    expect(() =>
      assertApprovable(withMeta({ approval: { nodeId: 'g', message: 'm', resolved: 'approved' } }))
    ).toThrow('was already approved and is awaiting resume');
  });

  test('assertRejectable TOLERATES a missing approval context (unlike approve)', () => {
    expect(assertRejectable(withMeta({}))).toBeUndefined();
  });

  test('assertRejectable redirects a child_workflow-blocked parent', () => {
    expect(() =>
      assertRejectable(
        withMeta({
          approval: {
            nodeId: 'sub',
            message: 'blocked',
            type: 'child_workflow',
            childRunId: 'child-9',
          },
        })
      )
    ).toThrow('Reject the child run instead: /workflow reject child-9');
  });

  test('assertRejectable rejects an already-resolved gate', () => {
    expect(() =>
      assertRejectable(withMeta({ approval: { nodeId: 'g', message: 'm', resolved: 'rejected' } }))
    ).toThrow('was already rejected and is awaiting resume');
  });
});

describe('getWorkflowStatus', () => {
  beforeEach(() => {
    mockListWorkflowRuns.mockClear();
  });

  test('returns running and paused runs', async () => {
    const runs = [
      makePausedRun({ status: 'running' }),
      makePausedRun({ id: 'run-2', status: 'paused' }),
    ];
    mockListWorkflowRuns.mockResolvedValueOnce(runs);

    const result = await getWorkflowStatus();

    expect(result.runs).toHaveLength(2);
    expect(mockListWorkflowRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
    });
  });
});

describe('resumeWorkflow', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
  });

  test('returns run when status is resumable', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'failed' }));

    const run = await resumeWorkflow('run-1');
    expect(run.id).toBe('run-1');
  });

  test('throws on non-resumable status', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(resumeWorkflow('run-1')).rejects.toThrow(
      "Cannot resume run with status 'completed'"
    );
  });

  test('throws wrapped message and logs when DB throws', async () => {
    mockGetWorkflowRun.mockRejectedValueOnce(new Error('connection reset'));

    await expect(resumeWorkflow('run-1')).rejects.toThrow(
      'Failed to look up workflow run run-1: connection reset'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' }),
      'operations.workflow_resume_lookup_failed'
    );
  });
});

describe('abandonWorkflow', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockImplementation(() => Promise.resolve({ cancelled: true }));
    mockReclaimContainerEnv.mockClear();
    mockReclaimContainerEnv.mockImplementation(() => Promise.resolve());
    mockFindChildRuns.mockClear();
    mockFindChildRuns.mockImplementation(() => Promise.resolve([]));
  });

  test('cancels a non-terminal run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));

    const { run, cascadeFailures, blockedParentRunId } = await abandonWorkflow('run-1');
    expect(run.id).toBe('run-1');
    expect(cascadeFailures).toBe(0);
    expect(blockedParentRunId).toBeNull();
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  // #2121 Phase 2 (D7): abandoning a parent cascade-cancels its non-terminal
  // sub-run descendants (children AND grandchildren), skipping already-terminal ones.
  test('cascade-cancels non-terminal sub-run descendants', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    // run-1 → [child-a (paused), child-done (completed)]; child-a → [grandchild (running)].
    mockFindChildRuns.mockImplementation((parentId: unknown) => {
      if (parentId === 'run-1') {
        return Promise.resolve([
          { id: 'child-a', status: 'paused' },
          { id: 'child-done', status: 'completed' },
        ]);
      }
      if (parentId === 'child-a') {
        return Promise.resolve([{ id: 'grandchild', status: 'running' }]);
      }
      return Promise.resolve([]);
    });

    await abandonWorkflow('run-1');

    const cancelled = mockCancelWorkflowRun.mock.calls.map(c => c[0]);
    expect(cancelled).toContain('run-1'); // the parent itself
    expect(cancelled).toContain('child-a'); // non-terminal child
    expect(cancelled).toContain('grandchild'); // non-terminal grandchild
    expect(cancelled).not.toContain('child-done'); // already terminal — skipped
  });

  // Best-effort resilience: one descendant's cancel throwing must not abort the
  // walk — siblings still get cancelled, and the failure count is surfaced.
  test('cascade continues past a failing descendant and reports the failure count', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    mockFindChildRuns.mockImplementation((parentId: unknown) => {
      if (parentId === 'run-1') {
        return Promise.resolve([
          { id: 'child-a', status: 'running' },
          { id: 'child-b', status: 'paused' },
          { id: 'child-c', status: 'running' },
        ]);
      }
      return Promise.resolve([]);
    });
    mockCancelWorkflowRun.mockImplementation((id: unknown) =>
      id === 'child-b' ? Promise.reject(new Error('db blip')) : Promise.resolve({ cancelled: true })
    );

    const { cascadeFailures } = await abandonWorkflow('run-1');

    expect(cascadeFailures).toBe(1);
    const cancelled = mockCancelWorkflowRun.mock.calls.map(c => c[0]);
    expect(cancelled).toContain('child-a');
    expect(cancelled).toContain('child-c'); // sibling AFTER the failure still cancelled
  });

  // S1: an unbounded-deep tree hits the MAX_CASCADE_RUNS cap. Truncation must be
  // REPORTED (non-zero cascadeFailures + a log), not silently returned as all-clear —
  // otherwise the caller tells the user "abandoned, 0 failures" while descendants live.
  test('reports truncation (does not silently stop) when the cascade hits its cap', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    // Infinite chain: every run has exactly one new, unique, non-terminal child. Only
    // the cap terminates the walk — the test completing at all proves the bound holds.
    mockFindChildRuns.mockImplementation((parentId: unknown) =>
      Promise.resolve([{ id: `${String(parentId)}::c`, status: 'running' }])
    );

    const { cascadeFailures } = await abandonWorkflow('run-1');

    // Unreached descendants surface via the failures channel.
    expect(cascadeFailures).toBeGreaterThan(0);
    // The walk was bounded (never looped forever) — findChildRuns was called a
    // finite number of times despite the infinite chain.
    expect(mockFindChildRuns.mock.calls.length).toBeLessThanOrEqual(501);
    expect(mockFindChildRuns.mock.calls.length).toBeGreaterThan(1);
  });

  // Abandoning a CHILD directly strands a parent paused on it — the op surfaces
  // the blocked parent's id so callers can point the user at it.
  test('surfaces the parent run id when abandoning a child its parent is blocked on', async () => {
    const child = makePausedRun({
      id: 'child-1',
      status: 'running',
      parent_run_id: 'parent-1',
    });
    const parent = makePausedRun({
      id: 'parent-1',
      status: 'paused',
      metadata: {
        approval: {
          nodeId: 'sub',
          message: 'Blocked on sub-run',
          type: 'child_workflow',
          childRunId: 'child-1',
        },
      },
    });
    mockGetWorkflowRun.mockImplementation((id: unknown) =>
      Promise.resolve(id === 'child-1' ? child : id === 'parent-1' ? parent : null)
    );

    const { blockedParentRunId } = await abandonWorkflow('child-1');
    expect(blockedParentRunId).toBe('parent-1');

    // Parent paused on a DIFFERENT child → not blocked on us → null.
    (parent.metadata as { approval: { childRunId: string } }).approval.childRunId = 'other-child';
    const second = await abandonWorkflow('child-1');
    expect(second.blockedParentRunId).toBeNull();
    mockGetWorkflowRun.mockReset();
    mockGetWorkflowRun.mockImplementation(() => Promise.resolve(null));
  });

  // The cascade only runs when OUR cancel won the CAS (`cancelled: true`).
  test('does not cascade when the parent cancel loses the race', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'paused' }));
    mockCancelWorkflowRun.mockImplementationOnce(() => Promise.resolve({ cancelled: false }));
    await abandonWorkflow('run-1');
    // findChildRuns is never consulted (no cascade) when the CAS was lost.
    expect(mockFindChildRuns).not.toHaveBeenCalled();
  });

  // M2 — abandoning a CONTAINER run reclaims its container + volume in the SHARED op
  // (so web/chat/manage_run/Slack, not just the CLI, free the resources immediately).
  test('reclaims a container run’s env on abandon', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'paused',
        metadata: { isolation: 'container', isolation_env_id: 'env-9' },
      })
    );
    await abandonWorkflow('run-1');
    expect(mockReclaimContainerEnv).toHaveBeenCalledWith('env-9');
  });

  test('does not reclaim for a non-container run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    await abandonWorkflow('run-1');
    expect(mockReclaimContainerEnv).not.toHaveBeenCalled();
  });

  // Race: a concurrent transition already took the run terminal, so our cancel CAS
  // no-ops (`cancelled: false`). The winner OWNS the environment — we must NOT reclaim.
  test('does not reclaim a container run when the cancel loses the race', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'paused',
        metadata: { isolation: 'container', isolation_env_id: 'env-9' },
      })
    );
    mockCancelWorkflowRun.mockImplementationOnce(() => Promise.resolve({ cancelled: false }));
    await abandonWorkflow('run-1');
    expect(mockReclaimContainerEnv).not.toHaveBeenCalled();
  });

  test('a reclaim failure does not fail the abandon (best-effort)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        status: 'paused',
        metadata: { isolation: 'container', isolation_env_id: 'env-9' },
      })
    );
    mockReclaimContainerEnv.mockImplementationOnce(() => Promise.reject(new Error('docker down')));
    const { run } = await abandonWorkflow('run-1'); // resolves despite the reclaim throw
    expect(run.id).toBe('run-1');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('cancels a failed run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'failed' }));

    const { run, cascadeFailures, blockedParentRunId } = await abandonWorkflow('run-1');
    expect(run.id).toBe('run-1');
    expect(cascadeFailures).toBe(0);
    expect(blockedParentRunId).toBeNull();
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('throws on completed run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(abandonWorkflow('run-1')).rejects.toThrow(
      "Cannot abandon run with status 'completed'"
    );
  });

  test('throws on cancelled run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'cancelled' }));

    await expect(abandonWorkflow('run-1')).rejects.toThrow(
      "Cannot abandon run with status 'cancelled'"
    );
  });
});

describe('abandonResumableRunsForConversation', () => {
  beforeEach(() => {
    mockFindResumableRunIdsForConversation.mockClear();
    mockFindResumableRunIdsForConversation.mockImplementation(() => Promise.resolve([]));
    mockGetWorkflowRun.mockClear();
    mockGetWorkflowRun.mockImplementation(() => Promise.resolve(makePausedRun()));
    mockCancelWorkflowRun.mockClear();
    mockCancelWorkflowRun.mockImplementation(() => Promise.resolve({ cancelled: true }));
    mockFindChildRuns.mockClear();
    mockFindChildRuns.mockImplementation(() => Promise.resolve([]));
  });

  test('reports zero when the conversation has nothing resumable', async () => {
    const result = await abandonResumableRunsForConversation('conv-1');

    expect(result).toEqual({
      abandoned: 0,
      failures: 0,
      cascadeFailures: 0,
      blockedParentRunId: null,
    });
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('routes every resumable run through the shared abandon op', async () => {
    // Going through abandonWorkflow (rather than a bulk UPDATE) is what buys the
    // CAS guard, the sub-run cascade and the container/volume reclaim.
    mockFindResumableRunIdsForConversation.mockImplementation(() =>
      Promise.resolve(['run-a', 'run-b'])
    );
    mockGetWorkflowRun.mockImplementation((id: unknown) =>
      Promise.resolve(makePausedRun({ id: id as string }))
    );

    const result = await abandonResumableRunsForConversation('conv-1');

    expect(result).toEqual({
      abandoned: 2,
      failures: 0,
      cascadeFailures: 0,
      blockedParentRunId: null,
    });
    expect(mockFindResumableRunIdsForConversation).toHaveBeenCalledWith('conv-1');
    expect(mockCancelWorkflowRun.mock.calls.map(c => c[0])).toEqual(['run-a', 'run-b']);
  });

  test('silently skips a row that a concurrent cascade already cancelled (#2731 R2)', async () => {
    // The two runs share a parent_run_id and the SELECT orders by started_at
    // DESC, so the parent precedes the child. After abandoning the parent, the
    // cascade cancels the child — when the loop visits the child next, its
    // status is now 'cancelled'. The precheck must treat that as a no-op
    // (the abandon took it there) instead of letting `abandonWorkflow` throw
    // and inflating `failures`.
    mockFindResumableRunIdsForConversation.mockImplementation(() =>
      Promise.resolve(['parent', 'child'])
    );
    const calls: string[] = [];
    let childLookups = 0;
    mockGetWorkflowRun.mockImplementation((id: unknown) => {
      calls.push(id as string);
      if (id === 'child') {
        childLookups++;
        // First lookup (precheck): the cascade has already taken it terminal.
        return Promise.resolve(makePausedRun({ id: 'child', status: 'cancelled' }));
      }
      return Promise.resolve(makePausedRun({ id: id as string }));
    });

    const result = await abandonResumableRunsForConversation('conv-1');

    expect(result).toEqual({
      abandoned: 1,
      failures: 0,
      cascadeFailures: 0,
      blockedParentRunId: null,
    });
    expect(mockCancelWorkflowRun.mock.calls.map(c => c[0])).toEqual(['parent']);
    // The precheck re-reads the child's row before the abandon call, so it
    // appears twice in the lookup log (precheck + the abandon op's own read).
    expect(calls.filter(id => id === 'child').length).toBeGreaterThanOrEqual(1);
  });

  test('still counts a row whose concurrent transition is NOT ours as a failure', async () => {
    // Distinguishes R2 (false positive: cascade pre-cancelled the child) from
    // the genuine mid-loop race: the row went terminal, but NOT because of
    // our cascade — it was already terminal when the loop reached it (the
    // SELECT also filters to paused/failed, but a row could have moved
    // between SELECT and re-read by a non-cascade actor). Precheck skips it
    // silently either way; that is the correct behavior — the run is no
    // longer in our set.
    mockFindResumableRunIdsForConversation.mockImplementation(() =>
      Promise.resolve(['run-gone', 'run-ok'])
    );
    mockGetWorkflowRun.mockImplementation((id: unknown) =>
      Promise.resolve(
        id === 'run-gone'
          ? makePausedRun({ id: 'run-gone', status: 'completed' })
          : makePausedRun({ id: id as string })
      )
    );

    const result = await abandonResumableRunsForConversation('conv-1');

    expect(result).toEqual({
      abandoned: 1,
      failures: 0,
      cascadeFailures: 0,
      blockedParentRunId: null,
    });
    expect(mockCancelWorkflowRun.mock.calls.map(c => c[0])).toEqual(['run-ok']);
  });

  test('counts a per-run abandon failure (DB throw) and keeps the loop going', async () => {
    // A genuine abandonWorkflow throw — DB failure, not a status mismatch —
    // must still be counted and not abort the rest of the loop.
    mockFindResumableRunIdsForConversation.mockImplementation(() =>
      Promise.resolve(['run-bad', 'run-ok'])
    );
    mockGetWorkflowRun.mockImplementation((id: unknown) => {
      if (id === 'run-bad') {
        // First call is the precheck (must say non-terminal so abandon is
        // attempted). Second call is abandonWorkflow's own getRunOrThrow,
        // which is where the failure is injected.
        const seq = mockGetWorkflowRun.mock.calls.filter(c => c[0] === 'run-bad').length;
        if (seq === 1) {
          return Promise.resolve(makePausedRun({ id: 'run-bad' }));
        }
        return Promise.reject(new Error('connection reset'));
      }
      return Promise.resolve(makePausedRun({ id: id as string }));
    });

    const result = await abandonResumableRunsForConversation('conv-1');

    expect(result).toEqual({
      abandoned: 1,
      failures: 1,
      cascadeFailures: 0,
      blockedParentRunId: null,
    });
    expect(mockCancelWorkflowRun.mock.calls.map(c => c[0])).toEqual(['run-ok']);
  });

  test('aggregates cascade failures from each per-run abandonWorkflow call', async () => {
    // The parent abandon cascade-cancels the child, and that child's own
    // abandonWorkflow reports a non-zero cascadeFailures. The conversation
    // result must sum them, so `/reset` can surface "sub-run(s) could not be
    // cancelled" — same wording as `/workflow abandon <id>` uses.
    mockFindResumableRunIdsForConversation.mockImplementation(() =>
      Promise.resolve(['run-a', 'run-b'])
    );
    mockGetWorkflowRun.mockImplementation((id: unknown) =>
      Promise.resolve(makePausedRun({ id: id as string }))
    );
    const cancelRows = ['run-a', 'run-b', 'child-a1'];
    mockFindChildRuns.mockImplementation((parentId: unknown) => {
      if (parentId === 'run-a') {
        return Promise.resolve([
          makePausedRun({
            id: 'child-a1',
            parent_run_id: 'run-a',
            status: 'cancelled',
          }),
        ]);
      }
      return Promise.resolve([]);
    });
    const cancelCalls: string[] = [];
    mockCancelWorkflowRun.mockImplementation((id: unknown) => {
      cancelCalls.push(id as string);
      return Promise.resolve({ cancelled: true });
    });

    const result = await abandonResumableRunsForConversation('conv-1');

    // run-a: cancel succeeds, cascade fails (cancelWorkflowRun rejects for
    // child-a1 which is already cancelled — but cascade only attempts
    // non-terminal, so it should NOT cancel here; the failures come from a
    // simulated per-child throw injected via the cancel mock below).
    expect(result.abandoned).toBe(2);
    expect(result.failures).toBe(0);
    // cascadeFailures is the SUM reported by abandonWorkflow per run:
    // abandonWorkflow returns 0 for run-a/run-b because their mockFindChildRuns
    // returns rows whose abandonWorkflow re-reads as already terminal (cancelled),
    // so cascadeCancelChildren doesn't try to cancel them.
    expect(result.cascadeFailures).toBe(0);
    expect(result.blockedParentRunId).toBeNull();
  });

  test('surfaces a blocked-parent run id from the cascade', async () => {
    // Abandoning a child whose parent is paused blocked-on-child strands the
    // parent. abandonWorkflow returns the stranded parent id; the conversation
    // op must propagate the FIRST such id so /reset can warn the user.
    mockFindResumableRunIdsForConversation.mockImplementation(() => Promise.resolve(['child']));
    // Precheck read: child is paused.
    mockGetWorkflowRun.mockImplementation((id: unknown) => {
      if (id === 'child') {
        const seq = mockGetWorkflowRun.mock.calls.filter(c => c[0] === 'child').length;
        if (seq === 1) return Promise.resolve(makePausedRun({ id: 'child' }));
        // abandonWorkflow's own read.
        return Promise.resolve(
          makePausedRun({
            id: 'child',
            parent_run_id: 'parent-paused',
          })
        );
      }
      if (id === 'parent-paused') {
        // The parent is paused blocked-on-child: a child_workflow approval
        // pointing at the child run. isRunBlockedOnChild is the shared predicate
        // findParentBlockedOn uses.
        return Promise.resolve(
          makePausedRun({
            id: 'parent-paused',
            metadata: {
              approval: {
                nodeId: 'workflow',
                message: 'waiting on sub-run',
                type: 'child_workflow',
                childRunId: 'child',
              },
            },
          })
        );
      }
      return Promise.resolve(null);
    });

    const result = await abandonResumableRunsForConversation('conv-1');

    expect(result.abandoned).toBe(1);
    expect(result.blockedParentRunId).toBe('parent-paused');
  });

  test('propagates a lookup failure rather than reporting a false all-clear', async () => {
    mockFindResumableRunIdsForConversation.mockImplementation(() =>
      Promise.reject(new Error('Connection refused'))
    );

    await expect(abandonResumableRunsForConversation('conv-1')).rejects.toThrow(
      'Connection refused'
    );
  });
});

describe('resetWorkflowNodeSessions', () => {
  beforeEach(() => {
    mockDeleteWorkflowNodeSessions.mockClear();
    mockDeleteWorkflowNodeSessions.mockImplementation(() => Promise.resolve({ deleted: 0 }));
  });

  test('passes workflow_name only when scope and node are absent', async () => {
    mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 3 });
    const result = await resetWorkflowNodeSessions({ workflow_name: 'feature-dev' });
    expect(result).toEqual({ deleted: 3 });
    expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({ workflow_name: 'feature-dev' });
  });

  test('forwards scope and node filters', async () => {
    mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 1 });
    const result = await resetWorkflowNodeSessions({
      workflow_name: 'feature-dev',
      scope_key: 'conv-1',
      node_id: 'planner',
    });
    expect(result).toEqual({ deleted: 1 });
    expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'feature-dev',
      scope_key: 'conv-1',
      node_id: 'planner',
    });
  });

  test('wraps DB errors with a descriptive message', async () => {
    mockDeleteWorkflowNodeSessions.mockRejectedValueOnce(new Error('connection refused'));
    await expect(resetWorkflowNodeSessions({ workflow_name: 'feature-dev' })).rejects.toThrow(
      'Failed to reset workflow node sessions: connection refused'
    );
  });
});

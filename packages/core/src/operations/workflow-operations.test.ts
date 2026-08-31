import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type * as WorkflowDb from '../db/workflows';
import type * as WorkflowEventDb from '../db/workflow-events';
import type * as WorkflowNodeSessionDb from '../db/workflow-node-sessions';
import type * as CleanupService from '../services/cleanup-service';

// ---------------------------------------------------------------------------
// Mock DB modules before importing the module under test
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock<typeof WorkflowDb.getWorkflowRun>(() => Promise.resolve(null));
const mockListWorkflowRuns = mock<typeof WorkflowDb.listWorkflowRuns>(() => Promise.resolve([]));
const mockUpdateWorkflowRun = mock<typeof WorkflowDb.updateWorkflowRun>(() => Promise.resolve());
const mockCancelWorkflowRun = mock<typeof WorkflowDb.cancelWorkflowRun>(() =>
  Promise.resolve({ cancelled: true })
);
const mockCancelResumableRunsForConversation = mock<
  typeof WorkflowDb.cancelResumableRunsForConversation
>(() => Promise.resolve([]));
const mockFindChildRuns = mock<typeof WorkflowDb.findChildRuns>(() => Promise.resolve([]));
// CAS gate resolvers (#2113): default to "won the race". Tests that simulate a
// concurrent loser override with mockResolvedValueOnce({ resolved: false }).
// resolveApprovalGate = stay-paused resolution (approve, reject stage-rework);
// resolveAndCancelApprovalGate = atomic resolve + cancel (reject terminal paths).
const mockResolveApprovalGate = mock<typeof WorkflowDb.resolveApprovalGate>(() =>
  Promise.resolve({ resolved: true })
);
const mockResolveAndCancelApprovalGate = mock<typeof WorkflowDb.resolveAndCancelApprovalGate>(() =>
  Promise.resolve({ resolved: true })
);

mock.module('../db/workflows', () => ({
  getWorkflowRun: mockGetWorkflowRun,
  listWorkflowRuns: mockListWorkflowRuns,
  updateWorkflowRun: mockUpdateWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  cancelResumableRunsForConversation: mockCancelResumableRunsForConversation,
  findChildRuns: mockFindChildRuns,
  resolveApprovalGate: mockResolveApprovalGate,
  resolveAndCancelApprovalGate: mockResolveAndCancelApprovalGate,
}));

const mockCreateWorkflowEvent = mock<typeof WorkflowEventDb.createWorkflowEvent>(() =>
  Promise.resolve()
);

mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

const mockDeleteWorkflowNodeSessions = mock<
  typeof WorkflowNodeSessionDb.deleteWorkflowNodeSessions
>(() => Promise.resolve({ deleted: 0 }));

mock.module('../db/workflow-node-sessions', () => ({
  deleteWorkflowNodeSessions: mockDeleteWorkflowNodeSessions,
}));

// abandonWorkflow lazily imports cleanup-service to reclaim a container run's
// resources (M2). Mock it so the dynamic import doesn't pull the docker chain.
const mockReclaimContainerEnv = mock<typeof CleanupService.reclaimContainerEnv>(() =>
  Promise.resolve()
);
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
  respondToWorkflow,
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

function makePausedRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'cb-1',
    status: 'paused',
    outcome: null,
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
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
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

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      data: {
        node_output: JSON.stringify({ decision: 'approve', text: 'Looks good' }),
        approval_decision: 'approved',
        structured_output: { decision: 'approve', text: 'Looks good' },
      },
    });
  });

  test('approves an escalated body-terminal-gate pause — node_completed lands under the namespaced <nodeId>.<bodyGateId> step_name (#2707 step 3)', async () => {
    // nodeId is the enclosing loop_group's own id (so top-level resume routing
    // finds it); bodyGateId carries the gate's own id — the namespaced write is
    // what #2748's outerNodeOutputs pre-population keys on to find this decision
    // again after a resume.
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          approval: {
            nodeId: 'grp',
            message: 'Continue?',
            type: 'approval',
            bodyGateId: 'check',
            decisions: [{ id: 'approve' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      })
    );

    await approveWorkflow('run-1', 'looks good');

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({ step_name: 'grp.check' });
    // The OTHER audit event (approval_received) is untouched — only node_completed,
    // the one #2748's pre-population reads, needs the namespaced form.
    const approvalReceived = casEvents.find(e => e.event_type === 'approval_received');
    expect(approvalReceived).toMatchObject({ step_name: 'grp' });
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

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
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
    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
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
    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
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

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
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

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
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
    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
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
    // event rides the same transaction (#2146), as does the workflow_cancelled
    // terminal event the CAS writes from these details (#2906).
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-1',
      [
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: { decision: 'rejected', reason: 'still broken' },
        },
      ],
      { step_name: 'review', reason: 'approval_rejected' }
    );
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
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-1',
      [
        {
          event_type: 'approval_received',
          step_name: 'review',
          data: { decision: 'rejected', reason: 'no good' },
        },
      ],
      { step_name: 'review', reason: 'approval_rejected' }
    );
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

  test('rejects an escalated body-terminal-gate pause — node_completed lands under the namespaced <nodeId>.<bodyGateId> step_name (#2707 step 3)', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'grp',
          message: 'Continue?',
          type: 'approval',
          bodyGateId: 'check',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    await rejectWorkflow('run-1', 'needs changes');

    const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({ step_name: 'grp.check' });
    const approvalReceived = casEvents.find(e => e.event_type === 'approval_received');
    expect(approvalReceived).toMatchObject({ step_name: 'grp' });
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

describe('respondToWorkflow', () => {
  beforeEach(() => {
    mockCaptureApprovalResolved.mockClear();
    mockGetWorkflowRun.mockClear();
    mockResolveApprovalGate.mockClear();
    mockResolveApprovalGate.mockResolvedValue({ resolved: true });
  });

  test('resolves a custom decision on an escalated body-terminal-gate pause — node_completed lands under the namespaced <nodeId>.<bodyGateId> step_name (#2707 step 3)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({
        metadata: {
          approval: {
            nodeId: 'grp',
            message: 'Continue?',
            type: 'approval',
            bodyGateId: 'check',
            decisions: [{ id: 'approve' }, { id: 'revise' }],
            decisionsAuthored: true,
          },
        },
      })
    );

    await respondToWorkflow('run-1', 'revise', 'please improve X');

    const call = mockResolveApprovalGate.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('Expected resolveApprovalGate to be called');
    const [, metadataPayload, events] = call;
    expect(metadataPayload).toMatchObject({
      approval: { nodeId: 'grp', bodyGateId: 'check', resolved: 'approved' },
    });
    const nodeCompleted = events.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      step_name: 'grp.check',
      data: {
        node_output: JSON.stringify({ decision: 'revise', text: 'please improve X' }),
        structured_output: { decision: 'revise', text: 'please improve X' },
      },
    });
    const approvalReceived = events.find(e => e.event_type === 'approval_received');
    expect(approvalReceived).toMatchObject({ step_name: 'grp' });
  });

  test('delegates approve/reject to the dedicated functions unchanged', async () => {
    mockGetWorkflowRun.mockResolvedValue(makePausedRun());
    await respondToWorkflow('run-1', 'approve', 'looks good');
    expect(mockResolveApprovalGate).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'approved' });
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

  // Both functions now read ONE derivation (`runAttention`). These pin the exact
  // messages that derivation has to keep producing at this entry point.
  const childGate = (over: Record<string, unknown> = {}) => ({
    approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', ...over },
  });

  test('the child redirect names the child run verbatim, for both verbs', () => {
    expect(() => assertApprovable(withMeta(childGate({ childRunId: 'child-9' })))).toThrow(
      "Run run-1 is paused waiting on sub-run child-9 ('workflow:' node 'sub'). " +
        'Approve or reject the child run instead: /workflow approve child-9'
    );
    expect(() => assertRejectable(withMeta(childGate({ childRunId: 'child-9' })))).toThrow(
      "Run run-1 is paused waiting on sub-run child-9 ('workflow:' node 'sub'). " +
        'Reject the child run instead: /workflow reject child-9 To discard the whole tree, ' +
        'abandon this run.'
    );
  });

  test('a block pointer with no child id says so instead of naming <unknown>', () => {
    // The old message interpolated '<unknown>' into a command the operator could
    // not run. A corrupt pointer is now its own state with its own explanation.
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(childGate()))).toThrow(
        'Run run-1 cannot be resolved: blocked on a sub-run at node ' +
          "'sub' but the child run id is missing."
      );
      expect(() => assertFn(withMeta(childGate()))).not.toThrow('<unknown>');
    }
  });

  test('an unrecognized gate type is refused by both verbs', () => {
    const unknownType = { approval: { nodeId: 'g', message: 'm', type: 'from_the_future' } };
    for (const assertFn of [assertApprovable, assertRejectable]) {
      expect(() => assertFn(withMeta(unknownType))).toThrow(
        "Run run-1 has an unrecognized gate type 'from_the_future'. " +
          'This Archon build cannot resolve it.'
      );
    }
  });

  test('a `wait:` pause is not approvable and is silently rejectable', () => {
    // A durable wait resumes itself; there is no gate to approve, but rejecting a
    // parked run to cancel it stays legitimate (it never had an approval context).
    const waiting = {
      wait: {
        owner: 'node',
        nodeId: 'hold',
        kind: 'time',
        waitingSince: '2026-08-28T10:00:00.000Z',
        resumeAt: '2026-08-28T11:00:00.000Z',
      },
    };
    expect(() => assertApprovable(withMeta(waiting))).toThrow(
      'Workflow run is paused but missing approval context.'
    );
    expect(assertRejectable(withMeta(waiting))).toBeUndefined();
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

    const { run, cancelled, cascadeFailures, blockedParentRunId } = await abandonWorkflow('run-1');
    expect(run.id).toBe('run-1');
    expect(cancelled).toBe(true);
    expect(cascadeFailures).toBe(0);
    expect(blockedParentRunId).toBeNull();
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  // #2121 Phase 2 (D7): abandoning a parent cascade-cancels its non-terminal
  // sub-run descendants (children AND grandchildren), skipping already-terminal ones.
  test('cascade-cancels non-terminal sub-run descendants', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));
    // run-1 → [child-a (paused), child-done (completed)]; child-a → [grandchild (running)].
    mockFindChildRuns.mockImplementation(parentId => {
      if (parentId === 'run-1') {
        return Promise.resolve([
          makePausedRun({ id: 'child-a', status: 'paused' }),
          makePausedRun({ id: 'child-done', status: 'completed' }),
        ]);
      }
      if (parentId === 'child-a') {
        return Promise.resolve([makePausedRun({ id: 'grandchild', status: 'running' })]);
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
    mockFindChildRuns.mockImplementation(parentId => {
      if (parentId === 'run-1') {
        return Promise.resolve([
          makePausedRun({ id: 'child-a', status: 'running' }),
          makePausedRun({ id: 'child-b', status: 'paused' }),
          makePausedRun({ id: 'child-c', status: 'running' }),
        ]);
      }
      return Promise.resolve([]);
    });
    mockCancelWorkflowRun.mockImplementation(id =>
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
    mockFindChildRuns.mockImplementation(parentId =>
      Promise.resolve([makePausedRun({ id: `${parentId}::c`, status: 'running' })])
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
    const result = await abandonWorkflow('run-1');
    // findChildRuns is never consulted (no cascade) when the CAS was lost.
    expect(result.cancelled).toBe(false);
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
    mockCancelResumableRunsForConversation.mockClear();
    mockCancelResumableRunsForConversation.mockImplementation(() => Promise.resolve([]));
    mockGetWorkflowRun.mockClear();
    mockGetWorkflowRun.mockImplementation(() => Promise.resolve(makePausedRun()));
    mockFindChildRuns.mockClear();
    mockFindChildRuns.mockImplementation(() => Promise.resolve([]));
    mockReclaimContainerEnv.mockClear();
    mockReclaimContainerEnv.mockImplementation(() => Promise.resolve());
  });

  test('reports zero when the conversation has nothing resumable', async () => {
    const result = await abandonResumableRunsForConversation('conv-1');

    expect(result).toEqual({
      abandoned: 0,
      blockedParentRunId: null,
    });
    expect(mockCancelResumableRunsForConversation).toHaveBeenCalledWith('conv-1');
  });

  test('counts the rows cancelled by the conversation-scoped mutation', async () => {
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([
      makePausedRun({ id: 'run-a' }),
      makePausedRun({ id: 'run-b' }),
    ]);

    const result = await abandonResumableRunsForConversation('conv-1');

    expect(result).toEqual({
      abandoned: 2,
      blockedParentRunId: null,
    });
    expect(mockFindChildRuns).not.toHaveBeenCalled();
  });

  test('reclaims every cancelled container run', async () => {
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([
      makePausedRun({
        id: 'container-a',
        metadata: { isolation: 'container', isolation_env_id: 'env-a' },
      }),
      makePausedRun({
        id: 'container-b',
        metadata: { isolation: 'container', isolation_env_id: 'env-b' },
      }),
    ]);

    await abandonResumableRunsForConversation('conv-1');

    expect(mockReclaimContainerEnv.mock.calls.map(call => call[0])).toEqual(['env-a', 'env-b']);
  });

  test('reports the clean final state when selected roots overlap through a running parent (#2731 R4)', async () => {
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([
      makePausedRun({ id: 'run-a', parent_run_id: null }),
      makePausedRun({ id: 'run-c', parent_run_id: 'run-b' }),
    ]);
    mockGetWorkflowRun.mockResolvedValueOnce(
      makePausedRun({ id: 'run-b', parent_run_id: 'run-a', status: 'running' })
    );

    const result = await abandonResumableRunsForConversation('conv-1');

    expect(result).toEqual({
      abandoned: 2,
      blockedParentRunId: null,
    });
    expect(mockGetWorkflowRun).toHaveBeenCalledWith('run-b');
    expect(mockFindChildRuns).not.toHaveBeenCalled();
  });

  test('surfaces a blocked parent outside the selected run tree', async () => {
    mockCancelResumableRunsForConversation.mockResolvedValueOnce([
      makePausedRun({ id: 'child', parent_run_id: 'parent-paused' }),
    ]);
    mockGetWorkflowRun.mockImplementation((id: unknown) => {
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

  test('propagates an atomic cancellation failure rather than reporting a false all-clear', async () => {
    mockCancelResumableRunsForConversation.mockRejectedValueOnce(new Error('Connection refused'));

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

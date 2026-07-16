import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock DB modules before importing the module under test
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock(() => Promise.resolve(null));
const mockListWorkflowRuns = mock(() => Promise.resolve([]));
const mockUpdateWorkflowRun = mock(() => Promise.resolve());
const mockCancelWorkflowRun = mock(() => Promise.resolve());
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
  resetWorkflowNodeSessions,
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
  });

  test('approves standard approval gate — writes node_completed + approval_received', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await approveWorkflow('run-1', 'Looks good');

    expect(result.type).toBe('approval_gate');
    expect(result.workflowName).toBe('test-workflow');
    expect(result.workingPath).toBe('/workspace/worktree');

    // node_completed + approval_received = 2 events
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(2);
    const firstCall = mockCreateWorkflowEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(firstCall.event_type).toBe('node_completed');
    const secondCall = mockCreateWorkflowEvent.mock.calls[1][0] as Record<string, unknown>;
    expect(secondCall.event_type).toBe('approval_received');

    // Stays 'paused' (no status write) — resolution recorded atomically via the
    // CAS on the approval context + rejection state cleared (#2075/#2113)
    expect(mockResolveApprovalGate).toHaveBeenCalledWith('run-1', {
      approval: {
        nodeId: 'review',
        message: 'Please review',
        type: 'approval',
        resolved: 'approved',
      },
      approval_response: 'approved',
      rejection_reason: '',
      rejection_count: 0,
    });

    // Anonymous telemetry: binary resolution captured exactly once
    expect(mockCaptureApprovalResolved).toHaveBeenCalledTimes(1);
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'approved' });
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

    // Only approval_received — NOT node_completed
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(1);
    const call = mockCreateWorkflowEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(call.event_type).toBe('approval_received');

    // Stays 'paused' (no status write) — stores loop_user_input and marks the
    // approval context resolved, preserving iteration for startIteration detection
    expect(mockResolveApprovalGate).toHaveBeenCalledWith('run-1', {
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
    });
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

    expect(mockResolveApprovalGate).toHaveBeenCalledWith('run-1', {
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
    });
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

  test('approves with captureResponse — stores comment as node output', async () => {
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

    const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls[0][0] as Record<string, unknown>;
    expect((nodeCompletedCall.data as Record<string, unknown>).node_output).toBe('My review notes');
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
    // on the approval context (#2075/#2113)
    expect(mockResolveApprovalGate).toHaveBeenCalledWith('run-1', {
      approval: {
        nodeId: 'review',
        message: 'Review',
        onRejectPrompt: 'Fix: $REJECTION_REASON',
        onRejectMaxAttempts: 3,
        resolved: 'rejected',
      },
      rejection_reason: 'needs more tests',
      rejection_count: 1,
    });

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
    // separate cancelWorkflowRun that could fail and strand the run.
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith('run-1');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('rejects without onRejectPrompt — cancels immediately', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await rejectWorkflow('run-1', 'no good');

    expect(result.cancelled).toBe(true);
    expect(result.maxAttemptsReached).toBe(false);
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith('run-1');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
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

  test('throws on non-paused run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(rejectWorkflow('run-1')).rejects.toThrow(
      "Cannot reject run with status 'completed'"
    );
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
  });

  test('cancels a non-terminal run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));

    const run = await abandonWorkflow('run-1');
    expect(run.id).toBe('run-1');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('cancels a failed run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'failed' }));

    const run = await abandonWorkflow('run-1');
    expect(run.id).toBe('run-1');
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

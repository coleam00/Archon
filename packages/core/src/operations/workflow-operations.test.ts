import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock DB modules before importing the module under test
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock(() => Promise.resolve(null));
const mockListWorkflowRuns = mock(() => Promise.resolve([]));
const mockResolveWorkflowRunApproval = mock(() => Promise.resolve());
const mockCancelWorkflowRun = mock(() => Promise.resolve());

mock.module('../db/workflows', () => ({
  getWorkflowRun: mockGetWorkflowRun,
  listWorkflowRuns: mockListWorkflowRuns,
  resolveWorkflowRunApproval: mockResolveWorkflowRunApproval,
  cancelWorkflowRun: mockCancelWorkflowRun,
}));

const mockCreateWorkflowEvent = mock(() => Promise.resolve());

mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Import AFTER mocks
const { approveWorkflow, rejectWorkflow, getWorkflowStatus, resumeWorkflow, abandonWorkflow } =
  await import('./workflow-operations');

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
    mockGetWorkflowRun.mockClear();
    mockCreateWorkflowEvent.mockClear();
    mockResolveWorkflowRunApproval.mockClear();
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

    expect(mockResolveWorkflowRunApproval).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      resolution: 'approved',
      metadata: { approval_response: 'approved', rejection_reason: '', rejection_count: 0 },
      decisionText: 'Looks good',
    });
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

    expect(mockResolveWorkflowRunApproval).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      resolution: 'feedback',
      metadata: { loop_user_input: 'fix the tests' },
      decisionText: 'fix the tests',
    });
  });

  test('approves interactive_loop completion alias — writes node_completed from lastOutput', async () => {
    const run = makePausedRun({
      metadata: {
        approval: {
          nodeId: 'explore',
          message: 'Say ready when done',
          type: 'interactive_loop',
          iteration: 2,
          lastOutput: 'Exploration summary for the plan.',
          completeOnUserInput: ['ready', 'create the plan'],
        },
      },
    });
    mockGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await approveWorkflow('run-1', ' Ready ');

    expect(result.type).toBe('interactive_loop');
    expect(mockCreateWorkflowEvent).toHaveBeenCalledTimes(2);
    expect(mockCreateWorkflowEvent.mock.calls[0][0]).toMatchObject({
      event_type: 'node_completed',
      step_name: 'explore',
      data: {
        node_output: 'Exploration summary for the plan.',
        approval_decision: 'approved',
        loop_completion_input: ' Ready ',
      },
    });
    expect(mockCreateWorkflowEvent.mock.calls[1][0]).toMatchObject({
      event_type: 'approval_received',
      data: { transition: 'complete_loop' },
    });
    expect(mockResolveWorkflowRunApproval).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      resolution: 'completed',
      metadata: { loop_completion_input: ' Ready ' },
      decisionText: ' Ready ',
    });
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
    mockGetWorkflowRun.mockClear();
    mockCreateWorkflowEvent.mockClear();
    mockResolveWorkflowRunApproval.mockClear();
    mockCancelWorkflowRun.mockClear();
  });

  test('rejects with onRejectPrompt under max attempts — transitions to failed', async () => {
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
    expect(mockResolveWorkflowRunApproval).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      resolution: 'rejected',
      metadata: { rejection_reason: 'needs more tests', rejection_count: 1 },
      decisionText: 'needs more tests',
    });
  });

  test('rejects at max attempts — archives decision and cancels run', async () => {
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
    expect(mockResolveWorkflowRunApproval).toHaveBeenCalledWith('run-1', {
      status: 'cancelled',
      resolution: 'rejected',
      metadata: { rejection_reason: 'still broken', rejection_count: 2 },
      decisionText: 'still broken',
    });
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('rejects without onRejectPrompt — archives decision and cancels immediately', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await rejectWorkflow('run-1', 'no good');

    expect(result.cancelled).toBe(true);
    expect(mockResolveWorkflowRunApproval).toHaveBeenCalledWith('run-1', {
      status: 'cancelled',
      resolution: 'rejected',
      decisionText: 'no good',
    });
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
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
      "Cannot resume run with status 'completed'. Only failed runs can be resumed."
    );
  });

  test('throws on paused run with approval guidance', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'paused' }));

    await expect(resumeWorkflow('run-1')).rejects.toThrow(
      "Cannot resume run with status 'paused'. Paused runs must be approved or rejected first."
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

  test('throws on terminal run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(abandonWorkflow('run-1')).rejects.toThrow(
      "Cannot abandon run with status 'completed'"
    );
  });
});

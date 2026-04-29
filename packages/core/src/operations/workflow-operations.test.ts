import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';

// ---------------------------------------------------------------------------
// Import namespace modules for spyOn (must come before module under test)
// ---------------------------------------------------------------------------

import * as dbWorkflows from '../db/workflows';
import * as dbWorkflowEvents from '../db/workflow-events';
import * as archonPaths from '@archon/paths';

// ---------------------------------------------------------------------------
// Import module under test (static import — spyOn intercepts at call time)
// ---------------------------------------------------------------------------

import {
  approveWorkflow,
  rejectWorkflow,
  getWorkflowStatus,
  resumeWorkflow,
  abandonWorkflow,
} from './workflow-operations';

// ---------------------------------------------------------------------------
// Spy variables
// ---------------------------------------------------------------------------

const mockLogger = createMockLogger();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateLogger: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyListWorkflowRuns: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyUpdateWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCancelWorkflowRun: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateWorkflowEvent: any;

beforeEach(() => {
  spyCreateLogger = spyOn(archonPaths, 'createLogger').mockReturnValue(mockLogger as never);
  spyGetWorkflowRun = spyOn(dbWorkflows, 'getWorkflowRun').mockResolvedValue(null);
  spyListWorkflowRuns = spyOn(dbWorkflows, 'listWorkflowRuns').mockResolvedValue([]);
  spyUpdateWorkflowRun = spyOn(dbWorkflows, 'updateWorkflowRun').mockResolvedValue(undefined);
  spyCancelWorkflowRun = spyOn(dbWorkflows, 'cancelWorkflowRun').mockResolvedValue(undefined);
  spyCreateWorkflowEvent = spyOn(dbWorkflowEvents, 'createWorkflowEvent').mockResolvedValue(
    undefined
  );
  mockLogger.error.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.info.mockClear();
});

afterEach(() => {
  spyCreateLogger.mockRestore();
  spyGetWorkflowRun.mockRestore();
  spyListWorkflowRuns.mockRestore();
  spyUpdateWorkflowRun.mockRestore();
  spyCancelWorkflowRun.mockRestore();
  spyCreateWorkflowEvent.mockRestore();
});

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
    spyGetWorkflowRun.mockClear();
    spyCreateWorkflowEvent.mockClear();
    spyUpdateWorkflowRun.mockClear();
  });

  test('approves standard approval gate — writes node_completed + approval_received', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await approveWorkflow('run-1', 'Looks good');

    expect(result.type).toBe('approval_gate');
    expect(result.workflowName).toBe('test-workflow');
    expect(result.workingPath).toBe('/workspace/worktree');

    // node_completed + approval_received = 2 events
    expect(spyCreateWorkflowEvent).toHaveBeenCalledTimes(2);
    const firstCall = spyCreateWorkflowEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(firstCall.event_type).toBe('node_completed');
    const secondCall = spyCreateWorkflowEvent.mock.calls[1][0] as Record<string, unknown>;
    expect(secondCall.event_type).toBe('approval_received');

    // Transitions to failed + clears rejection state
    expect(spyUpdateWorkflowRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { approval_response: 'approved', rejection_reason: '', rejection_count: 0 },
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
    spyGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await approveWorkflow('run-1', 'fix the tests');

    expect(result.type).toBe('interactive_loop');

    // Only approval_received — NOT node_completed
    expect(spyCreateWorkflowEvent).toHaveBeenCalledTimes(1);
    const call = spyCreateWorkflowEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(call.event_type).toBe('approval_received');

    // Stores loop_user_input in metadata
    expect(spyUpdateWorkflowRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { loop_user_input: 'fix the tests' },
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
    spyGetWorkflowRun.mockResolvedValueOnce(run);

    await approveWorkflow('run-1', 'My review notes');

    const nodeCompletedCall = spyCreateWorkflowEvent.mock.calls[0][0] as Record<string, unknown>;
    expect((nodeCompletedCall.data as Record<string, unknown>).node_output).toBe('My review notes');
  });

  test('throws on non-paused run', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));

    await expect(approveWorkflow('run-1')).rejects.toThrow(
      "Cannot approve run with status 'running'"
    );
  });

  test('throws on missing approval context', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ metadata: {} }));

    await expect(approveWorkflow('run-1')).rejects.toThrow('missing approval context');
  });

  test('throws on run not found', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(null);

    await expect(approveWorkflow('run-1')).rejects.toThrow('Workflow run not found: run-1');
  });
});

describe('rejectWorkflow', () => {
  beforeEach(() => {
    spyGetWorkflowRun.mockClear();
    spyCreateWorkflowEvent.mockClear();
    spyUpdateWorkflowRun.mockClear();
    spyCancelWorkflowRun.mockClear();
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
    spyGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'needs more tests');

    expect(result.cancelled).toBe(false);
    expect(result.workflowName).toBe('test-workflow');
    expect(spyCancelWorkflowRun).not.toHaveBeenCalled();
    expect(spyUpdateWorkflowRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { rejection_reason: 'needs more tests', rejection_count: 1 },
    });
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
    spyGetWorkflowRun.mockResolvedValueOnce(run);

    const result = await rejectWorkflow('run-1', 'still broken');

    expect(result.cancelled).toBe(true);
    expect(spyCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('rejects without onRejectPrompt — cancels immediately', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(makePausedRun());

    const result = await rejectWorkflow('run-1', 'no good');

    expect(result.cancelled).toBe(true);
    expect(spyCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('throws on non-paused run', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(rejectWorkflow('run-1')).rejects.toThrow(
      "Cannot reject run with status 'completed'"
    );
  });
});

describe('getWorkflowStatus', () => {
  beforeEach(() => {
    spyListWorkflowRuns.mockClear();
  });

  test('returns running and paused runs', async () => {
    const runs = [
      makePausedRun({ status: 'running' }),
      makePausedRun({ id: 'run-2', status: 'paused' }),
    ];
    spyListWorkflowRuns.mockResolvedValueOnce(runs);

    const result = await getWorkflowStatus();

    expect(result.runs).toHaveLength(2);
    expect(spyListWorkflowRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
    });
  });
});

describe('resumeWorkflow', () => {
  beforeEach(() => {
    spyGetWorkflowRun.mockClear();
  });

  test('returns run when status is resumable', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'failed' }));

    const run = await resumeWorkflow('run-1');
    expect(run.id).toBe('run-1');
  });

  test('throws on non-resumable status', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(resumeWorkflow('run-1')).rejects.toThrow(
      "Cannot resume run with status 'completed'"
    );
  });

  test('throws wrapped message and logs when DB throws', async () => {
    spyGetWorkflowRun.mockRejectedValueOnce(new Error('connection reset'));

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
    spyGetWorkflowRun.mockClear();
    spyCancelWorkflowRun.mockClear();
  });

  test('cancels a non-terminal run', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'running' }));

    const run = await abandonWorkflow('run-1');
    expect(run.id).toBe('run-1');
    expect(spyCancelWorkflowRun).toHaveBeenCalledWith('run-1');
  });

  test('throws on terminal run', async () => {
    spyGetWorkflowRun.mockResolvedValueOnce(makePausedRun({ status: 'completed' }));

    await expect(abandonWorkflow('run-1')).rejects.toThrow(
      "Cannot abandon run with status 'completed'"
    );
  });
});

import { describe, expect, it } from 'bun:test';
import { buildWorkflowRunQueryData } from './workflow-run-query';
import type { WorkflowEventResponse, WorkflowRunResponse } from './api';

let eventSequence = 0;

function makeRun(overrides: Partial<WorkflowRunResponse> = {}): WorkflowRunResponse {
  return {
    id: 'run-1',
    workflow_name: 'test-workflow',
    conversation_id: 'conversation-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    user_message: 'run the workflow',
    metadata: {},
    started_at: '2026-05-01T10:00:00',
    completed_at: null,
    last_activity_at: null,
    ...overrides,
  };
}

function makeEvent(
  eventType: string,
  overrides: Partial<WorkflowEventResponse> = {}
): WorkflowEventResponse {
  return {
    id: `${eventType}-${String((eventSequence += 1))}`,
    workflow_run_id: 'run-1',
    event_type: eventType,
    step_index: null,
    step_name: null,
    data: {},
    created_at: '2026-05-01T10:01:00',
    ...overrides,
  };
}

describe('buildWorkflowRunQueryData', () => {
  it('throws with run id when REST response is missing run data', () => {
    expect(() => buildWorkflowRunQueryData('run-123', { run: null, events: [] })).toThrow(
      'Workflow run run-123 was not found'
    );
  });

  it('returns empty DAG and artifact arrays when the run has no events', () => {
    const result = buildWorkflowRunQueryData('run-1', { run: makeRun(), events: [] });

    expect(result.workflowState.dagNodes).toEqual([]);
    expect(result.workflowState.artifacts).toEqual([]);
    expect(result.workerPlatformId).toBeNull();
    expect(result.parentPlatformId).toBeNull();
    expect(result.conversationPlatformId).toBeNull();
    expect(result.codebaseId).toBeNull();
    expect(result.workflowState.completedAt).toBeUndefined();
  });

  it('derives DAG node states from node events and falls back to data.nodeId', () => {
    const result = buildWorkflowRunQueryData('run-1', {
      run: makeRun(),
      events: [
        makeEvent('node_started', { step_name: 'build' }),
        makeEvent('node_completed', {
          step_name: 'build',
          data: { duration_ms: 1200 },
        }),
        makeEvent('node_failed', {
          step_name: 'test',
          data: { error: 'Unit tests failed' },
        }),
        makeEvent('node_skipped', {
          step_name: 'deploy',
          data: { reason: 'when_condition' },
        }),
        makeEvent('node_started', {
          data: { nodeId: 'fallback-node' },
        }),
        makeEvent('node_started'),
      ],
    });

    expect(result.workflowState.dagNodes).toEqual([
      {
        nodeId: 'build',
        name: 'build',
        status: 'completed',
        duration: 1200,
        error: undefined,
        reason: undefined,
      },
      {
        nodeId: 'test',
        name: 'test',
        status: 'failed',
        duration: undefined,
        error: 'Unit tests failed',
        reason: undefined,
      },
      {
        nodeId: 'deploy',
        name: 'deploy',
        status: 'skipped',
        duration: undefined,
        error: undefined,
        reason: 'when_condition',
      },
      {
        nodeId: 'fallback-node',
        name: 'fallback-node',
        status: 'running',
        duration: undefined,
        error: undefined,
        reason: undefined,
      },
    ]);
  });

  it('keeps terminal node state when stale running events arrive after completion', () => {
    const result = buildWorkflowRunQueryData('run-1', {
      run: makeRun(),
      events: [
        makeEvent('node_completed', {
          step_name: 'review',
          data: { duration_ms: 2500 },
        }),
        makeEvent('node_started', { step_name: 'review' }),
      ],
    });

    expect(result.workflowState.dagNodes).toHaveLength(1);
    expect(result.workflowState.dagNodes[0]).toMatchObject({
      nodeId: 'review',
      status: 'completed',
      duration: 2500,
    });
  });

  it('adds and updates loop iteration metadata on existing DAG nodes', () => {
    const result = buildWorkflowRunQueryData('run-1', {
      run: makeRun(),
      events: [
        makeEvent('node_started', { step_name: 'loop-node' }),
        makeEvent('loop_iteration_started', {
          step_name: 'loop-node',
          data: { iteration: 1, maxIterations: 3 },
        }),
        makeEvent('loop_iteration_started', {
          step_name: 'loop-node',
          data: { iteration: 1, maxIterations: 3, duration_ms: 10 },
        }),
        makeEvent('loop_iteration_completed', {
          step_name: 'loop-node',
          data: { iteration: 1, duration_ms: 110 },
        }),
        makeEvent('loop_iteration_started', {
          step_name: 'loop-node',
          data: { iteration: 2, maxIterations: 3 },
        }),
        makeEvent('loop_iteration_failed', {
          step_name: 'loop-node',
          data: { iteration: 2, duration_ms: 220 },
        }),
        makeEvent('loop_iteration_completed', {
          step_name: 'missing-node',
          data: { iteration: 1, duration_ms: 50 },
        }),
      ],
    });

    expect(result.workflowState.dagNodes).toHaveLength(1);
    expect(result.workflowState.dagNodes[0]).toMatchObject({
      nodeId: 'loop-node',
      currentIteration: 2,
      maxIterations: 3,
      iterations: [
        { iteration: 1, status: 'completed', duration: 110 },
        { iteration: 2, status: 'failed', duration: 220 },
      ],
    });
  });

  it('maps workflow artifacts and filters empty artifact events', () => {
    const result = buildWorkflowRunQueryData('run-1', {
      run: makeRun(),
      events: [
        makeEvent('workflow_artifact', {
          data: {
            artifactType: 'pr',
            label: 'Azure PR',
            url: 'https://dev.azure.com/example/project/_git/repo/pullrequest/123',
          },
        }),
        makeEvent('workflow_artifact', {
          data: {
            path: '/tmp/report.md',
          },
        }),
        makeEvent('workflow_artifact', {
          data: {},
        }),
      ],
    });

    expect(result.workflowState.artifacts).toEqual([
      {
        type: 'pr',
        label: 'Azure PR',
        url: 'https://dev.azure.com/example/project/_git/repo/pullrequest/123',
        path: undefined,
      },
      {
        type: 'commit',
        label: '',
        url: undefined,
        path: '/tmp/report.md',
      },
    ]);
  });

  it('computes timestamps and extracts platform identifiers from run data', () => {
    const result = buildWorkflowRunQueryData('run-1', {
      run: makeRun({
        id: 'run-99',
        workflow_name: 'deploy-workflow',
        status: 'completed',
        started_at: '2026-05-01T10:00:00',
        completed_at: '2026-05-01T10:05:30',
        worker_platform_id: 'worker-1',
        parent_platform_id: 'parent-1',
        conversation_platform_id: 'conversation-platform-1',
        codebase_id: 'codebase-1',
      }),
      events: [],
    });

    expect(result.workflowState).toMatchObject({
      runId: 'run-99',
      workflowName: 'deploy-workflow',
      status: 'completed',
      startedAt: Date.parse('2026-05-01T10:00:00Z'),
      completedAt: Date.parse('2026-05-01T10:05:30Z'),
    });
    expect(result.workerPlatformId).toBe('worker-1');
    expect(result.parentPlatformId).toBe('parent-1');
    expect(result.conversationPlatformId).toBe('conversation-platform-1');
    expect(result.codebaseId).toBe('codebase-1');
  });
});

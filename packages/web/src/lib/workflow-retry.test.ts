import { describe, expect, test } from 'bun:test';

import {
  buildCliRetryCommand,
  buildRetryWorkflowNodePath,
  getWorkflowNodeRetryActionState,
  getWorkflowRetryRunIneligibility,
  isRetryableFailedNode,
} from './workflow-retry';
import type { RetryableNodeState, WorkflowRetryRunContext } from './workflow-retry';

function runContext(overrides: Partial<WorkflowRetryRunContext> = {}): WorkflowRetryRunContext {
  return {
    runId: 'run-123',
    status: 'failed',
    parentPlatformId: 'web-parent',
    conversationPlatformId: 'web-worker',
    ...overrides,
  };
}

function failedNode(overrides: Partial<RetryableNodeState> = {}): RetryableNodeState {
  return {
    nodeId: 'build',
    status: 'failed',
    ...overrides,
  };
}

describe('workflow retry helpers', () => {
  test('identifies failed DAG nodes that can show the retry action', () => {
    expect(isRetryableFailedNode(failedNode())).toBe(true);
    expect(isRetryableFailedNode(failedNode({ retryEpoch: 2, latestRetryEpoch: 2 }))).toBe(true);
    expect(isRetryableFailedNode(failedNode({ retryEpoch: 1, latestRetryEpoch: 2 }))).toBe(false);
    expect(isRetryableFailedNode(failedNode({ status: 'completed' }))).toBe(false);
  });

  test('marks web-created failed or cancelled workflow runs as eligible', () => {
    expect(getWorkflowRetryRunIneligibility(runContext({ status: 'failed' }))).toBeNull();
    expect(getWorkflowRetryRunIneligibility(runContext({ status: 'cancelled' }))).toBeNull();
    expect(getWorkflowRetryRunIneligibility(runContext({ status: 'running' }))).toBe(
      'run-not-retryable'
    );
  });

  test('returns the web retry action for failed nodes on cancelled runs', () => {
    expect(
      getWorkflowNodeRetryActionState(runContext({ status: 'cancelled' }), failedNode())
    ).toEqual({
      kind: 'web',
      runId: 'run-123',
      nodeId: 'build',
    });
  });

  test('returns CLI guidance when the retryable run was not created from web', () => {
    expect(
      getWorkflowNodeRetryActionState(
        runContext({ status: 'cancelled', parentPlatformId: null }),
        failedNode()
      )
    ).toEqual({
      kind: 'cli',
      command: 'archon workflow retry-node run-123 build',
    });

    expect(
      getWorkflowNodeRetryActionState(
        runContext({ status: 'cancelled', parentPlatformId: null, conversationPlatformId: null }),
        failedNode()
      )
    ).toEqual({ kind: 'hidden' });
  });

  test('guides retryable route-loop controllers toward route_loop.from', () => {
    expect(
      getWorkflowNodeRetryActionState(runContext({ status: 'cancelled' }), {
        nodeId: 'review-router',
        status: 'completed',
        routeDecision: { from: 'review' },
      })
    ).toEqual({
      kind: 'route-loop-guidance',
      fromNodeId: 'review',
    });
  });

  test('builds retry API paths and CLI commands', () => {
    expect(buildRetryWorkflowNodePath('run 1', 'node/2')).toBe(
      '/api/workflows/runs/run%201/nodes/node%2F2/retry'
    );
    expect(buildCliRetryCommand('run-123', 'build')).toBe(
      'archon workflow retry-node run-123 build'
    );
  });
});

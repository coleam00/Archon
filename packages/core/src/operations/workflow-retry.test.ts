import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowDefinition, WorkflowRun } from '@archon/workflows/schemas';
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockGetWorkflowRun = mock(async () => makeRun());
const mockClaimWorkflowRunForNodeRetry = mock(async () =>
  makeRun({ status: 'running', metadata: { retry_epoch: 1 } })
);
const mockUpdateWorkflowRun = mock(async () => {});

mock.module('../db/workflows', () => ({
  getWorkflowRun: mockGetWorkflowRun,
  claimWorkflowRunForNodeRetry: mockClaimWorkflowRunForNodeRetry,
  updateWorkflowRun: mockUpdateWorkflowRun,
  WorkflowRetryNotClaimableError: class WorkflowRetryNotClaimableError extends Error {
    constructor(
      readonly runId: string,
      readonly currentStatus: string
    ) {
      super(`Workflow run is not retry-claimable (${runId}, ${currentStatus})`);
      this.name = 'WorkflowRetryNotClaimableError';
    }
  },
}));

const mockListWorkflowEvents = mock(async () => [
  { event_type: 'node_completed', step_name: 'a', data: { node_output: 'A0' } },
  { event_type: 'node_failed', step_name: 'b', data: { error: 'boom' } },
  { event_type: 'node_skipped', step_name: 'c', data: { reason: 'dependency_failed' } },
]);
const mockGetRetryPreservedDagNodeOutputs = mock(async () => new Map([['a', 'A0']]));

mock.module('../db/workflow-events', () => ({
  listWorkflowEvents: mockListWorkflowEvents,
  getRetryPreservedDagNodeOutputs: mockGetRetryPreservedDagNodeOutputs,
}));

const mockDeleteWorkflowNodeSessions = mock(async () => ({ deleted: 0 }));

mock.module('../db/workflow-node-sessions', () => ({
  deleteWorkflowNodeSessions: mockDeleteWorkflowNodeSessions,
}));

const mockQuery = mock(async () => createQueryResult([]));

mock.module('../db/connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

const { prepareWorkflowNodeRetry, WorkflowRetryError } = await import('./workflow-retry');

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflow_name: 'retry-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'codebase-1',
    status: 'failed',
    user_message: 'retry please',
    metadata: {},
    started_at: new Date('2026-06-21T00:00:00.000Z'),
    completed_at: new Date('2026-06-21T00:01:00.000Z'),
    last_activity_at: new Date('2026-06-21T00:01:00.000Z'),
    working_path: '/workspace/repo',
    user_id: null,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'retry-workflow',
    description: 'Retry workflow',
    mutates_checkout: false,
    nodes: [
      { id: 'a', command: 'a' },
      { id: 'b', command: 'b', depends_on: ['a'] },
      { id: 'c', command: 'c', depends_on: ['b'] },
    ],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<Parameters<typeof prepareWorkflowNodeRetry>[0]> = {}) {
  return {
    runId: 'run-1',
    nodeId: 'b',
    requesterSurface: 'cli' as const,
    requesterUserId: 'user-1',
    authorizationBasis: 'cli/solo',
    workflow: makeWorkflow(),
    ...overrides,
  };
}

function auditPayloads(): Record<string, unknown>[] {
  return mockQuery.mock.calls.map(call => JSON.parse((call[1] as unknown[])[5] as string));
}

describe('workflow retry preparation operation', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockGetWorkflowRun.mockImplementation(async () => makeRun());
    mockClaimWorkflowRunForNodeRetry.mockReset();
    mockClaimWorkflowRunForNodeRetry.mockImplementation(async () =>
      makeRun({ status: 'running', metadata: { retry_epoch: 1 } })
    );
    mockUpdateWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockImplementation(async () => {});
    mockListWorkflowEvents.mockReset();
    mockListWorkflowEvents.mockImplementation(async () => [
      { event_type: 'node_completed', step_name: 'a', data: { node_output: 'A0' } },
      { event_type: 'node_failed', step_name: 'b', data: { error: 'boom' } },
      { event_type: 'node_skipped', step_name: 'c', data: { reason: 'dependency_failed' } },
    ]);
    mockGetRetryPreservedDagNodeOutputs.mockReset();
    mockGetRetryPreservedDagNodeOutputs.mockImplementation(async () => new Map([['a', 'A0']]));
    mockDeleteWorkflowNodeSessions.mockReset();
    mockDeleteWorkflowNodeSessions.mockImplementation(async () => ({ deleted: 0 }));
    mockQuery.mockReset();
    mockQuery.mockImplementation(async () => createQueryResult([]));
  });

  test('prepares a linear A -> B -> C retry by preserving A, invalidating B/C, and reusing the same run', async () => {
    const result = await prepareWorkflowNodeRetry(makeRequest());

    expect(result.runId).toBe('run-1');
    expect(result.preCreatedRun.id).toBe('run-1');
    expect(result.retryEpoch).toBe(1);
    expect(result.invalidatedNodeIds).toEqual(['b', 'c']);
    expect(result.preservedCompletedOutputs).toEqual(new Map([['a', 'A0']]));
  });

  test('rejects retry when the run is not failed or the target node is not failed', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(makeRun({ status: 'running' }));
    await expect(prepareWorkflowNodeRetry(makeRequest())).rejects.toMatchObject({
      code: 'run_not_failed',
    });

    mockGetWorkflowRun.mockResolvedValueOnce(makeRun());
    mockListWorkflowEvents.mockResolvedValueOnce([
      { event_type: 'node_completed', step_name: 'b', data: { node_output: 'B0' } },
    ]);
    await expect(prepareWorkflowNodeRetry(makeRequest())).rejects.toMatchObject({
      code: 'node_not_failed',
    });
  });

  test('increments retry metadata exactly once while moving the same run back to running', async () => {
    await prepareWorkflowNodeRetry(makeRequest());

    expect(mockClaimWorkflowRunForNodeRetry).toHaveBeenCalledTimes(1);
    expect(mockClaimWorkflowRunForNodeRetry).toHaveBeenCalledWith('run-1');
  });

  test('filters preserved outputs to exclude invalidated target and descendant nodes', async () => {
    await prepareWorkflowNodeRetry(makeRequest());

    expect(mockGetRetryPreservedDagNodeOutputs).toHaveBeenCalledWith('run-1', ['b', 'c']);
  });

  test('deletes persisted node sessions for every invalidated node before dispatch', async () => {
    await prepareWorkflowNodeRetry(makeRequest());

    expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledTimes(2);
    expect(mockDeleteWorkflowNodeSessions).toHaveBeenNthCalledWith(1, {
      workflow_name: 'retry-workflow',
      scope_key: 'conv-1',
      node_id: 'b',
    });
    expect(mockDeleteWorkflowNodeSessions).toHaveBeenNthCalledWith(2, {
      workflow_name: 'retry-workflow',
      scope_key: 'conv-1',
      node_id: 'c',
    });
  });

  test('writes retry audit events through the strict retry audit writer', async () => {
    await prepareWorkflowNodeRetry(makeRequest());

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO remote_agent_workflow_events'),
      expect.arrayContaining(['run-1', 'node_retry_requested', null, 'b'])
    );
    expect(auditPayloads()[0]).toMatchObject({
      runId: 'run-1',
      node_id: 'b',
      retry_epoch: 1,
      invalidated_node_ids: ['b', 'c'],
      requester_surface: 'cli',
      requester_user_id: 'user-1',
      authorization_basis: 'cli/solo',
    });
  });

  test('restores failed status and avoids dispatch when retry preparation fails', async () => {
    mockGetRetryPreservedDagNodeOutputs.mockRejectedValueOnce(new Error('hydration failed'));

    await expect(prepareWorkflowNodeRetry(makeRequest())).rejects.toBeInstanceOf(
      WorkflowRetryError
    );

    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { retry_setup_error: 'hydration failed' },
    });
    const payloads = auditPayloads();
    expect(payloads[1]).toMatchObject({
      node_id: 'b',
      retry_epoch: 1,
      setup_phase: 'retry_preparation',
      error: 'hydration failed',
    });
  });
});

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
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

const mockFindLatestCheckpointForRetry = mock(async () => null);

mock.module('../db/workflow-checkpoints', () => ({
  findLatestCheckpointForRetry: mockFindLatestCheckpointForRetry,
}));

const mockVerifyCommitRef = mock(async () => 'checkpoint-sha');
const mockCreateRetrySafetyRef = mock(async () => ({
  ref: 'refs/archon/retry-safety/run-1/1',
  commitSha: 'safety-sha',
  createdCommit: false,
}));
const mockResetTrackedFilesToCommit = mock(async () => 'checkpoint-sha');

mock.module('@archon/git', () => ({
  verifyCommitRef: mockVerifyCommitRef,
  createRetrySafetyRef: mockCreateRetrySafetyRef,
  resetTrackedFilesToCommit: mockResetTrackedFilesToCommit,
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
    mockFindLatestCheckpointForRetry.mockReset();
    mockFindLatestCheckpointForRetry.mockImplementation(async () => null);
    mockVerifyCommitRef.mockReset();
    mockVerifyCommitRef.mockImplementation(async () => 'checkpoint-sha');
    mockCreateRetrySafetyRef.mockReset();
    mockCreateRetrySafetyRef.mockImplementation(async () => ({
      ref: 'refs/archon/retry-safety/run-1/1',
      commitSha: 'safety-sha',
      createdCommit: false,
    }));
    mockResetTrackedFilesToCommit.mockReset();
    mockResetTrackedFilesToCommit.mockImplementation(async () => 'checkpoint-sha');
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
    expect(auditPayloads()[1]).toMatchObject({
      node_id: 'b',
      retry_epoch: 1,
      checkpoint_ref: null,
      safety_ref: null,
      reset_skipped: true,
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
    expect(
      payloads.find(payload => (payload as { setup_phase?: unknown }).setup_phase)
    ).toMatchObject({
      node_id: 'b',
      retry_epoch: 1,
      setup_phase: 'retry_preparation',
      error: 'hydration failed',
    });
  });

  test('writes reset_skipped when a mutating retry has no checkpoint fallback', async () => {
    const result = await prepareWorkflowNodeRetry(
      makeRequest({ workflow: makeWorkflow({ mutates_checkout: true }) })
    );

    expect(result.resetSkipped).toBe(true);
    expect(mockFindLatestCheckpointForRetry).toHaveBeenCalledWith('run-1', 'b', ['a'], 1);
    expect(mockVerifyCommitRef).not.toHaveBeenCalled();
    expect(mockCreateRetrySafetyRef).not.toHaveBeenCalled();
    expect(mockResetTrackedFilesToCommit).not.toHaveBeenCalled();
    expect(auditPayloads()[1]).toMatchObject({
      node_id: 'b',
      retry_epoch: 1,
      checkpoint_ref: null,
      checkpoint_commit_sha: null,
      safety_ref: null,
      safety_commit_sha: null,
      reset_skipped: true,
    });
  });

  test('creates safety ref, resets to selected checkpoint, and writes node_retry_reset', async () => {
    mockFindLatestCheckpointForRetry.mockResolvedValueOnce({
      workflow_run_id: 'run-1',
      node_id: 'b',
      retry_epoch: 0,
      checkpoint_ref: 'refs/archon/checkpoints/run-1/0/b',
      commit_sha: 'checkpoint-sha',
      created_commit: false,
      fallback_from_node_id: null,
      created_at: new Date(),
    });

    const result = await prepareWorkflowNodeRetry(
      makeRequest({ workflow: makeWorkflow({ mutates_checkout: true }) })
    );

    expect(result.resetSkipped).toBe(false);
    expect(result.checkpointRef).toBe('refs/archon/checkpoints/run-1/0/b');
    expect(result.checkpointCommitSha).toBe('checkpoint-sha');
    expect(result.safetyRef).toBe('refs/archon/retry-safety/run-1/1');
    expect(result.safetyCommitSha).toBe('safety-sha');
    expect(mockVerifyCommitRef).toHaveBeenCalledWith(
      '/workspace/repo',
      'refs/archon/checkpoints/run-1/0/b'
    );
    expect(mockCreateRetrySafetyRef).toHaveBeenCalledWith('/workspace/repo', {
      runId: 'run-1',
      retryEpoch: 1,
    });
    expect(mockResetTrackedFilesToCommit).toHaveBeenCalledWith(
      '/workspace/repo',
      'refs/archon/checkpoints/run-1/0/b'
    );
    expect(auditPayloads()[1]).toMatchObject({
      node_id: 'b',
      retry_epoch: 1,
      checkpoint_ref: 'refs/archon/checkpoints/run-1/0/b',
      checkpoint_commit_sha: 'checkpoint-sha',
      safety_ref: 'refs/archon/retry-safety/run-1/1',
      safety_commit_sha: 'safety-sha',
      reset_skipped: false,
    });
  });

  test('writes node_retry_failed and avoids dispatch when checkpoint ref validation fails', async () => {
    mockFindLatestCheckpointForRetry.mockResolvedValueOnce({
      workflow_run_id: 'run-1',
      node_id: 'b',
      retry_epoch: 0,
      checkpoint_ref: 'refs/archon/checkpoints/run-1/0/b',
      commit_sha: 'checkpoint-sha',
      created_commit: false,
      fallback_from_node_id: null,
      created_at: new Date(),
    });
    mockVerifyCommitRef.mockRejectedValueOnce(new Error('missing checkpoint ref'));

    await expect(
      prepareWorkflowNodeRetry(makeRequest({ workflow: makeWorkflow({ mutates_checkout: true }) }))
    ).rejects.toMatchObject({ code: 'checkpoint_unavailable' });

    expect(mockCreateRetrySafetyRef).not.toHaveBeenCalled();
    expect(mockResetTrackedFilesToCommit).not.toHaveBeenCalled();
    expect(mockGetRetryPreservedDagNodeOutputs).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { retry_setup_error: 'missing checkpoint ref' },
    });
    expect(auditPayloads().at(-1)).toMatchObject({
      node_id: 'b',
      retry_epoch: 1,
      setup_phase: 'checkpoint_validation',
      error: 'missing checkpoint ref',
    });
  });

  test('writes node_retry_failed and avoids dispatch when git reset --hard fails', async () => {
    mockFindLatestCheckpointForRetry.mockResolvedValueOnce({
      workflow_run_id: 'run-1',
      node_id: 'b',
      retry_epoch: 0,
      checkpoint_ref: 'refs/archon/checkpoints/run-1/0/b',
      commit_sha: 'checkpoint-sha',
      created_commit: false,
      fallback_from_node_id: null,
      created_at: new Date(),
    });
    mockResetTrackedFilesToCommit.mockRejectedValueOnce(new Error('reset failed'));

    await expect(
      prepareWorkflowNodeRetry(makeRequest({ workflow: makeWorkflow({ mutates_checkout: true }) }))
    ).rejects.toMatchObject({ code: 'git_reset_failed' });

    expect(mockCreateRetrySafetyRef).toHaveBeenCalledTimes(1);
    expect(mockGetRetryPreservedDagNodeOutputs).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      metadata: { retry_setup_error: 'reset failed' },
    });
    expect(auditPayloads().at(-1)).toMatchObject({
      node_id: 'b',
      retry_epoch: 1,
      setup_phase: 'git_reset',
      error: 'reset failed',
    });
  });
});

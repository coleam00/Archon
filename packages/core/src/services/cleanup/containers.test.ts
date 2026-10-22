// @archon-test-isolated
import { describe, test, expect, beforeEach } from 'bun:test';
import type { IIsolationStore } from '@archon/isolation';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { WorkflowStatusReadError } from '../../db/workflow-run-status';
import { mockWorkflowRun } from '../../test/mocks/workflow-run';
import { listContainerEnvironments, reclaimContainerEnv } from './containers';
import {
  UNKNOWN_PLATFORM,
  makeContainerEnvironment,
  mockLogger,
  mockContainerDestroy,
  mockContainerOptions,
  mockListActiveContainerEnvironments,
  mockGetRunByIsolationEnvId,
  resetCleanupMocks,
} from './test-harness';

beforeEach(resetCleanupMocks);

describe('reclaimContainerEnv', () => {
  test('uses the supplied isolation store and preserves destroy failures', async () => {
    const store: IIsolationStore = {
      getById: async () => null,
      findActiveByWorkflow: async () => null,
      listActive: async () => [],
      create: async () => {
        throw new Error('Unexpected create');
      },
      updateStatus: async () => {},
      withWorktreeRegistration: async () => {
        throw new Error('Unexpected worktree removal');
      },
      markWorktreeDestroyed: async () => {},
      updateMetadata: async () => undefined,
      countActiveByCodebase: async () => 0,
    };
    await reclaimContainerEnv('supplied-env', store);
    expect(mockContainerOptions.mock.calls.at(-1)?.[0].store).toBe(store);
    expect(mockContainerDestroy).toHaveBeenLastCalledWith('supplied-env');
    const unknownStore = {
      ...store,
      getById: async () => makeContainerEnvironment({ created_by_platform: UNKNOWN_PLATFORM }),
    };
    const destroys = mockContainerDestroy.mock.calls.length;
    await expect(reclaimContainerEnv('supplied-env', unknownStore)).rejects.toThrow(
      `platform '${UNKNOWN_PLATFORM}' is not registered`
    );
    expect(mockContainerDestroy.mock.calls.length).toBe(destroys);
    mockContainerDestroy.mockRejectedValueOnce(new Error('Docker unavailable'));
    await expect(reclaimContainerEnv('supplied-env', store)).rejects.toThrow('Docker unavailable');
  });
});

describe('listContainerEnvironments', () => {
  beforeEach(() => {
    mockListActiveContainerEnvironments.mockResolvedValue([
      makeContainerEnvironment({ codebase_name: 'ops', days_since_created: 30 }),
    ]);
  });

  test.each(workflowRunStatusSchema.options)('lists supported run status %s', async status => {
    mockGetRunByIsolationEnvId.mockResolvedValue({ ...mockWorkflowRun, status });
    expect(await listContainerEnvironments()).toMatchObject([
      { runId: mockWorkflowRun.id, runStatus: status },
    ]);
    expect(mockContainerDestroy).not.toHaveBeenCalled();
  });

  test('distinguishes a missing run from an unsupported persisted status', async () => {
    expect(await listContainerEnvironments()).toMatchObject([{ runId: null, runStatus: null }]);
    const err = new WorkflowStatusReadError('unsupported-run', 'unexpected');
    mockGetRunByIsolationEnvId.mockRejectedValue(err);
    expect(await listContainerEnvironments()).toMatchObject([
      { runId: null, runStatus: 'lookup-failed' },
    ]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err, envId: expect.any(String) },
      'container_env_list_lookup_failed'
    );
    expect(mockContainerDestroy).not.toHaveBeenCalled();
  });
});

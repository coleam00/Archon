// @archon-test-isolated
import { hostname } from 'node:os';
import { describe, test, expect, beforeEach } from 'bun:test';
import type { IIsolationStore } from '@archon/isolation';
import { workflowRunStatusSchema } from '@archon/workflows/schemas/workflow-run';
import { WorkflowStatusReadError } from '../../db/workflow-run-status';
import { mockWorkflowRun } from '../../test/mocks/workflow-run';
import {
  listContainerEnvironments,
  reclaimContainerEnv,
  reapContainerEnvironments,
} from './containers';
import {
  UNKNOWN_PLATFORM,
  makeContainerEnvironment,
  mockLogger,
  mockContainerDestroy,
  mockContainerOptions,
  mockListActiveContainerEnvironments,
  mockGetRunByIsolationEnvId,
  mockGetWorkflowRun,
  mockReleaseVerificationImages,
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

describe('verification images after reaping', () => {
  test.each([
    'completed',
    'paused',
    'unknown-owner',
    'missing',
    'destroy-failed',
    'lookup-failed',
  ] as const)('rechecks the owning run after container teardown: %s', async mode => {
    mockListActiveContainerEnvironments.mockResolvedValue([makeContainerEnvironment()]);
    const run = {
      ...mockWorkflowRun,
      status: mode === 'paused' ? ('paused' as const) : ('completed' as const),
      metadata:
        mode === 'unknown-owner'
          ? {}
          : {
              execution_owner: { host: hostname(), pid: process.pid },
              isolation: 'container',
              isolation_env_id: 'env-1',
            },
    };
    mockGetRunByIsolationEnvId.mockResolvedValue(mode === 'missing' ? null : run);
    mockGetWorkflowRun.mockResolvedValue(run);
    if (mode === 'destroy-failed')
      mockContainerDestroy.mockRejectedValueOnce(new Error('Docker unavailable'));
    if (mode === 'lookup-failed')
      mockGetRunByIsolationEnvId.mockRejectedValueOnce(new Error('store unavailable'));
    const report = await reapContainerEnvironments(1);
    expect(report.removed).toEqual(mode === 'destroy-failed' ? [] : ['env-1']);
    if (mode === 'completed') {
      expect(mockReleaseVerificationImages).toHaveBeenCalledWith(run.id, 'env-1');
      expect(mockContainerDestroy).toHaveBeenCalledWith('env-1');
    } else expect(mockReleaseVerificationImages).not.toHaveBeenCalled();
  });
});

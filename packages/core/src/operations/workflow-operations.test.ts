// @archon-test-isolated
import { describe, test, expect, mock } from 'bun:test';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowOperationsDeps, WorkflowOperations } from './workflow-operations';
import type { IIsolationStore } from '@archon/isolation';
import {
  operator,
  EMPTY_COUNTS,
  mockReclaimContainerEnv,
  mockRequestDetachedRunStop,
  isolationStore,
  store,
  makePausedRun,
  createWorkflowOperations,
  isRunOwnedByThisProcess,
  isRunOwnerAnswering,
} from './workflow/test-harness';

describe('supplied stores', () => {
  test('two operation instances keep their run stores separate', async () => {
    const firstRun = makePausedRun({ id: 'first' });
    const secondRun = makePausedRun({ id: 'second' });
    const makeOperations = (run: WorkflowRun): WorkflowOperations =>
      createWorkflowOperations({
        getUserRole: async () => undefined,
        store: {
          ...store,
          getWorkflowRun: async () => run,
          findWorkflowRunsByIdPrefix: async (prefix, codebaseId) =>
            prefix === run.id && codebaseId === run.codebase_id ? [run] : [],
          listWorkflowRuns: async () => ({
            runs: [],
            total: run.id === 'first' ? 1 : 2,
            counts: EMPTY_COUNTS,
          }),
        },
        hostStore: { isolation: isolationStore },
        requestDetachedRunStop: mockRequestDetachedRunStop,
        isRunOwnedByThisProcess,
        isRunOwnerAnswering,
        reclaimRunWorktree: async () => ({ warnings: [] }),
        reclaimContainerEnv: mockReclaimContainerEnv,
      });
    const first = makeOperations(firstRun);
    const second = makeOperations(secondRun);
    expect(await first.resumeWorkflow('first', operator)).toBe(firstRun);
    expect(await second.resumeWorkflow('second', operator)).toBe(secondRun);
    expect(await first.resumeWorkflow('first', operator)).toBe(firstRun);
    expect(await first.findWorkflowRunsByIdPrefix('first', 'cb-1')).toEqual([firstRun]);
    expect(await second.findWorkflowRunsByIdPrefix('first', 'cb-1')).toEqual([]);
    expect((await first.listWorkflowRuns()).total).toBe(1);
    expect((await second.listWorkflowRuns()).total).toBe(2);
  });

  test('container cancellation reads and reclaims through the same supplied isolation store', async () => {
    const run = makePausedRun({
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'supplied-env' },
    });
    const getById = mock<IIsolationStore['getById']>(async () => ({
      id: 'supplied-env',
      codebase_id: 'codebase',
      workflow_type: 'task',
      workflow_id: run.id,
      provider: 'container',
      working_path: '/workspace',
      branch_name: 'task',
      status: 'active',
      created_at: new Date(),
      created_by_platform: 'test',
      created_by_user_id: null,
      metadata: {},
    }));
    const isolation = { ...isolationStore, getById };
    const cleanup = mock<WorkflowOperationsDeps['reclaimContainerEnv']>(async () => {});
    const cancelled = mock<IWorkflowStore['cancelWorkflowRun']>(async () => ({ cancelled: true }));
    const stop = mock(async () => ({ warnings: [] }));
    const operations = createWorkflowOperations({
      getUserRole: async () => undefined,
      store: {
        ...store,
        getWorkflowRun: async () => run,
        findChildRuns: async () => [],
        cancelWorkflowRun: cancelled,
      },
      hostStore: { isolation },
      requestDetachedRunStop: async () => ({ pid: 42, stop, release: () => {} }),
      isRunOwnedByThisProcess: () => false,
      isRunOwnerAnswering: async () => false,
      reclaimRunWorktree: async () => ({ warnings: [] }),
      reclaimContainerEnv: cleanup,
    });
    const result = await operations.cancelWorkflow(run.id, operator);
    expect(result.kind).toBe('stopped');
    expect(getById).toHaveBeenCalledWith('supplied-env');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith('supplied-env', isolation);
    expect(cancelled).toHaveBeenCalledTimes(1);

    cleanup.mockRejectedValueOnce(new Error('Docker unavailable'));
    cancelled.mockClear();
    await expect(operations.cancelWorkflow(run.id, operator)).rejects.toThrow('Docker unavailable');
    expect(cancelled).not.toHaveBeenCalled();
  });
});

// @archon-test-isolated
import {
  makeDeps,
  makeRun,
  makeStore,
  mockExecuteDagWorkflow,
  resetExecutorMocks,
  startWorkflow,
} from './executor/test-utils';
import { beforeEach, expect, mock, test } from 'bun:test';
import {
  holdRunSlotRelease,
  publishRunSlotRelease,
  subscribeRunSlotRelease,
} from './run-slot-release';
import { PackSettingsError } from './pack-settings';
import type { IWorkflowStore } from './store';

beforeEach(resetExecutorMocks);

test('pending pack-settings refusal publishes before any execution claim', async () => {
  const run = makeRun({ status: 'pending' });
  const store = makeStore();
  const order: string[] = [];
  store.failWorkflowRun = mock<IWorkflowStore['failWorkflowRun']>(async id => {
    order.push('commit');
    await publishRunSlotRelease(store, id);
    order.push('write returned');
    return { failed: true };
  });
  const deps = makeDeps(store);
  deps.loadConfig = async () => {
    throw new PackSettingsError('pack.settings.yaml: missing setting');
  };
  const claimed = mock(() => {});
  const dispose = subscribeRunSlotRelease(store, async ids => {
    expect(ids).toEqual([run.id]);
    order.push('drain');
  });
  try {
    await expect(
      startWorkflow({ deps, options: { preCreatedRun: run, onExecutionClaimed: claimed } })
    ).rejects.toThrow('missing setting');
    expect(claimed).not.toHaveBeenCalled();
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    expect(order).toEqual(['commit', 'write returned', 'drain']);
  } finally {
    dispose();
  }
});

test.each(['completed', 'failed'] as const)(
  '%s release waits for engine resource cleanup and live-owner close',
  async status => {
    const run = makeRun({ status });
    const store = makeStore({
      getWorkflowRun: mock(async () => run),
      getWorkflowRunStatus: mock(async () => status),
    });
    const order: string[] = [];
    const dispose = subscribeRunSlotRelease(store, async () => {
      order.push('drain');
    });
    const closeOwner = holdRunSlotRelease(store, run.id);
    mockExecuteDagWorkflow.mockImplementationOnce(async () => {
      await publishRunSlotRelease(store, run.id);
      order.push('nodes stopped');
      if (status === 'failed') throw new Error('DAG failed');
      return undefined;
    });
    try {
      const result = await startWorkflow({
        deps: {
          ...makeDeps(store),
          releaseRunResources: async () => {
            order.push('resources released');
          },
        },
      });
      expect(result.success).toBe(status === 'completed');
      expect(order).toEqual(['nodes stopped', 'resources released']);
      await closeOwner();
      expect(order).toEqual(['nodes stopped', 'resources released', 'drain']);
    } finally {
      await closeOwner();
      dispose();
    }
  }
);

test.each(['exception', 'warning'] as const)(
  'resource cleanup %s suppresses a concurrent cancellation release held by the executor',
  async outcome => {
    const run = makeRun({ status: 'cancelled' });
    const store = makeStore({
      getWorkflowRun: mock(async () => run),
      getWorkflowRunStatus: mock(async () => run.status),
    });
    const drained: string[] = [];
    const dispose = subscribeRunSlotRelease(store, async ids => {
      drained.push(...ids);
    });
    const closeOwner = holdRunSlotRelease(store, run.id);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    mockExecuteDagWorkflow.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return undefined;
    });
    try {
      const execution = startWorkflow({
        deps: {
          ...makeDeps(store),
          releaseRunResources: async () => {
            if (outcome === 'exception') throw new Error('container teardown failed');
            return ['image inventory is inconclusive'];
          },
        },
      });
      await entered.promise;
      await publishRunSlotRelease(store, run.id);
      expect(drained).toEqual([]);
      finish.resolve();
      await execution;
      await closeOwner();
      expect(drained).toEqual([]);
    } finally {
      finish.resolve();
      await closeOwner();
      dispose();
    }
  }
);

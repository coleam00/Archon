import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { runSubprocess } from '@archon/workflows/subprocess';
import { executionClaim } from '@archon/workflows/store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import {
  createInMemoryWorkflowStore,
  createInMemoryWorkflowHostStore,
} from '../test-support/workflow-store';
import { registerOwnedRunTermination } from './owned-run-termination';

const trackTempRoot = trackTempRoots();
const posixOnly = process.platform === 'win32' ? test.skip : test;
const strayPids: number[] = [];

async function runningRun(): Promise<WorkflowRun> {
  const store = createInMemoryWorkflowStore(createInMemoryWorkflowHostStore());
  const run = await store.createWorkflowRun({ workflow_name: 'signal', user_message: '' });
  const claimed = await store.claimPendingWorkflowRun(run.id);
  if (!claimed) throw new Error('Run was not claimed');
  return claimed;
}

afterEach(() => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntil(label: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

/**
 * Register the handler, start a node whose background job outlives a root-only kill,
 * deliver SIGTERM, and report what the handler did by the time it exits.
 */
async function interruptWithNodeInFlight(
  detachedProcessOwner: boolean,
  ownsExecution = true
): Promise<{
  descendant: number;
  descendantAliveAtFail: boolean;
  failedWith: unknown;
}> {
  const pidFile = join(trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-owned-run-'))), 'pid');
  let descendant = 0;
  let descendantAliveAtFail = false;
  let failedWith: unknown;
  const teardownSignals: string[] = [];
  let exited!: () => void;
  const exitCalled = new Promise<void>(resolve => {
    exited = resolve;
  });
  const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
    exited();
  }) as never);
  const run = await runningRun();
  const deregister = registerOwnedRunTermination({
    store: {
      failWorkflowRun: async (_runId, _error, reason) => {
        // Long enough for a tree ended before this write to have exited.
        await new Promise<void>(resolve => setTimeout(resolve, 300));
        descendantAliveAtFail = processExists(descendant);
        failedWith = reason;
        return { failed: ownsExecution };
      },
    },
    runId: 'run-1',
    getExecutionClaim: () => executionClaim(run.metadata),
    logModule: 'owned-run-termination.test',
    liveOwner: {
      close: async () => undefined,
      isStopRequested: () => false,
      registerTerminationPreparation: () => () => undefined,
    },
    detachedProcessOwner,
    teardown: async signal => {
      teardownSignals.push(signal);
    },
  });
  try {
    const node = runSubprocess(
      { kind: 'host' },
      '/bin/bash',
      ['-c', `/bin/sleep 30 & echo $! > '${pidFile}'; wait`],
      {
        cwd: import.meta.dir,
        timeout: 30_000,
        env: {},
        retention: { standalone: true },
        endTreeOnTimeout: true,
      }
    );
    node.catch(() => undefined);
    await waitUntil(
      'the descendant pid',
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''
    );
    descendant = Number(readFileSync(pidFile, 'utf8'));
    strayPids.push(descendant);

    process.emit('SIGTERM', 'SIGTERM');
    await exitCalled;
    expect(teardownSignals).toEqual(ownsExecution ? ['SIGTERM'] : []);

    return { descendant, descendantAliveAtFail, failedWith };
  } finally {
    deregister();
    exitSpy.mockRestore();
  }
}

posixOnly('an interrupt fails the run first, then ends the in-flight node tree', async () => {
  const result = await interruptWithNodeInFlight(false);

  expect(result.failedWith).toEqual({
    exitReason: 'process_terminated',
    signal: 'SIGTERM',
    expectedExecutionClaim: null,
  });
  expect(result.descendantAliveAtFail).toBe(true);
  await waitUntil('the descendant to exit', () => !processExists(result.descendant));
});

posixOnly('a genuine interrupt also ends detached command groups', async () => {
  const result = await interruptWithNodeInFlight(true);

  expect(result.failedWith).toEqual({
    exitReason: 'process_terminated',
    signal: 'SIGTERM',
    expectedExecutionClaim: null,
  });
  // A group kill returns once SIGKILL is sent; give it time to land before asserting.
  await new Promise<void>(resolve => setTimeout(resolve, 300));
  await waitUntil('the detached descendant to exit', () => !processExists(result.descendant));
});

for (const detached of [false, true]) {
  posixOnly(
    `a lost execution claim preserves process trees and container cleanup (detached: ${detached})`,
    async () => {
      const result = await interruptWithNodeInFlight(detached, false);
      expect(result.descendantAliveAtFail).toBe(true);
      expect(processExists(result.descendant)).toBe(true);
    }
  );
}

posixOnly(
  'detached preparation leaves owner resources intact when a stop is released and retried',
  async () => {
    const { startRunLiveOwner, requestRunLiveOwnerStop } = await import(
      '@archon/core/services/run-live-owner'
    );
    const runId = `teardown-${crypto.randomUUID()}`;
    const owner = await startRunLiveOwner(runId, { detachedProcessPid: process.pid });
    let teardownCalls = 0;
    const deregister = registerOwnedRunTermination({
      store: {
        failWorkflowRun: async () => {
          throw new Error('Controller owns the terminal write');
        },
      },
      runId,
      getExecutionClaim: () => null,
      logModule: 'owned-run-termination.test',
      liveOwner: owner,
      detachedProcessOwner: true,
      teardown: async () => {
        teardownCalls++;
      },
    });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const lease = await requestRunLiveOwnerStop(runId);
        try {
          expect(await lease.commit()).toEqual({ groups: [], warnings: [] });
          expect(teardownCalls).toBe(0);
        } finally {
          lease.release();
        }
        await waitUntil('the controller to disconnect', () => !owner.isStopRequested());
      }
    } finally {
      deregister();
      await owner.close();
    }
  }
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  for (const resumed of [false, true]) {
    test(`${signal} in-flight failure preserves a successor (predecessor resumed: ${resumed})`, async () => {
      const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-signal-claim-')));
      const { createFileWorkflowStore } = await import('@archon/workflows/file-store');
      const store = await createFileWorkflowStore({ root, getCodebase: async () => null });
      const run = await store.createWorkflowRun({ workflow_name: 'signal', user_message: '' });
      await store.claimPendingWorkflowRun(run.id);
      const approval = { nodeId: 'review', message: 'Review', type: 'approval' as const };
      if (resumed) {
        await store.pauseWorkflowRun(run.id, approval);
        await store.resumeWorkflowRun(run.id);
      }
      const predecessor = await store.getWorkflowRun(run.id);
      if (!predecessor) throw new Error('Missing predecessor');
      let entered!: () => void;
      const writeEntered = new Promise<void>(resolve => {
        entered = resolve;
      });
      let release!: () => void;
      const writeReleased = new Promise<void>(resolve => {
        release = resolve;
      });
      let exited!: () => void;
      const exitCalled = new Promise<void>(resolve => {
        exited = resolve;
      });
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => exited()) as never);
      const before = process.listeners(signal);
      const deregister = registerOwnedRunTermination({
        runId: run.id,
        getExecutionClaim: () => executionClaim(predecessor.metadata),
        logModule: 'owned-run-termination.test',
        store: {
          failWorkflowRun: async (...args) => {
            entered();
            await writeReleased;
            return store.failWorkflowRun(...args);
          },
        },
        liveOwner: {
          close: async () => undefined,
          isStopRequested: () => false,
          registerTerminationPreparation: () => () => undefined,
        },
        detachedProcessOwner: false,
      });
      try {
        const handler = process.listeners(signal).find(listener => !before.includes(listener));
        expect(handler).toBeDefined();
        handler?.(signal);
        await writeEntered;
        await store.pauseWorkflowRun(run.id, approval);
        deregister();
        await store.resumeWorkflowRun(run.id);
        const successor = await store.getWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        release();
        await exitCalled;
        expect(successor?.status).toBe('running');
        expect(await store.getWorkflowRun(run.id)).toEqual(successor);
        expect(await store.listWorkflowEvents(run.id)).toEqual(events);
      } finally {
        release();
        deregister();
        exitSpy.mockRestore();
      }
    });
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test.each(['paused', 'successor'] as const)(
    `${signal} preserves %s before predecessor retirement`,
    async state => {
      const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-signal-successor-')));
      const { createFileWorkflowStore } = await import('@archon/workflows/file-store');
      const store = await createFileWorkflowStore({ root, getCodebase: async () => null });
      const run = await store.createWorkflowRun({ workflow_name: 'signal', user_message: '' });
      await store.claimPendingWorkflowRun(run.id);
      let teardowns = 0;
      let exited!: () => void;
      const exitCalled = new Promise<void>(resolve => {
        exited = resolve;
      });
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => exited()) as never);
      const before = process.listeners(signal);
      const deregister = registerOwnedRunTermination({
        store,
        runId: run.id,
        getExecutionClaim: () => null,
        logModule: 'owned-run-termination.test',
        liveOwner: {
          close: async () => undefined,
          isStopRequested: () => false,
          registerTerminationPreparation: () => () => undefined,
        },
        detachedProcessOwner: false,
        teardown: async () => {
          teardowns++;
        },
      });
      try {
        await store.pauseWorkflowRun(run.id, {
          nodeId: 'review',
          message: 'Review',
          type: 'approval',
        });
        if (state === 'successor') await store.resumeWorkflowRun(run.id);
        const successor = await store.getWorkflowRun(run.id);
        const events = await store.listWorkflowEvents(run.id);
        const handler = process.listeners(signal).find(listener => !before.includes(listener));
        expect(handler).toBeDefined();
        handler?.(signal);
        await exitCalled;
        expect(await store.getWorkflowRun(run.id)).toEqual(successor);
        expect(await store.listWorkflowEvents(run.id)).toEqual(events);
        expect(teardowns).toBe(0);
      } finally {
        deregister();
        exitSpy.mockRestore();
      }
    }
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test.each(['rejected write', 'lost claim'] as const)(
    `${signal} warns when ownership cannot authorize cleanup (%s)`,
    async failure => {
      const exited = Promise.withResolvers<void>();
      const exit = spyOn(process, 'exit').mockImplementation((() => exited.resolve()) as never);
      const warning = spyOn(console, 'error').mockImplementation(() => undefined);
      const teardown = mock(async () => undefined);
      const before = process.listeners(signal);
      const deregister = registerOwnedRunTermination({
        store: {
          failWorkflowRun: async () => {
            if (failure === 'rejected write') throw new Error('store unavailable');
            return { failed: false };
          },
        },
        runId: 'unconfirmed-run',
        getExecutionClaim: () => 'old-claim',
        logModule: 'owned-run-termination.test',
        liveOwner: {
          close: async () => undefined,
          isStopRequested: () => false,
          registerTerminationPreparation: () => () => undefined,
        },
        detachedProcessOwner: false,
        teardown,
      });
      try {
        const handler = process.listeners(signal).find(listener => !before.includes(listener));
        expect(handler).toBeDefined();
        handler?.(signal);
        await exited.promise;
        expect(teardown).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(
            `run unconfirmed-run could not be confirmed as owned on ${signal}`
          )
        );
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining('archon workflow get unconfirmed-run')
        );
        expect(exit).toHaveBeenCalledWith(1);
      } finally {
        deregister();
        warning.mockRestore();
        exit.mockRestore();
      }
    }
  );
}

import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { runSubprocess } from '@archon/workflows/subprocess';
import { registerOwnedRunTermination } from './owned-run-termination';

const trackTempRoot = trackTempRoots();
const posixOnly = process.platform === 'win32' ? test.skip : test;
const strayPids: number[] = [];

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
async function interruptWithNodeInFlight(detachedProcessOwner: boolean): Promise<{
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
  const deregister = registerOwnedRunTermination({
    store: {
      getWorkflowRun: async () => null,
      listWorkflowEvents: async () => [],
      findChildRuns: async () => [],
      getWorkflowRunStatus: async () => 'running',
      failWorkflowRun: async (_runId, _error, reason) => {
        // Long enough for a tree ended before this write to have exited.
        await new Promise<void>(resolve => setTimeout(resolve, 300));
        descendantAliveAtFail = processExists(descendant);
        failedWith = reason;
        return { failed: true };
      },
    },
    runId: 'run-1',
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
    expect(teardownSignals).toEqual(['SIGTERM']);

    return { descendant, descendantAliveAtFail, failedWith };
  } finally {
    deregister();
    exitSpy.mockRestore();
  }
}

posixOnly('an interrupt fails the run first, then ends the in-flight node tree', async () => {
  const result = await interruptWithNodeInFlight(false);

  expect(result.failedWith).toEqual({ exitReason: 'process_terminated', signal: 'SIGTERM' });
  expect(result.descendantAliveAtFail).toBe(true);
  await waitUntil('the descendant to exit', () => !processExists(result.descendant));
});

posixOnly('a genuine interrupt also ends detached command groups', async () => {
  const result = await interruptWithNodeInFlight(true);

  expect(result.failedWith).toEqual({ exitReason: 'process_terminated', signal: 'SIGTERM' });
  // A group kill returns once SIGKILL is sent; give it time to land before asserting.
  await new Promise<void>(resolve => setTimeout(resolve, 300));
  await waitUntil('the detached descendant to exit', () => !processExists(result.descendant));
});

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
        getWorkflowRun: async () => null,
        listWorkflowEvents: async () => [],
        findChildRuns: async () => [],
        getWorkflowRunStatus: async () => 'running',
        failWorkflowRun: async () => {
          throw new Error('Controller owns the terminal write');
        },
      },
      runId,
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

for (const scope of ['run', 'descendant', 'container', 'agent'] as const) {
  posixOnly.each(['sh', 'bun', 'uv'] as const)(
    `a fresh detached owner classifies persisted %s history in ${scope} without targeting old groups`,
    async runtime => {
      const { createFileWorkflowStore } = await import('@archon/workflows/file-store');
      const { startRunLiveOwner, requestRunLiveOwnerStop } = await import(
        '@archon/core/services/run-live-owner'
      );
      const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-prior-command-')));
      const store = await createFileWorkflowStore({ root });
      const run = await store.createWorkflowRun({
        workflow_name: 'continued',
        working_path: root,
        user_message: '',
        metadata: scope === 'container' ? { isolation: 'container' } : {},
      });
      const evidenceRun =
        scope === 'descendant'
          ? await store.createWorkflowRun({
              workflow_name: 'child',
              working_path: root,
              user_message: '',
              parent_run_id: run.id,
            })
          : run;
      await store.persistWorkflowEvent({
        workflow_run_id: evidenceRun.id,
        event_type: 'node_started',
        step_name: 'completed',
        data: { type: scope === 'agent' ? 'agent' : runtime === 'sh' ? 'bash' : 'script', runtime },
      });
      await store.persistWorkflowEvent({
        workflow_run_id: evidenceRun.id,
        event_type: 'node_completed',
        step_name: 'completed',
        data: { type: scope === 'agent' ? 'agent' : runtime === 'sh' ? 'bash' : 'script', runtime },
      });
      const owner = await startRunLiveOwner(run.id, { detachedProcessPid: process.pid });
      const unregister = registerOwnedRunTermination({
        store,
        runId: run.id,
        logModule: 'test',
        liveOwner: owner,
        detachedProcessOwner: true,
      });
      try {
        const lease = await requestRunLiveOwnerStop(run.id);
        try {
          const prepared = await lease.commit();
          expect(prepared?.groups).toEqual([]);
          expect(prepared?.warnings).toEqual(
            scope === 'container' || scope === 'agent'
              ? []
              : [expect.stringContaining('may have left untracked background work')]
          );
        } finally {
          lease.release();
        }
      } finally {
        unregister();
        await owner.close();
      }
    }
  );
}

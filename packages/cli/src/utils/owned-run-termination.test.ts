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
  let exited!: () => void;
  const exitCalled = new Promise<void>(resolve => {
    exited = resolve;
  });
  const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
    exited();
  }) as never);
  const deregister = registerOwnedRunTermination({
    store: {
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

for (const outcome of ['success', 'failure', 'expiry'] as const) {
  posixOnly(
    `detached preparation waits for once-only teardown and reports ${outcome}`,
    async () => {
      const { startRunLiveOwner, requestRunLiveOwnerStop } = await import(
        '@archon/core/services/run-live-owner'
      );
      const runId = `teardown-${crypto.randomUUID()}`;
      const owner = await startRunLiveOwner(runId, { detachedProcessPid: process.pid });
      let calls = 0;
      let finish!: () => void;
      const cleanup = new Promise<void>((resolve, reject) => {
        finish = () =>
          outcome === 'failure' ? reject(new Error('fixture cleanup failure')) : resolve();
      });
      const deregister = registerOwnedRunTermination({
        store: {
          getWorkflowRunStatus: async () => 'running',
          failWorkflowRun: async () => {
            throw new Error('Controller owns the terminal write');
          },
        },
        runId,
        logModule: 'owned-run-termination.test',
        liveOwner: owner,
        detachedProcessOwner: true,
        teardown: async signal => {
          expect(signal).toBe('SIGTERM');
          calls++;
          await cleanup;
        },
      });
      const lease = await requestRunLiveOwnerStop(runId);
      try {
        let acknowledged = false;
        const committed = lease.commit().then(result => {
          acknowledged = true;
          return result;
        });
        await waitUntil('teardown to start', () => calls === 1);
        expect(acknowledged).toBe(false);
        if (outcome !== 'expiry') finish();
        const prepared = await committed;
        expect(prepared?.warnings).toHaveLength(outcome === 'success' ? 0 : 1);
        expect(calls).toBe(1);
        if (outcome === 'success') {
          lease.release();
          await waitUntil('the controller to disconnect', () => !owner.isStopRequested());
          const retry = await requestRunLiveOwnerStop(runId);
          try {
            expect((await retry.commit())?.warnings).toEqual([]);
          } finally {
            retry.release();
          }
          expect(calls).toBe(1);
        }
        if (outcome === 'failure') expect(prepared?.warnings[0]).toContain('cleanup failed');
        if (outcome === 'expiry') expect(prepared?.warnings[0]).toContain('exceeded');
      } finally {
        finish();
        lease.release();
        deregister();
        await owner.close();
      }
    },
    8000
  );
}

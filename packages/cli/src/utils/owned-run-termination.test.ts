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
async function interruptWithNodeInFlight(endNodeProcessTrees: boolean): Promise<{
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
      },
    },
    runId: 'run-1',
    logModule: 'owned-run-termination.test',
    liveOwner: { close: async () => undefined, isStopRequested: () => false },
    endNodeProcessTrees,
  });
  try {
    const node = runSubprocess(
      { kind: 'host' },
      '/bin/bash',
      ['-c', `/bin/sleep 30 & echo $! > '${pidFile}'; wait`],
      { cwd: import.meta.dir, timeout: 30_000, env: {}, retention: { standalone: true } }
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
  const result = await interruptWithNodeInFlight(true);

  expect(result.failedWith).toEqual({ exitReason: 'process_terminated', signal: 'SIGTERM' });
  expect(result.descendantAliveAtFail).toBe(true);
  await waitUntil('the descendant to exit', () => !processExists(result.descendant));
});

posixOnly('a detached owner leaves its node trees to the cancel controller', async () => {
  const result = await interruptWithNodeInFlight(false);

  expect(result.failedWith).toEqual({ exitReason: 'process_terminated', signal: 'SIGTERM' });
  // A group kill returns once SIGKILL is sent; give it time to land before asserting.
  await new Promise<void>(resolve => setTimeout(resolve, 300));
  expect(processExists(result.descendant)).toBe(true);
});

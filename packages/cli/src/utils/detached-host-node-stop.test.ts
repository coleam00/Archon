import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';
import { requestRunLiveOwnerStop, startRunLiveOwner } from '@archon/core/services/run-live-owner';
import {
  endRecordedNodeProcessTrees,
  recordNodeProcessTrees,
  runSubprocess,
} from '@archon/workflows/subprocess';

const trackTempRoot = trackTempRoots();
const posixTest = process.platform === 'win32' ? test.skip : test;
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

test('a stopped host node settles only after the controller releases its termination lease', async () => {
  const readyPath = join(
    trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-host-handoff-'))),
    'ready'
  );
  const runId = crypto.randomUUID();
  const trees = recordNodeProcessTrees(false);
  const owner = await startRunLiveOwner(runId, {
    detachedProcessPid: process.pid,
    beforeTerminate: endRecordedNodeProcessTrees,
  });
  let settled = false;
  const node = runSubprocess(
    { kind: 'host' },
    process.execPath,
    [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
    ],
    {
      cwd: import.meta.dir,
      timeout: 30_000,
      env: process.env,
      killTreeOnTimeout: true,
      retention: { standalone: true },
    }
  ).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  let lease: Awaited<ReturnType<typeof requestRunLiveOwnerStop>> | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(readyPath) || readFileSync(readyPath, 'utf8').trim() === '') {
      if (Date.now() >= deadline) throw new Error('Node did not start');
      await Bun.sleep(25);
    }
    const pid = Number(readFileSync(readyPath, 'utf8'));
    lease = await requestRunLiveOwnerStop(runId);
    await lease.commit();
    expect(alive(pid)).toBe(false);
    // Windows enumerates the owner's tree here before killing it. The executor
    // must not publish the node's forced exit as a workflow failure in that gap.
    await Bun.sleep(100);
    expect(settled).toBe(false);
    lease.release();
    await node;
    expect(settled).toBe(true);
  } finally {
    lease?.release();
    await owner.close();
    await trees.end();
    trees.release();
    await node;
  }
}, 15_000);
for (const mode of ['normal', 'survivor', 'timeout', 'max-buffer'] as const) {
  posixTest(
    `detached host node stop ${mode === 'normal' ? 'ends the node before success' : `refuses success when cleanup cannot be proved (${mode})`}`,
    async () => {
      const runId = crypto.randomUUID();
      const readyPath = join(
        trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-host-stop-'))),
        'ready'
      );
      const owner = spawn(
        process.execPath,
        [join(import.meta.dir, 'fixtures/detached-host-node-owner.ts'), runId, readyPath, mode],
        { detached: true, stdio: 'ignore' }
      );
      const ownerPid = owner.pid;
      if (ownerPid === undefined) throw new Error('Could not start owner');
      const exited = new Promise<void>(resolve => owner.once('exit', () => resolve()));
      let pids: { node: number; descendant?: number } | undefined;
      try {
        const deadline = Date.now() + 5000;
        while (!existsSync(readyPath)) {
          if (Date.now() >= deadline) throw new Error('Owner did not start node');
          await Bun.sleep(25);
        }
        pids = JSON.parse(readFileSync(readyPath, 'utf8'));
        if (!pids) throw new Error('Missing node pid');
        if (mode === 'timeout' || mode === 'max-buffer') {
          const failedDeadline = Date.now() + 10_000;
          while (!existsSync(`${readyPath}.failed`)) {
            if (Date.now() >= failedDeadline) throw new Error('Node cleanup did not fail');
            await Bun.sleep(25);
          }
        }
        const target = await requestDetachedRunStop(runId);
        if (mode === 'normal') {
          await target.stop();
          expect(alive(pids.node)).toBe(false);
          await exited;
        } else {
          await expect(target.stop()).rejects.toThrow();
          expect(alive(ownerPid)).toBe(true);
          if (pids.descendant === undefined) throw new Error('Missing descendant pid');
          expect(alive(pids.descendant)).toBe(true);
          const retry = await requestDetachedRunStop(runId);
          await expect(retry.stop()).rejects.toThrow();
        }
      } finally {
        for (const pid of [pids?.descendant, pids?.node, owner.pid]) {
          if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
        }
        await exited;
      }
    },
    20_000
  );
}

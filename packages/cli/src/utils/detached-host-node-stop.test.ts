import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';

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
for (const mode of ['normal', 'survivor'] as const) {
  posixTest(
    `detached host node stop ${mode === 'normal' ? 'ends the node before success' : 'refuses success when cleanup cannot be proved'}`,
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
    15_000
  );
}

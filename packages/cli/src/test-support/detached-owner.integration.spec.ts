import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { canConnectToRunLiveOwner, runLiveOwnerPath } from '@archon/core/services/run-live-owner';
import {
  DetachedRunOwnerUnavailableError,
  requestDetachedRunStop,
} from '@archon/core/services/run-owner-stop';
import { stopDetachedTestOwner } from './detached-owner';

const trackRoot = trackTempRoots();
interface TestOwner {
  runId: string;
  child: ChildProcess;
  exited: Promise<void>;
  pidFile: string;
  closedFile: string;
}

async function withOwner(mode: string, check: (owner: TestOwner) => Promise<void>): Promise<void> {
  const root = trackRoot(mkdtempSync(join(tmpdir(), 'archon-test-owner-')));
  const savedHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = join(root, 'home');
  const runId = crypto.randomUUID();
  const pidFile = join(root, 'owner.pid');
  const readyFile = join(root, 'ready');
  const closedFile = join(root, 'closed');
  const child = spawn(
    process.execPath,
    [
      join(import.meta.dir, 'fixtures/detached-owner.ts'),
      runId,
      mode,
      pidFile,
      readyFile,
      closedFile,
    ],
    { detached: true, stdio: 'ignore', env: { ...process.env, DATABASE_URL: '' } }
  );
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(readyFile)) {
      if (Date.now() >= deadline || child.exitCode !== null) throw new Error('Owner did not start');
      await Bun.sleep(10);
    }
    await check({ runId, child, exited, pidFile, closedFile });
  } finally {
    child.kill('SIGKILL');
    await exited;
    if (savedHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = savedHome;
  }
}

for (const mode of ['exit', 'live', 'gone'] as const) {
  // The live stop uses a POSIX process group; the fixture does not claim a Windows job.
  test.skipIf(process.platform === 'win32' && mode === 'live')(
    `detached cleanup accepts ${mode}`,
    async () => {
      await withOwner(mode, async ({ runId, child, exited, pidFile, closedFile }) => {
        if (mode === 'gone') {
          child.kill('SIGKILL');
          await exited;
        }
        await stopDetachedTestOwner(runId, pidFile);
        await exited;
        if (mode === 'exit') expect(existsSync(closedFile)).toBe(true);
      });
    }
  );
}

for (const mode of ['stay', 'closed'] as const) {
  test(`detached cleanup rejects an owner that stays alive: ${mode}`, async () => {
    await withOwner(mode, async ({ runId, child, pidFile }) => {
      if (mode === 'closed') {
        try {
          await requestDetachedRunStop(runId);
          throw new Error('Expected an unproven refusal');
        } catch (error) {
          expect(error).toBeInstanceOf(DetachedRunOwnerUnavailableError);
          if (!(error instanceof DetachedRunOwnerUnavailableError)) throw error;
          expect(error.reason).toBe('unproven');
        }
        expect(await canConnectToRunLiveOwner(runLiveOwnerPath(runId))).toBe(false);
      }
      await expect(stopDetachedTestOwner(runId, pidFile)).rejects.toThrow('still alive');
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    });
  });
}

test('detached cleanup preserves a not-detached refusal', async () => {
  await withOwner('not-detached', async ({ runId, pidFile }) => {
    await expect(stopDetachedTestOwner(runId, pidFile)).rejects.toMatchObject({
      reason: 'not_detached',
    });
  });
});

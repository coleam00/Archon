// @archon-test-isolated
import { describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { runLiveOwnerPath } from '@archon/core/services/run-live-owner';
import { DETACHED_RUN_FAILED_EXIT_CODE } from './workflow-exit-code';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';

import {
  DETACHED_RESUME_RECEIPT_ENV,
  waitForDetachedResumeReceipt,
} from './detached-resume-receipt';

// These fixtures are torn down after tests that spawn, and then kill, a real detached
// child. A killed process can still hold a handle inside its temp tree at the instant of
// cleanup, and an unretried removal fails a test whose assertions already passed (#2306).
const trackTempRoot = trackTempRoots();

/**
 * How long a spawned fixture process may take to reach the state a test polls for: to
 * signal that it is ready, or to be gone once the terminator stopped it.
 *
 * This was the default on `waitFor`. Naming it and removing the default means a wait that
 * needs a different window has to state one rather than inherit this.
 */
const FIXTURE_STATE_DEADLINE_MS = 5_000;

/**
 * For a test that runs a real stop. On Windows the test checks for survivors through
 * `Get-CimInstance`; once WMI is warm (see `WMI_WARM_UP_TIMEOUT_MS`) a listing takes 1-3 s.
 */
const STOP_TEST_TIMEOUT_MS = 30_000;

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture');
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
}

/** Wait for a spawned fixture process to reach the state `check` describes. */
async function waitForFixtureProcess(check: () => boolean): Promise<void> {
  await waitFor(check, FIXTURE_STATE_DEADLINE_MS);
}

function waitForExit(
  child: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Detached owner did not exit'));
    }, 8_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve: () => void, reject: (reason?: unknown) => void): void => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve: () => void): void => {
    server.close((): void => {
      resolve();
    });
  });
}

async function rejectedError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`Expected an Error rejection, received ${String(error)}`);
  }
  throw new Error('Expected the operation to reject');
}

/**
 * A control endpoint that hands out `pid` and commits the termination lease.
 *
 * The handshake is not what these tests are about: committing it puts the terminator
 * itself in front of a PID the test chose, which is the only way to stage a target
 * that is already gone, or one that is alive and out of reach.
 *
 * It reports `windowsJob` as the owner's job object name, or no job object when omitted,
 * as an owner from an older Archon version would.
 */
function stubOwner(pid: number, windowsJob?: string): Server {
  return createServer((socket: Socket): void => {
    socket.setEncoding('utf8');
    let request = '';
    socket.on('data', (chunk: string): void => {
      request += chunk;
      if (request.includes('stop\n')) {
        socket.write(`${JSON.stringify({ kind: 'detached', pid, windowsJob })}\n`);
        request = request.replace('stop\n', '');
      }
      if (request.includes('terminate\n')) {
        socket.write('ready\n');
        request = request.replace('terminate\n', '');
      }
    });
  });
}

describe('detached run control integration', () => {
  for (const closedLauncher of [false, true]) {
    it(`keeps the detached child executing (closed launcher: ${String(closedLauncher)})`, async () => {
      const fixtureDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-resume-receipt-')));
      const fixturePath = join(fixtureDir, 'receipt.ts');
      const continuedPath = join(fixtureDir, 'continued');
      const errorPath = join(fixtureDir, 'transport-error');
      writeFileSync(
        fixturePath,
        `
        import { consumeDetachedResumeReceiptRequest } from ${JSON.stringify(join(import.meta.dir, 'detached-resume-receipt.ts'))};
        import { writeFileSync } from 'node:fs';
        const notify = consumeDetachedResumeReceiptRequest((runId, error) => {
          writeFileSync(process.argv[3], JSON.stringify({ runId, code: error instanceof Error && 'code' in error ? error.code : null }));
        });
        setTimeout(() => {
          notify?.('fixture');
          writeFileSync(process.argv[2], 'continued');
        }, 100);
      `
      );
      const child = spawn(process.execPath, [fixturePath, continuedPath, errorPath], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
        env: { ...process.env, [DETACHED_RESUME_RECEIPT_ENV]: '1' },
      });
      const exit = waitForExit(child);
      try {
        const pipe = child.stdio[3];
        if (!pipe || !('readable' in pipe)) throw new Error('Missing receipt pipe');
        if (closedLauncher) {
          pipe.destroy();
          child.unref();
        } else {
          await waitForDetachedResumeReceipt(
            child,
            pipe,
            (code, signal) => new Error(`No receipt: ${String(code)} ${String(signal)}`)
          );
        }
        await waitForFixtureProcess(() => existsSync(continuedPath));
        expect(await exit).toEqual({ code: 0, signal: null });
        if (closedLauncher) {
          expect(JSON.parse(readFileSync(errorPath, 'utf8'))).toMatchObject({
            runId: 'fixture',
            code: 'EPIPE',
          });
        }
      } finally {
        if (child.pid !== undefined && processExists(child.pid)) child.kill();
      }
    });
  }

  for (const code of [0, DETACHED_RUN_FAILED_EXIT_CODE]) {
    it(`preserves exit ${String(code)} when the real child sends no receipt`, async () => {
      const child = spawn(process.execPath, ['-e', `process.exit(${String(code)})`], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      });
      const pipe = child.stdio[3];
      if (!pipe || !('readable' in pipe)) throw new Error('Missing receipt pipe');
      const error = await rejectedError(() =>
        waitForDetachedResumeReceipt(
          child,
          pipe,
          (exitCode, signal) => new Error(`No receipt: ${String(exitCode)} ${String(signal)}`)
        )
      );
      expect(error.message).toBe(`No receipt: ${String(code)} null`);
    });
  }

  it(
    'treats an already-gone target as a stopped tree, not a failed stop',
    async () => {
      // #2946: a gone tree must read as stopped, not as a failed stop that leaves the run
      // row saying `running`. POSIX only: a Windows stop needs the owner's job object, and
      // a live lease for a dead PID with no job is a state no real Windows owner produces.
      if (process.platform === 'win32') return;

      const runId = `already-gone-${crypto.randomUUID()}`;
      const path = runLiveOwnerPath(runId);
      const doomed = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      if (doomed.pid === undefined) throw new Error('Failed to spawn the short-lived target');
      const gonePid = doomed.pid;
      await waitForExit(doomed);
      // The premise, asserted rather than assumed: the terminator is aimed at nothing.
      await waitForFixtureProcess(() => !processExists(gonePid));

      const server = stubOwner(gonePid);
      await listen(server, path);
      try {
        const target = await requestDetachedRunStop(runId);
        // Resolving IS the assertion, and letting a rejection through reports the real
        // reason rather than a matcher's.
        await target.stop();
      } finally {
        await close(server);
        rmSync(path, { force: true });
      }
    },
    STOP_TEST_TIMEOUT_MS
  );

  it('still fails when the target is alive and the kill cannot reach it', async () => {
    // The guardrail for the tolerance above: an unreachable kill must never read as a
    // stopped tree, or the terminator stops protecting anything. Staged on POSIX,
    // where a live process that is not a group leader makes `kill(-pid)` raise the
    // same ESRCH that an entirely absent group raises — so only the follow-up check
    // on the process itself can tell the two apart. The Windows equivalent, a live
    // root that survives `taskkill /F`, needs a process the runner is not permitted
    // to kill and is not worth staging in CI.
    if (process.platform === 'win32') return;

    const runId = `alive-${crypto.randomUUID()}`;
    const path = runLiveOwnerPath(runId);
    // Not `detached`, so it joins this spec's process group and no process group
    // carrying its own PID exists for the terminator to signal.
    const survivor = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      stdio: 'ignore',
    });
    if (survivor.pid === undefined) throw new Error('Failed to spawn the surviving target');
    const survivorPid = survivor.pid;

    const server = stubOwner(survivorPid);
    await listen(server, path);
    try {
      const target = await requestDetachedRunStop(runId);
      const error = await rejectedError(async () => target.stop());
      expect(error.message).toContain('does not own process group');
      expect(processExists(survivorPid)).toBe(true);
    } finally {
      survivor.kill('SIGKILL');
      await close(server);
      rmSync(path, { force: true });
    }
  });

  it('refuses a marked POSIX owner that does not own its expected process group', async () => {
    if (process.platform === 'win32') return;

    const runId = `foreground-${crypto.randomUUID()}`;
    const fixtureDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-foreground-control-')));
    const readyPath = join(fixtureDir, 'ready');
    const leakPath = join(fixtureDir, 'leaked');
    const goPath = join(fixtureDir, 'go');
    const fixturePath = join(import.meta.dir, 'fixtures', 'detached-run-owner.ts');
    const owner = spawn(process.execPath, [fixturePath, runId, readyPath, leakPath, goPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (owner.pid === undefined) throw new Error('Failed to spawn foreground owner fixture');
    let stderr = '';
    owner.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });

    const result = await waitForExit(owner);
    expect(result.code).not.toBe(0);
    expect(stderr).toContain('does not own process group');
    expect(existsSync(readyPath)).toBe(false);
  });
});

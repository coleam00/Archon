import { describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { runLiveOwnerPath } from '@archon/core/services/run-live-owner';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';

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
 * For a test that runs a real stop. On Windows the stop reads the process table through
 * `Get-CimInstance`, and the first such query on a fresh runner took about 4 s.
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
 * `leaseMs` closes the lease that long after committing it, as a real owner does when
 * its termination lease lapses.
 */
function stubOwner(pid: number, leaseMs?: number): Server {
  return createServer((socket: Socket): void => {
    socket.setEncoding('utf8');
    let request = '';
    socket.on('data', (chunk: string): void => {
      request += chunk;
      if (request.includes('stop\n')) {
        socket.write(`${JSON.stringify({ kind: 'detached', pid })}\n`);
        request = request.replace('stop\n', '');
      }
      if (request.includes('terminate\n')) {
        socket.write('ready\n');
        request = request.replace('terminate\n', '');
        if (leaseMs !== undefined) setTimeout(() => socket.destroy(), leaseMs);
      }
    });
  });
}

describe('detached run control integration', () => {
  it(
    'stops the detached owner process group before its descendant can leak work',
    async () => {
      const runId = `tree-${crypto.randomUUID()}`;
      const fixtureDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-detached-control-')));
      const readyPath = join(fixtureDir, 'ready');
      const leakPath = join(fixtureDir, 'leaked');
      const goPath = join(fixtureDir, 'go');
      const fixturePath = join(import.meta.dir, 'fixtures', 'detached-run-owner.ts');
      const owner = spawn(process.execPath, [fixturePath, runId, readyPath, leakPath, goPath], {
        detached: true,
        stdio: 'ignore',
      });
      if (owner.pid === undefined) throw new Error('Failed to spawn detached owner fixture');
      const exited = waitForExit(owner);

      try {
        await waitForFixtureProcess(() => existsSync(readyPath));
        const pids = JSON.parse(readFileSync(readyPath, 'utf8')) as {
          owner: number;
          leakWriter: number;
        };
        // The descendant is live and armed before the stop: if the coming stop
        // failed to take the process group, it would remain able to act on the
        // go signal, so its death is a meaningful (not vacuous) transition.
        expect(pids.leakWriter).toBeGreaterThan(0);
        expect(processExists(pids.leakWriter)).toBe(true);
        const target = await requestDetachedRunStop(runId);
        await target.stop();
        await exited;
        // Event-driven proof instead of a fixed sleep: wait for the descendant's
        // observable death. A dead process cannot act on any future signal.
        await waitForFixtureProcess(() => !processExists(pids.leakWriter));
        writeFileSync(goPath, 'go');
        expect(existsSync(leakPath)).toBe(false);
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) {
          try {
            if (process.platform === 'win32') owner.kill();
            else process.kill(-owner.pid, 'SIGKILL');
          } catch {
            // The primary assertion reports failures; cleanup is best-effort for an already-gone fixture.
          }
        }
        if (process.platform !== 'win32') rmSync(runLiveOwnerPath(runId), { force: true });
      }
    },
    STOP_TEST_TIMEOUT_MS
  );

  it(
    'treats an already-gone target as a stopped tree, not a failed stop',
    async () => {
      // #2946: `taskkill /T` walks the tree PID by PID and exits non-zero when one of
      // them is already gone. Reading that exit code as failure made `archon workflow
      // cancel` report a failure on Windows for a run whose tree had in fact stopped,
      // and left the run row saying `running`. POSIX has always tolerated the same
      // condition as ESRCH; the contract is one tree-is-gone outcome on both branches.
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
        // reason rather than a matcher's. The old Windows branch rejected here, carrying
        // taskkill's "There is no running instance of the task" as a stop failure.
        await target.stop();
      } finally {
        await close(server);
        if (process.platform !== 'win32') rmSync(path, { force: true });
      }
    },
    STOP_TEST_TIMEOUT_MS
  );

  it(
    'does not report a Windows tree stopped while a descendant the first kill missed is alive',
    async () => {
      // #3466: `taskkill /T` kills the tree it saw when it started. A descendant spawned
      // while that walk runs survives it, and the old path then confirmed only the root.
      // The target here spawns a detached child every few milliseconds, so every stop
      // races at least one spawn. On Windows a detached child also breaks away from the
      // runtime's kill-on-close job, so nothing but the stop itself can end it. POSIX is
      // out of scope: a detached child there leaves the process group on purpose.
      if (process.platform !== 'win32') return;

      const runId = `spawner-${crypto.randomUUID()}`;
      const path = runLiveOwnerPath(runId);
      const kidsDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-spawner-')));
      // Each child's PID is recorded twice, by the spawner and by the child itself, as the
      // file's name, so a record can never be read half-written.
      const spawner = spawn(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process');",
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            'const dir = process.argv[1];',
            "const kid = \"require('node:fs').writeFileSync(require('node:path').join(process.argv[1], String(process.pid)), ''); setInterval(() => undefined, 1000);\";",
            'const loop = () => {',
            "  const child = spawn(process.execPath, ['-e', kid, dir], { detached: true, stdio: 'ignore' });",
            "  fs.writeFileSync(path.join(dir, String(child.pid)), '');",
            '  setTimeout(loop, 10);',
            '};',
            'loop();',
          ].join('\n'),
          kidsDir,
        ],
        { detached: true, stdio: 'ignore' }
      );
      if (spawner.pid === undefined) throw new Error('Failed to spawn the spawning target');
      const recordedKids = (): number[] => readdirSync(kidsDir).map(Number);

      const server = stubOwner(spawner.pid);
      await listen(server, path);
      try {
        // The target is spawning before the stop begins, so the race is live.
        await waitForFixtureProcess(() => recordedKids().length >= 3);
        const target = await requestDetachedRunStop(runId);
        await target.stop();

        // A stop that resolves claims the whole tree is gone. Check that claim against
        // every child the target ever recorded.
        expect(processExists(spawner.pid)).toBe(false);
        expect(recordedKids().filter(pid => processExists(pid))).toEqual([]);
      } finally {
        for (const pid of [spawner.pid, ...recordedKids()]) {
          try {
            process.kill(pid);
          } catch {
            // Already gone: the assertions above report a survivor.
          }
        }
        await close(server);
      }
    },
    STOP_TEST_TIMEOUT_MS
  );

  it(
    'reports an unconfirmed Windows stop, killing nothing, when an exited root left a child',
    async () => {
      // The root is gone before the stop, so nothing pins which process held its PID. A
      // process naming that PID as its parent may be an unrelated earlier holder's child,
      // so the stop must refuse to call the tree gone, and must not kill on the guess.
      if (process.platform !== 'win32') return;

      const runId = `orphaned-${crypto.randomUUID()}`;
      const path = runLiveOwnerPath(runId);
      const fixtureDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-orphaned-')));
      const childPidPath = join(fixtureDir, 'child');
      const root = spawn(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { detached: true, stdio: 'ignore' });",
            "require('node:fs').writeFileSync(process.argv[1], String(child.pid));",
            'process.exit(0);',
          ].join('\n'),
          childPidPath,
        ],
        { stdio: 'ignore' }
      );
      if (root.pid === undefined) throw new Error('Failed to spawn the exiting root');
      await waitForExit(root);
      const childPid = Number(readFileSync(childPidPath, 'utf8'));
      expect(processExists(childPid)).toBe(true);

      const server = stubOwner(root.pid);
      await listen(server, path);
      try {
        const target = await requestDetachedRunStop(runId);
        const error = await rejectedError(async (): Promise<void> => target.stop());
        expect(error.message).toContain('Could not confirm');
        expect(processExists(childPid)).toBe(true);
      } finally {
        try {
          process.kill(childPid);
        } catch {
          // Already gone: the assertion above reports it.
        }
        await close(server);
      }
    },
    STOP_TEST_TIMEOUT_MS
  );

  it(
    'kills nothing on Windows when the lease lapses before the kill',
    async () => {
      // The first process listing takes hundreds of milliseconds at least. A lease that
      // closes during it no longer proves the listed root is the owner, so the stop must
      // refuse rather than kill whatever now holds that PID.
      if (process.platform !== 'win32') return;

      const runId = `lapsed-${crypto.randomUUID()}`;
      const path = runLiveOwnerPath(runId);
      const target = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        stdio: 'ignore',
      });
      if (target.pid === undefined) throw new Error('Failed to spawn the target');
      const targetPid = target.pid;

      const server = stubOwner(targetPid, 50);
      await listen(server, path);
      try {
        const stop = await requestDetachedRunStop(runId);
        const error = await rejectedError(async (): Promise<void> => stop.stop());
        expect(error.message).toContain('released its termination lease before it was stopped');
        expect(processExists(targetPid)).toBe(true);
      } finally {
        target.kill();
        await close(server);
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
      const error = await rejectedError(async (): Promise<void> => target.stop());
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

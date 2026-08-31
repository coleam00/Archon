import { describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  canConnect,
  detachedRunControlPath,
  requestDetachedRunStop,
  startDetachedRunControlServer,
} from './detached-run-control';

// These fixtures are torn down after tests that spawn, and then kill, a real detached
// child. A killed process can still hold a handle inside its temp tree at the instant of
// cleanup, and an unretried removal fails a test whose assertions already passed (#2306).
const trackTempRoot = trackTempRoots();

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture');
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }
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
  } catch {
    return false;
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
      const rparen = stat.lastIndexOf(')');
      if (rparen !== -1) {
        const state = stat.slice(rparen + 2).split(' ')[0];
        return state !== 'Z';
      }
    } catch {
      return false;
    }
  }
  return true;
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
 */
function stubOwner(pid: number): Server {
  return createServer((socket: Socket): void => {
    socket.setEncoding('utf8');
    let request = '';
    socket.on('data', (chunk: string): void => {
      request += chunk;
      if (request.includes('stop\n')) {
        socket.write(`${JSON.stringify({ pid })}\n`);
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
  it('stops the detached owner process group before its descendant can leak work', async () => {
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
      await waitFor(() => existsSync(readyPath));
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
      await waitFor(() => !processExists(pids.leakWriter));
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
      if (process.platform !== 'win32') rmSync(detachedRunControlPath(runId), { force: true });
    }
  });

  it('treats an already-gone target as a stopped tree, not a failed stop', async () => {
    // #2946: `taskkill /T` walks the tree PID by PID and exits non-zero when one of
    // them is already gone. Reading that exit code as failure made `archon workflow
    // cancel` report a failure on Windows for a run whose tree had in fact stopped,
    // and left the run row saying `running`. POSIX has always tolerated the same
    // condition as ESRCH; the contract is one tree-is-gone outcome on both branches.
    const runId = `already-gone-${crypto.randomUUID()}`;
    const path = detachedRunControlPath(runId);
    const doomed = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    if (doomed.pid === undefined) throw new Error('Failed to spawn the short-lived target');
    const gonePid = doomed.pid;
    await waitForExit(doomed);
    // The premise, asserted rather than assumed: the terminator is aimed at nothing.
    await waitFor(() => !processExists(gonePid));

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
  });

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
    const path = detachedRunControlPath(runId);
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

  it('bounds owner shutdown when a controller retains an uncommitted stop lease', async () => {
    const runId = `retained-${crypto.randomUUID()}`;
    const endpointPath = detachedRunControlPath(runId);
    const owner = await startDetachedRunControlServer(runId);
    const client = createConnection(endpointPath);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    // The client never sends 'terminate' and never hangs up, so the owner-side
    // idle timeout is the only thing that can release close(). Assert the order
    // that timeout produces rather than measuring how long it took: an elapsed
    // floor against a real timer carries a couple of milliseconds of headroom
    // and fails whenever the timer and the clock disagree by that much (#2859).
    client.write('stop\n');
    await waitFor(() => owner.isStopRequested());

    const closing = owner.close();
    // close() is parked on the retained lease and has gone no further: it stops
    // the server and unlinks the endpoint only afterwards, so a close() that
    // ignored the lease would already have made this probe unreachable. Both
    // polarities are asserted, so a broken probe fails one of them rather than
    // quietly agreeing with itself.
    expect(await canConnect(endpointPath)).toBe(true);
    expect(owner.isStopRequested()).toBe(true);

    await closing;
    expect(owner.isStopRequested()).toBe(false);
    expect(await canConnect(endpointPath)).toBe(false);
    client.destroy();
  });

  it('fails when the owner closes before identifying itself', async () => {
    const runId = `close-before-pid-${crypto.randomUUID()}`;
    const path = detachedRunControlPath(runId);
    const server = createServer((socket: Socket): void => {
      socket.once('data', (): void => {
        socket.end();
      });
    });
    await listen(server, path);

    try {
      const error = await rejectedError(
        async (): Promise<unknown> => requestDetachedRunStop(runId)
      );
      expect(error.message).toMatch(/owner (?:ended|closed) before identifying itself/);
    } finally {
      await close(server);
      if (process.platform !== 'win32') rmSync(path, { force: true });
    }
  });

  it('fails when the owner closes before committing termination', async () => {
    const runId = `close-before-ready-${crypto.randomUUID()}`;
    const path = detachedRunControlPath(runId);
    const server = createServer((socket: Socket): void => {
      socket.setEncoding('utf8');
      let request = '';
      socket.on('data', (chunk: string): void => {
        request += chunk;
        if (request.includes('stop\n')) {
          socket.write(`${JSON.stringify({ pid: 12345 })}\n`);
          request = request.replace('stop\n', '');
        }
        if (request.includes('terminate\n')) socket.end();
      });
    });
    await listen(server, path);

    try {
      const target = await requestDetachedRunStop(runId);
      const error = await rejectedError(async (): Promise<void> => target.stop());
      expect(error.message).toMatch(/(?:ended|closed) before committing termination/);
    } finally {
      await close(server);
      if (process.platform !== 'win32') rmSync(path, { force: true });
    }
  });
});

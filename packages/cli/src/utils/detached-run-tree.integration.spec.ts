// @archon-test-isolated
// @archon-test-windows
/**
 * Stopping a real detached run owner and its whole process tree. On Windows a stop ends the
 * owner's job object and checks for survivors through WMI, so most cases here prove
 * Windows-only behaviour; the run-control tests that do not stop a tree are in
 * detached-run-control.integration.spec.ts.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  runLiveOwnerPath,
  isRunOwnedByThisProcess,
  isRunOwnerAnswering,
} from '@archon/core/services/run-live-owner';
import { createWorkflowOperations } from '@archon/core/operations/workflow-operations';
import { commit, createFileWorkflowStore } from '@archon/workflows/file-store';
import { createInMemoryWorkflowHostStore } from '../test-support/workflow-store';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';

const windowsOnly = it.skipIf(process.platform !== 'win32');
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
 * How long the `nested` Windows owner fixture may take to be ready: it starts its job
 * broker, which boots the CLI, and then a second owner through that broker.
 */
const NESTED_LAUNCH_DEADLINE_MS = 30_000;

/**
 * For a test that runs a real stop. On Windows the test checks for survivors through
 * `Get-CimInstance`; once WMI is warm (see `WMI_WARM_UP_TIMEOUT_MS`) a listing takes 1-3 s.
 */
const STOP_TEST_TIMEOUT_MS = 30_000;

/**
 * The first `Get-CimInstance` on a fresh Windows runner pays WMI's one-time start-up. It
 * took 6-8 s under CPU burners and up to 19 s under the full suite's load, where it pushed
 * the first stop test past `STOP_TEST_TIMEOUT_MS` while every later stop test passed in
 * seconds.
 * The cost is per machine, not per query: each listing runs in a fresh PowerShell and the
 * second one is already fast. So it is paid once before the stop tests, not inside one.
 */
const WMI_WARM_UP_TIMEOUT_MS = 90_000;

/**
 * For a stop against a real Windows owner fixture: the fixture's start-up, the stop, and
 * up to two survivor listings, each of which took 4-8 s on a Windows runner under CPU
 * load. This bounds a hang, not the stop's speed.
 */
const RACING_STOP_TEST_TIMEOUT_MS = 90_000;

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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

/**
 * PIDs of the live Windows processes whose command line contains `marker`. The marker
 * travels in the environment so that this query's own command line does not match it,
 * and the filter runs inside WMI so that a loaded runner is not made to serialize the
 * whole process table. `marker` must hold no WQL wildcard (`%`, `_`, `[`).
 */
async function windowsProcessesNaming(marker: string): Promise<number[]> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$pids = @(Get-CimInstance -ClassName Win32_Process -Filter "CommandLine LIKE \'%$($env:ARCHON_SPEC_MARKER)%\'" | ForEach-Object { [int]$_.ProcessId })',
    'ConvertTo-Json -Compress -InputObject $pids',
  ].join('\n');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { env: { ...process.env, ARCHON_SPEC_MARKER: marker }, windowsHide: true }
  );
  const pids: unknown = JSON.parse(stdout);
  if (!Array.isArray(pids) || !pids.every(pid => Number.isInteger(pid))) {
    throw new Error(`Unexpected process listing: ${stdout}`);
  }
  return pids as number[];
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

/**
 * Start `fixtures/windows-run-owner.ts` as a real detached run owner and wait until it is
 * ready. Its fixture directory's name is on the command line of every process in its tree.
 */
async function startWindowsRunOwner(
  mode: 'orphan' | 'orphan-exit' | 'trigger-exit' | 'spawner' | 'nested' | 'nested-approve'
): Promise<{
  runId: string;
  dir: string;
  marker: string;
  store: Awaited<ReturnType<typeof createFileWorkflowStore>>;
  exited: Promise<number | null>;
}> {
  const runId = `windows-${mode}-${crypto.randomUUID()}`;
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), `archon-windows-${mode}-`)));
  const store = await createFileWorkflowStore({ root: join(dir, 'parent-store') });
  await store.createWorkflowRun({ id: runId, workflow_name: mode, user_message: '' });
  await store.claimPendingWorkflowRun(runId);
  const fixturePath = join(import.meta.dir, 'fixtures', 'windows-run-owner.ts');
  const owner = spawn(process.execPath, [fixturePath, runId, dir, mode], {
    detached: true,
    stdio: 'ignore',
  });
  if (owner.pid === undefined) throw new Error('Failed to spawn the Windows run owner fixture');
  const exited = new Promise<number | null>(resolve => {
    owner.once('exit', resolve);
  });
  owner.unref();
  const marker = basename(dir);
  try {
    // A nested launch starts two owners and the job broker of each, so it gets a wider window.
    await waitFor(
      () => existsSync(join(dir, 'ready')),
      mode.startsWith('nested') ? NESTED_LAUNCH_DEADLINE_MS : FIXTURE_STATE_DEADLINE_MS
    );
  } catch (error) {
    // The caller's cleanup never runs for a fixture that did not become ready, and a
    // `spawner` owner would keep starting children; end its whole tree here. The readiness
    // error stays the one reported.
    const leftovers = await killWindowsProcessesNaming(marker).catch((cleanup: unknown) => [
      String(cleanup),
    ]);
    if (leftovers.length > 0) console.error(`Fixture cleanup: ${leftovers.join('; ')}`);
    throw error;
  }
  return { runId, dir, marker, store, exited };
}

function cancellationOperations(
  store: Awaited<ReturnType<typeof createFileWorkflowStore>>,
  beforeRecord: () => Promise<void>
) {
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected isolation or delete operation');
  };
  return createWorkflowOperations({
    store: {
      ...store,
      deleteWorkflowRun: unused,
      cancelWorkflowRun: async (...args) => {
        await beforeRecord();
        return store.cancelWorkflowRun(...args);
      },
    },
    hostStore: createInMemoryWorkflowHostStore(),
    getUserRole: async () => undefined,
    requestDetachedRunStop,
    isRunOwnedByThisProcess,
    isRunOwnerAnswering,
    reclaimRunWorktree: unused,
    reclaimContainerEnv: unused,
  });
}

/**
 * How long cleanup keeps ending a fixture tree. A `spawner` owner starts a child every 10 ms
 * until it is itself ended, so one pass can miss a child started after its listing; passes
 * repeat until one finds nothing.
 */
const CLEANUP_DEADLINE_MS = 30_000;

/**
 * One pass: end every process whose command line carries the marker now. A listed PID is
 * never killed by number: Windows reuses PIDs within seconds, and once handed one to
 * TrustedInstaller.exe (see below). Each process is opened first; the handle names that one
 * process for good, and its start time must match the listing's, so a process that reused
 * the PID since is left alone. A handle that cannot be opened is not one of this test's
 * processes, which run as the same user. Prints how many matched and every kill that failed.
 */
const KILL_PASS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$found = @(Get-CimInstance -ClassName Win32_Process -Filter "CommandLine LIKE \'%$($env:ARCHON_SPEC_MARKER)%\'")',
  '$failed = @()',
  'foreach ($entry in $found) {',
  '  try { $process = [System.Diagnostics.Process]::GetProcessById([int]$entry.ProcessId); $null = $process.Handle } catch { continue }',
  '  try {',
  '    if ([Math]::Abs(($process.StartTime - $entry.CreationDate).TotalMilliseconds) -gt 100) { continue }',
  '    $process.Kill()',
  '    if (-not $process.WaitForExit(5000)) { $failed += "$($entry.ProcessId) did not exit after Kill" }',
  '  } catch {',
  '    if (-not $process.HasExited) { $failed += "$($entry.ProcessId): $($_.Exception.Message)" }',
  '  } finally { $process.Dispose() }',
  '}',
  'ConvertTo-Json -Compress -InputObject @{ found = $found.Count; failed = @($failed) }',
].join('\n');

/**
 * End whatever `marker` still names, after a test that may have left survivors. Returns what
 * could not be ended: empty when a pass found nothing left.
 */
async function killWindowsProcessesNaming(marker: string): Promise<string[]> {
  const deadline = Date.now() + CLEANUP_DEADLINE_MS;
  for (;;) {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(KILL_PASS_SCRIPT, 'utf16le').toString('base64'),
      ],
      { env: { ...process.env, ARCHON_SPEC_MARKER: marker }, windowsHide: true }
    );
    const pass = JSON.parse(stdout) as { found: number; failed: string[] };
    if (pass.found === 0) return [];
    if (Date.now() >= deadline) {
      return [`${String(pass.found)} processes still name ${marker}`, ...pass.failed];
    }
  }
}

/**
 * Run `body`, then always `cleanup`, which returns what it could not end. A cleanup problem
 * fails a test that passed; after a failed test it is logged, so the test's own failure is
 * the one reported.
 */
async function withFixtureCleanup(
  body: () => Promise<void>,
  cleanup: () => Promise<string[]>
): Promise<void> {
  let failure: { error: unknown } | undefined;
  try {
    await body();
  } catch (error) {
    failure = { error };
  }
  let leftovers: string[];
  try {
    leftovers = await cleanup();
  } catch (error) {
    leftovers = [`cleanup failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (failure !== undefined) {
    if (leftovers.length > 0) console.error(`Fixture cleanup: ${leftovers.join('; ')}`);
    throw failure.error;
  }
  if (leftovers.length > 0) throw new Error(`Fixture cleanup: ${leftovers.join('; ')}`);
}

describe('detached run tree stop', () => {
  beforeAll(async (): Promise<void> => {
    // A fresh marker names no process; only the query's cost matters here.
    if (process.platform === 'win32') await windowsProcessesNaming(crypto.randomUUID());
  }, WMI_WARM_UP_TIMEOUT_MS);

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
      const ownerPid = owner.pid;

      await withFixtureCleanup(
        async () => {
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
          // The deadline starts once the stop resolves, so it measures the stop's effect
          // and not fixture startup on a loaded runner.
          await waitForFixtureProcess(() => owner.exitCode !== null || owner.signalCode !== null);
          // Event-driven proof instead of a fixed sleep: wait for the descendant's
          // observable death. A dead process cannot act on any future signal. Windows
          // reuses a dead PID fast enough that the recorded one may already name an
          // unrelated process, so there the descendant is found by the fixture directory
          // on its command line instead.
          if (process.platform === 'win32') {
            expect(await windowsProcessesNaming(basename(fixtureDir))).toEqual([]);
          } else {
            await waitForFixtureProcess(() => !processExists(pids.leakWriter));
          }
          writeFileSync(goPath, 'go');
          expect(existsSync(leakPath)).toBe(false);
        },
        async () => {
          // The descendant can outlive the owner (a stop that ended only the owner), and it
          // polls for the go signal forever, so it is ended whether or not the owner exited.
          if (process.platform === 'win32')
            return await killWindowsProcessesNaming(basename(fixtureDir));
          try {
            process.kill(-ownerPid, 'SIGKILL');
          } catch {
            // ESRCH: the group is already gone. The primary assertion reports failures.
          }
          rmSync(runLiveOwnerPath(runId), { force: true });
          return [];
        }
      );
    },
    STOP_TEST_TIMEOUT_MS
  );

  windowsOnly(
    'stops a Windows orphan grandchild before recording cancellation',
    async () => {
      // #3492: the owner started a child that started a grandchild and exited, so no
      // live process links the grandchild to the owner by parent PID. The grandchild is
      // detached, which takes it out of the runtime's own kill-on-close job.

      const { runId, dir, marker, store } = await startWindowsRunOwner('orphan');
      await withFixtureCleanup(
        async () => {
          const grandchild = Number(readFileSync(join(dir, 'grandchild'), 'utf8'));
          // The premise, asserted rather than assumed: the orphan is alive before the stop.
          expect(await windowsProcessesNaming(marker)).toContain(grandchild);

          let recorded = false;
          const operations = cancellationOperations(store, async () => {
            expect((await store.getWorkflowRun(runId))?.status).toBe('running');
            expect(await windowsProcessesNaming(marker)).toEqual([]);
            recorded = true;
          });
          const result = await operations.cancelWorkflow(runId, { kind: 'operator' });
          expect(result.kind).toBe('stopped');
          expect(recorded).toBe(true);
          expect((await store.getWorkflowRun(runId))?.status).toBe('cancelled');

          const survivors = await windowsProcessesNaming(marker);
          expect(survivors).toEqual([]);
        },
        () => killWindowsProcessesNaming(marker)
      );
    },
    RACING_STOP_TEST_TIMEOUT_MS
  );

  windowsOnly(
    'ends a Windows orphan grandchild when its owner exits by itself, with no stop',
    async () => {
      // #5988: a run that ends by itself gets no stop. The owner holds the only handle to its
      // kill-on-close job, so its exit is what ends a process a node left running. How the
      // owner exits does not matter to the job, so one exit stands for finishing, failing
      // and pausing.

      const { dir, marker, exited } = await startWindowsRunOwner('orphan-exit');
      await withFixtureCleanup(
        async () => {
          const grandchild = Number(readFileSync(join(dir, 'grandchild'), 'utf8'));
          // The premise, asserted rather than assumed: the orphan is alive before the exit.
          expect(await windowsProcessesNaming(marker)).toContain(grandchild);

          writeFileSync(join(dir, 'exit'), '');
          expect(await exited).toBe(0);
          // Windows ends the job's members as the owner's handle closes; give the
          // terminations a few listings to land rather than assume they are synchronous.
          let survivors = await windowsProcessesNaming(marker);
          const deadline = Date.now() + FIXTURE_STATE_DEADLINE_MS;
          while (survivors.length > 0 && Date.now() < deadline) {
            await new Promise<void>(resolve => setTimeout(resolve, 250));
            survivors = await windowsProcessesNaming(marker);
          }
          expect(survivors).toEqual([]);
        },
        () => killWindowsProcessesNaming(marker)
      );
    },
    RACING_STOP_TEST_TIMEOUT_MS
  );

  windowsOnly(
    'keeps a trigger executor its Windows owner started alive after that owner exits',
    async () => {
      // A run's end starts its follow-ups as trigger executors, which are other runs' owners.
      // The job is kill-on-close, so one started inside it would die with the owner that
      // started it; it must start outside the job and finish its own work. The fixture's
      // executor names no admitted request, so its work is to read the store and log that.
      // The test holds the store's lock until the owner has exited, so the executor cannot
      // log anything before then: a logged result shows it was alive after the owner died.

      const { dir, marker, exited } = await startWindowsRunOwner('trigger-exit');
      const log = join(dir, 'home', 'logs', `trigger-run-${marker}.log`);
      const executorDone = (): boolean =>
        existsSync(log) &&
        readFileSync(log, 'utf8').includes('Execution requires an admitted request');
      const storeRoot = join(dir, 'home', 'store');
      await createFileWorkflowStore({ root: storeRoot });
      await withFixtureCleanup(
        async () => {
          const grandchild = Number(readFileSync(join(dir, 'grandchild'), 'utf8'));
          expect(await windowsProcessesNaming(marker)).toContain(grandchild);

          let release!: () => void;
          const released = new Promise<void>(resolve => (release = resolve));
          let held!: () => void;
          const holding = new Promise<void>(resolve => (held = resolve));
          const lock = commit(storeRoot, [], async () => {
            held();
            await released;
            return { result: undefined, changes: {} };
          });
          try {
            await holding;
            writeFileSync(join(dir, 'exit'), '');
            expect(await exited).toBe(0);
            // Kept short: the executor gives up waiting for the lock after 10 seconds.
            expect(executorDone()).toBe(false);
          } finally {
            release();
            await lock;
          }
          await waitFor(executorDone, NESTED_LAUNCH_DEADLINE_MS);
          // The owner's own leftovers still ended with it.
          expect(await windowsProcessesNaming(marker)).not.toContain(grandchild);
        },
        () => killWindowsProcessesNaming(marker)
      );
    },
    RACING_STOP_TEST_TIMEOUT_MS
  );

  windowsOnly(
    'does not report a Windows tree stopped while a descendant the first kill missed is alive',
    async () => {
      // #3466: a kill that walks the tree misses a descendant spawned during the walk. The
      // owner here keeps spawning a detached child every 10 ms, so a stop is likely to race
      // a spawn; nothing forces one to overlap, so a run where none does still passes. What
      // the test proves either way is the claim a resolved stop makes: no process of the
      // tree survives. Each child is created inside the owner's job object, so the stop
      // keeps terminating the job until it holds no process. A detached child leaves only
      // the runtime's own job, not the owner's. POSIX is out of scope: a detached child
      // there leaves the process group on purpose.

      const { runId, dir, marker } = await startWindowsRunOwner('spawner');
      // Every process in the tree carries `marker` on its command line, which is how the
      // check below finds a survivor. A recorded PID cannot: Windows hands a killed child's
      // PID to unrelated processes within the stop's own runtime, and one such reuser
      // (TrustedInstaller.exe) once failed this test as a "survivor".
      await withFixtureCleanup(
        async () => {
          // The owner is spawning before the stop begins.
          await waitForFixtureProcess(() => readdirSync(join(dir, 'kids')).length >= 3);
          const target = await requestDetachedRunStop(runId);
          await target.stop();

          // A stop that resolves claims the whole tree is gone. Check that claim against
          // every process that belongs to the tree, the owner included.
          const survivors = await windowsProcessesNaming(marker);
          expect(survivors).toEqual([]);
        },
        () => killWindowsProcessesNaming(marker)
      );
    },
    RACING_STOP_TEST_TIMEOUT_MS
  );

  for (const mode of ['nested', 'nested-approve'] as const) {
    windowsOnly(
      `leaves a Windows ${mode} run running and owned when its launcher is cancelled`,
      async () => {
        // The launching run's job object holds every process the run starts, so a detached
        // owner launched from a node would die with it. `--detach` goes through the job
        // broker instead, so the child owner starts outside the job, and stopping it stays
        // the operator's call.

        const { runId, dir, marker, store } = await startWindowsRunOwner(mode);
        await withFixtureCleanup(
          async () => {
            const childRunId = readFileSync(join(dir, 'child-run-id'), 'utf8');
            const childStore = await createFileWorkflowStore({ root: join(dir, 'home', 'store') });
            await waitFor(() => existsSync(join(dir, 'child-ready')), NESTED_LAUNCH_DEADLINE_MS);
            const childPid = Number(readFileSync(join(dir, 'child-ready'), 'utf8'));
            // The lease only reads the child owner's PID; it is released before the parent's
            // cancel so that nothing this test holds keeps the child owner busy.
            const childLease = await requestDetachedRunStop(childRunId);
            const childOwnerPid = childLease.pid;
            childLease.release();

            const operations = cancellationOperations(store, async () => {
              expect((await store.getWorkflowRun(runId))?.status).toBe('running');
            });
            const parent = await operations.cancelWorkflow(runId, { kind: 'operator' });
            if (parent.kind !== 'stopped') throw new Error('Parent was not stopped');
            expect((await store.getWorkflowRun(runId))?.status).toBe('cancelled');

            const remaining = await windowsProcessesNaming(marker);
            expect(remaining).toContain(childPid);
            expect(remaining).toContain(childOwnerPid);
            expect(remaining).not.toContain(parent.pid);
            expect((await childStore.getWorkflowRun(childRunId))?.status).toBe('running');
            // The child is still owned: its owner hands out a fresh lease, and that lease stops it.
            const ownedChild = await requestDetachedRunStop(childRunId);
            try {
              expect(ownedChild.pid).toBe(childOwnerPid);
            } catch (error) {
              ownedChild.release();
              throw error;
            }
            await ownedChild.stop();

            const survivors = await windowsProcessesNaming(marker);
            expect(survivors).toEqual([]);
          },
          () => killWindowsProcessesNaming(marker)
        );
      },
      RACING_STOP_TEST_TIMEOUT_MS
    );
  }

  windowsOnly(
    'refuses a Windows owner that reported no job object, killing nothing',
    async () => {
      // An owner from an Archon version without job objects. Nothing can show its whole
      // tree gone, so the stop must refuse before it kills anything.

      const runId = `jobless-${crypto.randomUUID()}`;
      const path = runLiveOwnerPath(runId);
      const target = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        stdio: 'ignore',
      });
      if (target.pid === undefined) throw new Error('Failed to spawn the target');
      const targetPid = target.pid;

      const server = stubOwner(targetPid);
      await listen(server, path);
      try {
        const stop = await requestDetachedRunStop(runId);
        const error = await rejectedError(async () => stop.stop());
        expect(error.message).toContain('Could not confirm');
        expect(error.message).toContain('reported no job object');
        expect(processExists(targetPid)).toBe(true);
      } finally {
        target.kill();
        await close(server);
      }
    },
    STOP_TEST_TIMEOUT_MS
  );

  windowsOnly(
    'refuses a Windows owner whose job object cannot be opened, killing nothing',
    async () => {
      // The owner names a job that does not exist. A job the stop cannot open proves
      // nothing about the tree, so the stop must refuse before it kills anything.

      const runId = `unopenable-job-${crypto.randomUUID()}`;
      const path = runLiveOwnerPath(runId);
      const target = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        stdio: 'ignore',
      });
      if (target.pid === undefined) throw new Error('Failed to spawn the target');
      const targetPid = target.pid;

      const server = stubOwner(targetPid, `Global\\archon-run-${crypto.randomUUID()}`);
      await listen(server, path);
      try {
        const stop = await requestDetachedRunStop(runId);
        const error = await rejectedError(async () => stop.stop());
        expect(error.message).toContain('Could not confirm');
        expect(error.message).toContain('its job object could not be opened');
        expect(processExists(targetPid)).toBe(true);
      } finally {
        target.kill();
        await close(server);
      }
    },
    STOP_TEST_TIMEOUT_MS
  );
});

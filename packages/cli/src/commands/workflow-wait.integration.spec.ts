/**
 * `archon workflow wait <run-id>` against a REAL detached run, in a second process.
 *
 * This is #2745's regression boundary: the launching command returns, a separate
 * process waits on the run id it was handed, and that wait — not a `workflow get`
 * loop — is what learns the outcome. Every case here runs `wait` as its own OS
 * process against a real SQLite database, so a wake that only works in-process
 * would fail here.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { requestRunLiveOwnerStop } from '@archon/core/services/run-live-owner';
import { requestDetachedRunStop } from '../utils/detached-run-control';

const cleanupPaths: string[] = [];
const activeRunIds = new Set<string>();
const foregroundOwners = new Set<ForegroundOwner>();

// One explicit hook, not `trackTempRoots()`: a still-running owner has to be stopped
// before its tree can go, and two hooks would leave registration order as the only
// thing keeping that correct.
afterEach(async () => {
  await stopForegroundOwners();
  for (const runId of activeRunIds) {
    try {
      const target = await requestDetachedRunStop(runId);
      await target.stop();
    } catch {
      // A completed owner has already removed its endpoint.
    }
  }
  activeRunIds.clear();
  for (const path of cleanupPaths.splice(0)) {
    await removeTempTree(path);
  }
});

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');

interface Fixture {
  projectRoot: string;
  archonHome: string;
}

function makeFixture(
  prefix: string,
  workflows: Record<string, string>,
  options: { gitInit?: boolean } = {}
): Fixture {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(fixtureRoot);
  const archonHome = join(fixtureRoot, 'home');
  const projectRoot = join(fixtureRoot, 'project');
  const workflowsDir = join(projectRoot, '.archon', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(workflowsDir, `${name}.yaml`), body);
  }
  if (options.gitInit) {
    // The CLI's pre-dispatch gate accepts a git repo OR a registered folder project.
    // Tests that launch a run register the folder on the way in; a test that only
    // runs `wait` has to be a repo.
    Bun.spawnSync(['git', 'init', '-q', projectRoot]);
  }
  return { projectRoot, archonHome };
}

async function runCli(
  fixture: Fixture,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: fixture.projectRoot,
    env: { ...process.env, ARCHON_HOME: fixture.archonHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

interface ForegroundOwner {
  child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  settled: Promise<number>;
  output: { stdout: string; stderr: string };
}

function startForegroundOwner(fixture: Fixture, args: string[]): ForegroundOwner {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: fixture.projectRoot,
    env: { ...process.env, ARCHON_HOME: fixture.archonHome },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = { stdout: '', stderr: '' };
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    key: keyof typeof output
  ): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output[key] += decoder.decode(chunk, { stream: true });
    output[key] += decoder.decode();
  };
  const settled = Promise.all([
    child.exited,
    drain(child.stdout, 'stdout'),
    drain(child.stderr, 'stderr'),
  ]).then(([exitCode]) => exitCode);
  // Teardown still observes stream failures when discovery fails before awaiting exit.
  settled.catch(() => undefined);
  const owner = { child, settled, output };
  foregroundOwners.add(owner);
  return owner;
}

async function stopForegroundOwners(): Promise<void> {
  for (const owner of foregroundOwners) {
    if (owner.child.exitCode === null && owner.child.signalCode === null)
      owner.child.kill('SIGKILL');
    await owner.child.exited;
    await owner.settled;
    foregroundOwners.delete(owner);
  }
}

function ownerDiagnostics(owner: ForegroundOwner): string {
  return `owner pid ${String(owner.child.pid)}, exit ${String(owner.child.exitCode)}, signal ${String(owner.child.signalCode)}\nstdout:\n${owner.output.stdout}\nstderr:\n${owner.output.stderr}`;
}

/**
 * Assert the wait's exit code, naming the JSON envelope when it disagrees.
 *
 * `--json` always emits a reason — a failed wait writes `{ ok: false, error }` — and a
 * bare `expect(exitCode).toBe(0)` throws it away, leaving "expected 0, received 1" as
 * the only diagnostic. Windows CI failed five of these at once and reported nothing
 * about why; the reason was sitting in the payload the whole time.
 */
function expectWaitExit(
  result: { exitCode: number; payload: Record<string, unknown> },
  expected: number
): void {
  if (result.exitCode !== expected) {
    throw new Error(
      `wait exited ${String(result.exitCode)}, expected ${String(expected)} — payload: ${JSON.stringify(result.payload)}`
    );
  }
}

interface PendingWait {
  /**
   * Resolve once the wait has said, on stderr, that it is watching the run.
   *
   * This is the ordering a caller cannot otherwise establish. `waitForRunAttention`
   * is durable, so a waiter that attaches after a transition reports exactly the same
   * payload as one that was watching when it happened — which means a test can only
   * claim the wake half of the contract if it knows the watch had begun. Sleeping
   * first only made that likely; this makes it true or fails loudly.
   *
   * Rejects with everything the process wrote when it exits without announcing,
   * rather than leaving the caller to time out on a promise that will never settle.
   */
  attached(): Promise<{ observedStatus: string }>;
  settled(): Promise<{ exitCode: number; payload: Record<string, unknown> }>;
}

/** Start `workflow wait` as its own process without awaiting it. */
function startWait(fixture: Fixture, runId: string, timeoutSeconds: number): PendingWait {
  const child = Bun.spawn(
    [
      process.execPath,
      CLI_PATH,
      'workflow',
      'wait',
      runId,
      '--json',
      '--timeout',
      String(timeoutSeconds),
    ],
    {
      cwd: fixture.projectRoot,
      env: { ...process.env, ARCHON_HOME: fixture.archonHome },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  let announce: ((progress: { observedStatus: string }) => void) | undefined;
  let abandon: ((error: Error) => void) | undefined;
  const attached = new Promise<{ observedStatus: string }>((resolve, reject) => {
    announce = resolve;
    abandon = reject;
  });
  // A test that never asks about the attachment must not turn a legitimately
  // unannounced exit into an unhandled rejection.
  attached.catch(() => undefined);

  // One drain owns stderr: it hands the progress line over as it arrives and keeps
  // the whole text for `settled()`'s diagnostics. Two readers of the same stream
  // would leave which one saw what up to scheduling.
  const stderrText = (async (): Promise<string> => {
    const decoder = new TextDecoder();
    let text = '';
    let scanned = 0;
    const scan = (): void => {
      for (
        let newline = text.indexOf('\n', scanned);
        announce && newline !== -1;
        newline = text.indexOf('\n', scanned)
      ) {
        const line = text.slice(scanned, newline).trim();
        scanned = newline + 1;
        // Scan lines rather than assume the first one: `--json` silences logging, so
        // the progress envelope is normally alone here, but a diagnostic on stderr
        // must not be mistaken for it.
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const progress = parsed as { result?: unknown; observedStatus?: unknown };
        if (progress.result === 'waiting' && typeof progress.observedStatus === 'string') {
          announce({ observedStatus: progress.observedStatus });
          announce = undefined;
        }
      }
    };
    for await (const chunk of child.stderr) {
      text += decoder.decode(chunk, { stream: true });
      scan();
    }
    text += decoder.decode();
    scan();
    // Only when nothing was announced — `announce` is cleared the moment it fires.
    if (announce) abandon?.(new Error(`wait exited without announcing that it attached: ${text}`));
    return text;
  })();

  return {
    attached: (): Promise<{ observedStatus: string }> => attached,
    async settled(): Promise<{ exitCode: number; payload: Record<string, unknown> }> {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        stderrText,
      ]);
      // `--json` silences logging, so stdout is exactly one (pretty-printed) document.
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(stdout.trim()) as Record<string, unknown>;
      } catch {
        throw new Error(`wait emitted no JSON (exit ${String(exitCode)}): ${stdout}${stderr}`);
      }
      return { exitCode, payload };
    },
  };
}

/**
 * Launch a detached run and return the id its ack carried (#2872).
 *
 * The process spawned here is the launcher, not the run's owner: it forks the owner
 * into its own process group, waits a fixed startup window, acks, and exits 0. A
 * caller therefore gets a run id and no owner handle, which is why the boot waits on
 * these runs pass no `owner` — see `waitForRunBoot`. The one failure this does cover
 * is a child that dies inside that startup window: the launcher exits non-zero and
 * the throw below carries its output.
 */
async function launchDetached(
  fixture: Fixture,
  workflow: string
): Promise<{ runId: string; conversationId: string }> {
  const conversationId = `wait-${workflow}-${crypto.randomUUID()}`;
  const { exitCode, stdout, stderr } = await runCli(fixture, [
    'workflow',
    'run',
    workflow,
    'run-attention wait integration',
    '--folder',
    '--detach',
    '--json',
    '--conversation-id',
    conversationId,
  ]);
  if (exitCode !== 0) throw new Error(`Detached launcher failed: ${stderr || stdout}`);
  const ack = JSON.parse(stdout.trim()) as { runId?: unknown };
  if (typeof ack.runId !== 'string') throw new Error(`ack carried no run id: ${stdout}`);
  activeRunIds.add(ack.runId);
  return { runId: ack.runId, conversationId };
}

const SLOW_SUCCESS =
  'name: wait-success\ndescription: Detached success fixture.\n' +
  'nodes:\n  - id: finish\n    bash: "sleep 1; echo done"\n';
const SLOW_FAILURE =
  'name: wait-failure\ndescription: Detached failure fixture.\n' +
  'nodes:\n  - id: fail\n    bash: "sleep 1; echo failed >&2; exit 42"\n';
// `interactive: true` is refused for background dispatch by design (#2738), so this
// one runs in the foreground OF ANOTHER PROCESS — which is the property that matters:
// the waiter is not in the process that owns the run. The warm-up node is what lets
// the waiter attach BEFORE the gate exists, so the gate is a wake and not a read.
const GATED =
  'name: wait-gated\ndescription: Out-of-process gate fixture.\ninteractive: true\n' +
  'nodes:\n  - id: warmup\n    bash: "sleep 3; echo ready"\n' +
  '  - id: review\n    depends_on: [warmup]\n    approval:\n      message: Approve the plan?\n';

/** The newest run of `workflowName`, read straight from the database file. */
function readRunId(archonHome: string, workflowName: string): string | undefined {
  const databasePath = join(archonHome, 'archon.db');
  if (!existsSync(databasePath)) return undefined;
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .query<{ id: string }, [string]>(
        `SELECT id FROM remote_agent_workflow_runs
         WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1`
      )
      .get(workflowName)?.id;
  } finally {
    database.close();
  }
}

/** The status of one run, read straight from the database file. */
function readRunStatus(archonHome: string, runId: string): string | undefined {
  const databasePath = join(archonHome, 'archon.db');
  if (!existsSync(databasePath)) return undefined;
  const database = new Database(databasePath, { readonly: true });
  try {
    return database
      .query<{ status: string }, [string]>(
        `SELECT status FROM remote_agent_workflow_runs
         WHERE id = ?`
      )
      .get(runId)?.status;
  } finally {
    database.close();
  }
}

/**
 * One node's persisted completion output, read straight from the events table.
 *
 * A wait node's fixed `{ status, waited_ms }` contract is the engine's own record of
 * what happened, so it proves more than wall-clock timing: `waited_ms` shows the
 * deadline was genuinely waited instead of short-circuited, and `status` distinguishes
 * a satisfied wait from an expired one.
 */
function readNodeCompletedOutput(
  archonHome: string,
  runId: string,
  nodeId: string
): Record<string, unknown> | undefined {
  const databasePath = join(archonHome, 'archon.db');
  if (!existsSync(databasePath)) return undefined;
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .query<{ data: string }, [string, string]>(
        `SELECT data FROM remote_agent_workflow_events
         WHERE workflow_run_id = ? AND step_name = ? AND event_type = 'node_completed'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(runId, nodeId);
    if (!row) return undefined;
    const data = JSON.parse(row.data) as { structured_output?: unknown; node_output?: unknown };
    const output = data.structured_output ?? data.node_output;
    const parsed = typeof output === 'string' ? (JSON.parse(output) as unknown) : output;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    // The owner creates archon.db before applying the schema and Windows can widen
    // the commit window (#2306); the caller polls, so a transient read is not a result.
    return undefined;
  } finally {
    database.close();
  }
}

/**
 * Poll `read` until it produces a value, naming `what` if it never does.
 *
 * The catch is load bearing, not defensive: an owner process creates `archon.db`
 * BEFORE it applies the schema, so a reader that opens the file inside that window
 * gets `SQLiteError: no such table` out of `prepare()` — a throw, not an empty
 * result. Windows widens the same window to `disk I/O error` while a commit settles
 * (#2306). `workflow-terminal-event.integration.spec.ts` catches for exactly this
 * reason; a bare loop here would surface a startup race as a test failure.
 *
 * `timeoutMs` has no default on purpose. It used to default to 30 s, and the sites
 * waiting on one condition — a run booting — split into one that named a deadline and
 * two that inherited it silently, so nothing moved them together when 30 s turned out
 * to be wrong on Windows (#3288). Every caller states its own; the boot ones state it
 * through `waitForRunBoot` below.
 */
async function waitFor<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  owner?: ForegroundOwner
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    // Observe exit before the read, so a row committed just before exit gets a final read.
    const ownerExited = owner && (owner.child.exitCode !== null || owner.child.signalCode !== null);
    try {
      const value = await read();
      lastError = undefined;
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (owner) {
      if (ownerExited) {
        await owner.settled;
        throw new Error(`Owner exited before ${what}: ${ownerDiagnostics(owner)}`, {
          cause: lastError,
        });
      }
      await Promise.race([Bun.sleep(50), owner.settled]);
    } else {
      await Bun.sleep(50);
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(
    `Timed out waiting for ${what}${detail}${owner ? `\n${ownerDiagnostics(owner)}` : ''}`
  );
}

/**
 * How long a run launched in another process may take to boot far enough to be
 * observable: to apply the schema and write its row, and to reach `running`.
 *
 * This is a SETUP deadline and not a test budget. Every site that uses it is waiting
 * for the fixture to exist so the contract can begin; the contract's own deadline is
 * the `--timeout` handed to `startWait`, which none of this moves. #2924's standing
 * rule against fixing a Windows failure with a budget bump is intact — the `}, N)`
 * budgets below are untouched, and they were never what expired.
 *
 * 30 s was the old value and it was too small: on Windows CI this poll spent all of it
 * and gave up reporting `no such table: remote_agent_workflow_runs`, so the launcher
 * had created `archon.db` and had not yet applied the schema (#3288).
 *
 * The value has to clear the boots that runner completes when it is healthy by enough
 * that missing it means stuck rather than slow, and stay under the `}, N)` budgets so a
 * stall surfaces as `Timed out waiting for …` carrying what the wait knows, rather than
 * as Bun cutting the test off with nothing to read. #3288 holds the boot times it was
 * picked against. Those are one reading of one runner, and the margin over the slowest
 * healthy sample in that reading is real but not generous — which is what the `[boot]`
 * line below is for: the next Windows run reports a number instead of leaving the next
 * person to infer one.
 *
 * Do not read the original failure as "the launcher was alive and slow". That sample
 * predates the owner-exit guard in `waitFor`, so it could not tell a slow launcher from
 * a dead one. A boot that has an owner now fails fast with the launcher's streams
 * instead of spending this deadline; a detached boot has none — see `waitForRunBoot`.
 */
const RUN_BOOT_DEADLINE_MS = 90_000;

/**
 * Wait for a run launched in another process to boot, recording how long it took.
 *
 * The duration is why this exists rather than three calls naming the constant. Raising
 * a deadline without a signal only makes a stall take longer to appear; a boot creeping
 * toward the ceiling should be a number climbing in the CI transcript, visible before
 * it fails again. One line per boot, and none on the failure path — `waitFor` already
 * reports that one.
 *
 * `owner` is optional because only some boots have one to offer. A run launched in the
 * foreground of another process is this process's child, so `waitFor` sees it die and
 * fails in milliseconds carrying its streams. A detached run hands back no such handle
 * (`launchDetached`), and the alternatives are worse than the gap: the launcher exits 0
 * by design, so passing it would fail every healthy boot that needs a second poll; the
 * owner's pid is only ever the reply to a `stop` frame, which takes a termination lease
 * against the run under test; and its control endpoint opens after isolation setup, so
 * for most of a boot "unreachable" means "not yet", not "dead". A detached owner that
 * dies after its ack therefore spends this deadline and reports the plain timeout —
 * slower, never a false pass.
 */
async function waitForRunBoot<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  owner?: ForegroundOwner
): Promise<T> {
  const startedAt = Date.now();
  const value = await waitFor(what, read, RUN_BOOT_DEADLINE_MS, owner);
  const elapsed = Date.now() - startedAt;
  console.log(`[boot] ${what}: ${String(elapsed)}ms of ${String(RUN_BOOT_DEADLINE_MS)}ms`);
  return value;
}

describe('foreground run discovery', () => {
  test('reports owner exit and both streams before the row-discovery deadline', async () => {
    const fixture = makeFixture('archon-wait-startup-failure-', {});
    const owner = startForegroundOwner(fixture, [
      '-e',
      'console.log("startup stdout"); console.error("controlled startup failure"); process.exit(23)',
    ]);
    // Through the same helper the boot waits use, at the same deadline: the claim is
    // that owner exit beats `RUN_BOOT_DEADLINE_MS`, and this test's own budget is Bun's
    // 5 s default. A guard that stopped firing could only fail here, never pass slowly.
    const error = await waitForRunBoot('the failed run row', () => undefined, owner).catch(
      (error: unknown) => error
    );
    expect(String(error)).toMatch(
      /Owner exited before the failed run row:.*exit 23[\s\S]*startup stdout[\s\S]*controlled startup failure/
    );
  });

  test('successful empty reads replace an obsolete database error', async () => {
    let reads = 0;
    const now = spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValue(2);
    try {
      const error = await waitFor(
        'an absent row',
        () => {
          if (reads++ === 0) throw new Error('obsolete schema error');
          return undefined;
        },
        2
      ).catch((error: unknown) => error);
      expect(error).toEqual(new Error('Timed out waiting for an absent row'));
      expect(reads).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  test('failed discovery cleanup reaps the foreground child before fixture removal', async () => {
    const fixture = makeFixture('archon-wait-startup-stall-', {});
    const owner = startForegroundOwner(fixture, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      const error = await waitFor('an absent row', () => undefined, 0, owner).catch(
        (error: unknown) => error
      );
      expect(String(error)).toContain('Timed out waiting for an absent row');
    } finally {
      await stopForegroundOwners();
    }
    expect(owner.child.exitCode !== null || owner.child.signalCode !== null).toBe(true);
    expect(foregroundOwners.size).toBe(0);
    expect(existsSync(fixture.projectRoot)).toBe(true);
  });
});

describe('archon workflow wait against a detached run', () => {
  test.each([
    { workflow: 'wait-success', status: 'completed' },
    { workflow: 'wait-failure', status: 'failed' },
  ])(
    'wakes on $status without polling run status',
    async ({ workflow, status }) => {
      const fixture = makeFixture('archon-wait-terminal-', {
        'wait-success': SLOW_SUCCESS,
        'wait-failure': SLOW_FAILURE,
      });
      const { runId } = await launchDetached(fixture, workflow);

      // Started while the run is still live: the wake, not a durable read, is what
      // ends this wait. The waiter runs exactly one command — no `workflow get` loop.
      const waiter = startWait(fixture, runId, 60);
      const settled = await waiter.settled();
      activeRunIds.delete(runId);

      // Exit 0 for `failed` too: the exit code describes the WAIT, not the run.
      expectWaitExit(settled, 0);
      const { payload } = settled;
      expect(payload).toMatchObject({
        ok: true,
        action: 'wait',
        runId,
        result: 'attention',
        attention: { kind: 'terminal', runId, status },
      });

      // The detail comes from an ordinary inspection afterwards — polling is now a
      // diagnostic, not the orchestration contract. Not a boot wait: the run is already
      // terminal by the assertion above, so this retries one `workflow get` against the
      // commit window (#2306) rather than against a process starting up.
      const detail = await waitFor(
        'workflow get to read the terminal run',
        async () => {
          const inspected = await runCli(fixture, ['workflow', 'get', runId, '--json']);
          if (inspected.exitCode !== 0) throw new Error(inspected.stderr || inspected.stdout);
          return JSON.parse(inspected.stdout.trim()) as Record<string, unknown>;
        },
        30_000
      );
      expect(detail).toMatchObject({
        id: runId,
        status,
      });
    },
    90_000
  );

  test('wakes with awaiting_response on a gate, then with cancelled when it is rejected', async () => {
    const fixture = makeFixture('archon-wait-gate-', { 'wait-gated': GATED });
    // Owned by another process; it exits on its own once the run parks on the gate.
    const owner = startForegroundOwner(fixture, [
      CLI_PATH,
      'workflow',
      'run',
      'wait-gated',
      'run-attention wait integration',
      '--folder',
    ]);

    // Discovering the id is test setup, not the contract under test — the launcher
    // above has no `--detach --json` ack to carry one.
    const runId = await waitForRunBoot(
      'the gated run row',
      () => readRunId(fixture.archonHome, 'wait-gated'),
      owner
    );
    activeRunIds.add(runId);

    // Attached while the warm-up node is still running, so the gate is a WAKE.
    const gateWaiter = startWait(fixture, runId, 60);
    const gate = await gateWaiter.settled();

    expectWaitExit(gate, 0);
    expect(gate.payload).toMatchObject({
      result: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId,
        respondTo: { runId, nodeId: 'review' },
        message: 'Approve the plan?',
      },
    });
    const ownerExit = await owner.settled;
    if (ownerExit !== 0) throw new Error(`Gated owner failed: ${ownerDiagnostics(owner)}`);

    // Resolving the gate is the ordinary next step, and it is what makes the wake
    // actionable. Rejecting to termination also exercises the transition that writes
    // `cancelled` from the gate path.
    const rejected = await runCli(fixture, ['workflow', 'reject', runId, 'not this time']);
    if (rejected.exitCode !== 0) {
      throw new Error(`reject failed: ${rejected.stderr || rejected.stdout}`);
    }
    activeRunIds.delete(runId);
    const detail = await runCli(fixture, ['workflow', 'get', runId, '--json']);
    expect(JSON.parse(detail.stdout.trim())).toMatchObject({ id: runId, status: 'cancelled' });
  }, 120_000);

  test('wakes on a cancelled run stopped from a third process', async () => {
    // `cancelled` is the transition that never arrives on its own — someone else
    // causes it, in another process, which is exactly the shape a waiting host
    // cannot observe without this command.
    const fixture = makeFixture('archon-wait-cancel-', {
      'wait-slow':
        'name: wait-slow\ndescription: Long detached fixture.\n' +
        'nodes:\n  - id: hold\n    bash: "sleep 60; echo done"\n',
    });
    const { runId } = await launchDetached(fixture, 'wait-slow');

    // `cancel` stops LIVE work: it refuses a run that is still 'pending' outright, and
    // the tree it terminates has to exist. The forked owner starts its control endpoint
    // before it executes anything, so the row reaching 'running' is one observation
    // that covers both. Guessing 1.5s here instead is what failed on Windows — as
    // "Cannot actively cancel run with status 'pending'" and as a taskkill walking a
    // tree that was still spawning (#2982).
    await waitForRunBoot('the detached owner to start running', () =>
      readRunStatus(fixture.archonHome, runId) === 'running' ? true : undefined
    );

    const waiter = startWait(fixture, runId, 90);
    // The wait announces itself once it has read the row and found nothing to report,
    // so cancelling after this line is a WAKE and not a durable read of an
    // already-cancelled row. The status it announces is the proof it attached to a run
    // that was still live.
    expect(await waiter.attached()).toEqual({ observedStatus: 'running' });

    const cancelled = await runCli(fixture, ['workflow', 'cancel', runId]);
    if (cancelled.exitCode !== 0) {
      throw new Error(`cancel failed: ${cancelled.stderr || cancelled.stdout}`);
    }
    const settled = await waiter.settled();
    activeRunIds.delete(runId);

    expectWaitExit(settled, 0);
    const { payload } = settled;
    expect(payload).toMatchObject({
      result: 'attention',
      attention: { kind: 'terminal', runId, status: 'cancelled' },
    });
  }, 120_000);

  test('reports owner_lost after abrupt process death and leaves lifecycle operator-owned', async () => {
    if (process.platform === 'win32') return;
    const fixture = makeFixture('archon-wait-owner-lost-', {
      'wait-orphan':
        'name: wait-orphan\ndescription: Owner-loss fixture.\n' +
        'nodes:\n  - id: hold\n    bash: "sleep 60; echo done"\n',
    });
    const { runId } = await launchDetached(fixture, 'wait-orphan');
    await waitForRunBoot('the detached owner to start running', () =>
      readRunStatus(fixture.archonHome, runId) === 'running' ? true : undefined
    );

    const waiter = startWait(fixture, runId, 60);
    expect(await waiter.attached()).toEqual({ observedStatus: 'running' });

    // Acquire only long enough to learn the exact owner PID. Do not commit the
    // cancellation handoff: SIGKILL models the external death this result detects.
    const lease = await requestRunLiveOwnerStop(runId);
    const ownerPid = lease.pid;
    lease.release();
    process.kill(-ownerPid, 'SIGKILL');

    const settled = await waiter.settled();
    expectWaitExit(settled, 0);
    expect(settled.payload).toEqual({
      ok: true,
      action: 'wait',
      runId,
      result: 'owner_lost',
      observedStatus: 'running',
    });
    expect(readRunStatus(fixture.archonHome, runId)).toBe('running');

    const abandoned = await runCli(fixture, ['workflow', 'abandon', runId]);
    if (abandoned.exitCode !== 0) {
      throw new Error(`abandon failed: ${abandoned.stderr || abandoned.stdout}`);
    }
    expect(readRunStatus(fixture.archonHome, runId)).toBe('cancelled');
    activeRunIds.delete(runId);
  }, 120_000);

  test('exits 3 with the observed status when the timeout passes first', async () => {
    // A wait that runs out of time must never look like a run that finished.
    const fixture = makeFixture('archon-wait-deadline-', { 'wait-success': SLOW_SUCCESS });
    const { runId } = await launchDetached(fixture, 'wait-success');

    const { exitCode, payload } = await startWait(fixture, runId, 1).settled();

    if (exitCode === 3) {
      expect(payload).toMatchObject({ ok: true, result: 'deadline', runId });
      expect(payload).not.toHaveProperty('attention');
    } else {
      // The 1s run beat the 1s deadline; the only other honest outcome.
      expectWaitExit({ exitCode, payload }, 0);
      expect(payload).toMatchObject({ result: 'attention' });
    }
  }, 90_000);

  test('exits 1 for a run id that names nothing', async () => {
    const fixture = makeFixture(
      'archon-wait-missing-',
      { 'wait-success': SLOW_SUCCESS },
      { gitInit: true }
    );
    const missing = '00000000-1111-2222-3333-444444444444';

    const { exitCode, payload } = await startWait(fixture, missing, 30).settled();

    expectWaitExit({ exitCode, payload }, 1);
    expect(payload).toMatchObject({ ok: false, action: 'wait', error: 'not_found' });
  }, 60_000);
});

/**
 * #3312: with no `archon serve` anywhere in this block, the process that owns a run
 * enforces its own durable wait deadline. On a build where the `--detach` child exits
 * at the pause, every case here leaves the run `paused` forever and fails.
 */
describe('a durable wait deadline is enforced by the owning process', () => {
  const DURATION_WAIT =
    'name: wait-duration\ndescription: Durable duration wait fixture.\n' +
    'nodes:\n' +
    '  - id: warmup\n    bash: "echo ready"\n' +
    '  - id: cooldown\n    depends_on: [warmup]\n    wait:\n      duration_ms: 3000\n';
  const EVENT_WAIT =
    'name: wait-event\ndescription: Durable event wait fixture.\n' +
    'nodes:\n' +
    '  - id: warmup\n    bash: "echo ready"\n' +
    '  - id: checks\n    depends_on: [warmup]\n    wait:\n      event: checks.complete\n      deadline_ms: 1500\n';
  const ATTENTION_WAIT =
    'name: wait-attention\ndescription: Durable attention wait fixture.\n' +
    'nodes:\n' +
    '  - id: await-operator\n    wait:\n      attention: "Do the outside action, then resume."\n';
  // Longer than the owner's 5 s poll cadence, so a concurrent release lands while
  // the owner is still asleep and has to be noticed on its next read.
  const LONG_WAIT =
    'name: wait-long\ndescription: Long durable wait fixture.\n' +
    'nodes:\n' +
    '  - id: cooldown\n    wait:\n      duration_ms: 8000\n';

  test('resumes a duration wait at its deadline and finishes the run', async () => {
    const fixture = makeFixture('archon-wait-duration-', { 'wait-duration': DURATION_WAIT });
    const { runId } = await launchDetached(fixture, 'wait-duration');

    const completed = await waitFor(
      'the duration wait to resume and complete the run',
      () => (readRunStatus(fixture.archonHome, runId) === 'completed' ? 'completed' : undefined),
      60_000
    );
    activeRunIds.delete(runId);
    expect(completed).toBe('completed');

    const output = await waitFor(
      'the duration wait node completion',
      () => readNodeCompletedOutput(fixture.archonHome, runId, 'cooldown'),
      10_000
    );
    expect(output).toMatchObject({ status: 'satisfied' });
    // The engine's own record of the wait: the deadline was genuinely waited, and
    // only then did the owner resume the run.
    expect(Number(output.waited_ms)).toBeGreaterThanOrEqual(3000);
  }, 120_000);

  test('expires an event wait by its deadline and finishes the run', async () => {
    const fixture = makeFixture('archon-wait-event-', { 'wait-event': EVENT_WAIT });
    const { runId } = await launchDetached(fixture, 'wait-event');

    const completed = await waitFor(
      'the event wait to expire and complete the run',
      () => (readRunStatus(fixture.archonHome, runId) === 'completed' ? 'completed' : undefined),
      60_000
    );
    activeRunIds.delete(runId);
    expect(completed).toBe('completed');

    const output = await waitFor(
      'the event wait node completion',
      () => readNodeCompletedOutput(fixture.archonHome, runId, 'checks'),
      10_000
    );
    expect(output).toMatchObject({ status: 'expired', event: 'checks.complete' });
    expect(Number(output.waited_ms)).toBeGreaterThanOrEqual(1500);
  }, 120_000);

  test('workflow wait returns at the run terminal, not at the wait', async () => {
    const fixture = makeFixture('archon-wait-continuation-', { 'wait-duration': DURATION_WAIT });
    const { runId } = await launchDetached(fixture, 'wait-duration');

    // Attach only once the run is parked on its wait, so the waiter is watching the
    // resumed execution rather than racing the first pass.
    await waitFor(
      'the duration-wait run to park',
      () => (readRunStatus(fixture.archonHome, runId) === 'paused' ? 'paused' : undefined),
      30_000
    );
    const waiter = startWait(fixture, runId, 30);
    expect(await waiter.attached()).toEqual({ observedStatus: 'paused' });

    const settled = await waiter.settled();
    activeRunIds.delete(runId);
    // A wait that returned at the pause would carry its own kind, not the run's
    // terminal transition.
    expectWaitExit(settled, 0);
    expect(settled.payload).toMatchObject({
      result: 'attention',
      attention: { kind: 'terminal', runId, status: 'completed' },
    });
  }, 120_000);

  test('leaves an attention wait for the operator and releases its owner', async () => {
    const fixture = makeFixture('archon-wait-attention-', { 'wait-attention': ATTENTION_WAIT });
    const { runId } = await launchDetached(fixture, 'wait-attention');

    // An attention wait has no deadline, so its owner must exit rather than sleep.
    // With the endpoint gone nothing in this process can advance the run, which is
    // the difference that keeps a human decision out of the continuation loop.
    const ownerGone = await waitFor(
      'the attention owner to release its endpoint',
      async () => {
        try {
          const target = await requestDetachedRunStop(runId);
          target.release();
          return undefined;
        } catch {
          return 'gone';
        }
      },
      30_000
    );
    expect(ownerGone).toBe('gone');
    expect(readRunStatus(fixture.archonHome, runId)).toBe('paused');
  }, 90_000);

  test('does not resume a wait another process released', async () => {
    const fixture = makeFixture('archon-wait-released-', { 'wait-long': LONG_WAIT });
    const { runId } = await launchDetached(fixture, 'wait-long');
    await waitFor(
      'the long-wait run to park',
      () => (readRunStatus(fixture.archonHome, runId) === 'paused' ? 'paused' : undefined),
      30_000
    );

    const abandoned = await runCli(fixture, ['workflow', 'abandon', runId]);
    if (abandoned.exitCode !== 0) {
      throw new Error(`abandon failed: ${abandoned.stderr || abandoned.stdout}`);
    }
    activeRunIds.delete(runId);

    // The owner is asleep on its own timer here. Whether it notices on the next poll
    // or loses the resume's compare-and-swap, the released run must stay cancelled —
    // an owner that resurrects another process's terminal state is the defect.
    await Bun.sleep(9_000);
    expect(readRunStatus(fixture.archonHome, runId)).toBe('cancelled');
  }, 120_000);
});

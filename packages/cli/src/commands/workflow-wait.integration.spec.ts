/**
 * `archon workflow wait <run-id>` against a REAL detached run, in a second process.
 *
 * This is #2745's regression boundary: the launching command returns, a separate
 * process waits on the run id it was handed, and that wait — not a `workflow get`
 * loop — is what learns the outcome. Every case here runs `wait` as its own OS
 * process against a real SQLite database, so a wake that only works in-process
 * would fail here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { requestRunLiveOwnerStop } from '@archon/core/services/run-live-owner';
import { requestDetachedRunStop } from '../utils/detached-run-control';

const cleanupPaths: string[] = [];
const activeRunIds = new Set<string>();

// One explicit hook, not `trackTempRoots()`: a still-running owner has to be stopped
// before its tree can go, and two hooks would leave registration order as the only
// thing keeping that correct.
afterEach(async () => {
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

/** Launch a detached run and return the id its ack carried (#2872). */
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
 * Poll `read` until it produces a value, naming `what` if it never does.
 *
 * The catch is load bearing, not defensive: an owner process creates `archon.db`
 * BEFORE it applies the schema, so a reader that opens the file inside that window
 * gets `SQLiteError: no such table` out of `prepare()` — a throw, not an empty
 * result. Windows widens the same window to `disk I/O error` while a commit settles
 * (#2306). `workflow-terminal-event.integration.spec.ts` catches for exactly this
 * reason; a bare loop here would surface a startup race as a test failure.
 */
async function waitFor<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${what}${detail}`);
}

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
      // diagnostic, not the orchestration contract.
      const detail = await waitFor('workflow get to read the terminal run', async () => {
        const inspected = await runCli(fixture, ['workflow', 'get', runId, '--json']);
        if (inspected.exitCode !== 0) throw new Error(inspected.stderr || inspected.stdout);
        return JSON.parse(inspected.stdout.trim()) as Record<string, unknown>;
      });
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
    const owner = Bun.spawn(
      [
        process.execPath,
        CLI_PATH,
        'workflow',
        'run',
        'wait-gated',
        'run-attention wait integration',
        '--folder',
      ],
      {
        cwd: fixture.projectRoot,
        env: { ...process.env, ARCHON_HOME: fixture.archonHome },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    // Discovering the id is test setup, not the contract under test — the launcher
    // above has no `--detach --json` ack to carry one.
    const runId = await waitFor('the gated run row', () =>
      readRunId(fixture.archonHome, 'wait-gated')
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
    await owner.exited;

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
    await waitFor('the detached owner to start running', () =>
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
    await waitFor('the detached owner to start running', () =>
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

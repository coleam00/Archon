/**
 * Ctrl-C on a foreground `archon workflow run` records why the run stopped, and the run
 * still resumes (#3479).
 *
 * Every part of this has to be real to mean anything: the signal must reach a genuine
 * foreground owner process, that process must settle its own run from the signal it
 * received, and the same run must then continue to completion. An in-process test of the
 * handler would assert the call shape — which was already "correct" while no operator
 * surface could see the result.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const CLI_ENTRY = join(import.meta.dir, '..', 'cli.ts');
const WORKFLOW_NAME = 'interrupt-resume';

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

interface Fixture {
  repo: string;
  archonHome: string;
  /** Written by `hold` on its first pass, so the second pass can succeed instead. */
  marker: string;
  /** The pid of the `hold` node's own process, so the forced exit strands nothing. */
  pidFile: string;
}

/**
 * A repo, a scratch `ARCHON_HOME`, and a workflow the interrupt can land in the middle of.
 *
 * `settle` must complete before the signal arrives: a resume is refused outright for a run
 * with no completed node, so a single-node fixture would prove nothing about resumability.
 * `hold` blocks until it is signalled on the first pass and exits 0 on the second, which is
 * what makes the resumed run reach `completed` rather than stall again.
 */
function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'archon-workflow-interrupt-'));
  cleanupPaths.push(root);
  const repo = join(root, 'repo');
  const archonHome = join(root, 'home');
  const marker = join(root, 'hold.marker');
  const pidFile = join(root, 'hold.pid');
  const workflowDir = join(repo, '.archon', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(archonHome, { recursive: true });
  expect(spawnSync('git', ['init', '-q', '.'], { cwd: repo }).status).toBe(0);
  writeFileSync(
    join(workflowDir, `${WORKFLOW_NAME}.yaml`),
    [
      `name: ${WORKFLOW_NAME}`,
      'description: interrupt and resume a foreground run',
      'nodes:',
      '  - id: settle',
      '    bash: echo settled',
      '  - id: hold',
      '    depends_on: [settle]',
      '    bash: |',
      `      if [ -f '${marker}' ]; then echo resumed; exit 0; fi`,
      `      touch '${marker}'`,
      `      echo $$ > '${pidFile}'`,
      '      exec sleep 60',
      '',
    ].join('\n')
  );
  return { repo, archonHome, marker, pidFile };
}

interface CliResult {
  status: number | null;
  output: string;
}

function runCli(fixture: Fixture, args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ARCHON_HOME: fixture.archonHome, ARCHON_TELEMETRY_DISABLED: '1' },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

interface ForegroundOwner {
  child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  /** Both streams, drained into one buffer, so a failure can name what the owner said. */
  settled: Promise<{ exitCode: number; output: string }>;
}

/** Start `workflow run` as a real foreground owner and keep its handle. */
function startForegroundRun(fixture: Fixture): ForegroundOwner {
  const child = Bun.spawn(
    [
      process.execPath,
      CLI_ENTRY,
      'workflow',
      'run',
      WORKFLOW_NAME,
      '--cwd',
      fixture.repo,
      '--no-worktree',
    ],
    {
      cwd: fixture.repo,
      env: { ...process.env, ARCHON_HOME: fixture.archonHome, ARCHON_TELEMETRY_DISABLED: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
    return text + decoder.decode();
  };
  const settled = Promise.all([child.exited, drain(child.stdout), drain(child.stderr)]).then(
    ([exitCode, stdout, stderr]) => ({ exitCode, output: `${stdout}${stderr}` })
  );
  settled.catch(() => undefined);
  return { child, settled };
}

/**
 * Open the fixture database for reading, willing to wait out the owner's own writes.
 *
 * These reads happen while the owner process is live, so a bare open raced its commits
 * and failed with `SQLITE_BUSY` on a loaded runner.
 */
function openDatabase(fixture: Fixture): Database {
  const database = new Database(join(fixture.archonHome, 'archon.db'), { readonly: true });
  database.exec('PRAGMA busy_timeout = 15000');
  return database;
}

interface RunRow {
  id: string;
  status: string;
}

/** The fixture's one run, or undefined while the database or row is not readable yet. */
function readRun(fixture: Fixture): RunRow | undefined {
  if (!existsSync(join(fixture.archonHome, 'archon.db'))) return undefined;
  const database = openDatabase(fixture);
  try {
    return database
      .query<
        RunRow,
        [string]
      >('SELECT id, status FROM remote_agent_workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC LIMIT 1')
      .get(WORKFLOW_NAME) as RunRow | undefined;
  } catch {
    // The owner creates archon.db before applying the schema, so an early read throws
    // `no such table` rather than returning nothing. The caller polls.
    return undefined;
  } finally {
    database.close();
  }
}

/**
 * Poll `read` until it produces a value, failing fast if the owner dies first.
 *
 * Without the owner check a dead owner spends the whole deadline and reports a timeout,
 * hiding whatever it printed on the way out.
 */
async function waitFor<T>(
  what: string,
  read: () => T | undefined,
  owner?: ForegroundOwner
): Promise<T> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const ownerExited = owner !== undefined && owner.child.exitCode !== null;
    const value = read();
    if (value !== undefined) return value;
    if (ownerExited) {
      const { exitCode, output } = await owner.settled;
      throw new Error(`the owner exited ${String(exitCode)} before ${what}:\n${output}`);
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function getRunJson(fixture: Fixture, runId: string): Record<string, unknown> {
  const result = runCli(fixture, ['workflow', 'get', runId, '--json']);
  if (result.status !== 0) throw new Error(`workflow get --json failed: ${result.output}`);
  return JSON.parse(result.output.trim()) as Record<string, unknown>;
}

// Windows has no POSIX signal delivery, so there is no interrupt to deliver or record.
describe.skipIf(process.platform === 'win32')('an interrupted foreground run', () => {
  test('records why it stopped and still resumes to completion', async () => {
    const fixture = makeFixture();
    const owner = startForegroundRun(fixture);
    let holdPid: number | undefined;

    try {
      // The pidfile exists only once `hold` is executing, which is also the point at which
      // `settle` has completed and the owner's signal handlers are installed.
      holdPid = await waitFor(
        'the hold node to start',
        () => {
          if (!existsSync(fixture.pidFile)) return undefined;
          const pid = Number(readFileSync(fixture.pidFile, 'utf8').trim());
          return Number.isInteger(pid) && pid > 0 ? pid : undefined;
        },
        owner
      );
      const started = await waitFor(
        'the run to be running',
        () => {
          const run = readRun(fixture);
          return run?.status === 'running' ? run : undefined;
        },
        owner
      );

      owner.child.kill('SIGINT');
      const interrupted = await waitFor('the interrupted run to settle', () => {
        const run = readRun(fixture);
        return run?.status === 'failed' ? run : undefined;
      });
      expect(interrupted.id).toBe(started.id);

      // Between the interrupt and the resume: the reason is readable, and the run is
      // still `failed` — the resumable status. Recording `cancelled` here would have
      // made the resume below impossible (the trap draft PR #3351 fell into).
      const stopped = getRunJson(fixture, started.id);
      expect(stopped.status).toBe('failed');
      expect((stopped.metadata as { stop_reason?: unknown }).stop_reason).toEqual({
        reason: 'process_terminated',
        signal: 'SIGINT',
      });
      const human = runCli(fixture, ['workflow', 'get', started.id]);
      expect(human.status).toBe(0);
      expect(human.output).toContain('Stopped: interrupted by the operator (SIGINT)');

      const resumed = runCli(fixture, ['workflow', 'resume', started.id, '--cwd', fixture.repo]);
      if (resumed.status !== 0) throw new Error(`resume failed: ${resumed.output}`);
      // `hold` ran again and took its second-pass branch, so the run reached its end
      // rather than stalling at the node the interrupt left unfinished.
      expect(resumed.output).toContain('resumed');
      expect(readRun(fixture)?.status).toBe('completed');

      // A resumed run that completed must not go on claiming an operator interrupted it.
      const completed = getRunJson(fixture, started.id);
      expect((completed.metadata as { stop_reason?: unknown }).stop_reason).toBeUndefined();
    } finally {
      // The forced exit skips the owner's teardown, so its `sleep` outlives it.
      if (holdPid !== undefined) {
        try {
          process.kill(holdPid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      if (owner.child.exitCode === null) owner.child.kill('SIGKILL');
      await owner.settled;
    }
  }, 180_000);
});

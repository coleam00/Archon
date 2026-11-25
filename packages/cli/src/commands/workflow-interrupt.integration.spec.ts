// @archon-test-isolated
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
  /** A background descendant of the `hold` node, which only the owner's interrupt ends. */
  pidFile: string;
}

/**
 * A repo, a scratch `ARCHON_HOME`, and a workflow the interrupt can land in the middle of.
 *
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
      '  - id: hold',
      '    bash: |',
      `      if [ -f '${marker}' ]; then echo resumed; exit 0; fi`,
      `      touch '${marker}'`,
      '      sleep 60 &',
      `      echo $! > '${pidFile}'`,
      '      wait',
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
    env: {
      ...process.env,
      ARCHON_HOME: fixture.archonHome,
      ARCHON_TELEMETRY_DISABLED: '1',
      DATABASE_URL: '',
    },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

interface ForegroundOwner {
  child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  /** Both streams, drained into one buffer, so a failure can name what the owner said. */
  settled: Promise<{ exitCode: number; output: string }>;
}

/** Start `workflow run` as a real foreground owner and keep its handle. */
function startForegroundRun(fixture: Fixture, setup = false): ForegroundOwner {
  return startOwner(fixture, [
    'workflow',
    'run',
    WORKFLOW_NAME,
    '--cwd',
    fixture.repo,
    ...(setup ? [] : ['--no-worktree']),
  ]);
}

/** Start a CLI command as a real foreground owner and keep its handle. */
function startOwner(fixture: Fixture, args: string[]): ForegroundOwner {
  const child = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd: fixture.repo,
    env: {
      ...process.env,
      ARCHON_HOME: fixture.archonHome,
      ARCHON_TELEMETRY_DISABLED: '1',
      DATABASE_URL: '',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
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
  item_id: string | null;
}

/** A workflow's latest run, or undefined while the database or row is not readable yet. */
function readRun(fixture: Fixture, workflow = WORKFLOW_NAME): RunRow | undefined {
  return readRuns(fixture, workflow)?.[0];
}

/** Every run of a workflow, newest first. */
function readRuns(fixture: Fixture, workflow: string): RunRow[] | undefined {
  if (!existsSync(join(fixture.archonHome, 'archon.db'))) return undefined;
  const database = openDatabase(fixture);
  try {
    return database
      .query<RunRow, [string]>(
        'SELECT id, status, item_id FROM remote_agent_workflow_runs WHERE workflow_name = ? ORDER BY started_at DESC'
      )
      .all(workflow);
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
  owner?: ForegroundOwner,
  timeoutMs = 90_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

// Windows has no POSIX signal delivery, so there is no interrupt to deliver or record.
describe.skipIf(process.platform === 'win32')('an interrupted foreground run', () => {
  test('Ctrl-C during worktree setup ends its background descendant', async () => {
    const fixture = makeFixture();
    const root = join(fixture.repo, '..');
    const ready = join(root, 'setup.ready');
    const go = join(root, 'setup.go');
    const leaked = join(root, 'setup.leaked');
    const pidFile = join(root, 'setup.pid');
    const command = `bash -c 'echo $$ > "${pidFile}"; touch "${ready}"; while [ ! -f "${go}" ]; do sleep 0.01; done; touch "${leaked}"' & wait`;
    writeFileSync(
      join(fixture.repo, '.archon', 'config.yaml'),
      `worktree:\n  baseBranch: main\n  postCreate:\n    - ${JSON.stringify(command)}\n`
    );
    const origin = join(root, 'origin.git');
    mkdirSync(origin);
    const git = (cwd: string, args: string[]): void => {
      const result = spawnSync(
        'git',
        ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
        { cwd, encoding: 'utf8' }
      );
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git(origin, ['init', '--bare', '-q']);
    git(fixture.repo, ['add', '.archon']);
    git(fixture.repo, ['commit', '-qm', 'Setup interrupt fixture']);
    git(fixture.repo, ['branch', '-M', 'main']);
    git(fixture.repo, ['remote', 'add', 'origin', origin]);
    git(fixture.repo, ['push', '-q', 'origin', 'main']);
    const owner = startForegroundRun(fixture, true);
    try {
      await waitFor('setup to start', () => (existsSync(ready) ? true : undefined), owner);
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      expect(processExists(descendantPid)).toBe(true);
      owner.child.kill('SIGINT');
      await owner.settled;
      await waitFor(
        'the setup descendant to exit',
        () => (!processExists(descendantPid) ? true : undefined),
        undefined,
        3000
      );
      writeFileSync(go, '');
      expect(existsSync(leaked)).toBe(false);
    } finally {
      if (owner.child.exitCode === null) owner.child.kill('SIGKILL');
      await owner.settled;
      writeFileSync(go, '');
      await Bun.sleep(100);
    }
  }, 120000);

  // A hangup, a second Ctrl-C and SIGKILL all end the owner before its teardown runs.
  test('an owner that dies without its teardown still ends the node tree', async () => {
    const fixture = makeFixture();
    const owner = startForegroundRun(fixture);
    try {
      const holdPid = await waitFor(
        'the hold node to start',
        () => {
          if (!existsSync(fixture.pidFile)) return undefined;
          const pid = Number(readFileSync(fixture.pidFile, 'utf8').trim());
          return Number.isInteger(pid) && pid > 0 ? pid : undefined;
        },
        owner
      );
      owner.child.kill('SIGHUP');
      await owner.settled;
      await waitFor(
        'the orphaned node tree to exit',
        () => (!processExists(holdPid) ? true : undefined),
        undefined,
        3000
      );
    } finally {
      if (owner.child.exitCode === null) owner.child.kill('SIGKILL');
      await owner.settled;
    }
  }, 120_000);

  test('records why it stopped and still resumes to completion', async () => {
    const fixture = makeFixture();
    const owner = startForegroundRun(fixture);

    try {
      // The pidfile exists only once `hold` is executing, by which point the owner's signal
      // handlers are installed.
      const holdPid = await waitFor(
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
      // A resume must never overlap the interrupted attempt.
      await waitFor(
        'the interrupted node tree to exit',
        () => (!processExists(holdPid) ? true : undefined),
        undefined,
        3000
      );

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
      if (owner.child.exitCode === null) owner.child.kill('SIGKILL');
      await owner.settled;
    }
  }, 180_000);
});

/** The pid a node's background `sleep` wrote, once the node is executing. */
function readPid(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Kill a foreground owner outright and wait until the node tree it ran has gone too. */
async function killOwner(owner: ForegroundOwner, nodePid: number): Promise<void> {
  owner.child.kill('SIGKILL');
  await owner.settled;
  await waitFor(
    'the orphaned node tree to exit',
    () => (!processExists(nodePid) ? true : undefined),
    undefined,
    3000
  );
}

// A run stopped in its first node has nothing to skip, and resume still continues that
// same run: its first node runs again, on what the run was started with.
describe.skipIf(process.platform === 'win32')('a run stopped in its first node', () => {
  for (const stop of ['failed', 'killed'] as const) {
    test(`resumes in place after its owner ${stop === 'failed' ? 'recorded a failure' : 'was killed'}`, async () => {
      const fixture = makeFixture();
      const root = join(fixture.repo, '..');
      const record = join(root, 'first.record');
      const pidFile = join(root, 'first.pid');
      const workflowFile = join(fixture.repo, '.archon', 'workflows', 'first-node.yaml');
      const configFile = join(fixture.repo, 'run-config.yaml');
      const writeWorkflow = (graph: string): void =>
        writeFileSync(
          workflowFile,
          [
            'name: first-node',
            'description: stop in the first node, then resume',
            'inputs:',
            '  label:',
            '    required: true',
            'nodes:',
            '  - id: work',
            '    bash: |',
            `      echo "graph=${graph} input=$INPUTS_LABEL docs=$DOCS_DIR" >> '${record}'`,
            `      if [ -f '${fixture.marker}' ]; then exit 0; fi`,
            `      touch '${fixture.marker}'`,
            ...(stop === 'failed'
              ? ['      exit 1']
              : ['      sleep 60 &', `      echo $! > '${pidFile}'`, '      wait']),
            '',
          ].join('\n')
        );
      writeWorkflow('started');
      writeFileSync(configFile, 'docs:\n  path: started-docs\n');
      const runArgs = [
        'workflow',
        'run',
        'first-node',
        '--cwd',
        fixture.repo,
        '--no-worktree',
        '--item',
        'first-node-item',
        '--input',
        'label=started-input',
        '--config',
        configFile,
      ];

      if (stop === 'failed') {
        expect(runCli(fixture, runArgs).status).not.toBe(0);
      } else {
        const owner = startOwner(fixture, runArgs);
        try {
          const nodePid = await waitFor('the first node to start', () => readPid(pidFile), owner);
          await killOwner(owner, nodePid);
        } finally {
          if (owner.child.exitCode === null) owner.child.kill('SIGKILL');
          await owner.settled;
        }
      }
      const stopped = readRun(fixture, 'first-node');
      if (!stopped) throw new Error('no run was recorded');
      expect(stopped.status).toBe(stop === 'failed' ? 'failed' : 'running');
      expect(stopped.item_id).not.toBeNull();
      const firstPass = readFileSync(record, 'utf8');
      expect(firstPass).toContain('graph=started input=started-input');
      expect(firstPass).toContain('started-docs');

      // What the run started with must win over what is on disk at resume time.
      writeWorkflow('edited');
      writeFileSync(configFile, 'docs:\n  path: edited-docs\n');

      const resumed = runCli(fixture, ['workflow', 'resume', stopped.id, '--cwd', fixture.repo]);
      if (resumed.status !== 0) throw new Error(`resume failed: ${resumed.output}`);

      const runs = readRuns(fixture, 'first-node') ?? [];
      expect(runs).toEqual([{ id: stopped.id, status: 'completed', item_id: stopped.item_id }]);
      // Two passes of the first node, both on the run's own graph, input and config.
      expect(readFileSync(record, 'utf8')).toBe(firstPass.repeat(2));
    }, 180_000);
  }

  test('a parent killed in its first sub-run names the command that recovers it', async () => {
    const fixture = makeFixture();
    const pidFile = join(fixture.repo, '..', 'child.pid');
    const workflowDir = join(fixture.repo, '.archon', 'workflows');
    writeFileSync(
      join(workflowDir, 'first-child.yaml'),
      [
        'name: first-child',
        'description: the sub-run the parent is killed in',
        'nodes:',
        '  - id: hold',
        '    bash: |',
        `      if [ -f '${fixture.marker}' ]; then echo child-resumed; exit 0; fi`,
        `      touch '${fixture.marker}'`,
        '      sleep 60 &',
        `      echo $! > '${pidFile}'`,
        '      wait',
        '',
      ].join('\n')
    );
    writeFileSync(
      join(workflowDir, 'first-parent.yaml'),
      [
        'name: first-parent',
        'description: a parent whose first node is a sub-run',
        'nodes:',
        '  - id: sub',
        '    workflow: first-child',
        '',
      ].join('\n')
    );
    const owner = startOwner(fixture, [
      'workflow',
      'run',
      'first-parent',
      '--cwd',
      fixture.repo,
      '--no-worktree',
    ]);
    try {
      const nodePid = await waitFor('the sub-run node to start', () => readPid(pidFile), owner);
      await killOwner(owner, nodePid);
    } finally {
      if (owner.child.exitCode === null) owner.child.kill('SIGKILL');
      await owner.settled;
    }
    const parent = readRun(fixture, 'first-parent');
    const child = readRun(fixture, 'first-child');
    if (!parent || !child) throw new Error('the parent or its sub-run was not recorded');
    expect(child.status).toBe('running');

    const resumed = runCli(fixture, ['workflow', 'resume', parent.id, '--cwd', fixture.repo]);
    expect(readRun(fixture, 'first-parent')?.status).toBe('paused');
    // The parent waits on its sub-run, so it must name the command that moves the sub-run.
    // `approve` is refused for a sub-run that is still marked running.
    expect(resumed.output).toContain(`resume ${child.id}`);
    expect(resumed.output).not.toContain(`approve ${child.id}`);

    const recovered = runCli(fixture, ['workflow', 'resume', child.id, '--cwd', fixture.repo]);
    if (recovered.status !== 0) throw new Error(`sub-run resume failed: ${recovered.output}`);
    await waitFor('the parent to complete', () =>
      readRun(fixture, 'first-parent')?.status === 'completed' ? true : undefined
    );
    expect(readRun(fixture, 'first-child')?.status).toBe('completed');
  }, 180_000);
});

/**
 * A run's end starts the stage a run-ended binding names and admits the work its slot
 * held back, with no other command: real SQLite, every run in its own CLI process.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { itemReadSchema } from '@archon/workflows/item-read';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const HOST = 'factory-host';
const DEADLINE_MS = 30_000;
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

interface Fixture {
  root: string;
  projectRoot: string;
  archonHome: string;
  cli: (args: string[], env?: Record<string, string>) => Promise<string>;
  /** Run the CLI and return its exit code and output, whether or not it succeeded. */
  attempt: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Start the CLI without waiting for it; the caller awaits `exited`. */
  start: (args: string[]) => { exited: Promise<number> };
  rows: <T>(sql: string) => T[];
  fireConfig: (
    name: string,
    workflowName: string,
    resource: string,
    capacity?: number,
    hostId?: string
  ) => string;
  /**
   * Write a run-ended binding where the ending process reads it; by default it starts
   * `stage-b` in the project.
   */
  bind: (
    name: string,
    file: Record<string, unknown>,
    launch?: { workflowName?: string; cwd?: string }
  ) => void;
}

// Stage A returns a named outcome and a plan derived from its input, so B's `plan` (read
// from the result) differs from A's `plan` input; no node fires anything.
const STAGE_A = `name: stage-a
description: Plan an item.
mutates_checkout: false
inputs:
  plan: { required: true }
  issue: { required: true }
returns: { node: decide, outcome: outcome }
nodes:
  - id: decide
    bash: |
      printf '{"outcome": "planned", "plan": "planned: %s"}' "$INPUTS_PLAN"
    output_format:
      type: object
      properties:
        outcome: { type: string, enum: [planned, blocked] }
        plan: { type: string }
      required: [outcome, plan]
`;

const STAGE_B = `name: stage-b
description: Build what stage A planned.
mutates_checkout: false
inputs:
  plan: { required: true }
  issue: { required: true }
nodes:
  - id: build
    bash: echo "building $INPUTS_PLAN"
`;

// Holds a slot of resource 'pool' until the test writes \`release\`.
const HELD = `name: held
description: Hold the pool slot until released.
resource: pool
mutates_checkout: false
nodes:
  - id: hold
    bash: touch held-started; while [ ! -f release ]; do sleep 0.1; done
`;

const QUICK = `name: quick
description: Take a pool slot briefly.
resource: pool
mutates_checkout: false
nodes:
  - id: work
    bash: echo ran >> quick-ran
`;

const POOL = `name: pool-work
description: Hold one slot of a capacity-2 resource for a second.
mutates_checkout: false
nodes:
  - id: hold
    bash: sleep 1
`;

async function makeFixture(label: string): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `archon-run-ended-${label}-`)));
  tempRoots.push(root);
  const projectRoot = join(root, 'project');
  const archonHome = join(root, 'home');
  const workflows = join(projectRoot, '.archon', 'workflows');
  mkdirSync(workflows, { recursive: true });
  writeFileSync(join(workflows, 'stage-a.yaml'), STAGE_A);
  writeFileSync(join(workflows, 'stage-b.yaml'), STAGE_B);
  writeFileSync(join(workflows, 'pool-work.yaml'), POOL);
  writeFileSync(join(workflows, 'held.yaml'), HELD);
  writeFileSync(join(workflows, 'quick.yaml'), QUICK);
  expect(await Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot }).exited).toBe(0);

  const spawnCli = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawn([process.execPath, CLI_PATH, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        WORKFLOW_ID: '',
        ARCHON_NODE_EXECUTION: '',
        ARCHON_TRIGGER_HOST: '',
        DATABASE_URL: '',
        ARCHON_HOME: archonHome,
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        GITHUB_APP_ID: '',
        ...env,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  const attempt = async (
    args: string[],
    env: Record<string, string> = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const child = spawnCli(args, env);
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };
  const cli = async (args: string[], env: Record<string, string> = {}): Promise<string> => {
    const { exitCode, stdout, stderr } = await attempt(args, env);
    if (exitCode !== 0)
      throw new Error(`archon ${args.join(' ')} failed (${String(exitCode)}): ${stderr || stdout}`);
    return stdout;
  };
  const databasePath = join(archonHome, 'archon.db');
  const rows = <T>(sql: string): T[] => {
    if (!existsSync(databasePath)) return [];
    const database = new Database(databasePath, { readonly: true });
    try {
      database.run('PRAGMA busy_timeout = 5000');
      return database.query<T, []>(sql).all();
    } finally {
      database.close();
    }
  };
  // The first database command creates the scratch schema and the CLI's own user.
  const { runAsUserId: userId } = JSON.parse(await cli(['trigger', 'whoami'])) as {
    runAsUserId: string;
  };
  const binding = (
    bindingId: string,
    workflowName: string,
    resource: string,
    capacity?: number,
    hostId = HOST
  ) => ({
    bindingId,
    bindingRevision: null,
    hostId,
    runAsUserId: userId,
    resource,
    ...(capacity === undefined ? {} : { capacity }),
    overlap: 'queue',
    launch: { cwd: projectRoot, workflowName, inputs: {}, isolation: { kind: 'in-place' } },
  });
  return {
    root,
    projectRoot,
    archonHome,
    cli,
    attempt,
    start: args => {
      const child = spawnCli(args);
      return { exited: child.exited };
    },
    rows,
    fireConfig: (name, workflowName, resource, capacity, hostId) => {
      const path = join(root, `${name}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          sourceInstanceId: name,
          binding: binding(name, workflowName, resource, capacity, hostId),
        })
      );
      return path;
    },
    bind: (name, on, launch = {}) => {
      mkdirSync(join(archonHome, 'triggers'), { recursive: true });
      const base = binding(name, 'stage-b', 'stage-b');
      writeFileSync(
        join(archonHome, 'triggers', `${name}.json`),
        JSON.stringify({
          version: 1,
          sourceInstanceId: name,
          binding: { ...base, launch: { ...base.launch, ...launch } },
          on,
        })
      );
    },
  };
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

interface RunRow {
  id: string;
  workflow_name: string;
  status: string;
  metadata: string;
}

// The order `workflow runs --item` reads: start time, then the order the rows were written.
const RUNS_SQL =
  'SELECT id, workflow_name, status, metadata FROM remote_agent_workflow_runs ORDER BY started_at, rowid';

function completedRuns(fixture: Fixture, count: number): RunRow[] | undefined {
  const runs = fixture.rows<RunRow>(RUNS_SQL);
  return runs.length === count && runs.every(run => run.status === 'completed') ? runs : undefined;
}

const RUN_ENDED = {
  runEnded: {
    workflowName: 'stage-a',
    outcome: 'planned',
    inputs: { plan: { result: '/plan' }, issue: { input: 'issue' } },
  },
};

describe('a run-ended binding', () => {
  test('starts the bound stage on the same item with the ended run result, each time it ends', async () => {
    const fixture = await makeFixture('chain');
    fixture.bind('build-after-plan', RUN_ENDED);
    const listed = JSON.parse(await fixture.cli(['trigger', 'check'])) as {
      runEnded: { file: string; problems: string[] }[];
    };
    expect(listed.runEnded).toMatchObject([{ problems: [] }]);

    const fireA = fixture.fireConfig('plan', 'stage-a', 'stage-a');
    const startA = async (plan: string): Promise<void> => {
      const inputs = join(fixture.root, `inputs-${plan}.json`);
      writeFileSync(inputs, JSON.stringify({ plan, issue: 'Fix the login page' }));
      await fixture.cli([
        'trigger',
        'fire',
        '--config',
        fireA,
        '--item',
        'issue-1',
        '--inputs',
        inputs,
      ]);
    };
    // Nothing but the end of each A starts its B.
    await startA('first plan');
    await waitFor(() => completedRuns(fixture, 2), 'A and the B its end started');
    await startA('second plan');
    const runs = await waitFor(() => completedRuns(fixture, 4), 'the second A and its B');

    expect(runs.map(run => run.workflow_name)).toEqual([
      'stage-a',
      'stage-b',
      'stage-a',
      'stage-b',
    ]);
    const inputsOf = (run: RunRow | undefined) =>
      (JSON.parse(run?.metadata ?? '{}') as { inputs?: Record<string, string> }).inputs;
    expect(inputsOf(runs[1])).toEqual({ plan: 'planned: first plan', issue: 'Fix the login page' });
    expect(inputsOf(runs[3])).toEqual({
      plan: 'planned: second plan',
      issue: 'Fix the login page',
    });

    const read = itemReadSchema.parse(
      JSON.parse(await fixture.cli(['workflow', 'runs', '--item', 'issue-1', '--json']))
    );
    expect(read.runs.map(run => run.id)).toEqual(runs.map(run => run.id));
    expect(read.runs.map(run => run.cause)).toEqual([
      { kind: 'receipt', receiptId: expect.any(String), sourceInstanceId: 'plan' },
      { kind: 'run_ended', runId: runs[0]?.id },
      { kind: 'receipt', receiptId: expect.any(String), sourceInstanceId: 'plan' },
      { kind: 'run_ended', runId: runs[2]?.id },
    ]);
    expect(read.runs.map(run => run.outcome)).toEqual(['planned', null, 'planned', null]);
    expect(await fixture.cli(['workflow', 'runs', '--item', 'issue-1'])).toContain(
      `after run ${runs[2]?.id.slice(0, 8)} ended`
    );
  }, 90_000);

  test('a hand run with no trigger host starts the stage its end caused, with no other command', async () => {
    const fixture = await makeFixture('hand');
    fixture.bind('build-after-plan', RUN_ENDED);
    await fixture.cli([
      'workflow',
      'run',
      'stage-a',
      '--no-worktree',
      '--item',
      'issue-1',
      '--input',
      'plan=p1',
      '--input',
      'issue=i1',
    ]);
    const runs = await waitFor(() => completedRuns(fixture, 2), 'A and the B its end started');
    expect(runs.map(run => run.workflow_name)).toEqual(['stage-a', 'stage-b']);
  }, 90_000);

  test('a hand run starts the stage its end caused even behind a page of older pending work on the host', async () => {
    const fixture = await makeFixture('backlog');
    fixture.bind('build-after-plan', RUN_ENDED);
    // More older pending bindings on the binding's host than one page of the host-wide
    // list holds; the ending process must still find the start its own end wrote.
    const database = new Database(join(fixture.archonHome, 'archon.db'));
    try {
      database.run('PRAGMA busy_timeout = 5000');
      for (let index = 0; index < 101; index++) {
        const receiptId = crypto.randomUUID();
        database.run(
          "INSERT INTO remote_agent_start_receipts (id, source_instance_id, delivery_id, content_digest, received_at, outcome) VALUES (?, 'backlog', ?, 'digest', '2026-01-01T00:00:00.000Z', 'matched')",
          [receiptId, receiptId]
        );
        database.run(
          "INSERT INTO remote_agent_start_receipt_bindings (receipt_id, binding_id, host_id, preparation_status, created_at) VALUES (?, 'old', ?, 'pending', '2026-01-01 00:00:00')",
          [receiptId, HOST]
        );
      }
    } finally {
      database.close();
    }
    await fixture.cli([
      'workflow',
      'run',
      'stage-a',
      '--no-worktree',
      '--item',
      'issue-1',
      '--input',
      'plan=p1',
      '--input',
      'issue=i1',
    ]);
    const runs = await waitFor(() => completedRuns(fixture, 2), 'A and the B its end started');
    expect(runs.map(run => run.workflow_name)).toEqual(['stage-a', 'stage-b']);
    // The older work is the host's own drain's to prepare, not the ending process's.
    expect(
      fixture.rows<{ count: number }>(
        "SELECT COUNT(*) AS count FROM remote_agent_start_receipt_bindings WHERE binding_id = 'old' AND preparation_status = 'pending'"
      )
    ).toEqual([{ count: 101 }]);
  }, 90_000);

  test('a start admitted by a process that died before spawning it is shown, and runs once by hand', async () => {
    const fixture = await makeFixture('stranded');
    fixture.bind('build-after-plan', RUN_ENDED);
    // The ending process admits B, then cannot spawn B's executor because its log
    // directory is a file: the state a process killed between admission and spawn leaves.
    const logs = join(fixture.archonHome, 'logs');
    writeFileSync(logs, '');
    await fixture.cli([
      'workflow',
      'run',
      'stage-a',
      '--no-worktree',
      '--item',
      'issue-1',
      '--input',
      'plan=p1',
      '--input',
      'issue=i1',
    ]);
    const stageB = () =>
      fixture.rows<RunRow>(RUNS_SQL).filter(run => run.workflow_name === 'stage-b');
    const [stranded] = stageB();
    expect(stageB().map(run => run.status)).toEqual(['pending']);
    if (!stranded) throw new Error('stage B was not admitted');

    // A drain does not guess that the admitting process is gone.
    await fixture.cli(['trigger', 'drain', '--host', HOST]);
    expect(stageB().map(run => run.status)).toEqual(['pending']);

    // Where an operator looks, the start is shown with the command that runs it.
    const waiting = { requestId: stranded.id, hostId: HOST };
    const read = itemReadSchema.parse(
      JSON.parse(await fixture.cli(['workflow', 'runs', '--item', 'issue-1', '--json']))
    );
    expect(read.runs.map(run => run.awaitingExecution)).toEqual([null, waiting]);
    expect(await fixture.cli(['workflow', 'runs', '--item', 'issue-1'])).toContain(
      `archon trigger execute ${stranded.id} --host ${HOST}`
    );
    const listed = JSON.parse(await fixture.cli(['trigger', 'list'])) as {
      awaitingExecution: unknown[];
    }[];
    expect(listed.flatMap(receipt => receipt.awaitingExecution)).toEqual([waiting]);

    rmSync(logs);
    await fixture.cli(['trigger', 'execute', stranded.id, '--host', HOST]);
    expect(
      (await fixture.attempt(['trigger', 'execute', stranded.id, '--host', HOST])).exitCode
    ).not.toBe(0);
    expect(fixture.rows<RunRow>(RUNS_SQL).map(run => [run.workflow_name, run.status])).toEqual([
      ['stage-a', 'completed'],
      ['stage-b', 'completed'],
    ]);
  }, 90_000);

  test('a result pointer that does not resolve is reported where the run ends and in trigger list', async () => {
    const fixture = await makeFixture('pointer');
    fixture.bind('build-after-plan', {
      runEnded: { ...RUN_ENDED.runEnded, inputs: { plan: { result: '/missing' } } },
    });
    const ended = await fixture.cli([
      'workflow',
      'run',
      'stage-a',
      '--no-worktree',
      '--item',
      'issue-1',
      '--input',
      'plan=p1',
      '--input',
      'issue=i1',
    ]);
    expect(ended).toContain('/missing');
    expect(ended).toContain('not started');
    const [receipt, ...rest] = JSON.parse(await fixture.cli(['trigger', 'list'])) as {
      outcome: string;
      reason: string | null;
    }[];
    expect(rest).toEqual([]);
    expect(receipt?.outcome).toBe('unmatched');
    expect(receipt?.reason).toContain('/missing');
    expect(fixture.rows<RunRow>(RUNS_SQL).map(run => run.workflow_name)).toEqual(['stage-a']);
  }, 90_000);

  test('a binding that names a missing stage is refused before the stage feeding it runs', async () => {
    const fixture = await makeFixture('missing');
    fixture.bind('build-after-plan', RUN_ENDED);
    const file = join(fixture.archonHome, 'triggers', 'build-after-plan.json');
    const config = JSON.parse(readFileSync(file, 'utf8')) as {
      binding: { launch: { workflowName: string } };
    };
    config.binding.launch.workflowName = 'missing-stage';
    writeFileSync(file, JSON.stringify(config));

    const checked = await fixture.attempt(['trigger', 'check']);
    expect(checked.exitCode).not.toBe(0);
    expect(checked.stdout).toContain("workflow 'missing-stage' is not in this project");

    const launch = [
      'workflow',
      'run',
      'stage-a',
      '--no-worktree',
      '--item',
      'issue-1',
      '--input',
      'plan=p',
      '--input',
      'issue=i',
    ];
    const started = await fixture.attempt(launch);
    expect(started.exitCode).not.toBe(0);
    expect(started.stdout + started.stderr).toContain(
      "workflow 'missing-stage' is not in this project"
    );
    // A detached launch is refused in the result it prints, not later in its child.
    const detached = await fixture.attempt([...launch, '--detach', '--json']);
    expect(detached.exitCode).not.toBe(0);
    const refused = JSON.parse(detached.stdout) as { ok: boolean; error: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("workflow 'missing-stage' is not in this project");
    const runs = fixture.rows<{ status: string; events: number }>(
      `SELECT r.status, (SELECT COUNT(*) FROM remote_agent_workflow_events e
         WHERE e.workflow_run_id = r.id AND e.event_type = 'node_started') AS events
         FROM remote_agent_workflow_runs r`
    );
    expect(runs).toEqual([
      { status: 'cancelled', events: 0 },
      { status: 'cancelled', events: 0 },
    ]);
  }, 90_000);
});

describe('trigger check', () => {
  test('reports a duplicate stage, a stage bound to itself and a missing launch.cwd', async () => {
    const fixture = await makeFixture('check');
    fixture.bind('build-after-plan', RUN_ENDED);
    fixture.bind('build-after-plan-copy', RUN_ENDED);
    fixture.bind('plan-again', RUN_ENDED, { workflowName: 'stage-a' });
    const gone = join(fixture.root, 'deleted-checkout');
    fixture.bind('stale', RUN_ENDED, { cwd: gone });

    const checked = await fixture.attempt(['trigger', 'check']);
    expect(checked.exitCode).not.toBe(0);
    const problems = new Map(
      (
        JSON.parse(checked.stdout) as { runEnded: { file: string; problems: string[] }[] }
      ).runEnded.map(entry => [basename(entry.file, '.json'), entry.problems])
    );
    const duplicate = (other: string): string =>
      `binds the same outcome to the same stage as ${join(fixture.archonHome, 'triggers', `${other}.json`)}: the stage starts once per file on the item`;
    expect(problems.get('build-after-plan')).toEqual([duplicate('build-after-plan-copy')]);
    expect(problems.get('build-after-plan-copy')).toEqual([duplicate('build-after-plan')]);
    expect(problems.get('plan-again')).toEqual([
      "binding starts 'stage-a', the workflow whose end fires it: each run that completes with 'planned' starts another on the same item",
    ]);
    expect(problems.get('stale')).toEqual([
      `binding.launch.cwd '${gone}' does not exist, so this binding never starts; fix the path or remove the file`,
    ]);
  }, 90_000);
});

describe('a run end on a trigger host', () => {
  test('admits the queued starts its slot held back, with no further command', async () => {
    const fixture = await makeFixture('capacity');
    const config = fixture.fireConfig('pool', 'pool-work', 'pool', 2);
    for (let index = 0; index < 6; index++)
      await fixture.cli(['trigger', 'fire', '--config', config]);
    const runs = await waitFor(
      () => completedRuns(fixture, 6),
      'all six starts to run to their end'
    );
    expect(runs).toHaveLength(6);
  }, 90_000);

  test('a hand start takes a free slot even when another host has a start queued on it', async () => {
    const fixture = await makeFixture('free-slot');
    const held = fixture.start(['workflow', 'run', 'held', '--no-worktree']);
    await waitFor(
      () => (existsSync(join(fixture.projectRoot, 'held-started')) ? true : undefined),
      'the held run to take the slot'
    );
    const queued = () =>
      fixture.rows<{ status: string }>(
        "SELECT status FROM remote_agent_resource_start_requests WHERE host_id = 'other-host'"
      );
    // Released in a finally, so a failed step cannot leave the held run polling forever.
    try {
      // Another host's start queues behind the held run; nothing drains that host.
      await fixture.cli([
        'trigger',
        'fire',
        '--config',
        fixture.fireConfig('other', 'quick', 'pool', 1, 'other-host'),
      ]);
      expect(queued()).toEqual([{ status: 'queued' }]);
    } finally {
      writeFileSync(join(fixture.projectRoot, 'release'), '');
    }
    expect(await held.exited).toBe(0);

    // The slot is free and nothing runs: the hand start is admitted, not refused as full
    // or left behind the other host's start, which keeps its place.
    const started = await fixture.attempt([
      'workflow',
      'run',
      'quick',
      '--no-worktree',
      '--no-wait',
    ]);
    expect(started.exitCode, started.stdout + started.stderr).toBe(0);
    expect(readFileSync(join(fixture.projectRoot, 'quick-ran'), 'utf8')).toBe('ran\n');
    expect(queued()).toEqual([{ status: 'queued' }]);
  }, 90_000);
});

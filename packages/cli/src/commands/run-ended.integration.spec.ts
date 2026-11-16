/**
 * A run's end starts the stage a run-ended binding names and admits the work its slot
 * held back, with no other command: real SQLite, every run in its own CLI process.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  rows: <T>(sql: string) => T[];
  fireConfig: (name: string, workflowName: string, resource: string, capacity?: number) => string;
  /** Write a run-ended binding where the ending process reads it. */
  bind: (name: string, file: Record<string, unknown>) => void;
  userId: string;
}

// Stage A returns a named outcome and the plan it was given; no node fires anything.
// Both stages take a second, so on SQLite, whose start times have one-second resolution,
// each run starts in a later second than the one before it and the order reads true.
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
      sleep 1
      printf '{"outcome": "planned", "plan": "%s"}' "$INPUTS_PLAN"
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
    bash: sleep 1; echo "building $INPUTS_PLAN"
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
  expect(await Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot }).exited).toBe(0);

  const cli = async (args: string[], env: Record<string, string> = {}): Promise<string> => {
    const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
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
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
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
    capacity?: number
  ) => ({
    bindingId,
    bindingRevision: null,
    hostId: HOST,
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
    rows,
    userId,
    fireConfig: (name, workflowName, resource, capacity) => {
      const path = join(root, `${name}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          sourceInstanceId: name,
          binding: binding(name, workflowName, resource, capacity),
        })
      );
      return path;
    },
    bind: (name, on) => {
      mkdirSync(join(archonHome, 'triggers'), { recursive: true });
      writeFileSync(
        join(archonHome, 'triggers', `${name}.json`),
        JSON.stringify({
          version: 1,
          sourceInstanceId: name,
          binding: binding(name, 'stage-b', 'stage-b'),
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

const RUNS_SQL =
  'SELECT id, workflow_name, status, metadata FROM remote_agent_workflow_runs ORDER BY started_at, id';

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
    expect(inputsOf(runs[1])).toEqual({ plan: 'first plan', issue: 'Fix the login page' });
    expect(inputsOf(runs[3])).toEqual({ plan: 'second plan', issue: 'Fix the login page' });

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

  test('a start the end caused survives a process that never drained, and starts exactly once', async () => {
    const fixture = await makeFixture('crash');
    fixture.bind('build-after-plan', RUN_ENDED);
    // Register the project with a first fired A; its end starts a B in the usual way.
    const fireA = fixture.fireConfig('plan', 'stage-a', 'stage-a');
    const inputs = join(fixture.root, 'inputs.json');
    writeFileSync(inputs, JSON.stringify({ plan: 'p1', issue: 'i1' }));
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
    await waitFor(() => completedRuns(fixture, 2), 'the first A and B');

    // A hand start serves no trigger host: it ends A and writes the start, then exits
    // without a drain, the state a process killed after the commit leaves behind.
    await fixture.cli([
      'workflow',
      'run',
      'stage-a',
      '--no-worktree',
      '--item',
      'issue-2',
      '--input',
      'plan=p2',
      '--input',
      'issue=i2',
    ]);
    const pending = () =>
      fixture.rows<{ preparation_status: string }>(
        `SELECT b.preparation_status FROM remote_agent_start_receipt_bindings b
           JOIN remote_agent_start_receipts r ON r.id = b.receipt_id
           WHERE r.item_key = 'issue-2'`
      );
    expect(pending()).toEqual([{ preparation_status: 'pending' }]);
    expect(
      fixture.rows<RunRow>(RUNS_SQL).filter(run => run.workflow_name === 'stage-b')
    ).toHaveLength(1);

    // The host's next drains start it, once.
    await fixture.cli(['trigger', 'drain', '--host', HOST]);
    await fixture.cli(['trigger', 'drain', '--host', HOST]);
    const runs = await waitFor(() => completedRuns(fixture, 4), 'the recovered B');
    expect(runs.filter(run => run.workflow_name === 'stage-b')).toHaveLength(2);
    await fixture.cli(['trigger', 'drain', '--host', HOST]);
    await Bun.sleep(500);
    expect(fixture.rows<RunRow>(RUNS_SQL)).toHaveLength(4);
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
});

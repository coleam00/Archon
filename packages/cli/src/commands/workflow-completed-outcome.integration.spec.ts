// @archon-test-isolated
/**
 * A run's outcome is written once, by the write that completes it (#5660), against a real
 * SQLite store with every run in its own process.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const cleanupPaths: string[] = [];
const ownerPids = new Set<number>();

afterEach(async () => {
  for (const pid of ownerPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  ownerPids.clear();
  for (const path of cleanupPaths.splice(0)) await removeTempTree(path);
});

interface Fixture {
  projectRoot: string;
  archonHome: string;
}

const DECIDE =
  '  - id: decide\n    bash: |\n      echo \'{"stage": "built"}\'\n' +
  '    output_format:\n      type: object\n' +
  '      properties:\n        stage: { type: string, enum: [built, stop] }\n' +
  '      required: [stage]\n';

function workflowWithLater(name: string, later: string): string {
  return (
    `name: ${name}\ndescription: Completed outcome fixture.\n` +
    'returns: { node: decide, outcome: stage }\nnodes:\n' +
    DECIDE +
    `  - id: later\n    depends_on: [decide]\n    bash: "${later}"\n`
  );
}

function makeFixture(workflows: Record<string, string>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'archon-completed-outcome-'));
  cleanupPaths.push(root);
  const projectRoot = join(root, 'project');
  const workflowsDir = join(projectRoot, '.archon', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  for (const [name, body] of Object.entries(workflows))
    writeFileSync(join(workflowsDir, `${name}.yaml`), body);
  return { projectRoot, archonHome: join(root, 'home') };
}

async function runCli(
  fixture: Fixture,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      ARCHON_HOME: fixture.archonHome,
      DATABASE_URL: '',
      WORKFLOW_ID: '',
      ARCHON_NODE_EXECUTION: '',
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
  return { exitCode, stdout, stderr };
}

async function launchDetached(fixture: Fixture, workflow: string): Promise<string> {
  const { exitCode, stdout, stderr } = await runCli(fixture, [
    'workflow',
    'run',
    workflow,
    'completed outcome',
    '--folder',
    '--detach',
    '--json',
  ]);
  if (exitCode !== 0) throw new Error(`Detached launcher failed: ${stderr || stdout}`);
  return (JSON.parse(stdout.trim()) as { runId: string }).runId;
}

interface StoredRun {
  status: string;
  outcome: string | null;
  completed_outcome: string | null;
  metadata: { execution_owner?: { pid?: number } };
}

interface StoredEvent {
  event_type: string;
  step_name: string | null;
  data: Record<string, unknown>;
}

async function getRun(fixture: Fixture, runId: string): Promise<StoredRun> {
  const { stdout } = await runCli(fixture, ['workflow', 'get', runId, '--json']);
  return JSON.parse(stdout) as StoredRun;
}

async function getEvents(fixture: Fixture, runId: string): Promise<StoredEvent[]> {
  const { stdout } = await runCli(fixture, [
    'workflow',
    'get',
    runId,
    '--json',
    '--verbose',
    '--events',
  ]);
  return (JSON.parse(stdout) as { events: StoredEvent[] }).events;
}

const decideCompleted = (events: StoredEvent[]): StoredEvent | undefined =>
  events.find(event => event.event_type === 'node_completed' && event.step_name === 'decide');

/** Poll until `done` holds of the stored run and its events. */
async function until(
  fixture: Fixture,
  runId: string,
  done: (run: StoredRun, events: StoredEvent[]) => boolean
): Promise<{ run: StoredRun; events: StoredEvent[] }> {
  let last = '';
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await Bun.sleep(100)) {
    const run = await getRun(fixture, runId);
    const events = await getEvents(fixture, runId);
    last = JSON.stringify({ run, events });
    if (done(run, events)) return { run, events };
  }
  throw new Error(`run ${runId} never reached the expected state: ${last}`);
}

test('a process killed after the returns node completed leaves no outcome on the stored run', async () => {
  const fixture = makeFixture({ 'outcome-crash': workflowWithLater('outcome-crash', 'sleep 30') });
  const runId = await launchDetached(fixture, 'outcome-crash');

  const { run } = await until(
    fixture,
    runId,
    (stored, events) =>
      decideCompleted(events) !== undefined && stored.metadata.execution_owner?.pid !== undefined
  );
  const pid = run.metadata.execution_owner?.pid as number;
  ownerPids.add(pid);
  // SIGKILL runs no handler: the store keeps exactly what it held when the process died.
  process.kill(pid, 'SIGKILL');
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(50)) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
  }

  expect(await getRun(fixture, runId)).toMatchObject({
    status: 'running',
    outcome: null,
    completed_outcome: null,
  });
}, 120_000);

test('a run whose later work fails has no outcome, and the returns node output stays readable (#2618)', async () => {
  const fixture = makeFixture({
    'outcome-later-fails': workflowWithLater('outcome-later-fails', 'exit 1'),
  });
  const runId = await launchDetached(fixture, 'outcome-later-fails');

  const { run, events } = await until(fixture, runId, stored => stored.status === 'failed');

  expect(run).toMatchObject({ outcome: null, completed_outcome: null });
  expect(decideCompleted(events)?.data).toMatchObject({ structured_output: { stage: 'built' } });
}, 120_000);

test('a run that completes records its enum outcome in completed_outcome only', async () => {
  const fixture = makeFixture({
    'outcome-completes': workflowWithLater('outcome-completes', 'true'),
  });
  const runId = await launchDetached(fixture, 'outcome-completes');

  const { run } = await until(fixture, runId, stored => stored.status === 'completed');

  expect(run).toMatchObject({ outcome: null, completed_outcome: 'built' });
}, 120_000);

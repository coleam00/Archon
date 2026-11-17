// @archon-test-isolated
/**
 * A run on an item reads what an earlier run on that item returned, through a declared
 * `result_of` input: real SQLite, every run in its own CLI process.
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { itemReadSchema, type ItemRun } from '@archon/workflows/item-read';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await removeTempTree(root);
});

// Returns a result derived from its input, padded to `size` bytes so a run can return a
// result far past the 32 KiB cap on persisted node text.
const STAGE_A = `name: stage-a
description: Return a tagged result.
mutates_checkout: false
inputs:
  tag: { required: true }
  size: { default: '0' }
returns: decide
nodes:
  - id: decide
    bash: |
      pad=$(printf '%*s' "$INPUTS_SIZE" '' | tr ' ' x)
      printf '{"tag": "%s", "pad": "%s"}' "$INPUTS_TAG" "$pad"
    output_format:
      type: object
      properties: { tag: { type: string }, pad: { type: string } }
      required: [tag, pad]
`;

const STAGE_B = `name: stage-b
description: Unrelated work on the item.
mutates_checkout: false
returns: work
nodes:
  - id: work
    bash: |
      echo '{"done": true}'
    output_format: { type: object, properties: { done: { type: boolean } }, required: [done] }
`;

/** A reader that returns what its \`result_of\` input read, so the value is checkable. */
function reader(name: string, source: string): string {
  return `name: ${name}
description: Return what the latest ${source} returned.
mutates_checkout: false
inputs:
  prior: { result_of: ${source} }
returns: echo
nodes:
  - id: echo
    bash: |
      printf '{"read": %s}' "$INPUTS_PRIOR"
    output_format: { type: object, properties: { read: {} }, required: [read] }
`;
}

// Its returns node completes, then a later node fails the run.
const FAILS_LATE = `name: fails-late
description: Return a result, then fail.
mutates_checkout: false
returns: decide
nodes:
  - id: decide
    bash: |
      echo '{"tag": "stale"}'
    output_format: { type: object, properties: { tag: { type: string } }, required: [tag] }
  - id: later
    depends_on: [decide]
    bash: exit 1
`;

// Reads the latest result of its own workflow, and returns a count one past it.
const AGAIN = `name: again
description: Count rounds on the item.
mutates_checkout: false
inputs:
  prior: { result_of: again }
returns: count
nodes:
  - id: count
    bash: |
      last=$(printf '%s' "$INPUTS_PRIOR" | sed -n 's/.*"round":\\([0-9]*\\).*/\\1/p')
      printf '{"round": %s}' "$(( \${last:-0} + 1 ))"
    output_format: { type: object, properties: { round: { type: number } }, required: [round] }
`;

interface Fixture {
  /** The project checkout every run works in. */
  projectRoot: string;
  /** The run rows, oldest first. */
  rows: () => { id: string; status: string; metadata: string }[];
  /** Overwrite a run's terminal event data, as a damaged row reads. */
  corruptTerminalEvent: (runId: string, data: string) => void;
  cli: (args: string[]) => Promise<string>;
  attempt: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const WORKFLOWS: Record<string, string> = {
  'stage-a': STAGE_A,
  'stage-b': STAGE_B,
  'stage-c': reader('stage-c', 'stage-a'),
  'reads-failed': reader('reads-failed', 'fails-late'),
  'fails-late': FAILS_LATE,
  again: AGAIN,
};

async function makeFixture(
  label: string,
  workflowFiles: Record<string, string> = WORKFLOWS
): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `archon-item-results-${label}-`)));
  tempRoots.push(root);
  const projectRoot = join(root, 'project');
  const workflows = join(projectRoot, '.archon', 'workflows');
  mkdirSync(workflows, { recursive: true });
  for (const [name, body] of Object.entries(workflowFiles))
    writeFileSync(join(workflows, `${name}.yaml`), body);
  expect(await Bun.spawn(['git', 'init', '-q'], { cwd: projectRoot }).exited).toBe(0);
  const attempt = async (
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        WORKFLOW_ID: '',
        ARCHON_NODE_EXECUTION: '',
        ARCHON_TRIGGER_HOST: '',
        DATABASE_URL: '',
        ARCHON_HOME: join(root, 'home'),
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        GITHUB_APP_ID: '',
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
  };
  const cli = async (args: string[]): Promise<string> => {
    const { exitCode, stdout, stderr } = await attempt(args);
    if (exitCode !== 0)
      throw new Error(`archon ${args.join(' ')} failed (${String(exitCode)}): ${stderr || stdout}`);
    return stdout;
  };
  const rows = () => {
    const database = new Database(join(root, 'home', 'archon.db'), { readonly: true });
    try {
      return database
        .query<{ id: string; status: string; metadata: string }, []>(
          'SELECT id, status, metadata FROM remote_agent_workflow_runs ORDER BY started_at, rowid'
        )
        .all();
    } finally {
      database.close();
    }
  };
  const corruptTerminalEvent = (runId: string, data: string): void => {
    const database = new Database(join(root, 'home', 'archon.db'));
    try {
      database
        .query(
          "UPDATE remote_agent_workflow_events SET data = ? WHERE workflow_run_id = ? AND event_type = 'workflow_completed'"
        )
        .run(data, runId);
    } finally {
      database.close();
    }
  };
  return { projectRoot, cli, attempt, rows, corruptTerminalEvent };
}

const run = (workflow: string, ...inputs: string[]): string[] => [
  'workflow',
  'run',
  workflow,
  '--no-worktree',
  '--item',
  'issue-1',
  ...inputs.flatMap(input => ['--input', input]),
];

async function itemRuns(fixture: Fixture): Promise<ItemRun[]> {
  return itemReadSchema.parse(
    JSON.parse(await fixture.cli(['workflow', 'runs', '--item', 'issue-1', '--json']))
  ).runs;
}

interface RunDetail {
  terminal_record: {
    returns: { availability: string; value?: unknown };
    artifacts: { root: string | null };
  };
}

async function detail(fixture: Fixture, runId: string | undefined): Promise<RunDetail> {
  return JSON.parse(await fixture.cli(['workflow', 'get', String(runId), '--json'])) as RunDetail;
}

test('a reader gets the latest result of the workflow it names, from the database alone', async () => {
  const fixture = await makeFixture('latest');
  await fixture.cli(run('stage-a', 'tag=r1'));
  await fixture.cli(run('stage-b'));
  await fixture.cli(run('stage-a', 'tag=r2', 'size=40000'));
  const [, , secondA] = await itemRuns(fixture);
  // The reader has no access to the run's artifacts directory, as on a second host.
  const { artifacts } = (await detail(fixture, secondA?.id)).terminal_record;
  expect(artifacts.root).not.toBeNull();
  rmSync(String(artifacts.root), { recursive: true, force: true });
  expect(existsSync(String(artifacts.root))).toBe(false);

  const output = await fixture.cli(run('stage-c'));
  expect(output).toContain(`result of \`stage-a\` run \`${String(secondA?.id)}\``);
  const runs = await itemRuns(fixture);
  expect(runs.map(read => [read.workflow, read.hasResult])).toEqual([
    ['stage-a', true],
    ['stage-b', true],
    ['stage-a', true],
    ['stage-c', true],
  ]);
  const { returns } = (await detail(fixture, runs[3]?.id)).terminal_record;
  expect(returns.value).toEqual({ read: { tag: 'r2', pad: 'x'.repeat(40_000) } });
}, 120_000);

test('a run that failed after its returns node completed has no result for a reader', async () => {
  const fixture = await makeFixture('failed');
  expect((await fixture.attempt(run('fails-late'))).exitCode).not.toBe(0);
  const output = await fixture.cli(run('reads-failed'));
  expect(output).toContain('no completed run of `fails-late` on the item');
  const runs = await itemRuns(fixture);
  expect(runs.map(read => [read.workflow, read.status, read.hasResult])).toEqual([
    ['fails-late', 'failed', false],
    ['reads-failed', 'completed', true],
  ]);
  expect((await detail(fixture, runs[1]?.id)).terminal_record.returns.value).toEqual({
    read: null,
  });
}, 120_000);

test('an unreadable terminal record fails the reader instead of reading as no result', async () => {
  const fixture = await makeFixture('unreadable');
  await fixture.cli(run('stage-a', 'tag=r1'));
  const [written] = fixture.rows();
  fixture.corruptTerminalEvent(String(written?.id), '{not json');
  const failed = await fixture.attempt(run('stage-c'));
  expect(failed.exitCode).not.toBe(0);
  expect(`${failed.stdout}${failed.stderr}`).toContain(
    'Unable to read the earlier results its result_of inputs name'
  );
  expect(fixture.rows().map(row => row.status)).toEqual(['completed', 'failed']);
}, 120_000);

test('a stage reads the latest result of its own workflow on the item', async () => {
  const fixture = await makeFixture('again');
  await fixture.cli(run('again'));
  await fixture.cli(run('again'));
  const runs = await itemRuns(fixture);
  expect((await detail(fixture, runs[0]?.id)).terminal_record.returns.value).toEqual({ round: 1 });
  expect((await detail(fixture, runs[1]?.id)).terminal_record.returns.value).toEqual({ round: 2 });
}, 120_000);

test('a reader with no item is refused before it starts, unless the value is supplied', async () => {
  const fixture = await makeFixture('no-item');
  const refused = await fixture.attempt(['workflow', 'run', 'stage-c', '--no-worktree']);
  expect(refused.exitCode).not.toBe(0);
  expect(`${refused.stdout}${refused.stderr}`).toContain(
    "reads input 'prior' from result_of 'stage-a', which resolves from the run's item"
  );
  // No node ran: the run was cancelled before its claim.
  expect(fixture.rows().map(row => row.status)).toEqual(['cancelled']);

  await fixture.cli(['workflow', 'run', 'stage-c', '--no-worktree', '--input', 'prior="supplied"']);
  const supplied = fixture.rows()[1];
  expect(supplied?.status).toBe('completed');
  expect((await detail(fixture, supplied?.id)).terminal_record.returns.value).toEqual({
    read: 'supplied',
  });
}, 120_000);

// A review whose verdict names the commit it saw, so a reader can tell which review it got.
const REVIEW = `name: review
description: Approve the change.
mutates_checkout: false
returns: verdict
nodes:
  - id: verdict
    bash: |
      printf '{"verdict": "approve", "seen": "%s"}' "$(git rev-parse HEAD)"
    output_format:
      type: object
      properties: { verdict: { type: string }, seen: { type: string } }
      required: [verdict, seen]
`;

// Lands its own HEAD on \`landed\` only when the review holds at that commit; otherwise
// says where the latest review holds, read from the item, and moves nothing.
const LAND = `name: land
description: Land the commit the approval holds at.
mutates_checkout: false
inputs:
  approval: { result_of: review, at: checkout }
returns: decide
nodes:
  - id: decide
    runtime: bun
    script: |
      import { execFileSync } from 'node:child_process';
      import { emit, item } from 'archon:script';
      const approval = JSON.parse(process.env.INPUTS_APPROVAL ?? 'null');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (approval !== null) {
        execFileSync('git', ['update-ref', 'refs/heads/landed', head]);
        emit({ landed: head, seen: approval.seen, message: null });
      } else {
        const reviews = (item()?.runs ?? []).filter(run => run.workflow === 'review' && run.status === 'completed');
        const approvedAt = reviews.at(-1)?.resultCommit ?? 'no commit';
        emit({ landed: null, seen: null, message: \`approved at \${approvedAt}, the change is now at \${head}\` });
      }
    output_format:
      type: object
      properties: { landed: {}, seen: {}, message: {} }
      required: [landed, seen, message]
`;

test('a land stage merges only the commit its approval holds at', async () => {
  const fixture = await makeFixture('land', { review: REVIEW, land: LAND });
  const git = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn(
      [
        'git',
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: fixture.projectRoot, stdout: 'pipe', stderr: 'pipe' }
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
    return stdout.trim();
  };
  const commit = async (file: string): Promise<string> => {
    writeFileSync(join(fixture.projectRoot, file), file);
    await git('add', '-A');
    await git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  const landed = () =>
    git('rev-parse', '--verify', '--quiet', 'refs/heads/landed').catch(() => null);
  const landResult = async (): Promise<{
    landed: string | null;
    seen: string | null;
    message: string | null;
  }> => {
    const runs = await itemRuns(fixture);
    const last = runs.at(-1);
    expect(last?.workflow).toBe('land');
    return (await detail(fixture, last?.id)).terminal_record.returns.value as {
      landed: string | null;
      seen: string | null;
      message: string | null;
    };
  };

  const x = await commit('x.txt');
  await fixture.cli(run('review'));
  await fixture.cli(run('land'));
  expect(await landResult()).toEqual({ landed: x, seen: x, message: null });
  expect(await landed()).toBe(x);

  // The change moves on: the approval at X does not hold at Y.
  const y = await commit('y.txt');
  const refused = await fixture.cli(run('land'));
  expect(refused).toContain(`no completed run of \`review\` holds at ${y.slice(0, 12)}`);
  expect(refused).toContain(`holds at ${x.slice(0, 12)}`);
  expect(await landResult()).toEqual({
    landed: null,
    seen: null,
    message: `approved at ${x}, the change is now at ${y}`,
  });
  expect(await landed()).toBe(x);

  // With a later review at Y, a land at X still reads the review that holds at X.
  await fixture.cli(run('review'));
  await git('checkout', '-q', '--detach', x);
  await fixture.cli(run('land'));
  expect(await landResult()).toEqual({ landed: x, seen: x, message: null });

  // A review that completed with an untracked file present holds at no commit.
  const z = await commit('z.txt');
  writeFileSync(join(fixture.projectRoot, 'untracked.txt'), 'not committed');
  await fixture.cli(run('review'));
  await fixture.cli(run('land'));
  expect(await landResult()).toEqual({
    landed: null,
    seen: null,
    message: `approved at no commit, the change is now at ${z}`,
  });
  expect(await landed()).toBe(x);

  const reviews = (await itemRuns(fixture)).filter(read => read.workflow === 'review');
  expect(reviews.map(read => [read.hasResult, read.resultCommit])).toEqual([
    [true, x],
    [true, y],
    [true, null],
  ]);
}, 240_000);

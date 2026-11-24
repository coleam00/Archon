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

// Reader with result_of that pauses at an approval gate and resumes.
const RESUMES_NULL = `name: resumes-null
description: Reader with result_of that pauses and resumes.
mutates_checkout: false
inputs:
  prior: { result_of: fails-late }
returns: after
nodes:
  - id: gate
    approval:
      message: please approve
  - id: after
    depends_on: [gate]
    bash: |
      printf '{"read": %s}' "$INPUTS_PRIOR"
    output_format: { type: object, properties: { read: {} }, required: [read] }
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
  'resumes-null': RESUMES_NULL,
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

test('a resumed run preserves a result_of input that resolved to null at start (#5939)', async () => {
  const fixture = await makeFixture('resume-null');
  expect((await fixture.attempt(run('fails-late'))).exitCode).not.toBe(0);
  const started = await fixture.attempt(run('resumes-null'));
  expect(started.stdout).toContain('waiting for approval');
  const [, pausedRun] = await itemRuns(fixture);
  expect(pausedRun?.status).toBe('paused');
  await fixture.cli(['workflow', 'approve', String(pausedRun?.id)]);
  const runs = await itemRuns(fixture);
  expect(runs.map(read => [read.workflow, read.status, read.hasResult])).toEqual([
    ['fails-late', 'failed', false],
    ['resumes-null', 'completed', true],
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
  // A detached start is refused in the result it prints, before its child is forked.
  const detached = await fixture.attempt([
    'workflow',
    'run',
    'stage-c',
    '--no-worktree',
    '--detach',
    '--json',
  ]);
  expect(detached.exitCode).not.toBe(0);
  const refusal = JSON.parse(detached.stdout) as { ok: boolean; error: string };
  expect(refusal.ok).toBe(false);
  expect(refusal.error).toContain(
    "reads input 'prior' from result_of 'stage-a', which resolves from the run's item"
  );
  expect(fixture.rows().map(row => row.status)).toEqual(['cancelled', 'cancelled']);

  await fixture.cli(['workflow', 'run', 'stage-c', '--no-worktree', '--input', 'prior="supplied"']);
  const supplied = fixture.rows()[2];
  expect(supplied?.status).toBe('completed');
  expect((await detail(fixture, supplied?.id)).terminal_record.returns.value).toEqual({
    read: 'supplied',
  });
}, 120_000);

// A review that returns its verdict. With \`after=commit\`, a later node commits. With
// \`beside=commit\`, a parallel node commits while the judge waits for it.
const REVIEW = `name: review
description: Judge the change.
inputs:
  verdict: { default: approve }
  after: { default: none }
  beside: { default: none }
returns: judge
nodes:
  - id: judge
    bash: |
      start=$(git rev-parse HEAD)
      if [ "$INPUTS_BESIDE" = commit ]; then
        for _ in $(seq 100); do [ "$(git rev-parse HEAD)" != "$start" ] && break; sleep 0.1; done
      fi
      printf '{"verdict": "%s"}' "$INPUTS_VERDICT"
    output_format: { type: object, properties: { verdict: { type: string } }, required: [verdict] }
  - id: writer
    when: "$INPUTS.beside == 'commit'"
    bash: |
      echo beside > beside.txt
      git add beside.txt
      git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m beside
  - id: later
    depends_on: [judge]
    bash: |
      if [ "$INPUTS_AFTER" = commit ]; then
        echo later > later.txt
        git add later.txt
        git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m later
      fi
`;

// Lands the commit its approval holds at, only on an approving verdict; otherwise says why
// and moves nothing. With \`move=commit\`, its checkout moves before it decides.
const LAND = `name: land
description: Land the commit the approval holds at.
inputs:
  approval: { result_of: review, at: checkout }
  move: { default: none }
returns: decide
nodes:
  - id: move
    bash: |
      if [ "$INPUTS_MOVE" = commit ]; then
        echo moved > moved.txt
        git add moved.txt
        git -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m moved
      fi
  - id: decide
    depends_on: [move]
    runtime: bun
    script: |
      import { execFileSync } from 'node:child_process';
      import { emit, item } from 'archon:script';
      const approval = JSON.parse(process.env.INPUTS_APPROVAL ?? 'null');
      if (approval === null) {
        const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        const reviews = (item()?.runs ?? [])
          .filter(run => run.workflow === 'review' && run.status === 'completed')
          .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
        const heldAt = reviews.at(-1)?.resultCommit ?? 'no commit';
        emit({ landed: null, message: \`the latest review holds at \${heldAt}, the change is now at \${head}\` });
      } else if (approval.result.verdict !== 'approve') {
        emit({ landed: null, message: \`review at \${approval.commit} returned \${approval.result.verdict}\` });
      } else {
        execFileSync('git', ['update-ref', 'refs/heads/landed', approval.commit]);
        emit({ landed: approval.commit, message: null });
      }
    output_format:
      type: object
      properties: { landed: {}, message: {} }
      required: [landed, message]
`;

// A read-only check, which takes no path lock: it marks that it is judging, then waits
// for another process to commit in its checkout.
const CHECK = `name: check
description: Check the change without writing to it.
mutates_checkout: false
returns: judge
nodes:
  - id: judge
    bash: |
      start=$(git rev-parse HEAD)
      touch "$(git rev-parse --git-dir)/judging"
      for _ in $(seq 100); do [ "$(git rev-parse HEAD)" != "$start" ] && break; sleep 0.1; done
      echo '{"verdict": "approve"}'
    output_format: { type: object, properties: { verdict: { type: string } }, required: [verdict] }
`;

interface LandFixture {
  fixture: Fixture;
  commit: (file: string) => Promise<string>;
  /** Where \`landed\` points, or null when nothing has landed. */
  landed: () => Promise<string | null>;
  /** Run \`land\` and return its result. */
  land: (...inputs: string[]) => Promise<{ landed: string | null; message: string | null }>;
  reviews: () => Promise<ItemRun[]>;
  checkout: (commit: string) => Promise<void>;
}

async function makeLandFixture(label: string): Promise<LandFixture> {
  const fixture = await makeFixture(label, { review: REVIEW, land: LAND, check: CHECK });
  const git = async (...args: string[]): Promise<{ exitCode: number; stdout: string }> => {
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
    return { exitCode, stdout: stdout.trim() };
  };
  const commit = async (file: string): Promise<string> => {
    writeFileSync(join(fixture.projectRoot, file), file);
    for (const args of [
      ['add', '-A'],
      ['commit', '-q', '-m', file],
    ])
      expect((await git(...args)).exitCode).toBe(0);
    return (await git('rev-parse', 'HEAD')).stdout;
  };
  const landed = async (): Promise<string | null> => {
    const read = await git('rev-parse', '--verify', '--quiet', 'refs/heads/landed');
    return read.exitCode === 0 ? read.stdout : null;
  };
  const land = async (...inputs: string[]) => {
    await fixture.cli(run('land', ...inputs));
    const last = (await itemRuns(fixture)).at(-1);
    expect(last?.workflow).toBe('land');
    return (await detail(fixture, last?.id)).terminal_record.returns.value as {
      landed: string | null;
      message: string | null;
    };
  };
  const reviews = async () => (await itemRuns(fixture)).filter(read => read.workflow === 'review');
  const checkout = async (target: string): Promise<void> => {
    expect((await git('checkout', '-q', '--detach', target)).exitCode).toBe(0);
  };
  return { fixture, commit, landed, land, reviews, checkout };
}

test('a land stage merges only the commit its approval holds at', async () => {
  const { fixture, commit, landed, land, reviews, checkout } = await makeLandFixture('land');
  const x = await commit('x.txt');
  await fixture.cli(run('review'));
  expect(await land()).toEqual({ landed: x, message: null });

  // The change moves on: the approval at X does not hold at Y.
  const y = await commit('y.txt');
  const refused = await fixture.cli(run('land'));
  expect(refused).toContain(`no completed run of \`review\` holds at ${y.slice(0, 12)}`);
  expect(refused).toContain(`holds at ${x.slice(0, 12)}`);
  const lastLand = (await itemRuns(fixture)).at(-1);
  expect((await detail(fixture, lastLand?.id)).terminal_record.returns.value).toEqual({
    landed: null,
    message: `the latest review holds at ${x}, the change is now at ${y}`,
  });
  expect(await landed()).toBe(x);

  // A later review at Y does not replace the one that holds at X.
  await fixture.cli(run('review'));
  await checkout(x);
  expect(await land()).toEqual({ landed: x, message: null });
  expect((await reviews()).map(read => read.resultCommit)).toEqual([x, y]);
}, 240_000);

test('a land stage reads the latest verdict at its commit and refuses a rejecting one', async () => {
  const { fixture, commit, landed, land } = await makeLandFixture('verdict');
  const x = await commit('x.txt');
  await fixture.cli(run('review'));
  await fixture.cli(run('review', 'verdict=return'));
  expect(await land()).toEqual({ landed: null, message: `review at ${x} returned return` });
  // Once the change moves on, the land names where the rejecting review holds, not an approval.
  const y = await commit('y.txt');
  expect(await land()).toEqual({
    landed: null,
    message: `the latest review holds at ${x}, the change is now at ${y}`,
  });
  expect(await landed()).toBeNull();
}, 240_000);

test('a result holds at no commit when the checkout moved after the verdict, or was dirty', async () => {
  const { fixture, commit, landed, land, reviews } = await makeLandFixture('moved');
  const x = await commit('x.txt');
  // The verdict is given at X, then a later node of the same run commits Y.
  await fixture.cli(run('review', 'after=commit'));
  const [moved] = await reviews();
  expect(moved?.resultCommit).toBeNull();
  expect((await detail(fixture, moved?.id)).terminal_record).toMatchObject({
    result_commit: { held: false, reason: 'moved' },
  });
  const { message } = await land();
  expect(message).toStartWith('the latest review holds at no commit, the change is now at ');
  expect(message).not.toContain(x);

  // A review that completes with an untracked file present holds at no commit.
  const z = await commit('z.txt');
  writeFileSync(join(fixture.projectRoot, 'untracked.txt'), 'not committed');
  await fixture.cli(run('review'));
  expect(await land()).toEqual({
    landed: null,
    message: `the latest review holds at no commit, the change is now at ${z}`,
  });
  expect(await landed()).toBeNull();
}, 240_000);

test('a result given while a parallel node committed holds at no commit', async () => {
  const { fixture, commit, landed, land, reviews } = await makeLandFixture('beside');
  await commit('x.txt');
  // The judge reads X; its sibling commits Y before the judge returns its verdict.
  await fixture.cli(run('review', 'beside=commit'));
  const [beside] = await reviews();
  expect(beside?.resultCommit).toBeNull();
  expect((await detail(fixture, beside?.id)).terminal_record).toMatchObject({
    result_commit: { held: false, reason: 'concurrent' },
  });
  expect((await land()).landed).toBeNull();
  expect(await landed()).toBeNull();
}, 240_000);

test('a run that takes no path lock holds at no commit when another process commits under it', async () => {
  const { fixture, commit } = await makeLandFixture('unlocked');
  await commit('x.txt');
  const checking = fixture.cli(run('check'));
  const marker = join(fixture.projectRoot, '.git', 'judging');
  for (let tries = 0; tries < 300 && !existsSync(marker); tries++) await Bun.sleep(100);
  expect(existsSync(marker)).toBe(true);
  await commit('y.txt');
  await checking;
  const [checked] = (await itemRuns(fixture)).filter(read => read.workflow === 'check');
  expect(checked?.resultCommit).toBeNull();
  expect((await detail(fixture, checked?.id)).terminal_record).toMatchObject({
    result_commit: { held: false, reason: 'moved' },
  });
}, 240_000);

test('a land stage merges the commit its approval was read at, not where its checkout moved', async () => {
  const { fixture, commit, landed, land } = await makeLandFixture('land-moves');
  const x = await commit('x.txt');
  await fixture.cli(run('review'));
  expect(await land('move=commit')).toEqual({ landed: x, message: null });
  expect(await landed()).toBe(x);
}, 240_000);

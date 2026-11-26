// @archon-test-isolated
/**
 * A loop made of runs: build, then a read-only check on the built commit, then build again
 * on the same branch when the check returns it. Three run-ended bindings with
 * `checkout: "ended-run"`, real git and SQLite, every run in its own CLI process. Then the
 * same hand-off from a run that left asks, through `checkout: "asking-run"`, and from a run
 * that left a wait, through a wake binding with `checkout: "waiting-run"`.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { itemReadSchema } from '@archon/workflows/item-read';

const CLI_PATH = resolve(import.meta.dir, '..', 'cli.ts');
const DEADLINE_MS = 60_000;
const track = trackTempRoots();

// Each build adds one commit and publishes it, so nothing but the hand-off keeps its worktree.
const BUILD = `name: build
description: Add a commit.
returns: { node: commit, outcome: outcome }
nodes:
  - id: commit
    bash: |
      set -e
      n=$(git rev-list --count HEAD)
      echo "$n" > "build-$n.txt"
      git add . && git commit -qm "build $n" && git push -q origin HEAD
      printf '{"outcome": "built"}'
    output_format:
      type: object
      properties: { outcome: { type: string, enum: [built] } }
      required: [outcome]
`;

const PINNED = `name: pinned
description: Runs in place.
worktree: { enabled: false }
returns: { node: done, outcome: outcome }
nodes:
  - id: done
    bash: |
      printf '{"outcome": "built"}'
    output_format:
      type: object
      properties: { outcome: { type: string, enum: [built] } }
      required: [outcome]
`;

/** A read-only check; its body records what it saw and decides. */
const check = (body: string) => `name: check
description: Check the built commit.
mutates_checkout: false
returns: { node: look, outcome: outcome }
nodes:
  - id: look
    bash: |
      set -e
${body
  .trim()
  .split('\n')
  .map(line => `      ${line}`)
  .join('\n')}
    output_format:
      type: object
      properties: { outcome: { type: string, enum: [pass, return] } }
      required: [outcome]
`;

// Commits, publishes, and leaves one ask on its item.
/** Leaves one ask; `body` runs first. `ask-build` commits, `ask-look` is read-only. */
const leavesAsk = (name: string, readOnly: boolean, body: string) => `name: ${name}
description: Ask.
${readOnly ? 'mutates_checkout: false\n' : ''}returns: { node: commit, asks: asks }
nodes:
  - id: commit
    bash: |
      set -e
      ${body}
      printf '%s' '${JSON.stringify({
        summary: 'asked',
        asks: [
          {
            question: 'Keep going?',
            context: 'Half built.',
            options: [
              { id: 'go', does: 'Go on.', cost: 'Time.' },
              { id: 'stop', does: 'Stop.', cost: 'Work.' },
            ],
            recommendation: { option: 'go', why: 'It is half built.' },
            artifacts: [],
          },
        ],
      })}'
    output_format:
      type: object
      properties: { summary: { type: string } }
      required: [summary]
`;
const ASK_BUILD = leavesAsk(
  'ask-build',
  false,
  'echo asked > asked.txt && git add . && git commit -qm "asked" && git push -q origin HEAD'
);

/** A stage that records the branch and commit it starts on; `carry-on` then adds a commit. */
const stageAfterAsks = (name: string, readOnly: boolean, then = '') => `name: ${name}
description: Continue after the answers.
inputs:
  progress: {}
${readOnly ? 'mutates_checkout: false\n' : ''}nodes:
  - id: record
    bash: |
      set -e
      echo "$(git branch --show-current) $(git rev-parse HEAD)" > "$ROOT/${name}"
      ${then}
`;

interface Fixture {
  root: string;
  repo: string;
  home: string;
  git: (...args: string[]) => string;
  cli: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  rows: <T>(sql: string) => T[];
  bind: (name: string, ended: string, outcome: string, stage: string) => void;
  bindAsks: (name: string, asking: string, stage: string, inputs?: Record<string, unknown>) => void;
}

async function makeFixture(label: string, checkBody: string): Promise<Fixture> {
  const root = track(realpathSync(mkdtempSync(join(tmpdir(), `archon-handoff-${label}-`))));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const origin = join(root, 'origin.git');
  mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(['git', '-C', repo, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git('init', '-q', '--initial-branch=main');
  Bun.spawnSync(['git', 'init', '-q', '--bare', origin]);
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('remote', 'add', 'origin', origin);
  writeFileSync(join(repo, '.archon', 'config.yaml'), 'worktree:\n  baseBranch: main\n');
  const workflows = join(repo, '.archon', 'workflows');
  writeFileSync(join(workflows, 'build.yaml'), BUILD);
  writeFileSync(join(workflows, 'check.yaml'), check(checkBody.replaceAll('$ROOT', root)));
  writeFileSync(
    join(workflows, 'land.yaml'),
    `name: land\ndescription: Record what landed.\nnodes:\n  - id: land\n    bash: echo "$(git branch --show-current) $(git rev-parse HEAD)" > "${root}/landed"\n`
  );
  writeFileSync(join(workflows, 'pinned.yaml'), PINNED);
  writeFileSync(join(workflows, 'ask-build.yaml'), ASK_BUILD);
  writeFileSync(join(workflows, 'ask-look.yaml'), leavesAsk('ask-look', true, 'true'));
  writeFileSync(
    join(workflows, 'carry-on.yaml'),
    stageAfterAsks(
      'carry-on',
      false,
      'echo on > on.txt && git add . && git commit -qm "carry on"'
    ).replaceAll('$ROOT', root)
  );
  writeFileSync(
    join(workflows, 'look-again.yaml'),
    stageAfterAsks('look-again', true).replaceAll('$ROOT', root)
  );
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('push', '-q', 'origin', 'main');

  const cli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, CLI_PATH, ...args], {
      cwd: repo,
      env: {
        ...process.env,
        WORKFLOW_ID: '',
        ARCHON_NODE_EXECUTION: '',
        ARCHON_TRIGGER_HOST: '',
        DATABASE_URL: '',
        ARCHON_HOME: home,
        ARCHON_TELEMETRY_DISABLED: '1',
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
  const whoami = await cli(['trigger', 'whoami']);
  if (whoami.exitCode !== 0) throw new Error(whoami.stderr);
  const { runAsUserId } = JSON.parse(whoami.stdout) as { runAsUserId: string };
  const rows = <T>(sql: string): T[] => {
    const path = join(home, 'archon.db');
    if (!existsSync(path)) return [];
    const database = new Database(path, { readonly: true });
    try {
      database.run('PRAGMA busy_timeout = 5000');
      return database.query<T, []>(sql).all();
    } finally {
      database.close();
    }
  };
  const bindFile = (name: string, stage: string, on: Record<string, unknown>): void => {
    mkdirSync(join(home, 'triggers'), { recursive: true });
    writeFileSync(
      join(home, 'triggers', `${name}.json`),
      JSON.stringify({
        version: 1,
        sourceInstanceId: name,
        binding: {
          bindingId: name,
          bindingRevision: null,
          hostId: 'factory-host',
          runAsUserId,
          resource: stage,
          overlap: 'queue',
          launch: { cwd: repo, workflowName: stage, inputs: {}, isolation: { kind: 'default' } },
        },
        on,
      })
    );
  };
  const bind = (name: string, ended: string, outcome: string, stage: string): void =>
    bindFile(name, stage, { runEnded: { workflowName: ended, outcome, checkout: 'ended-run' } });
  const bindAsks = (
    name: string,
    asking: string,
    stage: string,
    inputs?: Record<string, unknown>
  ): void =>
    bindFile(name, stage, {
      asksSettled: {
        workflowName: asking,
        settled: 'answered',
        checkout: 'asking-run',
        ...(inputs ? { inputs } : {}),
      },
    });
  return { root, repo, home, git, cli, rows, bind, bindAsks };
}

/** The build, check, build loop: three bindings, and `land` once a check passes. */
function bindLoop(fixture: Fixture): void {
  fixture.bind('check-after-build', 'build', 'built', 'check');
  fixture.bind('build-after-return', 'check', 'return', 'build');
  fixture.bind('land-after-pass', 'check', 'pass', 'land');
}

interface RunRow {
  id: string;
  workflow_name: string;
  status: string;
  working_path: string | null;
  metadata: string;
}

const runs = (fixture: Fixture): RunRow[] =>
  fixture.rows<RunRow>(
    'SELECT id, workflow_name, status, working_path, metadata FROM remote_agent_workflow_runs ORDER BY started_at, rowid'
  );

async function waitForRuns(fixture: Fixture, count: number): Promise<RunRow[]> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const found = runs(fixture);
    if (found.length === count && found.every(run => ['completed', 'failed'].includes(run.status)))
      return found;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${String(count)} runs: ${JSON.stringify(runs(fixture))}`);
}

const metadata = (run: RunRow | undefined): Record<string, unknown> =>
  JSON.parse(run?.metadata ?? '{}') as Record<string, unknown>;

async function startBuild(fixture: Fixture): Promise<void> {
  const started = await fixture.cli(['workflow', 'run', 'build', '--item', 'issue-1']);
  if (started.exitCode !== 0) throw new Error(started.stderr || started.stdout);
}

describe('a stage on the checkout the ended run left', () => {
  test('build, check, build: the second build adds to the first on its branch; checks work on a branch of their own', async () => {
    // Two commits on top of main pass: the first build is returned, the second passes.
    const fixture = await makeFixture(
      'loop',
      `echo "$(git branch --show-current) $(git rev-parse HEAD)" >> "$ROOT/checks"
if [ "$(git rev-list --count HEAD)" -ge 3 ]; then printf '{"outcome": "pass"}'; else printf '{"outcome": "return"}'; fi`
    );
    bindLoop(fixture);
    await startBuild(fixture);
    const all = await waitForRuns(fixture, 5);
    expect(all.map(run => [run.workflow_name, run.status])).toEqual([
      ['build', 'completed'],
      ['check', 'completed'],
      ['build', 'completed'],
      ['check', 'completed'],
      ['land', 'completed'],
    ]);
    const [build1, check1, build2, check2, land] = all;
    const worktree = build1?.working_path ?? '';
    const branch = fixture.git('-C', worktree, 'branch', '--show-current');

    // Both builds and the land worked in one worktree; the branch holds both builds' commits.
    expect([build2?.working_path, land?.working_path]).toEqual([worktree, worktree]);
    expect(fixture.git('log', '--format=%s', `main..${branch}`).split('\n')).toEqual([
      'build 2',
      'build 1',
    ]);
    const tip = fixture.git('rev-parse', branch);
    expect(readFileSync(join(fixture.root, 'landed'), 'utf8').trim()).toBe(`${branch} ${tip}`);

    // Each check saw the commit the build before it ended on, in a checkout of its own.
    const seen = readFileSync(join(fixture.root, 'checks'), 'utf8').trim().split('\n');
    expect(seen.map(line => line.split(' ')[1])).toEqual([
      fixture.git('rev-parse', `${branch}~1`),
      tip,
    ]);
    for (const [index, check] of [check1, check2].entries()) {
      expect(check?.working_path).not.toBe(worktree);
      expect(seen[index]?.split(' ')[0]).not.toBe(branch);
    }

    // The first build's end handed its worktree on, so its release was held.
    expect(metadata(build1).worktree_disposition).toMatchObject({
      disposition: 'retained',
      reason: 'in_use',
    });
    expect(existsSync(worktree)).toBe(true);
    expect(metadata(build2).checkout_handoff).toMatchObject({
      runId: build1?.id,
      branch,
      lane: 'continue',
    });
    expect(metadata(check2).checkout_handoff).toMatchObject({ runId: build2?.id, lane: 'copy' });

    // Every run measures from where the first build's branch was cut: a check on its own
    // copy, and the land after it, show the size of the build they took.
    const read = await fixture.cli(['workflow', 'runs', '--item', 'issue-1', '--json']);
    const sizes = itemReadSchema.parse(JSON.parse(read.stdout)).runs.map(run => run.changeSize);
    const base = fixture.git('merge-base', 'main', branch);
    const first = {
      base,
      commit: fixture.git('rev-parse', `${branch}~1`),
      files: 1,
      added: 1,
      removed: 0,
    };
    const second = { base, commit: tip, files: 2, added: 2, removed: 0 };
    expect(sizes).toEqual([first, first, second, second, second]);
  }, 120_000);

  test('a stage reading a file setting that names a file only the ended run committed starts on its checkout', async () => {
    const fixture = await makeFixture('file-setting', 'true');
    const pack = join(fixture.repo, '.archon', 'workflows', 'chain');
    mkdirSync(join(pack, '.pack'), { recursive: true });
    mkdirSync(join(pack, 'read-build'), { recursive: true });
    writeFileSync(join(pack, '.pack', 'pack.yaml'), 'inputs:\n  brief:\n    file: true\n');
    writeFileSync(
      join(pack, 'read-build', 'read-build.yaml'),
      'name: read-build\ndescription: Read what the build wrote.\nnodes:\n  - id: read\n    bash: cat "$INPUTS_BRIEF"\n'
    );
    // The build names its file by the commit count it sees, one more than main has now.
    const built = `build-${String(Number(fixture.git('rev-list', '--count', 'HEAD')) + 1)}.txt`;
    mkdirSync(join(fixture.repo, '.archon', 'packs'));
    writeFileSync(
      join(fixture.repo, '.archon', 'packs', 'chain.yaml'),
      `settings:\n  brief: ${built}\n`
    );
    fixture.git('add', '.');
    fixture.git('commit', '-qm', 'pack');
    fixture.git('push', '-q', 'origin', 'main');
    fixture.bind('read-after-build', 'build', 'built', 'read-build');

    await startBuild(fixture);
    expect((await waitForRuns(fixture, 2)).map(run => [run.workflow_name, run.status])).toEqual([
      ['build', 'completed'],
      ['read-build', 'completed'],
    ]);
    // The project checkout never had the file: only the handed-on checkout does.
    expect(existsSync(join(fixture.repo, built))).toBe(false);
  }, 90_000);

  test('a branch that moved after the ended run is refused, not built on', async () => {
    // The check moves the build branch past the commit the build ended on, then returns it.
    const fixture = await makeFixture(
      'moved',
      `b=$(git for-each-ref --points-at HEAD --format='%(refname:short)' refs/heads | grep -vx "$(git branch --show-current)")
git commit -q --allow-empty -m meddle
git update-ref "refs/heads/$b" HEAD
printf '{"outcome": "return"}'`
    );
    bindLoop(fixture);
    await startBuild(fixture);
    const all = await waitForRuns(fixture, 3);
    expect(all.map(run => [run.workflow_name, run.status])).toEqual([
      ['build', 'completed'],
      ['check', 'completed'],
      ['build', 'failed'],
    ]);
    // The refusal names the run whose hand-off it refused.
    expect(String(metadata(all[2]).error)).toContain(all[0]?.id ?? 'build run');
  }, 120_000);

  test('a run in place leaves no checkout: the start is refused on its receipt', async () => {
    const fixture = await makeFixture('in-place', `printf '{"outcome": "pass"}'`);
    bindLoop(fixture);
    const started = await fixture.cli([
      'workflow',
      'run',
      'build',
      '--no-worktree',
      '--item',
      'issue-1',
    ]);
    expect(started.exitCode, started.stderr).toBe(0);
    expect(runs(fixture).map(run => run.workflow_name)).toEqual(['build']);
    const [receipt] = JSON.parse((await fixture.cli(['trigger', 'list'])).stdout) as {
      outcome: string;
      reason: string | null;
    }[];
    expect(receipt?.outcome).toBe('unmatched');
    expect(receipt?.reason).toContain(runs(fixture)[0]?.id ?? 'build run');
    // The refusal stops the item on the build run, in the item read and in attention.
    const refused = [
      {
        receiptId: expect.any(String),
        bindingId: 'check-after-build',
        workflow: 'check',
        reason: 'checkout_refused',
        refusedAt: expect.any(String),
      },
    ];
    const read = JSON.parse(
      (await fixture.cli(['workflow', 'runs', '--item', 'issue-1', '--json'])).stdout
    ) as { questions: { kind: string }[] };
    const attention = JSON.parse(
      (await fixture.cli(['workflow', 'attention', '--json'])).stdout
    ) as { items: { kind: string }[] };
    for (const items of [read.questions, attention.items])
      expect(items.filter(item => item.kind === 'stopped')).toEqual([
        expect.objectContaining({
          stoppedIn: expect.objectContaining({ workflow: 'build' }),
          refused,
        }),
      ]);
  }, 120_000);

  test('trigger check reports a workflow pinned in place on either side, and fire refuses', async () => {
    const fixture = await makeFixture('check', `printf '{"outcome": "pass"}'`);
    fixture.bind('after-pinned', 'pinned', 'built', 'check');
    fixture.bind('pinned-after-build', 'build', 'built', 'pinned');
    const checked = await fixture.cli(['trigger', 'check']);
    expect(checked.exitCode).not.toBe(0);
    const problems = new Map(
      (
        JSON.parse(checked.stdout) as { runEnded: { file: string; problems: string[] }[] }
      ).runEnded.map(entry => [basename(entry.file, '.json'), entry.problems])
    );
    // One problem each: the pinned ended workflow, and the pinned started one.
    expect(problems.get('after-pinned')).toHaveLength(1);
    expect(problems.get('pinned-after-build')).toHaveLength(1);

    const fired = await fixture.cli([
      'trigger',
      'fire',
      '--config',
      join(fixture.home, 'triggers', 'after-pinned.json'),
    ]);
    expect(fired.exitCode).not.toBe(0);
    expect(fired.stderr).toContain(join(fixture.home, 'triggers', 'after-pinned.json'));
  }, 120_000);
});

/** Answer the one open ask with its recommendation; returns what the answer printed. */
async function answerTheAsk(fixture: Fixture): Promise<string> {
  const listed = await fixture.cli(['workflow', 'attention', '--all', '--json']);
  const [ask] = (JSON.parse(listed.stdout) as { items: { ref: string }[] }).items;
  if (ask === undefined) throw new Error(`No open ask: ${listed.stdout}`);
  const answered = await fixture.cli(['workflow', 'answer', '--ref', ask.ref, '--recommended']);
  if (answered.exitCode !== 0) throw new Error(answered.stderr || answered.stdout);
  return answered.stdout;
}

async function startAskBuild(fixture: Fixture): Promise<RunRow> {
  const started = await fixture.cli(['workflow', 'run', 'ask-build', '--item', 'issue-1']);
  if (started.exitCode !== 0) throw new Error(started.stderr || started.stdout);
  const [asking] = await waitForRuns(fixture, 1);
  if (asking === undefined) throw new Error('No asking run');
  return asking;
}

describe('a stage on the checkout the asking run left', () => {
  test("answering the last ask starts the stage on the asking run's branch at the commit it ended on", async () => {
    const fixture = await makeFixture('asks', `printf '{"outcome": "pass"}'`);
    fixture.bindAsks('carry-on-after-answers', 'ask-build', 'carry-on');
    const asking = await startAskBuild(fixture);
    const { handoff } = metadata(asking).asks_checkout as {
      handoff: { runId: string; branch: string; commit: string };
    };
    expect(handoff.runId).toBe(asking.id);
    expect(fixture.git('log', '-1', '--format=%s', handoff.commit)).toBe('asked');

    // A fire has no asking run to take the checkout from.
    const fired = await fixture.cli([
      'trigger',
      'fire',
      '--config',
      join(fixture.home, 'triggers', 'carry-on-after-answers.json'),
    ]);
    expect(fired.exitCode).not.toBe(0);
    expect(fired.stderr).toContain('on.asksSettled.checkout');

    await answerTheAsk(fixture);
    const all = await waitForRuns(fixture, 2);
    expect(all.map(run => [run.workflow_name, run.status])).toEqual([
      ['ask-build', 'completed'],
      ['carry-on', 'completed'],
    ]);
    const read = (name: string): string => readFileSync(join(fixture.root, name), 'utf8').trim();
    // The mutating stage continued on the branch, from the commit the asking run ended on,
    // and its own commit landed there.
    expect(read('carry-on')).toBe(`${handoff.branch} ${handoff.commit}`);
    expect(fixture.git('log', '--format=%s', `main..${handoff.branch}`).split('\n')).toEqual([
      'carry on',
      'asked',
    ]);
    expect(metadata(all[1]).checkout_handoff).toMatchObject({
      runId: asking.id,
      lane: 'continue',
    });
  }, 120_000);

  // Apart from the test above: a copy is cut only while the branch is at the commit, so a
  // mutating stage started by the same answer could move it first.
  test('a read-only stage gets a checkout of its own at the commit the asking run ended on', async () => {
    const fixture = await makeFixture('asks-copy', `printf '{"outcome": "pass"}'`);
    fixture.bindAsks('look-after-answers', 'ask-build', 'look-again');
    const asking = await startAskBuild(fixture);
    const { handoff } = metadata(asking).asks_checkout as {
      handoff: { branch: string; commit: string };
    };
    await answerTheAsk(fixture);
    const [, look] = await waitForRuns(fixture, 2);
    expect(look?.status).toBe('completed');
    const [lookBranch, lookCommit] = readFileSync(join(fixture.root, 'look-again'), 'utf8')
      .trim()
      .split(' ');
    expect(lookCommit).toBe(handoff.commit);
    expect(lookBranch).not.toBe(handoff.branch);
    expect(metadata(look).checkout_handoff).toMatchObject({ runId: asking.id, lane: 'copy' });
  }, 120_000);

  test('a branch that moved after the asking run ended is refused, for a read-only stage too', async () => {
    const fixture = await makeFixture('asks-moved', `printf '{"outcome": "pass"}'`);
    fixture.bindAsks('carry-on-after-answers', 'ask-build', 'carry-on');
    fixture.bindAsks('look-after-answers', 'ask-build', 'look-again');
    const asking = await startAskBuild(fixture);
    const { handoff } = metadata(asking).asks_checkout as {
      handoff: { branch: string; commit: string };
    };
    // Someone moves the branch while the ask is open.
    const meddled = fixture.git(
      'commit-tree',
      '-p',
      handoff.commit,
      '-m',
      'meddle',
      `${handoff.commit}^{tree}`
    );
    fixture.git('update-ref', `refs/heads/${handoff.branch}`, meddled);

    await answerTheAsk(fixture);
    const all = await waitForRuns(fixture, 3);
    expect(all.map(run => [run.workflow_name, run.status]).sort()).toEqual([
      ['ask-build', 'completed'],
      ['carry-on', 'failed'],
      ['look-again', 'failed'],
    ]);
    for (const started of all.slice(1)) {
      const error = String(metadata(started).error);
      expect(error).toContain(handoff.branch);
      expect(error).toContain(asking.id);
    }
    expect(existsSync(join(fixture.root, 'carry-on'))).toBe(false);
    expect(existsSync(join(fixture.root, 'look-again'))).toBe(false);
  }, 120_000);

  test('an asking worktree removed while the asks were open refuses the start on its receipt', async () => {
    const fixture = await makeFixture('asks-gone', `printf '{"outcome": "pass"}'`);
    fixture.bindAsks('carry-on-after-answers', 'ask-build', 'carry-on');
    const asking = await startAskBuild(fixture);
    // Completion keeps the worktree its asks will hand on; something removes it later.
    expect(metadata(asking).worktree_disposition).toMatchObject({
      disposition: 'retained',
      reason: 'in_use',
    });
    const worktree = asking.working_path ?? '';
    fixture.git('worktree', 'remove', '--force', worktree);

    await answerTheAsk(fixture);
    const receipts = JSON.parse((await fixture.cli(['trigger', 'list'])).stdout) as {
      outcome: string;
      reason: string | null;
    }[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe('unmatched');
    expect(receipts[0]?.reason).toContain(`Checkout: the worktree at '${worktree}'`);
    expect(receipts[0]?.reason).toContain('is gone');
    expect(runs(fixture).map(run => run.workflow_name)).toEqual(['ask-build']);
    // The settled asks' refused start stops the item on the run that left them.
    const { items } = JSON.parse(
      (await fixture.cli(['workflow', 'attention', '--json'])).stdout
    ) as { items: { kind: string }[] };
    expect(items.filter(item => item.kind === 'stopped')).toEqual([
      expect.objectContaining({
        stoppedIn: expect.objectContaining({ runId: asking.id }),
        refused: [expect.objectContaining({ reason: 'checkout_refused' })],
      }),
    ]);
  }, 120_000);

  test('a worktree removed after the asks settled refuses the start when its host drains it', async () => {
    const fixture = await makeFixture('asks-drained', `printf '{"outcome": "pass"}'`);
    fixture.bindAsks('carry-on-after-answers', 'ask-build', 'carry-on');
    const asking = await startAskBuild(fixture);
    await answerElsewhere(fixture);
    // Settled with the worktree there, so the start was written matched and waits for a drain.
    fixture.git('worktree', 'remove', '--force', asking.working_path ?? '');
    await fixture.cli(['trigger', 'drain', '--host', 'factory-host']);
    const all = await waitForRuns(fixture, 2);
    expect(all.map(run => [run.workflow_name, run.status])).toEqual([
      ['ask-build', 'completed'],
      ['carry-on', 'failed'],
    ]);
    expect(String(metadata(all[1]).error)).toContain('is gone');
    expect(existsSync(asking.working_path ?? '')).toBe(false);
  }, 120_000);

  test('a read-only asking stage hands on its source checkout only while that worktree is there', async () => {
    const fixture = await makeFixture('asks-forwarded', `printf '{"outcome": "pass"}'`);
    fixture.bind('look-after-build', 'build', 'built', 'ask-look');
    fixture.bindAsks('carry-on-after-answers', 'ask-look', 'carry-on');
    await startBuild(fixture);
    const [build, look] = await waitForRuns(fixture, 2);
    expect(look?.workflow_name).toBe('ask-look');
    expect(metadata(look).asks_checkout).toMatchObject({
      handoff: { runId: build?.id },
      worktree: build?.working_path,
    });
    fixture.git('worktree', 'remove', '--force', build?.working_path ?? '');

    await answerTheAsk(fixture);
    const receipts = JSON.parse((await fixture.cli(['trigger', 'list'])).stdout) as {
      outcome: string;
      reason: string | null;
    }[];
    expect(receipts.find(receipt => receipt.outcome === 'unmatched')?.reason).toContain(
      `the worktree at '${build?.working_path}'`
    );
    expect(runs(fixture).map(run => run.workflow_name)).toEqual(['build', 'ask-look']);
  }, 120_000);

  test('after a read-only asking stage, the printed recovery adopts the run that holds the checkout', async () => {
    const fixture = await makeFixture('asks-recover', `printf '{"outcome": "pass"}'`);
    fixture.bind('look-after-build', 'build', 'built', 'ask-look');
    // A pointer the asking run's result lacks refuses the start; the checkout is intact.
    fixture.bindAsks('carry-on-after-answers', 'ask-look', 'carry-on', {
      progress: { result: '/missing' },
    });
    await startBuild(fixture);
    const [build] = await waitForRuns(fixture, 2);
    const printed = await answerTheAsk(fixture);
    const command = /archon workflow run <stage> (--adopt \S+ --item \S+)/.exec(printed)?.[1];
    expect(command, printed).toBe(`--adopt ${build?.id} --item issue-1`);

    // The printed command, run as printed, continues the build's branch.
    const recovered = await fixture.cli([
      'workflow',
      'run',
      'carry-on',
      ...(command ?? '').split(' '),
      '--input',
      'progress=by hand',
    ]);
    expect(recovered.exitCode, recovered.stderr || recovered.stdout).toBe(0);
    const branch = fixture.git('-C', build?.working_path ?? '', 'branch', '--show-current');
    expect(readFileSync(join(fixture.root, 'carry-on'), 'utf8').split(' ')[0]).toBe(branch);
    expect(fixture.git('log', '-1', '--format=%s', branch)).toBe('carry on');
  }, 120_000);
});

// A pack whose `host` stage ends waiting for checks at its head, then clears once woken.
const HOST_PACK = `bindings:
  checks-done:
    workflow: host
    resource: host
    overlap: queue
    event: { kind: check.changed }
    wake: { workflow: host, wait: checks, about: check.revision, checkout: waiting-run }
    inputs:
      land_on: { input: land_on }
      answers: { item: answers }
`;
const BUILD_FOR = `name: build-for
description: Add a commit for a base.
inputs:
  land_on: { required: true }
returns: { node: commit, outcome: outcome }
nodes:
  - id: commit
    bash: |
      set -e
      echo built > built.txt && git add . && git commit -qm "built" && git push -q origin HEAD
      printf '{"outcome": "built"}'
    output_format:
      type: object
      properties: { outcome: { type: string, enum: [built] } }
      required: [outcome]
`;
const host = (root: string) => `name: host
description: Wait for the checks at the head once, then clear.
inputs:
  land_on: { required: true }
  answers: {}
returns: { node: read, outcome: verdict, waits: waits }
nodes:
  - id: read
    bash: |
      set -e
      if [ -f "${root}/hosted" ]; then printf '{"verdict": "clear", "waits": []}'; exit 0; fi
      touch "${root}/hosted"
      printf '{"verdict": "waiting", "waits": [{"event": "checks", "about": "%s", "within_minutes": 60}]}' "$(git rev-parse HEAD)"
    output_format:
      type: object
      properties: { verdict: { type: string, enum: [clear, waiting] } }
      required: [verdict]
`;

describe('a stage woken by a wait, on the checkout the waiting run left', () => {
  test("a check at the waited commit starts the stage again with the waiting run's inputs, the item's answers and its checkout", async () => {
    const fixture = await makeFixture('wake', `printf '{"outcome": "pass"}'`);
    const pack = join(fixture.repo, '.archon', 'workflows', 'factory');
    mkdirSync(join(pack, '.pack'), { recursive: true });
    writeFileSync(join(pack, '.pack', 'pack.yaml'), HOST_PACK);
    for (const [name, body] of [
      ['build-for', BUILD_FOR],
      ['host', host(fixture.root)],
    ] as const) {
      mkdirSync(join(pack, name), { recursive: true });
      writeFileSync(join(pack, name, `${name}.yaml`), body);
    }
    fixture.git('add', '.');
    fixture.git('commit', '-qm', 'factory pack');
    fixture.git('push', '-q', 'origin', 'main');
    // The run-ended start the host stage first gets, with its inputs and the build's checkout.
    fixture.bind('host-after-build', 'build-for', 'built', 'host');
    writeTrigger(fixture, 'host-after-build', {
      runEnded: {
        workflowName: 'build-for',
        outcome: 'built',
        checkout: 'ended-run',
        inputs: { land_on: { input: 'land_on' }, answers: { item: 'answers' } },
      },
    });

    // An answer on the item, then the build the host stage follows.
    await startAskBuild(fixture);
    await answerTheAsk(fixture);
    // The item, now recorded, lands on its own branch: the build and host read from there.
    const landing = await fixture.cli([
      'workflow',
      'landing',
      '--item',
      'issue-1',
      '--branch',
      'landing',
      '--from',
      'origin/main',
    ]);
    if (landing.exitCode !== 0) throw new Error(landing.stderr || landing.stdout);

    const built = await fixture.cli([
      'workflow',
      'run',
      'build-for',
      '--item',
      'issue-1',
      '--input',
      'land_on=dev',
    ]);
    if (built.exitCode !== 0) throw new Error(built.stderr || built.stdout);
    const [, build, waiting] = await waitForRuns(fixture, 3);
    expect(waiting?.workflow_name).toBe('host');
    // Its pack's wake takes the checkout, so its completion recorded the one it worked on:
    // the build's branch, in the build's worktree.
    const { handoff, worktree } = metadata(waiting).asks_checkout as {
      handoff: { runId: string; branch: string; commit: string };
      worktree: string;
    };
    expect(worktree).toBe(build?.working_path ?? '');
    expect(fixture.git('log', '-1', '--format=%s', handoff.commit)).toBe('built');

    // The project's default branch drops `land_on` from `host` while the item waits. The
    // waiting run's own definitions still declare it, and they are what the check reads.
    writeFileSync(
      join(pack, 'host', 'host.yaml'),
      host(fixture.root).replace('  land_on: { required: true }\n', '')
    );
    fixture.git('commit', '-qam', 'host drops land_on on main');
    fixture.git('push', '-q', 'origin', 'main');

    // A hand-edited binding that reads an input `host` does not declare is refused when its
    // event arrives, naming the binding and the input, and the wait stays open.
    await acceptWake(fixture, handoff.commit, 'undeclared_base');
    const listed = JSON.parse((await fixture.cli(['trigger', 'list'])).stdout) as {
      outcome: string;
      reason: string | null;
    }[];
    const refused = listed.find(receipt => receipt.reason?.includes('undeclared_base'));
    expect(refused?.outcome).toBe('unmatched');
    expect(refused?.reason).toContain(
      "binding 'checks-done': input 'land_on' reads 'undeclared_base', which 'host' does not declare"
    );
    expect(
      fixture.rows<{ closed_as: string | null }>('SELECT closed_as FROM remote_agent_item_waits')
    ).toEqual([{ closed_as: null }]);

    // A completed check at that commit, as the GitHub source plugin hands it to the store.
    await acceptWake(fixture, handoff.commit);
    await fixture.cli(['trigger', 'drain', '--host', 'factory-host']);
    const all = await waitForRuns(fixture, 4);
    const woken = all[3];
    expect([woken?.workflow_name, woken?.status]).toEqual(['host', 'completed']);
    const given = metadata(woken).inputs_values ?? metadata(woken).inputs;
    expect(given).toMatchObject({
      land_on: 'dev',
      answers: [
        expect.objectContaining({
          question: 'Keep going?',
          closedAs: 'answered',
          option: expect.objectContaining({ id: 'go' }),
          workflowName: 'ask-build',
        }),
      ],
    });
    // On the branch the build left, at the commit the waiting run ended on.
    expect(metadata(woken).checkout_handoff).toMatchObject({
      runId: handoff.runId,
      branch: handoff.branch,
      commit: handoff.commit,
    });
    expect(woken?.working_path).toBe(build?.working_path);
  }, 120_000);
});

/** Replace the `on` of a trigger file the fixture wrote. */
function writeTrigger(fixture: Fixture, name: string, on: Record<string, unknown>): void {
  const sample = JSON.parse(
    readFileSync(join(fixture.home, 'triggers', `${name}.json`), 'utf8')
  ) as Record<string, unknown>;
  writeFileSync(join(fixture.home, 'triggers', `${name}.json`), JSON.stringify({ ...sample, on }));
}

/**
 * Accept a completed check at `commit` through the store every surface shares
 * (`createWorkflowStore().acceptStartReceipt`), with the binding the GitHub source plugin
 * makes of a pack's `checks-done` wake; `landOn` is the input its `land_on` reads.
 */
async function acceptWake(fixture: Fixture, commit: string, landOn = 'land_on'): Promise<void> {
  const file = JSON.parse(
    readFileSync(join(fixture.home, 'triggers', 'host-after-build.json'), 'utf8')
  ) as { binding: { runAsUserId: string } };
  const acceptance = {
    receipt: {
      id: crypto.randomUUID(),
      sourceInstanceId: 'github',
      deliveryId: `check:${commit}:${landOn}`,
      contentDigest: commit,
      receivedAt: new Date().toISOString(),
      occurredAt: null,
      sourceActor: null,
    },
    outcome: 'matched',
    bindings: [
      {
        bindingId: 'checks-done',
        bindingRevision: 'rev-1',
        hostId: 'factory-host',
        runAsUserId: file.binding.runAsUserId,
        resource: 'host',
        overlap: 'queue',
        launch: {
          cwd: fixture.repo,
          workflowName: 'host',
          inputs: {},
          isolation: { kind: 'default' },
        },
        eventInputs: {},
        wake: {
          workflowName: 'host',
          wait: 'checks',
          about: commit,
          inputs: { land_on: { input: landOn }, answers: { item: 'answers' } },
          checkout: 'waiting-run',
        },
      },
    ],
  };
  const waker = join(fixture.root, 'accept-wake.ts');
  const core = resolve(import.meta.dir, '..', '..', '..', 'core', 'src');
  writeFileSync(
    waker,
    `const { createWorkflowStore } = await import(${JSON.stringify(join(core, 'workflows', 'store-adapter.ts'))});
const { closeDatabase } = await import(${JSON.stringify(join(core, 'db', 'connection.ts'))});
const { setPlatformPolicies } = await import(${JSON.stringify(join(core, 'platforms', 'registry.ts'))});
const { defaultPlatformPolicies } = await import(${JSON.stringify(join(core, '..', '..', 'adapters', 'src', 'platform-policies.ts'))});
const { registerHostProviders } = await import(${JSON.stringify(join(core, 'providers', 'register-host-providers.ts'))});
// As the server does at start: the wake's input check loads config and discovers workflows.
setPlatformPolicies(defaultPlatformPolicies);
await registerHostProviders();
await createWorkflowStore().acceptStartReceipt(JSON.parse(process.argv[2]));
await closeDatabase();
`
  );
  const accepted = Bun.spawn([process.execPath, waker, JSON.stringify(acceptance)], {
    cwd: fixture.repo,
    env: { ...process.env, DATABASE_URL: '', ARCHON_HOME: fixture.home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await accepted.exited) !== 0) throw new Error(await new Response(accepted.stderr).text());
}

/**
 * Answer the open ask through the store every surface shares, as the server does for an
 * answer on a host it does not serve: the start is written, and nothing prepares it.
 */
async function answerElsewhere(fixture: Fixture): Promise<void> {
  const listed = await fixture.cli(['workflow', 'attention', '--all', '--json']);
  const refs = (JSON.parse(listed.stdout) as { items: { ref: string }[] }).items.map(i => i.ref);
  const answerer = join(fixture.root, 'answer-elsewhere.ts');
  const core = resolve(import.meta.dir, '..', '..', '..', 'core', 'src');
  writeFileSync(
    answerer,
    `const { createWorkflowStore } = await import(${JSON.stringify(join(core, 'workflows', 'store-adapter.ts'))});
const { attentionQueueSource } = await import(${JSON.stringify(join(core, 'operations', 'attention-queue.ts'))});
const { answerAttentionItem } = await import(${JSON.stringify(join(core, 'operations', 'attention-items.ts'))});
const { closeDatabase } = await import(${JSON.stringify(join(core, 'db', 'connection.ts'))});
const notUsed = async () => { throw new Error('not used for an ask'); };
const deps = {
  queue: attentionQueueSource(createWorkflowStore(), { findLatestByCodebaseAndWorkingPath: async () => null }),
  operations: { answerWorkflow: notUsed, respondToWorkflow: notUsed, assertRunActionAllowed: async () => undefined },
};
for (const ref of process.argv.slice(2))
  await answerAttentionItem(deps, ref, { recommended: true }, { kind: 'operator', declared: 'reviewer' }, 'api');
await closeDatabase();
`
  );
  const answered = Bun.spawn([process.execPath, answerer, ...refs], {
    cwd: fixture.repo,
    env: { ...process.env, DATABASE_URL: '', ARCHON_HOME: fixture.home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await answered.exited) !== 0) throw new Error(await new Response(answered.stderr).text());
}

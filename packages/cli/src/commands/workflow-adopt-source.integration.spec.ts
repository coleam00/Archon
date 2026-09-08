import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeProjectPath } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { readWorkflowSourceState } from '@archon/workflows/schemas/workflow-run';
import { capturedSourceRoots, loadWorkflowSource } from '@archon/workflows/workflow-source';
import { loadCommandPrompt } from '@archon/workflows/executor-shared';
import {
  canConnect,
  detachedRunControlPath,
  requestDetachedRunStop,
} from '../utils/detached-run-control';

const CLI_ENTRY = join(import.meta.dir, 'fixtures', 'workflow-cli-without-title.ts');
const roots: string[] = [];
const activeRuns = new Set<string>();

afterEach(async () => {
  for (const id of activeRuns) {
    if (await canConnect(detachedRunControlPath(id))) {
      const owner = await requestDetachedRunStop(id);
      await owner.stop();
    }
  }
  activeRuns.clear();
  for (const root of roots.splice(0)) await removeTempTree(root);
});

interface Fixture {
  root: string;
  repo: string;
  target: string;
  source: string;
  home: string;
  priorId: string;
}

interface RunRow {
  id: string;
  status: string;
  working_path: string;
  metadata: string;
  adopted_from_run_id: string | null;
}

function readRun(fixture: Fixture, id: string): RunRow {
  const db = new Database(join(fixture.home, 'archon.db'), { readonly: true });
  try {
    db.run('PRAGMA busy_timeout = 5000');
    const row = db
      .query<RunRow, [string]>('SELECT * FROM remote_agent_workflow_runs WHERE id = ?')
      .get(id);
    if (!row) throw new Error(`Missing run ${id}`);
    return row;
  } finally {
    db.close();
  }
}

function runCli(fixture: Fixture, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      ARCHON_HOME: fixture.home,
      DATABASE_URL: '',
      ARCHON_TELEMETRY_DISABLED: '1',
    },
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function writePack(root: string, vintage: string): void {
  for (const folder of ['workflows', 'scripts', 'prompts']) {
    mkdirSync(join(root, '.archon', folder), { recursive: true });
  }
  writeFileSync(join(root, '.archon', 'config.yaml'), 'commands:\n  folder: .archon/prompts\n');
  writeFileSync(join(root, '.archon', 'prompts', 'source-command.md'), `${vintage} command\n`);
  writeFileSync(
    join(root, '.archon', 'workflows', 'adopt-source.yaml'),
    `name: adopt-source\ndescription: ${vintage}\n` +
      'inputs:\n  token:\n    required: true\n' +
      'nodes:\n  - id: settled\n    bash: echo settled\n' +
      '  - id: probe\n    depends_on: [settled]\n    script: source-probe\n    runtime: bun\n' +
      `    with:\n      author: ${vintage}\n`
  );
  writeFileSync(
    join(root, '.archon', 'scripts', 'source-probe.ts'),
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync('source-result.json', JSON.stringify({
  vintage: ${JSON.stringify(vintage)},
  author: process.env.INPUTS_AUTHOR,
  cwd: process.cwd(),
  input: process.env.INPUTS_TOKEN,
  command: readFileSync(join(import.meta.dir, '..', 'prompts', 'source-command.md'), 'utf8'),
}));
if (!existsSync('allow-finish')) process.exit(23);
`
  );
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'archon-adopt-source-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const target = join(root, 'target');
  const source = join(root, 'source');
  mkdirSync(repo);
  const git = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  git(['init', '-q']);
  writeFileSync(join(repo, 'tracked.txt'), 'committed\n');
  git(['add', 'tracked.txt']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  git(['worktree', 'add', '-qb', 'fixture-lane', target]);
  writeFileSync(join(target, 'tracked.txt'), 'dirty tracked change\n');
  writeFileSync(join(target, 'untracked.txt'), 'dirty untracked change\n');
  writePack(source, 'old source');
  const fixture: Fixture = {
    root,
    repo: await canonicalizeProjectPath(repo),
    target: await canonicalizeProjectPath(target),
    source: await canonicalizeProjectPath(source),
    home: join(root, 'home'),
    priorId: '',
  };
  // A real first run supplies the old capture. Adoption must capture the freshly
  // selected authoring directory, not reuse this run's earlier source bytes.
  const prior = runCli(fixture, [
    'workflow',
    'run',
    'adopt-source',
    '--cwd',
    fixture.repo,
    '--workflow-source',
    fixture.source,
    '--no-worktree',
    '--input',
    'token=old',
  ]);
  expect(prior.output).toContain('probe');
  expect(prior.status).toBe(1);
  const db = new Database(join(fixture.home, 'archon.db'));
  try {
    const row = db
      .query<
        { id: string; codebase_id: string },
        []
      >('SELECT id, codebase_id FROM remote_agent_workflow_runs')
      .get();
    if (!row) throw new Error(prior.output);
    fixture.priorId = row.id;
    db.query('UPDATE remote_agent_workflow_runs SET working_path = ? WHERE id = ?').run(
      fixture.target,
      row.id
    );
    db.query(
      `INSERT INTO remote_agent_isolation_environments
      (codebase_id, workflow_type, workflow_id, working_path, branch_name)
      VALUES (?, 'task', ?, ?, 'fixture-lane')`
    ).run(row.codebase_id, row.id, fixture.target);
  } finally {
    db.close();
  }
  expect(readRun(fixture, fixture.priorId).status).toBe('failed');
  writePack(source, 'fresh source');
  return fixture;
}

async function adopt(fixture: Fixture, detached: boolean, explicit: boolean): Promise<RunRow> {
  const conversation = crypto.randomUUID();
  const result = runCli(fixture, [
    'workflow',
    'run',
    'adopt-source',
    '--cwd',
    fixture.repo,
    '--adopt',
    fixture.priorId,
    '--input',
    'token=selected',
    '--conversation-id',
    conversation,
    // Relative on purpose: the detached child changes cwd and must receive the
    // canonical source forwarded by the public parser.
    ...(explicit ? ['--workflow-source', 'source'] : []),
    ...(detached ? ['--detach', '--json'] : []),
  ]);
  let id: string;
  if (detached) {
    expect(result.status).toBe(0);
    const ack = JSON.parse(result.output) as { runId: string };
    id = ack.runId;
    activeRuns.add(id);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const row = readRun(fixture, id);
      if (
        ['completed', 'failed'].includes(row.status) &&
        !(await canConnect(detachedRunControlPath(id)))
      ) {
        activeRuns.delete(id);
        break;
      }
      await Bun.sleep(25);
    }
    const log = readFileSync(
      join(fixture.home, 'logs', `detached-run-${conversation}.log`),
      'utf8'
    );
    if (activeRuns.has(id)) throw new Error(`Detached owner did not finish:\n${log}`);
    expect(log).toContain('probe');
  } else {
    expect(result.output).toContain('probe');
    expect(result.status).toBe(1);
    const db = new Database(join(fixture.home, 'archon.db'), { readonly: true });
    try {
      const row = db
        .query<
          { id: string },
          [string]
        >('SELECT id FROM remote_agent_workflow_runs WHERE adopted_from_run_id = ?')
        .get(fixture.priorId);
      if (!row) throw new Error(result.output);
      id = row.id;
    } finally {
      db.close();
    }
  }
  return readRun(fixture, id);
}

function expectProbe(fixture: Fixture, vintage: string): void {
  expect(JSON.parse(readFileSync(join(fixture.target, 'source-result.json'), 'utf8'))).toEqual({
    vintage,
    author: vintage,
    cwd: fixture.target,
    input: 'selected',
    command: `${vintage} command\n`,
  });
  expect(readFileSync(join(fixture.target, 'tracked.txt'), 'utf8')).toBe('dirty tracked change\n');
  expect(readFileSync(join(fixture.target, 'untracked.txt'), 'utf8')).toBe(
    'dirty untracked change\n'
  );
}

describe('public CLI adopted workflow source', () => {
  for (const detached of [false, true]) {
    for (const conflicting of [false, true]) {
      test(`explicit source, detached=${String(detached)}, conflicting target=${String(conflicting)}`, async () => {
        const fixture = await makeFixture();
        if (conflicting) writePack(fixture.target, 'conflicting target');
        const missingInput = runCli(fixture, [
          'workflow',
          'run',
          'adopt-source',
          '--cwd',
          fixture.repo,
          '--workflow-source',
          fixture.source,
          '--adopt',
          fixture.priorId,
          ...(detached ? ['--detach', '--json'] : []),
        ]);
        expect(missingInput.status).toBe(1);
        expect(missingInput.output).toContain("requires input 'token'");
        const run = await adopt(fixture, detached, true);
        expect(run.status).toBe('failed');
        expect(run.working_path).toBe(fixture.target);
        expect(run.adopted_from_run_id).toBe(fixture.priorId);
        expectProbe(fixture, 'fresh source');
        const state = readWorkflowSourceState(JSON.parse(run.metadata));
        if (state.kind !== 'recorded') throw new Error('Adopting run did not record its source');
        expect(state.record.origin).toBe(fixture.source);
        expect(state.record.source_config?.command_folder).toBe('.archon/prompts');
        const capture = await loadWorkflowSource(
          state.record.root,
          state.record.digest,
          state.record.source_config
        );
        expect(capture.manifest.workflow_name).toBe('adopt-source');
        expect(
          await loadCommandPrompt(
            {
              loadConfig: async () => {
                throw new Error('Command lookup must use the captured source config');
              },
            },
            fixture.target,
            'source-command',
            undefined,
            capturedSourceRoots(capture.anchor)
          )
        ).toEqual({ success: true, content: 'fresh source command\n' });
        expect(
          readFileSync(
            join(state.record.root, 'project', '.archon', 'prompts', 'source-command.md'),
            'utf8'
          )
        ).toBe('fresh source command\n');

        // Both live trees now disagree with the frozen run, and the external
        // condition that failed probe is resolved. Resume must execute its capture.
        writePack(fixture.source, 'later source');
        writePack(fixture.target, 'later target');
        writeFileSync(join(fixture.target, 'allow-finish'), 'ready');
        const resumed = runCli(fixture, ['workflow', 'resume', run.id, '--cwd', fixture.repo]);
        expect(resumed.status).toBe(0);
        expect(readRun(fixture, run.id).status).toBe('completed');
        expectProbe(fixture, 'fresh source');
      }, 120_000);
    }

    test(`default source follows the adopted lane, detached=${String(detached)}`, async () => {
      const fixture = await makeFixture();
      writePack(fixture.repo, 'invoking checkout');
      writePack(fixture.target, 'adopted lane');
      const run = await adopt(fixture, detached, false);
      expect(run.status).toBe('failed');
      expectProbe(fixture, 'adopted lane');
      const state = readWorkflowSourceState(JSON.parse(run.metadata));
      if (state.kind !== 'recorded') throw new Error('Adopting run did not record its source');
      expect(state.record.origin).toBe(fixture.target);
      const capture = await loadWorkflowSource(
        state.record.root,
        state.record.digest,
        state.record.source_config
      );
      expect(capture.manifest.workflow_name).toBe('adopt-source');
    }, 120_000);
  }
});

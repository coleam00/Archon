import { getTerminalRecord, type TerminalRecordEvent } from '@archon/workflows/terminal-record';
import { afterEach, expect, test } from 'bun:test';
import { canConnectToRunLiveOwner, runLiveOwnerPath } from '@archon/core/services/run-live-owner';
import { requestDetachedRunStop } from '@archon/core/services/run-owner-stop';
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
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';

const roots: string[] = [];
const fixtures: { home: string; runs: () => RunRow[] }[] = [];
afterEach(async () => {
  const priorHome = process.env.ARCHON_HOME;
  try {
    for (const f of fixtures.splice(0)) {
      process.env.ARCHON_HOME = f.home;
      if (existsSync(join(f.home, 'archon.db'))) {
        for (const run of f.runs()) {
          const endpoint = runLiveOwnerPath(run.id);
          await waitFor(async () => {
            const status = f.runs().find(row => row.id === run.id)?.status;
            return (
              (status !== 'pending' && status !== 'running') ||
              (await canConnectToRunLiveOwner(endpoint))
            );
          });
          if (await canConnectToRunLiveOwner(endpoint))
            await (await requestDetachedRunStop(run.id)).stop();
        }
      }
    }
    for (const root of roots.splice(0)) await removeTempTree(root);
  } finally {
    if (priorHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = priorHome;
  }
});
const entry = join(import.meta.dir, 'fixtures/workflow-cli-without-title.ts');
interface RunRow {
  id: string;
  status: string;
  working_path: string;
  metadata: string;
}
interface EnvRow {
  id: string;
  status: string;
  working_path: string;
  branch_name: string;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'pipe', stdout: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture(race = false) {
  const selectedEntry = race
    ? join(import.meta.dir, 'fixtures/workflow-cli-with-cleanup-race.ts')
    : entry;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'checkout-lifetime-')));
  roots.push(root);
  const repo = join(root, 'repo'),
    home = join(root, 'home');
  mkdirSync(join(repo, '.archon/workflows'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(home, 'config.yaml'), 'store: database\n');
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(
    join(repo, '.archon/config.yaml'),
    'worktree:\n  path: .worktrees\n  baseBranch: dev\n'
  );
  const workflow = (name: string, nodes: string, noWorktree = false) =>
    writeFileSync(
      join(repo, `.archon/workflows/${name}.yaml`),
      `name: ${name}\ndescription: checkout lifetime fixture\n${noWorktree ? 'worktree:\n  enabled: false\n' : ''}nodes:\n${nodes}`
    );
  workflow('round', '  - id: observe\n    bash: pwd; git branch --show-current\n');
  workflow('readonly', '  - id: read\n    bash: git rev-parse HEAD\n', true);
  workflow(
    'failure',
    '  - id: before\n    bash: echo before\n  - id: retry\n    depends_on: [before]\n    bash: test "$LIFETIME_ALLOW" = 1\n'
  );
  workflow(
    'pause',
    '  - id: gate\n    approval:\n      message: Continue?\n      decisions: [{id: approve}, {id: reject}]\n  - id: after\n    depends_on: [gate]\n    bash: pwd\n'
  );
  workflow('dirty', '  - id: change\n    bash: echo valuable > local.txt\n');
  workflow(
    'unpushed',
    '  - id: commit\n    bash: echo valuable > local.txt; git add local.txt; git commit -qm valuable\n'
  );
  git(repo, 'init', '-q', '-b', 'dev');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  const remote = join(root, 'remote.git');
  git(repo, 'init', '--bare', '-q', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'dev');
  const env = {
    ...process.env,
    ARCHON_HOME: home,
    DATABASE_URL: '',
    ARCHON_TELEMETRY_DISABLED: '1',
    GITHUB_APP_ID: '',
    GITHUB_APP_PRIVATE_KEY: '',
    TOKEN_ENCRYPTION_KEY: '',
    ARCHON_USER_ID: '',
    WORKFLOW_ID: '',
    ARCHON_NODE_EXECUTION: '',
    WORKSPACE_PATH: '',
    ARCHON_DOCKER: '',
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    LOG_LEVEL: 'silent',
    LIFETIME_ALLOW: '',
  };
  async function cli(args: string[], extra: Record<string, string> = {}) {
    const child = Bun.spawn([process.execPath, '--no-env-file', selectedEntry, ...args], {
      cwd: repo,
      env: { ...env, ...extra },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, output: out + err };
  }
  function read<T>(query: string, ...params: string[]): T[] {
    const db = new Database(join(home, 'archon.db'), { readonly: true });
    try {
      db.run('PRAGMA busy_timeout = 5000');
      return db.query<T, string[]>(query).all(...params);
    } finally {
      db.close();
    }
  }
  const runs = () => read<RunRow>('SELECT * FROM remote_agent_workflow_runs ORDER BY rowid');
  const environments = () => read<EnvRow>('SELECT * FROM remote_agent_isolation_environments');
  const f = { root, repo, home, cli, read, runs, environments };
  fixtures.push(f);
  return f;
}
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Detached checkout cleanup did not settle');
    await Bun.sleep(25);
  }
}

test('literal branch rounds share one checkout; generated foreground and detached runs release theirs', async () => {
  const f = fixture();
  for (let round = 0; round < 2; round++) {
    const result = await f.cli(['workflow', 'run', 'round', '--branch', 'build/item']);
    expect(result.output).not.toContain('Workflow failed');
    expect(result.code).toBe(0);
  }
  const rounds = f.runs();
  expect(rounds).toHaveLength(2);
  expect(rounds[1]?.working_path).toBe(rounds[0]?.working_path);
  const item = f.environments()[0]!;
  expect(item.branch_name).toBe('build/item');
  expect(git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/archon/task-')).toBe('');
  expect(f.environments()).toHaveLength(1);
  const builderHead = git(item.working_path, 'rev-parse', 'HEAD');
  writeFileSync(join(item.working_path, 'builder.txt'), 'in progress');
  const before = git(f.repo, 'worktree', 'list', '--porcelain');
  expect((await f.cli(['workflow', 'run', 'readonly'])).code).toBe(0);
  expect(git(f.repo, 'worktree', 'list', '--porcelain')).toBe(before);
  expect(git(item.working_path, 'rev-parse', 'HEAD')).toBe(builderHead);
  expect(readFileSync(join(item.working_path, 'builder.txt'), 'utf8')).toBe('in progress');

  const foreground = await f.cli(['workflow', 'run', 'round']);
  expect(foreground.code).toBe(0);
  const generated = f.runs().at(-1)!;
  expect(generated.status).toBe('completed');
  expect(existsSync(generated.working_path)).toBe(false);
  const generatedEnv = f.environments().find(row => row.working_path === generated.working_path)!;
  expect(generatedEnv.status).toBe('destroyed');
  expect(git(f.repo, 'rev-parse', generatedEnv.branch_name)).toBe(builderHead);

  const detached = await f.cli(['workflow', 'run', 'round', '--detach', '--json']);
  expect(detached.code).toBe(0);
  await waitFor(
    () =>
      f.runs().length === 5 &&
      f.runs().at(-1)?.status === 'completed' &&
      f.environments().filter(row => row.status === 'destroyed').length === 2
  );
  const detachedRun = f.runs().at(-1)!;
  expect(existsSync(detachedRun.working_path)).toBe(false);
  const detachedEnv = f.environments().find(row => row.working_path === detachedRun.working_path)!;
  expect(git(f.repo, 'rev-parse', detachedEnv.branch_name)).toBe(builderHead);
  expect(existsSync(item.working_path)).toBe(true);
}, 30000);

test.each(['failure', 'pause'] as const)(
  '%s resumes in its original generated checkout and then releases it',
  async mode => {
    const f = fixture();
    const first = await f.cli(['workflow', 'run', mode]);
    expect(first.code).toBe(mode === 'failure' ? 1 : 0);
    const run = f.runs()[0]!;
    expect(run.status).toBe(mode === 'failure' ? 'failed' : 'paused');
    expect(existsSync(run.working_path)).toBe(true);
    const env = f.environments()[0]!;
    const creation = JSON.parse(run.metadata).owned_worktree;
    expect(creation).toBeDefined();
    const result =
      mode === 'failure'
        ? await f.cli(['workflow', 'resume', run.id], { LIFETIME_ALLOW: '1' })
        : await f.cli(['workflow', 'approve', run.id, 'approved']);
    expect(result.output).not.toContain('Workflow failed');
    expect(result.code).toBe(0);
    const resumed = f.runs()[0]!;
    expect(resumed.status).toBe('completed');
    expect(resumed.working_path).toBe(run.working_path);
    expect(JSON.parse(resumed.metadata).owned_worktree).toEqual(creation);
    expect(f.environments()).toHaveLength(1);
    expect(f.environments()[0]?.status).toBe('destroyed');
    expect(existsSync(run.working_path)).toBe(false);
    expect(git(f.repo, 'rev-parse', env.branch_name)).toBe(git(f.repo, 'rev-parse', 'dev'));
  },
  30000
);

test.each(['dirty', 'unpushed'] as const)(
  '%s generated completion retains and reports its listable checkout once',
  async mode => {
    const f = fixture();
    const result = await f.cli(['workflow', 'run', mode]);
    expect(result.code).toBe(0);
    const run = f.runs()[0]!;
    expect(run.status).toBe('completed');
    expect(existsSync(run.working_path)).toBe(true);
    expect(f.environments()[0]?.status).toBe('active');
    const disposition = JSON.parse(run.metadata).worktree_disposition;
    expect(disposition.disposition).toBe('retained');
    expect(disposition.reason).toBe(mode === 'dirty' ? 'uncommitted_changes' : 'unpushed_commits');
    expect(result.output.split('Warning:').length - 1).toBe(1);
    expect(result.output).toContain(run.working_path);
    const events = f.read<TerminalRecordEvent>(
      'SELECT * FROM remote_agent_workflow_events WHERE workflow_run_id = ? ORDER BY created_at, event_order, id',
      run.id
    );
    expect(getTerminalRecord('completed', events)?.worktree_disposition).toEqual(disposition);
    const listed = await f.cli(['isolation', 'list']);
    expect(listed.code).toBe(0);
    expect(listed.output).toContain(run.working_path);
  },
  30000
);

test('a refusal after assessment is recorded and printed through the real CLI host', async () => {
  const f = fixture(true);
  const result = await f.cli(['workflow', 'run', 'round']);
  expect(result.code).toBe(0);
  const run = f.runs()[0]!;
  expect(run.status).toBe('completed');
  expect(readFileSync(join(run.working_path, 'arrived.txt'), 'utf8')).toBe(
    'work arriving after assessment'
  );
  const events = f.read<TerminalRecordEvent>(
    'SELECT * FROM remote_agent_workflow_events WHERE workflow_run_id = ? ORDER BY created_at, event_order, id',
    run.id
  );
  expect(events.filter(event => event.event_type === 'workflow_completed')).toHaveLength(1);
  expect(events.filter(event => event.event_type === 'workflow_cleanup_warning')).toHaveLength(1);
  expect(getTerminalRecord('completed', events)?.worktree_disposition).toEqual(
    JSON.parse(run.metadata).worktree_disposition
  );
  expect(result.output.split('Warning:').length - 1).toBe(1);
  expect(result.output).toContain(run.working_path);
  expect((await f.cli(['isolation', 'list'])).output).toContain(run.working_path);
}, 30000);

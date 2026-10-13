import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { z } from '@hono/zod-openapi';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeProjectPath } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';

const CLI_ENTRY = join(import.meta.dir, 'fixtures', 'workflow-cli-without-title.ts');
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempTree(root);
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function initRepo(repo: string, remote: string, file: string): void {
  mkdirSync(join(repo, 'subdir'), { recursive: true });
  mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
  writeFileSync(join(repo, file), 'committed\n');
  writeFileSync(join(repo, '.gitignore'), 'projects/\n');
  writeFileSync(
    join(repo, '.archon', 'workflows', 'probe.yaml'),
    `name: probe\ndescription: Probe checkout\nnodes:\n  - id: probe\n    bash: cat ${file}\n`
  );
  git(repo, ['init', '-qb', 'main']);
  // Windows runners default to core.autocrlf=true, which would check the file
  // out as CRLF in the run's worktree.
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['add', '.']);
  git(repo, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  git(repo, ['init', '--bare', '-q', '--initial-branch=main', remote]);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-qu', 'origin', 'main']);
}

interface CodebaseRow {
  id: string;
  default_cwd: string;
}

interface RunRow {
  codebase_id: string;
  working_path: string;
  status: string;
}

test('nested repo registers independently and its worktree retains the child owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-codebase-resolution-'));
  roots.push(root);
  const home = join(root, 'home');
  const parent = join(root, 'parent');
  const child = join(parent, 'projects', 'apps', 'child');
  initRepo(parent, join(root, 'parent.git'), 'parent-only.txt');
  initRepo(child, join(root, 'child.git'), 'child-only.txt');

  function run(cwd: string, args: string[]): string {
    const invocation = crypto.randomUUID();
    const result = spawnSync(
      process.execPath,
      [CLI_ENTRY, 'workflow', 'run', 'probe', invocation, '--conversation-id', invocation, ...args],
      {
        cwd,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          ARCHON_HOME: home,
          DATABASE_URL: '',
          ARCHON_TELEMETRY_DISABLED: '1',
        },
      }
    );
    if (result.error) throw result.error;
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return invocation;
  }

  run(parent, ['--no-worktree']);
  const db = new Database(join(home, 'archon.db'), { readonly: true });
  try {
    const codebases = db.query<CodebaseRow, []>(
      'SELECT id, default_cwd FROM remote_agent_codebases'
    );
    const parentRow = codebases.get();
    if (!parentRow) throw new Error('Parent repository was not registered');
    expect(parentRow.default_cwd).toBe(await canonicalizeProjectPath(parent));
    const invocation = run(join(child, 'subdir'), ['--branch', 'child-probe', '--from', 'main']);
    const childPath = await canonicalizeProjectPath(child);
    const childRow = codebases.all().find(row => row.default_cwd === childPath);
    expect(childRow).toBeDefined();
    if (!childRow) throw new Error('Child repository was not registered');
    const runs = db.query<RunRow, [string]>(
      'SELECT codebase_id, working_path, status FROM remote_agent_workflow_runs WHERE user_message = ?'
    );
    const isolated = runs.get(invocation);
    expect(isolated?.codebase_id).toBe(childRow.id);
    expect(isolated?.status).toBe('completed');
    if (!isolated) throw new Error('Missing child run');
    expect(readFileSync(join(isolated.working_path, 'child-only.txt'), 'utf8')).toBe('committed\n');
    expect(
      git(isolated.working_path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).toBe(git(child, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    mkdirSync(join(isolated.working_path, 'subdir'));
    const worktreeInvocation = run(join(isolated.working_path, 'subdir'), ['--no-worktree']);
    expect(runs.get(worktreeInvocation)?.codebase_id).toBe(childRow.id);
    const subdirInvocation = run(join(child, 'subdir'), ['--no-worktree']);
    expect(runs.get(subdirInvocation)?.codebase_id).toBe(childRow.id);
    expect(codebases.all()).toHaveLength(2);
    expect(codebases.all().find(row => row.id === parentRow.id)).toEqual(parentRow);
  } finally {
    db.close();
  }
}, 120_000);

test('legacy relative registration fails with recovery guidance', () => {
  const root = mkdtempSync(join(tmpdir(), 'archon-legacy-cwd-'));
  roots.push(root);
  const home = join(root, 'home');
  const repo = join(root, 'legacy-project');
  initRepo(repo, join(root, 'remote.git'), 'probe.txt');
  const gitLog = join(root, 'git.jsonl');
  const recordingEntry = join(import.meta.dir, 'fixtures', 'workflow-cli-with-git-recording.ts');
  const run = (args: string[], cwd = repo): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [recordingEntry, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        ARCHON_HOME: home,
        DATABASE_URL: '',
        ARCHON_TELEMETRY_DISABLED: '1',
        ARCHON_TEST_GIT_LOG: gitLog,
      },
    });
  const initial = run(['workflow', 'run', 'probe', '--branch', 'legacy-probe', '--from', 'main']);
  expect(initial.status, initial.stdout + initial.stderr).toBe(0);
  const db = new Database(join(home, 'archon.db'));
  try {
    const project = db
      .query<{ id: string; name: string }, []>('SELECT id, name FROM remote_agent_codebases')
      .get();
    if (!project) throw new Error('Missing registration');
    const env = db
      .query<
        { id: string; working_path: string; branch_name: string },
        []
      >('SELECT id, working_path, branch_name FROM remote_agent_isolation_environments')
      .get();
    if (!env) throw new Error('Missing isolation environment');
    const gitCallSchema = z.object({ command: z.string(), args: z.array(z.string()) });
    const recorded = (): z.infer<typeof gitCallSchema>[] =>
      readFileSync(gitLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => gitCallSchema.parse(JSON.parse(line)));
    expect(recorded().some(call => call.command === 'git' && call.args.at(-1) === 'remote')).toBe(
      true
    );
    db.run("UPDATE remote_agent_isolation_environments SET created_at = '2000-01-01 00:00:00'");
    const missingPath = join(root, 'missing-worktree');
    const ghostId = crypto.randomUUID();
    db.run(
      `INSERT INTO remote_agent_isolation_environments
       (id, codebase_id, workflow_type, workflow_id, provider, working_path, branch_name,
        created_by_platform, created_at)
       VALUES (?, ?, 'task', 'missing', 'worktree', ?, 'missing', 'cli', '2000-01-01 00:00:00')`,
      [ghostId, project.id, missingPath]
    );
    db.run("UPDATE remote_agent_codebases SET default_cwd = 'projects/some-repo'");
    writeFileSync(gitLog, '');
    for (const args of [
      ['workflow', 'run', 'probe'],
      ['workflow', 'run', 'probe', '--no-worktree'],
      ['workflow', 'run', 'probe', '--detach'],
      ['isolation', 'cleanup', '7'],
    ]) {
      const legacy = run(args);
      expect(legacy.status, legacy.stdout + legacy.stderr).not.toBe(0);
      expect(legacy.stdout + legacy.stderr).toContain(project.name);
      expect(legacy.stdout + legacy.stderr).toContain('/register-project');
    }
    const folder = join(root, 'folder');
    mkdirSync(folder);
    const folderResult = run(['workflow', 'run', 'probe', '--folder', '--json'], folder);
    expect(folderResult.status).not.toBe(0);
    expect(JSON.parse(folderResult.stdout)).toMatchObject({
      ok: false,
      error: expect.stringContaining('/register-project'),
    });
    expect(
      recorded().filter(
        call =>
          call.command === 'git' &&
          call.args.some(
            (arg, index) => arg === '-C' && call.args[index + 1] === 'projects/some-repo'
          )
      )
    ).toEqual([]);
    expect(existsSync(env.working_path)).toBe(true);
    expect(git(repo, ['branch', '--list', env.branch_name])).toContain(env.branch_name);
    expect(
      db
        .query<{ status: string }, []>('SELECT status FROM remote_agent_isolation_environments')
        .all()
        .every(row => row.status === 'active')
    ).toBe(true);
    expect(
      db.query<{ default_cwd: string }, []>('SELECT default_cwd FROM remote_agent_codebases').get()
        ?.default_cwd
    ).toBe('projects/some-repo');
  } finally {
    db.close();
  }
}, 60_000);

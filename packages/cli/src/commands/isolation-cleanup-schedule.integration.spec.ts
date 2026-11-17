// @archon-test-isolated
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { cliProgramArguments } from '../utils/cli-program-arguments';
import { isolationCleanupScheduleConfig } from './isolation-schedule';

const trackTempRoot = trackTempRoots();
const CLI_ENTRY = resolve(import.meta.dir, '..', 'cli.ts');

function createFixture(): {
  repo: string;
  home: string;
  env: NodeJS.ProcessEnv;
  git: (...args: string[]) => string;
} {
  const root = trackTempRoot(realpathSync(mkdtempSync(join(tmpdir(), 'archon-cleanup-schedule-'))));
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(home);
  mkdirSync(join(repo, '.archon', 'workflows'), { recursive: true });
  function git(...args: string[]): string {
    const result = Bun.spawnSync(['git', '-C', repo, ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  git('init', '-q', '--initial-branch=main');
  git('init', '-q', '--bare', origin);
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('remote', 'add', 'origin', origin);
  writeFileSync(join(repo, '.archon', 'config.yaml'), 'worktree:\n  baseBranch: main\n');
  const workflows = {
    // Its commit lands on origin/main, so the merge covers the branch.
    land: 'set -e; echo landed > landed.txt; git add landed.txt; git commit -qm land; git push -q origin HEAD:main',
    dirty: 'echo work > uncommitted.txt',
  };
  for (const [name, bash] of Object.entries(workflows)) {
    writeFileSync(
      join(repo, '.archon', 'workflows', `${name}.yaml`),
      `name: ${name}\ndescription: Cleanup schedule fixture\nnodes:\n  - id: work\n    bash: ${JSON.stringify(bash)}\n`
    );
  }
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('push', '-q', 'origin', 'main');
  const env = {
    ...process.env,
    ARCHON_HOME: home,
    DATABASE_URL: '',
    ARCHON_TELEMETRY_DISABLED: '1',
  };
  return { repo, home, env, git };
}

function readEnvironments(
  home: string
): { branch_name: string; working_path: string; status: string }[] {
  const database = new Database(join(home, 'archon.db'), { readonly: true });
  try {
    return database
      .query<{ branch_name: string; working_path: string; status: string }, []>(
        'SELECT branch_name, working_path, status FROM remote_agent_isolation_environments'
      )
      .all();
  } finally {
    database.close();
  }
}

describe('isolation cleanup schedule', () => {
  test('one scheduled pass releases a merged worktree and keeps one with uncommitted changes', async () => {
    const fixture = createFixture();
    for (const [workflow, branch] of [
      ['land', 'land-branch'],
      ['dirty', 'dirty-branch'],
    ]) {
      const run = Bun.spawnSync(
        [process.execPath, CLI_ENTRY, 'workflow', 'run', workflow, '--branch', branch, '--json'],
        { cwd: fixture.repo, env: fixture.env }
      );
      if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    }
    const before = readEnvironments(fixture.home);
    expect(before.map(env => [env.branch_name, env.status]).sort()).toEqual([
      ['dirty-branch', 'active'],
      ['land-branch', 'active'],
    ]);

    // Run the installed job's command the way launchd would: from its working directory,
    // which is the Archon home and not a git repository.
    const config = isolationCleanupScheduleConfig(undefined, fixture.env);
    expect(config.workingDirectory).toBe(fixture.home);
    const archonArguments = config.programArguments.slice(cliProgramArguments().length);
    const pass = Bun.spawnSync([process.execPath, CLI_ENTRY, ...archonArguments], {
      cwd: config.workingDirectory,
      env: fixture.env,
    });
    if (pass.exitCode !== 0) throw new Error(pass.stderr.toString());

    const after = new Map(readEnvironments(fixture.home).map(env => [env.branch_name, env]));
    const landed = after.get('land-branch');
    const dirty = after.get('dirty-branch');
    expect(landed?.status).toBe('destroyed');
    expect(
      existsSync(before.find(env => env.branch_name === 'land-branch')?.working_path ?? '')
    ).toBe(false);
    expect(fixture.git('branch', '--list', 'land-branch')).toBe('');
    expect(dirty?.status).toBe('active');
    expect(existsSync(join(dirty?.working_path ?? '', 'uncommitted.txt'))).toBe(true);
  }, 30_000);
});

/**
 * Worktree creation against a real git repository.
 *
 * `worktree.test.ts` replaces `node:fs/promises` and `@archon/paths` for its whole
 * process, so this file gets its own `testGroups` entry. What it proves needs real
 * git: after setup fails, the directory is gone, git no longer lists the worktree,
 * the branch survives, and the next run cannot adopt what is no longer there.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toBranchName, toRepoPath } from '@archon/git';
import { setLogLevel } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';

import { WorktreeProvider } from './worktree';
import type { IsolationRequest } from '../types';

// The provider logs a full setup failure and its rollback. Both are expected here,
// and a child logger takes the level set before it is created.
setLogLevel('silent');

const CODEBASE_NAME = 'acme/widgets';
const TASK_BRANCH = 'feature/login';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`);
  }
  return stdout;
}

describe('WorktreeProvider against real git', () => {
  const trackTempRoot = trackTempRoots();
  const originalArchonHome = process.env.ARCHON_HOME;
  let root: string;
  let repoPath: string;
  let provider: WorktreeProvider;
  let request: IsolationRequest;
  let worktreePath: string;

  /** Register a submodule whose URL points at a path that was never created. */
  async function addUnreachableSubmodule(): Promise<void> {
    await git(repoPath, 'checkout', '-q', TASK_BRANCH);
    await writeFile(
      join(repoPath, '.gitmodules'),
      `[submodule "sub"]\n\tpath = sub\n\turl = ${join(root, 'missing.git')}\n`
    );
    await git(repoPath, 'add', '.gitmodules');
    const head = (await git(repoPath, 'rev-parse', 'HEAD')).trim();
    await git(repoPath, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`);
    await git(repoPath, 'commit', '-qm', 'register a submodule that cannot be fetched');
    await git(repoPath, 'checkout', '-q', 'main');
  }

  const registeredWorktrees = async (): Promise<string[]> =>
    (await git(repoPath, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => line.slice('worktree '.length).trim());

  beforeEach(async () => {
    // realpath so the paths this test asserts on match the ones git reports
    // (macOS resolves /var to /private/var).
    root = trackTempRoot(realpathSync(await mkdtemp(join(tmpdir(), 'archon-worktree-'))));
    process.env.ARCHON_HOME = join(root, 'archon-home');

    repoPath = join(root, 'repo');
    await mkdir(repoPath, { recursive: true });
    await git(repoPath, 'init', '-q', '-b', 'main');
    await git(repoPath, 'config', 'user.email', 'test@example.com');
    await git(repoPath, 'config', 'user.name', 'Archon Test');
    await git(repoPath, 'config', 'commit.gpgsign', 'false');
    await writeFile(join(repoPath, 'README.md'), '# fixture\n');
    await git(repoPath, 'add', 'README.md');
    await git(repoPath, 'commit', '-qm', 'initial commit');
    await git(repoPath, 'branch', TASK_BRANCH);

    provider = new WorktreeProvider();
    request = {
      codebaseId: 'cb-1',
      codebaseName: CODEBASE_NAME,
      canonicalRepoPath: toRepoPath(repoPath),
      workflowType: 'task',
      identifier: 'login',
      taskBranch: { kind: 'existing', branch: toBranchName(TASK_BRANCH) },
    };
    worktreePath = provider.getWorktreePath(request, TASK_BRANCH);
  });

  afterEach(() => {
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  test('a setup failure after `git worktree add` leaves nothing for the next run to adopt', async () => {
    await addUnreachableSubmodule();
    const branchHead = (await git(repoPath, 'rev-parse', TASK_BRANCH)).trim();

    await expect(provider.create(request)).rejects.toThrow(/Submodule initialization failed/);

    expect(existsSync(worktreePath)).toBe(false);
    expect(await registeredWorktrees()).not.toContain(worktreePath);
    // The branch predates this attempt: rolling back the checkout must not touch it.
    expect((await git(repoPath, 'rev-parse', TASK_BRANCH)).trim()).toBe(branchHead);

    // The next run must hit the same setup failure rather than adopt a checkout
    // whose submodules were never initialized.
    await expect(provider.create(request)).rejects.toThrow(/Submodule initialization failed/);
    expect(existsSync(worktreePath)).toBe(false);
  });

  test('a worktree whose setup completed survives and is reused by the next run', async () => {
    const created = await provider.create(request);

    expect(created.workingPath).toBe(worktreePath);
    expect(existsSync(worktreePath)).toBe(true);
    expect(await registeredWorktrees()).toContain(worktreePath);

    await writeFile(join(worktreePath, 'work-in-progress.txt'), 'from the first run\n');
    const reused = await provider.create(request);

    expect(reused.workingPath).toBe(worktreePath);
    expect(reused.metadata.adopted).toBe(true);
    // The same checkout, not a fresh one: the first run's file is still here.
    expect(existsSync(join(worktreePath, 'work-in-progress.txt'))).toBe(true);
  });
});

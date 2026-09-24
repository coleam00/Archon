/**
 * Worktree creation against a real git repository.
 *
 * `worktree.test.ts` replaces `node:fs/promises` and `@archon/paths` for its whole
 * process, so this file gets its own `testGroups` entry. What it proves needs real
 * git: after setup fails, the directory is gone, git no longer lists the worktree,
 * the branch survives, and the next run cannot adopt what is no longer there. The
 * setup lock is real git state too — git's own refusal to remove or prune a locked
 * worktree is half of what makes it a usable marker.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

  /**
   * What git knows about each worktree it has registered, with the path in this
   * platform's own spelling: git prints forward slashes on Windows, so its raw
   * strings never compare equal to a path built with `join`.
   */
  const worktreeRecords = async (): Promise<{ path: string; attributes: string[] }[]> =>
    (await git(repoPath, 'worktree', 'list', '--porcelain'))
      .trim()
      .split('\n\n')
      .map(record => record.split('\n').map(line => line.trim()))
      .map(([first = '', ...attributes]) => ({
        path: resolve(first.slice('worktree '.length)),
        attributes,
      }));

  const registeredWorktrees = async (): Promise<string[]> =>
    (await worktreeRecords()).map(record => record.path);

  const lockReasonOf = async (path: string): Promise<string | null> => {
    const record = (await worktreeRecords()).find(entry => entry.path === resolve(path));
    const locked = record?.attributes.find(line => line.startsWith('locked'));
    return locked === undefined ? null : locked.slice('locked'.length).trim();
  };

  /**
   * What the worktree's lock file held while `git worktree add` was still
   * running, as recorded by the `post-checkout` hook installed below.
   */
  const lockSeenDuringAdd = async (): Promise<string> => {
    const adminDir = (await git(worktreePath, 'rev-parse', '--absolute-git-dir')).trim();
    try {
      return (await readFile(join(adminDir, 'locked-during-add'), 'utf-8')).trim();
    } catch {
      return 'the post-checkout hook recorded nothing';
    }
  };

  beforeEach(async () => {
    // realpath so the paths this test asserts on match the ones git reports:
    // macOS resolves /var to /private/var, and Windows expands the 8.3 short
    // component (`C:\Users\RUNNER~1\…`). `fs/promises.realpath` is the variant
    // whose short-name expansion this repo has verified — see
    // `canonicalizeProjectPath` in @archon/paths.
    root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'archon-worktree-'))));
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
    expect(await registeredWorktrees()).not.toContain(resolve(worktreePath));
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
    expect(await registeredWorktrees()).toContain(resolve(worktreePath));
    // The setup lock is released, or nothing could adopt or clean up this checkout.
    expect(await lockReasonOf(worktreePath)).toBeNull();

    await writeFile(join(worktreePath, 'work-in-progress.txt'), 'from the first run\n');
    const reused = await provider.create(request);

    expect(reused.workingPath).toBe(worktreePath);
    expect(reused.metadata.adopted).toBe(true);
    // The same checkout, not a fresh one: the first run's file is still here.
    expect(existsSync(join(worktreePath, 'work-in-progress.txt'))).toBe(true);
  });

  test('a checkout still marked as being set up is refused, not adopted', async () => {
    // What a setup killed mid-flight leaves behind: the checkout git created,
    // still carrying the lock the run took before setting it up.
    await git(repoPath, 'worktree', 'add', '-q', worktreePath, TASK_BRANCH);
    await git(
      repoPath,
      'worktree',
      'lock',
      '--reason',
      'archon: worktree setup in progress',
      worktreePath
    );

    await expect(provider.create(request)).rejects.toThrow(/its setup did not finish/);

    // Refusing must not destroy it either: the operator decides, and a live run
    // may still own it.
    expect(existsSync(worktreePath)).toBe(true);
    expect(await lockReasonOf(worktreePath)).toBe('archon: worktree setup in progress');
  });

  test('the checkout is marked unfinished from the moment git creates it', async () => {
    // `post-checkout` runs inside the new worktree before `git worktree add`
    // returns — the first moment the checkout exists on disk, and so the first
    // moment another run's `findExisting` could see it. Recording git's own lock
    // file there captures exactly what that run would have found.
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\n' +
        'gd=$(git rev-parse --absolute-git-dir)\n' +
        'cp "$gd/locked" "$gd/locked-during-add" 2>/dev/null ||' +
        ' printf unlocked > "$gd/locked-during-add"\n',
      { mode: 0o755 }
    );

    await provider.create(request);

    // Taking the lock after `add` returned would leave this reading `unlocked`,
    // and a concurrent run adopting a checkout with no submodules and no
    // configured files. `--lock` on the add itself is what closes that window.
    expect(await lockSeenDuringAdd()).toBe('archon: worktree setup in progress');
  });

  test("a checkout locked for someone else's reason is still adopted", async () => {
    await git(repoPath, 'worktree', 'add', '-q', worktreePath, TASK_BRANCH);
    await git(repoPath, 'worktree', 'lock', '--reason', 'on the external drive', worktreePath);

    const adopted = await provider.create(request);

    expect(adopted.workingPath).toBe(worktreePath);
    expect(adopted.metadata.adopted).toBe(true);
  });
});

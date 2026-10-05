/**
 * Worktree creation against a real git repository.
 *
 * `worktree.test.ts` replaces `node:fs/promises` and `@archon/paths` for its whole
 * process, so this file gets its own `testGroups` entry. Real Git is needed to
 * prove failed-add ownership, cleanup, and preservation of hidden changes.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { toBranchName, toRepoPath } from '@archon/git';
import { setLogLevel } from '@archon/paths';
import { trackTempRoots } from '@archon/paths/test-utils';

import { WorktreeProvider } from './worktree';
import type { IsolationRequest } from '../types';
import { classifyIsolationError, MissingProjectDirectoryError } from '../errors';

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

describe('missing registered project directory', () => {
  const trackTempRoot = trackTempRoots();

  test.each([false, true])(
    'fails before config or directory creation (loader throws: %s)',
    async loaderThrows => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-missing-workspace-')));
      const repoPath = join(root, 'source');
      const provider = new WorktreeProvider(() => {
        if (loaderThrows) throw new Error('config must not load for a missing project');
        return Promise.resolve(null);
      });
      const error = await provider
        .create({
          codebaseId: 'cb-missing',
          codebaseName: CODEBASE_NAME,
          canonicalRepoPath: toRepoPath(repoPath),
          workflowType: 'issue',
          identifier: '1778',
        })
        .catch((error: unknown) => error);

      expect(error).toBeInstanceOf(MissingProjectDirectoryError);
      if (!(error instanceof MissingProjectDirectoryError)) {
        throw new Error('expected a missing-directory error');
      }
      expect(error.message).toContain(repoPath);
      expect(error.message).toContain(CODEBASE_NAME);
      expect(error.message).toContain('Restore');
      expect(error.message).toContain('re-register');
      expect(await readdir(root)).toEqual([]);
    }
  );

  test.each([
    ['is a regular file', 'source'],
    ['has a regular file as an ancestor', join('source', 'repo')],
  ])('treats a path that %s as missing', async (_shape, relativeRepoPath) => {
    const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-missing-workspace-')));
    await writeFile(join(root, 'source'), 'not a directory');
    const repoPath = join(root, relativeRepoPath);
    const provider = new WorktreeProvider(() => {
      throw new Error('config must not load for a missing project');
    });
    const error = await provider
      .create({
        codebaseId: 'cb-missing',
        codebaseName: CODEBASE_NAME,
        canonicalRepoPath: toRepoPath(repoPath),
        workflowType: 'issue',
        identifier: '1778',
      })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(MissingProjectDirectoryError);
    expect(await readdir(root)).toEqual(['source']);
  });
});

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

  test('an existing repository with a failed fetch still receives network guidance', async () => {
    await git(repoPath, 'remote', 'add', 'origin', join(root, 'missing-remote.git'));

    await expect(
      provider.create({
        codebaseId: request.codebaseId,
        codebaseName: request.codebaseName,
        canonicalRepoPath: request.canonicalRepoPath,
        workflowType: 'issue',
        identifier: '1778',
        baseBranch: toBranchName('main'),
      })
    ).rejects.toThrow('Check your network connection and remote configuration.');

    expect(existsSync(repoPath)).toBe(true);
    expect(await registeredWorktrees()).toEqual([resolve(repoPath)]);
  });

  test('a failing post-checkout hook rolls back its clean checkout and preserves the error', async () => {
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\necho hook-failure-3477 >&2\nexit 42\n',
      { mode: 0o755 }
    );

    await expect(provider.create(request)).rejects.toThrow('hook-failure-3477');

    expect(existsSync(worktreePath)).toBe(false);
    expect(await registeredWorktrees()).not.toContain(resolve(worktreePath));
    expect((await git(repoPath, 'rev-parse', TASK_BRANCH)).trim()).toBe(
      (await git(repoPath, 'rev-parse', 'main')).trim()
    );
  });

  test.each(['assume-unchanged', 'skip-worktree'])(
    'preserves tracked edits hidden by %s',
    async flag => {
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\ngit update-index --${flag} README.md\nprintf hidden-work > README.md\necho hidden-hook-failure >&2\nexit 42\n`,
        { mode: 0o755 }
      );
      await expect(provider.create(request)).rejects.toThrow('hidden-hook-failure');
      expect(await readFile(join(worktreePath, 'README.md'), 'utf-8')).toBe('hidden-work');
      expect(await lockReasonOf(worktreePath)).toMatch(/^archon: worktree setup in progress: .+/);
    }
  );

  test.each(['uninitialized', 'initialized-ignored'])(
    'preserves hidden files in an %s submodule',
    async kind => {
      await addUnreachableSubmodule();
      let submoduleSetup = 'mkdir -p sub\n';
      if (kind === 'initialized-ignored') {
        const subRepo = join(root, 'sub-repo');
        await mkdir(subRepo);
        await git(subRepo, 'init', '-q');
        await git(subRepo, 'config', 'user.email', 'test@example.com');
        await git(subRepo, 'config', 'user.name', 'Archon Test');
        await git(subRepo, 'config', 'commit.gpgsign', 'false');
        await writeFile(join(subRepo, '.gitignore'), 'hook-output\n');
        await git(subRepo, 'add', '.gitignore');
        await git(subRepo, 'commit', '-qm', 'ignore hook output');
        await git(repoPath, 'checkout', '-q', TASK_BRANCH);
        await writeFile(
          join(repoPath, '.gitmodules'),
          `[submodule "sub"]\n\tpath = sub\n\turl = ${subRepo}\n`
        );
        const head = (await git(subRepo, 'rev-parse', 'HEAD')).trim();
        await git(repoPath, 'update-index', '--cacheinfo', `160000,${head},sub`);
        await git(repoPath, 'add', '.gitmodules');
        await git(repoPath, 'commit', '-qm', 'use local submodule');
        await git(repoPath, 'checkout', '-q', 'main');
        submoduleSetup =
          'git -c protocol.file.allow=always submodule update --init >/dev/null 2>&1 || exit 99\n';
      }
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        '#!/bin/sh\n' +
          submoduleSetup +
          'printf nested-work > sub/hook-output\necho nested-hook-failure >&2\nexit 42\n',
        { mode: 0o755 }
      );
      await expect(provider.create(request)).rejects.toThrow('nested-hook-failure');
      expect(await readFile(join(worktreePath, 'sub', 'hook-output'), 'utf-8')).toBe('nested-work');
      expect(await registeredWorktrees()).toContain(resolve(worktreePath));
    }
  );

  test('removes the owned registration when a failing hook removes its checkout', async () => {
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\nrm -rf "$PWD"\necho vanished-hook-failure >&2\nexit 42\n',
      { mode: 0o755 }
    );
    const error = await provider.create(request).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected hook failure');
    expect(error.message).toContain('vanished-hook-failure');
    expect(classifyIsolationError(error)).not.toContain('was left behind');
    expect(await registeredWorktrees()).not.toContain(resolve(worktreePath));
    expect(existsSync(worktreePath)).toBe(false);
  });

  test.each(['another-attempt', 'unlocked'])(
    'preserves a missing checkout registration whose lock is %s',
    async reason => {
      const changeLock =
        reason === 'unlocked'
          ? 'rm "$gd/locked"'
          : 'printf "archon: worktree setup in progress: another-attempt" > "$gd/locked"';
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\ngd=$(git rev-parse --absolute-git-dir)\n${changeLock}\nrm -rf "$PWD"\necho unowned-hook-failure >&2\nexit 42\n`,
        { mode: 0o755 }
      );
      const error = await provider.create(request).catch((error: unknown) => error);
      if (!(error instanceof Error)) throw new Error('Expected hook failure');
      expect(error.message).toContain('unowned-hook-failure');
      expect(classifyIsolationError(error)).toContain('not owned by this attempt');
      expect(await registeredWorktrees()).toContain(resolve(worktreePath));
      expect(await lockReasonOf(worktreePath)).toBe(
        reason === 'unlocked' ? null : 'archon: worktree setup in progress: another-attempt'
      );
    }
  );

  test.each([
    'existing-task',
    'new-task',
    'existing-new-task',
    'same-repo-pr',
    'existing-same-repo-pr',
    'fork-sha',
    'fork-no-sha',
  ])('failed adds preserve the error and ownership across %s', async kind => {
    const remotePath = join(root, 'remote.git');
    await git(root, 'init', '--bare', '-q', remotePath);
    await git(repoPath, 'remote', 'add', 'origin', remotePath);
    await git(
      repoPath,
      'push',
      '-q',
      'origin',
      'main',
      'main:refs/pull/42/head',
      'main:refs/heads/pr-feature'
    );
    if (kind === 'existing-new-task') await git(repoPath, 'branch', 'new-task');
    if (kind === 'existing-same-repo-pr') await git(repoPath, 'branch', 'pr-feature');
    const attempt: IsolationRequest = kind.includes('task')
      ? {
          ...request,
          workflowType: 'task',
          baseBranch: toBranchName('main'),
          taskBranch:
            kind === 'existing-task'
              ? { kind: 'existing', branch: toBranchName(TASK_BRANCH) }
              : { kind: 'new', branch: toBranchName('new-task') },
        }
      : {
          codebaseId: request.codebaseId,
          codebaseName: request.codebaseName,
          canonicalRepoPath: request.canonicalRepoPath,
          workflowType: 'pr',
          identifier: '42',
          baseBranch: toBranchName('main'),
          prBranch: toBranchName('pr-feature'),
          isForkPR: kind.startsWith('fork'),
          ...(kind === 'fork-sha'
            ? { prSha: (await git(repoPath, 'rev-parse', 'main')).trim() }
            : {}),
        };
    const path = provider.getWorktreePath(attempt, provider.generateBranchName(attempt));
    const marker = join(repoPath, '.git', 'hook-failed');
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\nif test ! -f "${marker}"; then touch "${marker}"; echo 'hook-failure already exists' >&2; exit 42; fi\n`,
      { mode: 0o755 }
    );
    await expect(provider.create(attempt)).rejects.toThrow('hook-failure already exists');
    expect(await registeredWorktrees()).toEqual([resolve(repoPath)]);
    expect(existsSync(path)).toBe(false);

    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\ngit update-index --assume-unchanged README.md\nprintf hidden-work > README.md\necho hidden-hook-failure >&2\nexit 42\n',
      { mode: 0o755 }
    );
    await expect(provider.create(attempt)).rejects.toThrow('hidden-hook-failure');
    expect(await readFile(join(path, 'README.md'), 'utf-8')).toBe('hidden-work');
    expect(await registeredWorktrees()).toContain(resolve(path));
    expect(await lockReasonOf(path)).toMatch(/^archon: worktree setup in progress: .+/);
  });

  test.each(['tracked', 'untracked', 'ignored'])(
    'preserves %s changes left by a failing hook',
    async kind => {
      if (kind === 'ignored') {
        await writeFile(join(repoPath, '.git', 'info', 'exclude'), 'hook-output\n');
      }
      const filename = kind === 'tracked' ? 'README.md' : 'hook-output';
      await writeFile(
        join(repoPath, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\nprintf hook-work > ${filename}\necho dirty-hook-failure >&2\nexit 42\n`,
        { mode: 0o755 }
      );
      const error = await provider.create(request).catch((error: unknown) => error);
      if (!(error instanceof Error)) throw new Error('Expected hook failure');
      expect(error.message).toContain('dirty-hook-failure');
      expect(classifyIsolationError(error)).toContain('contains changes');
      expect(await readFile(join(worktreePath, filename), 'utf-8')).toBe('hook-work');
      expect(await registeredWorktrees()).toContain(resolve(worktreePath));
      expect(await lockReasonOf(worktreePath)).toMatch(/^archon: worktree setup in progress: .+/);
      await expect(provider.create(request)).rejects.toThrow('its setup did not finish');
    }
  );

  test('a fork review-branch hook failure is preserved after a successful add', async () => {
    const remotePath = join(root, 'remote.git');
    await git(root, 'init', '--bare', '-q', remotePath);
    await git(repoPath, 'remote', 'add', 'origin', remotePath);
    await git(repoPath, 'push', '-q', 'origin', 'main', 'main:refs/pull/42/head');
    const attempt: IsolationRequest = {
      codebaseId: request.codebaseId,
      codebaseName: request.codebaseName,
      canonicalRepoPath: request.canonicalRepoPath,
      workflowType: 'pr',
      identifier: '42',
      baseBranch: toBranchName('main'),
      prBranch: toBranchName('pr-feature'),
      isForkPR: true,
      prSha: (await git(repoPath, 'rev-parse', 'main')).trim(),
    };
    const path = provider.getWorktreePath(attempt, provider.generateBranchName(attempt));
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\nif test "$(git symbolic-ref --short -q HEAD)" = pr-42-review; then git update-index --skip-worktree README.md; printf hidden-work > README.md; echo "review-hook-failure already exists" >&2; exit 42; fi\n',
      { mode: 0o755 }
    );
    await expect(provider.create(attempt)).rejects.toThrow('review-hook-failure already exists');
    expect(await readFile(join(path, 'README.md'), 'utf-8')).toBe('hidden-work');
    expect(await registeredWorktrees()).toContain(resolve(path));
    expect(await lockReasonOf(path)).toMatch(/^archon: worktree setup in progress: .+/);
  });

  test('a fork add that created its checkout cannot succeed through another checkout', async () => {
    const remotePath = join(root, 'remote.git');
    await git(root, 'init', '--bare', '-q', remotePath);
    await git(repoPath, 'remote', 'add', 'origin', remotePath);
    await git(repoPath, 'push', '-q', 'origin', 'main', 'main:refs/pull/42/head');
    const attempt: IsolationRequest = {
      codebaseId: request.codebaseId,
      codebaseName: request.codebaseName,
      canonicalRepoPath: request.canonicalRepoPath,
      workflowType: 'pr',
      identifier: '42',
      baseBranch: toBranchName('main'),
      prBranch: toBranchName('pr-feature'),
      isForkPR: true,
    };
    const otherPath = join(root, 'other-checkout');
    const marker = join(repoPath, '.git', 'hook-started');
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\nif test ! -f "${marker}"; then touch "${marker}"; git -C "${repoPath}" worktree add --force -q "${otherPath}" pr-42-review || exit 99; echo original-fork-add-failure >&2; exit 42; fi\n`,
      { mode: 0o755 }
    );
    await expect(provider.create(attempt)).rejects.toThrow('original-fork-add-failure');
    expect(await registeredWorktrees()).toContain(resolve(otherPath));
    expect(existsSync(otherPath)).toBe(true);
  });

  test('a dirty fork-PR hook failure keeps the original error through adoption fallback', async () => {
    const remotePath = join(root, 'remote.git');
    await git(root, 'init', '--bare', '-q', remotePath);
    await git(repoPath, 'remote', 'add', 'origin', remotePath);
    await git(repoPath, 'push', '-q', 'origin', 'main', 'main:refs/pull/42/head');
    const prRequest: IsolationRequest = {
      codebaseId: request.codebaseId,
      codebaseName: request.codebaseName,
      canonicalRepoPath: request.canonicalRepoPath,
      workflowType: 'pr',
      identifier: '42',
      prBranch: toBranchName('feature/review'),
      isForkPR: true,
      baseBranch: toBranchName('main'),
    };
    const prPath = provider.getWorktreePath(prRequest, provider.generateBranchName(prRequest));
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\nprintf hook-work > hook-output\necho fork-hook-failure >&2\nexit 42\n',
      { mode: 0o755 }
    );
    const error = await provider.create(prRequest).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected fork hook failure');
    expect(error.message).toContain('fork-hook-failure');
    expect(classifyIsolationError(error)).toContain('contains changes');
    expect(await readFile(join(prPath, 'hook-output'), 'utf-8')).toBe('hook-work');
    expect(await registeredWorktrees()).toContain(resolve(prPath));
    expect(await lockReasonOf(prPath)).toMatch(/^archon: worktree setup in progress: .+/);
  });

  test('preserves a pre-existing worktree at the target path', async () => {
    await git(repoPath, 'worktree', 'add', '-q', worktreePath, TASK_BRANCH);
    await writeFile(join(worktreePath, 'user-work'), 'keep me');
    await writeFile(join(repoPath, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nexit 42\n', {
      mode: 0o755,
    });
    const adopted = await provider.create(request);
    expect(adopted.metadata.adopted).toBe(true);
    expect(await readFile(join(worktreePath, 'user-work'), 'utf-8')).toBe('keep me');
    expect(await registeredWorktrees()).toContain(resolve(worktreePath));
    expect(await lockReasonOf(worktreePath)).toBeNull();
  });

  test.each([false, true])('preserves a pre-existing directory (empty: %s)', async empty => {
    await mkdir(worktreePath, { recursive: true });
    if (!empty) await writeFile(join(worktreePath, 'user-work'), 'keep me');
    await expect(provider.create(request)).rejects.toThrow(
      'a pre-existing directory occupies this path'
    );
    expect(existsSync(worktreePath)).toBe(true);
    if (!empty) expect(await readFile(join(worktreePath, 'user-work'), 'utf-8')).toBe('keep me');
  });

  test('an add that creates nothing reports only the original failure', async () => {
    const missingBranchRequest: IsolationRequest = {
      ...request,
      workflowType: 'task',
      taskBranch: { kind: 'existing', branch: toBranchName('missing-branch') },
    };
    const error = await provider.create(missingBranchRequest).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected add failure');
    expect(error.message).toContain('missing-branch');
    expect(classifyIsolationError(error)).not.toContain('was left behind');
    expect(await registeredWorktrees()).toEqual([resolve(repoPath)]);
  });

  test('a setup failure preserves a checkout whose submodules can hide changes', async () => {
    await addUnreachableSubmodule();
    const branchHead = (await git(repoPath, 'rev-parse', TASK_BRANCH)).trim();
    const error = await provider.create(request).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected setup failure');
    expect(error.message).toContain('Submodule initialization failed');
    expect(classifyIsolationError(error)).toContain('submodules or index flags');
    expect(existsSync(worktreePath)).toBe(true);
    expect(await registeredWorktrees()).toContain(resolve(worktreePath));
    expect((await git(repoPath, 'rev-parse', TASK_BRANCH)).trim()).toBe(branchHead);
    await expect(provider.create(request)).rejects.toThrow('its setup did not finish');
  });

  test('a later setup failure preserves changes from a successful checkout hook', async () => {
    await addUnreachableSubmodule();
    await writeFile(
      join(repoPath, '.git', 'hooks', 'post-checkout'),
      '#!/bin/sh\nprintf hook-work > hook-output\n',
      { mode: 0o755 }
    );
    const error = await provider.create(request).catch((error: unknown) => error);
    if (!(error instanceof Error)) throw new Error('Expected submodule failure');
    expect(error.message).toContain('Submodule initialization failed');
    expect(classifyIsolationError(error)).toContain('contains changes');
    expect(await readFile(join(worktreePath, 'hook-output'), 'utf-8')).toBe('hook-work');
    expect(await lockReasonOf(worktreePath)).toMatch(/^archon: worktree setup in progress: .+/);
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

  test.each([
    'archon: worktree setup in progress',
    'archon: worktree setup in progress: previous-attempt',
  ])('refuses an unfinished checkout with lock %s', async reason => {
    // What a setup killed mid-flight leaves behind: the checkout git created,
    // still carrying the lock the run took before setting it up.
    await git(repoPath, 'worktree', 'add', '-q', worktreePath, TASK_BRANCH);
    await git(repoPath, 'worktree', 'lock', '--reason', reason, worktreePath);

    await expect(provider.create(request)).rejects.toThrow(/its setup did not finish/);

    // Refusing must not destroy it either: the operator decides, and a live run
    // may still own it.
    expect(existsSync(worktreePath)).toBe(true);
    expect(await lockReasonOf(worktreePath)).toBe(reason);
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
    const firstReason = await lockSeenDuringAdd();
    expect(firstReason).toMatch(/^archon: worktree setup in progress: .+/);
    await provider.destroy(worktreePath, { canonicalRepoPath: request.canonicalRepoPath });
    await provider.create(request);
    const secondReason = await lockSeenDuringAdd();
    expect(secondReason).toMatch(/^archon: worktree setup in progress: .+/);
    expect(secondReason).not.toBe(firstReason);
  });

  test("a checkout locked for someone else's reason is still adopted", async () => {
    await git(repoPath, 'worktree', 'add', '-q', worktreePath, TASK_BRANCH);
    await git(repoPath, 'worktree', 'lock', '--reason', 'on the external drive', worktreePath);

    const adopted = await provider.create(request);

    expect(adopted.workingPath).toBe(worktreePath);
    expect(adopted.metadata.adopted).toBe(true);
  });
});

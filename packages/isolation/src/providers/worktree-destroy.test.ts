/** Removing a worktree Archon created, then its local and remote branches. */
import {
  errno,
  execSpy,
  getCanonicalRepoPathSpy,
  listWorktreesSpy,
  mockAccess,
  mockLstat,
  mockReadFile,
  mockRm,
  ranGit,
  readWorktreeRegistrationSpy,
  REPO,
  resetWorktreeMocks,
} from './worktree-test-fixture';
import { describe, test, expect, beforeEach } from 'bun:test';
import * as git from '@archon/git';
import { WorktreeUncommittedChangesError } from '../errors';
import { WorktreeProvider } from './worktree';

const provider = new WorktreeProvider();
const WORKTREE = git.toWorktreePath('/workspace/worktrees/repo/feature-branch');
const BRANCH = git.toBranchName('feature-branch');
const ownedDestroyOptions = { canonicalRepoPath: REPO, creationId: 'test-creation' };

// A registered checkout that carries this creation's proof and is gone once removed.
beforeEach(() => {
  resetWorktreeMocks();
  mockAccess.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue('test-creation');
  readWorktreeRegistrationSpy.mockResolvedValueOnce({ lockReason: null });
  mockLstat.mockImplementation(async path => {
    await mockAccess(path);
    if (ranGit('remove')) throw errno('ENOENT');
    return { isDirectory: () => true };
  });
});

/** The checkout is already gone from disk and from git. */
const alreadyRemoved = (): void => {
  mockAccess.mockRejectedValueOnce(errno('ENOENT', 'ENOENT: no such file or directory'));
  readWorktreeRegistrationSpy.mockReset().mockResolvedValue(null);
};

/** Make the git command containing `token` fail with `error`. */
const failGit = (
  token: string,
  error: Error,
  extra: (args: string[]) => string = () => ''
): void => {
  execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes(token)) throw error;
    return { stdout: extra(args), stderr: '' };
  });
};

describe('ownership and removal', () => {
  test('dirty status refuses removal and branch cleanup', async () => {
    execSpy.mockResolvedValueOnce({ stdout: '?? new-file\0', stderr: '' });
    await expect(
      provider.destroy('/workspace/wt', { ...ownedDestroyOptions, branchName: BRANCH })
    ).rejects.toBeInstanceOf(WorktreeUncommittedChangesError);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      [
        '-C',
        '/workspace/wt',
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ],
      expect.any(Object)
    );
    expect(mockRm).not.toHaveBeenCalled();
  });

  test('status errors propagate unchanged without removal', async () => {
    const failure = new Error('status could not be modified');
    execSpy.mockRejectedValueOnce(failure);
    await expect(provider.destroy('/workspace/wt', ownedDestroyOptions)).rejects.toBe(failure);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(mockRm).not.toHaveBeenCalled();
  });

  test.each([{ force: true }, { removeLocked: true }])(
    'explicit destructive options skip status: %j',
    async flags => {
      await provider.destroy('/workspace/wt', { ...ownedDestroyOptions, ...flags });
      expect(ranGit('status')).toBe(false);
    }
  );

  test('removes only the checkout when no branch is named', async () => {
    getCanonicalRepoPathSpy.mockResolvedValue(REPO);

    const result = await provider.destroy(WORKTREE, ownedDestroyOptions);

    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', WORKTREE]),
      expect.any(Object)
    );
    expect(ranGit('-D')).toBe(false);
    expect(result).toEqual({
      worktreeRemoved: true,
      branchDeleted: null,
      remoteBranchDeleted: null,
      directoryClean: true,
      warnings: [],
    });
  });

  test('force removal deletes the local and remote branch too', async () => {
    getCanonicalRepoPathSpy.mockResolvedValue(REPO);

    const result = await provider.destroy(WORKTREE, {
      ...ownedDestroyOptions,
      force: true,
      branchName: BRANCH,
      deleteRemoteBranch: true,
    });

    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', '--force', WORKTREE]),
      expect.any(Object)
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/workspace/repo', 'branch', '-D', 'feature-branch'],
      expect.any(Object)
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/workspace/repo', 'push', 'origin', '--delete', 'feature-branch'],
      expect.any(Object)
    );
    expect(result).toEqual({
      worktreeRemoved: true,
      branchDeleted: true,
      remoteBranchDeleted: true,
      directoryClean: true,
      warnings: [],
    });
  });

  test('keeps a durable external Git directory anchor when the linked checkout is supplied', async () => {
    const worktreePath = git.toWorktreePath('/workspace/external-linked');
    const branchName = git.toBranchName('external-linked');
    getCanonicalRepoPathSpy.mockRejectedValue(
      new git.CanonicalRepoPathUnavailableError(worktreePath, '/metadata/repository')
    );

    const result = await provider.destroy(worktreePath, {
      ...ownedDestroyOptions,
      branchName,
      canonicalRepoPath: git.toRepoPath(worktreePath),
      deleteRemoteBranch: true,
    });

    expect(execSpy).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-C', '/metadata/repository', 'worktree', 'remove', worktreePath]),
      expect.any(Object)
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/metadata/repository', 'branch', '-D', branchName],
      expect.any(Object)
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/metadata/repository', 'push', 'origin', '--delete', branchName],
      expect.any(Object)
    );
    expect(result.branchDeleted).toBe(true);
    expect(result.remoteBranchDeleted).toBe(true);
  });

  test('refuses an unregistered checkout without issuing removal or branch deletion', async () => {
    readWorktreeRegistrationSpy.mockReset().mockResolvedValue(null);
    await expect(
      provider.destroy('/workspace/wt', { ...ownedDestroyOptions, force: true, branchName: BRANCH })
    ).rejects.toThrow('not registered');
    expect(execSpy).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
  });

  test('does not mistake a dangling symlink for an absent checkout', async () => {
    mockLstat.mockResolvedValue({ isDirectory: () => false });
    await expect(provider.destroy('/workspace/wt')).rejects.toThrow('creation proof');
    expect(execSpy).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
  });

  test('re-throws non-ENOENT errors from access check', async () => {
    mockAccess.mockRejectedValueOnce(errno('EACCES', 'EACCES: permission denied'));

    await expect(provider.destroy(WORKTREE, ownedDestroyOptions)).rejects.toThrow(
      'EACCES: permission denied'
    );
    expect(execSpy).not.toHaveBeenCalled();
  });

  test.each([
    'No such file or directory',
    'is not a working tree',
    'does not exist',
    'fatal: cannot remove: You have local modifications',
  ])(
    'propagates a Git removal error mentioning %s without deleting files or branches',
    async message => {
      const failure = new Error(message);
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' }).mockRejectedValueOnce(failure);
      await expect(
        provider.destroy('/workspace/wt', { ...ownedDestroyOptions, branchName: BRANCH })
      ).rejects.toBe(failure);
      expect(mockRm).not.toHaveBeenCalled();
      expect(ranGit('branch')).toBe(false);
    }
  );

  test('reports a surviving directory and skips branch cleanup without recursively removing it', async () => {
    mockLstat.mockResolvedValue({ isDirectory: () => true });
    const result = await provider.destroy('/workspace/wt', {
      ...ownedDestroyOptions,
      branchName: BRANCH,
    });
    expect(result.worktreeRemoved).toBe(true);
    expect(result.directoryClean).toBe(false);
    expect(result.warnings.join(' ')).toContain('Retained directory');
    expect(mockRm).not.toHaveBeenCalled();
    expect(ranGit('branch')).toBe(false);
  });
});

describe('a checkout that is already gone', () => {
  test('skips branch cleanup with a warning when no canonicalRepoPath is given', async () => {
    alreadyRemoved();

    const result = await provider.destroy(WORKTREE, {
      creationId: 'test-creation',
      branchName: BRANCH,
    });

    expect(execSpy).not.toHaveBeenCalled();
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Cannot delete branch');
  });

  test('still deletes the local and remote branch through canonicalRepoPath', async () => {
    alreadyRemoved();

    const result = await provider.destroy(WORKTREE, {
      ...ownedDestroyOptions,
      branchName: BRANCH,
      deleteRemoteBranch: true,
    });

    expect(ranGit('remove')).toBe(false);
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/workspace/repo', 'branch', '-D', 'feature-branch'],
      expect.any(Object)
    );
    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/workspace/repo', 'push', 'origin', '--delete', 'feature-branch'],
      expect.any(Object)
    );
    expect(result.worktreeRemoved).toBe(true); // Already gone counts as removed
    expect(result.branchDeleted).toBe(true);
    expect(result.remoteBranchDeleted).toBe(true);
  });
});

describe('branch cleanup', () => {
  beforeEach(() => {
    getCanonicalRepoPathSpy.mockResolvedValue(REPO);
  });

  const destroyBranch = (deleteRemoteBranch = false) =>
    provider.destroy(WORKTREE, { ...ownedDestroyOptions, branchName: BRANCH, deleteRemoteBranch });

  test('a local branch that is already gone counts as deleted', async () => {
    // Git's wording is ignored; the branch's absence afterwards decides.
    failGit('-D', new Error('error: branch not found'));

    const result = await destroyBranch();

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  test('a remote branch that is already gone counts as deleted', async () => {
    failGit('push', new Error('error: remote ref does not exist'));

    const result = await destroyBranch(true);

    expect(result.remoteBranchDeleted).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  for (const remote of [false, true]) {
    test(`failed ${remote ? 'remote' : 'local'} deletion cannot hide a surviving ref behind not-found prose`, async () => {
      failGit(
        remote ? 'push' : '-D',
        Object.assign(new Error('branch not found; remote ref does not exist'), {
          stderr: "couldn't find remote ref; did not match any branch",
        }),
        args =>
          args.includes('ls-remote') || args.includes('rev-parse')
            ? 'abc123\trefs/heads/feature-branch\n'
            : ''
      );

      const result = await destroyBranch(remote);

      expect(remote ? result.remoteBranchDeleted : result.branchDeleted).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('feature-branch');
    });
  }

  test('returns branchDeleted=false with warning when branch is checked out elsewhere', async () => {
    listWorktreesSpy.mockResolvedValue([{ path: git.toWorktreePath('/other'), branch: BRANCH }]);
    failGit('-D', new Error('error: checked out at'), args =>
      args.includes('rev-parse') ? 'abc123' : ''
    );

    const result = await destroyBranch();

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('checked out elsewhere');
  });

  test('an unexpected local deletion failure is a warning, not an error', async () => {
    failGit('-D', new Error('unexpected git internal error'), args =>
      args.includes('rev-parse') ? 'abc123' : ''
    );

    const result = await destroyBranch();

    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(result.warnings.some(w => w.includes('Unexpected error deleting branch'))).toBe(true);
  });

  test('returns remoteBranchDeleted=false with warning on network error', async () => {
    execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('ls-remote')) throw new Error('network unreachable');
      if (args.includes('push')) throw new Error('fatal: Could not read from remote repository');
      return { stdout: '', stderr: '' };
    });

    const result = await destroyBranch(true);

    expect(result.remoteBranchDeleted).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Failed to delete remote branch');
  });

  test('does not attempt remote branch deletion when deleteRemoteBranch is not set', async () => {
    const result = await destroyBranch();

    expect(ranGit('push')).toBe(false);
    expect(result.remoteBranchDeleted).toBeNull(); // Not requested
  });

  test('deletes the remote branch on the configured remote', async () => {
    await provider.destroy('worktree-path', {
      ...ownedDestroyOptions,
      branchName: git.toBranchName('archon/issue-42'),
      deleteRemoteBranch: true,
      remote: 'upstream',
    });

    expect(execSpy).toHaveBeenCalledWith(
      'git',
      ['-C', '/workspace/repo', 'push', 'upstream', '--delete', 'archon/issue-42'],
      expect.any(Object)
    );
  });
});

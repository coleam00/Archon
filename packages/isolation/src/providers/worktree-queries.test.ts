/** Reading existing worktrees: get, list, adopt and healthCheck. */
import {
  addSafeDirectorySpy,
  adoptionWarnings,
  getCanonicalRepoPathSpy,
  listWorktreesSpy,
  readWorktreeLockSpy,
  resetWorktreeMocks,
  worktreeExistsSpy,
} from './worktree-test-fixture';
import { describe, test, expect, beforeEach } from 'bun:test';
import * as git from '@archon/git';
import { WorktreeProvider } from './worktree';

const provider = new WorktreeProvider();
const MAIN = { path: git.toWorktreePath('/workspace/repo'), branch: git.toBranchName('main') };
const worktree = (path: string, branch: string): git.WorktreeInfo => ({
  path: git.toWorktreePath(path),
  branch: git.toBranchName(branch),
});
const FEATURE = worktree('/workspace/worktrees/repo/feature-auth', 'feature/auth');
const OTHER = worktree('/workspace/worktrees/repo/other-branch', 'other-branch');

beforeEach(resetWorktreeMocks);

/** A worktree on disk whose checkout resolves to `/workspace/repo`, which lists `entries`. */
const registered = (...entries: git.WorktreeInfo[]): void => {
  worktreeExistsSpy.mockResolvedValue(true);
  getCanonicalRepoPathSpy.mockResolvedValue(git.toRepoPath('/workspace/repo'));
  listWorktreesSpy.mockResolvedValue([MAIN, ...entries]);
};

/** A linked checkout whose Git directory lives outside its main repository. */
const externalLinked = (): git.WorktreePath => {
  const worktreePath = git.toWorktreePath('/workspace/external-linked');
  worktreeExistsSpy.mockResolvedValue(true);
  getCanonicalRepoPathSpy.mockRejectedValue(
    new git.CanonicalRepoPathUnavailableError(worktreePath, '/metadata/repository')
  );
  listWorktreesSpy.mockResolvedValue([worktree(worktreePath, 'external-linked')]);
  return worktreePath;
};

describe('get', () => {
  test('returns null for non-existent environment', async () => {
    expect(await provider.get('/workspace/worktrees/repo/nonexistent')).toBeNull();
  });

  test('describes a registered worktree as an observed, active environment', async () => {
    registered(FEATURE);

    expect(await provider.get(FEATURE.path)).toEqual({
      id: FEATURE.path,
      provider: 'worktree',
      workingPath: FEATURE.path,
      branchName: git.toBranchName('feature/auth'),
      status: 'active',
      createdAt: expect.any(Date),
      metadata: { provenance: 'observed', adopted: false },
    });
  });

  test('queries an external-git-dir linked checkout from its exact path', async () => {
    const worktreePath = externalLinked();

    const result = await provider.get(worktreePath);

    expect(result?.workingPath).toBe(worktreePath);
    expect(listWorktreesSpy).toHaveBeenCalledWith(worktreePath);
  });

  test('re-throws errors from getCanonicalRepoPath', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockRejectedValue(new Error('Permission denied'));

    await expect(provider.get(FEATURE.path)).rejects.toThrow('Permission denied');
  });

  test('re-throws errors from listWorktrees', async () => {
    registered();
    listWorktreesSpy.mockRejectedValue(new Error('git timeout'));

    await expect(provider.get(FEATURE.path)).rejects.toThrow('git timeout');
  });

  test('returns null when worktree exists on disk but not in git list (corrupted state)', async () => {
    registered(OTHER);

    expect(await provider.get(FEATURE.path)).toBeNull();
  });
});

describe('list', () => {
  test('lists every worktree except the main checkout as observed environments', async () => {
    const issue = worktree('/workspace/worktrees/repo/issue-10', 'issue-10');
    const pr = worktree('/workspace/worktrees/repo/pr-99', 'pr-99');
    listWorktreesSpy.mockResolvedValue([MAIN, issue, pr]);

    const results = await provider.list('/workspace/repo');

    expect(results).toEqual(
      [issue, pr].map(({ path, branch }) => ({
        id: path,
        provider: 'worktree',
        workingPath: path,
        branchName: branch,
        status: 'active',
        createdAt: expect.any(Date),
        metadata: { provenance: 'observed', adopted: false },
      }))
    );
  });

  test('returns empty array when only the main checkout exists', async () => {
    listWorktreesSpy.mockResolvedValue([MAIN]);

    expect(await provider.list('/workspace/repo')).toEqual([]);
  });
});

describe('healthCheck', () => {
  test('reports whether the worktree exists', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    expect(await provider.healthCheck(FEATURE.path)).toBe(true);
    worktreeExistsSpy.mockResolvedValue(false);
    expect(await provider.healthCheck('/workspace/worktrees/repo/nonexistent')).toBe(false);
  });

  test('propagates I/O errors from worktreeExists (permission denied)', async () => {
    // worktreeExists throws for permission errors (only returns false for ENOENT)
    worktreeExistsSpy.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied, access'), { code: 'EACCES' })
    );

    await expect(provider.healthCheck(FEATURE.path)).rejects.toThrow('EACCES');
  });
});

describe('adopt', () => {
  test('trusts the checkout, then describes it as an adopted environment', async () => {
    registered(FEATURE);
    getCanonicalRepoPathSpy.mockImplementation(async path => {
      expect(addSafeDirectorySpy).toHaveBeenCalledWith(git.toRepoPath(path));
      return git.toRepoPath('/workspace/repo');
    });

    expect(await provider.adopt(FEATURE.path)).toEqual({
      id: FEATURE.path,
      provider: 'worktree',
      workingPath: FEATURE.path,
      branchName: git.toBranchName('feature/auth'),
      status: 'active',
      createdAt: expect.any(Date),
      metadata: { provenance: 'adopted', adopted: true },
    });
    expect(adoptionWarnings()).toHaveLength(1);
  });

  test('public adoption rejects a required trust-write failure', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    addSafeDirectorySpy.mockRejectedValueOnce(new Error('config locked'));
    await expect(provider.adopt(FEATURE.path)).rejects.toThrow('config locked');
    expect(getCanonicalRepoPathSpy).not.toHaveBeenCalled();
    expect(listWorktreesSpy).not.toHaveBeenCalled();
  });

  test('refuses a registered worktree whose setup never finished', async () => {
    registered(FEATURE);
    readWorktreeLockSpy.mockResolvedValue({ reason: 'archon: worktree setup in progress' });

    await expect(provider.adopt(FEATURE.path)).rejects.toThrow(/its setup did not finish/);
  });

  test('adopts an external-git-dir linked checkout from its exact path', async () => {
    const worktreePath = externalLinked();

    const result = await provider.adopt(worktreePath);

    expect(result?.workingPath).toBe(worktreePath);
    expect(result?.metadata).toHaveProperty('adopted', true);
    expect(listWorktreesSpy).toHaveBeenCalledWith(worktreePath);
  });

  test('returns null for non-existent path', async () => {
    expect(await provider.adopt('/workspace/worktrees/repo/nonexistent')).toBeNull();
  });

  test('returns null when path is not a git repository', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockRejectedValue(
      new git.GitFailure('not_repository', 'fatal: not a git repository')
    );

    expect(await provider.adopt(FEATURE.path)).toBeNull();
  });

  test('throws when git query fails with unexpected error', async () => {
    worktreeExistsSpy.mockResolvedValue(true);
    getCanonicalRepoPathSpy.mockRejectedValue(new Error('permission denied'));

    await expect(provider.adopt(FEATURE.path)).rejects.toThrow('permission denied');
  });

  test('throws when listWorktrees fails with unexpected error', async () => {
    registered();
    listWorktreesSpy.mockRejectedValue(new Error('git timeout'));

    await expect(provider.adopt(FEATURE.path)).rejects.toThrow('git timeout');
  });

  test('returns null when worktree exists on disk but not in git list (corrupted state)', async () => {
    registered(OTHER);

    expect(await provider.adopt(FEATURE.path)).toBeNull();
  });
});

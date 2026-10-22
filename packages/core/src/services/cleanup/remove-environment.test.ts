// @archon-test-isolated
import { describe, test, expect, beforeEach } from 'bun:test';
import { removeEnvironment, type RemoveEnvironmentResult } from './remove-environment';
import {
  makeEnvironment,
  mockHasUncommittedChanges,
  mockWorktreeExists,
  mockDestroy,
  mockMarkWorktreeDestroyed,
  mockGetById,
  selectedEnvironment,
  resetCleanupMocks,
} from './test-harness';

beforeEach(resetCleanupMocks);

describe('removeEnvironment', () => {
  test('refuses container removal even with force', async () => {
    mockGetById.mockResolvedValue(makeEnvironment({ provider: 'container' }));
    const result = await removeEnvironment(await selectedEnvironment(), { force: true });
    expect(result.skippedReason).toContain('not a worktree');
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  test('calls destroy with canonicalRepoPath even when directory is missing', async () => {
    mockGetById.mockResolvedValue(
      makeEnvironment({
        working_path: '/path/that/does/not/exist',
        branch_name: 'issue-187',
        metadata: { worktree_branch_created: true },
      })
    );

    const result = await removeEnvironment(await selectedEnvironment());

    expect(mockDestroy).toHaveBeenCalledWith('/path/that/does/not/exist', {
      force: undefined,
      branchName: 'issue-187',
      canonicalRepoPath: '/workspace/repo',
    });
    expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'env-1' })
    );
    expect(result.worktreeRemoved).toBe(true);
    expect(result.skippedReason).toBeUndefined();
  });

  test('retains the active record when provider failure merely claims a missing path', async () => {
    mockGetById.mockResolvedValue(makeEnvironment({ working_path: '/path/exists/but/git/fails' }));
    mockWorktreeExists.mockResolvedValue(true);
    mockDestroy.mockRejectedValueOnce(
      new Error("fatal: cannot change to '/path/exists/but/git/fails': No such file or directory")
    );

    await expect(removeEnvironment(await selectedEnvironment())).rejects.toThrow(
      'No such file or directory'
    );
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  test('returns warnings from partial destroy and still marks the record destroyed', async () => {
    mockGetById.mockResolvedValue(makeEnvironment());
    const warning = "Cannot delete branch 'task-1': branch is checked out elsewhere";
    mockDestroy.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: false,
      remoteBranchDeleted: null,
      directoryClean: true,
      warnings: [warning],
    });

    const result = await removeEnvironment(await selectedEnvironment());

    expect(result).toEqual({ worktreeRemoved: true, branchDeleted: false, warnings: [warning] });
    expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'env-1' })
    );
  });

  test.each([false, true])(
    'retains remote refs without ownership proof (force=%s)',
    async force => {
      mockGetById.mockResolvedValue(makeEnvironment());
      const result = await removeEnvironment(await selectedEnvironment(), {
        force,
        deleteRemoteBranch: true,
      });
      expect(result.worktreeRemoved).toBe(true);
      expect(result.warnings.join(' ')).toContain('Remote branch retained');
      expect(mockDestroy).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ deleteRemoteBranch: true })
      );
      expect(mockMarkWorktreeDestroyed).toHaveBeenCalled();
    }
  );

  test.each([
    {
      label: 'says the environment did not create it',
      metadata: { worktree_branch_created: false },
    },
    { label: 'predates the branch-created key', metadata: {} },
  ])('keeps the branch when the record $label', async ({ metadata }) => {
    mockGetById.mockResolvedValue(
      makeEnvironment({
        working_path: '/workspace/worktrees/operator-branch',
        branch_name: 'operator-branch',
        metadata,
      })
    );

    await removeEnvironment(await selectedEnvironment());

    expect(mockDestroy).toHaveBeenCalledWith('/workspace/worktrees/operator-branch', {
      force: undefined,
      canonicalRepoPath: '/workspace/repo',
    });
    expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'env-1' })
    );
  });

  test('returns skippedReason when worktree has uncommitted changes without force', async () => {
    mockGetById.mockResolvedValue(makeEnvironment());
    mockWorktreeExists.mockResolvedValue(true);
    mockHasUncommittedChanges.mockResolvedValue(true);

    const result = await removeEnvironment(await selectedEnvironment());

    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(result).toEqual({
      worktreeRemoved: false,
      branchDeleted: false,
      warnings: [],
      skippedReason: 'has uncommitted changes',
    });
  });

  test('a failed removal status query propagates without destroying or marking dirty', async () => {
    mockGetById.mockResolvedValue(makeEnvironment());
    mockWorktreeExists.mockResolvedValue(true);
    const failure = new Error('status unavailable');
    mockHasUncommittedChanges.mockRejectedValueOnce(failure);

    await expect(removeEnvironment(await selectedEnvironment())).rejects.toBe(failure);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  test('skippedReason is a closed vocabulary callers can branch on', () => {
    // Callers decide cleanup outcomes by comparing reasons, so an unlisted
    // reason must fail type-check instead of silently missing those branches.
    // @ts-expect-error -- not a reason removeEnvironment produces
    const unknown: RemoveEnvironmentResult['skippedReason'] = 'already removed';
    expect(unknown).toBeDefined();
  });

  test.each(['worktreeRemoved', 'directoryClean'] as const)(
    'incomplete %s retains the active isolation record',
    async field => {
      mockGetById.mockResolvedValue(makeEnvironment());
      mockDestroy.mockResolvedValueOnce({
        worktreeRemoved: true,
        directoryClean: true,
        branchDeleted: null,
        remoteBranchDeleted: null,
        warnings: [],
        [field]: false,
      });
      const result = await removeEnvironment(await selectedEnvironment());
      expect(result.skippedReason).toContain('filesystem removal incomplete');
      expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    }
  );
});

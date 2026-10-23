// @archon-test-isolated
import { describe, test, expect, beforeEach } from 'bun:test';
import { toBranchName } from '@archon/git';
import type * as Isolation from '@archon/isolation';
import { cleanupStaleWorktrees } from '../cleanup-service';
import { cleanupMergedWorktrees, type MergedCleanupResult } from './merged-sweep';
import {
  NO_PR,
  prAt,
  worktreeEnv,
  makeEnvironmentWithAge,
  mockLogger,
  mockHasUncommittedChanges,
  mockWorktreeExists,
  mockGetDefaultBranch,
  mockIsBranchMerged,
  mockIsPatchEquivalent,
  mockLocalBranchExists,
  mockIsRevCoveredBy,
  mockDestroy,
  mockGetPrState,
  mockGetLiveRunOwningEnv,
  mockGetById,
  mockListByCodebaseWithAge,
  mockLoadRepoConfig,
  mergedSweepFinds,
  resetCleanupMocks,
} from './test-harness';

beforeEach(resetCleanupMocks);

describe('cleanupMergedWorktrees', () => {
  test('continues merged cleanup when the settled owner query fails for one environment', async () => {
    mergedSweepFinds(...['before', 'broken', 'after'].map(name => worktreeEnv(name)));
    mockIsBranchMerged.mockResolvedValue(true);
    mockGetLiveRunOwningEnv
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'failed-run', status: 'failed' })
      .mockRejectedValueOnce(new Error('settled owner query failed'));

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toEqual(['before', 'after']);
    expect(result.errors).toEqual([{ branchName: 'broken', error: 'settled owner query failed' }]);
    expect(result.releasedFailedRuns).toEqual([]);
  });

  test.each(
    (['merged', 'stale'] as const).flatMap(sweep =>
      (['throw', 'worktreeRemoved', 'directoryClean'] as const).map(failure => ({ sweep, failure }))
    )
  )('$sweep cleanup records $failure as an error and continues', async ({ sweep, failure }) => {
    const envs = ['broken', 'later'].map(branch =>
      makeEnvironmentWithAge({
        ...worktreeEnv(branch),
        created_by_platform: 'slack',
        days_since_activity: 30,
      })
    );
    mergedSweepFinds(...envs);
    mockListByCodebaseWithAge.mockResolvedValue(envs);
    mockIsBranchMerged.mockResolvedValue(true);
    if (failure === 'throw') mockDestroy.mockRejectedValueOnce(new Error('removal refused'));
    else
      mockDestroy.mockResolvedValueOnce({
        worktreeRemoved: true,
        directoryClean: true,
        branchDeleted: null,
        remoteBranchDeleted: null,
        warnings: [],
        [failure]: false,
      });
    const cleanup = sweep === 'merged' ? cleanupMergedWorktrees : cleanupStaleWorktrees;
    const result = await cleanup('codebase-1', '/workspace/repo');
    expect(result.removed).toEqual(['later']);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([
      {
        branchName: 'broken',
        error:
          failure === 'throw'
            ? 'removal refused'
            : 'filesystem removal incomplete; environment remains active',
      },
    ]);
  });

  test('removes merged branches without uncommitted changes', async () => {
    mergedSweepFinds(worktreeEnv('merged-branch'));
    mockIsBranchMerged.mockResolvedValue(true);
    mockWorktreeExists.mockResolvedValue(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('merged-branch');
    expect(result.skipped).toHaveLength(0);
    expect(mockDestroy).toHaveBeenCalledWith(
      '/workspace/repo/worktrees/merged-branch',
      expect.objectContaining({ branchName: 'merged-branch' })
    );
    expect(mockDestroy).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deleteRemoteBranch: true })
    );
  });

  // Git proves the branch merged, but the worktree's HEAD (detached, or a branch
  // renamed inside it) holds commits the base never received. Removal would delete them.
  test('keeps a worktree whose HEAD has commits git cannot find in the base', async () => {
    mergedSweepFinds(worktreeEnv('head-ahead'));
    mockIsBranchMerged.mockResolvedValue(true);
    mockWorktreeExists.mockResolvedValue(true);
    mockIsPatchEquivalent.mockResolvedValue(false);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    // removeEnvironment's first step: the sweep never tried to remove it.
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockIsPatchEquivalent).toHaveBeenCalledWith(
      '/workspace/repo/worktrees/head-ahead',
      'HEAD',
      'origin/main',
      { throwOnExpectedError: true }
    );
  });

  test('threads worktree.remote from repo config to getDefaultBranch and getPrState', async () => {
    mockLoadRepoConfig.mockResolvedValue({ worktree: { remote: 'upstream' } });
    mergedSweepFinds(worktreeEnv('feature-branch'));

    await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/workspace/repo', 'upstream');
    expect(mockGetPrState).toHaveBeenCalledWith(
      'feature-branch',
      '/workspace/repo',
      expect.any(Map),
      'upstream'
    );
  });

  test.each([
    { check: 'isBranchMerged', mock: mockIsBranchMerged },
    { check: 'isPatchEquivalent', mock: mockIsPatchEquivalent },
  ])('logs a warning and reports an error when $check fails', async ({ mock }) => {
    mergedSweepFinds(worktreeEnv('flaky-branch'));
    mock.mockRejectedValue(new Error('network unreachable'));

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.errors).toEqual([
      { branchName: 'flaky-branch', error: 'merge check failed: network unreachable' },
    ]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'flaky-branch', repoPath: '/workspace/repo' }),
      'cleanup.merge_check_failed'
    );
  });

  test('skips merged branches with uncommitted changes', async () => {
    mergedSweepFinds(worktreeEnv('dirty-branch'));
    mockIsBranchMerged.mockResolvedValue(true);
    mockWorktreeExists.mockResolvedValue(true);
    mockHasUncommittedChanges.mockResolvedValue(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'dirty-branch',
      reason: 'has uncommitted changes',
    });
  });

  test('skips merged branches with a live owning run', async () => {
    mergedSweepFinds(worktreeEnv('live-run-branch'));
    mockIsBranchMerged.mockResolvedValue(true);
    mockGetLiveRunOwningEnv.mockResolvedValue({ id: 'run-abc12345-6789', status: 'running' });

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'live-run-branch',
      reason: 'run run-abc1 is running',
    });
  });

  test('removes branch when git-cherry detects squash-merge', async () => {
    mergedSweepFinds(worktreeEnv('squash-branch'));
    mockIsPatchEquivalent.mockResolvedValueOnce(true);
    mockWorktreeExists.mockResolvedValue(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('squash-branch');
    // Remote-qualified ref is passed to both signals — the local base may be stale (#3002).
    expect(mockIsBranchMerged).toHaveBeenCalledWith(
      '/workspace/repo',
      'squash-branch',
      'origin/main'
    );
    expect(mockIsPatchEquivalent).toHaveBeenCalledWith(
      '/workspace/repo',
      'squash-branch',
      'origin/main'
    );
  });

  test('keeps a branch with commits past its merged PR head', async () => {
    mergedSweepFinds(worktreeEnv('reused-name'));
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
    mockIsRevCoveredBy.mockResolvedValue(false);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    // removeEnvironment's first step: the sweep never tried to remove it.
    expect(mockGetById).not.toHaveBeenCalled();
  });

  // The PR head could not be fetched from the remote; git then cannot compare,
  // and an unanswered comparison must not read as merged.
  test('reports a merged PR whose head commit cannot be fetched as a failed check', async () => {
    mergedSweepFinds(worktreeEnv('head-missing'));
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
    mockIsRevCoveredBy.mockRejectedValue(
      new Error('Failed to fetch PR head pr-head-sha from origin: not our ref')
    );

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.errors).toEqual([
      {
        branchName: 'head-missing',
        error: expect.stringContaining('merge check failed: Failed to fetch PR head'),
      },
    ]);
    expect(mockGetById).not.toHaveBeenCalled();
  });

  test('reports an environment whose PR lookup failed as unverifiable', async () => {
    mergedSweepFinds(worktreeEnv('pr-unavailable'));
    mockGetPrState.mockResolvedValue({ state: 'UNAVAILABLE' });

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toEqual([
      { branchName: 'pr-unavailable', reason: 'PR state lookup failed — merge state unverifiable' },
    ]);
  });

  test.each<{
    pr: Isolation.PrLookup;
    includeClosed: boolean;
    removed: string[];
    skipped: MergedCleanupResult['skipped'];
  }>([
    { pr: prAt('MERGED'), includeClosed: false, removed: ['pr-branch'], skipped: [] },
    { pr: prAt('CLOSED'), includeClosed: true, removed: ['pr-branch'], skipped: [] },
    { pr: prAt('CLOSED'), includeClosed: false, removed: [], skipped: [] },
    {
      pr: prAt('OPEN'),
      includeClosed: false,
      removed: [],
      skipped: [{ branchName: 'pr-branch', reason: 'PR is open (active review)' }],
    },
    { pr: NO_PR, includeClosed: false, removed: [], skipped: [] },
  ])(
    'judges a branch git calls unmerged by its $pr.state PR (includeClosed: $includeClosed)',
    async ({ pr, includeClosed, removed, skipped }) => {
      mergedSweepFinds(worktreeEnv('pr-branch'));
      mockWorktreeExists.mockResolvedValue(true);
      mockGetPrState.mockResolvedValue(pr);

      const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo', {
        includeClosed,
      });

      expect(result.removed).toEqual(removed);
      expect(result.skipped).toEqual(skipped);
    }
  );

  // Before #3471 this was the "merge check failed: unknown commit <branch>" skip that
  // never resolved: `git cherry` cannot take a ref that no longer exists.
  test('removes an environment whose branch ref is gone but whose PR is merged', async () => {
    mergedSweepFinds(worktreeEnv('ref-gone-branch'));
    mockLocalBranchExists.mockResolvedValue(false);
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
    mockWorktreeExists.mockResolvedValue(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('ref-gone-branch');
    expect(result.skipped).toHaveLength(0);
    expect(mockIsBranchMerged).not.toHaveBeenCalled();
    expect(mockIsPatchEquivalent).not.toHaveBeenCalled();
  });

  test('reports an environment whose branch ref is gone and has no PR as unverifiable', async () => {
    mergedSweepFinds(worktreeEnv('ref-gone-no-pr'));
    mockLocalBranchExists.mockResolvedValue(false);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toEqual([
      {
        branchName: 'ref-gone-no-pr',
        reason: 'branch ref is gone and no PR was found — merge state unverifiable',
      },
    ]);
  });

  test('reports the base ref it compared against, from worktree.baseBranch', async () => {
    mockLoadRepoConfig.mockResolvedValue({ worktree: { baseBranch: 'dev' } });

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.baseRef).toBe(toBranchName('origin/dev'));
    expect(mockGetDefaultBranch).not.toHaveBeenCalled();
  });

  // Same contract as the breakdown path: an unhonourable `assistants.*` value
  // stops the sweep before any worktree is inspected or removed.
  test('surfaces an invalid assistants config instead of sweeping worktrees', async () => {
    mergedSweepFinds(worktreeEnv('merged-branch'));
    mockLoadRepoConfig.mockRejectedValue(
      new Error(
        "Invalid assistants config in '/workspace/repo/.archon/config.yaml': " +
          "'assistants.claude.settingSources.0': expected 'project' or 'user'."
      )
    );

    await expect(cleanupMergedWorktrees('codebase-1', '/workspace/repo')).rejects.toThrow(
      /assistants\.claude\.settingSources\.0/
    );
    expect(mockIsBranchMerged).not.toHaveBeenCalled();
  });
});

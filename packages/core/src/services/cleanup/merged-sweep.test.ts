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
  mockHasUncommittedChanges,
  mockWorktreeExists,
  mockGetDefaultBranch,
  mockIsBranchMerged,
  mockIsPatchEquivalent,
  mockLocalBranchExists,
  mockIsRevCoveredBy,
  mockDestroy,
  mockGetPrState,
  mockGetPrsForCommit,
  mockExecFileAsync,
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
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
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
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
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

  test.each(['ancestry', 'patch', 'closed'] as const)(
    '%s evidence alone never authorizes merged removal',
    async evidence => {
      mergedSweepFinds(worktreeEnv('unproven'));
      mockWorktreeExists.mockResolvedValue(true);
      mockIsBranchMerged.mockResolvedValue(evidence === 'ancestry');
      mockIsPatchEquivalent.mockResolvedValue(evidence !== 'closed');
      mockGetPrState.mockResolvedValue(evidence === 'closed' ? prAt('CLOSED') : NO_PR);
      const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo', {
        includeClosed: true,
      });
      expect(result.removed).toEqual([]);
      expect(result.skipped).toHaveLength(1);
      expect(mockDestroy).not.toHaveBeenCalled();
    }
  );

  test('removes merged branches without uncommitted changes', async () => {
    mergedSweepFinds(worktreeEnv('merged-branch'));
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
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
    expect(mockGetPrsForCommit).toHaveBeenCalledWith('a'.repeat(40), '/workspace/repo', 'upstream');
  });

  test('skips merged branches with uncommitted changes', async () => {
    mergedSweepFinds(worktreeEnv('dirty-branch'));
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
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
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
    mockGetLiveRunOwningEnv.mockResolvedValue({ id: 'run-abc12345-6789', status: 'running' });

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'live-run-branch',
      reason: 'run run-abc1 is running',
    });
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
    {
      pr: prAt('CLOSED'),
      includeClosed: true,
      removed: [],
      skipped: [{ branchName: 'pr-branch', reason: 'no merged PR covers all local tips' }],
    },
    {
      pr: prAt('CLOSED'),
      includeClosed: false,
      removed: [],
      skipped: [{ branchName: 'pr-branch', reason: 'no merged PR covers all local tips' }],
    },
    {
      pr: prAt('OPEN'),
      includeClosed: false,
      removed: [],
      skipped: [{ branchName: 'pr-branch', reason: 'PR is open (active review)' }],
    },
    {
      pr: NO_PR,
      includeClosed: false,
      removed: [],
      skipped: [{ branchName: 'pr-branch', reason: 'no merged PR covers all local tips' }],
    },
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

  // An unhonourable `assistants.*` value stops the sweep before any worktree
  // is inspected or removed.
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

describe('commit-associated PR cleanup', () => {
  beforeEach(() => {
    mergedSweepFinds(worktreeEnv('local-feature'));
    mockWorktreeExists.mockResolvedValue(true);
    mockGetPrsForCommit.mockResolvedValue({
      state: 'FOUND',
      prs: [{ state: 'MERGED', headSha: 'covering-head' }],
    });
  });

  test('an open branch PR does not suppress a covering merged commit PR', async () => {
    mockGetPrState.mockResolvedValue(prAt('OPEN'));
    expect((await cleanupMergedWorktrees('codebase-1', '/workspace/repo')).removed).toEqual([
      'local-feature',
    ]);
  });

  test.each(['NONE', 'OPEN', 'uncovered'] as const)(
    'tries the other distinct tip after %s evidence',
    async first => {
      mockExecFileAsync
        .mockResolvedValueOnce({ stdout: 'a'.repeat(40), stderr: '' })
        .mockResolvedValueOnce({ stdout: 'b'.repeat(40), stderr: '' });
      mockGetPrsForCommit
        .mockResolvedValueOnce(
          first === 'NONE'
            ? { state: 'NONE' }
            : {
                state: 'FOUND',
                prs: [{ state: first === 'OPEN' ? 'OPEN' : 'MERGED', headSha: 'wrong-head' }],
              }
        )
        .mockResolvedValueOnce({
          state: 'FOUND',
          prs: [{ state: 'MERGED', headSha: 'covering-head' }],
        });
      mockIsRevCoveredBy.mockImplementation(async (_path, _rev, head) => head === 'covering-head');
      expect((await cleanupMergedWorktrees('codebase-1', '/workspace/repo')).removed).toEqual([
        'local-feature',
      ]);
      expect(mockGetPrsForCommit.mock.calls.map(call => call[0])).toEqual([
        'a'.repeat(40),
        'b'.repeat(40),
      ]);
    }
  );

  test.each(['branch', 'commit'] as const)(
    'tries later proof after a failed %s candidate comparison',
    async source => {
      if (source === 'branch')
        mockGetPrState.mockResolvedValue({ state: 'MERGED', headSha: 'missing-head' });
      else
        mockGetPrsForCommit.mockResolvedValue({
          state: 'FOUND',
          prs: [
            { state: 'MERGED', headSha: 'missing-head' },
            { state: 'MERGED', headSha: 'covering-head' },
          ],
        });
      mockIsRevCoveredBy.mockImplementation(async (_path, _rev, head) => {
        if (head === 'missing-head') throw new Error('cannot fetch missing head');
        return true;
      });
      const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');
      expect(result.removed).toEqual(['local-feature']);
      expect(result.errors).toEqual([]);
    }
  );

  test('preserves a failed comparison when later candidates do not prove coverage', async () => {
    mockGetPrsForCommit.mockResolvedValue({
      state: 'FOUND',
      prs: [
        { state: 'MERGED', headSha: 'missing-head' },
        { state: 'MERGED', headSha: 'wrong-head' },
      ],
    });
    mockIsRevCoveredBy.mockImplementation(async (_path, _rev, head) => {
      if (head === 'missing-head') throw new Error('cannot fetch missing head');
      return false;
    });
    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([
      { branchName: 'local-feature', error: 'merge check failed: cannot fetch missing head' },
    ]);
    expect(mockIsRevCoveredBy).toHaveBeenCalledWith(
      '/workspace/repo/worktrees/local-feature',
      'HEAD',
      'wrong-head',
      'origin'
    );
  });

  test('tries later candidates, requiring both tips against the same merged head', async () => {
    mockGetPrsForCommit.mockResolvedValue({
      state: 'FOUND',
      prs: [
        { state: 'MERGED', headSha: 'wrong-head' },
        { state: 'MERGED', headSha: 'covering-head' },
      ],
    });
    mockIsRevCoveredBy.mockImplementation(async (_path, _rev, head) => head === 'covering-head');
    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');
    expect(result.removed).toEqual(['local-feature']);
    expect(mockGetPrsForCommit).toHaveBeenCalledWith('a'.repeat(40), '/workspace/repo', 'origin');
    expect(mockIsRevCoveredBy).toHaveBeenCalledWith(
      '/workspace/repo/worktrees/local-feature',
      'HEAD',
      'covering-head',
      'origin'
    );
    expect(mockIsRevCoveredBy).toHaveBeenCalledWith(
      '/workspace/repo',
      'refs/heads/local-feature',
      'covering-head',
      'origin'
    );
  });

  test('never combines coverage from different candidates', async () => {
    mockGetPrsForCommit.mockResolvedValue({
      state: 'FOUND',
      prs: [
        { state: 'MERGED', headSha: 'head-only' },
        { state: 'MERGED', headSha: 'branch-only' },
      ],
    });
    mockIsRevCoveredBy.mockImplementation(
      async (_path, rev, head) => (rev === 'HEAD') === (head === 'head-only')
    );
    expect((await cleanupMergedWorktrees('codebase-1', '/workspace/repo')).removed).toEqual([]);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  test('branch UNAVAILABLE retains precedence', async () => {
    mockGetPrState.mockResolvedValue({ state: 'UNAVAILABLE' });
    expect((await cleanupMergedWorktrees('codebase-1', '/workspace/repo')).removed).toEqual([]);
    expect(mockGetPrsForCommit).not.toHaveBeenCalled();
  });

  test.each(['NONE', 'MERGED', 'CLOSED'] as const)(
    'falls back after an unsettled branch lookup: %s',
    async state => {
      mockGetPrState.mockResolvedValue(state === 'NONE' ? NO_PR : prAt(state));
      mockIsRevCoveredBy.mockImplementation(async (_path, _rev, head) => head === 'covering-head');
      expect((await cleanupMergedWorktrees('codebase-1', '/workspace/repo')).removed).toEqual([
        'local-feature',
      ]);
    }
  );

  test.each([true, false])('resolves the existing tip when branch exists=%s', async refExists => {
    mockLocalBranchExists.mockResolvedValue(refExists);
    if (refExists) mockWorktreeExists.mockResolvedValue(false);
    await cleanupMergedWorktrees('codebase-1', '/workspace/repo');
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      [
        '-C',
        refExists ? '/workspace/repo' : '/workspace/repo/worktrees/local-feature',
        'rev-parse',
        '--verify',
        refExists ? 'refs/heads/local-feature^{commit}' : 'HEAD^{commit}',
      ],
      expect.any(Object)
    );
  });

  test('queries equal tips only once when no candidate covers them', async () => {
    mockIsRevCoveredBy.mockResolvedValue(false);
    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');
    expect(result.removed).toEqual([]);
    expect(mockGetPrsForCommit).toHaveBeenCalledTimes(1);
  });

  test('does not invent a commit when both tips are gone', async () => {
    mockLocalBranchExists.mockResolvedValue(false);
    mockWorktreeExists.mockResolvedValue(false);
    await cleanupMergedWorktrees('codebase-1', '/workspace/repo');
    expect(mockGetPrsForCommit).not.toHaveBeenCalled();
  });

  test.each(['OPEN', 'CLOSED'] as const)(
    'associated %s alone never grants removal, even with includeClosed',
    async state => {
      mockGetPrsForCommit.mockResolvedValue({
        state: 'FOUND',
        prs: [{ state, headSha: 'covering-head' }],
      });
      const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo', {
        includeClosed: true,
      });
      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toBe(
        state === 'OPEN' ? 'PR is open (active review)' : 'no merged PR covers all local tips'
      );
    }
  );

  test('reports unavailable commit lookup', async () => {
    mockGetPrsForCommit.mockResolvedValue({ state: 'UNAVAILABLE' });
    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');
    expect(result.skipped).toEqual([
      { branchName: 'local-feature', reason: 'PR state lookup failed — merge state unverifiable' },
    ]);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  test.each(['resolution', 'coverage'] as const)(
    'reports failed %s without removal',
    async failure => {
      if (failure === 'resolution')
        mockExecFileAsync.mockRejectedValue(new Error('cannot inspect'));
      else mockIsRevCoveredBy.mockRejectedValue(new Error('cannot inspect'));
      const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');
      expect(result.errors).toEqual([
        { branchName: 'local-feature', error: 'merge check failed: cannot inspect' },
      ]);
      expect(mockDestroy).not.toHaveBeenCalled();
    }
  );
});

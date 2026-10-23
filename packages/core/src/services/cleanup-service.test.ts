// @archon-test-isolated
import { clearPlatformPolicies } from '../platforms/registry';
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { toRepoPath } from '@archon/git';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import type { Conversation } from '../types';
import type * as Git from '@archon/git';
import {
  runScheduledCleanup,
  startCleanupScheduler,
  getWorktreeStatusBreakdown,
  cleanupStaleWorktrees,
  onConversationClosed,
  cleanupContainerEnvironments,
  SESSION_RETENTION_DAYS,
} from './cleanup-service';
import { cleanupMergedWorktrees } from './cleanup/merged-sweep';
import { removeEnvironment } from './cleanup/remove-environment';
import {
  RETAINING_PLATFORM,
  UNKNOWN_PLATFORM,
  UNKNOWN_PLATFORM_REASON,
  daysAgo,
  NO_PR,
  PR_HEAD_SHA,
  prAt,
  makeEnvironment,
  makeConversation,
  type EnvironmentWithCodebase,
  makeEnvironmentWithCodebase,
  sweptWorktreeEnv,
  makeEnvironmentWithAge,
  makeContainerEnvironment,
  mockLogger,
  mockHasUncommittedChanges,
  mockWorktreeExists,
  mockGetDefaultBranch,
  mockIsBranchMerged,
  mockIsPatchEquivalent,
  mockLocalBranchExists,
  mockGetLastCommitDate,
  mockIsRevCoveredBy,
  mockCountCommitsMissingFromRemotes,
  mockDestroy,
  mockGetPrState,
  mockContainerDestroy,
  mockListAllActiveWithCodebase,
  mockMarkWorktreeDestroyed,
  mockGetLiveRunOwningEnv,
  mockGetById,
  mockListByCodebase,
  mockListByCodebaseWithAge,
  mockListActiveContainerEnvironments,
  mockGetConversationByPlatformId,
  mockUpdateConversation,
  mockGetActiveSession,
  mockDeactivateSession,
  mockDeleteOldSessions,
  mockLoadRepoConfig,
  storeHolds,
  scheduledSweepFinds,
  selectedEnvironment,
  resetCleanupMocks,
} from './cleanup/test-harness';

beforeEach(resetCleanupMocks);

describe('cleanupContainerEnvironments', () => {
  const oldRow = makeContainerEnvironment({
    codebase_name: 'ops',
    working_path: '/tmp/ops',
    days_since_created: 30,
  });
  beforeEach(() => {
    mockListActiveContainerEnvironments.mockResolvedValue([oldRow]);
  });

  test('does NOT destroy when the run lookup throws — reports the error instead', async () => {
    mockGetLiveRunOwningEnv.mockRejectedValue(new Error('DB down'));

    const report = await cleanupContainerEnvironments(7);
    expect(mockContainerDestroy).not.toHaveBeenCalled();
    expect(report.removed).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.error).toMatch(/lookup failed/);
  });

  // The reaper reads the same lock the worktree sweeps use, so a failed run's
  // container survives for `--resume` exactly as a paused one does.
  test.each(['paused', 'failed'])('never reaps the container of a %s run', async status => {
    mockGetLiveRunOwningEnv.mockResolvedValue({ id: 'run-1', status });
    const report = await cleanupContainerEnvironments(7);
    expect(mockContainerDestroy).not.toHaveBeenCalled();
    expect(report.skipped).toEqual([{ id: oldRow.id, reason: `run run-1 is ${status}` }]);
  });

  test('reaps a container no run can claim, older than the threshold', async () => {
    const report = await cleanupContainerEnvironments(7);
    expect(mockContainerDestroy).toHaveBeenCalledTimes(1);
    expect(report.removed).toEqual([oldRow.id]);
  });

  test('reports a failed destroy instead of claiming removal', async () => {
    mockContainerDestroy.mockRejectedValueOnce(new Error('status write failed'));

    expect(await cleanupContainerEnvironments(7)).toEqual({
      removed: [],
      skipped: [],
      errors: [{ id: oldRow.id, error: 'status write failed' }],
    });
  });

  test('keeps an old container whose registered platform retains workspaces', async () => {
    mockListActiveContainerEnvironments.mockResolvedValue([
      { ...oldRow, created_by_platform: RETAINING_PLATFORM },
    ]);

    const report = await cleanupContainerEnvironments(7);

    expect(report).toEqual({
      removed: [],
      skipped: [{ id: oldRow.id, reason: `platform '${RETAINING_PLATFORM}' retains workspaces` }],
      errors: [],
    });
    expect(mockGetLiveRunOwningEnv).not.toHaveBeenCalled();
    expect(mockContainerDestroy).not.toHaveBeenCalled();
  });
});

describe('runScheduledCleanup', () => {
  test.each([false, true])('skips container branch checks (path exists: %s)', async pathExists => {
    mockWorktreeExists.mockResolvedValue(pathExists);
    mockListAllActiveWithCodebase.mockResolvedValue([
      makeEnvironmentWithCodebase({
        provider: 'container',
        branch_name: '',
        codebase_repository_url: null,
      }),
    ]);
    await runScheduledCleanup();
    expect(mockWorktreeExists).not.toHaveBeenCalled();
    expect(mockGetPrState).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  test('returns empty report when no environments exist', async () => {
    expect(await runScheduledCleanup()).toEqual({
      removed: [],
      skipped: [],
      errors: [],
      sessionsDeleted: 0,
      releasedFailedRuns: [],
    });
  });

  test.each(['github', RETAINING_PLATFORM])(
    'marks missing paths as destroyed and cleans up branch (%s)',
    async platformId => {
      scheduledSweepFinds(
        makeEnvironmentWithCodebase({
          id: 'env-123',
          working_path: '/nonexistent/path',
          branch_name: 'issue-42',
          created_by_platform: platformId,
          metadata: { worktree_branch_created: true },
        })
      );

      const report = await runScheduledCleanup();

      expect(report.removed).toContain('env-123 (path missing)');
      expect(mockDestroy).toHaveBeenCalledWith('/nonexistent/path', {
        force: false,
        branchName: 'issue-42',
        canonicalRepoPath: '/workspace/repo',
      });
      expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'env-123' })
      );
    }
  );

  test.each(['github', RETAINING_PLATFORM])(
    'removes merged branches while retaining remote refs (%s)',
    async platformId => {
      scheduledSweepFinds(sweptWorktreeEnv('pr-99', { created_by_platform: platformId }));
      mockWorktreeExists.mockResolvedValue(true);
      mockIsBranchMerged.mockResolvedValue(true);

      const report = await runScheduledCleanup();

      expect(report.removed).toContain('env-pr-99 (merged)');
      expect(mockDestroy).toHaveBeenCalledWith('/workspace/repo/worktrees/pr-99', {
        force: false,
        branchName: 'pr-99',
        canonicalRepoPath: '/workspace/repo',
      });
      expect(mockDestroy).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ deleteRemoteBranch: true })
      );
    }
  );

  test.each(
    (['path missing', 'merged', 'stale'] as const).flatMap(sweep =>
      (['worktreeRemoved', 'directoryClean'] as const).map(failure => ({ sweep, failure }))
    )
  )(
    'scheduled $sweep cleanup reports incomplete $failure and continues',
    async ({ sweep, failure }) => {
      scheduledSweepFinds(
        ...['broken', 'later'].map(branch => sweptWorktreeEnv(branch, { created_at: daysAgo(30) }))
      );
      mockWorktreeExists.mockResolvedValue(sweep !== 'path missing');
      mockIsBranchMerged.mockResolvedValue(sweep === 'merged');
      mockDestroy.mockResolvedValueOnce({
        worktreeRemoved: true,
        directoryClean: true,
        branchDeleted: null,
        remoteBranchDeleted: null,
        warnings: [],
        [failure]: false,
      });

      const report = await runScheduledCleanup();

      expect(report.errors).toEqual([
        { id: 'env-broken', error: 'filesystem removal incomplete; environment remains active' },
      ]);
      expect(report.skipped).toEqual([]);
      expect(report.removed).toEqual([`env-later (${sweep})`]);
      expect(report.releasedFailedRuns).toEqual([]);
      expect(mockMarkWorktreeDestroyed).toHaveBeenCalledTimes(1);
      expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'env-later' })
      );
    }
  );

  test('skips merged branches with uncommitted changes', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('issue-10'));
    mockWorktreeExists.mockResolvedValue(true);
    mockIsBranchMerged.mockResolvedValue(true);
    mockHasUncommittedChanges.mockResolvedValue(true);

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-issue-10',
      reason: 'merged but has uncommitted changes',
    });
    expect(report.removed).toHaveLength(0);
  });

  test('reports a status failure as an error rather than a dirty skip', async () => {
    scheduledSweepFinds(makeEnvironmentWithCodebase());
    mockWorktreeExists.mockResolvedValue(true);
    mockIsBranchMerged.mockResolvedValue(true);
    mockHasUncommittedChanges.mockRejectedValueOnce(new Error('status unavailable'));

    const report = await runScheduledCleanup();

    expect(report.errors).toEqual([{ id: 'env-1', error: 'status unavailable' }]);
    expect(report.skipped).toEqual([]);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  test('skips merged branches with a live owning run and a live-run reason', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('issue-11'));
    mockWorktreeExists.mockResolvedValue(true);
    mockIsBranchMerged.mockResolvedValue(true);
    mockGetLiveRunOwningEnv.mockResolvedValue({ id: 'run-live-1', status: 'paused' });

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-issue-11',
      reason: 'merged but run run-live is paused',
    });
    expect(report.removed).toHaveLength(0);
  });

  test('skips path-missing environments owned by a live run', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('issue-13'));
    mockGetLiveRunOwningEnv.mockResolvedValue({ id: 'run-missing-live', status: 'paused' });

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-issue-13',
      reason: 'path missing but run run-miss is paused',
    });
    expect(report.removed).toHaveLength(0);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  test('scheduled cleanup retains a declared adapter and removes an age-based control', async () => {
    const retained = makeEnvironmentWithCodebase({
      id: 'retained',
      created_by_platform: RETAINING_PLATFORM,
      created_at: daysAgo(30),
    });
    const ageBased = makeEnvironmentWithCodebase({
      id: 'age-based',
      created_by_platform: 'new-forge',
      created_at: daysAgo(30),
    });
    scheduledSweepFinds(retained, ageBased);
    mockWorktreeExists.mockResolvedValue(true);

    const report = await runScheduledCleanup();

    expect(report.removed).toEqual(['age-based (stale)']);
    expect(report.errors).toEqual([]);
    expect(mockMarkWorktreeDestroyed).toHaveBeenCalledTimes(1);
    expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'age-based' })
    );
  });

  test('scheduled cleanup without configured platform policies fails and deletes nothing', async () => {
    clearPlatformPolicies();
    scheduledSweepFinds(
      makeEnvironmentWithCodebase({ created_by_platform: 'telegram', created_at: daysAgo(30) })
    );

    await expect(runScheduledCleanup()).rejects.toThrow('Platform policies are not configured');
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(mockDeleteOldSessions).not.toHaveBeenCalled();
  });

  test('continues processing after error on one environment', async () => {
    scheduledSweepFinds(
      makeEnvironmentWithCodebase({ id: 'env-error', working_path: '/bad/path' }),
      sweptWorktreeEnv('pr-1')
    );
    mockDestroy.mockRejectedValueOnce(new Error('destroy failed'));

    const report = await runScheduledCleanup();

    expect(report.errors).toEqual([{ id: 'env-error', error: 'destroy failed' }]);
    expect(report.removed).toEqual(['env-pr-1 (path missing)']);
  });

  test('deletes old sessions during scheduled cleanup', async () => {
    mockDeleteOldSessions.mockResolvedValue(5);

    const report = await runScheduledCleanup();

    expect(mockDeleteOldSessions).toHaveBeenCalledWith(SESSION_RETENTION_DAYS);
    expect(report.sessionsDeleted).toBe(5);
  });

  test('records error when session cleanup fails', async () => {
    mockDeleteOldSessions.mockRejectedValue(new Error('database locked'));

    const report = await runScheduledCleanup();

    expect(report.sessionsDeleted).toBe(0);
    expect(report.errors).toContainEqual({
      id: 'session-cleanup',
      error: 'database locked',
    });
  });

  test('detects squash-merged branches via isPatchEquivalent fallback', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('squash-branch'));
    mockWorktreeExists.mockResolvedValue(true);
    mockIsPatchEquivalent.mockResolvedValueOnce(true);

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-squash-branch (merged)');
    expect(mockIsPatchEquivalent).toHaveBeenCalledWith(
      '/workspace/repo',
      'squash-branch',
      'origin/main'
    );
  });

  // A squash merge of more than one commit leaves no patch-equivalent commit for
  // `git cherry` to find, so the PR's state is the only signal that sees it (#3471).
  test('removes a multi-commit squash-merged branch via PR state', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('multi-squash'));
    mockWorktreeExists.mockResolvedValue(true);
    mockIsPatchEquivalent.mockResolvedValue(false);
    mockGetPrState.mockResolvedValue(prAt('MERGED'));

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-multi-squash (merged)');
    expect(mockGetPrState).toHaveBeenCalledWith(
      'multi-squash',
      '/workspace/repo',
      expect.any(Map),
      'origin'
    );
    // Both local tips removal would delete are checked against the PR head.
    expect(mockIsRevCoveredBy).toHaveBeenCalledWith(
      '/workspace/repo/worktrees/multi-squash',
      'HEAD',
      PR_HEAD_SHA,
      'origin'
    );
    expect(mockIsRevCoveredBy).toHaveBeenCalledWith(
      '/workspace/repo',
      'refs/heads/multi-squash',
      PR_HEAD_SHA,
      'origin'
    );
  });

  // Run branch names come from the run identifier, so a re-run reuses the name of a
  // branch whose earlier PR already merged. The merged PR does not cover commits the
  // branch gained after its head, and nothing else holds that work.
  test('keeps a branch whose name matches a merged PR but whose tip is past the PR head', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('reused-name'));
    mockWorktreeExists.mockResolvedValue(true);
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
    // The worktree sits at the PR head; the branch ref has moved past it.
    mockIsRevCoveredBy.mockImplementation((_path, rev) => Promise.resolve(rev === 'HEAD'));

    const report = await runScheduledCleanup();

    expect(report.removed).toHaveLength(0);
    // removeEnvironment's first step: the sweep never tried to remove it.
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockIsRevCoveredBy).toHaveBeenCalledWith(
      '/workspace/repo',
      'refs/heads/reused-name',
      PR_HEAD_SHA,
      'origin'
    );
  });

  // Cleanup deletes the worktree, and a worktree keeps its HEAD after the branch ref
  // is gone: a detached HEAD, or a branch renamed inside the worktree, can hold
  // committed work past the old PR head that no ref protects.
  test('keeps a worktree whose branch ref is gone but whose HEAD is past the merged PR head', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('detached'));
    mockWorktreeExists.mockResolvedValue(true);
    mockLocalBranchExists.mockResolvedValue(false);
    mockGetPrState.mockResolvedValue(prAt('MERGED'));
    mockIsRevCoveredBy.mockImplementation((_path, rev) => Promise.resolve(rev !== 'HEAD'));

    const report = await runScheduledCleanup();

    expect(report.removed).toHaveLength(0);
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockIsRevCoveredBy).toHaveBeenCalledWith(
      '/workspace/repo/worktrees/detached',
      'HEAD',
      PR_HEAD_SHA,
      'origin'
    );
  });

  // A PR lookup that failed says nothing about the branch; it must not let the
  // environment through to the staleness sweep as if it were settled unmerged work.
  test('reports and keeps an environment whose PR lookup failed', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('pr-unavailable'));
    mockWorktreeExists.mockResolvedValue(true);
    mockGetPrState.mockResolvedValue({ state: 'UNAVAILABLE' });

    const report = await runScheduledCleanup();

    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toEqual([
      { id: 'env-pr-unavailable', reason: 'PR state lookup failed — merge state unverifiable' },
    ]);
    // The staleness sweep reads the last commit date; it never got that far.
    expect(mockGetLastCommitDate).not.toHaveBeenCalled();
  });

  // The worktree outlives its local branch ref (deleted after the merge, or created in
  // another repository). Both git signals need that ref, so the PR judges alone (#3471).
  test('removes an environment whose branch ref is gone but whose PR is merged', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('ref-gone-merged'));
    mockWorktreeExists.mockResolvedValue(true);
    mockLocalBranchExists.mockResolvedValue(false);
    mockGetPrState.mockResolvedValue(prAt('MERGED'));

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-ref-gone-merged (merged)');
    // Asking git about a ref that is gone is what produced "unknown commit" before.
    expect(mockIsBranchMerged).not.toHaveBeenCalled();
    expect(mockIsPatchEquivalent).not.toHaveBeenCalled();
    // The branch ref is gone, so the worktree's HEAD is the only local tip to check.
    expect(mockIsRevCoveredBy).toHaveBeenCalledTimes(1);
    expect(mockIsRevCoveredBy).toHaveBeenCalledWith(
      '/workspace/repo/worktrees/ref-gone-merged',
      'HEAD',
      PR_HEAD_SHA,
      'origin'
    );
  });

  test('keeps a recent environment that no signal calls merged', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('no-signal'));
    mockWorktreeExists.mockResolvedValue(true);

    const report = await runScheduledCleanup();

    expect(report.removed).toHaveLength(0);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  // A merge check that never resolved is not an answer. Letting it reach the staleness
  // sweep would delete an old branch on age alone, which no signal called unmerged.
  test('reports the environment and skips the staleness sweep when the merge check throws', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('unreadable', { created_at: daysAgo(30) }));
    mockWorktreeExists.mockResolvedValue(true);
    mockLocalBranchExists.mockRejectedValue(new Error('repository is unreadable'));

    const report = await runScheduledCleanup();

    expect(report.errors).toContainEqual({
      id: 'env-unreadable',
      error: 'repository is unreadable',
    });
    expect(report.removed).toHaveLength(0);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  // An open PR is active work. Age must not decide it, and the operator needs to see why
  // the worktree stayed.
  test('reports and keeps a stale environment whose PR is open', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('stale-open-pr', { created_at: daysAgo(30) }));
    mockWorktreeExists.mockResolvedValue(true);
    mockGetPrState.mockResolvedValue(prAt('OPEN'));

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-stale-open-pr',
      reason: 'PR is open (active review)',
    });
    expect(report.removed).toHaveLength(0);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  test('reports and keeps a stale environment whose merge state is unverifiable', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('stale-unjudgeable', { created_at: daysAgo(30) }));
    mockWorktreeExists.mockResolvedValue(true);
    mockLocalBranchExists.mockResolvedValue(false);

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-stale-unjudgeable',
      reason: 'branch ref is gone and no PR was found — merge state unverifiable',
    });
    expect(report.removed).toHaveLength(0);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  test('still stale-sweeps an environment git confirms is unmerged', async () => {
    scheduledSweepFinds(sweptWorktreeEnv('stale-unmerged', { created_at: daysAgo(30) }));
    mockWorktreeExists.mockResolvedValue(true);

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-stale-unmerged (stale)');
  });

  // #1419: a configured worktree.baseBranch replaces default-branch detection.
  const detection: Parameters<typeof Git.getDefaultBranch>[] = [
    [toRepoPath('/workspace/myrepo'), 'origin'],
  ];
  test.each<[string | undefined, string, Parameters<typeof Git.getDefaultBranch>[]]>([
    ['master', 'origin/master', []],
    ['  develop  ', 'origin/develop', []],
    [undefined, 'origin/main', detection],
    ['   ', 'origin/main', detection],
  ])('worktree.baseBranch %p compares against %s', async (baseBranch, baseRef, detected) => {
    mockLoadRepoConfig.mockResolvedValue({ worktree: { baseBranch } });
    scheduledSweepFinds(
      makeEnvironmentWithCodebase({
        branch_name: 'feature/foo',
        codebase_default_cwd: '/workspace/myrepo',
      })
    );
    mockWorktreeExists.mockResolvedValue(true);

    const report = await runScheduledCleanup();

    expect(report.errors).toEqual([]);
    expect(mockGetDefaultBranch.mock.calls).toEqual(detected);
    expect(mockIsBranchMerged).toHaveBeenCalledWith('/workspace/myrepo', 'feature/foo', baseRef);
  });
});

describe('cleanup environment configuration', () => {
  const variables = [
    'STALE_THRESHOLD_DAYS',
    'CLEANUP_INTERVAL_HOURS',
    'SESSION_RETENTION_DAYS',
  ] as const;
  let savedEnv: NodeJS.ProcessEnv;
  let importId = 0;

  function loadCleanupService(): Promise<typeof import('./cleanup-service')> {
    return import(`./cleanup-service.ts?configuration-test=${importId++}`);
  }

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const name of variables) delete process.env[name];
  });

  afterEach(() => {
    for (const name of variables) {
      const value = savedEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  for (const name of variables) {
    test.each([
      'abc',
      '0',
      '-1',
      '1.5',
      '',
      ' ',
      '12days',
      'Infinity',
      '9007199254740993',
      '0.99999999999999999',
      '1.0000000000000001',
    ])(`${name} rejects %j during module initialization`, async value => {
      process.env[name] = value;
      await expect(loadCleanupService()).rejects.toThrow(
        `${name} must be a positive integer; received ${JSON.stringify(value)}`
      );
    });
  }

  test('rejects an interval beyond the runtime timer limit at startup', async () => {
    process.env.CLEANUP_INTERVAL_HOURS = '597';
    await expect(loadCleanupService()).rejects.toThrow(
      'CLEANUP_INTERVAL_HOURS must be a positive integer; received "597"'
    );
  });

  test('preserves a 20-day worktree with a configured 21-day stale threshold', async () => {
    process.env.STALE_THRESHOLD_DAYS = '21';
    const service = await loadCleanupService();
    const env = makeEnvironmentWithAge({
      branch_name: 'twenty-day-branch',
      created_by_platform: 'slack',
      days_since_activity: 20,
    });
    mockListByCodebaseWithAge.mockResolvedValue([env]);
    storeHolds([env]);
    mockWorktreeExists.mockResolvedValue(true);

    const result = await service.cleanupStaleWorktrees(env.codebase_id, '/workspace/repo');

    expect(result).toEqual({
      errors: [],
      removed: [],
      skipped: [],
      warnings: [],
      releasedFailedRuns: [],
    });
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  test.each([
    { values: undefined, staleDays: 14, intervalHours: 6, retentionDays: 30 },
    { values: ['1', '2', '3'], staleDays: 1, intervalHours: 2, retentionDays: 3 },
    { values: ['21', '12', '60'], staleDays: 21, intervalHours: 12, retentionDays: 60 },
    { values: ['14', '596', '30'], staleDays: 14, intervalHours: 596, retentionDays: 30 },
  ])('uses defaults or configured positive integers: %j', async configuration => {
    for (const [index, name] of variables.entries()) {
      const value = configuration.values?.[index];
      if (value !== undefined) process.env[name] = value;
    }
    const service = await loadCleanupService();
    // Configuration is read once, at module initialization.
    for (const name of variables) process.env[name] = 'abc';
    expect(service.STALE_THRESHOLD_DAYS).toBe(configuration.staleDays);
    expect(service.SESSION_RETENTION_DAYS).toBe(configuration.retentionDays);

    await service.runScheduledCleanup();
    expect(mockDeleteOldSessions).toHaveBeenCalledWith(configuration.retentionDays);
    const interval = spyOn(globalThis, 'setInterval');
    try {
      service.startCleanupScheduler();
      expect(interval.mock.calls.at(-1)?.[1]).toBe(configuration.intervalHours * 60 * 60 * 1000);
    } finally {
      service.stopCleanupScheduler();
      interval.mockRestore();
    }
  });
});

describe('startCleanupScheduler', () => {
  test('refuses to start without configured platform policies', () => {
    clearPlatformPolicies();
    expect(() => startCleanupScheduler()).toThrow('Platform policies are not configured');
    expect(mockListAllActiveWithCodebase).not.toHaveBeenCalled();
  });
});

describe('getWorktreeStatusBreakdown', () => {
  test('returns correct breakdown with mixed environments', async () => {
    mockListByCodebaseWithAge.mockResolvedValue([
      makeEnvironmentWithAge({
        id: 'env-1',
        branch_name: 'merged-branch',
        created_by_platform: 'github',
        days_since_activity: 5,
      }),
      makeEnvironmentWithAge({
        id: 'env-2',
        branch_name: 'stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
      }),
      makeEnvironmentWithAge({
        id: 'env-3',
        branch_name: 'active-branch',
        created_by_platform: 'github',
        days_since_activity: 2,
      }),
      makeEnvironmentWithAge({
        id: 'env-4',
        branch_name: 'retained-branch',
        created_by_platform: RETAINING_PLATFORM,
        days_since_activity: 60,
      }),
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(true);

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.total).toBe(4);
    expect(mockIsPatchEquivalent).toHaveBeenCalledTimes(3);
    expect(breakdown.merged).toBe(1);
    // No worktree.remote configured — default-branch detection gets
    // 'origin' (the remote default).
    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/workspace/repo', 'origin');
    // env-4 is old but its platform retains workspaces, so it counts as active, not stale.
    expect(breakdown.stale).toBe(1);
    expect(breakdown.active).toBe(2);
    expect(breakdown.inspectionFailedEnvs).toEqual([]);
    expect(breakdown.staleEnvs).toEqual([
      {
        id: 'env-2',
        branchName: 'stale-branch',
        daysInactive: 30,
      },
    ]);
    // Verify the remote-qualified ref is threaded through to isBranchMerged.
    expect(mockIsBranchMerged).toHaveBeenCalledWith(
      '/workspace/repo',
      'merged-branch',
      'origin/main'
    );
  });

  test.each([2, 30])(
    'reports both merge inspection failures for a %s-day-old worktree',
    async daysInactive => {
      mockListByCodebaseWithAge.mockResolvedValue([
        makeEnvironmentWithAge({
          branch_name: 'unknown-branch',
          days_since_activity: daysInactive,
        }),
      ]);
      mockIsBranchMerged.mockRejectedValueOnce(new Error('ancestry unavailable'));
      mockIsPatchEquivalent.mockRejectedValueOnce(new Error('patch comparison unavailable'));

      const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

      expect(breakdown.stale).toBe(0);
      expect(breakdown.staleEnvs).toEqual([]);
      expect(breakdown.active).toBe(0);
      expect(breakdown.activeEnvs).toEqual([]);
      expect(breakdown.merged).toBe(0);
      expect(breakdown.inspectionFailedEnvs).toEqual([
        {
          id: 'env-1',
          branchName: 'unknown-branch',
          errors: [
            'Ancestry: ancestry unavailable',
            'Patch equivalence: patch comparison unavailable',
          ],
        },
      ]);
    }
  );

  test.each(['ancestry', 'patch'])(
    'reports incomplete inspection when only %s fails',
    async check => {
      mockListByCodebaseWithAge.mockResolvedValue([
        makeEnvironmentWithAge({ days_since_activity: 30 }),
      ]);
      if (check === 'ancestry') mockIsBranchMerged.mockRejectedValueOnce(new Error('unavailable'));
      else mockIsPatchEquivalent.mockRejectedValueOnce('unavailable');

      const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

      expect(breakdown.staleEnvs).toEqual([]);
      expect(breakdown.inspectionFailedEnvs).toEqual([
        {
          id: 'env-1',
          branchName: 'task-1',
          errors: [
            check === 'ancestry' ? 'Ancestry: unavailable' : 'Patch equivalence: unavailable',
          ],
        },
      ]);
    }
  );

  test('reports an empty codebase against the default branch of the configured worktree.remote', async () => {
    mockLoadRepoConfig.mockResolvedValue({ worktree: { remote: 'upstream' } });

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/workspace/repo', 'upstream');
    expect(breakdown).toEqual({
      total: 0,
      merged: 0,
      stale: 0,
      active: 0,
      mergedEnvs: [],
      staleEnvs: [],
      activeEnvs: [],
      inspectionFailedEnvs: [],
    });
  });

  test.each([false, true])('detects squash merges when ancestry fails=%s', async ancestryFails => {
    mockListByCodebaseWithAge.mockResolvedValue([
      makeEnvironmentWithAge({ branch_name: 'squash-branch', days_since_activity: 5 }),
    ]);
    if (ancestryFails) mockIsBranchMerged.mockRejectedValueOnce(new Error('ancestry unavailable'));
    mockIsPatchEquivalent.mockResolvedValueOnce(true);

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.merged).toBe(1);
    expect(breakdown.inspectionFailedEnvs).toEqual([]);
    expect(mockIsPatchEquivalent).toHaveBeenCalledWith(
      '/workspace/repo',
      'squash-branch',
      'origin/main',
      { throwOnExpectedError: true }
    );
  });

  // loadRepoConfig throws when `assistants.*` names a setting the provider
  // cannot honour (#2582). Cleanup must surface that rather than carrying on
  // with git detection — catching it here would restore the silent drop this
  // validation exists to close.
  test('surfaces an invalid assistants config instead of falling back to git detection', async () => {
    mockListByCodebaseWithAge.mockResolvedValue([makeEnvironmentWithAge()]);
    mockLoadRepoConfig.mockRejectedValue(
      new Error(
        "Invalid assistants config in '/workspace/repo/.archon/config.yaml': " +
          "'assistants.claude.settingSources.0': expected 'project' or 'user'."
      )
    );

    await expect(getWorktreeStatusBreakdown('codebase-1', '/workspace/repo')).rejects.toThrow(
      /assistants\.claude\.settingSources\.0/
    );
    expect(mockGetDefaultBranch).not.toHaveBeenCalled();
  });
});

describe('onConversationClosed', () => {
  function conversationUses(
    env: IsolationEnvironmentRow,
    conversation: Partial<Conversation> = {}
  ): void {
    mockGetConversationByPlatformId.mockResolvedValue(
      makeConversation({ isolation_env_id: env.id, ...conversation })
    );
    mockGetById.mockResolvedValue(env);
  }

  test('keeps an uninstalled platform workspace and its conversation reference', async () => {
    const env = makeEnvironment({ created_by_platform: UNKNOWN_PLATFORM });
    conversationUses(env, { cwd: env.working_path });

    await onConversationClosed(UNKNOWN_PLATFORM, 'thread-1', { merged: true });

    expect(mockUpdateConversation).not.toHaveBeenCalled();
    expect(mockGetLiveRunOwningEnv).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockContainerDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { envId: env.id, reason: UNKNOWN_PLATFORM_REASON },
      'cleanup_skipped'
    );
  });

  test('deactivates session with conversation-closed reason', async () => {
    conversationUses(makeEnvironment());
    mockGetActiveSession.mockResolvedValue({
      id: 'session-to-close',
      conversation_id: 'conv-1',
      codebase_id: null,
      ai_assistant_type: 'claude',
      assistant_session_id: null,
      active: true,
      metadata: {},
      started_at: new Date(),
      ended_at: null,
      parent_session_id: null,
      transition_reason: null,
      ended_reason: null,
    });

    await onConversationClosed('github', 'owner/repo#200');

    expect(mockDeactivateSession).toHaveBeenCalledWith('session-to-close', 'conversation-closed');
  });

  test.each([
    {
      label: 'merged',
      options: { merged: true },
      metadata: {},
    },
    {
      label: 'not merged',
      options: undefined,
      metadata: { worktree_branch_created: true },
    },
  ])(
    'retains the remote branch when the conversation closes ($label)',
    async ({ options, metadata }) => {
      conversationUses(
        makeEnvironment({
          working_path: '/workspace/worktrees/pr-100',
          branch_name: 'feature-x',
          metadata,
        })
      );

      await onConversationClosed('github', 'owner/repo#100', options);
      expect(mockDestroy).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ deleteRemoteBranch: true })
      );

      expect(mockDestroy).toHaveBeenCalledWith('/workspace/worktrees/pr-100', {
        force: false,
        branchName: 'feature-x',
        canonicalRepoPath: '/workspace/repo',
      });
    }
  );

  // Leaving cwd set would strand the conversation on a deleted directory; a cwd
  // pointing elsewhere is the conversation's own choice.
  test.each([
    { cwd: '/workspace/worktrees/pr-300', update: { isolation_env_id: null, cwd: null } },
    { cwd: '/somewhere/else', update: { isolation_env_id: null } },
  ])(
    'clears the env reference, and cwd only when it is the env ($cwd)',
    async ({ cwd, update }) => {
      conversationUses(makeEnvironment({ working_path: '/workspace/worktrees/pr-300' }), { cwd });

      await onConversationClosed('github', 'owner/repo#300');

      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-1', update);
    }
  );

  test('a live owning run keeps the env AND the conversation reference intact', async () => {
    const env = makeEnvironment({ working_path: '/workspace/worktrees/pr-400' });
    conversationUses(env, { cwd: env.working_path });
    mockGetLiveRunOwningEnv.mockResolvedValue({ id: 'run-live', status: 'paused' });

    await onConversationClosed('github', 'owner/repo#400');

    expect(mockDestroy).not.toHaveBeenCalled();
    // The null-out runs only AFTER the live-run check: a top-level run attaches
    // to its env solely through this reference, so clearing before checking
    // would erase the pin and let the env be removed under a live run.
    expect(mockUpdateConversation).not.toHaveBeenCalled();
  });
});

describe('cleanupStaleWorktrees', () => {
  function staleWorktree(
    overrides: Partial<IsolationEnvironmentRow & { days_since_activity: number }> = {}
  ): IsolationEnvironmentRow & { days_since_activity: number } {
    const env = makeEnvironmentWithAge({
      branch_name: 'stale-branch',
      created_by_platform: 'slack',
      days_since_activity: 30,
      ...overrides,
    });
    mockListByCodebaseWithAge.mockResolvedValue([env]);
    storeHolds([env]);
    return env;
  }

  test.each(['web', 'cli', null])(
    'removes a stale worktree of registered surface %s (including legacy null)',
    async platformId => {
      const env = staleWorktree({ created_by_platform: platformId, days_since_activity: 100 });

      const report = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

      expect(report.removed).toEqual([env.branch_name]);
      expect(report.skipped).toEqual([]);
      expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
        expect.objectContaining({ id: env.id })
      );
    }
  );

  test('preserves provider warnings for a removed stale worktree', async () => {
    const env = staleWorktree({ created_by_platform: 'web', days_since_activity: 100 });
    mockDestroy.mockResolvedValueOnce({
      worktreeRemoved: true,
      directoryClean: true,
      branchDeleted: false,
      remoteBranchDeleted: null,
      warnings: ['Local branch retained'],
    });
    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');
    expect(result.removed).toEqual([env.branch_name]);
    expect(result.warnings).toEqual([
      { branchName: env.branch_name, message: 'Local branch retained' },
    ]);
  });

  test('skips retain-policy worktrees even if old', async () => {
    staleWorktree({ created_by_platform: RETAINING_PLATFORM, days_since_activity: 100 });

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips worktrees that are not stale', async () => {
    staleWorktree({ days_since_activity: 5 });

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips stale worktrees with uncommitted changes', async () => {
    staleWorktree();
    mockWorktreeExists.mockResolvedValue(true);
    mockHasUncommittedChanges.mockResolvedValue(true);

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'stale-branch',
      reason: 'has uncommitted changes',
    });
  });

  test('skips stale worktrees owned by a live run', async () => {
    staleWorktree();
    mockGetLiveRunOwningEnv.mockResolvedValue({ id: 'run-live-stale', status: 'paused' });

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'stale-branch',
      reason: 'run run-live is paused',
    });
    expect(mockGetById).not.toHaveBeenCalled();
  });
});

describe('cleanup after a chat plugin is removed', () => {
  beforeEach(() => {
    mockIsBranchMerged.mockResolvedValue(true);
  });

  test.each([true, false])(
    'scheduled cleanup keeps unknown workspaces even when path exists=%s',
    async exists => {
      mockWorktreeExists.mockResolvedValue(exists);
      mockListAllActiveWithCodebase.mockResolvedValue([
        makeEnvironmentWithCodebase({
          created_by_platform: UNKNOWN_PLATFORM,
          created_at: new Date(0),
        }),
      ]);
      const report = await runScheduledCleanup();
      expect(report.skipped).toEqual([{ id: 'env-1', reason: UNKNOWN_PLATFORM_REASON }]);
      expect(report.removed).toEqual([]);
      expect(report.errors).toEqual([]);
      expect(mockWorktreeExists).not.toHaveBeenCalled();
      expect(mockDestroy).not.toHaveBeenCalled();
      expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    }
  );

  test('stale and merged sweeps report unknown workspaces and the breakdown keeps them active', async () => {
    const env = makeEnvironmentWithAge({
      created_by_platform: UNKNOWN_PLATFORM,
      days_since_activity: 100,
    });
    mockListByCodebaseWithAge.mockResolvedValue([env]);
    mockListByCodebase.mockResolvedValue([env]);
    const reason = UNKNOWN_PLATFORM_REASON;
    const stale = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');
    const merged = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');
    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');
    expect(stale).toEqual({
      errors: [],
      removed: [],
      warnings: [],
      skipped: [{ branchName: env.branch_name, reason }],
      releasedFailedRuns: [],
    });
    expect(merged.skipped).toEqual(stale.skipped);
    expect(merged.removed).toEqual([]);
    expect(breakdown.stale).toBe(0);
    expect(breakdown.merged).toBe(0);
    expect(breakdown.activeEnvs).toEqual([{ id: env.id, branchName: env.branch_name, reason }]);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  test('container reaping reports unknown platforms without destroying them', async () => {
    mockListActiveContainerEnvironments.mockResolvedValue([
      makeContainerEnvironment({ created_by_platform: UNKNOWN_PLATFORM, days_since_created: 100 }),
    ]);
    const report = await cleanupContainerEnvironments();
    expect(report.skipped).toEqual([{ id: 'env-1', reason: UNKNOWN_PLATFORM_REASON }]);
    expect(report.removed).toEqual([]);
    expect(mockContainerDestroy).not.toHaveBeenCalled();
  });

  test('explicit environment removal reports an unknown platform', async () => {
    mockGetById.mockResolvedValue(makeEnvironment({ created_by_platform: UNKNOWN_PLATFORM }));
    expect((await removeEnvironment(await selectedEnvironment())).skippedReason).toBe(
      UNKNOWN_PLATFORM_REASON
    );
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });
});

describe('worktree cleanup provider ownership', () => {
  test('merged, stale, and status checks exclude containers before checking branches', async () => {
    const env = makeEnvironment({ provider: 'container', branch_name: '' });
    mockListByCodebase.mockResolvedValue([env]);
    mockListByCodebaseWithAge.mockResolvedValue([{ ...env, days_since_activity: 30 }]);
    expect((await cleanupMergedWorktrees('cb', '/repo')).removed).toEqual([]);
    expect((await cleanupStaleWorktrees('cb', '/repo')).removed).toEqual([]);
    expect((await getWorktreeStatusBreakdown('cb', '/repo')).total).toBe(0);
    expect(mockGetPrState).not.toHaveBeenCalled();
    expect(mockWorktreeExists).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });
});

// A failed run locks its environment until a sweep settles its outcome (#4090). The
// lock query is mocked in call order: first without a release (who claims the env),
// then with one (who still claims it once the sweep's settlement is applied).
describe('failed-run lock release', () => {
  const FAILED_RUN = { id: 'run-failed-1234', status: 'failed' } as const;

  beforeEach(() => {
    mockWorktreeExists.mockResolvedValue(true);
    mockGetById.mockImplementation(id => Promise.resolve(makeEnvironment({ id })));
  });

  function releasedByTheSweep(): void {
    mockGetLiveRunOwningEnv.mockResolvedValueOnce(FAILED_RUN).mockResolvedValueOnce(null);
  }

  const staleEnv = (): EnvironmentWithCodebase =>
    makeEnvironmentWithCodebase({
      id: 'env-stale-failed',
      branch_name: 'stale-failed',
      created_at: daysAgo(30),
    });

  test.each([
    ['MERGED', {}, 'merged'],
    ['CLOSED', { includeClosed: true }, 'PR closed'],
  ] as const)(
    '--merged removes a failed run whose PR is %s and reports the release',
    async (prState, options, reason) => {
      mockListByCodebase.mockResolvedValue([makeEnvironment({ branch_name: 'settled' })]);
      mockGetPrState.mockResolvedValue(prAt(prState));
      releasedByTheSweep();

      const result = await cleanupMergedWorktrees('codebase-123', '/workspace/repo', options);

      expect(result.removed).toEqual(['settled']);
      expect(result.releasedFailedRuns).toEqual([
        { branchName: 'settled', runId: FAILED_RUN.id, reason },
      ]);
      expect(mockGetLiveRunOwningEnv).toHaveBeenLastCalledWith('env-1', { kind: 'settled' });
      expect(mockCountCommitsMissingFromRemotes).not.toHaveBeenCalled();
    }
  );

  test('the stale sweep removes a failed run inactive past the window with nothing unpushed', async () => {
    mockListAllActiveWithCodebase.mockResolvedValue([staleEnv()]);
    releasedByTheSweep();

    const report = await runScheduledCleanup();

    expect(report.removed).toEqual(['env-stale-failed (stale)']);
    expect(report.releasedFailedRuns).toEqual([
      { id: 'env-stale-failed', runId: FAILED_RUN.id, reason: 'stale' },
    ]);
    expect(mockGetLiveRunOwningEnv).toHaveBeenLastCalledWith('env-stale-failed', {
      kind: 'stale',
      staleDays: 14,
    });
    expect(mockCountCommitsMissingFromRemotes).toHaveBeenCalledWith('/workspace/worktrees/task-1', [
      'HEAD',
      'refs/heads/stale-failed',
    ]);
  });

  test.each(
    (['merged', 'stale'] as const).flatMap(sweep =>
      (['worktreeRemoved', 'directoryClean'] as const).map(failure => ({ sweep, failure }))
    )
  )(
    'scheduled $sweep cleanup does not report a failed-run release after incomplete $failure',
    async ({ sweep, failure }) => {
      const env = staleEnv();
      scheduledSweepFinds(env);
      mockIsBranchMerged.mockResolvedValue(sweep === 'merged');
      releasedByTheSweep();
      mockDestroy.mockResolvedValueOnce({
        worktreeRemoved: true,
        directoryClean: true,
        branchDeleted: null,
        remoteBranchDeleted: null,
        warnings: [],
        [failure]: false,
      });

      const report = await runScheduledCleanup();

      expect(mockGetLiveRunOwningEnv).toHaveBeenLastCalledWith(
        env.id,
        sweep === 'merged' ? { kind: 'settled' } : { kind: 'stale', staleDays: 14 }
      );
      expect(mockDestroy).toHaveBeenCalledTimes(1);
      expect(report.errors).toEqual([
        { id: env.id, error: 'filesystem removal incomplete; environment remains active' },
      ]);
      expect(report.skipped).toEqual([]);
      expect(report.removed).toEqual([]);
      expect(report.releasedFailedRuns).toEqual([]);
      expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    }
  );

  test('the stale sweep keeps a released failed run whose commits are on no remote', async () => {
    mockListAllActiveWithCodebase.mockResolvedValue([staleEnv()]);
    releasedByTheSweep();
    mockCountCommitsMissingFromRemotes.mockResolvedValueOnce(2);

    const report = await runScheduledCleanup();

    expect(report.removed).toEqual([]);
    expect(report.releasedFailedRuns).toEqual([]);
    expect(report.skipped).toContainEqual({
      id: 'env-stale-failed',
      reason: 'stale but failed run run-fail has 2 unpushed commit(s)',
    });
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  test('the stale sweep keeps an environment no run owns whose commits are on no remote', async () => {
    mockListAllActiveWithCodebase.mockResolvedValue([staleEnv()]);
    mockCountCommitsMissingFromRemotes.mockResolvedValueOnce(3);

    const report = await runScheduledCleanup();

    expect(report.removed).toEqual([]);
    expect(report.skipped).toContainEqual({
      id: 'env-stale-failed',
      reason:
        'stale but 3 unpushed commit(s); remove it explicitly with archon complete stale-failed --force',
    });
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  // The count mock answers only for the revs that shape should ask about, so a sweep
  // that skipped the worktree-gone or branch-gone shape would see 0 and remove the env.
  test.each([
    ['worktree is gone', false, true, '/workspace/repo', ['refs/heads/stale-failed']],
    ['branch is gone', true, false, '/workspace/worktrees/task-1', ['HEAD']],
  ] as const)(
    'the stale sweep keeps unpushed commits when the %s',
    async (_shape, worktreeLeft, branchLeft, countPath, countRevs) => {
      mockListByCodebaseWithAge.mockResolvedValue([
        makeEnvironmentWithAge({ branch_name: 'stale-failed', days_since_activity: 30 }),
      ]);
      mockWorktreeExists.mockResolvedValue(worktreeLeft);
      mockLocalBranchExists.mockResolvedValue(branchLeft);
      releasedByTheSweep();
      mockCountCommitsMissingFromRemotes.mockImplementation((path, revs) =>
        Promise.resolve(path === countPath && Bun.deepEquals(revs, countRevs) ? 1 : 0)
      );

      const result = await cleanupStaleWorktrees('codebase-123', '/workspace/repo');

      expect(result.skipped).toEqual([
        { branchName: 'stale-failed', reason: 'failed run run-fail has 1 unpushed commit(s)' },
      ]);
      expect(result.removed).toEqual([]);
      expect(mockDestroy).not.toHaveBeenCalled();
    }
  );

  test.each([
    ['its branch is left', true, ['refs/heads/stale-failed']],
    ['its branch is gone too', false, []],
  ] as const)(
    'the scheduled sweep releases a failed run whose worktree is gone once it is stale and %s',
    async (_shape, branchLeft, countRevs) => {
      mockListAllActiveWithCodebase.mockResolvedValue([staleEnv()]);
      mockWorktreeExists.mockResolvedValue(false);
      mockLocalBranchExists.mockResolvedValue(branchLeft);
      mockGetLiveRunOwningEnv
        .mockResolvedValueOnce(FAILED_RUN)
        .mockResolvedValueOnce(FAILED_RUN)
        .mockResolvedValueOnce(null);

      const report = await runScheduledCleanup();

      expect(report.removed).toEqual(['env-stale-failed (stale)']);
      expect(report.releasedFailedRuns).toEqual([
        { id: 'env-stale-failed', runId: FAILED_RUN.id, reason: 'stale' },
      ]);
      expect(mockCountCommitsMissingFromRemotes).toHaveBeenCalledWith('/workspace/repo', countRevs);
      expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'env-stale-failed' })
      );
    }
  );

  test.each([
    ['its PR is open', prAt('OPEN'), 'PR is open (active review)'],
    [
      'its PR lookup failed',
      { state: 'UNAVAILABLE' } as const,
      'PR state lookup failed — merge state unverifiable',
    ],
  ] as const)(
    'the scheduled sweep keeps a stale failed run whose worktree and branch are gone while %s',
    async (_shape, pr, reason) => {
      mockListAllActiveWithCodebase.mockResolvedValue([staleEnv()]);
      mockWorktreeExists.mockResolvedValue(false);
      mockLocalBranchExists.mockResolvedValue(false);
      mockGetPrState.mockResolvedValue(pr);
      mockGetLiveRunOwningEnv.mockResolvedValue(FAILED_RUN);

      const report = await runScheduledCleanup();

      expect(report.skipped).toEqual([{ id: 'env-stale-failed', reason }]);
      expect(report.removed).toEqual([]);
      expect(mockDestroy).not.toHaveBeenCalled();
      expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    }
  );

  test('the scheduled sweep keeps a failed run whose worktree is gone while inside the window', async () => {
    mockListAllActiveWithCodebase.mockResolvedValue([staleEnv()]);
    mockWorktreeExists.mockResolvedValue(false);
    mockGetLiveRunOwningEnv.mockResolvedValue(FAILED_RUN);

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-stale-failed',
      reason: 'stale but run run-fail is failed',
    });
    expect(report.removed).toEqual([]);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
  });

  test('the stale sweep keeps a failed run still inside the window', async () => {
    mockListAllActiveWithCodebase.mockResolvedValue([staleEnv()]);
    mockGetLiveRunOwningEnv.mockResolvedValue(FAILED_RUN);

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-stale-failed',
      reason: 'stale but run run-fail is failed',
    });
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  test('a paused run keeps its environment on every sweep, whatever its age', async () => {
    const paused = { id: 'run-paused-1234', status: 'paused' } as const;
    mockGetLiveRunOwningEnv.mockResolvedValue(paused);
    mockListAllActiveWithCodebase.mockResolvedValue([staleEnv()]);
    mockListByCodebase.mockResolvedValue([makeEnvironment({ branch_name: 'paused' })]);
    mockGetPrState.mockResolvedValue(prAt('MERGED'));

    const merged = await cleanupMergedWorktrees('codebase-123', '/workspace/repo');
    mockGetPrState.mockResolvedValue(NO_PR);
    const report = await runScheduledCleanup();

    expect(merged.skipped).toEqual([{ branchName: 'paused', reason: 'run run-paus is paused' }]);
    expect(report.skipped).toContainEqual({
      id: 'env-stale-failed',
      reason: 'stale but run run-paus is paused',
    });
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  test('the chat stale sweep removes a released failed run and reports it', async () => {
    mockListByCodebaseWithAge.mockResolvedValue([
      makeEnvironmentWithAge({ branch_name: 'stale-failed', days_since_activity: 30 }),
    ]);
    releasedByTheSweep();

    const result = await cleanupStaleWorktrees('codebase-123', '/workspace/repo');

    expect(result.removed).toEqual(['stale-failed']);
    expect(result.releasedFailedRuns).toEqual([
      { branchName: 'stale-failed', runId: FAILED_RUN.id, reason: 'stale' },
    ]);
  });
});

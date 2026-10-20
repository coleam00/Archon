/**
 * Tests for isolation commands (complete, cleanup, cleanup-merged)
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type * as Core from '@archon/core';
import type * as Codebases from '@archon/core/db/codebases';
import type * as IsolationDb from '@archon/core/db/isolation-environments';
import type * as IsolationOperations from '@archon/core/operations/isolation-operations';
import type * as CleanupService from '@archon/core/services/cleanup-service';
import type * as Git from '@archon/git';
import type * as Isolation from '@archon/isolation';
import { toBranchName, GitFailure } from '@archon/git';
import { WorktreeRegistrationChangedError, readWorktreeCreationId } from '@archon/isolation';
import {
  isolationCompleteCommand,
  isolationCleanupCommand,
  isolationCleanupMergedCommand,
} from './isolation';

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

const mockListActive = mock<typeof IsolationDb.listActive>(() => Promise.resolve([]));
const mockGetCodebase = mock<typeof Codebases.getCodebase>();
mock.module('@archon/core/db/codebases', () => ({ getCodebase: mockGetCodebase }));
const mockFindStaleEnvironments = mock<typeof IsolationDb.findStaleEnvironments>(() =>
  Promise.resolve([])
);
const mockMarkWorktreeDestroyed = mock<typeof IsolationDb.markWorktreeDestroyed>(() =>
  Promise.resolve()
);

const mockWithWorktreeRegistration = mock<typeof IsolationDb.withWorktreeRegistration>(
  async (observed, remove) => remove(() => mockMarkWorktreeDestroyed(observed))
);

mock.module('@archon/core/db/isolation-environments', () => ({
  findActiveByWorkflow: mock(() => Promise.resolve(null)),
  listActive: mockListActive,
  listByCodebaseWithAge: mock(() => Promise.resolve([])),
  findStaleEnvironments: mockFindStaleEnvironments,
  create: mock(() => Promise.resolve({ id: 'iso-123' })),
  updateStatus: mock(() => Promise.resolve()),
  markWorktreeDestroyed: mockMarkWorktreeDestroyed,
  withWorktreeRegistration: mockWithWorktreeRegistration,
}));

const mockLoadRepoConfig = mock<typeof Core.loadRepoConfig>(() => Promise.resolve({}));

mock.module('@archon/core', () => ({
  loadRepoConfig: mockLoadRepoConfig,
}));

const mockRemoveEnvironment = mock<typeof CleanupService.removeEnvironment>(() =>
  Promise.resolve({ worktreeRemoved: true, branchDeleted: true, warnings: [] })
);
const mockCleanupMergedWorktrees = mock<typeof CleanupService.cleanupMergedWorktrees>(() =>
  Promise.resolve({
    removed: [],
    skipped: [],
    releasedFailedRuns: [],
    warnings: [],
    baseRef: toBranchName('origin/dev'),
  })
);
const mockCleanupContainerEnvironments = mock<typeof CleanupService.cleanupContainerEnvironments>(
  () => Promise.resolve({ removed: [], skipped: [], errors: [] })
);
const mockGetLiveRunBlocker = mock<typeof CleanupService.getLiveRunBlocker>(() =>
  Promise.resolve(null)
);

function liveRunBlocker(runStatus: string): CleanupService.LiveRunBlocker {
  return {
    reason: 'live_run',
    display: `run run-live is ${runStatus}`,
    runId: 'run-live-1',
    runStatus,
  };
}

const mockGetCleanupRunLock = mock<typeof CleanupService.getCleanupRunLock>(() =>
  Promise.resolve({ kind: 'free' })
);

mock.module('@archon/core/services/cleanup-service', () => ({
  removeEnvironment: mockRemoveEnvironment,
  getCleanupRunLock: mockGetCleanupRunLock,
  cleanupMergedWorktrees: mockCleanupMergedWorktrees,
  cleanupContainerEnvironments: mockCleanupContainerEnvironments,
  getLiveRunBlocker: mockGetLiveRunBlocker,
}));

const mockListEnvironments = mock<typeof IsolationOperations.listEnvironments>(() =>
  Promise.resolve({
    codebases: [
      {
        codebaseId: 'cb-1',
        defaultCwd: '/test/repo',
        repositoryUrl: 'https://github.com/owner/repo',
        environments: [],
      },
    ],
    totalEnvironments: 0,
    ghostsReconciled: 0,
  })
);
const mockCleanupMergedEnvironments = mock<typeof IsolationOperations.cleanupMergedEnvironments>(
  () =>
    Promise.resolve({
      removed: [],
      skipped: [],
      releasedFailedRuns: [],
      warnings: [],
      baseRef: toBranchName('origin/dev'),
    })
);

mock.module('@archon/core/operations/isolation-operations', () => ({
  listEnvironments: mockListEnvironments,
  cleanupMergedEnvironments: mockCleanupMergedEnvironments,
}));

const mockWorktreeExists = mock<typeof Git.worktreeExists>(() => Promise.resolve(true));
const mockHasUncommittedChanges = mock<typeof Git.hasUncommittedChangesStrict>(() =>
  Promise.resolve(false)
);
// Default: gh returns empty PR array and git reports no unpushed commits.
const mockExecFileAsync = mock<typeof Git.execFileAsync>((cmd: string) =>
  Promise.resolve({ stdout: cmd === 'gh' ? '[]' : '', stderr: '' })
);

const mockGetUniqueCommitCount = mock<typeof Git.getUniqueCommitCount>(() => Promise.resolve(0));
const mockGetDefaultBranch = mock<typeof Git.getDefaultBranch>(() =>
  Promise.resolve(toBranchName('dev'))
);
const mockIsPatchEquivalent = mock<typeof Git.isPatchEquivalent>(() => Promise.resolve(false));

mock.module('@archon/git', () => ({
  GitFailure,
  hasUncommittedChangesStrict: mockHasUncommittedChanges,
  execFileAsync: mockExecFileAsync,
  toWorktreePath: mock((p: string) => p),
  toRepoPath: mock((p: string) => p),
  toBranchName: mock((b: string) => b),
  worktreeExists: mockWorktreeExists,
  getUniqueCommitCount: mockGetUniqueCommitCount,
  getDefaultBranch: mockGetDefaultBranch,
  isPatchEquivalent: mockIsPatchEquivalent,
}));

const mockDestroyWorktree = mock<ReturnType<typeof Isolation.getIsolationProvider>['destroy']>(() =>
  Promise.resolve({
    worktreeRemoved: true,
    branchDeleted: true,
    remoteBranchDeleted: null,
    directoryClean: true,
    warnings: [],
  })
);

mock.module('@archon/isolation', () => ({
  readWorktreeCreationId,
  getIsolationProvider: mock(() => ({
    destroy: mockDestroyWorktree,
  })),
}));

type ActiveEnvironment = Isolation.IsolationEnvironmentRow & {
  codebase_default_cwd: string;
  codebase_name: string;
};

function makeEnvironment(overrides: Partial<ActiveEnvironment> = {}): ActiveEnvironment {
  return {
    id: 'env-123',
    branch_name: 'feature-branch',
    working_path: '/test/worktree',
    codebase_id: 'cb-123',
    codebase_name: 'test-project',
    codebase_default_cwd: '/test/repo',
    workflow_id: 'wf-123',
    workflow_type: 'task',
    status: 'active',
    provider: 'worktree',
    created_by_platform: 'cli',
    created_by_user_id: null,
    metadata: {},
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const mockEnv = makeEnvironment({ metadata: { worktree_creation_id: 'checkout-proof' } });

describe('isolationCompleteCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    mockLogger.error.mockClear();
    mockListActive.mockReset().mockResolvedValue([mockEnv]);
    mockGetCodebase.mockReset().mockResolvedValue({
      id: 'cb-123',
      name: 'test-project',
      kind: 'repo',
      default_cwd: '/test/repo',
      repository_url: null,
      default_branch: 'main',
      ai_assistant_type: null,
      commands: {},
      created_at: new Date(),
      updated_at: new Date(),
    });
    mockRemoveEnvironment.mockReset();
    mockWorktreeExists.mockReset().mockResolvedValue(true);
    mockHasUncommittedChanges.mockReset();
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockGetLiveRunBlocker.mockReset();
    mockGetLiveRunBlocker.mockResolvedValue(null);
    mockExecFileAsync.mockReset();
    // Default: gh returns empty PR array and git reports no unpushed commits.
    mockExecFileAsync.mockImplementation((cmd: string) =>
      Promise.resolve({ stdout: cmd === 'gh' ? '[]' : '', stderr: '' })
    );
    mockLoadRepoConfig.mockReset();
    mockLoadRepoConfig.mockResolvedValue({});
    mockGetUniqueCommitCount.mockReset();
    mockGetUniqueCommitCount.mockResolvedValue(0);
    mockGetDefaultBranch.mockReset();
    mockGetDefaultBranch.mockResolvedValue(toBranchName('dev'));
    mockIsPatchEquivalent.mockReset();
    mockIsPatchEquivalent.mockResolvedValue(false);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('counts a lookup failure and continues completing the remaining branches', async () => {
    const lookupError = new Error('database unavailable');
    mockListActive.mockRejectedValueOnce(lookupError).mockResolvedValueOnce([mockEnv]);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });

    await expect(
      isolationCompleteCommand(['lookup-fails', 'feature-branch'], { force: true })
    ).rejects.toThrow('Failed to complete');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Failed: lookup-fails — DB lookup error: database unavailable'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: lookupError, branch: 'lookup-fails' },
      'isolation.lookup_failed'
    );
    expect(mockRemoveEnvironment).toHaveBeenCalledTimes(1);
    expect(mockRemoveEnvironment).toHaveBeenCalledWith(expect.objectContaining({ id: 'env-123' }), {
      force: true,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 1 failed, 0 not found');
  });

  it('refuses completion when the selected environment cannot be hydrated', async () => {
    const lookupError = new Error('invalid target path');
    mockListActive.mockResolvedValueOnce([mockEnv]);
    mockGetCodebase.mockRejectedValueOnce(lookupError);

    await expect(isolationCompleteCommand(['feature-branch'], { force: true })).rejects.toThrow(
      'Failed to complete'
    );

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Failed: feature-branch — DB lookup error: invalid target path'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: lookupError, branch: 'feature-branch' },
      'isolation.lookup_failed'
    );
  });

  it.each([false, true])('refuses ambiguous branches even with force=%s', async force => {
    mockListActive.mockResolvedValueOnce([
      mockEnv,
      {
        ...mockEnv,
        id: 'other-env',
        codebase_id: 'other-codebase',
        codebase_default_cwd: '/other/repo',
      },
    ]);

    await expect(isolationCompleteCommand(['feature-branch'], { force })).rejects.toThrow(
      'Failed to complete'
    );

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(mockGetCodebase).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Failed: feature-branch — multiple active environments match this branch; refusing ambiguous deletion'
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it.each([false, true])('completes an unchanged registration (legacy=%s)', async legacy => {
    const hydrated = makeEnvironment({
      metadata: legacy ? {} : { worktree_registration_id: 'stable-registration' },
    });
    const { codebase_default_cwd, codebase_name, ...row } = hydrated;
    mockListActive.mockResolvedValueOnce([row]);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });

    await isolationCompleteCommand(['feature-branch'], {});

    expect(mockRemoveEnvironment).toHaveBeenCalledWith(row, {
      force: undefined,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
  });

  it.each([false, true])('refuses container environments accurately with force=%s', async force => {
    const env = makeEnvironment({ provider: 'container' });
    mockListActive.mockResolvedValueOnce([env]);

    await expect(isolationCompleteCommand(['feature-branch'], { force })).rejects.toThrow(
      'Failed to complete'
    );

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Failed: feature-branch — not a worktree environment'
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it.each(['unknown revision', 'bad revision'])(
    'does not classify unrelated %s prose as an absent ref',
    async phrase => {
      mockListActive.mockResolvedValueOnce([mockEnv]);
      mockGetUniqueCommitCount.mockResolvedValueOnce(2);
      mockIsPatchEquivalent.mockResolvedValue(true);
      mockExecFileAsync.mockImplementation(async (cmd, args) => {
        if (cmd === 'gh') return { stdout: '[]', stderr: '' };
        if (args.includes('log')) throw new GitFailure('timeout', `timeout at /repo/${phrase}`);
        throw Object.assign(new Error('missing ref'), { code: 1 });
      });

      await expect(isolationCompleteCommand(['feature-branch'], {})).rejects.toThrow(
        'Failed to complete'
      );

      expect(mockRemoveEnvironment).not.toHaveBeenCalled();
      expect(mockIsPatchEquivalent).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 2 commit(s) unique to this branch');
    }
  );

  it.each([0, 128, null])(
    'keeps unique commits when the remote ref is present or unverifiable (code=%s)',
    async code => {
      mockListActive.mockResolvedValueOnce([mockEnv]);
      mockGetUniqueCommitCount.mockResolvedValueOnce(1);
      mockIsPatchEquivalent.mockResolvedValue(true);
      mockExecFileAsync.mockImplementation(async (cmd, args) => {
        if (cmd === 'gh') return { stdout: '[]', stderr: '' };
        if (args.includes('log')) return { stdout: '', stderr: '' };
        if (code !== 0) throw Object.assign(new Error('ref probe failed'), { code });
        return { stdout: '', stderr: '' };
      });

      await expect(isolationCompleteCommand(['feature-branch'], {})).rejects.toThrow(
        'Failed to complete'
      );

      expect(mockRemoveEnvironment).not.toHaveBeenCalled();
      expect(mockIsPatchEquivalent).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 1 commit(s) unique to this branch');
    }
  );

  it.each([
    { name: 'unclassified failure', logError: new Error('log failed') },
    { name: 'timeout', logError: new GitFailure('timeout', 'log timed out') },
    {
      name: 'missing repository',
      logError: new GitFailure('not_repository', 'repository missing'),
    },
  ])('refuses unverified push state with zero unique commits: $name', async ({ logError }) => {
    mockListActive.mockResolvedValue([mockEnv]);
    mockGetUniqueCommitCount.mockResolvedValue(0);
    mockIsPatchEquivalent.mockResolvedValue(true);
    mockExecFileAsync.mockImplementation(async (cmd, args) => {
      if (cmd === 'gh') return { stdout: '[]', stderr: '' };
      if (args.includes('log')) throw logError;
      throw Object.assign(new Error('missing ref'), { code: 1 });
    });

    for (const deleteRemote of [false, true]) {
      await expect(isolationCompleteCommand(['feature-branch'], { deleteRemote })).rejects.toThrow(
        'Failed to complete'
      );
      expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    }
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      `    ✗ could not verify unpushed commits (${logError.message}) — refusing to delete unverified`
    );
    expect(mockIsPatchEquivalent).not.toHaveBeenCalled();

    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });
    await isolationCompleteCommand(['feature-branch'], { force: true });
    expect(mockRemoveEnvironment).toHaveBeenCalledWith(expect.objectContaining({ id: 'env-123' }), {
      force: true,
      deleteRemoteBranch: true,
    });
  });

  it('finishes removing the first shared ref before checking the last one', async () => {
    const lastEnv = makeEnvironment({ id: 'last-env', branch_name: 'last' });
    mockListActive
      .mockResolvedValueOnce([makeEnvironment({ branch_name: 'first' })])
      .mockResolvedValueOnce([lastEnv]);
    let firstRemoved = false;
    const removalHeld = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    mockGetUniqueCommitCount.mockImplementation(async () => (firstRemoved ? 1 : 0));
    mockRemoveEnvironment.mockImplementationOnce(async () => {
      started.resolve();
      await removalHeld.promise;
      firstRemoved = true;
      return { worktreeRemoved: true, branchDeleted: true, warnings: [] };
    });

    const completion = isolationCompleteCommand(['first', 'last'], {}).then(
      () => null,
      (error: unknown) => error
    );
    await started.promise;
    try {
      expect(mockGetUniqueCommitCount).toHaveBeenCalledTimes(1);
    } finally {
      removalHeld.resolve();
      expect(await completion).toBeInstanceOf(Error);
    }
    expect(mockGetUniqueCommitCount).toHaveBeenCalledTimes(2);
    expect(mockRemoveEnvironment).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 1 commit(s) unique to this branch');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 1 failed, 0 not found');
  });

  it('checks open PRs in the selected repository rather than the process cwd', async () => {
    mockListActive.mockResolvedValueOnce([mockEnv]);
    expect(process.cwd()).not.toBe(mockEnv.codebase_default_cwd);
    mockExecFileAsync.mockImplementation(async (cmd, _args, options) => ({
      stdout:
        cmd === 'gh'
          ? JSON.stringify(
              options?.cwd === mockEnv.codebase_default_cwd
                ? [{ number: 42, title: 'target repository PR' }]
                : []
            )
          : '',
      stderr: '',
    }));

    await expect(isolationCompleteCommand(['feature-branch'], {})).rejects.toThrow(
      'Failed to complete'
    );

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ open PR #42 — "target repository PR"');
  });

  it('completes a branch when env is found and all checks pass', async () => {
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).toHaveBeenCalledWith(expect.objectContaining({ id: 'env-123' }), {
      force: false,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 0 failed, 0 not found');
  });

  it('prints not found when env does not exist', async () => {
    mockListActive.mockResolvedValueOnce([]);

    await isolationCompleteCommand(['nonexistent-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Not found: nonexistent-branch (no active isolation environment)'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 0 failed, 1 not found');
  });

  it('does not query status for an absent checkout', async () => {
    mockWorktreeExists.mockResolvedValueOnce(false);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockHasUncommittedChanges).not.toHaveBeenCalled();
    expect(mockRemoveEnvironment).toHaveBeenCalled();
  });

  it('blocks a failed status query without calling it uncommitted changes', async () => {
    mockHasUncommittedChanges.mockRejectedValueOnce(new Error('status unavailable'));

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '    ✗ could not verify uncommitted changes (worktree path may be missing)'
    );
    expect(consoleErrorSpy).not.toHaveBeenCalledWith('    ✗ uncommitted changes in worktree');
  });

  it('blocks when env has uncommitted changes without --force', async () => {
    const env = makeEnvironment({ branch_name: 'dirty-branch' });
    mockListActive.mockResolvedValueOnce([env]);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);

    await expect(
      isolationCompleteCommand(['dirty-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: dirty-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ uncommitted changes in worktree');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  // The worktree is clean and pushed, so the live-run lock is the only blocker. The
  // environment is the failed run's resume handle; removeEnvironment is what would
  // delete its worktree and its local and remote branch.
  it('refuses a clean, pushed environment a failed run can still resume', async () => {
    mockGetLiveRunBlocker.mockResolvedValueOnce(liveRunBlocker('failed'));

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockGetLiveRunBlocker).toHaveBeenCalledWith('env-123');
    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ run run-live is failed');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('refuses when the owning-run lookup fails', async () => {
    mockGetLiveRunBlocker.mockRejectedValueOnce(new Error('database is locked'));

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '    ✗ could not check for a run that owns this environment (database is locked)'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks when there is an open PR on the branch', async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify([{ number: 140, title: 'fix: add metrics session_id' }]),
          stderr: '',
        });
      }
      // git log: empty (no unmerged/unpushed)
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '    ✗ open PR #140 — "fix: add metrics session_id"'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('completes a branch identical to dev without --force', async () => {
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });
    mockGetUniqueCommitCount.mockResolvedValueOnce(0);

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockGetUniqueCommitCount).toHaveBeenCalledWith('/test/repo', 'feature-branch', 'origin');
    expect(mockRemoveEnvironment).toHaveBeenCalled();
  });

  it('uses the configured remote for the completion commit checks', async () => {
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });
    mockLoadRepoConfig.mockResolvedValueOnce({ worktree: { remote: 'upstream' } });
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.includes('upstream/feature-branch..feature-branch')) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockGetUniqueCommitCount).toHaveBeenCalledWith(
      '/test/repo',
      'feature-branch',
      'upstream'
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      [
        '-C',
        '/test/repo',
        'log',
        '--ignore-missing',
        'upstream/feature-branch..feature-branch',
        '--oneline',
      ],
      { timeout: 15000 }
    );
    expect(mockRemoveEnvironment).toHaveBeenCalled();
  });

  it('blocks when commits are unique to the branch', async () => {
    mockGetUniqueCommitCount.mockResolvedValueOnce(2);

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 2 commit(s) unique to this branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks when there are unpushed commits', async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        return Promise.resolve({ stdout: 'abc1234 wip: unpushed commit\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 1 commit(s) not pushed to remote');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('allows a squash-merged branch whose remote default has its patches', async () => {
    mockGetUniqueCommitCount.mockResolvedValueOnce(1);
    mockIsPatchEquivalent.mockImplementation((_repo: string, _branch: string, baseRef: string) =>
      Promise.resolve(baseRef === 'origin/dev')
    );
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('show-ref'))
        return Promise.reject(Object.assign(new Error('missing ref'), { code: 1 }));
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        if (args.includes('--ignore-missing')) return Promise.resolve({ stdout: '', stderr: '' });
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockIsPatchEquivalent).toHaveBeenCalledWith(
      '/test/repo',
      'feature-branch',
      'origin/dev',
      {
        throwOnExpectedError: true,
      }
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Note: no origin/feature-branch on the remote; content is already on origin/dev (squash-merged, or merged locally and never pushed).'
    );
    expect(mockRemoveEnvironment).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 0 failed, 0 not found');
  });

  it('does not accept patches present only on the local default branch', async () => {
    mockGetUniqueCommitCount.mockResolvedValueOnce(1);
    mockIsPatchEquivalent.mockImplementation((_repo: string, _branch: string, baseRef: string) =>
      Promise.resolve(baseRef === 'dev')
    );
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('show-ref'))
        return Promise.reject(Object.assign(new Error('missing ref'), { code: 1 }));
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        if (args.includes('--ignore-missing')) return Promise.resolve({ stdout: '', stderr: '' });
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '    ✗ no origin/feature-branch on the remote (deleted or never pushed) and content not found on origin/dev'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('still blocks on unique commits when the unpushed probe fails unexpectedly', async () => {
    mockGetUniqueCommitCount.mockResolvedValueOnce(2);
    mockIsPatchEquivalent.mockResolvedValue(true);
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('show-ref'))
        return Promise.reject(Object.assign(new Error('missing ref'), { code: 1 }));
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.includes('origin/feature-branch..feature-branch')) {
        return Promise.reject(new Error('fatal: could not read Username for https://github.com'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 2 commit(s) unique to this branch');
    // A probe that failed for an unknown reason is not evidence of a squash merge.
    expect(mockIsPatchEquivalent).not.toHaveBeenCalled();
  });

  it('blocks when the remote default branch cannot be verified', async () => {
    mockGetUniqueCommitCount.mockResolvedValueOnce(1);
    mockIsPatchEquivalent.mockRejectedValueOnce(new Error('unknown revision origin/dev'));
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('show-ref'))
        return Promise.reject(Object.assign(new Error('missing ref'), { code: 1 }));
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        if (args.includes('--ignore-missing')) return Promise.resolve({ stdout: '', stderr: '' });
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "    ✗ could not verify whether feature-branch's content is already on the base branch (unknown revision origin/dev)"
    );
  });

  it('allows never-pushed branch with 0 unique commits to complete without --force', async () => {
    // Every commit on the branch is reachable from a surviving ref (so
    // getUniqueCommitCount returns 0), and origin/<branch> does not exist.
    // Combined, there is provably nothing to lose — completion must succeed
    // without --force.
    mockGetUniqueCommitCount.mockResolvedValueOnce(0);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('show-ref'))
        return Promise.reject(Object.assign(new Error('missing ref'), { code: 1 }));
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        if (args.includes('--ignore-missing')) return Promise.resolve({ stdout: '', stderr: '' });
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).toHaveBeenCalledWith(expect.objectContaining({ id: 'env-123' }), {
      force: false,
      deleteRemoteBranch: true,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      '    ✗ branch has never been pushed to remote'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 0 failed, 0 not found');
  });

  it('still blocks when the unique-commit check throws (fail-closed preserved)', async () => {
    // getUniqueCommitCount throws — check 4's blocker fires. Check 5's
    // "never pushed" blocker must NOT also fire on the same branch: the gate
    // (uniqueCommitCount !== undefined && uniqueCommitCount > 0) is false
    // when uniqueCommitCount is undefined, so an unverifiable check 4 cannot
    // be misread as "verified zero unique commits".
    mockGetUniqueCommitCount.mockRejectedValueOnce(new Error('git rev-list failed'));
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('show-ref'))
        return Promise.reject(Object.assign(new Error('missing ref'), { code: 1 }));
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        if (args.includes('--ignore-missing')) return Promise.resolve({ stdout: '', stderr: '' });
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '    ✗ could not determine unique commits (git rev-list failed) — refusing to delete unverified'
    );
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      '    ✗ branch has never been pushed to remote'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('reports all blockers in safety-check order when multiple checks fail', async () => {
    mockHasUncommittedChanges.mockResolvedValueOnce(true);
    mockGetUniqueCommitCount.mockResolvedValueOnce(2);
    mockGetLiveRunBlocker.mockResolvedValueOnce(liveRunBlocker('running'));
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify([{ number: 140, title: 'fix: metrics' }]),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await expect(
      isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls).toEqual([
      ['  Blocked: feature-branch'],
      ['    ✗ uncommitted changes in worktree'],
      ['    ✗ run run-live is running'],
      ['    ✗ open PR #140 — "fix: metrics"'],
      ['    ✗ 2 commit(s) unique to this branch'],
      ['  Use --force to override.'],
    ]);
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it.each(['unavailable', 'malformed', 'failed'])(
    'warns on a %s PR check and continues without force',
    async failure => {
      const later = makeEnvironment({ id: 'env-later', branch_name: 'later' });
      mockListActive
        .mockResolvedValueOnce([makeEnvironment(), later])
        .mockResolvedValueOnce([later]);
      mockRemoveEnvironment.mockResolvedValue({
        worktreeRemoved: true,
        branchDeleted: true,
        warnings: [],
      });
      let checks = 0;
      mockExecFileAsync.mockImplementation((cmd: string) => {
        if (cmd === 'gh' && checks++ === 0) {
          if (failure === 'malformed') return Promise.resolve({ stdout: '{', stderr: '' });
          return Promise.reject(
            new Error(failure === 'unavailable' ? 'spawn gh ENOENT' : 'authentication failed')
          );
        }
        return Promise.resolve({ stdout: cmd === 'gh' ? '[]' : '', stderr: '' });
      });

      await isolationCompleteCommand(['feature-branch', 'later'], {
        force: false,
        deleteRemote: true,
      });

      expect(mockRemoveEnvironment).toHaveBeenCalledTimes(2);
      expect(mockRemoveEnvironment).toHaveBeenCalledWith(later, {
        force: false,
        deleteRemoteBranch: true,
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping open PR check')
      );
      expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: later');
    }
  );

  it('keeps dirty-worktree and commit checks when the PR query fails', async () => {
    mockHasUncommittedChanges.mockResolvedValue(true);
    mockGetUniqueCommitCount.mockResolvedValue(2);
    mockExecFileAsync.mockImplementation((cmd: string) =>
      cmd === 'gh'
        ? Promise.reject(new Error('spawn gh ENOENT'))
        : Promise.resolve({ stdout: '', stderr: '' })
    );
    await expect(isolationCompleteCommand(['feature-branch'], { force: false })).rejects.toThrow(
      'Failed to complete'
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('skipping open PR check'));
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ uncommitted changes in worktree');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 2 commit(s) unique to this branch');
    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
  });

  it('proceeds despite all checks when --force is set', async () => {
    const env = makeEnvironment({ branch_name: 'dirty-branch' });
    mockListActive.mockResolvedValueOnce([env]);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);
    mockGetLiveRunBlocker.mockResolvedValueOnce(liveRunBlocker('failed'));
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });

    await isolationCompleteCommand(['dirty-branch'], { force: true, deleteRemote: true });

    // All safety checks should NOT be called when force is true
    expect(mockHasUncommittedChanges).not.toHaveBeenCalled();
    expect(mockGetLiveRunBlocker).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(mockRemoveEnvironment).toHaveBeenCalledWith(expect.objectContaining({ id: 'env-123' }), {
      force: true,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: dirty-branch');
  });

  it('counts failed when removeEnvironment throws', async () => {
    const env = makeEnvironment({ branch_name: 'bad-branch' });
    mockListActive.mockResolvedValueOnce([env]);
    mockRemoveEnvironment.mockRejectedValueOnce(new Error('git error: cannot remove worktree'));

    await expect(
      isolationCompleteCommand(['bad-branch'], { force: false, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Failed: bad-branch — git error: cannot remove worktree'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('handles multiple branches with mixed results', async () => {
    mockListActive
      .mockResolvedValueOnce([makeEnvironment({ branch_name: 'branch-1' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([makeEnvironment({ branch_name: 'branch-3' })]);
    mockRemoveEnvironment
      .mockResolvedValueOnce({ worktreeRemoved: true, branchDeleted: true, warnings: [] }) // branch-1 succeeds
      .mockRejectedValueOnce(new Error('some error')); // branch-3 fails

    await expect(
      isolationCompleteCommand(['branch-1', 'branch-2', 'branch-3'], {
        force: false,
        deleteRemote: true,
      })
    ).rejects.toThrow('Failed to complete');

    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 1 failed, 1 not found');
  });
  it('counts as failed when removeEnvironment returns skippedReason (ghost worktree)', async () => {
    const env = makeEnvironment({ branch_name: 'ghost-branch' });
    mockListActive.mockResolvedValueOnce([env]);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: false,
      branchDeleted: false,
      skippedReason: 'has uncommitted changes',
      warnings: [],
    });

    await expect(
      isolationCompleteCommand(['ghost-branch'], { force: true, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Blocked: ghost-branch — has uncommitted changes'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('    Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('counts as failed when removeEnvironment returns partial (worktree not removed, branch deleted)', async () => {
    const env = makeEnvironment({ branch_name: 'partial-branch' });
    mockListActive.mockResolvedValueOnce([env]);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: false,
      branchDeleted: true,
      warnings: ['Some warning'],
      skippedReason: undefined,
    });

    await expect(
      isolationCompleteCommand(['partial-branch'], { force: true, deleteRemote: true })
    ).rejects.toThrow('Failed to complete');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Partial: partial-branch — worktree was not removed from disk (branch deleted, DB updated)'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ⚠ Some warning');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('surfaces warnings from removeEnvironment result', async () => {
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: false,
      warnings: ["Cannot delete branch 'feature-branch': checked out elsewhere"],
    });

    await isolationCompleteCommand(['feature-branch'], { force: true, deleteRemote: true });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "  Warning: Cannot delete branch 'feature-branch': checked out elsewhere"
    );
    // Should still count as completed since worktree was removed
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 0 failed, 0 not found');
  });
});

describe('isolationCleanupMergedCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    mockCleanupMergedEnvironments.mockReset();
    mockCleanupMergedEnvironments.mockResolvedValue({
      removed: [],
      skipped: [],
      releasedFailedRuns: [],
      warnings: [],
      baseRef: toBranchName('origin/dev'),
    });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('passes includeClosed=true when --include-closed flag is set', async () => {
    await isolationCleanupMergedCommand({ includeClosed: true });
    expect(mockCleanupMergedEnvironments).toHaveBeenCalledWith('cb-1', '/test/repo', {
      includeClosed: true,
    });
  });

  it('defaults to includeClosed=false', async () => {
    await isolationCleanupMergedCommand();
    expect(mockCleanupMergedEnvironments).toHaveBeenCalledWith('cb-1', '/test/repo', {});
  });

  // The command used to claim "merged into main" while comparing against the repo's
  // configured base branch (#3471).
  it('names each failed run whose lock the sweep released', async () => {
    mockCleanupMergedEnvironments.mockResolvedValueOnce({
      removed: ['settled'],
      skipped: [],
      warnings: [],
      releasedFailedRuns: [{ branchName: 'settled', runId: 'run-failed-1', reason: 'PR closed' }],
      baseRef: toBranchName('origin/dev'),
    });

    await isolationCleanupMergedCommand({ includeClosed: true });

    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Released failed run run-fail (PR closed): settled'
    );
  });

  it('shows retained remote branch warnings from merged cleanup', async () => {
    mockCleanupMergedEnvironments.mockResolvedValueOnce({
      removed: ['settled'],
      skipped: [],
      releasedFailedRuns: [],
      warnings: [{ branchName: 'settled', message: "Remote branch retained 'settled'" }],
      baseRef: toBranchName('origin/dev'),
    });
    await isolationCleanupMergedCommand();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "  Warning: settled: Remote branch retained 'settled'"
    );
  });

  it('names the base ref the sweep compared against, never a hardcoded main', async () => {
    await isolationCleanupMergedCommand();

    expect(consoleLogSpy).toHaveBeenCalledWith('  Base: origin/dev');
    const printed = consoleLogSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(printed).not.toContain('merged into main');
  });
});

describe('isolationCleanupCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    mockFindStaleEnvironments.mockReset();
    mockFindStaleEnvironments.mockResolvedValue([]);
    mockGetCleanupRunLock.mockReset();
    mockGetCleanupRunLock.mockResolvedValue({ kind: 'free' });
    mockGetLiveRunBlocker.mockReset();
    mockGetLiveRunBlocker.mockResolvedValue(null);
    mockDestroyWorktree.mockReset().mockResolvedValue({
      worktreeRemoved: true,
      directoryClean: true,
      branchDeleted: true,
      remoteBranchDeleted: null,
      warnings: [],
    });
    mockMarkWorktreeDestroyed.mockReset();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it.each([false, true])(
    'runs container cleanup without worktree destruction (stale container: %s)',
    async hasContainer => {
      mockFindStaleEnvironments.mockResolvedValueOnce(
        hasContainer ? [{ ...mockEnv, provider: 'container' }] : []
      );
      mockCleanupContainerEnvironments.mockClear();
      await isolationCleanupCommand(0);
      expect(mockDestroyWorktree).not.toHaveBeenCalled();
      expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
      expect(mockCleanupContainerEnvironments).toHaveBeenCalledWith(0);
    }
  );

  it('refuses a changed stale registration before destruction', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([mockEnv]);
    mockWithWorktreeRegistration.mockRejectedValueOnce(
      new WorktreeRegistrationChangedError(mockEnv.id)
    );
    await isolationCleanupCommand(7);
    expect(mockWithWorktreeRegistration).toHaveBeenLastCalledWith(mockEnv, expect.any(Function));
    expect(mockDestroyWorktree).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('changed during cleanup'));
  });

  it('rejects before reconciliation or destruction when the initial list rejects a legacy path', async () => {
    const { InvalidCodebaseDefaultCwdError } = await import('@archon/core/db/codebases');
    mockListEnvironments.mockRejectedValueOnce(
      new InvalidCodebaseDefaultCwdError('legacy', 'projects/repo')
    );
    await expect(isolationCleanupCommand()).rejects.toThrow('/register-project "legacy"');
    expect(mockDestroyWorktree).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls.flat().join(' ')).not.toContain('Status: Cleaned');
  });

  // A record written before worktree_branch_created was persisted has no key.
  it.each([
    { branchCreated: true, branchName: 'stale-branch' },
    { branchCreated: false, branchName: undefined },
    { branchCreated: 'absent', branchName: undefined },
  ])(
    'destroys a stale environment with no live owning run (branch created: $branchCreated)',
    async ({ branchCreated, branchName }) => {
      mockFindStaleEnvironments.mockResolvedValueOnce([
        {
          ...mockEnv,
          id: 'env-stale-1',
          branch_name: 'stale-branch',
          metadata:
            branchCreated === 'absent'
              ? mockEnv.metadata
              : { ...mockEnv.metadata, worktree_branch_created: branchCreated },
        },
      ]);

      await isolationCleanupCommand(7);

      expect(mockDestroyWorktree).toHaveBeenCalledWith('/test/worktree', {
        branchName,
        canonicalRepoPath: '/test/repo',
        creationId: 'checkout-proof',
      });
      expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'env-stale-1' })
      );
      expect(consoleLogSpy).toHaveBeenCalledWith('  Status: Cleaned');
    }
  );

  it('reports a stale branch deletion warning after retiring the registration', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([mockEnv]);
    const warning = "Cannot delete branch 'feature-branch': checked out elsewhere";
    mockDestroyWorktree.mockResolvedValueOnce({
      worktreeRemoved: true,
      directoryClean: true,
      branchDeleted: false,
      remoteBranchDeleted: null,
      warnings: [warning],
    });
    await isolationCleanupCommand(7);
    expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(mockEnv);
    expect(consoleLogSpy).toHaveBeenCalledWith(`  Warning: ${warning}`);
    expect(consoleLogSpy).toHaveBeenCalledWith('  Status: Cleaned');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '\nCleanup complete: 1 cleaned, 0 skipped, 0 failed'
    );
  });

  it.each(['refusal', 'partial'])(
    'reports %s without marking the stale environment destroyed',
    async mode => {
      mockFindStaleEnvironments.mockResolvedValueOnce([mockEnv]);
      if (mode === 'refusal')
        mockDestroyWorktree.mockRejectedValueOnce(new Error('ownership changed'));
      else
        mockDestroyWorktree.mockResolvedValueOnce({
          worktreeRemoved: true,
          directoryClean: false,
          branchDeleted: null,
          remoteBranchDeleted: null,
          warnings: ['Retained directory'],
        });
      await isolationCleanupCommand(7);
      expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls.flat().join(' ')).toContain(
        mode === 'refusal' ? 'ownership changed' : 'Retained directory'
      );
      expect(consoleLogSpy.mock.calls.flat().join(' ')).not.toContain('Status: Cleaned');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '\nCleanup complete: 0 cleaned, 0 skipped, 1 failed'
      );
    }
  );

  it('reports a registration recreated during cleanup as failed, not cleaned', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([mockEnv]);
    mockMarkWorktreeDestroyed.mockRejectedValueOnce(
      new WorktreeRegistrationChangedError(mockEnv.id)
    );
    await isolationCleanupCommand(7);
    expect(mockMarkWorktreeDestroyed).toHaveBeenCalledWith(mockEnv);
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).toContain('changed during cleanup');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '\nCleanup complete: 0 cleaned, 0 skipped, 1 failed'
    );
  });

  it('skips a stale environment owned by a live run without destroying it', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([
      { ...mockEnv, id: 'env-stale-2', branch_name: 'stale-branch' },
    ]);
    mockGetCleanupRunLock.mockResolvedValueOnce({
      kind: 'locked',
      blocker: liveRunBlocker('paused'),
    });

    await isolationCleanupCommand(7);

    expect(mockDestroyWorktree).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith('  Status: Skipped — run run-live is paused');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '\nCleanup complete: 0 cleaned, 1 skipped, 0 failed'
    );
  });

  it('judges the run lock against the same stale window it swept with', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([mockEnv]);

    await isolationCleanupCommand(3);

    expect(mockGetCleanupRunLock).toHaveBeenCalledWith(mockEnv, '/test/repo', {
      kind: 'stale',
      staleDays: 3,
    });
  });

  it('destroys a stale environment whose failed run was released and names the run', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([mockEnv]);
    mockGetCleanupRunLock.mockResolvedValueOnce({
      kind: 'released',
      runId: 'run-failed-1',
      reason: 'stale',
    });

    await isolationCleanupCommand(7);

    expect(mockDestroyWorktree).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Status: Cleaned (failed run run-fail released: stale)'
    );
  });

  it('keeps a released failed run whose commits are on no remote', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([mockEnv]);
    mockGetCleanupRunLock.mockResolvedValueOnce({
      kind: 'unpushed',
      runId: 'run-failed-1',
      commits: 2,
      display: 'failed run run-fail has 2 unpushed commit(s)',
    });

    await isolationCleanupCommand(7);

    expect(mockDestroyWorktree).not.toHaveBeenCalled();
    expect(mockMarkWorktreeDestroyed).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Status: Skipped — failed run run-fail has 2 unpushed commit(s)'
    );
  });

  it('keeps the environment and reports a failure when the lock check throws', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([mockEnv]);
    mockGetCleanupRunLock.mockRejectedValueOnce(new Error('rev-list failed'));

    await isolationCleanupCommand(7);

    expect(mockDestroyWorktree).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).toContain('rev-list failed');
  });
});

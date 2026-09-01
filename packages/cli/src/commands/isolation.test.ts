/**
 * Tests for isolation commands (complete, cleanup, cleanup-merged)
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import type * as Core from '@archon/core';
import type * as IsolationDb from '@archon/core/db/isolation-environments';
import type * as WorkflowDb from '@archon/core/db/workflows';
import type * as IsolationOperations from '@archon/core/operations/isolation-operations';
import type * as CleanupService from '@archon/core/services/cleanup-service';
import type * as Git from '@archon/git';
import type * as Isolation from '@archon/isolation';
import { toBranchName } from '@archon/git';
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

const mockFindActiveByBranchName = mock<typeof IsolationDb.findActiveByBranchName>(() =>
  Promise.resolve(null)
);
const mockFindStaleEnvironments = mock<typeof IsolationDb.findStaleEnvironments>(() =>
  Promise.resolve([])
);
const mockGetLiveRunOwningEnv = mock<typeof IsolationDb.getLiveRunOwningEnv>(() =>
  Promise.resolve(null)
);
const mockUpdateStatus = mock<typeof IsolationDb.updateStatus>(() => Promise.resolve());

mock.module('@archon/core/db/isolation-environments', () => ({
  findActiveByBranchName: mockFindActiveByBranchName,
  findActiveByWorkflow: mock(() => Promise.resolve(null)),
  listAllActiveWithCodebase: mock(() => Promise.resolve([])),
  listByCodebaseWithAge: mock(() => Promise.resolve([])),
  findStaleEnvironments: mockFindStaleEnvironments,
  getLiveRunOwningEnv: mockGetLiveRunOwningEnv,
  create: mock(() => Promise.resolve({ id: 'iso-123' })),
  updateStatus: mockUpdateStatus,
}));

const mockGetActiveWorkflowRunByPath = mock<typeof WorkflowDb.getActiveWorkflowRunByPath>(() =>
  Promise.resolve(null)
);

mock.module('@archon/core/db/workflows', () => ({
  getActiveWorkflowRunByPath: mockGetActiveWorkflowRunByPath,
}));

const mockLoadRepoConfig = mock<typeof Core.loadRepoConfig>(() => Promise.resolve({}));

mock.module('@archon/core', () => ({
  loadRepoConfig: mockLoadRepoConfig,
}));

const mockRemoveEnvironment = mock<typeof CleanupService.removeEnvironment>(() =>
  Promise.resolve({ worktreeRemoved: true, branchDeleted: true, warnings: [] })
);
const mockCleanupMergedWorktrees = mock<typeof CleanupService.cleanupMergedWorktrees>(() =>
  Promise.resolve({ removed: [], skipped: [] })
);
const mockCleanupContainerEnvironments = mock<typeof CleanupService.cleanupContainerEnvironments>(
  () => Promise.resolve({ removed: [], skipped: [], errors: [] })
);

mock.module('@archon/core/services/cleanup-service', () => ({
  removeEnvironment: mockRemoveEnvironment,
  cleanupMergedWorktrees: mockCleanupMergedWorktrees,
  cleanupContainerEnvironments: mockCleanupContainerEnvironments,
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
  () => Promise.resolve({ removed: [], skipped: [] })
);

mock.module('@archon/core/operations/isolation-operations', () => ({
  listEnvironments: mockListEnvironments,
  cleanupMergedEnvironments: mockCleanupMergedEnvironments,
}));

const mockHasUncommittedChanges = mock<typeof Git.hasUncommittedChanges>(() =>
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
  hasUncommittedChanges: mockHasUncommittedChanges,
  execFileAsync: mockExecFileAsync,
  toWorktreePath: mock((p: string) => p),
  toRepoPath: mock((p: string) => p),
  toBranchName: mock((b: string) => b),
  worktreeExists: mock(() => Promise.resolve(true)),
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
  getIsolationProvider: mock(() => ({
    destroy: mockDestroyWorktree,
  })),
}));

type ActiveEnvironment = NonNullable<
  Awaited<ReturnType<typeof IsolationDb.findActiveByBranchName>>
>;

function makeEnvironment(overrides: Partial<ActiveEnvironment> = {}): ActiveEnvironment {
  return {
    id: 'env-123',
    branch_name: 'feature-branch',
    working_path: '/test/worktree',
    codebase_id: 'cb-123',
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

const mockEnv = makeEnvironment();

type ActiveWorkflowRun = NonNullable<
  Awaited<ReturnType<typeof WorkflowDb.getActiveWorkflowRunByPath>>
>;

function makeActiveWorkflowRun(overrides: Partial<ActiveWorkflowRun> = {}): ActiveWorkflowRun {
  return {
    id: 'run-abc',
    workflow_name: 'implement',
    conversation_id: 'conv-123',
    parent_conversation_id: null,
    codebase_id: 'cb-123',
    status: 'running',
    outcome: null,
    user_message: 'test request',
    metadata: {},
    started_at: new Date('2026-01-01T00:00:00.000Z'),
    completed_at: null,
    last_activity_at: null,
    working_path: '/test/worktree',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    ...overrides,
  };
}

describe('isolationCompleteCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    mockFindActiveByBranchName.mockReset();
    mockRemoveEnvironment.mockReset();
    mockHasUncommittedChanges.mockReset();
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockGetActiveWorkflowRunByPath.mockReset();
    mockGetActiveWorkflowRunByPath.mockResolvedValue(null);
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

  it('completes a branch when env is found and all checks pass', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).toHaveBeenCalledWith('env-123', {
      force: false,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 0 failed, 0 not found');
  });

  it('prints not found when env does not exist', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(null);

    await isolationCompleteCommand(['nonexistent-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '  Not found: nonexistent-branch (no active isolation environment)'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 0 failed, 1 not found');
  });

  it('blocks when env has uncommitted changes without --force', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);

    await isolationCompleteCommand(['dirty-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: dirty-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ uncommitted changes in worktree');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks when there is a running workflow on the branch', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockGetActiveWorkflowRunByPath.mockResolvedValueOnce(makeActiveWorkflowRun());

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ running workflow: implement (id: run-abc)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks when there is an open PR on the branch', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
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

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '    ✗ open PR #140 — "fix: add metrics session_id"'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('completes a branch identical to dev without --force', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
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
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
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
      ['-C', '/test/repo', 'log', 'upstream/feature-branch..feature-branch', '--oneline'],
      { timeout: 15000 }
    );
    expect(mockRemoveEnvironment).toHaveBeenCalled();
  });

  it('blocks when commits are unique to the branch', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockGetUniqueCommitCount.mockResolvedValueOnce(2);

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 2 commit(s) unique to this branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('blocks when there are unpushed commits', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        return Promise.resolve({ stdout: 'abc1234 wip: unpushed commit\n', stderr: '' });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 1 commit(s) not pushed to remote');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('allows a squash-merged branch whose remote default has its patches', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
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
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
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
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockGetUniqueCommitCount.mockResolvedValueOnce(1);
    mockIsPatchEquivalent.mockImplementation((_repo: string, _branch: string, baseRef: string) =>
      Promise.resolve(baseRef === 'dev')
    );
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '    ✗ no origin/feature-branch on the remote (deleted or never pushed) and content not found on origin/dev'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  // The unique-commits blocker is pushed from two places since the refactor. This
  // covers the second one — an unpushed probe that fails for a reason that is NOT a
  // missing ref — so the copy on the destructive path cannot rot untested.
  it('still blocks on unique commits when the unpushed probe fails unexpectedly', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockGetUniqueCommitCount.mockResolvedValueOnce(2);
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.includes('origin/feature-branch..feature-branch')) {
        return Promise.reject(new Error('fatal: could not read Username for https://github.com'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ 2 commit(s) unique to this branch');
    // A probe that failed for an unknown reason is not evidence of a squash merge.
    expect(mockIsPatchEquivalent).not.toHaveBeenCalled();
  });

  it('blocks when the remote default branch cannot be verified', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockGetUniqueCommitCount.mockResolvedValueOnce(1);
    mockIsPatchEquivalent.mockRejectedValueOnce(new Error('unknown revision origin/dev'));
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "    ✗ could not verify whether feature-branch's content is already on the base branch (unknown revision origin/dev)"
    );
  });

  it('allows never-pushed branch with 0 unique commits to complete without --force', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
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
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).toHaveBeenCalledWith('env-123', {
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
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    // getUniqueCommitCount throws — check 4's blocker fires. Check 5's
    // "never pushed" blocker must NOT also fire on the same branch: the gate
    // (uniqueCommitCount !== undefined && uniqueCommitCount > 0) is false
    // when uniqueCommitCount is undefined, so an unverifiable check 4 cannot
    // be misread as "verified zero unique commits".
    mockGetUniqueCommitCount.mockRejectedValueOnce(new Error('git rev-list failed'));
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        return Promise.resolve({ stdout: '[]', stderr: '' });
      }
      if (cmd === 'git' && args.some((a: string) => a.startsWith('origin/'))) {
        return Promise.reject(new Error('fatal: unknown revision origin/feature-branch'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

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

  it('reports all blockers together when multiple checks fail', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);
    mockGetActiveWorkflowRunByPath.mockResolvedValueOnce(makeActiveWorkflowRun());
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === 'gh') {
        return Promise.resolve({
          stdout: JSON.stringify([{ number: 140, title: 'fix: metrics' }]),
          stderr: '',
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(mockRemoveEnvironment).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Blocked: feature-branch');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ uncommitted changes in worktree');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ running workflow: implement (id: run-abc)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ✗ open PR #140 — "fix: metrics"');
    expect(consoleErrorSpy).toHaveBeenCalledWith('  Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('skips PR check with warning when gh CLI is not available', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === 'gh') {
        const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
        return Promise.reject(err);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    await isolationCompleteCommand(['feature-branch'], { force: false, deleteRemote: true });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '  Warning: gh CLI not available — skipping open PR check'
    );
    // Should still complete since gh check is non-fatal
    expect(mockRemoveEnvironment).toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: feature-branch');
  });

  it('proceeds despite all checks when --force is set', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockHasUncommittedChanges.mockResolvedValueOnce(true);
    mockGetActiveWorkflowRunByPath.mockResolvedValueOnce(makeActiveWorkflowRun());
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: true,
      branchDeleted: true,
      warnings: [],
    });

    await isolationCompleteCommand(['dirty-branch'], { force: true, deleteRemote: true });

    // All safety checks should NOT be called when force is true
    expect(mockHasUncommittedChanges).not.toHaveBeenCalled();
    expect(mockGetActiveWorkflowRunByPath).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
    expect(mockRemoveEnvironment).toHaveBeenCalledWith('env-123', {
      force: true,
      deleteRemoteBranch: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith('  Completed: dirty-branch');
  });

  it('counts failed when removeEnvironment throws', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockRejectedValueOnce(new Error('git error: cannot remove worktree'));

    await isolationCompleteCommand(['bad-branch'], { force: false, deleteRemote: true });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Failed: bad-branch — git error: cannot remove worktree'
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('handles multiple branches with mixed results', async () => {
    mockFindActiveByBranchName
      .mockResolvedValueOnce(mockEnv) // found: branch-1
      .mockResolvedValueOnce(null) // not found: branch-2
      .mockResolvedValueOnce(mockEnv); // found: branch-3 (will fail)
    mockRemoveEnvironment
      .mockResolvedValueOnce({ worktreeRemoved: true, branchDeleted: true, warnings: [] }) // branch-1 succeeds
      .mockRejectedValueOnce(new Error('some error')); // branch-3 fails

    await isolationCompleteCommand(['branch-1', 'branch-2', 'branch-3'], {
      force: false,
      deleteRemote: true,
    });

    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 1 completed, 1 failed, 1 not found');
  });
  it('counts as failed when removeEnvironment returns skippedReason (ghost worktree)', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: false,
      branchDeleted: false,
      skippedReason: 'has uncommitted changes',
      warnings: [],
    });

    await isolationCompleteCommand(['ghost-branch'], { force: true, deleteRemote: true });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Blocked: ghost-branch — has uncommitted changes'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('    Use --force to override.');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('counts as failed when removeEnvironment returns partial (worktree not removed, branch deleted)', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
    mockRemoveEnvironment.mockResolvedValueOnce({
      worktreeRemoved: false,
      branchDeleted: true,
      warnings: ['Some warning'],
      skippedReason: undefined,
    });

    await isolationCompleteCommand(['partial-branch'], { force: true, deleteRemote: true });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '  Partial: partial-branch — worktree was not removed from disk (branch deleted, DB updated)'
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith('    ⚠ Some warning');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nComplete: 0 completed, 1 failed, 0 not found');
  });

  it('surfaces warnings from removeEnvironment result', async () => {
    mockFindActiveByBranchName.mockResolvedValueOnce(mockEnv);
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
    mockCleanupMergedEnvironments.mockResolvedValue({ removed: [], skipped: [] });
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
});

describe('isolationCleanupCommand', () => {
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    mockFindStaleEnvironments.mockReset();
    mockFindStaleEnvironments.mockResolvedValue([]);
    mockGetLiveRunOwningEnv.mockReset();
    mockGetLiveRunOwningEnv.mockResolvedValue(null);
    mockDestroyWorktree.mockReset();
    mockUpdateStatus.mockReset();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('destroys a stale environment with no live owning run', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([
      { ...mockEnv, id: 'env-stale-1', branch_name: 'stale-branch' },
    ]);

    await isolationCleanupCommand(7);

    expect(mockDestroyWorktree).toHaveBeenCalledWith('/test/worktree', {
      branchName: 'stale-branch',
      canonicalRepoPath: '/test/repo',
    });
    expect(mockUpdateStatus).toHaveBeenCalledWith('env-stale-1', 'destroyed');
    expect(consoleLogSpy).toHaveBeenCalledWith('  Status: Cleaned');
  });

  it('skips a stale environment owned by a live run without destroying it', async () => {
    mockFindStaleEnvironments.mockResolvedValueOnce([
      { ...mockEnv, id: 'env-stale-2', branch_name: 'stale-branch' },
    ]);
    mockGetLiveRunOwningEnv.mockResolvedValueOnce({ id: 'run-live-1', status: 'paused' });

    await isolationCleanupCommand(7);

    expect(mockDestroyWorktree).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith('  Status: Skipped — run run-live is paused');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      '\nCleanup complete: 0 cleaned, 1 skipped, 0 failed'
    );
  });
});

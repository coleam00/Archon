import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
// Mock logger to suppress noisy output during tests
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Mock @archon/git - the cleanup service imports git functions from @archon/git
const mockExecFileAsync = mock(() => Promise.resolve({ stdout: '', stderr: '' }));
const mockHasUncommittedChanges = mock(() => Promise.resolve(false));
const mockWorktreeExists = mock(() => Promise.resolve(false));
const mockGetDefaultBranch = mock(() => Promise.resolve('main'));
const mockIsBranchMerged = mock(() => Promise.resolve(false));
const mockIsPatchEquivalent = mock(() => Promise.resolve(false));
const mockGetLastCommitDate = mock(() => Promise.resolve(null as Date | null));
mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
  hasUncommittedChanges: mockHasUncommittedChanges,
  worktreeExists: mockWorktreeExists,
  getDefaultBranch: mockGetDefaultBranch,
  isBranchMerged: mockIsBranchMerged,
  isPatchEquivalent: mockIsPatchEquivalent,
  getLastCommitDate: mockGetLastCommitDate,
  toRepoPath: (p: string) => p,
  toBranchName: (b: string) => b,
  toWorktreePath: (p: string) => p,
}));

// Mock isolation provider
const mockDestroy = mock(() =>
  Promise.resolve({
    worktreeRemoved: true,
    branchDeleted: true,
    remoteBranchDeleted: true,
    directoryClean: true,
    warnings: [],
  })
);
mock.module('../isolation', () => ({
  getIsolationProvider: () => ({
    destroy: mockDestroy,
  }),
}));
type PrStateValue = 'MERGED' | 'CLOSED' | 'OPEN' | 'NONE';
const mockGetPrState = mock(() => Promise.resolve('NONE' as PrStateValue));
mock.module('@archon/isolation', () => ({
  getIsolationProvider: () => ({
    destroy: mockDestroy,
  }),
  getPrState: mockGetPrState,
}));

// Mock isolation-environments DB
const mockListAllActiveWithCodebase = mock(() => Promise.resolve([]));
const mockUpdateStatus = mock(() => Promise.resolve());
const mockGetConversationsUsingEnv = mock(() => Promise.resolve([]));
const mockGetById = mock(() => Promise.resolve(null));
const mockListByCodebase = mock(() => Promise.resolve([]));
const mockListByCodebaseWithAge = mock(() => Promise.resolve([]));
const mockCountActiveByCodebase = mock(() => Promise.resolve(0));
mock.module('../db/isolation-environments', () => ({
  listAllActiveWithCodebase: mockListAllActiveWithCodebase,
  updateStatus: mockUpdateStatus,
  getConversationsUsingEnv: mockGetConversationsUsingEnv,
  getById: mockGetById,
  listByCodebase: mockListByCodebase,
  listByCodebaseWithAge: mockListByCodebaseWithAge,
  countActiveByCodebase: mockCountActiveByCodebase,
}));

// Mock conversations DB
const mockGetConversationByPlatformId = mock(() => Promise.resolve(null));
const mockUpdateConversation = mock(() => Promise.resolve());
mock.module('../db/conversations', () => ({
  getConversationByPlatformId: mockGetConversationByPlatformId,
  updateConversation: mockUpdateConversation,
}));

// Mock sessions DB
const mockGetActiveSession = mock(() => Promise.resolve(null));
const mockDeactivateSession = mock(() => Promise.resolve());
const mockDeleteOldSessions = mock(() => Promise.resolve(0));
mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
  deleteOldSessions: mockDeleteOldSessions,
}));

// Mock codebases DB
const mockGetCodebase = mock(() => Promise.resolve(null));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

import {
  runScheduledCleanup,
  startCleanupScheduler,
  stopCleanupScheduler,
  isSchedulerRunning,
  getWorktreeStatusBreakdown,
  cleanupMergedWorktrees,
  cleanupStaleWorktrees,
  removeEnvironment,
  onConversationClosed,
  SESSION_RETENTION_DAYS,
} from './cleanup-service';

describe('cleanup-service', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockHasUncommittedChanges.mockClear();
    mockWorktreeExists.mockClear();
    mockGetDefaultBranch.mockClear();
    mockIsBranchMerged.mockClear();
    mockGetLastCommitDate.mockClear();
    mockDestroy.mockClear();
    mockUpdateStatus.mockClear();
    mockGetById.mockClear();
    mockGetCodebase.mockClear();
    // Reset defaults
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockWorktreeExists.mockResolvedValue(false);
    mockGetDefaultBranch.mockResolvedValue('main');
    mockIsBranchMerged.mockResolvedValue(false);
    mockGetLastCommitDate.mockResolvedValue(null);
  });

  describe('removeEnvironment', () => {
    test('calls destroy with canonicalRepoPath even when directory is missing', async () => {
      const envId = 'env-missing-dir';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '187',
        provider: 'worktree',
        working_path: '/path/that/does/not/exist',
        branch_name: 'issue-187',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      // Mock codebase fetch to get canonical repo path
      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // worktreeExists returns false (default)

      const result = await removeEnvironment(envId);

      // Should call destroy with branchName and canonicalRepoPath for cleanup
      expect(mockDestroy).toHaveBeenCalledWith('/path/that/does/not/exist', {
        force: undefined,
        branchName: 'issue-187',
        canonicalRepoPath: '/workspace/repo',
      });
      // Should mark as destroyed
      expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
      // Should return success result
      expect(result.worktreeRemoved).toBe(true);
      expect(result.skippedReason).toBeUndefined();
    });

    test('handles git worktree remove failure for missing path', async () => {
      const envId = 'env-git-fail';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '187',
        provider: 'worktree',
        working_path: '/path/exists/but/git/fails',
        branch_name: 'issue-187',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      // Mock codebase fetch
      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // worktreeExists returns true (path exists)
      mockWorktreeExists.mockResolvedValueOnce(true);

      // hasUncommittedChanges returns false (default)

      // provider.destroy fails with "No such file or directory"
      mockDestroy.mockRejectedValueOnce(
        new Error("fatal: cannot change to '/path/exists/but/git/fails': No such file or directory")
      );

      await removeEnvironment(envId);

      // Should mark as destroyed despite provider.destroy failure
      expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
    });

    test('logs warnings from partial destroy and still marks as destroyed', async () => {
      const envId = 'env-partial-cleanup';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '42',
        provider: 'worktree',
        working_path: '/workspace/worktrees/repo/issue-42',
        branch_name: 'issue-42',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // worktreeExists returns false (default)

      // destroy returns with warnings (branch couldn't be deleted)
      mockDestroy.mockResolvedValueOnce({
        worktreeRemoved: true,
        branchDeleted: false,
        remoteBranchDeleted: null,
        directoryClean: true,
        warnings: ["Cannot delete branch 'issue-42': branch is checked out elsewhere"],
      });

      await removeEnvironment(envId);

      // Should still mark as destroyed despite partial cleanup
      expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
    });

    test('passes deleteRemoteBranch to provider.destroy when specified', async () => {
      const envId = 'env-remote-delete';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'pr',
        workflow_id: '99',
        provider: 'worktree',
        working_path: '/workspace/worktrees/pr-99',
        branch_name: 'feature-branch',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // worktreeExists returns false (default)

      await removeEnvironment(envId, { deleteRemoteBranch: true });

      expect(mockDestroy).toHaveBeenCalledWith('/workspace/worktrees/pr-99', {
        force: undefined,
        branchName: 'feature-branch',
        canonicalRepoPath: '/workspace/repo',
        deleteRemoteBranch: true,
      });
      expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
    });

    test('does not pass deleteRemoteBranch when not specified', async () => {
      const envId = 'env-no-remote-delete';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '42',
        provider: 'worktree',
        working_path: '/workspace/worktrees/issue-42',
        branch_name: 'issue-42',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // worktreeExists returns false (default)

      await removeEnvironment(envId);

      expect(mockDestroy).toHaveBeenCalledWith('/workspace/worktrees/issue-42', {
        force: undefined,
        branchName: 'issue-42',
        canonicalRepoPath: '/workspace/repo',
        deleteRemoteBranch: undefined,
      });
    });

    test('returns skippedReason when worktree has uncommitted changes without force', async () => {
      const envId = 'env-uncommitted';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '42',
        provider: 'worktree',
        working_path: '/workspace/worktrees/issue-42',
        branch_name: 'issue-42',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // worktreeExists returns true (path exists)
      mockWorktreeExists.mockResolvedValueOnce(true);
      // hasUncommittedChanges returns true
      mockHasUncommittedChanges.mockResolvedValueOnce(true);

      const result = await removeEnvironment(envId);

      // Should NOT call destroy or mark as destroyed
      expect(mockDestroy).not.toHaveBeenCalled();
      expect(mockUpdateStatus).not.toHaveBeenCalled();
      // Should return skipped result
      expect(result.worktreeRemoved).toBe(false);
      expect(result.branchDeleted).toBe(false);
      expect(result.skippedReason).toBe('has uncommitted changes');
    });

    test('returns warnings from partial destroy', async () => {
      const envId = 'env-partial';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '42',
        provider: 'worktree',
        working_path: '/workspace/worktrees/issue-42',
        branch_name: 'issue-42',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // worktreeExists returns false (default)

      mockDestroy.mockResolvedValueOnce({
        worktreeRemoved: true,
        branchDeleted: false,
        remoteBranchDeleted: null,
        directoryClean: true,
        warnings: ["Cannot delete branch 'issue-42': checked out elsewhere"],
      });

      const result = await removeEnvironment(envId);

      expect(result.worktreeRemoved).toBe(true);
      expect(result.branchDeleted).toBe(false);
      expect(result.warnings).toEqual(["Cannot delete branch 'issue-42': checked out elsewhere"]);
      expect(result.skippedReason).toBeUndefined();
    });

    test('re-throws non-directory errors from provider.destroy', async () => {
      const envId = 'env-real-error';

      mockGetById.mockResolvedValueOnce({
        id: envId,
        codebase_id: 'codebase-123',
        workflow_type: 'issue',
        workflow_id: '187',
        provider: 'worktree',
        working_path: '/path/exists',
        branch_name: 'issue-187',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'github',
        metadata: {},
      });

      // Mock codebase fetch
      mockGetCodebase.mockResolvedValueOnce({
        id: 'codebase-123',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      });

      // worktreeExists returns true (path exists)
      mockWorktreeExists.mockResolvedValueOnce(true);

      // hasUncommittedChanges returns false (default)

      // provider.destroy fails with a different error (uncommitted changes)
      mockDestroy.mockRejectedValueOnce(
        new Error('fatal: cannot remove: You have local modifications')
      );

      // Should re-throw the error
      await expect(removeEnvironment(envId)).rejects.toThrow('local modifications');

      // Should NOT mark as destroyed
      expect(mockUpdateStatus).not.toHaveBeenCalled();
    });
  });
});

describe('runScheduledCleanup', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockHasUncommittedChanges.mockClear();
    mockWorktreeExists.mockClear();
    mockGetDefaultBranch.mockClear();
    mockIsBranchMerged.mockClear();
    mockGetLastCommitDate.mockClear();
    mockDestroy.mockClear();
    mockListAllActiveWithCodebase.mockClear();
    mockUpdateStatus.mockClear();
    mockGetConversationsUsingEnv.mockClear();
    mockGetById.mockClear();
    mockGetCodebase.mockClear();
    mockDeleteOldSessions.mockClear();
    // Reset defaults
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockWorktreeExists.mockResolvedValue(false);
    mockGetDefaultBranch.mockResolvedValue('main');
    mockIsBranchMerged.mockResolvedValue(false);
    mockGetLastCommitDate.mockResolvedValue(null);
  });

  test('returns empty report when no environments exist', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([]);

    const report = await runScheduledCleanup();

    expect(report.removed).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
  });

  test('marks missing paths as destroyed and cleans up branch', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-123',
        working_path: '/nonexistent/path',
        branch_name: 'issue-42',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '42',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // worktreeExists returns false for both calls (runScheduledCleanup + removeEnvironment)
    // (already default)
    // removeEnvironment: getById returns the env
    mockGetById.mockResolvedValueOnce({
      id: 'env-123',
      codebase_id: 'codebase-1',
      working_path: '/nonexistent/path',
      branch_name: 'issue-42',
      status: 'active',
    });
    // removeEnvironment: getCodebase for canonical repo path
    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-123 (path missing)');
    // Should call destroy to clean up the branch
    expect(mockDestroy).toHaveBeenCalledWith('/nonexistent/path', {
      force: false,
      branchName: 'issue-42',
      canonicalRepoPath: '/workspace/repo',
    });
    expect(mockUpdateStatus).toHaveBeenCalledWith('env-123', 'destroyed');
  });

  test('removes merged branches without uncommitted changes', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-456',
        working_path: '/workspace/repo/worktrees/pr-99',
        branch_name: 'pr-99',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'pr',
        workflow_id: '99',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // worktreeExists returns true (path exists)
    mockWorktreeExists.mockResolvedValue(true);
    // getDefaultBranch returns 'main' (default)
    // isBranchMerged returns true
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default)
    // No conversations using it
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    // For removeEnvironment: getById returns the env
    mockGetById.mockResolvedValueOnce({
      id: 'env-456',
      codebase_id: 'codebase-1',
      working_path: '/workspace/repo/worktrees/pr-99',
      status: 'active',
    });
    // removeEnvironment: getCodebase for canonical repo path
    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-456 (merged)');
  });

  test('passes deleteRemoteBranch: true for merged branches in scheduled cleanup', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-merged-remote',
        working_path: '/workspace/repo/worktrees/pr-50',
        branch_name: 'pr-50',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'pr',
        workflow_id: '50',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // worktreeExists returns true
    mockWorktreeExists.mockResolvedValue(true);
    // getDefaultBranch returns 'main' (default)
    // isBranchMerged returns true
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default)
    // No conversations
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce({
      id: 'env-merged-remote',
      codebase_id: 'codebase-1',
      working_path: '/workspace/repo/worktrees/pr-50',
      branch_name: 'pr-50',
      status: 'active',
    });
    // removeEnvironment: getCodebase
    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });

    await runScheduledCleanup();

    // Verify deleteRemoteBranch: true was passed through
    expect(mockDestroy).toHaveBeenCalledWith('/workspace/repo/worktrees/pr-50', {
      force: false,
      branchName: 'pr-50',
      canonicalRepoPath: '/workspace/repo',
      deleteRemoteBranch: true,
    });
  });

  test('skips merged branches with uncommitted changes', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-789',
        working_path: '/workspace/repo/worktrees/issue-10',
        branch_name: 'issue-10',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '10',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // worktreeExists returns true (path exists)
    mockWorktreeExists.mockResolvedValueOnce(true);
    // getDefaultBranch returns 'main' (default)
    // isBranchMerged returns true
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // Has uncommitted changes
    mockHasUncommittedChanges.mockResolvedValueOnce(true);

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-789',
      reason: 'merged but has uncommitted changes',
    });
    expect(report.removed).toHaveLength(0);
  });

  test('skips telegram environments', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-telegram',
        working_path: '/workspace/repo/worktrees/thread-abc',
        branch_name: 'thread-abc',
        status: 'active',
        created_by_platform: 'telegram',
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'thread',
        workflow_id: 'abc',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // Path exists for this env
    mockWorktreeExists.mockResolvedValueOnce(true);
    // getDefaultBranch returns 'main' (default from beforeEach)
    // isBranchMerged returns false (default from beforeEach)

    const report = await runScheduledCleanup();

    // Should not be in removed (Telegram is persistent)
    expect(report.removed).toHaveLength(0);
  });

  test('continues processing after error on one environment', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      {
        id: 'env-error',
        working_path: '/bad/path',
        branch_name: 'bad-branch',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '1',
        provider: 'worktree',
        metadata: {},
      },
      {
        id: 'env-good',
        working_path: '/workspace/repo/worktrees/pr-1',
        branch_name: 'pr-1',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'pr',
        workflow_id: '1',
        provider: 'worktree',
        metadata: {},
      },
    ]);
    // worktreeExists returns false for both (already default)
    // env-error: removeEnvironment needs getById + getCodebase
    mockGetById.mockResolvedValueOnce({
      id: 'env-error',
      codebase_id: 'codebase-1',
      working_path: '/bad/path',
      branch_name: 'bad-branch',
      status: 'active',
    });
    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });
    // env-good: removeEnvironment needs getById + getCodebase
    mockGetById.mockResolvedValueOnce({
      id: 'env-good',
      codebase_id: 'codebase-1',
      working_path: '/workspace/repo/worktrees/pr-1',
      branch_name: 'pr-1',
      status: 'active',
    });
    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });

    const report = await runScheduledCleanup();

    // Both should be marked as destroyed since paths are missing
    expect(report.removed).toContain('env-error (path missing)');
    expect(report.removed).toContain('env-good (path missing)');
  });

  test('resolveMainBranch is called for merge checking in runScheduledCleanup', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const tempDir = await mkdtemp(join(tmpdir(), 'archon-cleanup-test-'));
    try {
      await mkdir(join(tempDir, '.archon'), { recursive: true });
      await writeFile(
        join(tempDir, '.archon', 'config.yaml'),
        'worktree:\n  baseBranch: develop\n'
      );

      mockListAllActiveWithCodebase.mockResolvedValueOnce([
        {
          id: 'env-resolve-test',
          working_path: join(tempDir, 'worktrees', 'feature-a'),
          branch_name: 'feature-a',
          status: 'active',
          created_by_platform: 'github',
          created_at: new Date(),
          codebase_default_cwd: tempDir,
          codebase_id: 'codebase-1',
          workflow_type: 'issue',
          workflow_id: '1',
          provider: 'worktree',
          metadata: {},
        },
      ]);
      // Path exists
      mockWorktreeExists.mockResolvedValueOnce(true);
      // Not merged
      mockIsBranchMerged.mockResolvedValueOnce(false);

      await runScheduledCleanup();

      // Should use 'develop' from config, NOT call getDefaultBranch
      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      expect(mockIsBranchMerged).toHaveBeenCalledWith(tempDir, 'feature-a', 'develop');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('deletes old sessions during scheduled cleanup', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([]);
    mockDeleteOldSessions.mockResolvedValueOnce(5);

    const report = await runScheduledCleanup();

    expect(mockDeleteOldSessions).toHaveBeenCalledWith(SESSION_RETENTION_DAYS);
    expect(report.sessionsDeleted).toBe(5);
  });

  test('reports zero when no old sessions to delete', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([]);
    mockDeleteOldSessions.mockResolvedValueOnce(0);

    const report = await runScheduledCleanup();

    expect(mockDeleteOldSessions).toHaveBeenCalledWith(SESSION_RETENTION_DAYS);
    expect(report.sessionsDeleted).toBe(0);
  });

  test('records error when session cleanup fails', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([]);
    mockDeleteOldSessions.mockRejectedValueOnce(new Error('database locked'));

    const report = await runScheduledCleanup();

    expect(report.sessionsDeleted).toBe(0);
    expect(report.errors).toContainEqual({
      id: 'session-cleanup',
      error: 'database locked',
    });
  });
});

describe('SESSION_RETENTION_DAYS', () => {
  test('exports configuration constant', () => {
    expect(typeof SESSION_RETENTION_DAYS).toBe('number');
    expect(SESSION_RETENTION_DAYS).toBeGreaterThan(0);
  });

  test('has default value of 30', () => {
    expect(SESSION_RETENTION_DAYS).toBe(30);
  });
});

describe('scheduler lifecycle', () => {
  beforeEach(() => {
    stopCleanupScheduler(); // Ensure clean state
    mockListAllActiveWithCodebase.mockClear();
    mockListAllActiveWithCodebase.mockResolvedValue([]); // Prevent actual cleanup during tests
  });

  afterAll(() => {
    stopCleanupScheduler(); // Clean up after tests
  });

  test('starts and stops scheduler', () => {
    expect(isSchedulerRunning()).toBe(false);

    startCleanupScheduler();
    expect(isSchedulerRunning()).toBe(true);

    stopCleanupScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });

  test('prevents multiple scheduler instances', () => {
    startCleanupScheduler();
    startCleanupScheduler(); // Should warn but not create second

    expect(isSchedulerRunning()).toBe(true);

    stopCleanupScheduler();
    expect(isSchedulerRunning()).toBe(false);
  });
});

// =============================================================================
// Phase 3D: Worktree Limits and User Feedback Tests
// =============================================================================

describe('getWorktreeStatusBreakdown', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockGetDefaultBranch.mockClear();
    mockIsBranchMerged.mockClear();
    mockListByCodebaseWithAge.mockClear();
    // Reset defaults
    mockGetDefaultBranch.mockResolvedValue('main');
    mockIsBranchMerged.mockResolvedValue(false);
  });

  test('returns correct breakdown with mixed environments', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-1',
        branch_name: 'merged-branch',
        created_by_platform: 'github',
        days_since_activity: 5,
        working_path: '/path1',
        status: 'active',
      },
      {
        id: 'env-2',
        branch_name: 'stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        working_path: '/path2',
        status: 'active',
      },
      {
        id: 'env-3',
        branch_name: 'active-branch',
        created_by_platform: 'github',
        days_since_activity: 2,
        working_path: '/path3',
        status: 'active',
      },
      {
        id: 'env-4',
        branch_name: 'telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 60,
        working_path: '/path4',
        status: 'active',
      },
    ]);

    // getDefaultBranch returns 'main' (default from beforeEach)
    // Check merged for env-1 (merged)
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // env-2, env-3, env-4 use default (false)

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.total).toBe(4);
    expect(breakdown.merged).toBe(1);
    expect(breakdown.stale).toBe(1); // env-2 is stale (30 days), env-4 is Telegram so not counted as stale
    expect(breakdown.active).toBe(2); // env-3 active, env-4 Telegram (counted as active, not stale)
  });

  test('excludes telegram from stale count', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-telegram',
        branch_name: 'telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 100,
        working_path: '/path',
        status: 'active',
      },
    ]);

    // getDefaultBranch returns 'main' (default from beforeEach)
    // isBranchMerged returns false (default from beforeEach)

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.stale).toBe(0);
    expect(breakdown.active).toBe(1);
  });

  test('resolveMainBranch is called for merge checking in getWorktreeStatusBreakdown', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const tempDir = await mkdtemp(join(tmpdir(), 'archon-cleanup-test-'));
    try {
      await mkdir(join(tempDir, '.archon'), { recursive: true });
      await writeFile(join(tempDir, '.archon', 'config.yaml'), 'worktree:\n  baseBranch: trunk\n');

      mockListByCodebaseWithAge.mockResolvedValueOnce([
        {
          id: 'env-breakdown-test',
          branch_name: 'feature-b',
          created_by_platform: 'github',
          days_since_activity: 5,
          working_path: '/path-b',
          status: 'active',
        },
      ]);
      mockIsBranchMerged.mockResolvedValueOnce(false);

      const breakdown = await getWorktreeStatusBreakdown('codebase-1', tempDir);

      // Should use 'trunk' from config, NOT call getDefaultBranch
      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      expect(mockIsBranchMerged).toHaveBeenCalledWith(tempDir, 'feature-b', 'trunk');
      expect(breakdown.active).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('returns empty breakdown for empty codebase', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([]);
    // getDefaultBranch returns 'main' (default from beforeEach)

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.total).toBe(0);
    expect(breakdown.merged).toBe(0);
    expect(breakdown.stale).toBe(0);
    expect(breakdown.active).toBe(0);
  });
});

describe('cleanupMergedWorktrees', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockGetConversationsUsingEnv.mockClear();
    mockGetById.mockClear();
    mockListByCodebase.mockClear();
    mockGetDefaultBranch.mockClear();
    mockIsBranchMerged.mockClear();
    mockHasUncommittedChanges.mockClear();
    mockWorktreeExists.mockClear();
    mockGetCodebase.mockClear();
    mockUpdateStatus.mockClear();
    // Reset defaults
    mockGetDefaultBranch.mockResolvedValue('main');
    mockIsBranchMerged.mockResolvedValue(false);
    mockIsPatchEquivalent.mockReset();
    mockIsPatchEquivalent.mockResolvedValue(false);
    mockGetPrState.mockReset();
    mockGetPrState.mockResolvedValue('NONE');
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockWorktreeExists.mockResolvedValue(false);
  });

  test('removes merged branches without uncommitted changes', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-merged',
        branch_name: 'merged-branch',
        working_path: '/workspace/repo/worktrees/merged-branch',
        status: 'active',
      },
    ]);

    // getDefaultBranch returns 'main' (default from beforeEach)
    // isBranchMerged returns true for this branch
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default from beforeEach)
    // No conversations
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce({
      id: 'env-merged',
      working_path: '/workspace/repo/worktrees/merged-branch',
      status: 'active',
    });
    // removeEnvironment: worktreeExists returns true (path exists)
    mockWorktreeExists.mockResolvedValueOnce(true);
    // removeEnvironment: hasUncommittedChanges returns false (default)

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('merged-branch');
    expect(result.skipped).toHaveLength(0);
    // Verify deleteRemoteBranch: true is passed for merged branches
    expect(mockDestroy).toHaveBeenCalledWith(
      '/workspace/repo/worktrees/merged-branch',
      expect.objectContaining({ deleteRemoteBranch: true })
    );
  });

  test('skips merged branches with uncommitted changes', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-dirty',
        branch_name: 'dirty-branch',
        working_path: '/workspace/repo/worktrees/dirty-branch',
        status: 'active',
      },
    ]);

    // getDefaultBranch returns 'main' (default from beforeEach)
    // isBranchMerged returns true
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // Has uncommitted changes
    mockHasUncommittedChanges.mockResolvedValueOnce(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'dirty-branch',
      reason: 'has uncommitted changes',
    });
  });

  test('skips merged branches with conversation references', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-in-use',
        branch_name: 'in-use-branch',
        working_path: '/workspace/repo/worktrees/in-use-branch',
        status: 'active',
      },
    ]);

    // getDefaultBranch returns 'main' (default from beforeEach)
    // isBranchMerged returns true
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default from beforeEach)
    // Has conversation references
    mockGetConversationsUsingEnv.mockResolvedValueOnce(['conv-1', 'conv-2']);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'in-use-branch',
      reason: 'still used by 2 conversation(s)',
    });
  });

  test('removes branch when git-cherry detects squash-merge', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-squash',
        branch_name: 'squash-branch',
        working_path: '/workspace/repo/worktrees/squash-branch',
        status: 'active',
      },
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(true);
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    mockGetById.mockResolvedValueOnce({
      id: 'env-squash',
      working_path: '/workspace/repo/worktrees/squash-branch',
      status: 'active',
    });
    mockWorktreeExists.mockResolvedValueOnce(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('squash-branch');
  });

  test('removes branch when PR is MERGED', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-pr-merged',
        branch_name: 'pr-merged-branch',
        working_path: '/workspace/repo/worktrees/pr-merged-branch',
        status: 'active',
      },
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(false);
    mockGetPrState.mockResolvedValueOnce('MERGED');
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    mockGetById.mockResolvedValueOnce({
      id: 'env-pr-merged',
      working_path: '/workspace/repo/worktrees/pr-merged-branch',
      status: 'active',
    });
    mockWorktreeExists.mockResolvedValueOnce(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('pr-merged-branch');
  });

  test('skips branch when PR is OPEN with clear reason', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-pr-open',
        branch_name: 'pr-open-branch',
        working_path: '/workspace/repo/worktrees/pr-open-branch',
        status: 'active',
      },
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(false);
    mockGetPrState.mockResolvedValueOnce('OPEN');

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'pr-open-branch',
      reason: 'PR is open (active review)',
    });
  });

  test('skips branch when PR is CLOSED and includeClosed=false', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-pr-closed',
        branch_name: 'pr-closed-branch',
        working_path: '/workspace/repo/worktrees/pr-closed-branch',
        status: 'active',
      },
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(false);
    mockGetPrState.mockResolvedValueOnce('CLOSED');

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
  });

  test('removes branch when PR is CLOSED and includeClosed=true', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-pr-closed-include',
        branch_name: 'pr-closed-branch',
        working_path: '/workspace/repo/worktrees/pr-closed-branch',
        status: 'active',
      },
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(false);
    mockGetPrState.mockResolvedValueOnce('CLOSED');
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    mockGetById.mockResolvedValueOnce({
      id: 'env-pr-closed-include',
      working_path: '/workspace/repo/worktrees/pr-closed-branch',
      status: 'active',
    });
    mockWorktreeExists.mockResolvedValueOnce(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo', {
      includeClosed: true,
    });

    expect(result.removed).toContain('pr-closed-branch');
  });

  test('skips branch when no PR and not merged', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-none',
        branch_name: 'orphan-branch',
        working_path: '/workspace/repo/worktrees/orphan-branch',
        status: 'active',
      },
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(false);
    mockGetPrState.mockResolvedValueOnce('NONE');

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips branch when isPatchEquivalent throws unexpected error', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-error',
        branch_name: 'error-branch',
        working_path: '/workspace/repo/worktrees/error-branch',
        status: 'active',
      },
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockRejectedValueOnce(new Error('permission denied'));

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual(
      expect.objectContaining({
        branchName: 'error-branch',
        reason: expect.stringContaining('merge check failed'),
      })
    );
  });
});

describe('onConversationClosed', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockUpdateStatus.mockClear();
    mockGetById.mockClear();
    mockGetCodebase.mockClear();
    mockGetConversationsUsingEnv.mockClear();
    mockGetConversationByPlatformId.mockClear();
    mockGetActiveSession.mockClear();
    mockUpdateConversation.mockClear();
    mockWorktreeExists.mockClear();
    mockHasUncommittedChanges.mockClear();
    // Reset defaults
    mockWorktreeExists.mockResolvedValue(false);
    mockHasUncommittedChanges.mockResolvedValue(false);
  });

  test('deactivates session with conversation-closed reason', async () => {
    mockGetConversationByPlatformId.mockResolvedValueOnce({
      id: 'conv-active-session',
      isolation_env_id: 'env-with-session',
    });

    mockGetActiveSession.mockResolvedValueOnce({
      id: 'session-to-close',
      conversation_id: 'conv-active-session',
      active: true,
    });
    mockDeactivateSession.mockResolvedValueOnce(undefined);

    mockGetById.mockResolvedValueOnce({
      id: 'env-with-session',
      codebase_id: 'codebase-1',
      working_path: '/workspace/worktrees/pr-200',
      branch_name: 'feature-y',
      status: 'active',
    });

    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);

    mockGetById.mockResolvedValueOnce({
      id: 'env-with-session',
      codebase_id: 'codebase-1',
      working_path: '/workspace/worktrees/pr-200',
      branch_name: 'feature-y',
      status: 'active',
    });

    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });

    // removeEnvironment: worktreeExists returns false (default from beforeEach)

    await onConversationClosed('github', 'owner/repo#200');

    expect(mockDeactivateSession).toHaveBeenCalledWith('session-to-close', 'conversation-closed');
  });

  test('passes deleteRemoteBranch: true when merged option is set', async () => {
    // Conversation with isolation env
    mockGetConversationByPlatformId.mockResolvedValueOnce({
      id: 'conv-1',
      isolation_env_id: 'env-merged-pr',
    });

    // No active session
    mockGetActiveSession.mockResolvedValueOnce(null);

    // Environment exists
    mockGetById.mockResolvedValueOnce({
      id: 'env-merged-pr',
      codebase_id: 'codebase-1',
      working_path: '/workspace/worktrees/pr-100',
      branch_name: 'feature-x',
      status: 'active',
    });

    // No other conversations use this env
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);

    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce({
      id: 'env-merged-pr',
      codebase_id: 'codebase-1',
      working_path: '/workspace/worktrees/pr-100',
      branch_name: 'feature-x',
      status: 'active',
    });

    // removeEnvironment: getCodebase
    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });

    // removeEnvironment: worktreeExists returns false (default from beforeEach)

    await onConversationClosed('github', 'owner/repo#100', { merged: true });

    expect(mockDestroy).toHaveBeenCalledWith('/workspace/worktrees/pr-100', {
      force: false,
      branchName: 'feature-x',
      canonicalRepoPath: '/workspace/repo',
      deleteRemoteBranch: true,
    });
  });

  test('does not pass deleteRemoteBranch when merged is not set', async () => {
    // Conversation with isolation env
    mockGetConversationByPlatformId.mockResolvedValueOnce({
      id: 'conv-2',
      isolation_env_id: 'env-closed-pr',
    });

    // No active session
    mockGetActiveSession.mockResolvedValueOnce(null);

    // Environment exists
    mockGetById.mockResolvedValueOnce({
      id: 'env-closed-pr',
      codebase_id: 'codebase-1',
      working_path: '/workspace/worktrees/pr-101',
      branch_name: 'feature-y',
      status: 'active',
    });

    // No other conversations use this env
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);

    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce({
      id: 'env-closed-pr',
      codebase_id: 'codebase-1',
      working_path: '/workspace/worktrees/pr-101',
      branch_name: 'feature-y',
      status: 'active',
    });

    // removeEnvironment: getCodebase
    mockGetCodebase.mockResolvedValueOnce({
      id: 'codebase-1',
      name: 'test-repo',
      default_cwd: '/workspace/repo',
    });

    // removeEnvironment: worktreeExists returns false (default from beforeEach)

    await onConversationClosed('github', 'owner/repo#101');

    expect(mockDestroy).toHaveBeenCalledWith('/workspace/worktrees/pr-101', {
      force: false,
      branchName: 'feature-y',
      canonicalRepoPath: '/workspace/repo',
      deleteRemoteBranch: undefined,
    });
  });
});

describe('cleanupStaleWorktrees', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockGetConversationsUsingEnv.mockClear();
    mockGetById.mockClear();
    mockListByCodebaseWithAge.mockClear();
    mockHasUncommittedChanges.mockClear();
    mockWorktreeExists.mockClear();
    mockGetCodebase.mockClear();
    mockUpdateStatus.mockClear();
    // Reset defaults
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockWorktreeExists.mockResolvedValue(false);
  });

  test('removes stale worktrees without uncommitted changes', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-stale',
        branch_name: 'stale-branch',
        working_path: '/workspace/repo/worktrees/stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        status: 'active',
      },
    ]);

    // hasUncommittedChanges returns false (default from beforeEach)
    // No conversations
    mockGetConversationsUsingEnv.mockResolvedValueOnce([]);
    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce({
      id: 'env-stale',
      working_path: '/workspace/repo/worktrees/stale-branch',
      status: 'active',
    });
    // removeEnvironment: worktreeExists returns true (path exists)
    mockWorktreeExists.mockResolvedValueOnce(true);
    // removeEnvironment: hasUncommittedChanges returns false (default)

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('stale-branch');
  });

  test('skips telegram worktrees even if old', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-telegram',
        branch_name: 'telegram-branch',
        working_path: '/workspace/repo/worktrees/telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 100,
        status: 'active',
      },
    ]);

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips worktrees that are not stale', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-recent',
        branch_name: 'recent-branch',
        working_path: '/workspace/repo/worktrees/recent-branch',
        created_by_platform: 'slack',
        days_since_activity: 5, // Less than 14 days
        status: 'active',
      },
    ]);

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips stale worktrees with uncommitted changes', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      {
        id: 'env-dirty-stale',
        branch_name: 'dirty-stale-branch',
        working_path: '/workspace/repo/worktrees/dirty-stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        status: 'active',
      },
    ]);

    // Has uncommitted changes
    mockHasUncommittedChanges.mockResolvedValueOnce(true);

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'dirty-stale-branch',
      reason: 'has uncommitted changes',
    });
  });
});

describe('resolveMainBranch config override', () => {
  beforeEach(() => {
    mockListByCodebase.mockClear();
    mockIsBranchMerged.mockClear();
    mockIsBranchMerged.mockResolvedValue(false);
    mockIsPatchEquivalent.mockClear();
    mockIsPatchEquivalent.mockResolvedValue(false);
    mockGetPrState.mockClear();
    mockGetPrState.mockResolvedValue('NONE' as PrStateValue);
    mockGetDefaultBranch.mockClear();
    mockGetDefaultBranch.mockResolvedValue('main');
    mockHasUncommittedChanges.mockClear();
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockGetConversationsUsingEnv.mockClear();
    mockGetById.mockClear();
    mockWorktreeExists.mockClear();
    mockWorktreeExists.mockResolvedValue(false);
    mockDestroy.mockClear();
    mockUpdateStatus.mockClear();
  });

  test('uses worktree.baseBranch from .archon/config.yaml instead of auto-detection', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const tempDir = await mkdtemp(join(tmpdir(), 'archon-cleanup-test-'));
    try {
      await mkdir(join(tempDir, '.archon'), { recursive: true });
      await writeFile(join(tempDir, '.archon', 'config.yaml'), 'worktree:\n  baseBranch: master\n');

      // Mock a merged environment
      mockListByCodebase.mockResolvedValueOnce([
        {
          id: 'env-1',
          branch_name: 'feature-x',
          working_path: join(tempDir, 'worktrees', 'feature-x'),
          status: 'active',
        },
      ]);
      mockIsBranchMerged.mockResolvedValueOnce(true);
      mockHasUncommittedChanges.mockResolvedValueOnce(false);
      mockGetPrState.mockResolvedValueOnce('MERGED');
      mockDestroy.mockResolvedValueOnce({
        worktreeRemoved: true,
        branchDeleted: true,
        remoteBranchDeleted: true,
        directoryClean: true,
        warnings: [],
      });
      mockUpdateStatus.mockResolvedValueOnce(undefined);

      await cleanupMergedWorktrees('codebase-1', tempDir);

      // getDefaultBranch should NOT have been called — config was used
      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      // isBranchMerged should have been called with 'master' (from config)
      expect(mockIsBranchMerged).toHaveBeenCalledWith(tempDir, 'feature-x', 'master');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('falls back to getDefaultBranch when config has invalid YAML syntax', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const tempDir = await mkdtemp(join(tmpdir(), 'archon-cleanup-test-'));
    try {
      await mkdir(join(tempDir, '.archon'), { recursive: true });
      // Write invalid YAML that will cause a parse error
      await writeFile(join(tempDir, '.archon', 'config.yaml'), ': invalid: yaml: [unterminated');

      mockListByCodebase.mockResolvedValueOnce([
        {
          id: 'env-bad-yaml',
          branch_name: 'feature-z',
          working_path: join(tempDir, 'worktrees', 'feature-z'),
          status: 'active',
        },
      ]);
      mockGetDefaultBranch.mockResolvedValueOnce('main');

      await cleanupMergedWorktrees('codebase-1', tempDir);

      // Should fall back to getDefaultBranch since YAML parse failed
      expect(mockGetDefaultBranch).toHaveBeenCalledTimes(1);
      expect(mockGetDefaultBranch).toHaveBeenCalledWith(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('falls back to getDefaultBranch when baseBranch is non-string type', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const tempDir = await mkdtemp(join(tmpdir(), 'archon-cleanup-test-'));
    try {
      await mkdir(join(tempDir, '.archon'), { recursive: true });
      // baseBranch is a number, not a string — .trim() will throw at runtime
      await writeFile(join(tempDir, '.archon', 'config.yaml'), 'worktree:\n  baseBranch: 42\n');

      mockListByCodebase.mockResolvedValueOnce([
        {
          id: 'env-numeric-base',
          branch_name: 'feature-w',
          working_path: join(tempDir, 'worktrees', 'feature-w'),
          status: 'active',
        },
      ]);
      mockGetDefaultBranch.mockResolvedValueOnce('main');

      await cleanupMergedWorktrees('codebase-1', tempDir);

      // baseBranch=42 is a number at runtime; calling .trim() on it throws TypeError,
      // which is caught and falls back to getDefaultBranch
      expect(mockGetDefaultBranch).toHaveBeenCalledTimes(1);
      expect(mockGetDefaultBranch).toHaveBeenCalledWith(tempDir);
      expect(mockIsBranchMerged).toHaveBeenCalledWith(tempDir, 'feature-w', 'main');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('falls back to getDefaultBranch when baseBranch is null', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('fs/promises');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const tempDir = await mkdtemp(join(tmpdir(), 'archon-cleanup-test-'));
    try {
      await mkdir(join(tempDir, '.archon'), { recursive: true });
      // baseBranch is explicitly null
      await writeFile(join(tempDir, '.archon', 'config.yaml'), 'worktree:\n  baseBranch: null\n');

      mockListByCodebase.mockResolvedValueOnce([
        {
          id: 'env-null-base',
          branch_name: 'feature-v',
          working_path: join(tempDir, 'worktrees', 'feature-v'),
          status: 'active',
        },
      ]);
      mockGetDefaultBranch.mockResolvedValueOnce('develop');

      await cleanupMergedWorktrees('codebase-1', tempDir);

      // null?.trim() returns undefined, so should fall back
      expect(mockGetDefaultBranch).toHaveBeenCalledTimes(1);
      expect(mockIsBranchMerged).toHaveBeenCalledWith(tempDir, 'feature-v', 'develop');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('falls back to getDefaultBranch when no config exists', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      {
        id: 'env-fallback',
        branch_name: 'feature-y',
        working_path: '/nonexistent/repo/worktrees/feature-y',
        status: 'active',
      },
    ]);
    mockGetDefaultBranch.mockResolvedValueOnce('main');

    await cleanupMergedWorktrees('codebase-1', '/nonexistent/repo');

    expect(mockGetDefaultBranch).toHaveBeenCalledTimes(1);
    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/nonexistent/repo');
    expect(mockIsBranchMerged.mock.calls[0][2]).toBe('main');
  });
});

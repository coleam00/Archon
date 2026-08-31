import { mock, describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { toBranchName } from '@archon/git';
import type {
  ContainerBackend,
  IIsolationProvider,
  IsolationEnvironmentRow,
} from '@archon/isolation';
import type { Codebase, Conversation, Session } from '../types';
import type * as Git from '@archon/git';
import type * as Isolation from '@archon/isolation';
import type * as IsolationEnvironmentDb from '../db/isolation-environments';
import type * as WorkflowDb from '../db/workflows';
import type * as ConversationDb from '../db/conversations';
import type * as SessionDb from '../db/sessions';
import type * as CodebaseDb from '../db/codebases';
import type * as ConfigLoader from '../config/config-loader';

function makeEnvironment(
  overrides: Partial<IsolationEnvironmentRow> = {}
): IsolationEnvironmentRow {
  return {
    id: 'env-1',
    codebase_id: 'codebase-123',
    workflow_type: 'task',
    workflow_id: 'task-1',
    provider: 'worktree',
    working_path: '/workspace/worktrees/task-1',
    branch_name: 'task-1',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'test',
    created_by_user_id: null,
    metadata: {},
    ...overrides,
  };
}

function makeCodebase(overrides: Partial<Codebase> = {}): Codebase {
  return {
    id: 'codebase-123',
    name: 'test-repo',
    repository_url: 'https://github.com/test/repo.git',
    default_cwd: '/workspace/repo',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    platform_type: 'web',
    platform_conversation_id: 'web-conv-1',
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: null,
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
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
    ...overrides,
  };
}

function makeEnvironmentWithCodebase(
  overrides: Partial<
    IsolationEnvironmentRow & {
      codebase_default_cwd: string;
      codebase_repository_url: string | null;
    }
  > = {}
): IsolationEnvironmentRow & {
  codebase_default_cwd: string;
  codebase_repository_url: string | null;
} {
  return {
    ...makeEnvironment(),
    codebase_default_cwd: '/workspace/repo',
    codebase_repository_url: 'https://github.com/test/repo.git',
    ...overrides,
  };
}

function makeEnvironmentWithAge(
  overrides: Partial<IsolationEnvironmentRow & { days_since_activity: number }> = {}
): IsolationEnvironmentRow & { days_since_activity: number } {
  return { ...makeEnvironment(), days_since_activity: 0, ...overrides };
}

function makeContainerEnvironment(
  overrides: Partial<
    IsolationEnvironmentRow & { codebase_name: string; days_since_created: number }
  > = {}
): IsolationEnvironmentRow & { codebase_name: string; days_since_created: number } {
  return {
    ...makeEnvironment({ provider: 'container' }),
    codebase_name: 'test-repo',
    days_since_created: 30,
    ...overrides,
  };
}
// Mock logger to suppress noisy output during tests
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Mock @archon/git - the cleanup service imports git functions from @archon/git
const mockExecFileAsync = mock<typeof Git.execFileAsync>(() =>
  Promise.resolve({ stdout: '', stderr: '' })
);
const mockHasUncommittedChanges = mock<typeof Git.hasUncommittedChanges>(() =>
  Promise.resolve(false)
);
const mockWorktreeExists = mock<typeof Git.worktreeExists>(() => Promise.resolve(false));
const mockGetDefaultBranch = mock<typeof Git.getDefaultBranch>(() =>
  Promise.resolve(toBranchName('main'))
);
const mockIsBranchMerged = mock<typeof Git.isBranchMerged>(() => Promise.resolve(false));
const mockIsPatchEquivalent = mock<typeof Git.isPatchEquivalent>(() => Promise.resolve(false));
const mockGetLastCommitDate = mock<typeof Git.getLastCommitDate>(() => Promise.resolve(null));
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
const mockDestroy = mock<IIsolationProvider['destroy']>(() =>
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
const mockGetPrState = mock<typeof Isolation.getPrState>(() => Promise.resolve('NONE'));
const mockContainerDestroy = mock<ContainerBackend['destroy']>(() => Promise.resolve());
class MockContainerBackend {
  destroy = mockContainerDestroy;
}
mock.module('@archon/isolation', () => ({
  getIsolationProvider: () => ({
    destroy: mockDestroy,
  }),
  getPrState: mockGetPrState,
  ContainerBackend: MockContainerBackend,
  // Loaded transitively via the orchestrator → child-isolation-resolver (PR-A).
  classifyIsolationError: (err: Error) => err.message,
}));

// Mock isolation-environments DB
const mockListAllActiveWithCodebase = mock<typeof IsolationEnvironmentDb.listAllActiveWithCodebase>(
  () => Promise.resolve([])
);
const mockUpdateStatus = mock<typeof IsolationEnvironmentDb.updateStatus>(() => Promise.resolve());
const mockGetLiveRunOwningEnv = mock<typeof IsolationEnvironmentDb.getLiveRunOwningEnv>(() =>
  Promise.resolve(null)
);
const mockGetById = mock<typeof IsolationEnvironmentDb.getById>(() => Promise.resolve(null));
const mockListByCodebase = mock<typeof IsolationEnvironmentDb.listByCodebase>(() =>
  Promise.resolve([])
);
const mockListByCodebaseWithAge = mock<typeof IsolationEnvironmentDb.listByCodebaseWithAge>(() =>
  Promise.resolve([])
);
const mockCountActiveByCodebase = mock<typeof IsolationEnvironmentDb.countActiveByCodebase>(() =>
  Promise.resolve(0)
);
const mockListActiveContainerEnvironments = mock<
  typeof IsolationEnvironmentDb.listActiveContainerEnvironments
>(() => Promise.resolve([]));
mock.module('../db/isolation-environments', () => ({
  listAllActiveWithCodebase: mockListAllActiveWithCodebase,
  updateStatus: mockUpdateStatus,
  getLiveRunOwningEnv: mockGetLiveRunOwningEnv,
  getById: mockGetById,
  listByCodebase: mockListByCodebase,
  listByCodebaseWithAge: mockListByCodebaseWithAge,
  countActiveByCodebase: mockCountActiveByCodebase,
  listActiveContainerEnvironments: mockListActiveContainerEnvironments,
  createIsolationStore: () => ({}),
}));

// Mock workflows DB (getRunByIsolationEnvId — the run id/status `isolation list`
// displays for a container env; the reaper's own lock is getLiveRunOwningEnv)
const mockGetRunByIsolationEnvId = mock<typeof WorkflowDb.getRunByIsolationEnvId>(() =>
  Promise.resolve(null)
);
mock.module('../db/workflows', () => ({
  getRunByIsolationEnvId: mockGetRunByIsolationEnvId,
}));

// Mock conversations DB
const mockGetConversationByPlatformId = mock<typeof ConversationDb.getConversationByPlatformId>(
  () => Promise.resolve(null)
);
const mockUpdateConversation = mock<typeof ConversationDb.updateConversation>(() =>
  Promise.resolve()
);
mock.module('../db/conversations', () => ({
  getConversationByPlatformId: mockGetConversationByPlatformId,
  updateConversation: mockUpdateConversation,
}));

// Mock sessions DB
const mockGetActiveSession = mock<typeof SessionDb.getActiveSession>(() => Promise.resolve(null));
const mockDeactivateSession = mock<typeof SessionDb.deactivateSession>(() => Promise.resolve());
const mockDeleteOldSessions = mock<typeof SessionDb.deleteOldSessions>(() => Promise.resolve(0));
mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
  deleteOldSessions: mockDeleteOldSessions,
}));

// Mock codebases DB
const mockGetCodebase = mock<typeof CodebaseDb.getCodebase>(() => Promise.resolve(null));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

// Mock config-loader (loadRepoConfig) - cleanup-service consults
// .archon/config.yaml worktree.baseBranch before falling back to git detection.
const mockLoadRepoConfig = mock<typeof ConfigLoader.loadRepoConfig>(() => Promise.resolve({}));
mock.module('../config/config-loader', () => ({
  loadRepoConfig: mockLoadRepoConfig,
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
  cleanupContainerEnvironments,
  SESSION_RETENTION_DAYS,
} from './cleanup-service';

describe('cleanupContainerEnvironments — H3 fail-closed on lookup error', () => {
  const oldRow = makeContainerEnvironment({
    id: 'env-1',
    codebase_name: 'ops',
    working_path: '/tmp/ops',
    days_since_created: 30,
  });
  beforeEach(() => {
    mockListActiveContainerEnvironments.mockReset();
    mockGetLiveRunOwningEnv.mockReset();
    mockGetLiveRunOwningEnv.mockImplementation(() => Promise.resolve(null));
    mockContainerDestroy.mockReset();
    mockContainerDestroy.mockImplementation(() => Promise.resolve());
  });

  test('does NOT destroy when the run lookup throws — reports the error instead', async () => {
    mockListActiveContainerEnvironments.mockImplementation(() => Promise.resolve([oldRow]));
    mockGetLiveRunOwningEnv.mockImplementation(() => Promise.reject(new Error('DB down')));

    const report = await cleanupContainerEnvironments(7);
    expect(mockContainerDestroy).not.toHaveBeenCalled();
    expect(report.removed).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.error).toMatch(/lookup failed/);
  });

  test('never reaps a PAUSED run’s container (awaited state)', async () => {
    mockListActiveContainerEnvironments.mockImplementation(() => Promise.resolve([oldRow]));
    mockGetLiveRunOwningEnv.mockImplementation(() =>
      Promise.resolve({ id: 'run-1', status: 'paused' })
    );
    const report = await cleanupContainerEnvironments(7);
    expect(mockContainerDestroy).not.toHaveBeenCalled();
    expect(report.skipped).toHaveLength(1);
  });

  // The reaper reads the same lock the worktree sweeps use, so a failed run's
  // container survives for `--resume` exactly as a paused one does.
  test('never reaps a FAILED run’s container (still resumable)', async () => {
    mockListActiveContainerEnvironments.mockImplementation(() => Promise.resolve([oldRow]));
    mockGetLiveRunOwningEnv.mockImplementation(() =>
      Promise.resolve({ id: 'run-1', status: 'failed' })
    );
    const report = await cleanupContainerEnvironments(7);
    expect(mockContainerDestroy).not.toHaveBeenCalled();
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.reason).toBe('run run-1 is failed');
  });

  test('reaps a container no run can claim, older than the threshold', async () => {
    mockListActiveContainerEnvironments.mockImplementation(() => Promise.resolve([oldRow]));
    mockGetLiveRunOwningEnv.mockImplementation(() => Promise.resolve(null));
    const report = await cleanupContainerEnvironments(7);
    expect(mockContainerDestroy).toHaveBeenCalledTimes(1);
    expect(report.removed).toEqual(['env-1']);
  });
});

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
    mockLoadRepoConfig.mockClear();
    // Reset defaults
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockWorktreeExists.mockResolvedValue(false);
    mockGetDefaultBranch.mockResolvedValue(toBranchName('main'));
    mockIsBranchMerged.mockResolvedValue(false);
    mockGetLastCommitDate.mockResolvedValue(null);
    mockLoadRepoConfig.mockResolvedValue({});
  });

  describe('removeEnvironment', () => {
    test('calls destroy with canonicalRepoPath even when directory is missing', async () => {
      const envId = 'env-missing-dir';

      mockGetById.mockResolvedValueOnce(
        makeEnvironment({
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
        })
      );

      // Mock codebase fetch to get canonical repo path
      mockGetCodebase.mockResolvedValueOnce(
        makeCodebase({
          id: 'codebase-123',
          name: 'test-repo',
          default_cwd: '/workspace/repo',
        })
      );

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

      mockGetById.mockResolvedValueOnce(
        makeEnvironment({
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
        })
      );

      // Mock codebase fetch
      mockGetCodebase.mockResolvedValueOnce(
        makeCodebase({
          id: 'codebase-123',
          name: 'test-repo',
          default_cwd: '/workspace/repo',
        })
      );

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

      mockGetById.mockResolvedValueOnce(
        makeEnvironment({
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
        })
      );

      mockGetCodebase.mockResolvedValueOnce(
        makeCodebase({
          id: 'codebase-123',
          name: 'test-repo',
          default_cwd: '/workspace/repo',
        })
      );

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

      mockGetById.mockResolvedValueOnce(
        makeEnvironment({
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
        })
      );

      mockGetCodebase.mockResolvedValueOnce(
        makeCodebase({
          id: 'codebase-123',
          name: 'test-repo',
          default_cwd: '/workspace/repo',
        })
      );

      // worktreeExists returns false (default)

      await removeEnvironment(envId, { deleteRemoteBranch: true });

      expect(mockDestroy).toHaveBeenCalledWith('/workspace/worktrees/pr-99', {
        force: undefined,
        branchName: 'feature-branch',
        canonicalRepoPath: '/workspace/repo',
        deleteRemoteBranch: true,
        remote: 'origin',
      });
      expect(mockUpdateStatus).toHaveBeenCalledWith(envId, 'destroyed');
    });

    test('passes configured worktree.remote to provider.destroy for remote branch deletion', async () => {
      const envId = 'env-remote-custom';

      mockGetById.mockResolvedValueOnce(
        makeEnvironment({
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
        })
      );

      mockGetCodebase.mockResolvedValueOnce(
        makeCodebase({
          id: 'codebase-123',
          name: 'test-repo',
          default_cwd: '/workspace/repo',
        })
      );
      mockLoadRepoConfig.mockResolvedValueOnce({ worktree: { remote: 'upstream' } });

      await removeEnvironment(envId, { deleteRemoteBranch: true });

      expect(mockDestroy).toHaveBeenCalledWith(
        '/workspace/worktrees/pr-99',
        expect.objectContaining({ deleteRemoteBranch: true, remote: 'upstream' })
      );
    });

    test('does not pass deleteRemoteBranch when not specified', async () => {
      const envId = 'env-no-remote-delete';

      mockGetById.mockResolvedValueOnce(
        makeEnvironment({
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
        })
      );

      mockGetCodebase.mockResolvedValueOnce(
        makeCodebase({
          id: 'codebase-123',
          name: 'test-repo',
          default_cwd: '/workspace/repo',
        })
      );

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

      mockGetById.mockResolvedValueOnce(
        makeEnvironment({
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
        })
      );

      mockGetCodebase.mockResolvedValueOnce(
        makeCodebase({
          id: 'codebase-123',
          name: 'test-repo',
          default_cwd: '/workspace/repo',
        })
      );

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

      mockGetById.mockResolvedValueOnce(
        makeEnvironment({
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
        })
      );

      mockGetCodebase.mockResolvedValueOnce(
        makeCodebase({
          id: 'codebase-123',
          name: 'test-repo',
          default_cwd: '/workspace/repo',
        })
      );

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

      mockGetById.mockResolvedValueOnce(
        makeEnvironment({
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
        })
      );

      // Mock codebase fetch
      mockGetCodebase.mockResolvedValueOnce(
        makeCodebase({
          id: 'codebase-123',
          name: 'test-repo',
          default_cwd: '/workspace/repo',
        })
      );

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
    mockGetLiveRunOwningEnv.mockClear();
    mockGetById.mockClear();
    mockGetCodebase.mockClear();
    mockDeleteOldSessions.mockClear();
    mockLoadRepoConfig.mockClear();
    mockIsPatchEquivalent.mockClear();
    // Reset defaults
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockWorktreeExists.mockResolvedValue(false);
    mockGetDefaultBranch.mockResolvedValue(toBranchName('main'));
    mockIsBranchMerged.mockResolvedValue(false);
    mockIsPatchEquivalent.mockResolvedValue(false);
    mockGetLastCommitDate.mockResolvedValue(null);
    mockLoadRepoConfig.mockResolvedValue({});
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
      makeEnvironmentWithCodebase({
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
      }),
    ]);
    // worktreeExists returns false for both calls (runScheduledCleanup + removeEnvironment)
    // (already default)
    // removeEnvironment: getById returns the env
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-123',
        codebase_id: 'codebase-1',
        working_path: '/nonexistent/path',
        branch_name: 'issue-42',
        status: 'active',
      })
    );
    // removeEnvironment: getCodebase for canonical repo path
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

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
      makeEnvironmentWithCodebase({
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
      }),
    ]);
    // worktreeExists returns true (path exists)
    mockWorktreeExists.mockResolvedValue(true);
    // getDefaultBranch returns 'main' (default)
    // isBranchMerged returns true
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default)
    // No conversations using it
    // For removeEnvironment: getById returns the env
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-456',
        codebase_id: 'codebase-1',
        working_path: '/workspace/repo/worktrees/pr-99',
        status: 'active',
      })
    );
    // removeEnvironment: getCodebase for canonical repo path
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-456 (merged)');
  });

  test('passes deleteRemoteBranch: true for merged branches in scheduled cleanup', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
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
      }),
    ]);
    // worktreeExists returns true
    mockWorktreeExists.mockResolvedValue(true);
    // getDefaultBranch returns 'main' (default)
    // isBranchMerged returns true
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default)
    // No conversations
    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-merged-remote',
        codebase_id: 'codebase-1',
        working_path: '/workspace/repo/worktrees/pr-50',
        branch_name: 'pr-50',
        status: 'active',
      })
    );
    // removeEnvironment: getCodebase
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

    await runScheduledCleanup();

    // Verify deleteRemoteBranch: true was passed through
    expect(mockDestroy).toHaveBeenCalledWith('/workspace/repo/worktrees/pr-50', {
      force: false,
      branchName: 'pr-50',
      canonicalRepoPath: '/workspace/repo',
      deleteRemoteBranch: true,
      remote: 'origin',
    });
  });

  test('skips merged branches with uncommitted changes', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
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
      }),
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

  test('skips merged branches with a live owning run and a live-run reason', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
        id: 'env-live',
        working_path: '/workspace/repo/worktrees/issue-11',
        branch_name: 'issue-11',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '11',
        provider: 'worktree',
        metadata: {},
      }),
    ]);
    mockWorktreeExists.mockResolvedValueOnce(true);
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default from beforeEach)
    mockGetLiveRunOwningEnv.mockResolvedValueOnce({ id: 'run-live-1', status: 'paused' });

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-live',
      reason: 'merged but run run-live is paused',
    });
    expect(report.removed).toHaveLength(0);
  });

  test('skips stale environments with a live owning run', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
        id: 'env-stale-live',
        working_path: '/workspace/repo/worktrees/issue-12',
        branch_name: 'issue-12',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days old
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '12',
        provider: 'worktree',
        metadata: {},
      }),
    ]);
    mockWorktreeExists.mockResolvedValueOnce(true);
    // isBranchMerged stays false (default from beforeEach)
    // getLastCommitDate stays null (default from beforeEach), so staleness
    // falls back to the 30-day creation age.
    mockGetLiveRunOwningEnv.mockResolvedValueOnce({ id: 'run-live-stale-1', status: 'running' });

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-stale-live',
      reason: 'stale but run run-live is running',
    });
    expect(report.removed).toHaveLength(0);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  test('skips path-missing environments owned by a live run', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
        id: 'env-missing-live',
        working_path: '/workspace/repo/worktrees/issue-13',
        branch_name: 'issue-13',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '13',
        provider: 'worktree',
        metadata: {},
      }),
    ]);
    // worktreeExists stays false (default from beforeEach): path missing
    mockGetLiveRunOwningEnv.mockResolvedValueOnce({ id: 'run-missing-live', status: 'paused' });

    const report = await runScheduledCleanup();

    expect(report.skipped).toContainEqual({
      id: 'env-missing-live',
      reason: 'path missing but run run-miss is paused',
    });
    expect(report.removed).toHaveLength(0);
    expect(mockDestroy).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  test('skips telegram environments', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
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
      }),
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
      makeEnvironmentWithCodebase({
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
      }),
      makeEnvironmentWithCodebase({
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
      }),
    ]);
    // worktreeExists returns false for both (already default)
    // env-error: removeEnvironment needs getById + getCodebase
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-error',
        codebase_id: 'codebase-1',
        working_path: '/bad/path',
        branch_name: 'bad-branch',
        status: 'active',
      })
    );
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );
    // env-good: removeEnvironment needs getById + getCodebase
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-good',
        codebase_id: 'codebase-1',
        working_path: '/workspace/repo/worktrees/pr-1',
        branch_name: 'pr-1',
        status: 'active',
      })
    );
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

    const report = await runScheduledCleanup();

    // Both should be marked as destroyed since paths are missing
    expect(report.removed).toContain('env-error (path missing)');
    expect(report.removed).toContain('env-good (path missing)');
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

  test('detects squash-merged branches via isPatchEquivalent fallback', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
        id: 'env-squash',
        working_path: '/workspace/repo/worktrees/squash-branch',
        branch_name: 'squash-branch',
        status: 'active',
        created_by_platform: 'github',
        created_at: new Date(),
        codebase_default_cwd: '/workspace/repo',
        codebase_id: 'codebase-1',
        workflow_type: 'issue',
        workflow_id: '42',
        provider: 'worktree',
        metadata: {},
      }),
    ]);
    // worktreeExists returns true (path exists)
    mockWorktreeExists.mockResolvedValue(true);
    // isBranchMerged returns false — regular merge detection fails
    mockIsBranchMerged.mockResolvedValueOnce(false);
    // isPatchEquivalent returns true — squash-merge detected
    mockIsPatchEquivalent.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default)
    // For removeEnvironment: getById returns the env
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-squash',
        codebase_id: 'codebase-1',
        working_path: '/workspace/repo/worktrees/squash-branch',
        status: 'active',
      })
    );
    // removeEnvironment: getCodebase for canonical repo path
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

    const report = await runScheduledCleanup();

    expect(report.removed).toContain('env-squash (merged)');
    expect(mockIsPatchEquivalent).toHaveBeenCalledWith(
      '/workspace/repo',
      'squash-branch',
      'origin/main'
    );
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
    mockLoadRepoConfig.mockClear();
    mockIsPatchEquivalent.mockClear();
    // Reset defaults
    mockGetDefaultBranch.mockResolvedValue(toBranchName('main'));
    mockIsBranchMerged.mockResolvedValue(false);
    mockIsPatchEquivalent.mockResolvedValue(false);
    mockLoadRepoConfig.mockResolvedValue({});
  });

  test('returns correct breakdown with mixed environments', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      makeEnvironmentWithAge({
        id: 'env-1',
        branch_name: 'merged-branch',
        created_by_platform: 'github',
        days_since_activity: 5,
        working_path: '/path1',
        status: 'active',
      }),
      makeEnvironmentWithAge({
        id: 'env-2',
        branch_name: 'stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        working_path: '/path2',
        status: 'active',
      }),
      makeEnvironmentWithAge({
        id: 'env-3',
        branch_name: 'active-branch',
        created_by_platform: 'github',
        days_since_activity: 2,
        working_path: '/path3',
        status: 'active',
      }),
      makeEnvironmentWithAge({
        id: 'env-4',
        branch_name: 'telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 60,
        working_path: '/path4',
        status: 'active',
      }),
    ]);

    // getDefaultBranch returns 'main' (default from beforeEach)
    // Check merged for env-1 (merged)
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // env-2, env-3, env-4 use default (false)

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.total).toBe(4);
    expect(breakdown.merged).toBe(1);
    // No worktree.remote configured — default-branch detection gets
    // 'origin' (the remote default).
    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/workspace/repo', 'origin');
    expect(breakdown.stale).toBe(1); // env-2 is stale (30 days), env-4 is Telegram so not counted as stale
    expect(breakdown.active).toBe(2); // env-3 active, env-4 Telegram (counted as active, not stale)
    // Verify the remote-qualified ref is threaded through to isBranchMerged.
    expect(mockIsBranchMerged).toHaveBeenCalledWith(
      '/workspace/repo',
      'merged-branch',
      'origin/main'
    );
  });

  test('excludes telegram from stale count', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      makeEnvironmentWithAge({
        id: 'env-telegram',
        branch_name: 'telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 100,
        working_path: '/path',
        status: 'active',
      }),
    ]);

    // getDefaultBranch returns 'main' (default from beforeEach)
    // isBranchMerged returns false (default from beforeEach)

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.stale).toBe(0);
    expect(breakdown.active).toBe(1);
  });

  test('returns empty breakdown for empty codebase', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([]);
    // resolveRepoGitContext returns 'main' (no config → getDefaultBranch fallback, default from beforeEach)

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.total).toBe(0);
    expect(breakdown.merged).toBe(0);
    expect(breakdown.stale).toBe(0);
    expect(breakdown.active).toBe(0);
  });

  test('detects the default branch on the configured worktree.remote', async () => {
    mockLoadRepoConfig.mockResolvedValue({ worktree: { remote: 'upstream' } });
    mockListByCodebaseWithAge.mockResolvedValueOnce([]);

    await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/workspace/repo', 'upstream');
  });

  test('detects squash-merged branches via isPatchEquivalent fallback', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      makeEnvironmentWithAge({
        id: 'env-squash',
        branch_name: 'squash-branch',
        created_by_platform: 'github',
        days_since_activity: 5,
        working_path: '/path1',
        status: 'active',
      }),
    ]);
    // isBranchMerged returns false — regular merge detection fails
    mockIsBranchMerged.mockResolvedValueOnce(false);
    // isPatchEquivalent returns true — squash-merge detected
    mockIsPatchEquivalent.mockResolvedValueOnce(true);

    const breakdown = await getWorktreeStatusBreakdown('codebase-1', '/workspace/repo');

    expect(breakdown.merged).toBe(1);
    expect(mockIsPatchEquivalent).toHaveBeenCalledWith(
      '/workspace/repo',
      'squash-branch',
      'origin/main'
    );
  });
});

describe('cleanupMergedWorktrees', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockGetLiveRunOwningEnv.mockClear();
    mockGetById.mockClear();
    mockListByCodebase.mockClear();
    mockGetDefaultBranch.mockClear();
    mockIsBranchMerged.mockClear();
    mockHasUncommittedChanges.mockClear();
    mockWorktreeExists.mockClear();
    mockGetCodebase.mockClear();
    mockUpdateStatus.mockClear();
    mockLoadRepoConfig.mockClear();
    // Reset defaults
    mockGetDefaultBranch.mockResolvedValue(toBranchName('main'));
    mockIsBranchMerged.mockResolvedValue(false);
    mockLoadRepoConfig.mockResolvedValue({});
    mockIsPatchEquivalent.mockReset();
    mockIsPatchEquivalent.mockResolvedValue(false);
    mockGetPrState.mockReset();
    mockGetPrState.mockResolvedValue('NONE');
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockWorktreeExists.mockResolvedValue(false);
  });

  test('removes merged branches without uncommitted changes', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-merged',
        branch_name: 'merged-branch',
        working_path: '/workspace/repo/worktrees/merged-branch',
        status: 'active',
      }),
    ]);

    // resolveBaseBranch returns 'main' (no config → getDefaultBranch fallback, default from beforeEach)
    // isBranchMerged returns true for this branch
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default from beforeEach)
    // No conversations
    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-merged',
        working_path: '/workspace/repo/worktrees/merged-branch',
        status: 'active',
      })
    );
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

  test('threads worktree.remote from repo config to getDefaultBranch and getPrState', async () => {
    mockLoadRepoConfig.mockResolvedValue({ worktree: { remote: 'upstream' } });
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-remote',
        branch_name: 'feature-branch',
        working_path: '/workspace/repo/worktrees/feature-branch',
        status: 'active',
      }),
    ]);
    // Not merged, not patch-equivalent → falls through to the PR-state check
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(false);
    mockGetPrState.mockResolvedValueOnce('NONE');

    await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    // Default-branch detection uses the configured remote (no baseBranch set)
    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/workspace/repo', 'upstream');
    // PR-state lookup receives the configured remote
    expect(mockGetPrState).toHaveBeenCalledWith(
      'feature-branch',
      '/workspace/repo',
      expect.any(Map),
      'upstream'
    );
  });

  test('logs a warn before skipping an environment when the merge check fails', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-flaky',
        branch_name: 'flaky-branch',
        working_path: '/workspace/repo/worktrees/flaky-branch',
        status: 'active',
      }),
    ]);
    mockIsBranchMerged.mockRejectedValueOnce(new Error('network unreachable'));

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.skipped).toEqual([
      { branchName: 'flaky-branch', reason: 'merge check failed: network unreachable' },
    ]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'flaky-branch', repoPath: '/workspace/repo' }),
      'cleanup.merge_check_failed'
    );
  });

  test('skips merged branches with uncommitted changes', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-dirty',
        branch_name: 'dirty-branch',
        working_path: '/workspace/repo/worktrees/dirty-branch',
        status: 'active',
      }),
    ]);

    // resolveBaseBranch returns 'main' (no config → getDefaultBranch fallback, default from beforeEach)
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

  test('skips merged branches with a live owning run', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-live-run',
        branch_name: 'live-run-branch',
        working_path: '/workspace/repo/worktrees/live-run-branch',
        status: 'active',
      }),
    ]);

    // resolveBaseBranch returns 'main' (no config → getDefaultBranch fallback, default from beforeEach)
    // isBranchMerged returns true
    mockIsBranchMerged.mockResolvedValueOnce(true);
    // hasUncommittedChanges returns false (default from beforeEach)
    // A running workflow owns the environment
    mockGetLiveRunOwningEnv.mockResolvedValueOnce({ id: 'run-abc12345-6789', status: 'running' });

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'live-run-branch',
      reason: 'run run-abc1 is running',
    });
  });

  test('cleans a merged environment pinned only by historical conversation references (#2868)', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-historical',
        branch_name: 'historical-branch',
        working_path: '/workspace/repo/worktrees/historical-branch',
        status: 'active',
      }),
    ]);

    mockIsBranchMerged.mockResolvedValueOnce(true);
    // No live work: the env's conversation and runs are all terminal history.
    // getLiveRunOwningEnv default (null) covers this — nothing to stub.

    // For removeEnvironment: getById returns the env
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-historical',
        working_path: '/workspace/repo/worktrees/historical-branch',
        status: 'active',
      })
    );
    // worktreeExists returns false (default) — destroy still runs for branch cleanup

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('historical-branch');
    expect(result.skipped).toHaveLength(0);
  });

  test('removes branch when git-cherry detects squash-merge', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-squash',
        branch_name: 'squash-branch',
        working_path: '/workspace/repo/worktrees/squash-branch',
        status: 'active',
      }),
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(true);
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-squash',
        working_path: '/workspace/repo/worktrees/squash-branch',
        status: 'active',
      })
    );
    mockWorktreeExists.mockResolvedValueOnce(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('squash-branch');
    // Remote-qualified ref is passed to both signals — the local base may be stale.
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

  test('removes squash-merged branch when local base is stale (#3002)', async () => {
    // Simulate a scenario where the local `main` is behind `origin/main`.
    // In the pre-#3002 code this would have been classified as unmerged;
    // now the remote-qualified ref gives the correct answer.
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-squash-stale-base',
        branch_name: 'squash-stale-base',
        working_path: '/workspace/repo/worktrees/squash-stale-base',
        status: 'active',
      }),
    ]);
    // git branch --merged origin/main → false (regular merge check fails against
    // the remote-qualified ref too — the branch was squash-merged, not ff-merged)
    mockIsBranchMerged.mockResolvedValueOnce(false);
    // git cherry origin/main <branch> → true (patch-equivalent, squash-merged)
    mockIsPatchEquivalent.mockResolvedValueOnce(true);
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-squash-stale-base',
        working_path: '/workspace/repo/worktrees/squash-stale-base',
        status: 'active',
      })
    );
    mockWorktreeExists.mockResolvedValueOnce(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('squash-stale-base');
    // The remote-qualified ref was used, not the bare local branch name.
    expect(mockIsPatchEquivalent).toHaveBeenCalledWith(
      '/workspace/repo',
      'squash-stale-base',
      'origin/main'
    );
  });

  test('removes branch when PR is MERGED', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-pr-merged',
        branch_name: 'pr-merged-branch',
        working_path: '/workspace/repo/worktrees/pr-merged-branch',
        status: 'active',
      }),
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(false);
    mockGetPrState.mockResolvedValueOnce('MERGED');
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-pr-merged',
        working_path: '/workspace/repo/worktrees/pr-merged-branch',
        status: 'active',
      })
    );
    mockWorktreeExists.mockResolvedValueOnce(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('pr-merged-branch');
  });

  test('skips branch when PR is OPEN with clear reason', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-pr-open',
        branch_name: 'pr-open-branch',
        working_path: '/workspace/repo/worktrees/pr-open-branch',
        status: 'active',
      }),
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
      makeEnvironment({
        id: 'env-pr-closed',
        branch_name: 'pr-closed-branch',
        working_path: '/workspace/repo/worktrees/pr-closed-branch',
        status: 'active',
      }),
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(false);
    mockGetPrState.mockResolvedValueOnce('CLOSED');

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
  });

  test('removes branch when PR is CLOSED and includeClosed=true', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-pr-closed-include',
        branch_name: 'pr-closed-branch',
        working_path: '/workspace/repo/worktrees/pr-closed-branch',
        status: 'active',
      }),
    ]);
    mockIsBranchMerged.mockResolvedValueOnce(false);
    mockIsPatchEquivalent.mockResolvedValueOnce(false);
    mockGetPrState.mockResolvedValueOnce('CLOSED');
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-pr-closed-include',
        working_path: '/workspace/repo/worktrees/pr-closed-branch',
        status: 'active',
      })
    );
    mockWorktreeExists.mockResolvedValueOnce(true);

    const result = await cleanupMergedWorktrees('codebase-1', '/workspace/repo', {
      includeClosed: true,
    });

    expect(result.removed).toContain('pr-closed-branch');
  });

  test('skips branch when no PR and not merged', async () => {
    mockListByCodebase.mockResolvedValueOnce([
      makeEnvironment({
        id: 'env-none',
        branch_name: 'orphan-branch',
        working_path: '/workspace/repo/worktrees/orphan-branch',
        status: 'active',
      }),
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
      makeEnvironment({
        id: 'env-error',
        branch_name: 'error-branch',
        working_path: '/workspace/repo/worktrees/error-branch',
        status: 'active',
      }),
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

describe('resolveBaseBranch via runScheduledCleanup (issue #1419)', () => {
  beforeEach(() => {
    mockListAllActiveWithCodebase.mockClear();
    mockWorktreeExists.mockClear();
    mockGetDefaultBranch.mockClear();
    mockIsBranchMerged.mockClear();
    mockHasUncommittedChanges.mockClear();
    mockLoadRepoConfig.mockClear();
    mockDeleteOldSessions.mockClear();
    // Defaults
    mockWorktreeExists.mockResolvedValue(true);
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockIsBranchMerged.mockResolvedValue(false);
    mockLoadRepoConfig.mockResolvedValue({});
    mockGetDefaultBranch.mockResolvedValue(toBranchName('main'));
  });

  test('uses worktree.baseBranch from config and skips git detection for master-branch repo', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
        id: 'env-master',
        codebase_id: 'codebase-1',
        status: 'active',
        branch_name: 'feature/foo',
        working_path: '/workspace/.archon/worktrees/feature-foo',
        codebase_default_cwd: '/workspace/myrepo',
        codebase_repository_url: null,
        workflow_type: 'task',
        workflow_id: 'wf-1',
        created_at: new Date(),
        created_by_platform: null,
        created_by_user_id: null,
        metadata: {},
        provider: 'worktree',
      }),
    ]);
    mockLoadRepoConfig.mockResolvedValueOnce({
      worktree: { baseBranch: 'master' },
    });

    const report = await runScheduledCleanup();

    // Config took over — getDefaultBranch must NOT have been called for this env.
    expect(mockGetDefaultBranch).not.toHaveBeenCalled();
    expect(report.errors).toHaveLength(0);
    // isBranchMerged called with 'origin/master', not 'main'.
    expect(mockIsBranchMerged).toHaveBeenCalledWith(
      '/workspace/myrepo',
      'feature/foo',
      'origin/master'
    );
  });

  test('trims whitespace and uses the configured base branch', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
        id: 'env-trim',
        codebase_id: 'codebase-1',
        status: 'active',
        branch_name: 'feature/baz',
        working_path: '/workspace/.archon/worktrees/feature-baz',
        codebase_default_cwd: '/workspace/repo',
        codebase_repository_url: null,
        workflow_type: 'task',
        workflow_id: 'wf-3',
        created_at: new Date(),
        created_by_platform: null,
        created_by_user_id: null,
        metadata: {},
        provider: 'worktree',
      }),
    ]);
    mockLoadRepoConfig.mockResolvedValueOnce({
      worktree: { baseBranch: '  develop  ' },
    });

    await runScheduledCleanup();

    expect(mockGetDefaultBranch).not.toHaveBeenCalled();
    expect(mockIsBranchMerged).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/baz',
      'origin/develop'
    );
  });

  test('falls back to git detection when worktree.baseBranch is not configured', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
        id: 'env-main',
        codebase_id: 'codebase-2',
        status: 'active',
        branch_name: 'feature/bar',
        working_path: '/workspace/.archon/worktrees/feature-bar',
        codebase_default_cwd: '/workspace/mainrepo',
        codebase_repository_url: null,
        workflow_type: 'task',
        workflow_id: 'wf-2',
        created_at: new Date(),
        created_by_platform: null,
        created_by_user_id: null,
        metadata: {},
        provider: 'worktree',
      }),
    ]);
    mockLoadRepoConfig.mockResolvedValueOnce({}); // no baseBranch configured
    mockGetDefaultBranch.mockResolvedValueOnce(toBranchName('main'));

    await runScheduledCleanup();

    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/workspace/mainrepo', 'origin');
    expect(mockIsBranchMerged).toHaveBeenCalledWith(
      '/workspace/mainrepo',
      'feature/bar',
      'origin/main'
    );
  });

  test('whitespace-only baseBranch falls back to git detection', async () => {
    mockListAllActiveWithCodebase.mockResolvedValueOnce([
      makeEnvironmentWithCodebase({
        id: 'env-ws',
        codebase_id: 'codebase-3',
        status: 'active',
        branch_name: 'feature/qux',
        working_path: '/workspace/.archon/worktrees/feature-qux',
        codebase_default_cwd: '/workspace/repo3',
        codebase_repository_url: null,
        workflow_type: 'task',
        workflow_id: 'wf-4',
        created_at: new Date(),
        created_by_platform: null,
        created_by_user_id: null,
        metadata: {},
        provider: 'worktree',
      }),
    ]);
    mockLoadRepoConfig.mockResolvedValueOnce({
      worktree: { baseBranch: '   ' },
    });
    mockGetDefaultBranch.mockResolvedValueOnce(toBranchName('main'));

    await runScheduledCleanup();

    expect(mockGetDefaultBranch).toHaveBeenCalledWith('/workspace/repo3', 'origin');
  });
});

describe('onConversationClosed', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockUpdateStatus.mockClear();
    mockGetById.mockClear();
    mockGetCodebase.mockClear();
    mockGetLiveRunOwningEnv.mockClear();
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
    mockGetConversationByPlatformId.mockResolvedValueOnce(
      makeConversation({
        id: 'conv-active-session',
        isolation_env_id: 'env-with-session',
      })
    );

    mockGetActiveSession.mockResolvedValueOnce(
      makeSession({
        id: 'session-to-close',
        conversation_id: 'conv-active-session',
        active: true,
      })
    );
    mockDeactivateSession.mockResolvedValueOnce(undefined);

    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-with-session',
        codebase_id: 'codebase-1',
        working_path: '/workspace/worktrees/pr-200',
        branch_name: 'feature-y',
        status: 'active',
      })
    );

    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-with-session',
        codebase_id: 'codebase-1',
        working_path: '/workspace/worktrees/pr-200',
        branch_name: 'feature-y',
        status: 'active',
      })
    );

    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

    // removeEnvironment: worktreeExists returns false (default from beforeEach)

    await onConversationClosed('github', 'owner/repo#200');

    expect(mockDeactivateSession).toHaveBeenCalledWith('session-to-close', 'conversation-closed');
  });

  test('passes deleteRemoteBranch: true when merged option is set', async () => {
    // Conversation with isolation env
    mockGetConversationByPlatformId.mockResolvedValueOnce(
      makeConversation({
        id: 'conv-1',
        isolation_env_id: 'env-merged-pr',
      })
    );

    // No active session
    mockGetActiveSession.mockResolvedValueOnce(null);

    // Environment exists
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-merged-pr',
        codebase_id: 'codebase-1',
        working_path: '/workspace/worktrees/pr-100',
        branch_name: 'feature-x',
        status: 'active',
      })
    );

    // No other conversations use this env

    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-merged-pr',
        codebase_id: 'codebase-1',
        working_path: '/workspace/worktrees/pr-100',
        branch_name: 'feature-x',
        status: 'active',
      })
    );

    // removeEnvironment: getCodebase
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

    // removeEnvironment: worktreeExists returns false (default from beforeEach)

    await onConversationClosed('github', 'owner/repo#100', { merged: true });

    expect(mockDestroy).toHaveBeenCalledWith('/workspace/worktrees/pr-100', {
      force: false,
      branchName: 'feature-x',
      canonicalRepoPath: '/workspace/repo',
      deleteRemoteBranch: true,
      remote: 'origin',
    });
  });

  test('does not pass deleteRemoteBranch when merged is not set', async () => {
    // Conversation with isolation env
    mockGetConversationByPlatformId.mockResolvedValueOnce(
      makeConversation({
        id: 'conv-2',
        isolation_env_id: 'env-closed-pr',
      })
    );

    // No active session
    mockGetActiveSession.mockResolvedValueOnce(null);

    // Environment exists
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-closed-pr',
        codebase_id: 'codebase-1',
        working_path: '/workspace/worktrees/pr-101',
        branch_name: 'feature-y',
        status: 'active',
      })
    );

    // No other conversations use this env

    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-closed-pr',
        codebase_id: 'codebase-1',
        working_path: '/workspace/worktrees/pr-101',
        branch_name: 'feature-y',
        status: 'active',
      })
    );

    // removeEnvironment: getCodebase
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

    // removeEnvironment: worktreeExists returns false (default from beforeEach)

    await onConversationClosed('github', 'owner/repo#101');

    expect(mockDestroy).toHaveBeenCalledWith('/workspace/worktrees/pr-101', {
      force: false,
      branchName: 'feature-y',
      canonicalRepoPath: '/workspace/repo',
      deleteRemoteBranch: undefined,
    });
  });

  test('clears cwd when it points at the environment being removed', async () => {
    mockGetConversationByPlatformId.mockResolvedValueOnce(
      makeConversation({
        id: 'conv-cwd',
        isolation_env_id: 'env-cwd',
        cwd: '/workspace/worktrees/pr-300',
      })
    );
    mockGetActiveSession.mockResolvedValueOnce(null);

    const env = makeEnvironment({
      id: 'env-cwd',
      codebase_id: 'codebase-1',
      working_path: '/workspace/worktrees/pr-300',
      branch_name: 'feature-z',
      status: 'active',
    });
    mockGetById.mockResolvedValueOnce(env);
    mockGetById.mockResolvedValueOnce(env);
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

    await onConversationClosed('github', 'owner/repo#300');

    // Leaving cwd set would strand the conversation on a deleted directory.
    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-cwd', {
      isolation_env_id: null,
      cwd: null,
    });
  });

  test('a live owning run keeps the env AND the conversation reference intact', async () => {
    mockGetConversationByPlatformId.mockResolvedValueOnce(
      makeConversation({
        id: 'conv-live-run',
        isolation_env_id: 'env-live-run',
        cwd: '/workspace/worktrees/pr-400',
      })
    );
    mockGetActiveSession.mockResolvedValueOnce(null);
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-live-run',
        codebase_id: 'codebase-1',
        working_path: '/workspace/worktrees/pr-400',
        branch_name: 'feature-live',
        status: 'active',
      })
    );
    mockGetLiveRunOwningEnv.mockResolvedValueOnce({ id: 'run-live', status: 'paused' });

    await onConversationClosed('github', 'owner/repo#400');

    expect(mockDestroy).not.toHaveBeenCalled();
    // The null-out runs only AFTER the live-run check: a top-level run attaches
    // to its env solely through this reference, so clearing before checking
    // would erase the pin and let the env be removed under a live run.
    expect(mockUpdateConversation).not.toHaveBeenCalled();
  });

  test('leaves an unrelated cwd untouched', async () => {
    mockGetConversationByPlatformId.mockResolvedValueOnce(
      makeConversation({
        id: 'conv-other-cwd',
        isolation_env_id: 'env-other',
        cwd: '/somewhere/else',
      })
    );
    mockGetActiveSession.mockResolvedValueOnce(null);

    const env = makeEnvironment({
      id: 'env-other',
      codebase_id: 'codebase-1',
      working_path: '/workspace/worktrees/pr-301',
      branch_name: 'feature-w',
      status: 'active',
    });
    mockGetById.mockResolvedValueOnce(env);
    mockGetById.mockResolvedValueOnce(env);
    mockGetCodebase.mockResolvedValueOnce(
      makeCodebase({
        id: 'codebase-1',
        name: 'test-repo',
        default_cwd: '/workspace/repo',
      })
    );

    await onConversationClosed('github', 'owner/repo#301');

    expect(mockUpdateConversation).toHaveBeenCalledWith('conv-other-cwd', {
      isolation_env_id: null,
    });
  });
});

describe('cleanupStaleWorktrees', () => {
  beforeEach(() => {
    mockExecFileAsync.mockClear();
    mockDestroy.mockClear();
    mockGetLiveRunOwningEnv.mockClear();
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
      makeEnvironmentWithAge({
        id: 'env-stale',
        branch_name: 'stale-branch',
        working_path: '/workspace/repo/worktrees/stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        status: 'active',
      }),
    ]);

    // hasUncommittedChanges returns false (default from beforeEach)
    // No conversations
    // For removeEnvironment: getById
    mockGetById.mockResolvedValueOnce(
      makeEnvironment({
        id: 'env-stale',
        working_path: '/workspace/repo/worktrees/stale-branch',
        status: 'active',
      })
    );
    // removeEnvironment: worktreeExists returns true (path exists)
    mockWorktreeExists.mockResolvedValueOnce(true);
    // removeEnvironment: hasUncommittedChanges returns false (default)

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toContain('stale-branch');
  });

  test('skips telegram worktrees even if old', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      makeEnvironmentWithAge({
        id: 'env-telegram',
        branch_name: 'telegram-branch',
        working_path: '/workspace/repo/worktrees/telegram-branch',
        created_by_platform: 'telegram',
        days_since_activity: 100,
        status: 'active',
      }),
    ]);

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips worktrees that are not stale', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      makeEnvironmentWithAge({
        id: 'env-recent',
        branch_name: 'recent-branch',
        working_path: '/workspace/repo/worktrees/recent-branch',
        created_by_platform: 'slack',
        days_since_activity: 5, // Less than 14 days
        status: 'active',
      }),
    ]);

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips stale worktrees with uncommitted changes', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      makeEnvironmentWithAge({
        id: 'env-dirty-stale',
        branch_name: 'dirty-stale-branch',
        working_path: '/workspace/repo/worktrees/dirty-stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        status: 'active',
      }),
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

  test('skips stale worktrees owned by a live run', async () => {
    mockListByCodebaseWithAge.mockResolvedValueOnce([
      makeEnvironmentWithAge({
        id: 'env-live-stale',
        branch_name: 'live-stale-branch',
        working_path: '/workspace/repo/worktrees/live-stale-branch',
        created_by_platform: 'slack',
        days_since_activity: 30,
        status: 'active',
      }),
    ]);

    // hasUncommittedChanges returns false (default from beforeEach)
    mockGetLiveRunOwningEnv.mockResolvedValueOnce({ id: 'run-live-stale', status: 'paused' });

    const result = await cleanupStaleWorktrees('codebase-1', '/workspace/repo');

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      branchName: 'live-stale-branch',
      reason: 'run run-live is paused',
    });
    expect(mockGetById).not.toHaveBeenCalled();
  });
});

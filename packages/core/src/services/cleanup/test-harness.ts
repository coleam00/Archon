/**
 * Shared fixture for the cleanup unit suites: fixtures, the module mocks the cleanup
 * jobs read through, and resetCleanupMocks, which each suite runs before every test.
 * Import it after the module under test. A module mock replaces the exports of a module
 * that is already loaded, but a `const` export of one loaded later keeps its real value.
 */
import { setPlatformPolicies } from '../../platforms/registry';
import { mock } from 'bun:test';
import {
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
} from '@archon/isolation/types';
import { createMockLogger } from '../../test/mocks/logger';
import { toBranchName } from '@archon/git';
import type {
  ContainerBackend,
  IIsolationProvider,
  IsolationEnvironmentRow,
} from '@archon/isolation';
import type { Codebase, Conversation } from '../../types';
import type * as Git from '@archon/git';
import type * as Isolation from '@archon/isolation';
import type * as IsolationEnvironmentDb from '../../db/isolation-environments';
import type * as ConversationDb from '../../db/conversations';
import type * as SessionDb from '../../db/sessions';
import type * as CodebaseDb from '../../db/codebases';
import type * as ConfigLoader from '../../config/config-loader';
import type * as WorkflowDb from '../../db/workflows';

export const ageBasedPolicies = ['test', 'github', 'slack', 'cli', 'web', 'new-forge'].map(id => ({
  id,
  workspaceRetention: 'age-based' as const,
}));
export const RETAINING_PLATFORM = 'matrix-chat';
export const UNKNOWN_PLATFORM = 'removed-chat';
export const UNKNOWN_PLATFORM_REASON = `platform '${UNKNOWN_PLATFORM}' is not registered; workspace kept (plugin may have been removed)`;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

export const NO_PR: Isolation.PrLookup = { state: 'NONE' };
export const PR_HEAD_SHA = 'pr-head-sha';
export function prAt(state: 'MERGED' | 'OPEN' | 'CLOSED'): Isolation.PrLookup {
  return { state, headSha: PR_HEAD_SHA };
}

export function makeEnvironment(
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

/** An environment named after its branch, checked out under the repo's worktrees. */
export function worktreeEnv(
  branch: string,
  overrides: Partial<IsolationEnvironmentRow> = {}
): IsolationEnvironmentRow {
  return makeEnvironment({
    id: `env-${branch}`,
    branch_name: branch,
    working_path: `/workspace/repo/worktrees/${branch}`,
    ...overrides,
  });
}

export function makeCodebase(overrides: Partial<Codebase> = {}): Codebase {
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

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
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

export type EnvironmentWithCodebase = Awaited<
  ReturnType<typeof IsolationEnvironmentDb.listAllActiveWithCodebase>
>[number];

export function makeEnvironmentWithCodebase(
  overrides: Partial<EnvironmentWithCodebase> = {}
): EnvironmentWithCodebase {
  return {
    ...makeEnvironment(),
    codebase_name: 'test-project',
    codebase_default_cwd: '/workspace/repo',
    codebase_repository_url: 'https://github.com/test/repo.git',
    ...overrides,
  };
}

/** The scheduled sweep's view of `worktreeEnv`. */
export function sweptWorktreeEnv(
  branch: string,
  overrides: Partial<EnvironmentWithCodebase> = {}
): EnvironmentWithCodebase {
  return { ...makeEnvironmentWithCodebase(worktreeEnv(branch)), ...overrides };
}

export function makeEnvironmentWithAge(
  overrides: Partial<IsolationEnvironmentRow & { days_since_activity: number }> = {}
): IsolationEnvironmentRow & { days_since_activity: number } {
  return { ...makeEnvironment(), days_since_activity: 0, ...overrides };
}

export function makeContainerEnvironment(
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

export const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// Every mock's default is installed by the top-level beforeEach, so no test sees
// another's leftovers.
export const mockHasUncommittedChanges = mock<typeof Git.hasUncommittedChangesStrict>();
export const mockWorktreeExists = mock<typeof Git.worktreeExists>();
export const mockGetDefaultBranch = mock<typeof Git.getDefaultBranch>();
export const mockIsBranchMerged = mock<typeof Git.isBranchMerged>();
export const mockIsPatchEquivalent = mock<typeof Git.isPatchEquivalent>();
export const mockLocalBranchExists = mock<typeof Git.localBranchExists>();
export const mockGetLastCommitDate = mock<typeof Git.getLastCommitDate>();
export const mockIsRevCoveredBy = mock<typeof Git.isRevCoveredBy>();
export const mockCountCommitsMissingFromRemotes = mock<typeof Git.countCommitsMissingFromRemotes>();
mock.module('@archon/git', () => ({
  getGitCheckoutIdentity: async () => ({
    gitDir: '/workspace/repo',
    commonGitDir: '/workspace/repo',
    linkedWorktree: false,
  }),
  countCommitsMissingFromRemotes: mockCountCommitsMissingFromRemotes,
  execFileAsync: mock(() => Promise.resolve({ stdout: '', stderr: '' })),
  hasUncommittedChangesStrict: mockHasUncommittedChanges,
  worktreeExists: mockWorktreeExists,
  getDefaultBranch: mockGetDefaultBranch,
  isBranchMerged: mockIsBranchMerged,
  isPatchEquivalent: mockIsPatchEquivalent,
  localBranchExists: mockLocalBranchExists,
  isRevCoveredBy: mockIsRevCoveredBy,
  getLastCommitDate: mockGetLastCommitDate,
  toRepoPath: (p: string) => p,
  toBranchName: (b: string) => b,
  toWorktreePath: (p: string) => p,
}));

export const mockDestroy = mock<IIsolationProvider['destroy']>();
export const mockGetPrState = mock<typeof Isolation.getPrState>();
export const mockContainerDestroy = mock<ContainerBackend['destroy']>();
export const mockContainerOptions =
  mock<(options: ConstructorParameters<typeof Isolation.ContainerBackend>[0]) => void>();
export class MockContainerBackend {
  constructor(options: ConstructorParameters<typeof Isolation.ContainerBackend>[0]) {
    mockContainerOptions(options);
  }
  destroy = mockContainerDestroy;
}
mock.module('@archon/isolation', () => ({
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
  getIsolationProvider: () => ({
    destroy: mockDestroy,
  }),
  getPrState: mockGetPrState,
  ContainerBackend: MockContainerBackend,
}));

export const mockListAllActiveWithCodebase =
  mock<typeof IsolationEnvironmentDb.listAllActiveWithCodebase>();
export const mockMarkWorktreeDestroyed =
  mock<typeof IsolationEnvironmentDb.markWorktreeDestroyed>();
export const mockGetLiveRunOwningEnv = mock<typeof IsolationEnvironmentDb.getLiveRunOwningEnv>();
export const mockGetById = mock<typeof IsolationEnvironmentDb.getById>();
export const mockListByCodebase = mock<typeof IsolationEnvironmentDb.listByCodebase>();
export const mockListByCodebaseWithAge =
  mock<typeof IsolationEnvironmentDb.listByCodebaseWithAge>();
export const mockListActiveContainerEnvironments =
  mock<typeof IsolationEnvironmentDb.listActiveContainerEnvironments>();
mock.module('../../db/isolation-environments', () => ({
  listAllActiveWithCodebase: mockListAllActiveWithCodebase,
  updateStatus: mock(() => Promise.resolve()),
  markWorktreeDestroyed: mockMarkWorktreeDestroyed,
  withWorktreeRegistration: async (
    env: IsolationEnvironmentRow,
    remove: Parameters<typeof IsolationEnvironmentDb.withWorktreeRegistration>[1]
  ) => remove(() => mockMarkWorktreeDestroyed(env)),
  getLiveRunOwningEnv: mockGetLiveRunOwningEnv,
  isSettleableRunStatus: (status: string) => status === 'failed',
  getById: mockGetById,
  listByCodebase: mockListByCodebase,
  listByCodebaseWithAge: mockListByCodebaseWithAge,
  countActiveByCodebase: mock(() => Promise.resolve(0)),
  listActiveContainerEnvironments: mockListActiveContainerEnvironments,
  createIsolationStore: () => ({}),
}));

export const mockGetRunByIsolationEnvId = mock<typeof WorkflowDb.getRunByIsolationEnvId>();
mock.module('../../db/workflows', () => ({
  getRunByIsolationEnvId: mockGetRunByIsolationEnvId,
}));

export const mockGetConversationByPlatformId =
  mock<typeof ConversationDb.getConversationByPlatformId>();
export const mockUpdateConversation = mock<typeof ConversationDb.updateConversation>();
mock.module('../../db/conversations', () => ({
  getConversationByPlatformId: mockGetConversationByPlatformId,
  updateConversation: mockUpdateConversation,
}));

export const mockGetActiveSession = mock<typeof SessionDb.getActiveSession>();
export const mockDeactivateSession = mock<typeof SessionDb.deactivateSession>();
export const mockDeleteOldSessions = mock<typeof SessionDb.deleteOldSessions>();
mock.module('../../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
  deleteOldSessions: mockDeleteOldSessions,
}));

export const mockGetCodebase = mock<typeof CodebaseDb.getCodebase>();
mock.module('../../db/codebases', () => ({
  getCodebase: mockGetCodebase,
}));

// cleanup-service consults .archon/config.yaml worktree.baseBranch / worktree.remote
// before falling back to git detection.
export const mockLoadRepoConfig = mock<typeof ConfigLoader.loadRepoConfig>();
mock.module('../../config/config-loader', () => ({
  loadRepoConfig: mockLoadRepoConfig,
}));

// Default for the merge judgment: the branch is not patch-equivalent, and the
// worktree's HEAD (checked once a git signal proves the branch merged) sits at the
// branch tip, so it is covered by whatever proved the merge.
export const branchUnmergedHeadAtTip: typeof Git.isPatchEquivalent = (_path, rev) =>
  Promise.resolve(rev === 'HEAD');

export function resetCleanupMocks(): void {
  setPlatformPolicies([
    ...ageBasedPolicies,
    { id: RETAINING_PLATFORM, workspaceRetention: 'retain' },
  ]);
  mockLogger.warn.mockClear();
  mockHasUncommittedChanges.mockReset().mockResolvedValue(false);
  mockWorktreeExists.mockReset().mockResolvedValue(false);
  mockGetDefaultBranch.mockReset().mockResolvedValue(toBranchName('main'));
  mockIsBranchMerged.mockReset().mockResolvedValue(false);
  mockIsPatchEquivalent.mockReset().mockImplementation(branchUnmergedHeadAtTip);
  mockLocalBranchExists.mockReset().mockResolvedValue(true);
  mockGetLastCommitDate.mockReset().mockResolvedValue(null);
  // Default: the local branch tip is the PR's head commit (or behind it).
  mockIsRevCoveredBy.mockReset().mockResolvedValue(true);
  mockCountCommitsMissingFromRemotes.mockReset().mockResolvedValue(0);
  mockDestroy.mockReset().mockResolvedValue({
    worktreeRemoved: true,
    branchDeleted: true,
    remoteBranchDeleted: true,
    directoryClean: true,
    warnings: [],
  });
  mockGetPrState.mockReset().mockResolvedValue(NO_PR);
  mockContainerDestroy.mockReset().mockResolvedValue(undefined);
  mockContainerOptions.mockReset();
  mockListAllActiveWithCodebase.mockReset().mockResolvedValue([]);
  mockMarkWorktreeDestroyed.mockReset().mockResolvedValue(undefined);
  mockGetLiveRunOwningEnv.mockReset().mockResolvedValue(null);
  mockGetById.mockReset().mockResolvedValue(null);
  mockListByCodebase.mockReset().mockResolvedValue([]);
  mockListByCodebaseWithAge.mockReset().mockResolvedValue([]);
  mockListActiveContainerEnvironments.mockReset().mockResolvedValue([]);
  mockGetRunByIsolationEnvId.mockReset().mockResolvedValue(null);
  mockGetConversationByPlatformId.mockReset().mockResolvedValue(null);
  mockUpdateConversation.mockReset().mockResolvedValue(undefined);
  mockGetActiveSession.mockReset().mockResolvedValue(null);
  mockDeactivateSession.mockReset().mockResolvedValue(undefined);
  mockDeleteOldSessions.mockReset().mockResolvedValue(0);
  mockGetCodebase.mockReset().mockResolvedValue(makeCodebase());
  mockLoadRepoConfig.mockReset().mockResolvedValue({});
}

/** Lets removal read each environment back by id, as the database would. */
export function storeHolds(envs: readonly IsolationEnvironmentRow[]): void {
  mockGetById.mockImplementation(id => Promise.resolve(envs.find(env => env.id === id) ?? null));
}

export function scheduledSweepFinds(...envs: EnvironmentWithCodebase[]): void {
  mockListAllActiveWithCodebase.mockResolvedValue(envs);
  storeHolds(envs);
}

export function mergedSweepFinds(...envs: IsolationEnvironmentRow[]): void {
  mockListByCodebase.mockResolvedValue(envs);
  storeHolds(envs);
}

export async function selectedEnvironment(): Promise<IsolationEnvironmentRow> {
  const env = await mockGetById('env-1');
  if (!env) throw new Error('Missing selected environment fixture');
  return env;
}

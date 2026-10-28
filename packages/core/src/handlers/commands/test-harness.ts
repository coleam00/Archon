/**
 * Module mocks, spies and fixtures shared by the command handler suites. Importing it
 * installs module mocks of the database, isolation and cleanup modules, so every
 * importer runs isolated.
 *
 * Note: We avoid using mock.module() for internal modules (utils/git)
 * that have their own test files. Mocking internal modules causes test isolation issues
 * since Bun's mock.module() persists globally across test files.
 *
 * Instead, we use spyOn for internal modules, which allows spying on specific functions
 * without replacing the entire module in the global cache.
 */
import type { RunActor } from '../../operations/run-authorization';
import { expect, mock, spyOn } from 'bun:test';
import {
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
} from '@archon/isolation/types';
import { createMockLogger } from '../../test/mocks/logger';
import type { Codebase, Conversation, Session, WorkflowRequest } from '../../types';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { DashboardWorkflowRun } from '../../schemas/workflow-run';
import type { CleanupOperationResult } from '../../services/cleanup/merged-sweep';
import {
  WorktreeUncommittedChangesError,
  worktreeRegistrationMetadata,
  readWorktreeCreationId,
  type DestroyResult,
  type IsolationEnvironmentRow,
  type IsolationRequest,
  type WorktreeCreationEnvironment,
} from '@archon/isolation';
import { join } from 'path';
import * as fsPromises from 'fs/promises';
import * as gitUtils from '@archon/git';
import * as workflowDiscovery from '@archon/workflows/workflow-discovery';
import type * as CodebaseDb from '../../db/codebases';
import type * as ConversationDb from '../../db/conversations';
import type * as IsolationEnvironmentDb from '../../db/isolation-environments';
import type * as SessionDb from '../../db/sessions';
import type * as CleanupRunLock from '../../services/cleanup/run-lock';
import type * as WorkflowDb from '../../db/workflows';
import type * as WorkflowEventDb from '../../db/workflow-events';
import type * as WorkflowNodeSessionDb from '../../db/workflow-node-sessions';
import { DetachedRunOwnerUnavailableError as RealDetachedRunOwnerUnavailableError } from '../../services/run-owner-stop';

export const operator: RunActor = { kind: 'operator' };

export function makeCodebase(overrides: Partial<Codebase> = {}): Codebase {
  return {
    id: 'codebase-123',
    name: 'owner/repo',
    repository_url: 'https://github.com/owner/repo.git',
    default_cwd: '/workspace/owner/repo',
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
    id: 'conv-123',
    platform_type: 'telegram',
    platform_conversation_id: 'chat-123',
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

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-123',
    conversation_id: 'conv-123',
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

export function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: { conversationId: 'conv-123' },
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-123',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'test request',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    ...overrides,
  };
}

export function startRequest(
  request: WorkflowRequest | undefined
): Extract<WorkflowRequest, { kind: 'start' }> {
  expect(request?.kind).toBe('start');
  return request as Extract<WorkflowRequest, { kind: 'start' }>;
}

export function resumeRequest(
  request: WorkflowRequest | undefined
): Extract<WorkflowRequest, { kind: 'resume' }> {
  expect(request?.kind).toBe('resume');
  return request as Extract<WorkflowRequest, { kind: 'resume' }>;
}

export const workflowRequestTypeChecks = (): void => {
  const run = makeWorkflowRun();
  const resume: WorkflowRequest = { kind: 'resume', run };
  void resume;
  // @ts-expect-error A resume request must carry its selected run.
  const missingRun: WorkflowRequest = { kind: 'resume' };
  // @ts-expect-error A resume request cannot supply an independent graph.
  const mismatchedGraph: WorkflowRequest = { kind: 'resume', run, definition: {} };
  // @ts-expect-error A resume request cannot supply an independent run id.
  const mismatchedId: WorkflowRequest = { kind: 'resume', run, resumeRunId: 'other-run' };
  // @ts-expect-error A start request must carry a definition and arguments.
  const incompleteStart: WorkflowRequest = { kind: 'start' };
  void missingRun;
  void mismatchedGraph;
  void mismatchedId;
  void incompleteStart;
};
void workflowRequestTypeChecks;

export const EMPTY_DASHBOARD_COUNTS = {
  all: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  pending: 0,
  paused: 0,
};

export function makeDashboardRun(
  overrides: Partial<DashboardWorkflowRun> = {}
): DashboardWorkflowRun {
  return {
    ...makeWorkflowRun(),
    codebase_name: 'Archon',
    platform_type: 'cli',
    worker_platform_id: null,
    parent_platform_id: null,
    active_nodes: [],
    current_step_name: null,
    total_steps: null,
    current_step_status: null,
    agents_completed: null,
    agents_failed: null,
    agents_total: null,
    ...overrides,
  };
}

export function makeIsolationEnvironment(
  overrides: Partial<IsolationEnvironmentRow> = {}
): IsolationEnvironmentRow {
  return {
    id: 'env-uuid-123',
    codebase_id: 'codebase-123',
    workflow_type: 'task',
    workflow_id: 'task-feat-auth',
    provider: 'worktree',
    working_path: '/workspace/my-repo/worktrees/task-feat-auth',
    branch_name: 'task-feat-auth',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'test',
    created_by_user_id: null,
    metadata: {},
    ...overrides,
  };
}

// Create mock functions for database modules (safe to mock - no standalone tests)
export const mockUpdateConversation = mock<typeof ConversationDb.updateConversation>(() =>
  Promise.resolve()
);
export const mockGetCodebase = mock<typeof CodebaseDb.getCodebase>(() => Promise.resolve(null));
export const mockFindCodebaseByDefaultCwd = mock<typeof CodebaseDb.findCodebaseByDefaultCwd>(() =>
  Promise.resolve(null)
);
export const mockCreateCodebase = mock<typeof CodebaseDb.createCodebase>(() =>
  Promise.resolve(makeCodebase())
);
export const mockGetCodebaseCommands = mock<typeof CodebaseDb.getCodebaseCommands>(() =>
  Promise.resolve({})
);
export const mockUpdateCodebaseCommands = mock<typeof CodebaseDb.updateCodebaseCommands>(() =>
  Promise.resolve()
);
export const mockDeleteCodebase = mock<typeof CodebaseDb.deleteCodebase>(() => Promise.resolve());
export const mockListCodebases = mock<typeof CodebaseDb.listCodebases>(() => Promise.resolve([]));
export const mockGetActiveSession = mock<typeof SessionDb.getActiveSession>(() =>
  Promise.resolve(null)
);
export const mockDeactivateSession = mock<typeof SessionDb.deactivateSession>(() =>
  Promise.resolve()
);

// Workflow database mocks
export const mockGetActiveWorkflowRun = mock<typeof WorkflowDb.getActiveWorkflowRun>(() =>
  Promise.resolve(null)
);
export const mockCancelWorkflowRun = mock<typeof WorkflowDb.cancelWorkflowRun>(() =>
  Promise.resolve({ cancelled: true })
);
export const mockCancelResumableRunsForConversation = mock<
  typeof WorkflowDb.cancelResumableRunsForConversation
>(() => Promise.resolve([]));
export const mockListDashboardRuns = mock<typeof WorkflowDb.listDashboardRuns>(() =>
  Promise.resolve({ runs: [], total: 0, counts: EMPTY_DASHBOARD_COUNTS })
);
export const mockGetWorkflowRun = mock<typeof WorkflowDb.getWorkflowRun>(() =>
  Promise.resolve(null)
);
export const mockFindWorkflowRunsByIdPrefix = mock<typeof WorkflowDb.findWorkflowRunsByIdPrefix>(
  () => Promise.resolve([])
);
export const mockResumeWorkflowRun = mock<typeof WorkflowDb.resumeWorkflowRun>(() =>
  Promise.resolve(makeWorkflowRun({ id: 'run-id' }))
);
export const mockFailWorkflowRun = mock<typeof WorkflowDb.failWorkflowRun>(() =>
  Promise.resolve({ failed: true })
);
export const mockUpdateWorkflowRun = mock<typeof WorkflowDb.updateWorkflowRun>(() =>
  Promise.resolve()
);
// /workflow abandon cascade-cancels the sub-run tree (#2121 Phase 2), walking it
// via findChildRuns. This entry is load-bearing: mock.module MERGES over the real
// module rather than replacing the namespace, so an omitted export keeps its REAL
// implementation. While this was missing, every abandon test ran the real
// findChildRuns → pool.query → created and schema-initialised a real SQLite
// database on disk, in a test that reads as fully mocked (#2240).
export const mockFindChildRuns = mock<typeof WorkflowDb.findChildRuns>(() => Promise.resolve([]));
// CAS gate resolvers (#2113) — approve/reject stamp the resolution atomically here
// instead of via updateWorkflowRun. resolveAndCancelApprovalGate is the atomic
// resolve+cancel for terminal reject outcomes. Default to "won the race".
export const mockResolveApprovalGate = mock<typeof WorkflowDb.resolveApprovalGate>(() =>
  Promise.resolve({ resolved: true })
);
export const mockResolveAndCancelApprovalGate = mock<
  typeof WorkflowDb.resolveAndCancelApprovalGate
>(() => Promise.resolve({ resolved: true }));

// Workflow events database mocks
export const mockCreateWorkflowEvent = mock<typeof WorkflowEventDb.createWorkflowEvent>(() =>
  Promise.resolve()
);

// Spies for internal modules (use spyOn instead of mock.module to avoid global pollution)
export let spyExecFileAsync: ReturnType<typeof spyOn>;
export let spyWorktreeExists: ReturnType<typeof spyOn>;
export let spyListWorktrees: ReturnType<typeof spyOn>;
export let spyRemoveWorktree: ReturnType<typeof spyOn>;
export let spyGetWorktreeBase: ReturnType<typeof spyOn>;
export let spyGetCanonicalRepoPath: ReturnType<typeof spyOn>;
export let spyIsWorktreePath: ReturnType<typeof spyOn>;
export let spyFindWorktreeByBranch: ReturnType<typeof spyOn>;
export let spyMkdirAsync: ReturnType<typeof spyOn>;

// Spies for fs/promises (avoid global mock.module pollution)
export let spyFsAccess: ReturnType<typeof spyOn>;
export let spyFsMkdir: ReturnType<typeof spyOn>;
export let spyFsReaddir: ReturnType<typeof spyOn>;
export let spyFsRm: ReturnType<typeof spyOn>;
export let spyFsWriteFile: ReturnType<typeof spyOn>;

// Spies for workflows module
export let spyDiscoverWorkflows: ReturnType<typeof spyOn>;

// Mock database modules (safe - these don't have standalone tests that would be affected)
mock.module('../../db/conversations', () => ({
  updateConversation: mockUpdateConversation,
}));

mock.module('../../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  findCodebaseByDefaultCwd: mockFindCodebaseByDefaultCwd,
  createCodebase: mockCreateCodebase,
  getCodebaseCommands: mockGetCodebaseCommands,
  updateCodebaseCommands: mockUpdateCodebaseCommands,
  deleteCodebase: mockDeleteCodebase,
  listCodebases: mockListCodebases,
}));

mock.module('../../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
}));

mock.module('../../db/workflows', () => ({
  getActiveWorkflowRun: mockGetActiveWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  cancelResumableRunsForConversation: mockCancelResumableRunsForConversation,
  listDashboardRuns: mockListDashboardRuns,
  getWorkflowRun: mockGetWorkflowRun,
  findWorkflowRunsByIdPrefix: mockFindWorkflowRunsByIdPrefix,
  findChildRuns: mockFindChildRuns,
  resumeWorkflowRun: mockResumeWorkflowRun,
  failWorkflowRun: mockFailWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
  resolveApprovalGate: mockResolveApprovalGate,
  resolveAndCancelApprovalGate: mockResolveAndCancelApprovalGate,
}));

mock.module('../../db/workflow-events', () => ({
  listWorkflowEvents: mock<typeof WorkflowEventDb.listWorkflowEvents>(async () => []),
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

// Mock the node-session DB layer so /workflow reset-sessions exercises the real
// operation (resetWorkflowNodeSessions) without touching a database. Safe from
// mock.module pollution because command-handler.test.ts runs as its own isolated
// `bun test` invocation (declared by @archon-test-isolated).
export const mockDeleteWorkflowNodeSessions = mock<
  typeof WorkflowNodeSessionDb.deleteWorkflowNodeSessions
>(() => Promise.resolve({ deleted: 0 }));
mock.module('../../db/workflow-node-sessions', () => ({
  deleteWorkflowNodeSessions: mockDeleteWorkflowNodeSessions,
  listWorkflowNodeSessions: mock(() => Promise.resolve([])),
  upsertWorkflowNodeSession: mock(() => Promise.resolve()),
}));

// Mock isolation-environments database
export const mockIsolationEnvDbCreate = mock<typeof IsolationEnvironmentDb.create>(() =>
  Promise.resolve(makeIsolationEnvironment())
);
export const mockIsolationEnvDbGet = mock<typeof IsolationEnvironmentDb.getById>(() =>
  Promise.resolve(null)
);
export const mockMarkWorktreeDestroyed = mock<typeof IsolationEnvironmentDb.markWorktreeDestroyed>(
  () => Promise.resolve()
);

export const mockWithWorktreeRegistration = mock<
  typeof IsolationEnvironmentDb.withWorktreeRegistration
>(async (observed, remove) => remove(() => mockMarkWorktreeDestroyed(observed)));
export const mockCountActiveByCodebase = mock<typeof IsolationEnvironmentDb.countActiveByCodebase>(
  () => Promise.resolve(0)
);
mock.module('../../db/isolation-environments', () => ({
  create: mockIsolationEnvDbCreate,
  getById: mockIsolationEnvDbGet,
  getByWorkingPath: mock(() => Promise.resolve(null)),
  updateStatus: mock(() => Promise.resolve()),
  markWorktreeDestroyed: mockMarkWorktreeDestroyed,
  withWorktreeRegistration: mockWithWorktreeRegistration,
  markDestroyed: mock(() => Promise.resolve()),
  getActiveByCodebase: mock(() => Promise.resolve([])),
  getActiveEnvironments: mock(() => Promise.resolve([])),
  countActiveByCodebase: mockCountActiveByCodebase,
}));

// Mock isolation provider
export const mockIsolationCreate = mock<
  (request: IsolationRequest) => Promise<WorktreeCreationEnvironment>
>(() =>
  Promise.resolve({
    id: '/workspace/my-repo/worktrees/task-feat-auth',
    provider: 'worktree',
    workingPath: '/workspace/my-repo/worktrees/task-feat-auth',
    branchName: gitUtils.toBranchName('task-feat-auth'),
    status: 'active',
    createdAt: new Date(),
    metadata: {
      provenance: 'created',
      adopted: false,
      creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
      branchCreated: true,
    },
  })
);
export const mockIsolationDestroy = mock(
  (): Promise<DestroyResult> =>
    Promise.resolve({
      worktreeRemoved: true,
      directoryClean: true,
      branchDeleted: null,
      remoteBranchDeleted: null,
      warnings: [],
    })
);

mock.module('@archon/isolation', () => ({
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
  WorktreeUncommittedChangesError,
  worktreeRegistrationMetadata,
  readWorktreeCreationId,
  getIsolationProvider: () => ({
    providerType: 'worktree',
    create: mockIsolationCreate,
    destroy: mockIsolationDestroy,
    get: mock(() => Promise.resolve(null)),
    list: mock(() => Promise.resolve([])),
    adopt: mock(() => Promise.resolve(null)),
    healthCheck: mock(() => Promise.resolve(true)),
  }),
  // Loaded transitively via the orchestrator → child-isolation-resolver (PR-A).
  // Marked rather than reimplemented: a test here proves the reply routes through
  // the classifier, while what the real one produces is the isolation package's
  // own test.
  classifyIsolationError: (err: Error) => `classified: ${err.message}`,
}));

// Mock cleanup service
export const emptyCleanup = (): CleanupOperationResult => ({
  removed: [],
  skipped: [],
  errors: [],
  releasedFailedRuns: [],
  warnings: [],
});
export const mockCleanupMergedWorktrees = mock(() => Promise.resolve(emptyCleanup()));
export const mockCleanupStaleWorktrees = mock(() => Promise.resolve(emptyCleanup()));
// Capture the real class before mock.module replaces the module, so the mock
// re-exports it rather than a hand-declared copy that could drift.
// Abandon asks the run's live-owner endpoint first (#2325). Default: nothing answers,
// without touching a real socket.
export const mockRequestDetachedRunStop = mock<
  typeof import('../../services/run-owner-stop').requestDetachedRunStop
>(() => Promise.reject(new RealDetachedRunOwnerUnavailableError('run', 'ENOENT', 'unreachable')));
mock.module('../../services/run-owner-stop', () => ({
  requestDetachedRunStop: mockRequestDetachedRunStop,
  DetachedRunOwnerUnavailableError: RealDetachedRunOwnerUnavailableError,
}));

export const mockReclaimContainerEnv = mock(async () => undefined);
export const mockGetLiveRunBlocker = mock<typeof CleanupRunLock.getLiveRunBlocker>(() =>
  Promise.resolve(null)
);
export const mockGetWorktreeStatusBreakdown = mock<
  typeof import('../../services/cleanup-service').getWorktreeStatusBreakdown
>(() =>
  Promise.resolve({
    total: 0,
    active: 0,
    merged: 0,
    stale: 0,
    activeEnvs: [],
    mergedEnvs: [],
    staleEnvs: [],
    inspectionFailedEnvs: [],
  })
);
mock.module('../../services/cleanup-service', () => ({
  cleanupStaleWorktrees: mockCleanupStaleWorktrees,
  getWorktreeStatusBreakdown: mockGetWorktreeStatusBreakdown,
}));
mock.module('../../services/cleanup/run-lock', () => ({
  getLiveRunBlocker: mockGetLiveRunBlocker,
  getCleanupRunLock: mock(),
  toUnpushedLock: mock(),
  countUnpushedCommits: mock(),
  readLiveRemoteTips: mock(),
  checkRemoval: mock(),
}));
mock.module('../../services/cleanup/run-worktree', () => ({
  reclaimRunWorktree: async () => ({ warnings: [] }),
  assessCompletedRunWorktree: mock(),
  releaseCompletedRunWorktree: mock(),
}));
mock.module('../../services/cleanup/containers', () => ({
  reclaimContainerEnv: mockReclaimContainerEnv,
  listContainerEnvironments: mock(),
  reapContainerEnvironments: mock(),
}));
mock.module('../../services/cleanup/merged-sweep', () => ({
  cleanupMergedWorktrees: mockCleanupMergedWorktrees,
  cleanupToMakeRoom: mock(),
  recordCleanupRemoval: mock(),
}));

// Note: We removed mock.module('child_process') because:
// 1. We already spy on gitUtils.execFileAsync which covers git operations
// 2. mock.module('child_process') pollutes other test files that use child_process
//
// We also use spyOn for fs/promises and internal modules to avoid polluting
// other test files (like git.test.ts)

// Mock logger to suppress noisy output during tests
export const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  expandTilde: mock((p: string) => p.replace(/^~/, '/home/test')),
  ensureProjectStructure: mock(() => Promise.resolve()),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/home/test/.archon/workspaces/${owner}/${repo}/source`
  ),
  createProjectSourceSymlink: mock(() => Promise.resolve()),
  parseOwnerRepo: mock((name: string) => {
    const parts = name.split('/');
    return parts.length === 2 ? { owner: parts[0], repo: parts[1] } : null;
  }),
}));

// Helper to clear all mocks
export function clearAllMocks(): void {
  mockGetWorktreeStatusBreakdown.mockClear();
  mockUpdateConversation.mockClear();
  mockGetCodebase.mockClear();
  mockFindCodebaseByDefaultCwd.mockClear();
  mockCreateCodebase.mockClear();
  mockGetCodebaseCommands.mockClear();
  mockUpdateCodebaseCommands.mockClear();
  mockDeleteCodebase.mockClear();
  mockListCodebases.mockClear();
  mockGetActiveSession.mockClear();
  mockDeactivateSession.mockClear();
  // Workflow db mocks
  mockGetActiveWorkflowRun.mockClear();
  mockCancelWorkflowRun.mockClear();
  mockCancelResumableRunsForConversation.mockClear();
  mockListDashboardRuns.mockClear();
  mockGetWorkflowRun.mockClear();
  mockResumeWorkflowRun.mockClear();
  mockFailWorkflowRun.mockClear();
  mockUpdateWorkflowRun.mockClear();
  mockResolveApprovalGate.mockClear();
  mockResolveAndCancelApprovalGate.mockClear();
  mockCreateWorkflowEvent.mockClear();
  mockDeleteWorkflowNodeSessions.mockClear();
  // Isolation mocks
  mockIsolationCreate.mockClear();
  mockIsolationDestroy.mockClear();
  // Isolation-environments db mocks
  mockIsolationEnvDbCreate.mockClear();
  mockIsolationEnvDbGet.mockClear();
  mockMarkWorktreeDestroyed.mockClear();
  mockGetLiveRunBlocker.mockReset();
  mockGetLiveRunBlocker.mockResolvedValue(null);
  // Cleanup service mocks
  mockCleanupMergedWorktrees.mockClear();
  mockCleanupStaleWorktrees.mockClear();
  mockCountActiveByCodebase.mockClear();
}

// Setup spies for internal modules
export function setupSpies(): void {
  // Git utility spies
  spyExecFileAsync = spyOn(gitUtils, 'execFileAsync').mockResolvedValue({ stdout: '', stderr: '' });
  spyWorktreeExists = spyOn(gitUtils, 'worktreeExists').mockResolvedValue(false);
  spyListWorktrees = spyOn(gitUtils, 'listWorktrees').mockResolvedValue([]);
  spyRemoveWorktree = spyOn(gitUtils, 'removeWorktree').mockResolvedValue();
  spyGetWorktreeBase = spyOn(gitUtils, 'getWorktreeBase').mockImplementation(repoPath => ({
    base: join(repoPath, 'worktrees'),
    layout: 'workspace-scoped',
  }));
  spyGetCanonicalRepoPath = spyOn(gitUtils, 'getCanonicalRepoPath').mockImplementation(path =>
    Promise.resolve(gitUtils.toRepoPath(path))
  );
  spyIsWorktreePath = spyOn(gitUtils, 'isWorktreePath').mockResolvedValue(false);
  spyFindWorktreeByBranch = spyOn(gitUtils, 'findWorktreeByBranch').mockResolvedValue(null);
  spyMkdirAsync = spyOn(gitUtils, 'mkdirAsync').mockResolvedValue();

  // fs/promises spies (avoid global mock.module pollution)
  spyFsAccess = spyOn(fsPromises, 'access').mockImplementation(() =>
    Promise.reject(new Error('ENOENT'))
  );
  spyFsMkdir = spyOn(fsPromises, 'mkdir').mockImplementation(() => Promise.resolve(undefined));
  spyFsReaddir = spyOn(fsPromises, 'readdir').mockImplementation(() => Promise.resolve([]));
  spyFsRm = spyOn(fsPromises, 'rm').mockImplementation(() => Promise.resolve());
  spyFsWriteFile = spyOn(fsPromises, 'writeFile').mockImplementation(() =>
    Promise.resolve(undefined)
  );

  // Workflow spies
  spyDiscoverWorkflows = spyOn(workflowDiscovery, 'discoverWorkflowsWithConfig').mockResolvedValue({
    workflows: [],
    errors: [],
  });
}

// Restore all spies
export function restoreSpies(): void {
  spyExecFileAsync?.mockRestore();
  spyWorktreeExists?.mockRestore();
  spyListWorktrees?.mockRestore();
  spyRemoveWorktree?.mockRestore();
  spyGetWorktreeBase?.mockRestore();
  spyGetCanonicalRepoPath?.mockRestore();
  spyIsWorktreePath?.mockRestore();
  spyFindWorktreeByBranch?.mockRestore();
  spyMkdirAsync?.mockRestore();
  spyFsAccess?.mockRestore();
  spyFsMkdir?.mockRestore();
  spyFsReaddir?.mockRestore();
  spyFsRm?.mockRestore();
  spyFsWriteFile?.mockRestore();
  spyDiscoverWorkflows?.mockRestore();
}

// The project the `/workflow …` describes attach to via `codebase_id: 'codebase-123'`.
export function stubWorkflowCodebase(): void {
  mockGetCodebase.mockResolvedValue(
    makeCodebase({
      id: 'codebase-123',
      repository_url: 'https://github.com/test/repo',
      default_cwd: '/workspace/test-repo',
    })
  );
}

export const baseConversation = makeConversation({
  id: 'conv-123',
  platform_conversation_id: 'chat-456',
});

// The gate describes (approve / reject / respond) all run against this one.
export const approveConversation = makeConversation({
  id: 'conv-approve',
  platform_conversation_id: 'chat-approve',
});

export function resetCommandHandlerMocks(): void {
  clearAllMocks();
  restoreSpies();
  setupSpies();
  delete process.env.WORKSPACE_PATH;
}

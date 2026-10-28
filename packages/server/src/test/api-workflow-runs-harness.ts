/**
 * Shared scaffolding for the run-route tests: the module mocks, fakes, fixtures and
 * `makeApp`. Importing this module installs the mocks, so a test file imports it before
 * anything that reads a mocked module. Describes assign the mocked auth session and
 * ARCHON_HOME through the setters, since an imported binding cannot be assigned.
 */
import { mock, beforeAll } from 'bun:test';
import { join, relative, sep } from 'path';
import * as realStorage from '@archon/paths/archon-paths';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { User } from '@archon/core';
import { providerRegistry } from '@archon/providers';
import { ConversationLockManager } from '@archon/core/utils/conversation-lock';
import type { DashboardWorkflowRun } from '@archon/core/db/workflows';
import type { resolveRunWorkflow } from '@archon/core/workflows/resolve-run-workflow';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type {
  ProviderEventQuery,
  ProviderEventRecord,
} from '@archon/workflows/schemas/provider-event';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from '../routes/openapi-defaults';
import { makeIdleLockStats } from './conversation-lock-fixtures';
import { makeListDashboardRunsMock, mockAllWorkflowModules } from './workflow-mock-factories';

beforeAll(async (): Promise<void> => {
  const { registerBuiltinProviders, registerCommunityProviders } = await import(
    '@archon/providers/in-process'
  );
  registerBuiltinProviders();
  registerCommunityProviders();
});

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

let sessionUserId: string | undefined;
let requireRunIdentity = false;
export function setSessionUserId(id: string | undefined): void {
  sessionUserId = id;
}
export function setRequireRunIdentity(required: boolean): void {
  requireRunIdentity = required;
}
mock.module('../auth', () => ({
  getAuth: () =>
    sessionUserId
      ? {
          api: { getSession: async () => ({ user: { id: sessionUserId } }) },
        }
      : null,
  isWebAuthEnabled: () => requireRunIdentity || sessionUserId !== undefined,
  isApiGateEnabled: () => false,
  // Conversation ownership has its own suite (api.conversation-ownership.test.ts).
  isConversationOwnershipEnforced: () => false,
  getSignupMode: () => 'disabled',
}));
export function makeUser(id: string): User {
  return {
    id,
    display_name: null,
    email: null,
    role: 'member',
    created_at: new Date(),
    updated_at: new Date(),
  };
}
export const mockFindOrCreateUser = mock(
  async (_platform: string, platformUserId: string): Promise<User> =>
    makeUser(`user-from-${platformUserId}`)
);
export const realGetUserById = (await import('@archon/core/db/users')).getUserById;
export const mockGetUserById = mock(async (id: string): Promise<User | null> => makeUser(id));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
  getUserById: mockGetUserById,
}));

export const mockGetWorkflowRun = mock(async (_id: string) => null as null | MockWorkflowRun);
export const mockListDueWorkflowContinuations = mock<
  IWorkflowStore['listDueWorkflowContinuations']
>(async () => []);
export const mockCancelWorkflowRun = mock(async (_id: string) => ({ cancelled: true }));
type ListWorkflowRunsOptions = Parameters<
  typeof import('@archon/core/db/workflows')['listWorkflowRuns']
>[0];

export const mockListWorkflowRuns = mock<
  (_options?: ListWorkflowRunsOptions) => Promise<MockWorkflowRun[]>
>(async () => []);
export const mockListAttentionQueueRows = mock(async (): Promise<DashboardWorkflowRun[]> => []);
export const mockListDashboardRuns = makeListDashboardRunsMock();
export const mockGetWorkflowRunByWorkerPlatformId = mock(
  async (_id: string) => null as null | MockWorkflowRun
);
export const mockListWorkflowEvents = mock(
  async (_runId: string, _options?: { excludeEventTypes?: readonly string[] }) =>
    [] as MockWorkflowEvent[]
);
export const mockListProviderEvents = mock(
  async (_runId: string, _query?: ProviderEventQuery): Promise<ProviderEventRecord[]> => []
);
export const mockGetConversationById = mock(
  async (_id: string) =>
    null as null | { id: string; platform_conversation_id: string; platform_type: string }
);
export const mockFindConversationByPlatformId = mock(
  async (_id: string) =>
    null as null | {
      id: string;
      platform_conversation_id: string;
      title: string | null;
      ai_assistant_type: string;
      created_at: Date;
      updated_at: Date;
      platform_type: string;
      deleted_at: Date | null;
      codebase_id: string | null;
    }
);
export const mockHandleMessage = mock<typeof import('@archon/core')['handleMessage']>(
  async () => {}
);
export const mockAddMessage = mock(async () => ({
  id: 'msg-1',
  conversation_id: 'conv-1',
  role: 'user' as const,
  content: 'hi',
  metadata: '{}',
  created_at: new Date().toISOString(),
}));
export const mockGenerateAndSetTitle = mock(async () => {});
const mockResolveTitleRequest = mock(async () => ({
  provider: 'claude',
  options: {} as Record<string, unknown>,
}));

// Type aliases for clarity in tests
export type MockWorkflowRun = Omit<WorkflowRun, 'conversation_id' | 'last_activity_at'> & {
  conversation_id: WorkflowRun['conversation_id'] | null;
  last_activity_at: WorkflowRun['last_activity_at'] | undefined;
};

export type MockWorkflowEvent = {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
};

// resumeRunHeadless (#2008) — stubbed so a future change to it or its
// neighbors can't silently start touching the real workflow store or the
// real isolation provider (see #2240 for what an un-stubbed export costs).
const mockCreateCodebaseChildResolver = mock(
  (_store: unknown, _codebase: unknown, _surface: unknown) => mock(async () => ({}) as unknown)
);

mock.module('@archon/core', () => ({
  providers: providerRegistry,
  handleMessage: mockHandleMessage,
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  ProjectRegistrationError: class ProjectRegistrationError extends Error {},
  inspectProjectBaseBranch: mock(async () => ({
    kind: 'repo',
    defaultBranch: 'dev',
    reason: null,
  })),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateTitleForUser: mockGenerateAndSetTitle,
  resolveTitleRequest: mockResolveTitleRequest,
  createWorkflowDeps: mock(() => ({
    store: {
      getWorkflowRun: mockGetWorkflowRun,
      signalWorkflowWait: mockSignalWorkflowWait,
      listDueWorkflowContinuations: mockListDueWorkflowContinuations,
      deferWorkflowContinuation: mock(async () => {}),
    },
  })),
  createCodebaseChildResolver: mockCreateCodebaseChildResolver,
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
}));

function parseOwnerRepoFake(name: string): { owner: string; repo: string } | null {
  const parts = name.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}

const resolveProjectStorageKeyFake = realStorage.resolveProjectStorageKey;

/**
 * Mutable so the filesystem-touching artifact tests can point ARCHON_HOME at a
 * real temp dir. A hard-coded '/tmp/...' is fine for tests that only assert
 * status codes, but tests that mkdir/readdir need a path that is absolute on
 * Windows too.
 */
export let mockArchonHome = '/tmp/.archon';
export function setMockArchonHome(home: string): void {
  mockArchonHome = home;
}
export function wsRoot(): string {
  return join(mockArchonHome, 'workspaces');
}

function storageRootFake(key: realStorage.ProjectStorageKey): string {
  return join(
    wsRoot(),
    relative(realStorage.getArchonWorkspacesPath(), realStorage.getProjectStoragePaths(key).root)
  );
}

function storagePathsForRootFake(root: string): {
  root: string;
  artifactsRoot: string;
  logsDir: string;
  stateRoot: string;
  workflowSourceRoot: string;
} {
  return {
    root,
    artifactsRoot: join(root, 'artifacts'),
    logsDir: join(root, 'logs'),
    stateRoot: join(root, 'state'),
    workflowSourceRoot: join(root, 'workflow-source'),
  };
}

export const mockCaptureApprovalResolved = mock(() => undefined);
mock.module('@archon/paths', () => ({
  canonicalizeProjectPath: async (path: string) => path,
  captureApprovalResolved: mockCaptureApprovalResolved,
  createLogger: () => ({
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(function (this: unknown) {
      return this;
    }),
    bindings: mock(() => ({ module: 'test' })),
    isLevelEnabled: mock(() => true),
    level: 'info',
  }),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getBundledWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows'),
  getArchonWorkspacesPath: () => wsRoot(),
  getArchonHome: () => mockArchonHome,
  getRunArtifactsPath: (owner: string, repo: string, runId: string): string =>
    join(wsRoot(), owner, repo, 'artifacts', 'runs', runId),
  // Mirrors the real parseOwnerRepo semantics (exactly owner/repo, no
  // traversal segments, GitHub-safe characters only).
  parseOwnerRepo: parseOwnerRepoFake,
  // Mirrors the real identity→paths resolver (#2200) so the routes are
  // exercised as delegation, with paths rooted at the mocked ARCHON_HOME.
  resolveProjectStorageKey: resolveProjectStorageKeyFake,
  resolveRunStorageRoot: (
    run: { output_root?: string | null },
    codebase: { kind?: string | null; name: string; default_cwd: string } | null
  ): string | null => {
    if (
      run.output_root &&
      (run.output_root === mockArchonHome || run.output_root.startsWith(`${mockArchonHome}${sep}`))
    ) {
      return run.output_root;
    }
    return codebase
      ? storageRootFake(resolveProjectStorageKeyFake(codebase, codebase.default_cwd))
      : null;
  },
  getStoragePathsForRoot: storagePathsForRootFake,
  getRunArtifactsDirForKey: (key: realStorage.ProjectStorageKey, runId: string): string =>
    join(storageRootFake(key), 'artifacts', 'runs', runId),
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  getConversationByPlatformId: (_platform: string, id: string) =>
    mockFindConversationByPlatformId(id),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async () => ({
    id: 'internal-uuid-123',
    platform_conversation_id: 'web-test-abc',
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
    ai_assistant_type: 'claude',
  })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mockGetConversationById,
}));

type MockCodebase = {
  id?: string;
  name: string;
  kind?: 'repo' | 'folder';
  default_cwd: string;
  default_branch?: string | null;
};
export const mockGetCodebase = mock(async (_id: string) => null as null | MockCodebase);

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mockGetCodebase,
  deleteCodebase: mock(async () => {}),
}));

export const mockFindLatestEnvironment = mock(
  async (): Promise<{ branch_name: string } | null> => null
);
mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
  findLatestByCodebaseAndWorkingPath: mockFindLatestEnvironment,
}));

export const mockDeleteWorkflowRun = mock(async (_id: string) => {});
export const mockUpdateWorkflowRun = mock(async (_id: string, _update: unknown) => {});
// CAS gate resolvers (#2113) — the real approve/reject operations stamp the
// resolution here. resolveAndCancelApprovalGate is the atomic resolve+cancel for
// terminal reject outcomes. Default to "won the race".
// The 3rd arg (approve) / 2nd arg (cancel) is the audit-event batch written in the
// same transaction as the resolution (#2146).
export const mockResolveApprovalGate = mock<
  typeof import('@archon/core/db/workflows')['resolveApprovalGate']
>(async () => ({ resolved: true }));
export const mockResolveAndCancelApprovalGate = mock<
  typeof import('@archon/core/db/workflows')['resolveAndCancelApprovalGate']
>(async () => ({ resolved: true }));
export const mockFindChildRuns = mock(async (_parentRunId: string): Promise<unknown[]> => []);
export const mockSignalWorkflowWait = mock(
  async (_id: string, _wait: unknown, _payload?: unknown) => ({
    signaled: true,
  })
);
export const mockAnswerAttentionWait = mock<
  typeof import('@archon/core/db/workflows')['answerAttentionWait']
>(async () => ({ answered: true }));
export const mockLabelAttentionWait = mock<
  typeof import('@archon/core/db/workflows')['labelAttentionWait']
>(async () => ({ labeled: false }));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mockListWorkflowRuns,
  listDashboardRuns: mockListDashboardRuns,
  listAttentionQueueRows: mockListAttentionQueueRows,
  getWorkflowRun: mockGetWorkflowRun,
  findChildRuns: mockFindChildRuns,
  cancelWorkflowRun: mockCancelWorkflowRun,
  deleteWorkflowRun: mockDeleteWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
  resolveApprovalGate: mockResolveApprovalGate,
  resolveAndCancelApprovalGate: mockResolveAndCancelApprovalGate,
  signalWorkflowWait: mockSignalWorkflowWait,
  answerAttentionWait: mockAnswerAttentionWait,
  labelAttentionWait: mockLabelAttentionWait,
  getWorkflowRunByWorkerPlatformId: mockGetWorkflowRunByWorkerPlatformId,
}));

export const mockCreateWorkflowEvent = mock(async (_event: unknown) => {});

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mockListWorkflowEvents,
  createWorkflowEvent: mockCreateWorkflowEvent,
  listProviderEvents: mockListProviderEvents,
  PROVIDER_EVENT_ROW_TYPES: [
    'provider_event',
    'tool_called',
    'tool_completed',
    'task_activity',
    'hook_activity',
  ],
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findCommandFiles: mock(async () => []),
}));

export const mockResolveRunWorkflow = mock<typeof resolveRunWorkflow>(async () => ({
  ok: true,
  workflow: makeTestResolvedWorkflow({ name: 'deploy' }),
}));
// Capture the real class before mock.module replaces the module.
import { DetachedRunOwnerUnavailableError as RealDetachedRunOwnerUnavailableError } from '@archon/core/services/run-owner-stop';
export { RealDetachedRunOwnerUnavailableError };
export const mockReclaimContainerEnv = mock(async () => {});
mock.module('@archon/core/services/cleanup/run-worktree', () => ({
  reclaimRunWorktree: async () => ({ warnings: [] }),
  assessCompletedRunWorktree: mock(),
  releaseCompletedRunWorktree: mock(),
}));
mock.module('@archon/core/services/cleanup/containers', () => ({
  reclaimContainerEnv: mockReclaimContainerEnv,
  listContainerEnvironments: mock(),
  reapContainerEnvironments: mock(),
}));
// Abandon asks the run's live-owner endpoint first (#2325). Default: nothing answers.
export const mockRequestDetachedRunStop = mock<
  typeof import('@archon/core/services/run-owner-stop').requestDetachedRunStop
>(() => Promise.reject(new RealDetachedRunOwnerUnavailableError('run', 'ENOENT', 'unreachable')));
mock.module('@archon/core/services/run-owner-stop', () => ({
  requestDetachedRunStop: mockRequestDetachedRunStop,
  DetachedRunOwnerUnavailableError: RealDetachedRunOwnerUnavailableError,
}));

// Capture the real module before mock.module replaces it; the dashboard routes probe
// owner endpoints, which tests answer here instead of through /tmp sockets.
import * as runAttentionWatchModule from '@archon/core/services/run-attention-watch';
const realRunAttentionWatch = { ...runAttentionWatchModule };
export const mockObserveRunOwner = mock<typeof runAttentionWatchModule.observeRunOwner>(
  async () => null
);
mock.module('@archon/core/services/run-attention-watch', () => ({
  ...realRunAttentionWatch,
  observeRunOwner: mockObserveRunOwner,
}));

mock.module('@archon/core/workflows/resolve-run-workflow', () => ({
  resolveRunWorkflow: mockResolveRunWorkflow,
}));

export const mockHydrateResumableRun = mock<
  typeof import('@archon/workflows/run-resume')['hydrateResumableRun']
>(async (_deps, run) => ({
  preCreatedRun: { ...run, status: 'running' },
  priorCompletedNodes: new Map(),
  priorFailedNodes: new Map(),
  resumeCause: run.status === 'paused' ? 'continue_after_wait' : 'retry_failed',
  priorUsage: { costUsd: 0 },
  priorNodeSessions: [],
}));
export const mockExecuteWorkflow = mock<
  typeof import('@archon/workflows/executor')['executeWorkflow']
>(async () => ({ success: true, workflowRunId: 'run-1' }));
mock.module('@archon/workflows/run-resume', () => ({
  hydrateResumableRun: mockHydrateResumableRun,
}));
mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));

import { registerApiRoutes } from '../routes/api';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

export const NOW = new Date().toISOString();
export const NOW_DATE = new Date(NOW);

export const MOCK_RUNNING_RUN = {
  origin: { conversationId: 'conv-uuid-1' },
  id: 'run-uuid-1',
  workflow_name: 'deploy',
  conversation_id: 'conv-uuid-1',
  parent_conversation_id: null,
  codebase_id: 'cb-uuid-1',
  status: 'running',
  outcome: null,
  user_message: 'Deploy to staging',
  started_at: NOW_DATE,
  completed_at: null,
  metadata: {},
  working_path: '/tmp/worktrees/feature',
  last_activity_at: NOW_DATE,
  user_id: null,
  parent_run_id: null,
  adopted_from_run_id: null,
  output_root: null,
  checkout_baseline: null,
} satisfies MockWorkflowRun;

export const MOCK_COMPLETED_RUN = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-2',
  status: 'completed',
  outcome: 'failed',
  completed_at: NOW_DATE,
} satisfies MockWorkflowRun;

export const MOCK_FAILED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-4',
  status: 'failed',
  outcome: 'succeeded',
  completed_at: NOW_DATE,
};

export const MOCK_PENDING_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-3',
  status: 'pending',
};

export function makeDashboardWorkflowRun(run: WorkflowRun): DashboardWorkflowRun {
  return {
    ...run,
    codebase_name: null,
    platform_type: null,
    worker_platform_id: null,
    parent_platform_id: null,
    active_nodes: [],
    current_step_name: null,
    total_steps: null,
    current_step_status: null,
    agents_completed: null,
    agents_failed: null,
    agents_total: null,
  };
}

export const MOCK_EVENTS: MockWorkflowEvent[] = [
  {
    id: 'evt-1',
    workflow_run_id: 'run-uuid-1',
    event_type: 'step_started',
    step_index: 0,
    step_name: 'plan',
    data: {},
    created_at: NOW,
  },
  {
    id: 'evt-2',
    workflow_run_id: 'run-uuid-1',
    event_type: 'step_completed',
    step_index: 0,
    step_name: 'plan',
    data: { duration_ms: 1234 },
    created_at: NOW,
  },
  {
    id: 'evt-3',
    workflow_run_id: 'run-uuid-1',
    event_type: 'tool_called',
    step_index: 0,
    step_name: 'plan',
    data: { tool_name: 'Read', tool_input: { file_path: '/tmp/test.ts' } },
    created_at: NOW,
  },
];

export const MOCK_CONV = {
  id: 'internal-uuid-123',
  platform_conversation_id: 'web-test-abc',
  title: null,
  ai_assistant_type: 'claude',
  created_at: new Date(),
  updated_at: new Date(),
  platform_type: 'web',
  deleted_at: null,
  codebase_id: null,
};

export function makeApp(lockManager?: ConversationLockManager): {
  app: OpenAPIHono;
  mockWebAdapter: WebAdapter;
} {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(makeIdleLockStats),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, lockManager ?? mockLockManager);
  return { app, mockWebAdapter };
}

export const MOCK_PAUSED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-paused-1',
  status: 'paused',
  metadata: {
    approval: {
      type: 'approval',
      nodeId: 'review-gate',
      message: 'Review the plan',
    },
  },
};

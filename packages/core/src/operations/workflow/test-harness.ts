/**
 * Supplied effects, mocks and fixtures shared by the workflow operation suites. Importing
 * it installs a module mock of `@archon/paths`, so every importer runs isolated.
 */
import type { RunActor } from '../run-authorization';
import { mock } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { getRunArtifactsDirForRoot, getRunScratchDir } from '@archon/paths/archon-paths';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { DashboardWorkflowRun } from '../../schemas/workflow-run';
import type { IWorkflowStore } from '@archon/workflows/store';
import type { WorkflowOperationsDeps } from '../workflow-operations';
import type { IIsolationStore } from '@archon/isolation';
import { DetachedRunOwnerUnavailableError } from '../../services/run-owner-stop';
// ---------------------------------------------------------------------------
// Supplied persistence and host effects
// ---------------------------------------------------------------------------

export const operator: RunActor = { kind: 'operator' };

export const mockGetWorkflowRun = mock<IWorkflowStore['getWorkflowRun']>(() =>
  Promise.resolve(null)
);
export const EMPTY_COUNTS = {
  all: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  pending: 0,
  paused: 0,
};
export const mockListWorkflowRuns = mock<IWorkflowStore['listWorkflowRuns']>(() =>
  Promise.resolve({ runs: [], total: 0, counts: EMPTY_COUNTS })
);
export const mockCancelWorkflowRun = mock<IWorkflowStore['cancelWorkflowRun']>(() =>
  Promise.resolve({ cancelled: true })
);
export const mockCancelResumableRunsForConversation = mock<
  IWorkflowStore['cancelResumableRunsForConversation']
>(() => Promise.resolve([]));
export const mockFindChildRuns = mock<IWorkflowStore['findChildRuns']>(() => Promise.resolve([]));
export const mockGetRunAncestry = mock<IWorkflowStore['getRunAncestry']>(() => Promise.resolve([]));
// CAS gate resolvers (#2113): default to "won the race". Tests that simulate a
// concurrent loser override with mockResolvedValueOnce({ resolved: false }).
// resolveApprovalGate = stay-paused resolution (approve, reject stage-rework);
// resolveAndCancelApprovalGate = atomic resolve + cancel (reject terminal paths).
export const mockResolveApprovalGate = mock<IWorkflowStore['resolveApprovalGate']>(() =>
  Promise.resolve({ resolved: true })
);
export const mockResolveAndCancelApprovalGate = mock<
  IWorkflowStore['resolveAndCancelApprovalGate']
>(() => Promise.resolve({ resolved: true }));

export const mockDeleteWorkflowNodeSessions = mock<IWorkflowStore['deleteWorkflowNodeSessions']>(
  () => Promise.resolve({ deleted: 0 })
);

export const mockReclaimContainerEnv = mock<WorkflowOperationsDeps['reclaimContainerEnv']>(() =>
  Promise.resolve()
);

/** What the stop path reports when nothing listens at the run's endpoint. */
export function noOwnerAnswers(): Promise<never> {
  return Promise.reject(new DetachedRunOwnerUnavailableError('run-1', 'ENOENT', 'unreachable'));
}
export const mockRequestDetachedRunStop =
  mock<typeof import('../../services/run-owner-stop').requestDetachedRunStop>(noOwnerAnswers);

export const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
};
export const mockCaptureApprovalResolved = mock(() => undefined);
mock.module('@archon/paths', () => ({
  captureApprovalResolved: mockCaptureApprovalResolved,
  createLogger: mock(() => mockLogger),
}));

export const {
  createWorkflowOperations,
  AbandonOwnerNotStoppedError,
  CancelRefusedError,
  describeAbandonOwner,
  assertAnswerable,
  assertApprovable,
  assertRejectable,
  ChildRunRedirectError,
  expectedGateForOccurrence,
  StaleGateAnswerError,
} = await import('../workflow-operations');
export const { isRunOwnedByThisProcess, isRunOwnerAnswering } = await import(
  '../../services/run-live-owner'
);
export const isolationStore: IIsolationStore = {
  listActive: () => {
    throw new Error('Unexpected isolation lookup');
  },
  getById: mock(async () => null),
  findActiveByWorkflow: () => {
    throw new Error('Unexpected isolation lookup');
  },
  create: () => {
    throw new Error('Unexpected isolation creation');
  },
  updateStatus: () => {
    throw new Error('Unexpected isolation update');
  },
  withWorktreeRegistration: async () => {
    throw new Error('Unexpected worktree removal');
  },
  markWorktreeDestroyed: () => {
    throw new Error('Unexpected isolation update');
  },
  updateMetadata: () => {
    throw new Error('unused');
  },
  countActiveByCodebase: () => {
    throw new Error('Unexpected isolation count');
  },
};
export const mockPersistWorkflowEvent = mock<
  WorkflowOperationsDeps['store']['persistWorkflowEvent']
>(async () => undefined);
export const store: WorkflowOperationsDeps['store'] = {
  persistWorkflowEvent: mockPersistWorkflowEvent,
  signalWorkflowWait: mock(async () => ({ signaled: true })),
  deleteWorkflowRun: mock(async () => undefined),
  getWorkflowRun: mockGetWorkflowRun,
  listWorkflowRuns: mockListWorkflowRuns,
  findWorkflowRunsByIdPrefix: async () => [],
  cancelWorkflowRun: mockCancelWorkflowRun,
  cancelResumableRunsForConversation: mockCancelResumableRunsForConversation,
  findChildRuns: mockFindChildRuns,
  getRunAncestry: mockGetRunAncestry,
  resolveApprovalGate: mockResolveApprovalGate,
  resolveAndCancelApprovalGate: mockResolveAndCancelApprovalGate,
  answerAttentionWait: async () => {
    throw new Error('Unexpected answerAttentionWait');
  },
  labelAttentionWait: async () => {
    throw new Error('Unexpected labelAttentionWait');
  },
  deleteWorkflowNodeSessions: mockDeleteWorkflowNodeSessions,
};
export const {
  approveWorkflow,
  rejectWorkflow,
  respondToWorkflow,
  getWorkflowStatus,
  resumeWorkflow,
  abandonWorkflow,
  cancelWorkflow,
  abandonResumableRunsForConversation,
  resetWorkflowNodeSessions,
} = createWorkflowOperations({
  getUserRole: async () => undefined,
  store,
  hostStore: { isolation: isolationStore },
  requestDetachedRunStop: mockRequestDetachedRunStop,
  isRunOwnedByThisProcess,
  isRunOwnerAnswering,
  reclaimRunWorktree: async () => ({ warnings: [] }),
  reclaimContainerEnv: mockReclaimContainerEnv,
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function makePausedRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: { conversationId: 'conv-1' },
    id: 'run-1',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'cb-1',
    status: 'paused',
    outcome: null,
    user_message: 'test',
    metadata: {
      approval: {
        nodeId: 'review',
        message: 'Please review',
        type: 'approval',
      },
    },
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/workspace/worktree',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    ...overrides,
  };
}

/**
 * A paused run whose recorded owner is this process, which is not executing it, with a
 * scratch checkout on disk under `outputRoot`.
 */
export function makeRunWithScratch(
  outputRoot: string,
  overrides: Partial<WorkflowRun> = {}
): { run: WorkflowRun; checkout: string } {
  const run = makePausedRun({
    output_root: outputRoot,
    ...overrides,
    metadata: {
      ...makePausedRun().metadata,
      execution_owner: { host: hostname(), pid: process.pid, uid: process.getuid?.() },
      ...overrides.metadata,
    },
  });
  const checkout = join(getRunScratchDir(getRunArtifactsDirForRoot(outputRoot, run.id)), 'repro');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  return { run, checkout };
}

export function makeDashboardRun(
  overrides: Partial<DashboardWorkflowRun> = {}
): DashboardWorkflowRun {
  return {
    ...makePausedRun(),
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

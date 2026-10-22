/** Fakes for the `@archon/core/db` modules the workflow commands read and write. */
import { PROVIDER_EVENT_ROW_TYPES } from '@archon/workflows/store';
import { mock } from 'bun:test';

mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(() => Promise.resolve({ id: 'user-cli-1' })),
}));

mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mock(() =>
    Promise.resolve({ id: 'conv-123', platform_type: 'cli', platform_conversation_id: 'cli-123' })
  ),
  getConversationById: mock(() =>
    Promise.resolve({
      id: 'conv-123',
      platform_type: 'cli',
      platform_conversation_id: 'cli-123',
    })
  ),
  updateConversation: mock(() => Promise.resolve()),
}));

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByDefaultCwd: mock(() => Promise.resolve(null)),
  listCodebaseClaims: mock(() => Promise.resolve([])),
  findCodebaseByPathPrefix: mock(() => Promise.resolve(null)),
  getCodebase: mock(() => Promise.resolve(null)),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  createIsolationStore: mock(() => ({})),
  updateMetadata: mock(async () => undefined),
  getById: mock((): Promise<null> => Promise.resolve(null)),
  findActiveByWorkflow: mock(() => Promise.resolve(null)),
  create: mock(() => Promise.resolve({ id: 'iso-123' })),
  listActive: mock(() => Promise.resolve([])),
  // Reached only by the --resume path. mock.module() MERGES over the real
  // module, so omitting this would leave the REAL implementation in place and
  // open a live SQLite handle rather than failing loudly (#2240).
  listByCodebase: mock(() => Promise.resolve([])),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(() => Promise.resolve()),
}));

/**
 * The row a `--detach` parent writes before forking (#2872). Only `id` is read by the
 * launch path; the child hands the whole row to `executeWorkflow` as `preCreatedRun`.
 */
export const mockCreateWorkflowRun = mock(
  (data: {
    workflow_name: string;
    id?: string;
    origin?: import('@archon/workflows/schemas/workflow-run').WorkflowRunOrigin;
  }) =>
    Promise.resolve({
      origin: data.origin ?? null,
      id: data.id ?? 'run-detached-created',
      workflow_name: data.workflow_name,
      conversation_id: data.origin?.conversationId ?? null,
      status: 'pending',
      working_path: null,
      started_at: new Date(),
      metadata: {},
    })
);

const EMPTY_STATUS_COUNTS = {
  all: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  pending: 0,
  paused: 0,
};
export const mockListDashboardRuns = mock(() =>
  Promise.resolve({ runs: [] as unknown[], total: 0, counts: EMPTY_STATUS_COUNTS })
);
export function statusRuns(runs: unknown[]): {
  runs: unknown[];
  total: number;
  counts: typeof EMPTY_STATUS_COUNTS;
} {
  return { runs, total: runs.length, counts: EMPTY_STATUS_COUNTS };
}

export const mockLookupWorkflowRun = mock<
  typeof import('@archon/core/db/workflows').getWorkflowRun
>(async () => null);
export const mockCancelWorkflowRunCommand = mock<
  typeof import('@archon/core/db/workflows').cancelWorkflowRun
>(async () => ({ cancelled: true }));

mock.module('@archon/core/db/workflows', () => ({
  insertWorkflowRun: async (): Promise<never> => {
    throw new Error('Unexpected admission run insert');
  },
  createWorkflowRun: mockCreateWorkflowRun,
  getActiveWorkflowRun: mock(() => Promise.resolve(null)),
  getWorkflowRunStatus: mock(() => Promise.resolve(null)),
  failWorkflowRun: mock(() => Promise.resolve({ failed: true })),
  cancelWorkflowRun: mockCancelWorkflowRunCommand,
  findChildRuns: mock(() => Promise.resolve([])),
  getRunAncestry: mock(() => Promise.resolve([])),
  findResumableRun: mock(() => Promise.resolve(null)),
  resumeWorkflowRun: mock(() => Promise.resolve(null)),
  getWorkflowRun: mockLookupWorkflowRun,
  findAdoptingRuns: mock(() => Promise.resolve([])),
  findWorkflowRunsByIdPrefix: mock(() => Promise.resolve([])),
  updateWorkflowRun: mock(() => Promise.resolve()),
  // CAS gate resolvers (#2113) — approve/reject stamp the resolution here;
  // resolveAndCancelApprovalGate atomically resolves+cancels terminal rejects.
  resolveApprovalGate: mock(() => Promise.resolve({ resolved: true })),
  resolveAndCancelApprovalGate: mock(() => Promise.resolve({ resolved: true })),
  listWorkflowRuns: mock(() => Promise.resolve([])),
  listDashboardRuns: mockListDashboardRuns,
  findOpenWorkRuns: mock(() => Promise.resolve([])),
  deleteOldWorkflowRuns: mock(() => Promise.resolve({ count: 0 })),
  deleteWorkflowRun: mock(() => Promise.resolve()),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(() => Promise.resolve([])),
  listEventsForRuns: mock(() => Promise.resolve(new Map())),
  createWorkflowEvent: mock(() => Promise.resolve()),
  PROVIDER_EVENT_ROW_TYPES,
}));

// Reset-sessions runs the real resetWorkflowNodeSessions operation over this mocked
// DB layer, as the other workflow commands do. Safe from mock.module pollution:
// every suite using the harness is its own isolated `bun test` invocation.
export const mockDeleteNodeSessions = mock(() => Promise.resolve({ deleted: 0 }));
mock.module('@archon/core/db/workflow-node-sessions', () => ({
  deleteWorkflowNodeSessions: mockDeleteNodeSessions,
  listWorkflowNodeSessions: mock(() => Promise.resolve([])),
  upsertWorkflowNodeSession: mock(() => Promise.resolve()),
}));

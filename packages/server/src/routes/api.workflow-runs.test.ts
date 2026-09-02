import { describe, test, expect, mock, beforeAll, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { DashboardWorkflowRun } from '@archon/core/db/workflows';
import type { resolveRunContinuation } from '@archon/core/handlers';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { makeTestResolvedWorkflow } from '@archon/workflows/test-utils';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import {
  dashboardWorkflowRunSchema as apiDashboardWorkflowRunSchema,
  workflowRunSchema as apiWorkflowRunSchema,
} from './schemas/workflow.schemas';
import {
  makeDashboardRunsResult,
  makeListDashboardRunsMock,
  mockAllWorkflowModules,
} from '../test/workflow-mock-factories';

beforeAll(async (): Promise<void> => {
  const { registerBuiltinProviders, registerCommunityProviders } =
    await import('@archon/providers');
  registerBuiltinProviders();
  registerCommunityProviders();
});

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock(async (_id: string) => null as null | MockWorkflowRun);
const mockCancelWorkflowRun = mock(async (_id: string) => ({ cancelled: true }));
type ListWorkflowRunsOptions = Parameters<
  (typeof import('@archon/core/db/workflows'))['listWorkflowRuns']
>[0];

const mockListWorkflowRuns = mock<
  (_options?: ListWorkflowRunsOptions) => Promise<MockWorkflowRun[]>
>(async () => []);
const mockListDashboardRuns = makeListDashboardRunsMock();
const mockGetWorkflowRunByWorkerPlatformId = mock(
  async (_id: string) => null as null | MockWorkflowRun
);
const mockListWorkflowEvents = mock(async (_runId: string) => [] as MockWorkflowEvent[]);
const mockGetConversationById = mock(
  async (_id: string) =>
    null as null | { id: string; platform_conversation_id: string; platform_type: string }
);
const mockFindConversationByPlatformId = mock(
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
const mockHandleMessage = mock<(typeof import('@archon/core'))['handleMessage']>(async () => {});
const mockAddMessage = mock(async () => ({
  id: 'msg-1',
  conversation_id: 'conv-1',
  role: 'user' as const,
  content: 'hi',
  metadata: '{}',
  created_at: new Date().toISOString(),
}));
const mockGenerateAndSetTitle = mock(async () => {});
const mockResolveTitleRequest = mock(async () => ({
  provider: 'claude',
  options: {} as Record<string, unknown>,
}));

// Type aliases for clarity in tests
type MockWorkflowRun = Omit<WorkflowRun, 'conversation_id' | 'last_activity_at'> & {
  conversation_id: WorkflowRun['conversation_id'] | null;
  last_activity_at: WorkflowRun['last_activity_at'] | undefined;
};

type MockWorkflowEvent = {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
};

describe('workflow run API wait metadata', () => {
  const attentionWait = {
    owner: 'loop_group' as const,
    nodeId: 'recover-ci',
    bodyWaitId: 'pause',
    iteration: 14,
    sessionId: null,
    sessionProvider: null,
    kind: 'attention' as const,
    waitingSince: '2026-08-31T10:00:00.000Z',
    message: 'Re-run CI, then resume.',
  };

  test('projects the engine wait union through regular and dashboard run metadata', () => {
    const metadata = { wait: attentionWait, custom: 'preserved' };

    expect(apiWorkflowRunSchema.shape.metadata.parse(metadata)).toEqual(metadata);
    expect(apiDashboardWorkflowRunSchema.shape.metadata.parse(metadata)).toEqual(metadata);
  });

  test('rejects a malformed projected wait while leaving unrelated metadata open-ended', () => {
    expect(
      apiWorkflowRunSchema.shape.metadata.safeParse({
        wait: { ...attentionWait, waitingSince: undefined },
      }).success
    ).toBe(false);
    expect(apiWorkflowRunSchema.shape.metadata.parse({ custom: { nested: true } })).toEqual({
      custom: { nested: true },
    });
  });
});

// resumeRunHeadless (#2008) — stubbed so a future change to it or its
// neighbors can't silently start touching the real workflow store or the
// real isolation provider (see #2240 for what an un-stubbed export costs).
const mockCreateChildWorktreeResolver = mock((_config: unknown) =>
  mock(async () => ({}) as unknown)
);

mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mockGenerateAndSetTitle,
  resolveTitleRequest: mockResolveTitleRequest,
  createWorkflowDeps: mock(() => ({ store: {} })),
  createChildWorktreeResolver: mockCreateChildWorktreeResolver,
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

/**
 * Deterministic stand-ins for the shared identity→paths helpers (#2200),
 * mirroring the real branch order and layout under the mocked ARCHON_HOME.
 */
type FakeStorageKey =
  | { kind: 'repo'; owner: string; repo: string }
  | { kind: 'folder'; slug: string }
  | { kind: 'cwd'; cwd: string };

function parseOwnerRepoFake(name: string): { owner: string; repo: string } | null {
  const parts = name.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}

function basenameFake(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? '';
}

function resolveProjectStorageKeyFake(
  codebase: { kind?: string | null; name: string; default_cwd: string } | null | undefined,
  cwd: string
): FakeStorageKey {
  if (codebase) {
    if (codebase.kind === 'folder') {
      const slug =
        codebase.name
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'folder';
      return { kind: 'folder', slug };
    }
    const parsed = parseOwnerRepoFake(codebase.name);
    if (parsed) return { kind: 'repo', ...parsed };
    const base = basenameFake(codebase.default_cwd);
    if (base && base !== '.' && base !== '..') return { kind: 'repo', owner: '_local', repo: base };
  }
  return { kind: 'cwd', cwd };
}

/**
 * Mutable so the filesystem-touching artifact tests can point ARCHON_HOME at a
 * real temp dir. A hard-coded '/tmp/...' is fine for tests that only assert
 * status codes, but tests that mkdir/readdir need a path that is absolute on
 * Windows too.
 */
let mockArchonHome = '/tmp/.archon';
function wsRoot(): string {
  return join(mockArchonHome, 'workspaces');
}

function storageRootFake(key: FakeStorageKey): string {
  if (key.kind === 'repo') return join(wsRoot(), key.owner, key.repo);
  if (key.kind === 'folder') return join(wsRoot(), '_folder', key.slug);
  return join(wsRoot(), '_cwd', basenameFake(key.cwd) || '_');
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

const mockCaptureApprovalResolved = mock(() => undefined);
mock.module('@archon/paths', () => ({
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
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
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
  getRunArtifactsDirForKey: (key: FakeStorageKey, runId: string): string =>
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
const mockGetCodebase = mock(async (_id: string) => null as null | MockCodebase);

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mockGetCodebase,
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

const mockDeleteWorkflowRun = mock(async (_id: string) => {});
const mockUpdateWorkflowRun = mock(async (_id: string, _update: unknown) => {});
// CAS gate resolvers (#2113) — the real approve/reject operations stamp the
// resolution here. resolveAndCancelApprovalGate is the atomic resolve+cancel for
// terminal reject outcomes. Default to "won the race".
// The 3rd arg (approve) / 2nd arg (cancel) is the audit-event batch written in the
// same transaction as the resolution (#2146).
const mockResolveApprovalGate = mock(async (_id: string, _md: unknown, _events?: unknown) => ({
  resolved: true,
}));
const mockResolveAndCancelApprovalGate = mock(async (_id: string, _events?: unknown) => ({
  resolved: true,
}));
const mockFindChildRuns = mock(async (_parentRunId: string): Promise<unknown[]> => []);
const mockSignalWorkflowWait = mock(async (_id: string, _wait: unknown, _payload?: unknown) => ({
  signaled: true,
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mockListWorkflowRuns,
  listDashboardRuns: mockListDashboardRuns,
  getWorkflowRun: mockGetWorkflowRun,
  findChildRuns: mockFindChildRuns,
  cancelWorkflowRun: mockCancelWorkflowRun,
  deleteWorkflowRun: mockDeleteWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
  resolveApprovalGate: mockResolveApprovalGate,
  resolveAndCancelApprovalGate: mockResolveAndCancelApprovalGate,
  signalWorkflowWait: mockSignalWorkflowWait,
  getWorkflowRunByWorkerPlatformId: mockGetWorkflowRunByWorkerPlatformId,
}));

const mockCreateWorkflowEvent = mock(async (_event: unknown) => {});

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mockListWorkflowEvents,
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

// resumeRunHeadless (#2008) — the direct in-process resume fallback used when
// a run has no parent conversation to dispatch a chat message through.
type RunContinuationResult = Awaited<ReturnType<typeof resolveRunContinuation>>;
const mockResolveRunContinuation = mock(
  async (_runId: string, _cwd: string): Promise<RunContinuationResult> => ({
    ok: true,
    workflowName: 'deploy',
    workflow: { definition: makeTestResolvedWorkflow({ name: 'deploy' }), args: '' },
  })
);
mock.module('@archon/core/handlers', () => ({
  resolveRunContinuation: mockResolveRunContinuation,
}));

const mockHydrateResumableRun = mock<
  (typeof import('@archon/workflows/executor'))['hydrateResumableRun']
>(async (_deps, run) => ({
  preCreatedRun: { ...run, status: 'running' },
  priorCompletedNodes: new Map(),
  priorUsage: { costUsd: 0 },
  priorNodeSessions: [],
}));
const mockExecuteWorkflow = mock<(typeof import('@archon/workflows/executor'))['executeWorkflow']>(
  async () => ({ success: true, workflowRunId: 'run-1' })
);
mock.module('@archon/workflows/executor', () => ({
  hydrateResumableRun: mockHydrateResumableRun,
  executeWorkflow: mockExecuteWorkflow,
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();
const NOW_DATE = new Date(NOW);

const MOCK_RUNNING_RUN = {
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
} satisfies MockWorkflowRun;

const MOCK_COMPLETED_RUN = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-2',
  status: 'completed',
  outcome: 'failed',
  completed_at: NOW_DATE,
} satisfies MockWorkflowRun;

const MOCK_FAILED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-4',
  status: 'failed',
  outcome: 'succeeded',
  completed_at: NOW_DATE,
};

const MOCK_PENDING_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-3',
  status: 'pending',
};

function makeDashboardWorkflowRun(run: WorkflowRun): DashboardWorkflowRun {
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

const MOCK_EVENTS: MockWorkflowEvent[] = [
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

const MOCK_CONV = {
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

function makeApp(): { app: OpenAPIHono; mockWebAdapter: WebAdapter } {
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
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return { app, mockWebAdapter };
}

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/:name/run
// ---------------------------------------------------------------------------

describe('POST /api/workflows/:name/run', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockHandleMessage.mockReset();
    mockAddMessage.mockReset();
    mockGenerateAndSetTitle.mockReset();
  });

  test('dispatches workflow run to orchestrator and returns accepted', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Deploy to staging',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy to staging' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { accepted: boolean; status: string };
    expect(body.accepted).toBe(true);
    expect(body.status).toBe('started');
  });

  test('sends /workflow run <name> <message> to orchestrator', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Run tests',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/test-suite/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Run tests' }),
    });

    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      '/workflow run test-suite Run tests',
      expect.objectContaining({
        isolationHints: { workflowType: 'thread', workflowId: 'web-test-abc' },
      })
    );
  });

  test('accepts a percent-encoded namespaced name and forwards the decoded name', async () => {
    // Regression guard: percent-encoded '/' must be decoded and validate, not raw-route to 400.
    const { isValidWorkflowName, isValidCommandName } =
      await import('@archon/workflows/command-validation');
    const segmentOk = (seg: string) =>
      !!seg && !seg.startsWith('.') && !seg.includes('\\') && !seg.includes('..');
    // Real namespaced logic: `triage/review` is valid (one subfolder deep).
    (isValidWorkflowName as ReturnType<typeof mock>).mockImplementationOnce((name: string) => {
      if (!name) return false;
      const segments = name.split('/');
      if (segments.length > 2) return false;
      return segments.every(segmentOk);
    });
    // Strict command logic that rejects `/`, so this test goes red if the run
    // route validates with isValidCommandName instead of isValidWorkflowName.
    (isValidCommandName as ReturnType<typeof mock>).mockImplementationOnce(
      (name: string) => segmentOk(name) && !name.includes('/')
    );

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Run triage',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/triage%2Freview/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Run triage' }),
    });
    expect(response.status).toBe(200);

    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      '/workflow run triage/review Run triage',
      expect.objectContaining({
        isolationHints: { workflowType: 'thread', workflowId: 'web-test-abc' },
      })
    );
  });

  test('persists user message to DB when conversation found', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Deploy',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy' }),
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      MOCK_CONV.id,
      'user',
      'Deploy',
      undefined,
      undefined
    );
  });

  test('fires title generation for conversations without title', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => ({
      ...MOCK_CONV,
      title: null,
    }));
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Deploy',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Deploy' }),
    });

    // generateAndSetTitle is fire-and-forget; just verify it was called
    // (it runs asynchronously so we check the mock was called, not the result)
    // Allow the microtask queue to flush
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockGenerateAndSetTitle).toHaveBeenCalled();
  });

  test('returns 400 when conversationId is missing', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Deploy to staging' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('conversationId');
  });

  test('returns 400 when message is missing', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('message');
  });

  test('returns 400 for invalid workflow name (path traversal)', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/../secret/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Test' }),
    });
    // Hono routes won't match ../secret as /:name due to path normalization — either 400 or 404
    expect([400, 404]).toContain(response.status);
  });

  test('returns 400 when isValidWorkflowName rejects the name', async () => {
    const { isValidWorkflowName } = await import('@archon/workflows/command-validation');
    (isValidWorkflowName as ReturnType<typeof mock>).mockReturnValueOnce(false);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/.hidden/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Test' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid workflow name');
  });

  test('returns 400 for malformed JSON body', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {{{',
    });
    expect(response.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Declared inputs (#2554)
  // -------------------------------------------------------------------------

  test('forwards a JSON `inputs` map on the context, never in the message text', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Review it',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/review-block/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'web-test-abc',
        message: 'Review it',
        inputs: { diff: 'D1', style: 'terse' },
      }),
    });
    expect(response.status).toBe(200);

    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      // The command text is untouched — a supplied value must never be confusable
      // with $ARGUMENTS, and this route must not invent a chat grammar.
      '/workflow run review-block Review it',
      expect.objectContaining({ workflowInputs: { diff: 'D1', style: 'terse' } })
    );
  });

  test('omits workflowInputs entirely when no inputs are supplied', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Go',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go' }),
    });

    const ctx = mockHandleMessage.mock.calls[0]?.[3];
    expect(ctx).not.toHaveProperty('workflowInputs');
  });

  test('returns 400 when `inputs` is not an object of strings', async () => {
    const { app } = makeApp();
    for (const inputs of [['a'], 'nope', { diff: 5 }, { diff: null }]) {
      const response = await app.request('/api/workflows/deploy/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', inputs }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('inputs');
    }
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('treats an explicit empty `inputs` object as nothing supplied', async () => {
    // `{}` is valid, not an error — it means "take every declared default", so the
    // context must carry no workflowInputs rather than an empty map.
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Go',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/deploy/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', inputs: {} }),
    });
    expect(response.status).toBe(200);

    const ctx = mockHandleMessage.mock.calls[0]?.[3];
    expect(ctx).not.toHaveProperty('workflowInputs');
  });

  test('accepts a multipart `inputs` field carrying the map JSON-encoded', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Review it',
      metadata: '{}',
      created_at: NOW,
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const form = new FormData();
    form.append('conversationId', 'web-test-abc');
    form.append('message', 'Review it');
    form.append('inputs', JSON.stringify({ diff: 'D1' }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/review-block/run', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(200);

    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      '/workflow run review-block Review it',
      expect.objectContaining({ workflowInputs: { diff: 'D1' } })
    );
  });

  test('returns 400 for a malformed multipart `inputs` field rather than dropping it', async () => {
    const form = new FormData();
    form.append('conversationId', 'web-test-abc');
    form.append('message', 'Review it');
    form.append('inputs', 'not json {{{');

    const { app } = makeApp();
    const response = await app.request('/api/workflows/review-block/run', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(400);
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('forwards sparse JSON tier and alias bindings as structured context', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockHandleMessage.mockImplementationOnce(async () => {});
    const { app } = makeApp();
    const response = await app.request('/api/workflows/bench/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'web-test-abc',
        message: 'Go',
        tiers: { large: 'openai/gpt-5.6' },
        aliases: { '@planner': 'codex/gpt-5.6-sol' },
      }),
    });

    expect(response.status).toBe(200);
    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      '/workflow run bench Go',
      expect.objectContaining({
        workflowModelOverrides: {
          tiers: { large: 'openai/gpt-5.6' },
          aliases: { '@planner': 'codex/gpt-5.6-sol' },
        },
      })
    );
  });

  test('accepts multipart tier and alias maps as JSON object fields', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockHandleMessage.mockImplementationOnce(async () => {});
    const form = new FormData();
    form.append('conversationId', 'web-test-abc');
    form.append('message', 'Go');
    form.append('tiers', JSON.stringify({ large: 'openai/gpt-5.6' }));
    form.append('aliases', JSON.stringify({ '@planner': 'codex/gpt-5.6-sol' }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/bench/run', {
      method: 'POST',
      body: form,
    });

    expect(response.status).toBe(200);
    const context = mockHandleMessage.mock.calls[0]?.[3];
    expect(context?.workflowModelOverrides).toEqual({
      tiers: { large: 'openai/gpt-5.6' },
      aliases: { '@planner': 'codex/gpt-5.6-sol' },
    });
  });

  test('rejects malformed model binding maps before dispatch', async () => {
    const { app } = makeApp();
    for (const payload of [
      { tiers: { tiny: 'x' } },
      { tiers: { large: 5 } },
      { aliases: { planner: 'x' } },
      { aliases: ['@planner=x'] },
    ]) {
      const response = await app.request('/api/workflows/bench/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', ...payload }),
      });
      expect(response.status).toBe(400);
    }
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('forwards validated inline JSON config as structured context', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockHandleMessage.mockImplementationOnce(async () => {});
    const { app } = makeApp();
    const response = await app.request('/api/workflows/bench/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'web-test-abc',
        message: 'Go',
        config: {
          defaultAssistant: 'pi',
          tiers: { small: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
          env: { BENCH_TOKEN: 'secret' },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(mockHandleMessage).toHaveBeenCalledWith(
      expect.anything(),
      'web-test-abc',
      '/workflow run bench Go',
      expect.objectContaining({
        workflowRunConfig: {
          source: { kind: 'http', label: 'inline' },
          layer: {
            assistant: 'pi',
            tiers: { small: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
            envVars: { BENCH_TOKEN: 'secret' },
          },
        },
      })
    );
  });

  test('accepts multipart config as a JSON-encoded object', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockHandleMessage.mockImplementationOnce(async () => {});
    const form = new FormData();
    form.append('conversationId', 'web-test-abc');
    form.append('message', 'Go');
    form.append('config', JSON.stringify({ docs: { path: 'handbook' } }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/bench/run', {
      method: 'POST',
      body: form,
    });

    expect(response.status).toBe(200);
    const context = mockHandleMessage.mock.calls[0]?.[3];
    expect(context?.workflowRunConfig).toEqual({
      source: { kind: 'http', label: 'inline' },
      layer: { docsPath: 'handbook' },
    });
  });

  test('rejects caller-supplied server paths and ineffective config before dispatch', async () => {
    const { app } = makeApp();
    const invalidConfigs = [
      [{ configPath: '/etc/passwd' }, 'configPath is not supported'],
      [{ config: null }, "Invalid run config at 'document'"],
      [{ config: { paths: { worktrees: '/tmp/other' } } }, "Run config key 'paths' cannot apply"],
      [{ config: { unknown: true } }, "Unknown run config key 'unknown'"],
    ] as const;
    for (const [payload, expectedError] of invalidConfigs) {
      const response = await app.request('/api/workflows/bench/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'web-test-abc', message: 'Go', ...payload }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining(expectedError),
      });
    }
    for (const [payload, expectedError] of invalidConfigs) {
      const form = new FormData();
      form.append('conversationId', 'web-test-abc');
      form.append('message', 'Go');
      if ('configPath' in payload) form.append('configPath', payload.configPath);
      if ('config' in payload) form.append('config', JSON.stringify(payload.config));
      const response = await app.request('/api/workflows/bench/run', {
        method: 'POST',
        body: form,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining(expectedError),
      });
    }
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/cancel
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/cancel', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockReset();
  });

  test('cancels a running workflow run and returns success', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockCancelWorkflowRun.mockImplementationOnce(async () => ({ cancelled: true }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('deploy');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-uuid-1');
  });

  test('cancels a pending workflow run and returns success', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_PENDING_RUN);
    mockCancelWorkflowRun.mockImplementationOnce(async () => ({ cancelled: true }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-3/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  test('reports "nothing to cancel" when the run finished in the cancel TOCTOU window', async () => {
    // Run passes the status pre-check (running), but cancelWorkflowRun no-ops
    // because the run reached a terminal state first — the route must not claim
    // a false "Cancelled" (#1830 I1).
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockCancelWorkflowRun.mockImplementationOnce(async () => ({ cancelled: false }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('nothing to cancel');
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/unknown-run/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 400 when trying to cancel a completed run', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_COMPLETED_RUN);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('completed');
  });

  test('returns 400 when trying to cancel an already-cancelled run', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'cancelled' as const,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('cancelled');
  });

  test('returns 400 when trying to cancel a failed run', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      status: 'failed' as const,
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
  });

  test('returns 500 when DB throws during cancel', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockCancelWorkflowRun.mockImplementationOnce(async () => {
      throw new Error('DB locked');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to cancel');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/workflows/runs
// ---------------------------------------------------------------------------

describe('GET /api/workflows/runs', () => {
  beforeEach(() => {
    mockListWorkflowRuns.mockReset();
  });

  test('returns empty runs array when no runs exist', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { runs: unknown[] };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBe(0);
  });

  test('returns list of workflow runs', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => [MOCK_RUNNING_RUN, MOCK_COMPLETED_RUN]);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      runs: Array<{ id: string; outcome: 'succeeded' | 'failed' | null }>;
    };
    expect(body.runs.length).toBe(2);
    expect(body.runs[0]?.id).toBe('run-uuid-1');
    expect(body.runs.map(run => run.outcome)).toEqual([null, 'failed']);
  });

  test('converts Date objects to ISO strings in response', async () => {
    const now = new Date('2025-06-01T12:00:00.000Z');
    mockListWorkflowRuns.mockImplementationOnce(async () => [
      {
        ...MOCK_RUNNING_RUN,
        started_at: now,
        completed_at: null,
        last_activity_at: undefined,
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      runs: Array<{ started_at: string; completed_at: null; last_activity_at: null }>;
    };
    expect(body.runs[0]?.started_at).toBe('2025-06-01T12:00:00.000Z');
    expect(body.runs[0]?.completed_at).toBeNull();
    expect(body.runs[0]?.last_activity_at).toBeNull();
  });

  test('filters by status query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => [MOCK_RUNNING_RUN]);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?status=running');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBe('running');
  });

  test('ignores invalid status values', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?status=invalid_status');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBeUndefined();
  });

  test('filters by conversationId query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?conversationId=conv-123');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.conversationId).toBe('conv-123');
  });

  test('filters by codebaseId query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?codebaseId=cb-uuid-1');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.codebaseId).toBe('cb-uuid-1');
  });

  test('caps limit at 200', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?limit=9999');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.limit).toBeLessThanOrEqual(200);
  });

  test('uses default limit of 50 when not specified', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs');

    const [callArgs] = mockListWorkflowRuns.mock.calls[0] ?? [];
    expect(callArgs?.limit).toBe(50);
  });

  test('returns 500 when DB throws', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => {
      throw new Error('DB failure');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list workflow runs');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/workflows/runs/:runId
// ---------------------------------------------------------------------------

describe('GET /api/workflows/runs/:runId', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockListWorkflowEvents.mockReset();
    mockGetConversationById.mockReset();
  });

  test('returns run with events for a known runId', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_RUNNING_RUN);
    mockListWorkflowEvents.mockImplementationOnce(async () => MOCK_EVENTS);
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'web-conv-abc',
      platform_type: 'web',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: { id: string; workflow_name: string };
      events: Array<{ event_type: string }>;
    };
    expect(body.run.id).toBe('run-uuid-1');
    expect(body.run.workflow_name).toBe('deploy');
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(3);
    expect(body.events[0]?.event_type).toBe('step_started');
    expect(body.events[2]?.event_type).toBe('tool_called');
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/unknown-run-id');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns authored outcome independently from failed lifecycle status', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => MOCK_FAILED_RUN);
    mockListWorkflowEvents.mockImplementationOnce(async () => []);
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'web-conv-abc',
      platform_type: 'web',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run: { status: string; outcome: string | null };
    };
    expect(body.run).toMatchObject({ status: 'failed', outcome: 'succeeded' });
  });

  test('includes conversation_platform_id for CLI runs (no parent_conversation_id)', async () => {
    // CLI run: conversation_id set, no parent_conversation_id
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      parent_conversation_id: null,
    }));
    mockListWorkflowEvents.mockImplementationOnce(async () => []);
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'cli-conv-xyz',
      platform_type: 'cli',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: {
        conversation_platform_id: string | null;
        worker_platform_id: string | undefined;
      };
    };
    // CLI run: conversation_platform_id should be set, worker_platform_id should be undefined
    expect(body.run.conversation_platform_id).toBe('cli-conv-xyz');
    expect(body.run.worker_platform_id).toBeUndefined();
  });

  test('includes worker_platform_id for web runs (with parent_conversation_id)', async () => {
    // Web run: conversation_id is the worker, parent_conversation_id is the parent
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      parent_conversation_id: 'parent-conv-uuid',
    }));
    mockListWorkflowEvents.mockImplementationOnce(async () => []);
    // First call: worker conversation
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'conv-uuid-1',
      platform_conversation_id: 'worker-platform-id',
      platform_type: 'web',
    }));
    // Second call: parent conversation
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'parent-conv-uuid',
      platform_conversation_id: 'parent-platform-id',
      platform_type: 'web',
    }));

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: {
        worker_platform_id: string | undefined;
        parent_platform_id: string | undefined;
        conversation_platform_id: string | null;
      };
    };
    expect(body.run.worker_platform_id).toBe('worker-platform-id');
    expect(body.run.parent_platform_id).toBe('parent-platform-id');
  });

  test('returns run with null conversation fields when no conversation_id', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      conversation_id: null,
      parent_conversation_id: null,
    }));
    mockListWorkflowEvents.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: { conversation_platform_id: null };
    };
    expect(body.run.conversation_platform_id).toBeNull();
  });

  test('returns 500 when DB throws', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => {
      throw new Error('DB timeout');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get workflow run');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/dashboard/runs
// ---------------------------------------------------------------------------

describe('GET /api/dashboard/runs', () => {
  beforeEach(() => {
    mockListDashboardRuns.mockReset();
  });

  test('returns paginated runs with total and counts', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () =>
      makeDashboardRunsResult({
        runs: [
          {
            ...makeDashboardWorkflowRun(MOCK_RUNNING_RUN),
            active_nodes: ['parallel-a', 'parallel-b'],
          },
          makeDashboardWorkflowRun(MOCK_COMPLETED_RUN),
        ],
        total: 2,
        counts: { all: 5, running: 1, completed: 2, failed: 1, cancelled: 1 },
      })
    );

    const { app } = makeApp();
    const response = await app.request('/api/dashboard/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      runs: Array<{ status: string; outcome: string | null; active_nodes: string[] }>;
      total: number;
      counts: { all: number };
    };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBe(2);
    expect(body.runs[0]?.active_nodes).toEqual(['parallel-a', 'parallel-b']);
    expect(body.runs[1]).toMatchObject({ status: 'completed', outcome: 'failed' });
    expect(body.total).toBe(2);
    expect(body.counts.all).toBe(5);
  });

  test('filters by status query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=running');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBe('running');
  });

  test('accepts paused as valid status', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=paused');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBe('paused');
  });

  test('ignores invalid status values in dashboard runs', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=bogus');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.status).toBeUndefined();
  });

  test('filters by codebaseId query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?codebaseId=cb-1');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.codebaseId).toBe('cb-1');
  });

  test('filters by search query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?search=deploy');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.search).toBe('deploy');
  });

  test('supports after and before date filters', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?after=2024-01-01T00:00:00Z&before=2024-12-31T23:59:59Z');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.after).toBe('2024-01-01T00:00:00Z');
    expect(callArgs?.before).toBe('2024-12-31T23:59:59Z');
  });

  test('caps limit at 200', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?limit=9999');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.limit).toBeLessThanOrEqual(200);
  });

  test('supports offset for pagination', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => makeDashboardRunsResult());

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?offset=50');

    const [callArgs] = mockListDashboardRuns.mock.calls[0] ?? [];
    expect(callArgs?.offset).toBe(50);
  });

  test('returns 500 when DB throws', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => {
      throw new Error('query timeout');
    });

    const { app } = makeApp();
    const response = await app.request('/api/dashboard/runs');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list dashboard runs');
  });
});

describe('GET /api/workflows/runs/by-worker/:platformId', () => {
  beforeEach(() => {
    mockGetWorkflowRunByWorkerPlatformId.mockReset();
  });

  test('returns run when found', async () => {
    mockGetWorkflowRunByWorkerPlatformId.mockResolvedValueOnce(MOCK_COMPLETED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/by-worker/some-platform-id');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      run: { status: string; outcome: string | null };
    };
    expect(body.run).toMatchObject({ status: 'completed', outcome: 'failed' });
  });

  test('returns 404 when not found', async () => {
    mockGetWorkflowRunByWorkerPlatformId.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/by-worker/unknown-id');
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/resume
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/resume', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockGetConversationById.mockReset();
    mockHandleMessage.mockReset();
    mockResolveRunContinuation.mockClear();
    mockHydrateResumableRun.mockClear();
    mockExecuteWorkflow.mockClear();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not in failed status', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot resume');
  });

  test('resumes headlessly (no dispatch) when run has no parent_conversation_id (#2008)', async () => {
    // A CLI-launched run has no parent conversation to dispatch a chat
    // message through — it now resumes directly, in-process, instead of
    // being stranded until someone runs the CLI.
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: null,
      working_path: '/tmp/worktrees/run-uuid-4',
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Resuming workflow');
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockGetConversationById).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    const cwd = mockExecuteWorkflow.mock.calls[0]?.[3];
    expect(cwd).toBe('/tmp/worktrees/run-uuid-4');
  });

  test('returns 400 with CLI hint when the run has no parent conversation and cannot be resolved headlessly', async () => {
    // Safe degrade: the workflow source is unresolvable (e.g. deleted) —
    // falls back to the existing CLI-hint response instead of a silent 500.
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: null,
      working_path: '/tmp/worktrees/run-uuid-4',
    });
    mockResolveRunContinuation.mockResolvedValueOnce({
      ok: false,
      message: 'workflow deleted',
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('archon workflow resume run-uuid-4');
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('returns 400 when parent conversation no longer exists', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: 'deleted-conv-uuid',
    });
    mockGetConversationById.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('returns 400 when parent conversation is non-web', async () => {
    // Slack/Telegram/GitHub-sourced runs cannot route through the web
    // adapter — the dispatcher is wired to webAdapter + lockManager.
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: 'slack-parent-uuid',
    });
    mockGetConversationById.mockResolvedValueOnce({
      id: 'slack-parent-uuid',
      platform_conversation_id: '1234567890.123456',
      platform_type: 'slack',
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('archon workflow resume run-uuid-4');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('returns 200 and dispatches resume when parent is a web conversation', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_FAILED_RUN,
      parent_conversation_id: 'parent-conv-uuid',
      user_message: 'Run the deploy',
    });
    mockGetConversationById.mockResolvedValueOnce({
      id: 'parent-conv-uuid',
      platform_conversation_id: 'web-plat-abc',
      platform_type: 'web',
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Resuming workflow');

    // dispatchToOrchestrator → lockManager → handleMessage
    expect(mockHandleMessage).toHaveBeenCalled();
    const [, platformConvId, dispatchedMessage] = mockHandleMessage.mock.calls[0] ?? [];
    expect(platformConvId).toBe('web-plat-abc');
    expect(dispatchedMessage).toBe('/workflow resume run-uuid-4');
  });
});

describe('POST /api/workflows/runs/:runId/signal', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockGetConversationById.mockReset();
    mockHandleMessage.mockReset();
    mockSignalWorkflowWait.mockReset();
    mockSignalWorkflowWait.mockResolvedValue({ signaled: true });
    mockHydrateResumableRun.mockClear();
    mockExecuteWorkflow.mockClear();
  });

  test('atomically signals the matching event wait and leaves continuation to the scheduler', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_RUNNING_RUN,
      id: 'run-wait-1',
      status: 'paused',
      working_path: '/tmp/worktrees/run-wait-1',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'checks',
          kind: 'event',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-1/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'checks.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
        payload: { conclusion: 'success' },
      }),
    });

    expect(response.status).toBe(200);
    expect(mockSignalWorkflowWait).toHaveBeenCalledWith(
      'run-wait-1',
      {
        owner: 'node',
        nodeId: 'checks',
        kind: 'event',
        event: 'checks.complete',
        waitingSince: '2026-08-24T10:00:00.000Z',
        resumeAt: '2026-08-25T10:00:00.000Z',
      },
      { conclusion: 'success' }
    );
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockHandleMessage).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      message: "Signaled 'checks.complete'. The workflow will resume shortly.",
    });
  });

  test('acknowledges a web-parented signal without inline routing after commit', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_RUNNING_RUN,
      id: 'run-wait-web',
      status: 'paused',
      parent_conversation_id: 'parent-conv-uuid',
      working_path: '/tmp/worktrees/run-wait-web',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'checks',
          kind: 'event',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-web/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'checks.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockGetConversationById).not.toHaveBeenCalled();
  });

  test('forwards the exact loop-owned wait occurrence to the signal CAS', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_RUNNING_RUN,
      id: 'run-loop-wait',
      status: 'paused',
      metadata: {
        wait: {
          owner: 'loop_group',
          nodeId: 'release',
          bodyWaitId: 'checks',
          iteration: 2,
          sessionId: null,
          sessionProvider: null,
          kind: 'event',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-loop-wait/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'checks.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockSignalWorkflowWait).toHaveBeenCalledWith(
      'run-loop-wait',
      expect.objectContaining({
        owner: 'loop_group',
        nodeId: 'release',
        bodyWaitId: 'checks',
        iteration: 2,
        event: 'checks.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
      }),
      undefined
    );
  });

  test('rejects a signal that does not match the run wait', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_RUNNING_RUN,
      id: 'run-wait-2',
      status: 'paused',
      metadata: {
        wait: {
          owner: 'node',
          nodeId: 'checks',
          kind: 'event',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-25T10:00:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-2/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'deploy.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
      }),
    });

    expect(response.status).toBe(400);
    expect(mockSignalWorkflowWait).not.toHaveBeenCalled();
  });

  test('rejects a delayed signal for an earlier occurrence of the same event', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_RUNNING_RUN,
      id: 'run-wait-2',
      status: 'paused',
      metadata: {
        wait: {
          owner: 'loop_group',
          nodeId: 'release',
          bodyWaitId: 'checks',
          iteration: 2,
          sessionId: null,
          sessionProvider: null,
          kind: 'event',
          event: 'checks.complete',
          waitingSince: '2026-08-24T10:01:00.000Z',
          resumeAt: '2026-08-25T10:01:00.000Z',
        },
      },
    });
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-2/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'checks.complete',
        resumeAt: '2026-08-25T10:00:00.000Z',
        payload: { conclusion: 'stale' },
      }),
    });

    expect(response.status).toBe(400);
    expect(mockSignalWorkflowWait).not.toHaveBeenCalled();
  });

  test('rejects a missing JSON body before reading the run', async () => {
    const { app } = makeApp();

    const response = await app.request('/api/workflows/runs/run-wait-2/signal', {
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(mockGetWorkflowRun).not.toHaveBeenCalled();
    expect(mockSignalWorkflowWait).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/abandon
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/abandon', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockReset();
    // The shared abandonWorkflow op destructures { cancelled } from this call —
    // a bare mockReset() would make it return undefined and 500 the route.
    mockCancelWorkflowRun.mockImplementation(async (_id: string) => ({ cancelled: true }));
    mockFindChildRuns.mockReset();
    mockFindChildRuns.mockImplementation(async (_parentRunId: string): Promise<unknown[]> => []);
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is completed (non-resumable terminal)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_COMPLETED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot abandon');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('returns 400 when run is cancelled (non-resumable terminal)', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_RUNNING_RUN,
      status: 'cancelled' as const,
      completed_at: NOW_DATE,
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot abandon');
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('returns 200 and calls cancelWorkflowRun for running run', async () => {
    // Two lookups now: the route's pre-check + the shared abandonWorkflow op's own.
    mockGetWorkflowRun.mockResolvedValue(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Abandoned');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-uuid-1');
  });

  // #1887: a failed run is terminal but resumable, so it must remain
  // abandonable — the HTTP route previously rejected it, contradicting CLI/chat.
  test('returns 200 and calls cancelWorkflowRun for failed run', async () => {
    // Two lookups now: the route's pre-check + the shared abandonWorkflow op's own.
    mockGetWorkflowRun.mockResolvedValue(MOCK_FAILED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Abandoned');
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-uuid-4');
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/workflows/runs/:runId
// ---------------------------------------------------------------------------

describe('DELETE /api/workflows/runs/:runId', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockDeleteWorkflowRun.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not terminal', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1', {
      method: 'DELETE',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot delete');
  });

  test('returns 200 and deletes a completed run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_COMPLETED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('Deleted');
    expect(mockDeleteWorkflowRun).toHaveBeenCalledWith('run-uuid-2');
  });

  test('returns 200 and deletes a failed run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_FAILED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(mockDeleteWorkflowRun).toHaveBeenCalledWith('run-uuid-4');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/approve
// ---------------------------------------------------------------------------

const MOCK_PAUSED_RUN: MockWorkflowRun = {
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

describe('action-required pause gate routes', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
  });

  for (const [verb, body] of [
    ['approve', {}],
    ['reject', { reason: 'no' }],
    ['respond', { decision: 'approve' }],
  ] as const) {
    test(`${verb} directs the operator to resume or abandon instead`, async () => {
      mockGetWorkflowRun.mockResolvedValueOnce({
        ...MOCK_PAUSED_RUN,
        id: 'run-action-required',
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'rerun-ci',
            kind: 'attention',
            waitingSince: '2026-08-24T10:00:00.000Z',
            message: 'Re-run CI, then resume.',
          },
        },
      });
      const { app } = makeApp();
      const response = await app.request(`/api/workflows/runs/run-action-required/${verb}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(response.status).toBe(400);
      const result = (await response.json()) as { error?: string };
      expect(result.error).toContain('resume');
      expect(result.error).toContain('abandon');
      expect(mockResolveApprovalGate).not.toHaveBeenCalled();
      expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
    });
  }
});

describe('POST /api/workflows/runs/:runId/approve', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockReset();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
    mockCreateWorkflowEvent.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/missing/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not paused', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/approve', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });

  // #2121 Phase 2: a parent paused blocked on a `workflow:` child has no approvable
  // gate of its own — approving the PARENT must 400 with a redirect to the child id,
  // never stamp a spurious node_completed for the parent's sub-run node.
  test('returns 400 redirecting to the child when the parent is blocked on a sub-run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'parent-blocked-1',
      metadata: {
        approval: {
          type: 'child_workflow',
          nodeId: 'sub',
          message: 'Blocked on sub-run',
          childRunId: 'child-xyz',
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/parent-blocked-1/approve', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('child-xyz');
    // No gate mutation happened.
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  // One derivation (`runAttention`) now answers the precondition for all three
  // gate routes, so a corrupt block pointer and a gate type this build cannot
  // resolve reach the console as 400s with the reason, not an opaque 500.
  test('returns 400 explaining a block pointer with no child id, never naming <unknown>', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'parent-blocked-2',
      metadata: {
        approval: { type: 'child_workflow', nodeId: 'sub', message: 'Blocked on sub-run' },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/parent-blocked-2/approve', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('the child run id is missing');
    expect(body.error).not.toContain('<unknown>');
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('returns 400 for a gate type this build cannot resolve', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-future-gate',
      metadata: {
        approval: { type: 'from_the_future', nodeId: 'gate', message: 'Decide' },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-future-gate/approve', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("unrecognized gate type 'from_the_future'");
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('returns 400 when the gate is already resolved (double-approve guard)', async () => {
    // Post-#2075 an approved run stays 'paused' with approval.resolved set —
    // the status check alone no longer blocks a second approve.
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          resolved: 'approved',
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'again' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('already approved');
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });

  test('bare gate with captureResponse but no decisionsAuthored keeps plain-text output (R2 fix — #2707)', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-capture',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          captureResponse: true,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-capture/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'Looks great, proceed' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    // Audit events ride the CAS transaction now (#2146), not a separate write.
    const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
      Record<string, unknown>
    >;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      data: { node_output: 'Looks great, proceed', approval_decision: 'approved' },
    });
    expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
  });

  test('bare gate with no captureResponse set — empty output, unaffected by #2707', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_PAUSED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'a comment' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    // Audit events ride the CAS transaction now (#2146), not a separate write.
    const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
      Record<string, unknown>
    >;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      data: { node_output: '', approval_decision: 'approved' },
    });
    expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'approved' });
  });

  test('new-mode gate (decisionsAuthored) produces structured output (#2707)', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-new-mode',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-new-mode/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'a comment' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
      Record<string, unknown>
    >;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      data: {
        node_output: JSON.stringify({ decision: 'approve', text: 'a comment' }),
        approval_decision: 'approved',
        structured_output: { decision: 'approve', text: 'a comment' },
      },
    });
  });

  test('legacy on_reject-configured gate keeps plain text output, unaffected by #2707', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-legacy-capture',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          captureResponse: true,
          onRejectPrompt: 'Fix: $REJECTION_REASON',
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-legacy-capture/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'Looks great, proceed' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
      Record<string, unknown>
    >;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      data: { node_output: 'Looks great, proceed', approval_decision: 'approved' },
    });
    expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
  });

  test('passes an absent comment through as no-feedback on an interactive_loop gate (#2074)', async () => {
    // The route must NOT default the comment to 'Approved' — approveWorkflow derives
    // loop_feedback_given from the RAW comment, and a masked no-feedback would make
    // every web approve iterate instead of finalize.
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-loop-bare',
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          message: 'gate',
          iteration: 1,
          completionSignaled: true,
          signaledOutput: 'REPORT',
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-loop-bare/approve', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const casCall = mockResolveApprovalGate.mock.calls[0] as unknown[];
    expect(casCall[1]).toMatchObject({
      loop_feedback_given: false,
      loop_user_input: 'Approved',
    });
  });

  test('returns 400 (not a silent bare approve) when the body is sent but malformed (#2074)', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-bad-body',
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          message: 'gate',
          iteration: 1,
          completionSignaled: true,
          signaledOutput: 'REPORT',
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-bad-body/approve', {
      method: 'POST',
      body: '{"comment": "intended feedback', // truncated JSON — client bug
      headers: { 'Content-Type': 'application/json' },
    });
    // A malformed body must never be coerced into a bare approve — that would
    // FINALIZE a signal-bearing gate while silently discarding the feedback.
    expect(response.status).toBe(400);
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('passes a provided comment through as feedback on an interactive_loop gate (#2074)', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-loop-feedback',
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          message: 'gate',
          iteration: 1,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-loop-feedback/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'actually re-check X' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const casCall = mockResolveApprovalGate.mock.calls[0] as unknown[];
    expect(casCall[1]).toMatchObject({
      loop_feedback_given: true,
      loop_user_input: 'actually re-check X',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/reject
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/reject', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockReset();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
    mockCancelWorkflowRun.mockReset();
    mockCreateWorkflowEvent.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/missing/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'bad' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is not paused', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-1/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'bad' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });

  // #2121 Phase 2: rejecting a parent blocked on a `workflow:` child must 400 with a
  // redirect to the child id, not cancel the parent or stamp its sub-run node.
  test('returns 400 redirecting to the child when the parent is blocked on a sub-run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'parent-blocked-2',
      metadata: {
        approval: {
          type: 'child_workflow',
          nodeId: 'sub',
          message: 'Blocked on sub-run',
          childRunId: 'child-abc',
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/parent-blocked-2/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'no' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('child-abc');
    expect(mockResolveAndCancelApprovalGate).not.toHaveBeenCalled();
  });

  test('cancels immediately when no on_reject configured', async () => {
    mockGetWorkflowRun.mockResolvedValue(MOCK_PAUSED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'needs work' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    // Terminal reject resolves + cancels atomically (#2113); the audit event rides
    // the same transaction (#2146).
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-paused-1',
      [
        {
          event_type: 'approval_received',
          step_name: 'review-gate',
          data: { decision: 'rejected', reason: 'needs work' },
        },
      ],
      { step_name: 'review-gate', reason: 'approval_rejected' }
    );
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    expect(mockCaptureApprovalResolved).toHaveBeenCalledWith({ resolution: 'rejected' });
  });

  test('records rejection and increments count when on_reject configured and under limit', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-on-reject',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-on-reject/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'needs more tests' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    // This fixture has no parent_conversation_id, so the on-reject prompt now
    // resumes headlessly (#2008) instead of surfacing the old CLI-hint text.
    expect(body.message).toContain('Running on-reject prompt');
    expect(mockResolveApprovalGate).toHaveBeenCalledWith(
      'run-on-reject',
      {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
          resolved: 'rejected',
        },
        rejection_reason: 'needs more tests',
        rejection_count: 1,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'review-gate',
          data: { decision: 'rejected', reason: 'needs more tests' },
        },
      ]
    );
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('cancels when max attempts reached', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-max-attempts',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 2,
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-max-attempts/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'still bad' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('max attempts reached');
    // Terminal reject resolves + cancels atomically (#2113); the audit event rides
    // the same transaction (#2146).
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-max-attempts',
      [
        {
          event_type: 'approval_received',
          step_name: 'review-gate',
          data: { decision: 'rejected', reason: 'still bad' },
        },
      ],
      { step_name: 'review-gate', reason: 'approval_rejected' }
    );
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });
});

// #2707 step 2 — the general drive verb. 'approve'/'reject' produce the exact same
// resolution as the dedicated routes above; any other decision resolves through the
// new declared-decision path.
describe('POST /api/workflows/runs/:runId/respond', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockReset();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
    mockCreateWorkflowEvent.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/missing/respond', {
      method: 'POST',
      body: JSON.stringify({ decision: 'revise' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when the body has no decision', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_PAUSED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/respond', {
      method: 'POST',
      body: JSON.stringify({ text: 'no decision here' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('returns 400 naming the actual options when the decision is not declared', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
      ...MOCK_PAUSED_RUN,
      id: 'run-respond-invalid',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-respond-invalid/respond', {
      method: 'POST',
      body: JSON.stringify({ decision: 'escalate' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("does not declare decision 'escalate'");
    expect(body.error).toContain('approve, revise');
    expect(mockResolveApprovalGate).not.toHaveBeenCalled();
  });

  test('resolves a declared non-default decision with the caller-supplied id', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-respond-revise',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-respond-revise/respond', {
      method: 'POST',
      body: JSON.stringify({ decision: 'revise', text: 'needs more detail' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
      Record<string, unknown>
    >;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      data: {
        structured_output: { decision: 'revise', text: 'needs more detail' },
      },
    });
  });

  test("'approve' produces the exact same resolution as POST .../approve", async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-respond-approve',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Review the plan',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-respond-approve/respond', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve', text: 'lgtm' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const casEvents = (mockResolveApprovalGate.mock.calls[0] as unknown[])[2] as Array<
      Record<string, unknown>
    >;
    const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
    expect(nodeCompleted).toMatchObject({
      data: { structured_output: { decision: 'approve', text: 'lgtm' } },
    });
  });
});

// ---------------------------------------------------------------------------
// Auto-resume: approve/reject endpoints dispatch to orchestrator when the run
// has parent_conversation_id set (web-dispatched foreground/interactive
// workflows). Mirrors what the CLI does in workflowApproveCommand/RejectCommand.
// ---------------------------------------------------------------------------

describe('approve/reject auto-resume', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockReset();
    mockResolveApprovalGate.mockClear();
    mockResolveAndCancelApprovalGate.mockClear();
    mockCreateWorkflowEvent.mockReset();
    mockGetConversationById.mockReset();
    mockHandleMessage.mockReset();
    mockCancelWorkflowRun.mockReset();
    mockResolveRunContinuation.mockClear();
    mockHydrateResumableRun.mockClear();
    mockExecuteWorkflow.mockClear();
    mockGetCodebase.mockReset();
    mockCreateChildWorktreeResolver.mockClear();
  });

  test('approve: dispatches resume when parent_conversation_id is set', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-auto-resume-approve',
      parent_conversation_id: 'parent-conv-uuid',
      user_message: 'Deploy feature X',
    });
    mockGetConversationById.mockResolvedValueOnce({
      id: 'parent-conv-uuid',
      platform_conversation_id: 'web-plat-abc',
      platform_type: 'web',
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-auto-resume-approve/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Resuming workflow');

    // dispatchToOrchestrator → lockManager → handleMessage
    expect(mockHandleMessage).toHaveBeenCalled();
    const [, platformConvId, dispatchedMessage] = mockHandleMessage.mock.calls[0] ?? [];
    expect(platformConvId).toBe('web-plat-abc');
    expect(dispatchedMessage).toBe('/workflow resume run-auto-resume-approve');
  });

  test('approve: resumes headlessly when parent_conversation_id is null (CLI-dispatched run, #2008)', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: null,
    });
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-uuid-1',
      name: 'owner/repo',
      kind: 'repo',
      default_cwd: '/home/u/owner/repo',
      default_branch: 'main',
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Resuming workflow');
    // No chat message to dispatch through — resumed directly instead.
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockGetConversationById).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    // #2008 R1: a git-repo codebase in scope gets a child-isolation resolver
    // wired into the resumed execution, same as CLI/chat resume, so a
    // downstream `workflow:` node with isolation:worktree doesn't fail.
    expect(mockCreateChildWorktreeResolver).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-uuid-1', codebaseName: 'owner/repo' })
    );
    const opts = mockExecuteWorkflow.mock.calls[0]?.[7];
    expect(opts?.resolveChildIsolation).toBeDefined();
    expect(opts?.baseBranch).toBe('main');
  });

  test('approve: skips the child-isolation resolver for a folder-project codebase', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: null,
    });
    mockGetCodebase.mockResolvedValueOnce({
      id: 'cb-folder-1',
      name: 'ops-folder',
      kind: 'folder',
      default_cwd: '/home/u/ops-folder',
      default_branch: null,
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(mockCreateChildWorktreeResolver).not.toHaveBeenCalled();
  });

  test('approve: falls back to the CLI-hint response when headless resume cannot resolve the workflow', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: null,
    });
    mockResolveRunContinuation.mockResolvedValueOnce({ ok: false, message: 'workflow deleted' });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('archon workflow resume run-paused-1');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('approve: falls back to the CLI-hint response (not a 500) when headless resume hits an unexpected error (#2008 R2)', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: null,
    });
    mockHydrateResumableRun.mockImplementationOnce(async () => {
      throw new Error('transient DB error');
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });

    // The gate decision was already recorded — an unexpected error resuming
    // it must degrade safely, not surface as a 500.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('archon workflow resume run-paused-1');
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  test('reject: resumes headlessly when parent_conversation_id is null (CLI-dispatched run, #2008)', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-reject-headless',
      parent_conversation_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-reject-headless/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'tests missing' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Running on-reject prompt');
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockGetConversationById).not.toHaveBeenCalled();
    expect(mockHydrateResumableRun).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
  });

  test('approve: skips dispatch when parent conversation no longer exists', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: 'deleted-conv-uuid',
    });
    mockGetConversationById.mockResolvedValueOnce(null); // conversation deleted

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('archon workflow resume run-paused-1');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('approve: skips dispatch when parent conversation is on a non-web platform', async () => {
    // A Slack/Telegram/GitHub-sourced run being approved via the dashboard
    // must not route through dispatchToOrchestrator — that helper is wired
    // to the web adapter + lock manager, so dispatching a Slack thread_ts
    // or Telegram chat_id would misroute through the wrong adapter.
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: 'slack-parent-conv-uuid',
    });
    mockGetConversationById.mockResolvedValueOnce({
      id: 'slack-parent-conv-uuid',
      platform_conversation_id: '1234567890.123456', // a Slack thread_ts
      platform_type: 'slack',
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'LGTM' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    // Surfaces the exact CLI command so the web-UI user has a concrete next step.
    expect(body.message).toContain('archon workflow resume run-paused-1');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('reject: dispatches resume for on_reject flows when parent is set', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-auto-resume-reject',
      parent_conversation_id: 'parent-conv-uuid',
      user_message: 'Review PR',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    });
    mockGetConversationById.mockResolvedValueOnce({
      id: 'parent-conv-uuid',
      platform_conversation_id: 'web-plat-xyz',
      platform_type: 'web',
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-auto-resume-reject/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'tests missing' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('Running on-reject prompt');
    expect(mockHandleMessage).toHaveBeenCalled();
    const [, platformConvId, dispatchedMessage] = mockHandleMessage.mock.calls[0] ?? [];
    expect(platformConvId).toBe('web-plat-xyz');
    expect(dispatchedMessage).toBe('/workflow resume run-auto-resume-reject');
  });

  test('reject: surfaces CLI resume hint when on_reject configured but parent is non-web', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      id: 'run-reject-non-web',
      parent_conversation_id: 'slack-parent-conv-uuid',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review-gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    });
    mockGetConversationById.mockResolvedValueOnce({
      id: 'slack-parent-conv-uuid',
      platform_conversation_id: '1234567890.123456',
      platform_type: 'slack',
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-reject-non-web/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'tests missing' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain('archon workflow resume run-reject-non-web');
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('reject: does NOT dispatch when the run is being cancelled (no on_reject configured)', async () => {
    mockGetWorkflowRun.mockResolvedValue({
      ...MOCK_PAUSED_RUN,
      parent_conversation_id: 'parent-conv-uuid', // set, but doesn't matter — reject cancels
    });

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'no' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    // Cancellation path doesn't auto-resume — nothing to resume to.
    expect(mockHandleMessage).not.toHaveBeenCalled();
    // Terminal reject resolves + cancels atomically (#2113); the audit event rides
    // the same transaction (#2146).
    expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-paused-1',
      [
        {
          event_type: 'approval_received',
          step_name: 'review-gate',
          data: { decision: 'rejected', reason: 'no' },
        },
      ],
      { step_name: 'review-gate', reason: 'approval_rejected' }
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/runs/:runId/artifacts — the new artifact-listing endpoint
// ---------------------------------------------------------------------------

describe('GET /api/runs/:runId/artifacts', () => {
  // These cases write real files under the resolved artifact dir, so point the
  // fake ARCHON_HOME at an OS temp dir — a hard-coded '/tmp/...' is not an
  // absolute path on Windows. Torn down per case, so no cross-test leakage.
  const originalMockHome = mockArchonHome;
  beforeEach(async () => {
    mockArchonHome = await mkdtemp(join(tmpdir(), 'archon-artifacts-home-'));
    mockGetWorkflowRun.mockReset();
    mockGetCodebase.mockReset();
  });

  afterEach(async () => {
    const used = mockArchonHome;
    mockArchonHome = originalMockHome;
    await rm(used, { recursive: true, force: true });
  });

  test('returns 400 for invalid run ids (regex guard)', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/runs/has..slash/artifacts');
    expect(response.status).toBe(400);
  });

  test('returns 404 when the run does not exist', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => null);
    const { app } = makeApp();
    const response = await app.request('/api/runs/run-missing/artifacts');
    expect(response.status).toBe(404);
  });

  // #2200: an unresolvable output location is an explicit 404. An empty 200 was
  // indistinguishable from "the run produced nothing".
  test('returns 404 when run has no codebase_id and no output_root', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-orphan',
      codebase_id: null,
    }));
    const { app } = makeApp();
    const response = await app.request('/api/runs/run-orphan/artifacts');
    expect(response.status).toBe(404);
    expect(mockGetCodebase).not.toHaveBeenCalled();
  });

  test('resolves a bare-basename (_local) codebase instead of failing the parse', async () => {
    const runId = 'run-local-listing';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), '# plan');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-1',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/runs/${runId}/artifacts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { path: string }[] };
    // Before #2200 this returned an empty list — parseOwnerRepo(name) was null.
    expect(body.files.map(f => f.path)).toEqual(['plan.md']);
  });

  test('resolves a folder project to _folder/<slug> storage', async () => {
    const runId = 'run-folder-listing';
    const dir = join(wsRoot(), '_folder', 'my-ops-folder', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.md'), '# report');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-folder',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'My Ops Folder',
      kind: 'folder',
      default_cwd: '/srv/ops',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/runs/${runId}/artifacts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { path: string }[] };
    expect(body.files.map(f => f.path)).toEqual(['report.md']);
  });

  test('a persisted output_root wins over a codebase renamed since the run', async () => {
    const runId = 'run-persisted-root';
    const root = join(wsRoot(), 'acme', 'original');
    const dir = join(root, 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'out.md'), 'x');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-renamed',
      output_root: root,
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'acme/renamed-since',
      kind: 'repo',
      default_cwd: '/repos/renamed',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/runs/${runId}/artifacts`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { path: string }[] };
    expect(body.files.map(f => f.path)).toEqual(['out.md']);
  });

  test('an out-of-tree output_root falls through to re-derivation, keeping the tree relocatable', async () => {
    // Durability, not just correctness: move ARCHON_HOME (machine migration,
    // restored backup, the ARCHON_DATA split) and EVERY stamped root is
    // out-of-tree. Hard-failing here would permanently un-browse every
    // historical run whose artifacts are sitting right there under the new
    // home — and output_root is write-once via COALESCE, so the app could never
    // clear the column to recover.
    const runId = 'run-stale-root';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), '# still here');

    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-1',
      // A root from the OLD home — the shape every run has after a relocation.
      output_root: '/previous/archon/home/workspaces/_local/workspace',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));

    const { app } = makeApp();
    const response = await app.request(`/api/runs/${runId}/artifacts`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { files: { path: string }[] };
    expect(body.files.map(f => f.path)).toEqual(['plan.md']);
  });

  test('the containment guard still rejects a DERIVED path that escapes the tree', async () => {
    // The guard's live purpose after the fix: nothing re-derivable, and a
    // persisted root that cannot be trusted, must not serve a path outside
    // ARCHON_HOME.
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-escape-root',
      codebase_id: null,
      output_root: '/etc',
    }));
    const { app } = makeApp();
    const response = await app.request('/api/runs/run-escape-root/artifacts');
    // No codebase to re-derive from, and the persisted root is untrusted, so the
    // location is genuinely unresolvable.
    expect(response.status).toBe(404);
  });

  test('returns 500 + logs when the codebase lookup throws', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-db-err',
      codebase_id: 'cb-broken',
    }));
    mockGetCodebase.mockImplementationOnce(async () => {
      throw new Error('DB connection lost');
    });
    const { app } = makeApp();
    const response = await app.request('/api/runs/run-db-err/artifacts');
    expect(response.status).toBe(500);
  });

  // Traversal-shaped codebase names never produce a traversal path: they fail
  // parseOwnerRepo and fall through to `_local/<basename(default_cwd)>`, which
  // is a single sanitised segment. The result is a real (empty) project dir,
  // NOT an escape — and the ARCHON_HOME containment check is the second layer.
  test('a traversal-shaped codebase name resolves inside ARCHON_HOME, never outside it', async () => {
    for (const name of ['../../etc/passwd', 'a/b/c', '../repo', 'owner/..', 'ow ner/repo']) {
      mockGetWorkflowRun.mockImplementationOnce(async () => ({
        ...MOCK_RUNNING_RUN,
        id: 'run-bad-name',
        codebase_id: 'cb-bad',
      }));
      mockGetCodebase.mockImplementationOnce(async () => ({
        name,
        kind: 'repo',
        default_cwd: '/home/u/checkout',
      }));
      const { app } = makeApp();
      const response = await app.request('/api/runs/run-bad-name/artifacts');
      // Resolved to _local/checkout (which does not exist) → empty list, not an escape.
      expect(response.status).toBe(200);
      const body = (await response.json()) as { files: unknown[] };
      expect(body.files).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/artifacts/:runId/* — the artifact file-serving endpoint
// (owner/repo derivation only; content serving hits the real filesystem)
// ---------------------------------------------------------------------------

describe('GET /api/artifacts/:runId/* storage-key resolution', () => {
  // These cases write real files under the resolved artifact dir, so point the
  // fake ARCHON_HOME at an OS temp dir — a hard-coded '/tmp/...' is not an
  // absolute path on Windows. Torn down per case, so no cross-test leakage.
  const originalMockHome = mockArchonHome;
  beforeEach(async () => {
    mockArchonHome = await mkdtemp(join(tmpdir(), 'archon-artifacts-home-'));
    mockGetWorkflowRun.mockReset();
    mockGetCodebase.mockReset();
  });

  afterEach(async () => {
    const used = mockArchonHome;
    mockArchonHome = originalMockHome;
    await rm(used, { recursive: true, force: true });
  });

  test('returns 404 when there is no codebase and no output_root to resolve from', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-serve-orphan',
      codebase_id: null,
    }));
    const { app } = makeApp();
    const response = await app.request('/api/artifacts/run-serve-orphan/plan.md');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('could not resolve');
  });

  test('serves a folder project’s artifact (404 before #2200)', async () => {
    const runId = 'run-serve-folder';
    const dir = join(wsRoot(), '_folder', 'my-ops-folder', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), '# folder plan');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-folder',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'My Ops Folder',
      kind: 'folder',
      default_cwd: '/srv/ops',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/artifacts/${runId}/plan.md`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# folder plan');
  });

  test('serves a no-remote local repo’s artifact (404 before #2200)', async () => {
    const runId = 'run-serve-local';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), '# local plan');
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/artifacts/${runId}/plan.md`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# local plan');
  });

  test('an out-of-tree output_root falls through to re-derivation and still serves', async () => {
    // Same relocation case as the list route: a stamped root from a previous
    // ARCHON_HOME must not permanently un-serve a run whose file is present.
    const runId = 'run-serve-stale-root';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), '# still here');

    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-1',
      output_root: '/previous/archon/home/workspaces/_local/workspace',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));

    const { app } = makeApp();
    const response = await app.request(`/api/artifacts/${runId}/plan.md`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# still here');
  });

  test('an untrusted output_root with nothing to re-derive from is unresolvable', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-serve-escape-root',
      codebase_id: null,
      output_root: '/etc',
    }));
    const { app } = makeApp();
    const response = await app.request('/api/artifacts/run-serve-escape-root/passwd');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('could not resolve');
  });

  test('a valid owner/repo name resolves and proceeds to the file read', async () => {
    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: 'run-serve-ok',
      codebase_id: 'cb-ok',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'acme/widgets',
      kind: 'repo',
      default_cwd: '/repos/widgets',
    }));
    const { app } = makeApp();
    const response = await app.request('/api/artifacts/run-serve-ok/plan.md');
    // Artifact dir does not exist on disk → ENOENT, distinct from the
    // unresolvable-location rejection above.
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Artifact file not found');
  });

  test('an artifact pointer from a run result addresses this route with no extra machinery', async () => {
    // #2453 — a workflow result may carry { type, run_id, path }, validated by the
    // producing node (packages/workflows/src/artifact-pointer.ts) against its own run's
    // artifacts root. Those two fields ARE this route's parameters: the pointer needs no
    // resolution surface of its own. The read side owns reachability and real-path checks
    // by design; this route does lexical containment on the untrusted request path today,
    // and real-path resolution at read time is not yet implemented (#3160).
    const runId = 'run-serve-pointer';
    const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
    await mkdir(join(dir, 'review'), { recursive: true });
    await writeFile(join(dir, 'review', 'report.md'), '# the full report');

    const pointer = { type: 'archon_artifact', run_id: runId, path: 'review/report.md' };

    mockGetWorkflowRun.mockImplementationOnce(async () => ({
      ...MOCK_RUNNING_RUN,
      id: runId,
      codebase_id: 'cb-local',
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      name: 'workspace',
      kind: 'repo',
      default_cwd: '/home/u/workspace',
    }));
    const { app } = makeApp();
    const response = await app.request(`/api/artifacts/${pointer.run_id}/${pointer.path}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('# the full report');
  });

  // Symlinks can chain through readFile; the lexical containment check only
  // rejects .. segments. Git-Bash on Windows can't create real symlinks and
  // MSYS mangles absolute targets, so the symlink cases skip on win32 — the
  // lexical containment tests above still run there.
  const isWin = process.platform === 'win32';

  test.skipIf(isWin)(
    'an escape symlink is refused with 404 and never leaks its target (#3160)',
    async () => {
      // Plant a sentinel file under mockArchonHome but OUTSIDE this run's
      // artifact dir, then a relative symlink inside the artifact dir that
      // points back at it. The lexical check passes (no `..` segments in the
      // request), so before the real-path check the route reads through the
      // symlink and serves the sentinel. After the real-path check it must
      // 404 with the same body as a missing file, and the response body must
      // not contain the sentinel — refusing the request must not confirm what
      // exists outside the artifacts directory.
      const runId = 'run-serve-symlink-escape';
      const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
      await mkdir(dir, { recursive: true });
      const sentinel = 'TOP_SECRET_SENTINEL_VALUE_DO_NOT_LEAK';
      await writeFile(join(mockArchonHome, 'secret.txt'), sentinel);
      // Six `..` to climb runs/<runId> -> runs -> artifacts -> workspace -> _local
      // -> workspaces -> mockArchonHome.
      await symlink(`../../../../../../secret.txt`, join(dir, 'escape.txt'));

      mockGetWorkflowRun.mockImplementationOnce(async () => ({
        ...MOCK_RUNNING_RUN,
        id: runId,
        codebase_id: 'cb-local',
      }));
      mockGetCodebase.mockImplementationOnce(async () => ({
        name: 'workspace',
        kind: 'repo',
        default_cwd: '/home/u/workspace',
      }));

      const { app } = makeApp();
      const response = await app.request(`/api/artifacts/${runId}/escape.txt`);

      expect(response.status).toBe(404);
      const bodyText = await response.text();
      expect(bodyText).not.toContain(sentinel);
      const body = JSON.parse(bodyText) as { error: string };
      expect(body.error).toBe('Artifact file not found');
    }
  );

  test.skipIf(isWin)(
    'a sibling symlink inside the artifacts directory is still served (#3160)',
    async () => {
      // Real-path resolution must not break the supported case: a symlink to a
      // sibling file inside the same artifacts directory resolves to a path
      // that still lies under the real artifact directory, so the route
      // serves the target's content normally.
      const runId = 'run-serve-symlink-sibling';
      const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'target.md'), '# sibling target');
      await symlink('target.md', join(dir, 'link.md'));

      mockGetWorkflowRun.mockImplementationOnce(async () => ({
        ...MOCK_RUNNING_RUN,
        id: runId,
        codebase_id: 'cb-local',
      }));
      mockGetCodebase.mockImplementationOnce(async () => ({
        name: 'workspace',
        kind: 'repo',
        default_cwd: '/home/u/workspace',
      }));

      const { app } = makeApp();
      const response = await app.request(`/api/artifacts/${runId}/link.md`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('# sibling target');
    }
  );

  test.skipIf(isWin)(
    'an absolute symlink target outside ARCHON_HOME is also refused (#3160)',
    async () => {
      // Guards against an accidental realpath that lands outside the trust
      // boundary in the opposite direction from the lexical check. /etc/hosts
      // exists on every Linux and macOS host and contains no private data.
      const runId = 'run-serve-symlink-absolute';
      const dir = join(wsRoot(), '_local', 'workspace', 'artifacts', 'runs', runId);
      await mkdir(dir, { recursive: true });
      await symlink('/etc/hosts', join(dir, 'hosts'));

      mockGetWorkflowRun.mockImplementationOnce(async () => ({
        ...MOCK_RUNNING_RUN,
        id: runId,
        codebase_id: 'cb-local',
      }));
      mockGetCodebase.mockImplementationOnce(async () => ({
        name: 'workspace',
        kind: 'repo',
        default_cwd: '/home/u/workspace',
      }));

      const { app } = makeApp();
      const response = await app.request(`/api/artifacts/${runId}/hosts`);

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('Artifact file not found');
    }
  );
});

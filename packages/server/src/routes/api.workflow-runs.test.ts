import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@harneeslab/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

const mockGetWorkflowRun = mock(async (_id: string) => null as null | MockWorkflowRun);
const mockCancelWorkflowRun = mock(async (_id: string) => {});
const mockListWorkflowRuns = mock(async () => [] as MockWorkflowRun[]);
const mockListDashboardRuns = mock(async () => ({
  runs: [] as MockWorkflowRun[],
  total: 0,
  counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
}));
const mockGetWorkflowRunByWorkerPlatformId = mock(
  async (_id: string) => null as null | MockWorkflowRun
);
const mockListWorkflowEvents = mock(async (_runId: string) => [] as MockWorkflowEvent[]);
const mockGetConversationById = mock(
  async (_id: string) => null as null | { id: string; platform_conversation_id: string }
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
const mockHandleMessage = mock(async () => {});
const mockAddMessage = mock(async () => ({
  id: 'msg-1',
  conversation_id: 'conv-1',
  role: 'user' as const,
  content: 'hi',
  metadata: '{}',
  created_at: new Date().toISOString(),
}));
const mockGenerateAndSetTitle = mock(async () => {});

// Type aliases for clarity in tests
type MockWorkflowRun = {
  id: string;
  workflow_name: string;
  conversation_id: string | null;
  parent_conversation_id: string | null;
  codebase_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  user_message: string;
  started_at: string;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  working_path: string | null;
  last_activity_at: string | null;
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

mock.module('@harneeslab/core', () => ({
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

mock.module('@harneeslab/paths', () => ({
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
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
}));

mockAllWorkflowModules();

mock.module('@harneeslab/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@harneeslab/core/db/conversations', () => ({
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

mock.module('@harneeslab/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@harneeslab/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

const mockDeleteWorkflowRun = mock(async (_id: string) => {});
const mockUpdateWorkflowRun = mock(async (_id: string, _update: unknown) => {});

mock.module('@harneeslab/core/db/workflows', () => ({
  listWorkflowRuns: mockListWorkflowRuns,
  listDashboardRuns: mockListDashboardRuns,
  getWorkflowRun: mockGetWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  deleteWorkflowRun: mockDeleteWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
  getWorkflowRunByWorkerPlatformId: mockGetWorkflowRunByWorkerPlatformId,
}));

const mockCreateWorkflowEvent = mock(async (_event: unknown) => {});

mock.module('@harneeslab/core/db/workflow-events', () => ({
  listWorkflowEvents: mockListWorkflowEvents,
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

mock.module('@harneeslab/core/db/messages', () => ({
  addMessage: mockAddMessage,
  listMessages: mock(async () => []),
}));

mock.module('@harneeslab/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

const MOCK_RUNNING_RUN: MockWorkflowRun = {
  id: 'run-uuid-1',
  workflow_name: 'deploy',
  conversation_id: 'conv-uuid-1',
  parent_conversation_id: null,
  codebase_id: 'cb-uuid-1',
  status: 'running',
  user_message: 'Deploy to staging',
  started_at: NOW,
  completed_at: null,
  metadata: {},
  working_path: '/tmp/worktrees/feature',
  last_activity_at: NOW,
};

const MOCK_COMPLETED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-2',
  status: 'completed',
  completed_at: NOW,
};

const MOCK_FAILED_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-4',
  status: 'failed',
  completed_at: NOW,
};

const MOCK_PENDING_RUN: MockWorkflowRun = {
  ...MOCK_RUNNING_RUN,
  id: 'run-uuid-3',
  status: 'pending',
};

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

    expect(mockAddMessage).toHaveBeenCalledWith(MOCK_CONV.id, 'user', 'Deploy');
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

  test('returns 400 when isValidCommandName rejects the name', async () => {
    const { isValidCommandName } = await import('@harneeslab/workflows/command-validation');
    (isValidCommandName as ReturnType<typeof mock>).mockReturnValueOnce(false);

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
    mockCancelWorkflowRun.mockImplementationOnce(async () => {});

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
    mockCancelWorkflowRun.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-3/cancel', {
      method: 'POST',
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
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

    const body = (await response.json()) as { runs: Array<{ id: string }> };
    expect(body.runs.length).toBe(2);
    expect(body.runs[0]?.id).toBe('run-uuid-1');
  });

  test('filters by status query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => [MOCK_RUNNING_RUN]);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?status=running');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [
      [{ status?: string; limit?: number }],
    ][];
    expect(callArgs?.status).toBe('running');
  });

  test('ignores invalid status values', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?status=invalid_status');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [
      [{ status?: string; limit?: number }],
    ][];
    expect(callArgs?.status).toBeUndefined();
  });

  test('filters by conversationId query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?conversationId=conv-123');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [[{ conversationId?: string }]][];
    expect(callArgs?.conversationId).toBe('conv-123');
  });

  test('filters by codebaseId query param', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?codebaseId=cb-uuid-1');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [[{ codebaseId?: string }]][];
    expect(callArgs?.codebaseId).toBe('cb-uuid-1');
  });

  test('caps limit at 200', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs?limit=9999');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [[{ limit?: number }]][];
    expect(callArgs?.limit).toBeLessThanOrEqual(200);
  });

  test('uses default limit of 50 when not specified', async () => {
    mockListWorkflowRuns.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/workflows/runs');

    const [[callArgs]] = mockListWorkflowRuns.mock.calls as [[{ limit?: number }]][];
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
    }));
    // Second call: parent conversation
    mockGetConversationById.mockImplementationOnce(async () => ({
      id: 'parent-conv-uuid',
      platform_conversation_id: 'parent-platform-id',
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
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [MOCK_RUNNING_RUN, MOCK_COMPLETED_RUN],
      total: 2,
      counts: { all: 5, running: 1, completed: 2, failed: 1, cancelled: 1, pending: 0 },
    }));

    const { app } = makeApp();
    const response = await app.request('/api/dashboard/runs');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      runs: unknown[];
      total: number;
      counts: { all: number };
    };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBe(2);
    expect(body.total).toBe(2);
    expect(body.counts.all).toBe(5);
  });

  test('filters by status query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=running');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ status?: string }]][];
    expect(callArgs?.status).toBe('running');
  });

  test('accepts paused as valid status', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=paused');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ status?: string }]][];
    expect(callArgs?.status).toBe('paused');
  });

  test('ignores invalid status values in dashboard runs', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?status=bogus');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ status?: string }]][];
    expect(callArgs?.status).toBeUndefined();
  });

  test('filters by codebaseId query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?codebaseId=cb-1');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ codebaseId?: string }]][];
    expect(callArgs?.codebaseId).toBe('cb-1');
  });

  test('filters by search query param', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?search=deploy');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ search?: string }]][];
    expect(callArgs?.search).toBe('deploy');
  });

  test('supports after and before date filters', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?after=2024-01-01T00:00:00Z&before=2024-12-31T23:59:59Z');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [
      [{ after?: string; before?: string }],
    ][];
    expect(callArgs?.after).toBe('2024-01-01T00:00:00Z');
    expect(callArgs?.before).toBe('2024-12-31T23:59:59Z');
  });

  test('caps limit at 200', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?limit=9999');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ limit?: number }]][];
    expect(callArgs?.limit).toBeLessThanOrEqual(200);
  });

  test('supports offset for pagination', async () => {
    mockListDashboardRuns.mockImplementationOnce(async () => ({
      runs: [],
      total: 0,
      counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
    }));

    const { app } = makeApp();
    await app.request('/api/dashboard/runs?offset=50');

    const [[callArgs]] = mockListDashboardRuns.mock.calls as [[{ offset?: number }]][];
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
    mockGetWorkflowRunByWorkerPlatformId.mockResolvedValueOnce(MOCK_RUNNING_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/by-worker/some-platform-id');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: unknown };
    expect(body.run).toBeDefined();
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

  test('returns 200 with message when run is failed', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_FAILED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-4/resume', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(body.message).toContain('ready to resume');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/workflows/runs/:runId/abandon
// ---------------------------------------------------------------------------

describe('POST /api/workflows/runs/:runId/abandon', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockCancelWorkflowRun.mockReset();
  });

  test('returns 404 when run not found', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(null);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-missing/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 when run is already terminal', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_COMPLETED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-uuid-2/abandon', {
      method: 'POST',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Cannot abandon');
  });

  test('returns 200 and calls cancelWorkflowRun for running run', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_RUNNING_RUN);
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

describe('POST /api/workflows/runs/:runId/approve', () => {
  beforeEach(() => {
    mockGetWorkflowRun.mockReset();
    mockUpdateWorkflowRun.mockReset();
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

  test('stores user comment as node_output when captureResponse is true', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
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
    const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedCall?.[0]).toMatchObject({
      data: { node_output: 'Looks great, proceed', approval_decision: 'approved' },
    });
  });

  test('stores empty node_output when captureResponse is not set', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_PAUSED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/approve', {
      method: 'POST',
      body: JSON.stringify({ comment: 'a comment' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).event_type === 'node_completed'
    );
    expect(nodeCompletedCall?.[0]).toMatchObject({
      data: { node_output: '', approval_decision: 'approved' },
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

  test('cancels immediately when no on_reject configured', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce(MOCK_PAUSED_RUN);
    const { app } = makeApp();
    const response = await app.request('/api/workflows/runs/run-paused-1/reject', {
      method: 'POST',
      body: JSON.stringify({ reason: 'needs work' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; message: string };
    expect(body.success).toBe(true);
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-paused-1');
  });

  test('records rejection and increments count when on_reject configured and under limit', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
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
    expect(body.message).toContain('On-reject prompt');
    expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-on-reject', {
      status: 'failed',
      metadata: { rejection_reason: 'needs more tests', rejection_count: 1 },
    });
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
  });

  test('cancels when max attempts reached', async () => {
    mockGetWorkflowRun.mockResolvedValueOnce({
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
    expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-max-attempts');
    expect(mockUpdateWorkflowRun).not.toHaveBeenCalled();
  });
});

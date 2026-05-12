import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports of mocked modules
// ---------------------------------------------------------------------------

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
const mockUpdateConversationTitle = mock(async (_id: string, _title: string) => {});
const mockAddMessage = mock(
  async (_conversationId: string, _role: 'user' | 'assistant', _content: string) => ({
    id: 'msg-uuid-1',
    conversation_id: _conversationId,
    role: _role,
    content: _content,
    metadata: '{}',
    created_at: new Date().toISOString(),
  })
);
const mockListMessages = mock(async (_conversationId: string, _limit?: number) => []);
const mockHandleMessage = mock(async () => {});

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
  generateAndSetTitle: mock(async () => {}),
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

mock.module('@archon/paths', () => ({
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
  updateConversationTitle: mockUpdateConversationTitle,
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
  listMessages: mockListMessages,
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

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

const MOCK_MESSAGES = [
  {
    id: 'msg-1',
    conversation_id: 'internal-uuid-123',
    role: 'user' as const,
    content: 'Hello there',
    metadata: '{}',
    created_at: new Date().toISOString(),
  },
  {
    id: 'msg-2',
    conversation_id: 'internal-uuid-123',
    role: 'assistant' as const,
    content: 'Hi! How can I help?',
    metadata: '{"toolCalls":[]}',
    created_at: new Date().toISOString(),
  },
];

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
// Tests: POST /api/conversations/:id/message
// ---------------------------------------------------------------------------

describe('POST /api/conversations/:id/message', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockHandleMessage.mockReset();
    mockAddMessage.mockReset();
  });

  test('accepts a valid message and dispatches to orchestrator', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Hello',
      metadata: '{}',
      created_at: new Date().toISOString(),
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { accepted: boolean; status: string };
    expect(body.accepted).toBe(true);
    expect(body.status).toBe('started');
  });

  test('persists user message to DB when conversation is found', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Test message',
      metadata: '{}',
      created_at: new Date().toISOString(),
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Test message' }),
    });

    expect(mockAddMessage).toHaveBeenCalledWith(MOCK_CONV.id, 'user', 'Test message', undefined);
  });

  test('still dispatches when conversation lookup fails (no message persistence)', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/conversations/unknown-conv/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    // Should still return accepted — message is sent even without persistence
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
    // addMessage should NOT be called when conversation is not found
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  test('returns 400 when message is empty string', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('message');
  });

  test('returns 400 when message field is missing', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    // Zod validation returns "message: Required" before the handler runs
    expect(body.error).toContain('message');
  });

  test('returns 400 for malformed JSON body', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json{',
    });
    expect(response.status).toBe(400);
  });

  test('returns 400 when message is a non-string type', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 42 }),
    });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/conversations/:id/messages
// ---------------------------------------------------------------------------

describe('GET /api/conversations/:id/messages', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockListMessages.mockReset();
  });

  test('returns message history for a conversation', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => MOCK_MESSAGES);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ id: string; role: string; content: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body[0]?.role).toBe('user');
    expect(body[1]?.role).toBe('assistant');
  });

  test('uses conversation DB id when querying messages', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/conversations/web-test-abc/messages');

    expect(mockListMessages).toHaveBeenCalledWith(MOCK_CONV.id, expect.any(Number));
  });

  test('normalizes JSONB metadata (object) to JSON string', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-1',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: 'Response',
        // Simulate PostgreSQL returning JSONB as an object
        metadata: { toolCalls: [{ name: 'bash' }] } as unknown as string,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ metadata: string }>;
    // Metadata should be serialized to JSON string for frontend consumption
    expect(typeof body[0]?.metadata).toBe('string');
    const parsed = JSON.parse(body[0]?.metadata ?? '{}') as { toolCalls: unknown[] };
    expect(Array.isArray(parsed.toolCalls)).toBe(true);
  });

  test('returns 404 when conversation not found', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/unknown-conv/messages');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('respects limit query parameter', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/conversations/web-test-abc/messages?limit=10');

    expect(mockListMessages).toHaveBeenCalledWith(MOCK_CONV.id, 10);
  });

  test('caps limit at 500', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => []);

    const { app } = makeApp();
    await app.request('/api/conversations/web-test-abc/messages?limit=9999');

    const [, passedLimit] = (mockListMessages.mock.calls[0] ?? []) as [unknown, number];
    expect(passedLimit).toBeLessThanOrEqual(500);
  });

  test('returns 500 when DB throws', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => {
      throw new Error('DB failure');
    });

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list messages');
  });
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/conversations/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/conversations/:id', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockUpdateConversationTitle.mockReset();
  });

  test('updates conversation title and returns success', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated Title' }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith(MOCK_CONV.id, 'Updated Title');
  });

  test('truncates title to 255 characters', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    const longTitle = 'x'.repeat(400);
    await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: longTitle }),
    });

    const lastCall = mockUpdateConversationTitle.mock.calls.at(-1) as [string, string];
    expect(lastCall[1].length).toBe(255);
  });

  test('returns success without updating title when body has no title field', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const { app } = makeApp();
    const callsBefore = mockUpdateConversationTitle.mock.calls.length;
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ someOtherField: 'value' }),
    });
    expect(response.status).toBe(200);
    expect(mockUpdateConversationTitle.mock.calls.length).toBe(callsBefore);
  });

  test('returns 404 when conversation not found', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/unknown-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(404);
  });

  test('returns 400 for malformed JSON body', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json {{{',
    });
    expect(response.status).toBe(400);
  });
});

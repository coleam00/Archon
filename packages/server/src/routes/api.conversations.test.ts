import { describe, test, expect, mock } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

const mockFindConversationByPlatformId = mock(
  async (_platformId: string) =>
    null as null | {
      id: string;
      platform_conversation_id: string;
      title: string | null;
      created_at: Date;
      updated_at: Date;
      platform_type: string;
      deleted_at: Date | null;
      codebase_id: string | null;
    }
);
const mockSoftDeleteConversation = mock(async (_id: string) => {});
const mockUpdateConversationTitle = mock(async (_id: string, _title: string) => {});

const mockGenerateAndSetTitle = mock(async () => {});
mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.archon/commands/defaults']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  cloneRepository: mock(async () => {}),
  registerRepository: mock(async () => ({ success: true })),
  removeWorktree: mock(async () => ({ success: true })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  generateAndSetTitle: mockGenerateAndSetTitle,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
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

mockAllWorkflowModules();

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  softDeleteConversation: mockSoftDeleteConversation,
  updateConversationTitle: mockUpdateConversationTitle,
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
  })),
}));

mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/workflow-events', () => ({}));
const mockAddMessage = mock(async (_convId: string, _role: string, _content: string) => ({
  id: 'msg-uuid-1',
}));
mock.module('@archon/core/db/messages', () => ({
  addMessage: mockAddMessage,
}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => [{ default_cwd: '/tmp/project' }]),
  getCodebase: mock(async () => null),
}));

import { registerApiRoutes } from './api';

const MOCK_CONV = {
  id: 'internal-uuid-123',
  platform_conversation_id: 'web-test-abc',
  title: null,
  created_at: new Date(),
  updated_at: new Date(),
  platform_type: 'web',
  deleted_at: null,
  codebase_id: null,
};

describe('GET /api/conversations/:id', () => {
  test('returns conversation JSON by platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { platform_conversation_id: string };
    expect(body.platform_conversation_id).toBe('web-test-abc');
  });

  test('returns 404 for unknown platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 500 when DB throws unexpectedly', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => {
      throw new Error('DB connection lost');
    });

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc');
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get conversation');
  });
});

describe('DELETE /api/conversations/:id', () => {
  test('returns { success: true } when deleting by platform conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockSoftDeleteConversation.mockImplementationOnce(async () => {});

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', { method: 'DELETE' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockSoftDeleteConversation).toHaveBeenCalledWith('internal-uuid-123');
  });

  test('returns 404 when platform conversation ID does not exist', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });
});

describe('PATCH /api/conversations/:id', () => {
  test('resolves platform ID and updates title using internal ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockUpdateConversationTitle).toHaveBeenCalledWith('internal-uuid-123', 'New Title');
  });

  test('returns 404 when platform conversation ID does not exist', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-nonexistent-id', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Title' }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{',
    });
    expect(response.status).toBe(400);
  });

  test('returns { success: true } without calling updateConversationTitle when body has no title', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const callsBefore = mockUpdateConversationTitle.mock.calls.length;
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toEqual({ success: true });
    expect(mockUpdateConversationTitle.mock.calls.length).toBe(callsBefore);
  });

  test('truncates title to 255 characters', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockUpdateConversationTitle.mockImplementationOnce(async () => {});

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const longTitle = 'a'.repeat(300);
    const response = await app.request('/api/conversations/web-test-abc', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: longTitle }),
    });
    expect(response.status).toBe(200);
    const lastCall = mockUpdateConversationTitle.mock.calls.at(-1) as [string, string];
    expect(lastCall[1].length).toBe(255);
  });
});

describe('POST /api/conversations', () => {
  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
  } as unknown as WebAdapter;

  test('creates conversation and returns auto-generated conversationId', async () => {
    const app = new OpenAPIHono();
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { conversationId: string; id: string };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
  });

  test('returns 400 if conversationId is provided in request body', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'my-custom-id' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('conversationId');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not valid json{',
    });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/conversations with message (atomic create+send)', () => {
  const mockLockManager = {
    acquireLock: mock(async (_convId: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' as const };
    }),
  } as unknown as ConversationLockManager;

  const mockWebAdapter = {
    setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    emitLockEvent: mock((_convId: string, _locked: boolean) => {}),
    emitSSE: mock(async (_convId: string, _data: string) => {}),
  } as unknown as WebAdapter;

  test('creates conversation and dispatches message atomically', async () => {
    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversationId: string;
      id: string;
      dispatched: boolean;
    };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
    expect(body.dispatched).toBe(true);
  });

  test('persists user message during atomic creation', async () => {
    const callsBefore = mockAddMessage.mock.calls.length;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test message' }),
    });
    expect(mockAddMessage.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('generates title for non-command messages', async () => {
    const callsBefore = mockGenerateAndSetTitle.mock.calls.length;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'help me debug this function' }),
    });
    expect(mockGenerateAndSetTitle.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('skips title generation for slash commands', async () => {
    const callsBefore = mockGenerateAndSetTitle.mock.calls.length;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, mockWebAdapter, mockLockManager);

    await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '/status' }),
    });
    expect(mockGenerateAndSetTitle.mock.calls.length).toBe(callsBefore);
  });

  test('still works without message (backward compatible)', async () => {
    const simpleWebAdapter = {
      setConversationDbId: mock((_platformId: string, _dbId: string) => {}),
    } as unknown as WebAdapter;

    const app = new OpenAPIHono({ defaultHook: validationErrorHook });
    registerApiRoutes(app, simpleWebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      conversationId: string;
      id: string;
      dispatched?: boolean;
    };
    expect(body.conversationId).toBe('web-test-abc');
    expect(body.id).toBe('internal-uuid-123');
    expect(body.dispatched).toBeUndefined();
  });
});

// Regression tests for non-web adapter conversations (Gitea, GitHub forge adapters)
// Platform conversation IDs from forge adapters contain slashes and # characters:
// e.g. "CyberFitz-LLC/devops-platform#24" — these must be URL-encoded by the client
// and correctly decoded by the server route params.
// Ref: https://github.com/coleam00/Archon/issues/476
describe('GET /api/conversations/:id — forge platform IDs with encoded slashes', () => {
  const GITEA_CONV = {
    id: 'gitea-internal-uuid',
    platform_conversation_id: 'CyberFitz-LLC/devops-platform#24',
    title: 'feat: add context enrichment',
    created_at: new Date(),
    updated_at: new Date(),
    platform_type: 'gitea',
    deleted_at: null,
    codebase_id: null,
  };

  test('finds gitea conversation when ID contains encoded slash and hash', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async platformId => {
      // Server should receive the decoded platform ID (slashes + # restored)
      expect(platformId).toBe('CyberFitz-LLC/devops-platform#24');
      return GITEA_CONV;
    });

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // Client must URL-encode the ID: %2F for slash, %23 for #
    const response = await app.request('/api/conversations/CyberFitz-LLC%2Fdevops-platform%2324');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      platform_conversation_id: string;
      platform_type: string;
    };
    expect(body.platform_conversation_id).toBe('CyberFitz-LLC/devops-platform#24');
    expect(body.platform_type).toBe('gitea');
  });

  test('finds gitea PR conversation with ! separator when ID is encoded', async () => {
    const giteaPRConv = {
      ...GITEA_CONV,
      platform_conversation_id: 'owner/repo!42',
      platform_type: 'gitea',
    };

    mockFindConversationByPlatformId.mockImplementationOnce(async platformId => {
      expect(platformId).toBe('owner/repo!42');
      return giteaPRConv;
    });

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/owner%2Frepo!42');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { platform_conversation_id: string };
    expect(body.platform_conversation_id).toBe('owner/repo!42');
  });

  test('returns 404 for unknown gitea conversation ID', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => null);

    const app = new OpenAPIHono();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/conversations/unknown-org%2Funknown-repo%2399');
    expect(response.status).toBe(404);
  });
});

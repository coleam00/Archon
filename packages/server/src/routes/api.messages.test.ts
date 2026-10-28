import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { makeIdleLockStats } from '../test/conversation-lock-fixtures';
import { makeListDashboardRunsMock, mockAllWorkflowModules } from '../test/workflow-mock-factories';
import { MAX_TOOL_OUTPUT_CHARS } from '../adapters/web/truncate';
import { sendMessageBodySchema } from './schemas/conversation.schemas';

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
const mockAddMessage = mock(
  async (_conversationId: string, _role: 'user' | 'assistant', _content: string) => ({
    id: 'msg-uuid-1',
    conversation_id: _conversationId,
    role: _role,
    content: _content,
    metadata: '{}',
    user_id: null,
    created_at: new Date().toISOString(),
  })
);
const mockListMessages = mock<typeof import('@archon/core/db/messages')['listMessages']>(
  async () => []
);
const mockHandleMessage = mock(async () => {});

mock.module('@archon/core', () => ({
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
  generateTitleForUser: mock(async () => {}),
  resolveTitleRequest: mock(async () => ({ provider: 'claude', options: {} })),
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
  canonicalizeProjectPath: async (path: string) => path,
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
  listDashboardRuns: makeListDashboardRunsMock(),
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
  findCommandFiles: mock(async () => []),
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
    user_id: null,
    created_at: new Date().toISOString(),
  },
  {
    id: 'msg-2',
    conversation_id: 'internal-uuid-123',
    role: 'assistant' as const,
    content: 'Hi! How can I help?',
    metadata: '{"toolCalls":[]}',
    user_id: null,
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
    getStats: mock(makeIdleLockStats),
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

  test('publishes JSON and multipart message request bodies', async () => {
    const { app } = makeApp();
    const response = await app.request('/api/openapi.json');
    expect(response.status).toBe(200);
    const doc = (await response.json()) as ReturnType<typeof app.getOpenAPIDocument>;
    type Schema = NonNullable<NonNullable<typeof doc.components>['schemas']>[string];
    function resolve(schema: Schema | undefined): Exclude<Schema, { $ref: string }> {
      if (!schema) throw new Error('Missing schema');
      if ('$ref' in schema)
        return resolve(doc.components?.schemas?.[schema.$ref.split('/').at(-1) ?? '']);
      return schema;
    }
    const body = doc.paths['/api/conversations/{id}/message']?.post?.requestBody;
    if (!body || '$ref' in body) throw new Error('Missing message request body');
    expect(body.required).toBe(true);
    expect(Object.keys(body.content)).toEqual(['application/json', 'multipart/form-data']);
    const json = resolve(body.content['application/json']?.schema);
    const form = resolve(body.content['multipart/form-data']?.schema);
    for (const schema of [json, form]) {
      expect(schema.required).toEqual(['message']);
      expect(resolve(schema.properties?.message)).toMatchObject({ type: 'string', minLength: 1 });
    }
    expect(json.properties?.files).toBeUndefined();
    const files = resolve(form.properties?.files);
    expect(files).toMatchObject({ type: 'array', maxItems: 5 });
    if (!files.items || Array.isArray(files.items)) throw new Error('Missing file item schema');
    expect(resolve(files.items)).toMatchObject({ type: 'string', format: 'binary' });
  });

  test.each(['json', 'multipart'] as const)(
    '%s message validation follows the published schema',
    async transport => {
      mockFindConversationByPlatformId.mockResolvedValue(null);
      const { app } = makeApp();
      for (const message of [undefined, '', 'a', ' ', 'Hello']) {
        mockHandleMessage.mockClear();
        const form = new FormData();
        if (message !== undefined) form.set('message', message);
        const valid = sendMessageBodySchema.safeParse({ message }).success;
        const response = await app.request('/api/conversations/web-test-abc/message', {
          method: 'POST',
          ...(transport === 'json'
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message }),
              }
            : { body: form }),
        });
        expect(response.status).toBe(valid ? 200 : 400);
        expect(await response.json()).toEqual(
          valid
            ? { accepted: true, status: 'started' }
            : { error: 'message must be a non-empty string' }
        );
        expect(mockHandleMessage).toHaveBeenCalledTimes(valid ? 1 : 0);
      }
    }
  );

  test.each(['too many', 'too large'] as const)('refuses %s attachments', async kind => {
    mockFindConversationByPlatformId.mockResolvedValue(null);
    const { app } = makeApp();
    const form = new FormData();
    form.set('message', 'Hello');
    for (let index = 0; index < (kind === 'too many' ? 6 : 1); index++) {
      form.append(
        'files',
        new File(
          [kind === 'too large' ? new Uint8Array(10 * 1024 * 1024 + 1) : 'hello'],
          'file.txt',
          {
            type: 'text/plain',
          }
        )
      );
    }
    const response = await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        kind === 'too many'
          ? 'Maximum 5 files per message'
          : 'File "file.txt" exceeds the 10 MB size limit',
    });
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  test('accepts a valid message and dispatches to orchestrator', async () => {
    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockAddMessage.mockImplementationOnce(async () => ({
      id: 'msg-1',
      conversation_id: MOCK_CONV.id,
      role: 'user' as const,
      content: 'Hello',
      metadata: '{}',
      user_id: null,
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
      user_id: null,
      created_at: new Date().toISOString(),
    }));
    mockHandleMessage.mockImplementationOnce(async () => {});

    const { app } = makeApp();
    await app.request('/api/conversations/web-test-abc/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Test message' }),
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      MOCK_CONV.id,
      'user',
      'Test message',
      undefined,
      undefined
    );
  });

  test('still dispatches when no conversation exists (no message persistence)', async () => {
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
    expect(body.error).toContain('message');
  });

  test.each(['null', 'true', '42', '"Hello"', '[]', '["Hello"]'])(
    'returns 400 for a non-object JSON body: %s',
    async body => {
      const { app } = makeApp();
      const response = await app.request('/api/conversations/web-test-abc/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'message must be a non-empty string' });
      expect(mockHandleMessage).not.toHaveBeenCalled();
      expect(mockAddMessage).not.toHaveBeenCalled();
    }
  );

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
        user_id: null,
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

  test('falls back to empty JSON object when metadata serialization fails', async () => {
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-1',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: 'Response',
        // Simulate unserializable metadata from PostgreSQL JSONB
        metadata: circular as unknown as string,
        user_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ metadata: string }>;
    expect(body[0]?.metadata).toBe('{}');
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
// Tests: GET /api/conversations/:id/messages — tool output bounding (#2236)
// ---------------------------------------------------------------------------

describe('GET /api/conversations/:id/messages — tool output bounding', () => {
  beforeEach(() => {
    mockFindConversationByPlatformId.mockReset();
    mockListMessages.mockReset();
  });

  test('truncates large tool output in hydration metadata without touching the DB value', async () => {
    const largeOutput = 'y'.repeat(MAX_TOOL_OUTPUT_CHARS + 10_000);
    const storedMetadata = JSON.stringify({
      toolCalls: [
        {
          name: 'bash',
          input: { command: 'cat file.txt' },
          output: largeOutput,
          duration: 500,
        },
      ],
    });

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-tool',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: '',
        metadata: storedMetadata,
        user_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ metadata: string }>;
    const returnedMeta = JSON.parse(body[0]!.metadata) as {
      toolCalls: Array<{ output: string }>;
    };

    // Returned tool output must be bounded, with the truncation marker appended
    expect(returnedMeta.toolCalls[0]!.output.length).toBeLessThan(largeOutput.length);
    expect(returnedMeta.toolCalls[0]!.output).toContain('[truncated');
    expect(returnedMeta.toolCalls[0]!.output).toContain('full output preserved on the server');
  });

  test('preserves tool output within the cap in hydration', async () => {
    const smallOutput = 'short output from tool';
    const metadata = JSON.stringify({
      toolCalls: [{ name: 'bash', input: {}, output: smallOutput, duration: 10 }],
    });

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-small',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: '',
        metadata,
        user_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    const body = (await response.json()) as Array<{ metadata: string }>;
    expect(body[0]!.metadata).toBe(metadata);
  });

  test('returns non-toolCall metadata (workflowResult etc.) unchanged', async () => {
    const metadata = JSON.stringify({ workflowResult: { runId: 'abc' } });

    mockFindConversationByPlatformId.mockImplementationOnce(async () => MOCK_CONV);
    mockListMessages.mockImplementationOnce(async () => [
      {
        id: 'msg-no-tools',
        conversation_id: MOCK_CONV.id,
        role: 'assistant' as const,
        content: 'Done.',
        metadata,
        user_id: null,
        created_at: new Date().toISOString(),
      },
    ]);

    const { app } = makeApp();
    const response = await app.request('/api/conversations/web-test-abc/messages');
    const body = (await response.json()) as Array<{ metadata: string }>;
    expect(body[0]!.metadata).toBe(metadata);
  });
});

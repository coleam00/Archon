import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Ownership on the SSE routes (#3135).
//
// The stream routes are plain `app.get` registrations with no OpenAPI schema and
// had no HTTP-level coverage at all, so this file is their first. What matters
// here beyond the status code is *when* the denial happens: before `streamSSE`
// takes over the response, so a refused caller gets a JSON 404 rather than an
// opened stream that emits nothing.
//
// Mock setup must precede the dynamic import of ./api below.
// ---------------------------------------------------------------------------

const noopLogger = () => ({
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
});

let ownershipEnforced = false;

mock.module('../auth', () => ({
  getAuth: () => null,
  isWebAuthEnabled: () => false,
  getSignupMode: () => 'disabled',
  isApiGateEnabled: () => false,
  isConversationOwnershipEnforced: () => ownershipEnforced,
}));

// `X-Archon-User: alice` resolves to `user-alice`, mirroring resolveAuthContext's
// header door without needing a real users table.
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(async (_platform: string, platformUserId: string) => ({
    id: `user-${platformUserId}`,
    display_name: null,
    email: null,
    role: 'admin' as const,
    created_at: new Date(),
    updated_at: new Date(),
  })),
}));

interface ConversationRow {
  id: string;
  platform_conversation_id: string;
  platform_type: string;
  user_id: string | null;
  title: string | null;
  ai_assistant_type: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  codebase_id: string | null;
}

let storedConversation: ConversationRow | null = null;

const mockFindConversationByPlatformId = mock(
  async (platformId: string): Promise<ConversationRow | null> =>
    storedConversation && storedConversation.platform_conversation_id === platformId
      ? storedConversation
      : null
);

const PRIVATE_PLATFORM_TYPES = ['web', 'cli'] as const;

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  listConversations: mock(async () => []),
  getConversationById: mock(async () => null),
  getOrCreateConversation: mock(async () => ({
    id: 'internal-new',
    platform_conversation_id: 'web-new',
  })),
  PRIVATE_PLATFORM_TYPES,
  isPrivatePlatformType: (platformType: string) =>
    (PRIVATE_PLATFORM_TYPES as readonly string[]).includes(platformType),
}));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'postgresql',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: mock(async () => {}),
  resolveTitleRequest: mock(async () => ({ provider: 'claude', options: {} })),
  isPerUserGitHubEnabled: () => false,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: noopLogger,
}));

mock.module('@archon/paths', () => ({
  createLogger: noopLogger,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  getArchonHome: () => '/tmp/.archon',
  getRunArtifactsPath: (owner: string, repo: string, runId: string): string =>
    `/tmp/.archon/workspaces/${owner}/${repo}/artifacts/runs/${runId}`,
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({ id: 'msg-1' })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mock(async () => []),
  getCodebase: mock(async () => null),
  deleteCodebase: mock(async () => {}),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mock(async () => []),
  updateStatus: mock(async () => {}),
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  getWorkflowRun: mock(async () => null),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

const mockRegisterStream = mock((_key: string, _stream: unknown) => {});
const mockRemoveStream = mock((_key: string, _stream?: unknown) => {});

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
    registerStream: mockRegisterStream,
    removeStream: mockRemoveStream,
  } as unknown as WebAdapter;
  const mockLockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

const CONVERSATION_ID = 'web-alice-1';

function conversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'internal-uuid-1',
    platform_conversation_id: CONVERSATION_ID,
    platform_type: 'web',
    user_id: 'user-alice',
    title: 'Alice thread',
    ai_assistant_type: 'claude',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    deleted_at: null,
    codebase_id: null,
    ...overrides,
  };
}

/**
 * Open a stream and stop reading it. The handler's heartbeat loop never ends on
 * its own, so the assertions are on the response head — status and content type
 * — and the body is cancelled rather than drained.
 */
async function openStream(path: string, user?: string): Promise<Response> {
  const controller = new AbortController();
  const res = await makeApp().request(path, {
    headers: user ? { 'X-Archon-User': user } : {},
    signal: controller.signal,
  });
  await res.body?.cancel();
  controller.abort();
  return res;
}

describe('GET /api/stream/:conversationId ownership (#3135)', () => {
  beforeEach(() => {
    ownershipEnforced = false;
    storedConversation = conversation();
    mockRegisterStream.mockClear();
    mockFindConversationByPlatformId.mockClear();
  });
  afterEach(() => {
    ownershipEnforced = false;
  });

  test('owner opens a stream', async () => {
    ownershipEnforced = true;
    const res = await openStream(`/api/stream/${CONVERSATION_ID}`, 'alice');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(mockRegisterStream).toHaveBeenCalledWith(CONVERSATION_ID, expect.anything());
  });

  test('non-owner gets a JSON 404 and no stream is opened', async () => {
    ownershipEnforced = true;
    const res = await makeApp().request(`/api/stream/${CONVERSATION_ID}`, {
      headers: { 'X-Archon-User': 'bob' },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Conversation not found' });
    expect(mockRegisterStream).not.toHaveBeenCalled();
  });

  // Fail-closed: a row Archon cannot attribute is "unknown", not "public".
  test('ownerless row is streamable by nobody', async () => {
    ownershipEnforced = true;
    storedConversation = conversation({ user_id: null });
    const res = await makeApp().request(`/api/stream/${CONVERSATION_ID}`, {
      headers: { 'X-Archon-User': 'alice' },
    });
    expect(res.status).toBe(404);
    expect(mockRegisterStream).not.toHaveBeenCalled();
  });

  test('unresolved identity is refused, never widened', async () => {
    ownershipEnforced = true;
    const res = await makeApp().request(`/api/stream/${CONVERSATION_ID}`);
    expect(res.status).toBe(404);
    expect(mockRegisterStream).not.toHaveBeenCalled();
  });

  test('an id naming no conversation gets 404 instead of a stream', async () => {
    ownershipEnforced = true;
    const res = await makeApp().request('/api/stream/web-invented', {
      headers: { 'X-Archon-User': 'alice' },
    });
    expect(res.status).toBe(404);
    expect(mockRegisterStream).not.toHaveBeenCalled();
  });

  test('a platform privacy does not cover still streams for everyone', async () => {
    ownershipEnforced = true;
    storedConversation = conversation({ platform_type: 'slack', user_id: 'user-someone' });
    const res = await openStream(`/api/stream/${CONVERSATION_ID}`, 'bob');
    expect(res.status).toBe(200);
    expect(mockRegisterStream).toHaveBeenCalled();
  });

  test('a lookup failure fails closed with 500 rather than opening the stream', async () => {
    ownershipEnforced = true;
    mockFindConversationByPlatformId.mockImplementationOnce(async () => {
      throw new Error('database is down');
    });
    const res = await makeApp().request(`/api/stream/${CONVERSATION_ID}`, {
      headers: { 'X-Archon-User': 'alice' },
    });
    expect(res.status).toBe(500);
    expect(mockRegisterStream).not.toHaveBeenCalled();
  });

  test('enforcement off (solo install): any id opens without a lookup', async () => {
    const res = await openStream('/api/stream/web-never-persisted');
    expect(res.status).toBe(200);
    expect(mockRegisterStream).toHaveBeenCalledWith('web-never-persisted', expect.anything());
    expect(mockFindConversationByPlatformId).not.toHaveBeenCalled();
  });
});

describe('GET /api/stream/__dashboard__', () => {
  beforeEach(() => {
    ownershipEnforced = false;
    storedConversation = conversation();
    mockRegisterStream.mockClear();
    mockFindConversationByPlatformId.mockClear();
  });
  afterEach(() => {
    ownershipEnforced = false;
  });

  // The literal path must keep winning over :conversationId, or the install-wide
  // ops view would be authorized as a conversation named `__dashboard__` and
  // stop resolving for everyone under enforcement.
  test('stays open under enforcement, with no conversation lookup', async () => {
    ownershipEnforced = true;
    const res = await openStream('/api/stream/__dashboard__');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(mockRegisterStream).toHaveBeenCalledWith('__dashboard__', expect.anything());
    expect(mockFindConversationByPlatformId).not.toHaveBeenCalled();
  });
});

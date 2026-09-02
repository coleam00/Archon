import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Ownership enforcement on every by-id conversation ingress (#3135).
//
// Mock setup must precede the dynamic import of ./api below. The matrix at the
// bottom drives each ingress through the same five states, and the inventory
// test fails when a new /api/conversations/{id} route is added without being
// proven here.
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

// --- Controllable web-auth module (../auth) ---
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

/** The row `findConversationByPlatformId` returns; null means "no such row". */
let storedConversation: ConversationRow | null = null;
/** `@archon/paths` mock home; one test points it at a real temp dir to assert on disk. */
let mockArchonHome = '/tmp/.archon';

const mockFindConversationByPlatformId = mock(
  async (platformId: string): Promise<ConversationRow | null> =>
    storedConversation && storedConversation.platform_conversation_id === platformId
      ? storedConversation
      : null
);
const mockSoftDeleteConversation = mock(async (_id: string) => {});
const mockUpdateConversationTitle = mock(async (_id: string, _title: string) => {});

const PRIVATE_PLATFORM_TYPES = ['web', 'cli'] as const;

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  softDeleteConversation: mockSoftDeleteConversation,
  updateConversationTitle: mockUpdateConversationTitle,
  listConversations: mock(async () => []),
  getConversationById: mock(async (id: string) =>
    storedConversation && storedConversation.id === id ? storedConversation : null
  ),
  getOrCreateConversation: mock(async () => ({
    id: 'internal-new',
    platform_conversation_id: 'web-new',
  })),
  PRIVATE_PLATFORM_TYPES,
  isPrivatePlatformType: (platformType: string) =>
    (PRIVATE_PLATFORM_TYPES as readonly string[]).includes(platformType),
}));

const mockResetNodeSessions = mock(async (_filter: unknown) => ({ deleted: 1 }));
mock.module('@archon/core/operations/workflow-operations', () => ({
  abandonWorkflow: mock(async () => {}),
  approveWorkflow: mock(async () => {}),
  rejectWorkflow: mock(async () => {}),
  respondToWorkflow: mock(async () => {}),
  assertRespondable: mock(() => {}),
  resetWorkflowNodeSessions: mockResetNodeSessions,
}));

const mockHandleMessage = mock(async () => {});
const mockAddMessage = mock(async () => ({ id: 'msg-1' }));
const mockListMessages = mock(async () => []);

mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
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
  getArchonHome: () => mockArchonHome,
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
  addMessage: mockAddMessage,
  listMessages: mockListMessages,
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

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const mockWebAdapter = {
    setConversationDbId: mock(() => {}),
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
  return app;
}

const CONVERSATION_ID = 'web-alice-1';

const INTERNAL_ID = 'internal-uuid-1';

function conversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: INTERNAL_ID,
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

function asUser(user?: string): { headers: Record<string, string> } {
  return { headers: user ? { 'X-Archon-User': user } : {} };
}

interface Ingress {
  name: string;
  /** OpenAPI path + method, used by the route-inventory test. */
  path: string;
  method: string;
  call: (app: OpenAPIHono, conversationId: string, user?: string) => Response | Promise<Response>;
}

const INGRESSES: readonly Ingress[] = [
  {
    name: 'get',
    path: '/api/conversations/{id}',
    method: 'get',
    call: (app, id, user) => app.request(`/api/conversations/${id}`, asUser(user)),
  },
  {
    name: 'messages',
    path: '/api/conversations/{id}/messages',
    method: 'get',
    call: (app, id, user) => app.request(`/api/conversations/${id}/messages`, asUser(user)),
  },
  {
    name: 'rename',
    path: '/api/conversations/{id}',
    method: 'patch',
    call: (app, id, user) =>
      app.request(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...asUser(user).headers },
        body: JSON.stringify({ title: 'Renamed by the caller' }),
      }),
  },
  {
    name: 'delete',
    path: '/api/conversations/{id}',
    method: 'delete',
    call: (app, id, user) =>
      app.request(`/api/conversations/${id}`, { method: 'DELETE', ...asUser(user) }),
  },
  {
    name: 'send',
    path: '/api/conversations/{id}/message',
    method: 'post',
    call: (app, id, user) =>
      app.request(`/api/conversations/${id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...asUser(user).headers },
        body: JSON.stringify({ message: 'hello' }),
      }),
  },
  {
    name: 'run',
    // The conversation id arrives in the body here, not the path — which is why
    // the check is a helper every handler calls rather than path middleware.
    path: '/api/workflows/{name}/run',
    method: 'post',
    call: (app, id, user) =>
      app.request('/api/workflows/demo/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...asUser(user).headers },
        body: JSON.stringify({ conversationId: id, message: 'go' }),
      }),
  },
  {
    // A node-session scope key is the conversation's INTERNAL id (the in-chat
    // `/workflow reset-sessions` passes the authorized row's own id), so this
    // route is a conversation ingress that the platform-id prefix inventory below
    // would never see; it is listed by hand there.
    name: 'reset node sessions',
    path: '/api/workflows/{name}/node-sessions',
    method: 'delete',
    call: (app, _id, user) =>
      app.request(`/api/workflows/demo/node-sessions?scope=${INTERNAL_ID}`, {
        method: 'DELETE',
        ...asUser(user),
      }),
  },
];

describe('conversation ownership on every by-id ingress (#3135)', () => {
  beforeEach(() => {
    ownershipEnforced = false;
    storedConversation = conversation();
    mockSoftDeleteConversation.mockClear();
    mockUpdateConversationTitle.mockClear();
    mockHandleMessage.mockClear();
    mockAddMessage.mockClear();
  });
  afterEach(() => {
    ownershipEnforced = false;
  });

  for (const ingress of INGRESSES) {
    describe(ingress.name, () => {
      test('owner reaches it', async () => {
        ownershipEnforced = true;
        const res = await ingress.call(makeApp(), CONVERSATION_ID, 'alice');
        expect(res.status).toBe(200);
      });

      test('non-owner gets 404, indistinguishable from a missing conversation', async () => {
        ownershipEnforced = true;
        const res = await ingress.call(makeApp(), CONVERSATION_ID, 'bob');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Conversation not found' });
      });

      // Fail-closed: a row Archon cannot attribute is "unknown", not "public".
      test('ownerless row is reachable by nobody', async () => {
        ownershipEnforced = true;
        storedConversation = conversation({ user_id: null });
        const res = await ingress.call(makeApp(), CONVERSATION_ID, 'alice');
        expect(res.status).toBe(404);
      });

      test('unresolved identity is refused, never widened', async () => {
        ownershipEnforced = true;
        const res = await ingress.call(makeApp(), CONVERSATION_ID);
        expect(res.status).toBe(404);
      });

      test('enforcement off (solo install) → anyone reaches it', async () => {
        const res = await ingress.call(makeApp(), CONVERSATION_ID);
        expect(res.status).toBe(200);
      });

      test('platforms privacy does not cover keep today behavior', async () => {
        ownershipEnforced = true;
        storedConversation = conversation({ platform_type: 'slack', user_id: 'user-someone' });
        const res = await ingress.call(makeApp(), CONVERSATION_ID, 'bob');
        expect(res.status).toBe(200);
      });
    });
  }

  test('a denied rename never writes', async () => {
    ownershipEnforced = true;
    const res = await INGRESSES.find(i => i.name === 'rename')?.call(
      makeApp(),
      CONVERSATION_ID,
      'bob'
    );
    expect(res?.status).toBe(404);
    expect(mockUpdateConversationTitle).not.toHaveBeenCalled();
  });

  test('a denied delete never writes', async () => {
    ownershipEnforced = true;
    const res = await INGRESSES.find(i => i.name === 'delete')?.call(
      makeApp(),
      CONVERSATION_ID,
      'bob'
    );
    expect(res?.status).toBe(404);
    expect(mockSoftDeleteConversation).not.toHaveBeenCalled();
  });

  test('a denied send never dispatches to the orchestrator', async () => {
    ownershipEnforced = true;
    const res = await INGRESSES.find(i => i.name === 'send')?.call(
      makeApp(),
      CONVERSATION_ID,
      'bob'
    );
    expect(res?.status).toBe(404);
    expect(mockHandleMessage).not.toHaveBeenCalled();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});

// A caller naming an id that matches no row used to have a conversation
// materialize at that identifier through dispatch — creating rows at
// caller-chosen ids is the shape of the hole this change closes.
describe('dispatch to an unknown conversation id', () => {
  beforeEach(() => {
    ownershipEnforced = false;
    storedConversation = null;
    mockHandleMessage.mockClear();
  });
  afterEach(() => {
    ownershipEnforced = false;
  });

  test('send: enforced → 404 and no dispatch', async () => {
    ownershipEnforced = true;
    const res = await makeApp().request('/api/conversations/web-invented/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Archon-User': 'alice' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(404);
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  test('send: enforcement off → today create-on-dispatch is preserved', async () => {
    const res = await makeApp().request('/api/conversations/web-invented/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(mockHandleMessage).toHaveBeenCalled();
  });

  test('workflow run: enforced → 404 and no dispatch', async () => {
    ownershipEnforced = true;
    const res = await makeApp().request('/api/workflows/demo/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Archon-User': 'alice' },
      body: JSON.stringify({ conversationId: 'web-invented', message: 'go' }),
    });
    expect(res.status).toBe(404);
    expect(mockHandleMessage).not.toHaveBeenCalled();
  });

  // The upload directory is per conversation and shared by every request into it.
  // A refused multipart run must delete only what it wrote: a recursive delete
  // would take a concurrent owner request's attachments before orchestration read
  // them, which turns a 404 for the intruder into lost input for the owner.
  test("workflow run: a refused multipart request leaves the owner's uploads in place", async () => {
    ownershipEnforced = true;
    storedConversation = conversation({ user_id: 'user-bob' });
    const home = await mkdtemp(join(tmpdir(), 'archon-ownership-uploads-'));
    const previousHome = mockArchonHome;
    mockArchonHome = home;
    const uploadDir = join(home, 'artifacts', 'uploads', CONVERSATION_ID);
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, 'owner-attachment.txt'), 'bob was here first');
    try {
      const form = new FormData();
      form.append('conversationId', CONVERSATION_ID);
      form.append('message', 'go');
      form.append('files', new File(['intruder'], 'intruder.txt', { type: 'text/plain' }));

      const res = await makeApp().request('/api/workflows/demo/run', {
        method: 'POST',
        headers: { 'X-Archon-User': 'user-alice' },
        body: form,
      });

      expect(res.status).toBe(404);
      expect(mockHandleMessage).not.toHaveBeenCalled();
      // Only the refused request's own file is gone; the directory and its
      // sibling survive for the owner's in-flight request.
      expect((await readdir(uploadDir)).sort()).toEqual(['owner-attachment.txt']);
    } finally {
      mockArchonHome = previousHome;
      await removeTempTree(home);
    }
  });

  test('node-sessions: the cross-scope wipe is refused while conversations are owned', async () => {
    ownershipEnforced = true;
    mockResetNodeSessions.mockClear();
    const res = await makeApp().request('/api/workflows/demo/node-sessions?confirm=all-scopes', {
      method: 'DELETE',
      headers: { 'X-Archon-User': 'alice' },
    });
    expect(res.status).toBe(403);
    expect(mockResetNodeSessions).not.toHaveBeenCalled();
  });

  test('node-sessions: a scope naming no conversation is unreachable under enforcement', async () => {
    ownershipEnforced = true;
    mockResetNodeSessions.mockClear();
    const res = await makeApp().request('/api/workflows/demo/node-sessions?scope=not-a-row', {
      method: 'DELETE',
      headers: { 'X-Archon-User': 'alice' },
    });
    expect(res.status).toBe(404);
    expect(mockResetNodeSessions).not.toHaveBeenCalled();
  });

  test('node-sessions: enforcement off → the cross-scope wipe still works as today', async () => {
    mockResetNodeSessions.mockClear();
    const res = await makeApp().request('/api/workflows/demo/node-sessions?confirm=all-scopes', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(mockResetNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'demo',
      scope_key: undefined,
      node_id: undefined,
    });
  });

  test('workflow run: enforcement off → today create-on-dispatch is preserved', async () => {
    const res = await makeApp().request('/api/workflows/demo/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'web-invented', message: 'go' }),
    });
    expect(res.status).toBe(200);
    expect(mockHandleMessage).toHaveBeenCalled();
  });
});

// Forge ids carry `/`, `#`, and `!`. They belong to platforms privacy does not
// cover, so they stay reachable — but they must still travel through the helper
// with the same decoding the direct lookup used to do.
describe('forge conversation ids still resolve through the helper', () => {
  beforeEach(() => {
    ownershipEnforced = true;
    storedConversation = conversation({
      platform_conversation_id: 'CyberFitz-LLC/devops-platform#24',
      platform_type: 'github',
      user_id: null,
    });
  });
  afterEach(() => {
    ownershipEnforced = false;
  });

  test('GET decodes %2F and %23 before the lookup', async () => {
    mockFindConversationByPlatformId.mockClear();
    const res = await makeApp().request('/api/conversations/CyberFitz-LLC%2Fdevops-platform%2324', {
      headers: { 'X-Archon-User': 'bob' },
    });
    expect(res.status).toBe(200);
    expect(mockFindConversationByPlatformId).toHaveBeenCalledWith(
      'CyberFitz-LLC/devops-platform#24'
    );
  });
});

// Buys back the one property route middleware would have given: a new by-id
// conversation route that forgets the helper fails here instead of shipping a
// hole. Add the route to INGRESSES — which proves it denies a non-owner — to
// make this pass again.
describe('route inventory', () => {
  test('every /api/conversations/{id} operation is covered by the ownership matrix', async () => {
    const res = await makeApp().request('/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> };

    const declared: string[] = [];
    for (const [path, operations] of Object.entries(doc.paths)) {
      if (!path.startsWith('/api/conversations/{')) continue;
      for (const method of Object.keys(operations)) declared.push(`${method} ${path}`);
    }
    const covered = new Set(INGRESSES.map(i => `${i.method} ${i.path}`));

    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter(op => !covered.has(op))).toEqual([]);

    // Conversation ingresses that live outside the prefix and so cannot be found
    // by scanning it. Each names a conversation by another key and must sit in
    // the matrix above; add here when another such route appears.
    const outsidePrefix = ['delete /api/workflows/{name}/node-sessions'];
    expect(outsidePrefix.filter(op => !covered.has(op))).toEqual([]);
    for (const op of outsidePrefix) {
      const [method, path] = op.split(' ');
      expect(Object.keys(doc.paths[path] ?? {})).toContain(method);
    }
  });
});

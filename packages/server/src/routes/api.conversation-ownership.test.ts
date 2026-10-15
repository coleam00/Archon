import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { SSEStreamingApi } from 'hono/streaming';
import type { ConversationLockManager } from '@archon/core';
import * as sqlHost from '@archon/core/workflows/sql-host';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { makeIdleLockStats } from '../test/conversation-lock-fixtures';
import { makeListDashboardRunsMock, mockAllWorkflowModules } from '../test/workflow-mock-factories';
import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Operator conversations are private to their owner (#3135). Every ingress that
// names a conversation runs through the same matrix of callers below, and the
// inventory test at the bottom fails when a conversation route is added without
// joining it. Mock setup must precede the dynamic import of ./api.
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
let apiGateEnabled = false;
let authInstance: { api: { getSession: () => Promise<unknown> } } | null = null;

mock.module('../auth', () => ({
  getAuth: () => authInstance,
  isWebAuthEnabled: () => false,
  getSignupMode: () => 'disabled',
  isApiGateEnabled: () => apiGateEnabled,
  isConversationOwnershipEnforced: () => ownershipEnforced,
}));

// `X-Archon-User: alice` resolves to `user-alice`. `usersDown` simulates the
// database failing during identity resolution.
let usersDown = false;
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(async (_platform: string, platformUserId: string) => {
    if (usersDown) throw new Error('connection refused');
    return {
      id: `user-${platformUserId}`,
      display_name: null,
      email: null,
      role: 'admin' as const,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }),
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
  last_activity_at: Date | null;
  codebase_id: string | null;
  cwd: string | null;
  isolation_env_id: string | null;
  hidden: boolean;
}

const PLATFORM_ID = 'web-alice-1';
const INTERNAL_ID = 'internal-uuid-1';

function conversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: INTERNAL_ID,
    platform_conversation_id: PLATFORM_ID,
    platform_type: 'web',
    user_id: 'user-alice',
    title: 'Alice thread',
    ai_assistant_type: 'claude',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    deleted_at: null,
    last_activity_at: null,
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    hidden: false,
    ...overrides,
  };
}

// Platform ids are unique per platform only, so two rows can share one. The
// platform-agnostic lookup returns whichever row it meets first, as the real one may.
let rows: ConversationRow[] = [conversation()];
let mockArchonHome = '/tmp/.archon';

const mockFindConversationByPlatformId = mock(
  async (platformId: string) => rows.find(r => r.platform_conversation_id === platformId) ?? null
);
const mockGetConversationByPlatformId = mock(
  async (platformType: string, platformId: string) =>
    rows.find(r => r.platform_type === platformType && r.platform_conversation_id === platformId) ??
    null
);
const mockGetConversationById = mock(async (id: string) => rows.find(r => r.id === id) ?? null);
const mockListConversations = mock(async (_visibility: unknown, _filter?: unknown) => []);
const mockGetOrCreateConversation = mock(
  async (
    _platform: string,
    platformId: string,
    _codebaseId?: string,
    _parent?: string,
    userId?: string
  ) => conversation({ id: 'internal-new', platform_conversation_id: platformId, user_id: userId })
);
const mockSoftDeleteConversation = mock(async (_id: string) => {});
const mockUpdateConversationTitle = mock(async (_id: string, _title: string) => {});

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mockFindConversationByPlatformId,
  getConversationByPlatformId: mockGetConversationByPlatformId,
  getConversationById: mockGetConversationById,
  listConversations: mockListConversations,
  getOrCreateConversation: mockGetOrCreateConversation,
  softDeleteConversation: mockSoftDeleteConversation,
  updateConversationTitle: mockUpdateConversationTitle,
}));

let runTranscript = false;
const mockIsRunTranscriptConversation = mock(async (_id: string) => runTranscript);
mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: makeListDashboardRunsMock(),
  getWorkflowRun: mock(async () => null),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  isRunTranscriptConversation: mockIsRunTranscriptConversation,
}));

const mockHandleMessage = mock(async () => {});
const mockAddMessage = mock(async () => ({ id: 'msg-1' }));
const mockListMessages = mock(async () => []);

mock.module('@archon/core', () => ({
  handleMessage: mockHandleMessage,
  getDatabaseType: () => 'postgresql',
  getSchemaVersion: mock(async () => null),
  loadConfig: mock(async () => ({})),
  ProjectRegistrationError: class ProjectRegistrationError extends Error {},
  inspectProjectBaseBranch: mock(async () => ({
    kind: 'repo',
    defaultBranch: 'dev',
    reason: null,
  })),
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
  canonicalizeProjectPath: async (path: string) => path,
  createLogger: noopLogger,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  getBundledWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows'),
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

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/utils/commands', () => ({
  findCommandFiles: mock(async () => []),
}));

const operations = sqlHost.createSqlWorkflowOperations();
const mockResetNodeSessions = spyOn(operations, 'resetWorkflowNodeSessions').mockResolvedValue({
  deleted: 1,
});
spyOn(sqlHost, 'createSqlWorkflowOperations').mockReturnValue(operations);

// The heartbeat loop would otherwise hold an opened stream for 30 seconds.
spyOn(SSEStreamingApi.prototype, 'sleep').mockImplementation(async () => {
  throw new Error('aborted');
});

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const webAdapter = {
    setConversationDbId: mock(() => {}),
    emitSSE: mock(async () => {}),
    emitLockEvent: mock(async () => {}),
    registerStream: mock(() => {}),
    removeStream: mock(() => {}),
  } as unknown as WebAdapter;
  const lockManager = {
    acquireLock: mock(async (_id: string, fn: () => Promise<void>) => {
      await fn();
      return { status: 'started' };
    }),
    getStats: mock(makeIdleLockStats),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, webAdapter, lockManager);
  return app;
}

function headersFor(user?: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, ...(user ? { 'X-Archon-User': user } : {}) };
}

const json = { 'Content-Type': 'application/json' };

interface Ingress {
  name: string;
  /** OpenAPI method + path, for the route inventory. */
  operation: string;
  access: 'read' | 'write';
  /** Acts through the web adapter, which knows only `web` rows by platform id. */
  web?: true;
  call: (app: OpenAPIHono, user?: string) => Response | Promise<Response>;
  /** Side effects a refused caller must never cause. */
  effects: () => readonly { mock: { calls: unknown[] } }[];
}

const INGRESSES: readonly Ingress[] = [
  {
    name: 'get',
    operation: 'get /api/conversations/{id}',
    access: 'read',
    call: (app, user) =>
      app.request(`/api/conversations/${PLATFORM_ID}`, { headers: headersFor(user) }),
    effects: () => [],
  },
  {
    name: 'messages',
    operation: 'get /api/conversations/{id}/messages',
    access: 'read',
    call: (app, user) =>
      app.request(`/api/conversations/${PLATFORM_ID}/messages`, { headers: headersFor(user) }),
    effects: () => [mockListMessages],
  },
  {
    name: 'stream',
    operation: 'get /api/stream/{conversationId}',
    access: 'read',
    web: true,
    call: async (app, user) => {
      const res = await app.request(`/api/stream/${PLATFORM_ID}`, { headers: headersFor(user) });
      // Only an opened stream needs closing; a refusal is a plain JSON body.
      if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
        await res.body?.cancel();
      }
      return res;
    },
    effects: () => [],
  },
  {
    name: 'rename',
    operation: 'patch /api/conversations/{id}',
    access: 'write',
    call: (app, user) =>
      app.request(`/api/conversations/${PLATFORM_ID}`, {
        method: 'PATCH',
        headers: headersFor(user, json),
        body: JSON.stringify({ title: 'Renamed by the caller' }),
      }),
    effects: () => [mockUpdateConversationTitle],
  },
  {
    name: 'delete',
    operation: 'delete /api/conversations/{id}',
    access: 'write',
    call: (app, user) =>
      app.request(`/api/conversations/${PLATFORM_ID}`, {
        method: 'DELETE',
        headers: headersFor(user),
      }),
    effects: () => [mockSoftDeleteConversation],
  },
  {
    name: 'send',
    operation: 'post /api/conversations/{id}/message',
    access: 'write',
    web: true,
    call: (app, user) =>
      app.request(`/api/conversations/${PLATFORM_ID}/message`, {
        method: 'POST',
        headers: headersFor(user, json),
        body: JSON.stringify({ message: 'hello' }),
      }),
    effects: () => [mockHandleMessage, mockAddMessage],
  },
  {
    // The conversation id arrives in the body, which is why authorization is a
    // helper each handler calls rather than path middleware.
    name: 'workflow run',
    operation: 'post /api/workflows/{name}/run',
    access: 'write',
    web: true,
    call: (app, user) =>
      app.request('/api/workflows/demo/run', {
        method: 'POST',
        headers: headersFor(user, json),
        body: JSON.stringify({ conversationId: PLATFORM_ID, message: 'go' }),
      }),
    effects: () => [mockHandleMessage, mockAddMessage],
  },
  {
    // A node-session scope is the conversation's internal id.
    name: 'node-session reset',
    operation: 'delete /api/workflows/{name}/node-sessions',
    access: 'write',
    call: (app, user) =>
      app.request(`/api/workflows/demo/node-sessions?scope=${INTERNAL_ID}`, {
        method: 'DELETE',
        headers: headersFor(user),
      }),
    effects: () => [mockResetNodeSessions],
  },
];

function clearEffects(): void {
  for (const m of [
    mockListMessages,
    mockUpdateConversationTitle,
    mockSoftDeleteConversation,
    mockHandleMessage,
    mockAddMessage,
    mockResetNodeSessions,
    mockListConversations,
    mockGetOrCreateConversation,
    mockIsRunTranscriptConversation,
  ]) {
    m.mockClear();
  }
}

function expectNoEffects(ingress: Ingress): void {
  for (const effect of ingress.effects()) expect(effect.mock.calls).toHaveLength(0);
}

beforeEach(() => {
  ownershipEnforced = false;
  apiGateEnabled = false;
  usersDown = false;
  authInstance = null;
  runTranscript = false;
  rows = [conversation()];
  mockArchonHome = '/tmp/.archon';
  clearEffects();
});

afterAll(() => {
  mock.restore();
});

describe('every conversation ingress enforces ownership', () => {
  for (const ingress of INGRESSES) {
    describe(ingress.name, () => {
      test('the owner reaches it', async () => {
        ownershipEnforced = true;
        expect((await ingress.call(makeApp(), 'alice')).status).toBe(200);
      });

      test('another user gets the same 404 as a missing conversation, and nothing happens', async () => {
        ownershipEnforced = true;
        const res = await ingress.call(makeApp(), 'bob');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Conversation not found' });
        expectNoEffects(ingress);
      });

      test('an ownerless conversation is reachable by nobody', async () => {
        ownershipEnforced = true;
        rows = [conversation({ user_id: null })];
        expect((await ingress.call(makeApp(), 'alice')).status).toBe(404);
        expectNoEffects(ingress);
      });

      test('an unresolved identity is refused with 401, never widened', async () => {
        ownershipEnforced = true;
        expect((await ingress.call(makeApp())).status).toBe(401);
        expectNoEffects(ingress);
      });

      test('an identity-backend outage is 503, not 401 or 404', async () => {
        ownershipEnforced = true;
        usersDown = true;
        expect((await ingress.call(makeApp(), 'alice')).status).toBe(503);
        expectNoEffects(ingress);
      });

      test('the API gate reports an identity-backend outage as 503 too', async () => {
        ownershipEnforced = true;
        apiGateEnabled = true;
        usersDown = true;
        expect((await ingress.call(makeApp(), 'alice')).status).toBe(503);
        expectNoEffects(ingress);
      });

      test('a solo install without identity reaches it as before', async () => {
        expect((await ingress.call(makeApp())).status).toBe(200);
      });

      if (ingress.web) {
        test('a chat-platform row at the id does not admit anyone to the web chat', async () => {
          ownershipEnforced = true;
          rows = [
            conversation({ id: 'internal-slack', platform_type: 'slack', user_id: null }),
            conversation(),
          ];
          expect((await ingress.call(makeApp(), 'bob')).status).toBe(404);
          expectNoEffects(ingress);
          expect((await ingress.call(makeApp(), 'alice')).status).toBe(200);
        });

        test('a chat-platform row alone is not a web chat to act on', async () => {
          ownershipEnforced = true;
          rows = [conversation({ platform_type: 'slack', user_id: 'user-someone' })];
          expect((await ingress.call(makeApp(), 'bob')).status).toBe(404);
          expectNoEffects(ingress);
        });
      } else {
        test('chat and forge platforms keep their own access model', async () => {
          ownershipEnforced = true;
          rows = [conversation({ platform_type: 'slack', user_id: 'user-someone' })];
          expect((await ingress.call(makeApp(), 'bob')).status).toBe(200);
        });
      }

      if (ingress.access === 'read') {
        test("a run's transcript stays readable to another signed-in user", async () => {
          ownershipEnforced = true;
          runTranscript = true;
          rows = [conversation({ hidden: true })];
          expect((await ingress.call(makeApp(), 'bob')).status).toBe(200);
          expect(mockIsRunTranscriptConversation).toHaveBeenCalledWith(INTERNAL_ID);
        });
      } else {
        test("a run's transcript is still not writable by another user", async () => {
          ownershipEnforced = true;
          runTranscript = true;
          rows = [conversation({ hidden: true })];
          expect((await ingress.call(makeApp(), 'bob')).status).toBe(404);
          expectNoEffects(ingress);
        });
      }
    });
  }
});

describe('Better Auth sessions', () => {
  const getConversation = (headers: Record<string, string> = {}) =>
    makeApp().request(`/api/conversations/${PLATFORM_ID}`, { headers });

  test("a signed-in user cannot open another user's conversation", async () => {
    ownershipEnforced = true;
    authInstance = { api: { getSession: async () => ({ user: { id: 'bob', name: 'Bob' } }) } };
    expect((await getConversation()).status).toBe(404);
  });

  test('the session wins over a trusted header naming the owner', async () => {
    ownershipEnforced = true;
    authInstance = { api: { getSession: async () => ({ user: { id: 'bob', name: 'Bob' } }) } };
    expect((await getConversation({ 'X-Archon-User': 'alice' })).status).toBe(404);
  });

  test('a session-backend outage is 503 even when a header could stand in', async () => {
    ownershipEnforced = true;
    authInstance = {
      api: {
        getSession: async () => {
          throw new Error('connection refused');
        },
      },
    };
    expect((await getConversation({ 'X-Archon-User': 'alice' })).status).toBe(503);
  });
});

describe('conversation list', () => {
  const list = (user?: string, query = '') =>
    makeApp().request(`/api/conversations${query}`, { headers: headersFor(user) });

  test('an enforced install lists only the caller-owned conversations', async () => {
    ownershipEnforced = true;
    expect((await list('alice')).status).toBe(200);
    expect(mockListConversations.mock.calls[0]?.[0]).toEqual({
      kind: 'owner',
      userId: 'user-alice',
    });
  });

  test('`mine=false` cannot widen an enforced list', async () => {
    ownershipEnforced = true;
    expect((await list('alice', '?mine=false')).status).toBe(200);
    expect(mockListConversations.mock.calls[0]?.[0]).toEqual({
      kind: 'owner',
      userId: 'user-alice',
    });
  });

  test('an unresolved identity is 401, never the whole install', async () => {
    ownershipEnforced = true;
    expect((await list(undefined, '?mine=true')).status).toBe(401);
    expect(mockListConversations).not.toHaveBeenCalled();
  });

  test('an identity-backend outage is 503, never the whole install', async () => {
    ownershipEnforced = true;
    usersDown = true;
    expect((await list('alice')).status).toBe(503);
    expect(mockListConversations).not.toHaveBeenCalled();
  });

  test('a solo install lists everything', async () => {
    expect((await list(undefined, '?mine=true')).status).toBe(200);
    expect(mockListConversations.mock.calls[0]?.[0]).toEqual({ kind: 'all' });
  });

  test('off enforcement, `mine=true` still narrows to a resolved identity', async () => {
    expect((await list('alice', '?mine=true')).status).toBe(200);
    expect(mockListConversations.mock.calls[0]?.[0]).toEqual({
      kind: 'owner',
      userId: 'user-alice',
    });
  });
});

describe('conversation create', () => {
  const create = (user?: string) =>
    makeApp().request('/api/conversations', {
      method: 'POST',
      headers: headersFor(user, json),
      body: JSON.stringify({}),
    });

  test('an enforced install stamps the caller as owner', async () => {
    ownershipEnforced = true;
    expect((await create('alice')).status).toBe(200);
    expect(mockGetOrCreateConversation.mock.calls[0]?.[4]).toBe('user-alice');
  });

  test('an unresolved identity is 401 and creates no ownerless row', async () => {
    ownershipEnforced = true;
    expect((await create()).status).toBe(401);
    expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
  });

  test('an identity-backend outage is 503 and creates no row', async () => {
    ownershipEnforced = true;
    usersDown = true;
    expect((await create('alice')).status).toBe(503);
    expect(mockGetOrCreateConversation).not.toHaveBeenCalled();
  });

  test('a solo install still creates an unattributed conversation', async () => {
    expect((await create()).status).toBe(200);
    expect(mockGetOrCreateConversation.mock.calls[0]?.[4]).toBeUndefined();
  });
});

// Dispatch used to materialize a conversation at whatever id the caller named.
describe('dispatch to an unknown conversation id', () => {
  beforeEach(() => {
    rows = [];
  });

  for (const ingress of INGRESSES.filter(i => i.name === 'send' || i.name === 'workflow run')) {
    test(`${ingress.name}: an enforced install refuses it with 404`, async () => {
      ownershipEnforced = true;
      expect((await ingress.call(makeApp(), 'alice')).status).toBe(404);
      expect(mockHandleMessage).not.toHaveBeenCalled();
    });

    test(`${ingress.name}: a solo install still dispatches`, async () => {
      expect((await ingress.call(makeApp())).status).toBe(200);
      expect(mockHandleMessage).toHaveBeenCalled();
    });
  }
});

describe('refused uploads', () => {
  // The upload directory is per conversation and shared by every request into it,
  // so a refused request must not write into it, nor delete what the owner wrote.
  for (const route of ['send', 'workflow run'] as const) {
    test(`${route}: a refused multipart request leaves the owner's directory untouched`, async () => {
      ownershipEnforced = true;
      const home = await mkdtemp(join(tmpdir(), 'archon-ownership-uploads-'));
      mockArchonHome = home;
      const uploadDir = join(home, 'artifacts', 'uploads', PLATFORM_ID);
      await mkdir(uploadDir, { recursive: true });
      await writeFile(join(uploadDir, 'owner-attachment.txt'), 'alice was here first');
      try {
        const form = new FormData();
        form.append('message', 'go');
        form.append('files', new File(['intruder'], 'intruder.txt', { type: 'text/plain' }));
        let res: Response;
        if (route === 'send') {
          res = await makeApp().request(`/api/conversations/${PLATFORM_ID}/message`, {
            method: 'POST',
            headers: headersFor('bob'),
            body: form,
          });
        } else {
          form.append('conversationId', PLATFORM_ID);
          res = await makeApp().request('/api/workflows/demo/run', {
            method: 'POST',
            headers: headersFor('bob'),
            body: form,
          });
        }
        expect(res.status).toBe(404);
        expect(mockHandleMessage).not.toHaveBeenCalled();
        expect(await readdir(uploadDir)).toEqual(['owner-attachment.txt']);
      } finally {
        await removeTempTree(home);
      }
    });
  }
});

describe('node-session reset across every scope', () => {
  const resetAll = (user?: string) =>
    makeApp().request('/api/workflows/demo/node-sessions?confirm=all-scopes', {
      method: 'DELETE',
      headers: headersFor(user),
    });

  test("is refused on an enforced install: it would reach other users' conversations", async () => {
    ownershipEnforced = true;
    expect((await resetAll('alice')).status).toBe(403);
    expect(mockResetNodeSessions).not.toHaveBeenCalled();
  });

  test('still works on a solo install', async () => {
    expect((await resetAll()).status).toBe(200);
    expect(mockResetNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'demo',
      scope_key: undefined,
      node_id: undefined,
    });
  });
});

describe('route inventory', () => {
  test('every route naming a conversation is in the ownership matrix', async () => {
    const res = await makeApp().request('/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> };

    const declared: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      if (!path.startsWith('/api/conversations/{')) continue;
      for (const method of Object.keys(ops)) declared.push(`${method} ${path}`);
    }
    const covered = new Set(INGRESSES.map(i => i.operation));
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter(op => !covered.has(op))).toEqual([]);

    // Ingresses outside the prefix name a conversation by another key and must
    // exist where the matrix says they do. The stream is a plain Hono route.
    for (const op of [
      'post /api/workflows/{name}/run',
      'delete /api/workflows/{name}/node-sessions',
    ]) {
      const [method, path] = op.split(' ');
      expect(Object.keys(doc.paths[path] ?? {})).toContain(method);
    }
  });
});

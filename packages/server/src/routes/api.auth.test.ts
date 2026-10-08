import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { Hono, type Context } from 'hono';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager, User } from '@archon/core';
import { SSEStreamingApi } from 'hono/streaming';
import { WebAdapter } from '../adapters/web';
import { MessagePersistence } from '../adapters/web/persistence';
import { WorkflowEventBridge } from '../adapters/web/workflow-bridge';
import { DASHBOARD_STREAM, SSETransport } from '../adapters/web/transport';
import { DASHBOARD_SSE_PATH } from '../../../web/src/experiments/console/lib/sse-endpoints';
import { validationErrorHook } from './openapi-defaults';
import { makeListDashboardRunsMock, mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must precede the dynamic import of ./api below.
// Covers: GET /api/auth/status (enabled/disabled shape) and the non-enforcing
// ?mine filter on the runs + conversations list endpoints (session-first, then
// the X-Archon-User header, threaded into the DB query as a userId filter).
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
let authEnabled = false;
let signupMode: 'allowlist' | 'open' | 'disabled' = 'disabled';
let apiGateEnabled = false;
let authInstance: { api: { getSession: (args: unknown) => Promise<unknown> } } | null = null;

mock.module('../auth', () => ({
  getAuth: () => authInstance,
  isWebAuthEnabled: () => authEnabled,
  getSignupMode: () => signupMode,
  isApiGateEnabled: () => apiGateEnabled,
}));

// --- Identity resolution ---
const mockFindOrCreateUser = mock(
  async (_platform: string, platformUserId: string, _displayName?: string): Promise<User> => ({
    id: `user-from-${platformUserId}`,
    display_name: null,
    email: null,
    role: 'admin',
    created_at: new Date(),
    updated_at: new Date(),
  })
);

mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
}));

// --- List endpoints we assert the filter threading on ---
const mockListWorkflowRuns = mock(async (_opts?: { userId?: string }) => [] as unknown[]);
const mockListConversations = mock(
  async (
    _limit?: number,
    _platform?: string,
    _codebaseId?: string,
    _excludeEmpty?: boolean,
    _userId?: string
  ) => [] as unknown[]
);

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'postgresql',
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

mock.module('@archon/core/db/conversations', () => ({
  listConversations: mockListConversations,
  findConversationByPlatformId: mock(async () => null),
  getOrCreateConversation: mock(async () => ({ id: 'c', platform_conversation_id: 'web-x' })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
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
  listWorkflowRuns: mockListWorkflowRuns,
  listDashboardRuns: makeListDashboardRunsMock(),
  getWorkflowRun: mock(async () => null),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
  createWorkflowEvent: mock(async () => {}),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({ id: 'm' })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findCommandFiles: mock(async () => []),
}));

import {
  registerApiRoutes,
  resolveAuthContext,
  resolveWebUserId,
  resolveRunActor,
  requireWebUser,
} from './api';

function makeApp(
  webAdapter?: WebAdapter,
  app = new OpenAPIHono({ defaultHook: validationErrorHook })
): OpenAPIHono {
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
    getStats: mock(() => ({
      active: 0,
      queuedTotal: 0,
      queuedByConversation: [] as { conversationId: string; queuedMessages: number }[],
      maxConcurrent: 10,
      activeConversationIds: [] as string[],
    })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, webAdapter ?? mockWebAdapter, mockLockManager);
  return app;
}

describe('console dashboard SSE endpoint and disconnect lifecycle', () => {
  for (const cleanup of ['abort', 'finally'] as const) {
    test(`${cleanup} removes only the disconnected dashboard connection`, async () => {
      apiGateEnabled = false;
      const transport = new SSETransport();
      const adapter = new WebAdapter(
        transport,
        new MessagePersistence((id, event) => transport.emit(id, event)),
        new WorkflowEventBridge(transport)
      );
      const sleepers = new Map<SSEStreamingApi, (reason: Error) => void>();
      // Control the heartbeat wait so both cleanup paths run without a 30-second timer.
      const sleep = spyOn(SSEStreamingApi.prototype, 'sleep').mockImplementation(function (
        this: SSEStreamingApi
      ) {
        return new Promise<void>((_resolve, reject) => sleepers.set(this, reject));
      });
      const readers: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel'>[] = [];
      const decoder = new TextDecoder();
      try {
        const app = new OpenAPIHono({ defaultHook: validationErrorHook });
        app.use('*', async (c, next) => {
          await next();
          c.header('X-Test-Route', c.req.routePath);
        });
        makeApp(adapter, app);
        for (let i = 0; i < 2; i++) {
          const response = await app.request(DASHBOARD_SSE_PATH);
          expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toBe('text/event-stream');
          expect(response.headers.get('X-Test-Route')).toBe(DASHBOARD_SSE_PATH);
          if (!response.body) throw new Error('Missing SSE response body');
          const reader = response.body.getReader();
          readers.push(reader);
          expect(decoder.decode((await reader.read()).value)).toContain('"heartbeat"');
        }
        const [first, second] = readers;
        if (!first || !second) throw new Error('Missing dashboard readers');
        const broadcast = adapter.emitSSE(DASHBOARD_STREAM, 'first event');
        const frames = await Promise.all([first.read(), second.read()]);
        await broadcast;
        expect(frames.map(frame => decoder.decode(frame.value))).toEqual([
          'data: first event\n\n',
          'data: first event\n\n',
        ]);
        const firstSleeper = sleepers.values().next().value;
        if (!firstSleeper) throw new Error('Heartbeat wait was not reached');
        if (cleanup === 'abort') {
          await first.cancel();
        } else {
          firstSleeper(new Error('closed'));
          expect((await first.read()).done).toBe(true);
        }
        expect(transport.hasActiveStream(DASHBOARD_STREAM)).toBe(true);
        const nextBroadcast = adapter.emitSSE(DASHBOARD_STREAM, 'second event');
        expect(decoder.decode((await second.read()).value)).toBe('data: second event\n\n');
        await nextBroadcast;
        if (cleanup === 'abort') {
          firstSleeper(new Error('aborted'));
          await first.read();
        }
        expect(transport.hasActiveStream(DASHBOARD_STREAM)).toBe(true);
        await second.cancel();
        expect(transport.hasActiveStream(DASHBOARD_STREAM)).toBe(false);
      } finally {
        await Promise.all(readers.map(reader => reader.cancel()));
        for (const reject of sleepers.values()) reject(new Error('closed'));
        sleep.mockRestore();
        transport.stop();
      }
    });
  }
});

describe('GET /api/auth/status', () => {
  beforeEach(() => {
    authEnabled = false;
    // `disabled` is the real default posture (no allowlist + no open-signup flag).
    signupMode = 'disabled';
    authInstance = null;
  });

  test('auth disabled → { enabled: false, signup: disabled }', async () => {
    const app = makeApp();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, signup: 'disabled' });
  });

  test('enabled + no allowlist → { enabled: true, signup: disabled } (safe default)', async () => {
    authEnabled = true;
    const app = makeApp();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, signup: 'disabled' });
  });

  test('enabled + allowlist → { enabled: true, signup: allowlist }', async () => {
    authEnabled = true;
    signupMode = 'allowlist';
    const app = makeApp();
    const res = await app.request('/api/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, signup: 'allowlist' });
  });
});

describe('server-side /api/* gate', () => {
  beforeEach(() => {
    authEnabled = false;
    apiGateEnabled = false;
    authInstance = null;
    mockFindOrCreateUser.mockClear();
  });
  afterEach(() => {
    apiGateEnabled = false; // don't leak the gate into other describes
  });

  test('gate off (default) → /api/conversations is reachable unauthenticated', async () => {
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(200);
  });

  test('gate on + no identity → 401 on a protected /api route', async () => {
    apiGateEnabled = true;
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(401);
  });

  test('gate on → /api/auth/status stays public (login surface allowlisted)', async () => {
    apiGateEnabled = true;
    authEnabled = true;
    const res = await makeApp().request('/api/auth/status');
    expect(res.status).toBe(200);
  });

  test('gate on → /api/health is never blocked by the gate (healthcheck allowlist)', async () => {
    apiGateEnabled = true;
    const res = await makeApp().request('/api/health');
    expect(res.status).toBe(200);
  });

  test('gate on + Better Auth session → protected route passes', async () => {
    apiGateEnabled = true;
    authEnabled = true;
    authInstance = {
      api: { getSession: async () => ({ user: { id: 'sess-1', name: 'A', email: 'a@x.io' } }) },
    };
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(200);
  });

  test('gate on + X-Archon-User header → protected route passes', async () => {
    apiGateEnabled = true;
    const res = await makeApp().request('/api/conversations', {
      headers: { 'X-Archon-User': 'alice' },
    });
    expect(res.status).toBe(200);
  });

  // Fail-closed: a session lookup that throws (e.g. DB outage) with NO trusted
  // header must NOT admit the request. resolveAuthContext swallows the throw and
  // returns undefined, which the gate maps to 401 — never access-granted.
  test('gate on + session lookup throws + no header → 401 (fails closed)', async () => {
    apiGateEnabled = true;
    authEnabled = true;
    authInstance = {
      api: {
        getSession: async () => {
          throw new Error('PG connection refused');
        },
      },
    };
    const res = await makeApp().request('/api/conversations');
    expect(res.status).toBe(401);
  });
});

describe('?mine filter — non-enforcing', () => {
  beforeEach(() => {
    authEnabled = false;
    signupMode = 'open';
    authInstance = null;
    mockListWorkflowRuns.mockClear();
    mockListConversations.mockClear();
    mockFindOrCreateUser.mockClear();
  });

  test('runs: no ?mine → listWorkflowRuns called without a userId filter', async () => {
    const app = makeApp();
    const res = await app.request('/api/workflows/runs');
    expect(res.status).toBe(200);
    const opts = mockListWorkflowRuns.mock.calls[0]?.[0];
    expect(opts?.userId).toBeUndefined();
  });

  test('runs: ?mine=true with X-Archon-User header → filters by resolved userId', async () => {
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      headers: { 'X-Archon-User': 'alice' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'alice', 'alice');
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-alice');
  });

  test('runs: ?mine=true with a Better Auth session → session wins over header', async () => {
    authEnabled = true;
    authInstance = {
      api: {
        getSession: async () => ({ user: { id: 'sess-1', name: 'Sessioned', email: 's@x.io' } }),
      },
    };
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      // header present too — session must take precedence
      headers: { 'X-Archon-User': 'header-user' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'sess-1', 'Sessioned');
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-sess-1');
  });

  test('conversations: no ?mine → listConversations called without a userId filter', async () => {
    const app = makeApp();
    const res = await app.request('/api/conversations');
    expect(res.status).toBe(200);
    // listConversations(limit, platform, codebaseId, excludeEmpty, userId)
    expect(mockListConversations.mock.calls[0]?.[4]).toBeUndefined();
  });

  test('conversations: ?mine=true with X-Archon-User header → filters by userId', async () => {
    const app = makeApp();
    const res = await app.request('/api/conversations?mine=true', {
      headers: { 'X-Archon-User': 'bob' },
    });
    expect(res.status).toBe(200);
    expect(mockListConversations.mock.calls[0]?.[4]).toBe('user-from-bob');
  });

  // The headline guarantee of this PR: ?mine is non-enforcing. With no
  // resolvable identity (no session, no header) it must degrade to listing
  // everything — NOT to an empty/zero-result gate.
  test('runs: ?mine=true with no identity → still returns all (no userId filter)', async () => {
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true');
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBeUndefined();
  });

  test('conversations: ?mine=true with no identity → still returns all (no userId filter)', async () => {
    const app = makeApp();
    const res = await app.request('/api/conversations?mine=true');
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(mockListConversations.mock.calls[0]?.[4]).toBeUndefined();
  });

  // Resilience: a Better Auth session lookup that throws (e.g. DB outage) must
  // fall through to the trusted proxy header rather than dropping attribution.
  test('runs: ?mine=true — session lookup throws → falls through to header', async () => {
    authEnabled = true;
    authInstance = {
      api: {
        getSession: async () => {
          throw new Error('PG connection refused');
        },
      },
    };
    const app = makeApp();
    const res = await app.request('/api/workflows/runs?mine=true', {
      headers: { 'X-Archon-User': 'fallback-user' },
    });
    expect(res.status).toBe(200);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'fallback-user', 'fallback-user');
    expect(mockListWorkflowRuns.mock.calls[0]?.[0]?.userId).toBe('user-from-fallback-user');
  });
});

describe('per-request auth helpers', () => {
  async function request(headers?: RequestInit['headers']): Promise<Context> {
    let context: Context | undefined;
    const app = new Hono();
    app.get('/api/auth/providers', c => {
      context = c;
      return c.text('');
    });
    await app.request('/api/auth/providers', { headers });
    if (!context) throw new Error('Request did not reach the test handler');
    return context;
  }
  const originalHeader = process.env.ARCHON_WEB_AUTH_HEADER;

  beforeEach(() => {
    authEnabled = false;
    authInstance = null;
    delete process.env.ARCHON_WEB_AUTH_HEADER;
    mockFindOrCreateUser.mockClear();
  });

  afterEach(() => {
    if (originalHeader === undefined) delete process.env.ARCHON_WEB_AUTH_HEADER;
    else process.env.ARCHON_WEB_AUTH_HEADER = originalHeader;
  });

  test('run actor uses session identity before proxy identity', async () => {
    authEnabled = true;
    authInstance = { api: { getSession: async () => ({ user: { id: 'session-user' } }) } };
    expect(await resolveRunActor(await request({ 'X-Archon-User': 'proxy-user' }))).toEqual({
      kind: 'user',
      userId: 'user-from-session-user',
    });
  });

  test('run actor uses a proxy identity with web auth off', async () => {
    expect(await resolveRunActor(await request({ 'X-Archon-User': 'proxy-user' }))).toEqual({
      kind: 'user',
      userId: 'user-from-proxy-user',
    });
  });

  for (const enabled of [false, true]) {
    test(`no identity with web auth ${enabled ? 'enabled' : 'disabled'} preserves unattributed requests`, async () => {
      authEnabled = enabled;
      if (enabled) authInstance = { api: { getSession: async () => null } };
      const c = await request();
      expect(await resolveAuthContext(c)).toBeUndefined();
      expect(await resolveWebUserId(c)).toBeUndefined();
      expect(await resolveRunActor(c)).toEqual({ kind: enabled ? 'unidentified' : 'operator' });
      const result = await requireWebUser(c, 'Login to manage keys');
      expect(result).toHaveProperty('error');
      if (!('error' in result)) throw new Error('Expected authentication refusal');
      expect(result.error.status).toBe(401);
      expect(await result.error.json()).toEqual({ error: 'Login to manage keys' });
      expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    });
  }

  test('session identity wins over a conflicting header for all three helpers', async () => {
    authEnabled = true;
    const getSession = mock(async (_args: unknown) => ({
      user: { id: 'session-user', name: 'Session Name', email: 'session@example.test' },
    }));
    authInstance = { api: { getSession } };
    const c = await request({ 'X-Archon-User': 'another-user', Cookie: 'session=test' });
    const expected = { userId: 'user-from-session-user', role: 'admin' as const };
    expect(await resolveAuthContext(c)).toEqual(expected);
    expect(await resolveWebUserId(c)).toBe(expected.userId);
    expect(await requireWebUser(c)).toEqual(expected);
    expect(getSession).toHaveBeenCalledWith({ headers: c.req.raw.headers });
    expect(mockFindOrCreateUser.mock.calls).toEqual([
      ['web', 'session-user', 'Session Name'],
      ['web', 'session-user', 'Session Name'],
      ['web', 'session-user', 'Session Name'],
    ]);
  });

  test('configured proxy header is trimmed and works without Better Auth', async () => {
    process.env.ARCHON_WEB_AUTH_HEADER = 'X-Trusted-User';
    const c = await request({ 'X-Trusted-User': '  proxy-user  ', 'X-Archon-User': 'ignored' });
    const expected = { userId: 'user-from-proxy-user', role: 'admin' as const };
    expect(await resolveAuthContext(c)).toEqual(expected);
    expect(await resolveWebUserId(c)).toBe(expected.userId);
    expect(await requireWebUser(c)).toEqual(expected);
    expect(mockFindOrCreateUser).toHaveBeenCalledWith('web', 'proxy-user', 'proxy-user');
    expect(await resolveAuthContext(await request({ 'X-Trusted-User': '   ' }))).toBeUndefined();
  });

  test('missing Better Auth session falls back to the trusted proxy for all three helpers', async () => {
    authEnabled = true;
    const getSession = mock(async (_args: unknown) => null);
    authInstance = { api: { getSession } };
    process.env.ARCHON_WEB_AUTH_HEADER = 'X-Trusted-User';
    const c = await request({ 'X-Trusted-User': 'proxy-user', 'X-Archon-User': 'ignored' });
    const expected = { userId: 'user-from-proxy-user', role: 'admin' as const };
    expect(await resolveAuthContext(c)).toEqual(expected);
    expect(await resolveWebUserId(c)).toBe(expected.userId);
    expect(await requireWebUser(c)).toEqual(expected);
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(getSession).toHaveBeenCalledWith({ headers: c.req.raw.headers });
    expect(mockFindOrCreateUser.mock.calls).toEqual([
      ['web', 'proxy-user', 'proxy-user'],
      ['web', 'proxy-user', 'proxy-user'],
      ['web', 'proxy-user', 'proxy-user'],
    ]);
  });

  test('session outage permits soft proxy attribution but strict identity returns 503', async () => {
    authInstance = {
      api: {
        getSession: async () => {
          throw new Error('session unavailable');
        },
      },
    };
    const c = await request({ 'X-Archon-User': 'proxy-user' });
    expect(await resolveAuthContext(c)).toEqual({ userId: 'user-from-proxy-user', role: 'admin' });
    expect(await resolveWebUserId(c)).toBe('user-from-proxy-user');
    mockFindOrCreateUser.mockClear();
    const result = await requireWebUser(c);
    if (!('error' in result)) throw new Error('Expected backend refusal');
    expect(result.error.status).toBe(503);
    expect(await result.error.json()).toEqual({
      error: 'Could not verify session — backend unavailable',
    });
    expect(mockFindOrCreateUser).not.toHaveBeenCalled();
    expect(await resolveAuthContext(await request())).toBeUndefined();
    expect(await resolveWebUserId(await request())).toBeUndefined();
  });

  for (const source of ['session', 'header']) {
    test(`${source} identity storage outage is unattributed for soft helpers and 503 for strict`, async () => {
      if (source === 'session')
        authInstance = { api: { getSession: async () => ({ user: { id: 'session-user' } }) } };
      const c = await request(source === 'header' ? { 'X-Archon-User': 'proxy-user' } : undefined);
      mockFindOrCreateUser.mockRejectedValueOnce(new Error('identity unavailable'));
      expect(await resolveAuthContext(c)).toBeUndefined();
      mockFindOrCreateUser.mockRejectedValueOnce(new Error('identity unavailable'));
      expect(await resolveWebUserId(c)).toBeUndefined();
      mockFindOrCreateUser.mockRejectedValueOnce(new Error('identity unavailable'));
      const result = await requireWebUser(c);
      if (!('error' in result)) throw new Error('Expected backend refusal');
      expect(result.error.status).toBe(503);
      expect(await result.error.json()).toEqual({
        error: 'Could not verify web identity — backend unavailable',
      });
    });
  }
});

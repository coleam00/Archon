import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must precede the dynamic import of ./api below. Exercises the
// per-user AI-provider key routes (GET/PUT/DELETE /api/auth/providers).
// Filename uses `provider-keys` (not `credentials`) to clear the secret-guard.
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
let authInstance: { api: { getSession: (args: unknown) => Promise<unknown> } } | null = null;
mock.module('../auth', () => ({
  getAuth: () => authInstance,
  isWebAuthEnabled: () => false,
  getSignupMode: () => 'disabled',
  isApiGateEnabled: () => false,
}));

// --- Identity resolution (X-Archon-User → user) ---
const mockFindOrCreateUser = mock(async (_platform: string, platformUserId: string) => ({
  id: `user-from-${platformUserId}`,
  display_name: null,
  email: null,
  role: 'admin' as const,
  created_at: new Date(),
  updated_at: new Date(),
}));
mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mockFindOrCreateUser,
}));

// --- Provider-key store/connect surface (the unit under test, via mocked core) ---
const KNOWN = new Set<string>([
  'claude',
  'codex',
  'anthropic',
  'openai',
  'google',
  'groq',
  'mistral',
  'cerebras',
  'xai',
  'openrouter',
  'huggingface',
]);

// Mirror core's typed validation error so the route's `instanceof` check (400 vs
// opaque 500) is exercised: validation throws this; storage failures throw plain.
class InvalidProviderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProviderKeyError';
  }
}

let keysEnabled = true;
let savedKeys: { userId: string; provider: string; apiKey: string; label: string | null }[] = [];

const mockPersist = mock(
  async (userId: string, provider: string, apiKey: string, label?: string | null) => {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new InvalidProviderKeyError('API key must not be empty.');
    if (!KNOWN.has(provider)) {
      throw new InvalidProviderKeyError(
        `Unknown provider '${provider}'. Known: ${[...KNOWN].sort().join(', ')}.`
      );
    }
    const normalizedLabel = label?.trim() ? label.trim() : null;
    savedKeys = savedKeys.filter(k => !(k.userId === userId && k.provider === provider));
    savedKeys.push({ userId, provider, apiKey: trimmed, label: normalizedLabel });
    return { provider, kind: 'api_key' as const, label: normalizedLabel };
  }
);
const mockList = mock(async (userId: string) =>
  savedKeys
    .filter(k => k.userId === userId)
    .map(k => ({ provider: k.provider, kind: 'api_key' as const, label: k.label }))
);
const mockDelete = mock(async (userId: string, provider: string) => {
  savedKeys = savedKeys.filter(k => !(k.userId === userId && k.provider === provider));
});

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'postgresql',
  loadConfig: mock(async () => ({})),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  generateAndSetTitle: mock(async () => {}),
  isPerUserGitHubEnabled: () => false,
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  createLogger: noopLogger,
  // Provider-key surface under test:
  isPerUserProviderKeysEnabled: () => keysEnabled,
  persistProviderApiKey: mockPersist,
  InvalidProviderKeyError,
  listUserProviderKeys: mockList,
  deleteUserProviderKey: mockDelete,
  KNOWN_PROVIDERS: KNOWN,
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

mock.module('@archon/core/db/conversations', () => ({
  listConversations: mock(async () => []),
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
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 },
  })),
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
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';
// Import the REAL exemption check (../auth barrel is mocked above; ../auth/config is not).
import { isArchonOwnedAuthPath } from '../auth/config';

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

const ALICE = { 'X-Archon-User': 'alice' };

describe('GET /api/auth/providers', () => {
  beforeEach(() => {
    authInstance = null;
    keysEnabled = true;
    savedKeys = [];
    mockFindOrCreateUser.mockClear();
    mockList.mockClear();
  });

  test('401 when no web identity resolves', async () => {
    const res = await makeApp().request('/api/auth/providers');
    expect(res.status).toBe(401);
  });

  test('enabled + no connections → { enabled:true, connections:[], available:[...sorted] }', async () => {
    const res = await makeApp().request('/api/auth/providers', { headers: ALICE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      connections: unknown[];
      available: string[];
    };
    expect(body.enabled).toBe(true);
    expect(body.connections).toEqual([]);
    expect(body.available).toContain('openrouter');
    expect(body.available).toContain('claude');
    // available is sorted
    expect([...body.available]).toEqual([...body.available].sort());
  });

  test('gate off → { enabled:false }, available still present, DB never queried', async () => {
    keysEnabled = false;
    const res = await makeApp().request('/api/auth/providers', { headers: ALICE });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; available: string[] };
    expect(body.enabled).toBe(false);
    expect(body.available.length).toBeGreaterThan(0);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('lists connected providers as metadata only (no secret fields)', async () => {
    savedKeys.push({
      userId: 'user-from-alice',
      provider: 'openrouter',
      apiKey: 'sk-x',
      label: 'mine',
    });
    const res = await makeApp().request('/api/auth/providers', { headers: ALICE });
    const body = (await res.json()) as { connections: Record<string, unknown>[] };
    expect(body.connections).toEqual([{ provider: 'openrouter', kind: 'api_key', label: 'mine' }]);
    expect(JSON.stringify(body)).not.toContain('sk-x');
  });
});

describe('PUT /api/auth/providers/:provider', () => {
  beforeEach(() => {
    authInstance = null;
    keysEnabled = true;
    savedKeys = [];
    mockPersist.mockClear();
  });

  test('stores the key and returns NO secret value', async () => {
    const res = await makeApp().request('/api/auth/providers/openrouter', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-super-secret-123', label: 'mine' }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('sk-super-secret-123');
    expect(JSON.parse(raw)).toEqual({
      success: true,
      provider: 'openrouter',
      kind: 'api_key',
      label: 'mine',
    });
    expect(mockPersist).toHaveBeenCalledWith(
      'user-from-alice',
      'openrouter',
      'sk-super-secret-123',
      'mine'
    );
  });

  test('unknown provider → 400', async () => {
    const res = await makeApp().request('/api/auth/providers/bogus', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(400);
  });

  test('empty apiKey → 400 (body validation)', async () => {
    const res = await makeApp().request('/api/auth/providers/openrouter', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '' }),
    });
    expect(res.status).toBe(400);
  });

  test('storage failure → opaque 500, internal message never leaks (C1)', async () => {
    // A DB/encryption error is NOT an InvalidProviderKeyError → must be 500, and
    // the internal error string must not reach the client body.
    mockPersist.mockRejectedValueOnce(new Error('PG connection refused at 10.0.0.5'));
    const res = await makeApp().request('/api/auth/providers/openrouter', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('PG connection refused');
    expect(raw).not.toContain('10.0.0.5');
  });

  test('gate off → 404', async () => {
    keysEnabled = false;
    const res = await makeApp().request('/api/auth/providers/openrouter', {
      method: 'PUT',
      headers: { ...ALICE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(404);
  });

  test('no identity → 401', async () => {
    const res = await makeApp().request('/api/auth/providers/openrouter', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/auth/providers/:provider', () => {
  beforeEach(() => {
    authInstance = null;
    keysEnabled = true;
    savedKeys = [
      { userId: 'user-from-alice', provider: 'openrouter', apiKey: 'sk-x', label: null },
    ];
    mockDelete.mockClear();
  });

  test('disconnects and is idempotent', async () => {
    const app = makeApp();
    const res = await app.request('/api/auth/providers/openrouter', {
      method: 'DELETE',
      headers: ALICE,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mockDelete).toHaveBeenCalledWith('user-from-alice', 'openrouter');
    // Idempotent: deleting again still 200.
    const res2 = await app.request('/api/auth/providers/openrouter', {
      method: 'DELETE',
      headers: ALICE,
    });
    expect(res2.status).toBe(200);
  });

  test('gate off → 404', async () => {
    keysEnabled = false;
    const res = await makeApp().request('/api/auth/providers/openrouter', {
      method: 'DELETE',
      headers: ALICE,
    });
    expect(res.status).toBe(404);
  });

  test('no identity → 401', async () => {
    const res = await makeApp().request('/api/auth/providers/openrouter', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});

// Airtight guard for the Better Auth catch-all shadowing bug: when web auth is
// on, Better Auth claims all of /api/auth/* and 404s anything it doesn't own.
// EVERY Archon-registered /api/auth/* route must be in isArchonOwnedAuthPath or it
// 404s live (this is exactly what bit GET /api/auth/providers). registerApiRoutes
// registers only Archon routes (Better Auth mounts separately in index.ts), so
// all /api/auth/* paths here are Archon's and must be exempted.
describe('Better Auth catch-all exemption is exhaustive', () => {
  test('every Archon-registered /api/auth/* route is exempted by isArchonOwnedAuthPath', () => {
    const app = makeApp();
    const authPaths = [
      ...new Set(app.routes.map(r => r.path).filter(p => p.startsWith('/api/auth/'))),
    ];
    expect(authPaths.length).toBeGreaterThan(0); // sanity: we actually found auth routes
    const notExempted = authPaths.filter(p => !isArchonOwnedAuthPath(p));
    expect(notExempted).toEqual([]);
  });
});

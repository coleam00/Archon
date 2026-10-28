import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { makeIdleLockStats } from '../test/conversation-lock-fixtures';
import {
  makeDiscoverWorkflowsMock,
  makeLoaderMock,
  makeCommandValidationMock,
  makeListDashboardRunsMock,
} from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports
// ---------------------------------------------------------------------------

type TestConfig = {
  assistants?: { claude: { model: string } };
  worktree?: { baseBranch: string };
  concurrency?: { maxConversations: number };
};

const mockLoadConfig = mock<(_repoPath?: string) => Promise<TestConfig>>(async () => ({
  assistants: { claude: { model: 'sonnet' } },
  worktree: { baseBranch: 'main' },
}));
const mockGetDatabaseType = mock<() => 'postgresql' | 'sqlite'>(() => 'sqlite');
const mockGetSchemaVersion = mock(async () => ({
  createdAppVersion: '0.5.3' as string | null,
  appVersion: '0.6.0',
  createdAt: '2026-01-01T00:00:00.000Z' as string | null,
  appliedAt: '2026-07-01T00:00:00.000Z' as string | null,
}));
const mockIsDocker = mock(() => false);
const mockIsWSL = mock(() => false);
const mockGetWSLDistroName = mock((): string | undefined => undefined);
const mockGetStats = mock(() => ({ ...makeIdleLockStats(), active: 1, queuedTotal: 2 }));

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: mockGetDatabaseType,
  getSchemaVersion: mockGetSchemaVersion,
  loadConfig: mockLoadConfig,
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
  toSafeConfig: (config: unknown) => config,
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
  isDocker: mockIsDocker,
  isWSL: mockIsWSL,
  getWSLDistroName: mockGetWSLDistroName,
}));

const STORE_ID = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7';
const mockReadStoreId = mock((): string | null => STORE_ID);
const realServerDiscovery = { ...(await import('@archon/paths/server-discovery')) };
mock.module('@archon/paths/server-discovery', () => ({
  ...realServerDiscovery,
  readStoreId: mockReadStoreId,
}));

mock.module('@archon/workflows/workflow-discovery', makeDiscoverWorkflowsMock);
mock.module('@archon/workflows/loader', makeLoaderMock);
mock.module('@archon/workflows/command-validation', makeCommandValidationMock);
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));

mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
}));

mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
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

const mockGetRunningWorkflows = mock<
  typeof import('@archon/core/db/workflows')['getRunningWorkflows']
>(async () => []);

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: makeListDashboardRunsMock(),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getRunningWorkflows: mockGetRunningWorkflows,
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user',
    content: 'hi',
    metadata: '{}',
    created_at: new Date().toISOString(),
  })),
  listMessages: mock(async () => []),
}));

import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00.000Z';

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono();
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
    getStats: mockGetStats,
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/health
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  beforeEach(() => {
    mockGetStats.mockReset();
    mockGetRunningWorkflows.mockReset();
    mockIsDocker.mockClear(); // preserve base () => false implementation; only clear call records
    mockIsWSL.mockClear();
    mockGetWSLDistroName.mockClear();
    mockGetSchemaVersion.mockClear();
  });

  test('returns status ok with adapter and concurrency info', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      ...makeIdleLockStats(),
      queuedTotal: 2,
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => [
      { id: 'run-1', conversation_id: 'conv-1', workflow_name: 'assist', started_at: '2026-01-01' },
    ]);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const text = await response.text();
    const body = JSON.parse(text) as {
      status: string;
      adapter: string;
      concurrency: Record<string, unknown>;
      runningWorkflows: number;
      version: string;
    };
    expect(body.status).toBe('ok');
    expect(body.adapter).toBe('web');
    expect(body.concurrency).toEqual({
      active: 1,
      queuedTotal: 2,
      maxConcurrent: 10,
      oldestActiveAgeMs: null,
      oldestQueuedAgeMs: null,
    });
    // Health is public: conversation ids stay behind /api/dashboard/conversations.
    expect(text).not.toContain('conv-1');
    expect(body.runningWorkflows).toBe(1);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  // Schema vintage (#2316): a bug report needs to be able to state which build
  // created this database and which last applied schema to it.
  test('reports the schema vintage', async () => {
    mockGetStats.mockImplementationOnce(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      schema?: { createdAppVersion: string | null; appVersion: string; appliedAt: string | null };
    };
    expect(body.schema).toEqual({
      createdAppVersion: '0.5.3',
      appVersion: '0.6.0',
      appliedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  test('reports a null creation vintage rather than omitting it', async () => {
    mockGetStats.mockImplementationOnce(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);

    mockGetSchemaVersion.mockImplementationOnce(async () => ({
      createdAppVersion: null,
      appVersion: '0.6.0',
      createdAt: null,
      appliedAt: null,
    }));

    const app = makeApp();
    const body = (await (await app.request('/api/health')).json()) as {
      schema?: { createdAppVersion: string | null };
    };
    expect(body.schema).toBeDefined();
    expect(body.schema?.createdAppVersion).toBeNull();
  });

  test("reports its home's store id, and omits it when the home has none", async () => {
    mockGetStats.mockImplementation(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementation(async () => []);
    const app = makeApp();

    const withId = (await (await app.request('/api/health')).json()) as { storeId?: string };
    expect(withId.storeId).toBe(STORE_ID);

    mockReadStoreId.mockImplementationOnce(() => null);
    const missing = await app.request('/api/health');
    expect(missing.status).toBe(200);
    expect(((await missing.json()) as { storeId?: string }).storeId).toBeUndefined();

    mockReadStoreId.mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    const unreadable = await app.request('/api/health');
    expect(unreadable.status).toBe(200);
    expect(((await unreadable.json()) as { storeId?: string }).storeId).toBeUndefined();
  });

  test('omits schema and still answers 200 when the vintage read fails', async () => {
    mockGetStats.mockImplementationOnce(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);

    mockGetSchemaVersion.mockImplementationOnce(async () => {
      throw new Error('no such table: remote_agent_schema_version');
    });

    const app = makeApp();
    const response = await app.request('/api/health');
    // Health is public and must stay answerable when the DB is degraded.
    expect(response.status).toBe(200);

    const body = (await response.json()) as { status: string; schema?: unknown };
    expect(body.status).toBe('ok');
    expect(body.schema).toBeUndefined();
  });

  test('includes running background workflows in concurrency.active count', async () => {
    mockGetStats.mockImplementationOnce(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementationOnce(async () => [
      { id: 'run-1', conversation_id: 'conv-1', workflow_name: 'assist', started_at: '2026-01-01' },
      { id: 'run-2', conversation_id: 'conv-2', workflow_name: 'plan', started_at: '2026-01-01' },
      { id: 'run-local', conversation_id: null, workflow_name: 'local', started_at: '2026-01-01' },
    ]);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      concurrency: { active: number };
      runningWorkflows: number;
    };
    expect(body.concurrency.active).toBe(2);
    expect(body.runningWorkflows).toBe(3);
  });

  test('deduplicates conversation IDs tracked by both lock manager and DB', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      ...makeIdleLockStats(),
      active: 1,
      activeConversations: [{ conversationId: 'conv-1', acquiredAt: T0, ageMs: 1_000 }],
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => [
      { id: 'run-1', conversation_id: 'conv-1', workflow_name: 'assist', started_at: '2026-01-01' },
    ]);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { concurrency: { active: number } };
    // Should NOT double-count conv-1
    expect(body.concurrency.active).toBe(1);
  });

  test('combines lock manager and background workflow counts', async () => {
    mockGetStats.mockImplementationOnce(() => ({
      ...makeIdleLockStats(),
      active: 1,
      queuedTotal: 3,
      activeConversations: [{ conversationId: 'conv-1', acquiredAt: T0, ageMs: 2_220_000 }],
      queuedConversations: [
        { conversationId: 'conv-3', queuedMessages: 2, oldestEnqueuedAt: T0, oldestAgeMs: 60_000 },
        { conversationId: 'conv-4', queuedMessages: 1, oldestEnqueuedAt: T0, oldestAgeMs: 5_000 },
      ],
    }));
    mockGetRunningWorkflows.mockImplementationOnce(async () => [
      { id: 'run-2', conversation_id: 'conv-2', workflow_name: 'plan', started_at: '2026-01-01' },
    ]);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const text = await response.text();
    const body = JSON.parse(text) as {
      status: string;
      concurrency: Record<string, unknown>;
      runningWorkflows: number;
    };
    // A 37-minute-old slot is reported as an age; it does not change status.
    expect(body.status).toBe('ok');
    expect(body.concurrency).toEqual({
      active: 2,
      queuedTotal: 3,
      maxConcurrent: 10,
      oldestActiveAgeMs: 2_220_000,
      oldestQueuedAgeMs: 60_000,
    });
    expect(body.runningWorkflows).toBe(1);
    expect(text).not.toMatch(/conv-\d/);
  });

  test('GET /api/dashboard/conversations returns the per-conversation snapshot', async () => {
    const snapshot = {
      ...makeIdleLockStats(),
      active: 1,
      queuedTotal: 1,
      activeConversations: [{ conversationId: 'conv-1', acquiredAt: T0, ageMs: 2_220_000 }],
      queuedConversations: [
        { conversationId: 'conv-2', queuedMessages: 1, oldestEnqueuedAt: T0, oldestAgeMs: 60_000 },
      ],
    };
    mockGetStats.mockImplementationOnce(() => snapshot);

    const response = await makeApp().request('/api/dashboard/conversations');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
  });

  test('returns 200 without any auth requirements', async () => {
    mockGetStats.mockImplementationOnce(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
  });

  test('includes is_docker: false in non-Docker environment', async () => {
    mockGetStats.mockImplementationOnce(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);
    mockIsDocker.mockReturnValueOnce(false);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { is_docker: boolean };
    expect(body.is_docker).toBe(false);
  });

  test('includes is_docker: true in Docker environment', async () => {
    mockGetStats.mockImplementationOnce(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);
    mockIsDocker.mockReturnValueOnce(true);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { is_docker: boolean };
    expect(body.is_docker).toBe(true);
  });

  test('includes is_wsl: false and omits wsl_distro in non-WSL environment', async () => {
    mockGetStats.mockImplementationOnce(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);
    mockIsWSL.mockReturnValueOnce(false);
    mockGetWSLDistroName.mockReturnValueOnce(undefined);

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { is_wsl: boolean; wsl_distro?: string };
    expect(body.is_wsl).toBe(false);
    expect('wsl_distro' in body).toBe(false);
  });

  test('includes is_wsl: true and wsl_distro in WSL environment', async () => {
    mockGetStats.mockImplementationOnce(makeIdleLockStats);
    mockGetRunningWorkflows.mockImplementationOnce(async () => []);
    mockIsWSL.mockReturnValueOnce(true);
    mockGetWSLDistroName.mockReturnValueOnce('Ubuntu');

    const app = makeApp();
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { is_wsl: boolean; wsl_distro?: string };
    expect(body.is_wsl).toBe(true);
    expect(body.wsl_distro).toBe('Ubuntu');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/config
// ---------------------------------------------------------------------------

describe('GET /api/config', () => {
  beforeEach(() => {
    mockLoadConfig.mockReset();
    mockGetDatabaseType.mockReset();
  });

  test('returns the loaded conversation limit and database type', async () => {
    mockLoadConfig.mockImplementationOnce(async () => ({
      assistants: { claude: { model: 'sonnet' } },
      concurrency: { maxConversations: 3 },
    }));
    mockGetDatabaseType.mockImplementationOnce(() => 'sqlite');

    const app = makeApp();
    const response = await app.request('/api/config');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      config: {
        assistants: { claude: { model: string } };
        concurrency: { maxConversations: number };
      };
      database: string;
    };
    expect(body.config).toBeDefined();
    expect(body.database).toBe('sqlite');
    expect(body.config.assistants.claude.model).toBe('sonnet');
    expect(body.config.concurrency.maxConversations).toBe(3);
  });

  test('reflects postgres database type when configured', async () => {
    mockLoadConfig.mockImplementationOnce(async () => ({}));
    mockGetDatabaseType.mockImplementationOnce(() => 'postgresql');

    const app = makeApp();
    const response = await app.request('/api/config');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { database: string };
    expect(body.database).toBe('postgresql');
  });

  test('returns 500 when loadConfig throws', async () => {
    mockLoadConfig.mockImplementationOnce(async () => {
      throw new Error('config file missing');
    });

    const app = makeApp();
    const response = await app.request('/api/config');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get config');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/openapi.json — guards @hono/zod-openapi spec generation
// (the v0 -> v1 / zod v4 upgrade is a major bump; this confirms every
// registered route's schema still serializes without throwing).
// ---------------------------------------------------------------------------

describe('GET /api/openapi.json', () => {
  test('generates a valid OpenAPI 3 document for all registered routes', async () => {
    const app = makeApp();
    const response = await app.request('/api/openapi.json');
    expect(response.status).toBe(200);

    const doc = (await response.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(typeof doc.info.title).toBe('string');
    // A representative sample of registered routes must be present, including
    // ones whose schemas use the patterns touched by the zod v4 migration
    // (z.record key types, z.string().datetime(), the node-sessions route).
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(doc.paths['/api/health']).toBeDefined();
    expect(doc.paths['/api/workflows/{name}/node-sessions']).toBeDefined();
    // The datetime-heavy, highest-traffic routes are the ones the zod-to-openapi
    // v7 -> v8 serialization change most threatens (z.string().datetime() fields
    // on conversation/codebase schemas). A route can register in `paths` while
    // its schema silently fails to serialize, so also assert the component
    // schemas those routes reference actually made it into the document.
    expect(doc.paths['/api/conversations']).toBeDefined();
    expect(doc.paths['/api/codebases']).toBeDefined();
    const schemas = doc.components?.schemas ?? {};
    expect(Object.keys(schemas).length).toBeGreaterThan(10);
    expect(schemas['Conversation']).toBeDefined();
    expect(schemas['Codebase']).toBeDefined();
    expect(schemas['WorkflowEvent']).toBeDefined();
    expect(schemas['DagNodeSseEvent']).toBeDefined();
    expect(schemas['NodeSkipReason']).toBeDefined();
    expect(schemas['SkipCause']).toBeDefined();
    // The WSL fields on /api/health are consumed by the generated web client
    // types — assert the schema actually exposes them.
    const health = schemas['HealthResponse'] as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    expect(health?.properties?.['is_wsl']).toBeDefined();
    expect(health?.properties?.['wsl_distro']).toBeDefined();
    expect(health?.required).toContain('is_wsl');
    expect(health?.required).not.toContain('wsl_distro');
    expect(health?.properties?.['storeId']).toBeDefined();
  });
});

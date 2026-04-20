import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import {
  makeDiscoverWorkflowsMock,
  makeLoaderMock,
  makeCommandValidationMock,
} from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be before dynamic imports
// ---------------------------------------------------------------------------

const mockLoadConfig = mock(async () => ({
  assistants: { claude: { model: 'sonnet' } },
  worktree: { baseBranch: 'main' },
}));
const mockGetDatabaseType = mock(() => 'sqlite' as const);

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: mockGetDatabaseType,
  loadConfig: mockLoadConfig,
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
  generateAndSetTitle: mock(async () => {}),
  updateGlobalConfig: mock(async () => {}),
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
  isDocker: mock(() => false),
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
  getOrCreateConversation: mock(async () => null),
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
  listByCodebaseWithAge: mock(async () => []),
  updateStatus: mock(async () => {}),
}));
mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: mock(async () => ({ runs: [], total: 0, counts: {} })),
  getWorkflowRun: mock(async () => null),
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getRunningWorkflows: mock(async () => []),
}));
mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));
mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => null),
  listMessages: mock(async () => []),
}));
mock.module('@archon/core/db/env-vars', () => ({
  getEnvVars: mock(async () => []),
  getEnvVarKeys: mock(async () => []),
  setEnvVar: mock(async () => {}),
  deleteEnvVar: mock(async () => {}),
}));
mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

// Bootstrap registry after mocks
clearRegistry();
registerBuiltinProviders();

import { registerApiRoutes } from './api';

type Hono = InstanceType<typeof OpenAPIHono>;

function makeApp(): Hono {
  const app = new OpenAPIHono();
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
      queuedByConversation: [],
      maxConcurrent: 10,
      activeConversationIds: [],
    })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/providers
// ---------------------------------------------------------------------------

describe('GET /api/providers', () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
  });

  test('returns 200 with provider list', async () => {
    const response = await app.request('/api/providers');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: unknown[] };
    expect(body.providers).toBeDefined();
    expect(Array.isArray(body.providers)).toBe(true);
  });

  test('includes built-in providers', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: { id: string; builtIn: boolean }[];
    };
    const ids = body.providers.map(p => p.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(body.providers.every(p => p.builtIn)).toBe(true);
  });

  test('returns correct shape per provider (no factory or isModelCompatible)', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: Record<string, unknown>[];
    };
    for (const provider of body.providers) {
      expect(provider).toHaveProperty('id');
      expect(provider).toHaveProperty('displayName');
      expect(provider).toHaveProperty('capabilities');
      expect(provider).toHaveProperty('builtIn');
      // Non-serializable fields must NOT leak
      expect(provider).not.toHaveProperty('factory');
      expect(provider).not.toHaveProperty('isModelCompatible');
    }
  });

  test('capabilities have expected boolean fields', async () => {
    const response = await app.request('/api/providers');
    const body = (await response.json()) as {
      providers: { capabilities: Record<string, boolean> }[];
    };
    const caps = body.providers[0].capabilities;
    expect(typeof caps.sessionResume).toBe('boolean');
    expect(typeof caps.mcp).toBe('boolean');
    expect(typeof caps.hooks).toBe('boolean');
    expect(typeof caps.structuredOutput).toBe('boolean');
  });
});

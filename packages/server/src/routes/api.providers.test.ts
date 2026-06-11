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
const mockUpdateGlobalConfig = mock(async (_updates: unknown) => {});

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
  updateGlobalConfig: mockUpdateGlobalConfig,
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
      providers: {
        capabilities: Record<string, boolean> & {
          structuredOutput: 'enforced' | 'best-effort' | false;
        };
      }[];
    };
    const caps = body.providers[0].capabilities;
    expect(typeof caps.sessionResume).toBe('boolean');
    expect(typeof caps.mcp).toBe('boolean');
    expect(typeof caps.hooks).toBe('boolean');
    // structuredOutput is the tiered union, not a boolean.
    expect(['enforced', 'best-effort', false]).toContain(caps.structuredOutput);
  });
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/config/tiers (ungated — solo-OK)
// ---------------------------------------------------------------------------

describe('PATCH /api/config/tiers', () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockUpdateGlobalConfig.mockClear();
  });

  function patch(tiers: unknown): Promise<Response> {
    return app.request('/api/config/tiers', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tiers }),
    });
  }

  test('sets a tier → 200 and calls updateGlobalConfig with a clean RawAliasEntry', async () => {
    const res = await patch({ large: { provider: 'claude', model: 'opus', effort: 'high' } });
    expect(res.status).toBe(200);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { tiers: Record<string, unknown> };
    expect(arg.tiers.large).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
  });

  test('unknown provider → 400, no write', async () => {
    const res = await patch({ large: { provider: 'definitely-not-a-provider', model: 'x' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('invalid effort for the provider → 400, no write (not silently dropped)', async () => {
    const res = await patch({ large: { provider: 'claude', model: 'opus', effort: 'ultra' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('null tier value unsets (passes null through)', async () => {
    const res = await patch({ large: null });
    expect(res.status).toBe(200);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { tiers: Record<string, unknown> };
    expect(arg.tiers.large).toBeNull();
  });

  test('drops `thinking` from the written entry (no UI surface)', async () => {
    const res = await patch({
      small: { provider: 'claude', model: 'haiku', thinking: { level: 'high' } },
    });
    expect(res.status).toBe(200);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { tiers: Record<string, unknown> };
    expect(arg.tiers.small).toEqual({ provider: 'claude', model: 'haiku' });
  });

  test('is ungated — succeeds with no auth identity', async () => {
    // No X-Archon-User header, web auth disabled in the harness → still 200.
    const res = await patch({ medium: { provider: 'claude', model: 'sonnet' } });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: PATCH /api/config/aliases (ungated — solo-OK; mirrors /tiers)
// ---------------------------------------------------------------------------

describe('PATCH /api/config/aliases', () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockUpdateGlobalConfig.mockClear();
  });

  function patch(aliases: unknown): Promise<Response> {
    return app.request('/api/config/aliases', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases }),
    });
  }

  test('sets an alias → 200 and calls updateGlobalConfig with a clean entry', async () => {
    const res = await patch({ '@fast': { provider: 'claude', model: 'haiku', effort: 'low' } });
    expect(res.status).toBe(200);
    expect(mockUpdateGlobalConfig).toHaveBeenCalledTimes(1);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { aliases: Record<string, unknown> };
    expect(arg.aliases['@fast']).toEqual({ provider: 'claude', model: 'haiku', effort: 'low' });
  });

  test('reserved tier name as alias → 400, no write', async () => {
    const res = await patch({ large: { provider: 'claude', model: 'opus' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('alias without @ prefix → 400, no write', async () => {
    const res = await patch({ fast: { provider: 'claude', model: 'haiku' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('unknown provider → 400, no write', async () => {
    const res = await patch({ '@fast': { provider: 'definitely-not-a-provider', model: 'x' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('invalid effort for the provider → 400, no write', async () => {
    const res = await patch({ '@fast': { provider: 'claude', model: 'haiku', effort: 'ultra' } });
    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConfig).not.toHaveBeenCalled();
  });

  test('null alias value unsets (passes null through)', async () => {
    const res = await patch({ '@fast': null });
    expect(res.status).toBe(200);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { aliases: Record<string, unknown> };
    expect(arg.aliases['@fast']).toBeNull();
  });

  test('drops `thinking` from the written entry (no UI surface)', async () => {
    const res = await patch({
      '@deep': { provider: 'claude', model: 'opus', thinking: { level: 'high' } },
    });
    expect(res.status).toBe(200);
    const arg = mockUpdateGlobalConfig.mock.calls[0]?.[0] as { aliases: Record<string, unknown> };
    expect(arg.aliases['@deep']).toEqual({ provider: 'claude', model: 'opus' });
  });

  test('is ungated — succeeds with no auth identity', async () => {
    const res = await patch({ '@fast': { provider: 'claude', model: 'haiku' } });
    expect(res.status).toBe(200);
  });
});

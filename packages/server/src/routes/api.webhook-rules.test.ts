import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';

const mockDiscoverWorkflowsWithConfig = mock(async (cwd: string) => {
  if (cwd === '/tmp/project-one') {
    return {
      workflows: [
        {
          workflow: { name: 'archon-smart-pr-review', description: 'Review PR' },
          source: 'project' as const,
        },
        { workflow: { name: 'triage', description: 'Triage issue' }, source: 'bundled' as const },
      ],
      errors: [],
    };
  }

  return {
    workflows: [
      { workflow: { name: 'assist', description: 'Assist workflow' }, source: 'bundled' as const },
    ],
    errors: [],
  };
});

const mockListCodebases = mock(async () => [
  {
    id: 'cb-1',
    name: 'SmelhausJosef/KoKot',
    repository_url: 'https://github.com/SmelhausJosef/KoKot.git',
    default_cwd: '/tmp/project-one',
    ai_assistant_type: 'claude',
    allow_env_keys: false,
    commands: {},
    created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-01-01T00:00:00Z').toISOString(),
  },
  {
    id: 'cb-2',
    name: 'SmelhausJosef/Other',
    repository_url: null,
    default_cwd: '/tmp/project-two',
    ai_assistant_type: 'claude',
    allow_env_keys: false,
    commands: {},
    created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    updated_at: new Date('2026-01-01T00:00:00Z').toISOString(),
  },
]);

const mockGetCodebase = mock(async (id: string) => {
  const codebases = await mockListCodebases();
  return codebases.find(codebase => codebase.id === id) ?? null;
});

const mockListWebhookRules = mock(async () => [
  {
    id: 'rule-1',
    codebase_id: 'cb-1',
    codebase_name: 'SmelhausJosef/KoKot',
    path_slug: 'kokot-pr-review',
    workflow_name: 'archon-smart-pr-review',
    enabled: true,
    created_at: new Date('2026-01-02T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
  },
]);

const mockGetWebhookRule = mock(async (_id: string) => ({
  id: 'rule-1',
  codebase_id: 'cb-1',
  path_slug: 'kokot-pr-review',
  workflow_name: 'archon-smart-pr-review',
  enabled: true,
  created_at: new Date('2026-01-02T00:00:00Z'),
  updated_at: new Date('2026-01-02T00:00:00Z'),
}));

const mockFindWebhookRuleBySlug = mock(async (_slug: string) => null);

const mockCreateWebhookRule = mock(async () => ({
  id: 'rule-2',
  codebase_id: 'cb-1',
  path_slug: 'kokot-pr-review',
  workflow_name: 'archon-smart-pr-review',
  enabled: true,
  created_at: new Date('2026-01-03T00:00:00Z'),
  updated_at: new Date('2026-01-03T00:00:00Z'),
}));

const mockUpdateWebhookRule = mock(async () => ({
  id: 'rule-1',
  codebase_id: 'cb-1',
  path_slug: 'kokot-triage',
  workflow_name: 'triage',
  enabled: false,
  created_at: new Date('2026-01-02T00:00:00Z'),
  updated_at: new Date('2026-01-04T00:00:00Z'),
}));

const mockDeleteWebhookRule = mock(async (_id: string) => {});
const mockIsWebhookRuleConflictError = mock(() => false);
const mockDispatchMatchedWebhookRule = mock(async () => undefined);

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  toSafeConfig: (config: unknown) => config,
  updateGlobalConfig: mock(async () => {}),
  cloneRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  registerRepository: mock(async () => ({ codebaseId: 'x', alreadyExisted: false })),
  dispatchMatchedWebhookRule: mockDispatchMatchedWebhookRule,
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  generateAndSetTitle: mock(async () => {}),
  EnvLeakError: class EnvLeakError extends Error {},
  scanPathForSensitiveKeys: mock(async () => ({ findings: [] })),
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
  getRunArtifactsPath: () => '/tmp/.archon/artifacts',
  getArchonHome: () => '/tmp/.archon',
  isDocker: () => false,
  checkForUpdate: mock(async () => null),
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: '0.0.0-test',
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));
mock.module('@archon/workflows/loader', () => ({
  parseWorkflow: mock(() => ({
    workflow: null,
    error: { filename: '', error: 'stub', errorType: 'parse_error' },
  })),
}));
mock.module('@archon/workflows/command-validation', () => ({
  isValidCommandName: mock(() => true),
}));
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {},
  BUNDLED_COMMANDS: {},
  isBinaryBuild: mock(() => false),
}));
mock.module('@archon/git', () => ({
  removeWorktree: mock(async () => {}),
  toRepoPath: (path: string) => path,
  toWorktreePath: (path: string) => path,
}));
mock.module('@archon/core/db/conversations', () => ({
  findConversationByPlatformId: mock(async () => null),
  listConversations: mock(async () => []),
  getOrCreateConversation: mock(async (_platform: string, conversationId: string) => ({
    id: 'conv-1',
    platform_conversation_id: conversationId,
    title: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    platform_type: 'web',
    deleted_at: null,
    codebase_id: null,
    ai_assistant_type: 'claude',
    cwd: null,
  })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
  updateConversation: mock(async () => {}),
}));
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mockListCodebases,
  getCodebase: mockGetCodebase,
  deleteCodebase: mock(async () => {}),
}));
mock.module('@archon/core/db/env-vars', () => ({
  listCodebaseEnvVars: mock(async () => []),
  setCodebaseEnvVar: mock(async () => {}),
  deleteCodebaseEnvVar: mock(async () => {}),
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
  cancelWorkflowRun: mock(async () => {}),
  getWorkflowRunByWorkerPlatformId: mock(async () => null),
  getRunningWorkflows: mock(async () => []),
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
mock.module('@archon/core/db/webhook-rules', () => ({
  listWebhookRules: mockListWebhookRules,
  getWebhookRule: mockGetWebhookRule,
  findWebhookRuleBySlug: mockFindWebhookRuleBySlug,
  createWebhookRule: mockCreateWebhookRule,
  updateWebhookRule: mockUpdateWebhookRule,
  deleteWebhookRule: mockDeleteWebhookRule,
  isWebhookRuleConflictError: mockIsWebhookRuleConflictError,
}));
mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

import { registerApiRoutes } from './api';

function makeApp(): OpenAPIHono {
  const app = new OpenAPIHono({ defaultHook: validationErrorHook });
  const webAdapter = {
    setConversationDbId: mock(() => {}),
  } as unknown as WebAdapter;
  const lockManager = {
    acquireLock: mock(async (_id: string, handler: () => Promise<void>) => {
      await handler();
    }),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, webAdapter, lockManager);
  return app;
}

describe('webhook rules routes', () => {
  beforeEach(() => {
    mockListCodebases.mockClear();
    mockGetCodebase.mockClear();
    mockListWebhookRules.mockClear();
    mockGetWebhookRule.mockClear();
    mockFindWebhookRuleBySlug.mockReset();
    mockFindWebhookRuleBySlug.mockImplementation(async () => null);
    mockCreateWebhookRule.mockClear();
    mockUpdateWebhookRule.mockClear();
    mockDeleteWebhookRule.mockClear();
    mockDispatchMatchedWebhookRule.mockClear();
    mockIsWebhookRuleConflictError.mockReset();
    mockIsWebhookRuleConflictError.mockImplementation(() => false);
    mockDiscoverWorkflowsWithConfig.mockClear();
  });

  test('GET /api/webhook-rules lists configured rules', async () => {
    const app = makeApp();
    const response = await app.request('/api/webhook-rules');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rules: Array<{ codebaseName: string; urlSlug: string; workflowName: string }>;
    };

    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]).toMatchObject({
      codebaseName: 'SmelhausJosef/KoKot',
      urlSlug: 'kokot-pr-review',
      workflowName: 'archon-smart-pr-review',
    });
  });

  test('GET /api/webhook-rules/options returns codebases and workflows', async () => {
    const app = makeApp();
    const response = await app.request('/api/webhook-rules/options');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      codebases: Array<{ id: string; name: string }>;
      workflowsByCodebase: Array<{ codebaseId: string; workflows: Array<{ name: string }> }>;
    };

    expect(body.codebases).toEqual([
      { id: 'cb-1', name: 'SmelhausJosef/KoKot' },
      { id: 'cb-2', name: 'SmelhausJosef/Other' },
    ]);
    expect(body.workflowsByCodebase).toContainEqual({
      codebaseId: 'cb-1',
      workflows: [
        { name: 'archon-smart-pr-review', description: 'Review PR', source: 'project' },
        { name: 'triage', description: 'Triage issue', source: 'bundled' },
      ],
    });
  });

  test('POST /api/webhook-rules creates a rule when slug and workflow are valid', async () => {
    const app = makeApp();
    const response = await app.request('/api/webhook-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codebaseId: 'cb-1',
        urlSlug: 'kokot-pr-review',
        workflowName: 'archon-smart-pr-review',
        enabled: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(mockCreateWebhookRule).toHaveBeenCalledWith({
      codebase_id: 'cb-1',
      path_slug: 'kokot-pr-review',
      workflow_name: 'archon-smart-pr-review',
      enabled: true,
    });

    const body = (await response.json()) as { codebaseName: string; workflowName: string };
    expect(body).toMatchObject({
      codebaseName: 'SmelhausJosef/KoKot',
      workflowName: 'archon-smart-pr-review',
    });
  });

  test('POST /api/webhook-rules rejects unknown workflows', async () => {
    const app = makeApp();
    const response = await app.request('/api/webhook-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codebaseId: 'cb-1',
        urlSlug: 'kokot-unknown',
        workflowName: 'does-not-exist',
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Workflow not found for codebase');
  });

  test('POST /api/webhook-rules returns conflict when slug already exists', async () => {
    mockCreateWebhookRule.mockRejectedValueOnce(new Error('duplicate'));
    mockIsWebhookRuleConflictError.mockReturnValueOnce(true);

    const app = makeApp();
    const response = await app.request('/api/webhook-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codebaseId: 'cb-1',
        urlSlug: 'kokot-pr-review',
        workflowName: 'archon-smart-pr-review',
      }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Webhook rule conflict');
  });

  test('PATCH /api/webhook-rules/:id updates a rule after revalidating the target', async () => {
    const app = makeApp();
    const response = await app.request('/api/webhook-rules/rule-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urlSlug: 'kokot-triage',
        workflowName: 'triage',
        enabled: false,
      }),
    });

    const body = (await response.json()) as {
      urlSlug: string;
      workflowName: string;
      enabled: boolean;
    };
    expect(response.status).toBe(200);
    expect(mockUpdateWebhookRule).toHaveBeenCalledWith('rule-1', {
      codebase_id: undefined,
      path_slug: 'kokot-triage',
      workflow_name: 'triage',
      enabled: false,
    });

    expect(body).toMatchObject({
      urlSlug: 'kokot-triage',
      workflowName: 'triage',
      enabled: false,
    });
  });

  test('DELETE /api/webhook-rules/:id deletes a rule', async () => {
    const app = makeApp();
    const response = await app.request('/api/webhook-rules/rule-1', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(mockDeleteWebhookRule).toHaveBeenCalledWith('rule-1');
    expect(await response.json()).toEqual({ success: true });
  });

  test('POST /webhooks/:slug dispatches the configured workflow', async () => {
    mockFindWebhookRuleBySlug.mockResolvedValueOnce({
      id: 'rule-1',
      codebase_id: 'cb-1',
      path_slug: 'kokot-pr-review',
      workflow_name: 'archon-smart-pr-review',
      enabled: true,
      created_at: new Date('2026-01-02T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
    });

    const app = makeApp();
    const response = await app.request('/webhooks/kokot-pr-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(response.status).toBe(202);
    expect(mockDispatchMatchedWebhookRule).toHaveBeenCalledTimes(1);
    expect(mockDispatchMatchedWebhookRule.mock.calls[0]?.[0]).toMatchObject({
      pathSlug: 'kokot-pr-review',
      contentType: 'application/json',
      matchedRule: expect.objectContaining({ workflow_name: 'archon-smart-pr-review' }),
      codebase: expect.objectContaining({ id: 'cb-1' }),
    });
  });
});

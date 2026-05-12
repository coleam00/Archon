import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be declared before any dynamic imports of mocked modules
// ---------------------------------------------------------------------------

const mockGetCodebase = mock(
  async (_id: string) =>
    null as null | {
      id: string;
      name: string;
      repository_url: string | null;
      default_cwd: string;
      ai_assistant_type: string;
      commands: Record<string, unknown> | string;
      created_at: string;
      updated_at: string;
    }
);
const mockListCodebases = mock(async () => [] as (typeof MOCK_CODEBASE)[]);
const mockDeleteCodebase = mock(async (_id: string) => {});
const mockCloneRepository = mock(async (_url: string) => ({
  codebaseId: 'clone-uuid-1',
  alreadyExisted: false,
}));
const mockRegisterRepository = mock(async (_path: string) => ({
  codebaseId: 'register-uuid-1',
  alreadyExisted: false,
}));
const mockListByCodebase = mock(async (_id: string) => [] as unknown[]);
const mockRemoveWorktree = mock(async () => {});
const mockUpdateStatus = mock(async (_id: string, _status: string) => {});

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  cloneRepository: mockCloneRepository,
  registerRepository: mockRegisterRepository,
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mock(async () => {}),
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
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mockRemoveWorktree,
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
  })),
  softDeleteConversation: mock(async () => {}),
  updateConversationTitle: mock(async () => {}),
  getConversationById: mock(async () => null),
}));

mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mockListCodebases,
  getCodebase: mockGetCodebase,
  deleteCodebase: mockDeleteCodebase,
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mockListByCodebase,
  updateStatus: mockUpdateStatus,
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
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(async () => []),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(async () => ({
    id: 'msg-1',
    conversation_id: 'conv-1',
    role: 'user',
    content: 'hello',
    metadata: '{}',
    created_at: new Date().toISOString(),
  })),
  listMessages: mock(async () => []),
}));

mock.module('@archon/core/utils/commands', () => ({
  findMarkdownFilesRecursive: mock(async () => []),
}));

// Import the module under test AFTER all mock.module() calls
import { registerApiRoutes } from './api';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_CODEBASE = {
  id: 'codebase-uuid-1',
  name: 'my-project',
  repository_url: 'https://github.com/user/repo',
  default_cwd: '/home/user/projects/my-project',
  ai_assistant_type: 'claude',
  commands: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MOCK_CODEBASE_WITH_STRING_COMMANDS = {
  ...MOCK_CODEBASE,
  id: 'codebase-uuid-2',
  commands: '{"plan":{"path":"/cmds/plan.md","description":"Plan"}}',
};

const MOCK_ENV = {
  id: 'env-uuid-1',
  codebase_id: 'codebase-uuid-1',
  working_path: '/tmp/worktrees/feature-branch',
  status: 'active',
  workflow_type: 'implement',
  workflow_id: 'wf-1',
  branch_name: 'feature-branch',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function makeApp(): OpenAPIHono {
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
    getStats: mock(() => ({ active: 0, queued: 0 })),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager);
  return app;
}

// ---------------------------------------------------------------------------
// Tests: GET /api/codebases
// ---------------------------------------------------------------------------

describe('GET /api/codebases', () => {
  beforeEach(() => {
    mockListCodebases.mockReset();
  });

  test('returns empty array when no codebases exist', async () => {
    mockListCodebases.mockImplementationOnce(async () => []);

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(200);

    const body = (await response.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  test('returns list of codebases sorted by name', async () => {
    mockListCodebases.mockImplementationOnce(async () => [
      { ...MOCK_CODEBASE, id: 'b', name: 'zebra-project', repository_url: null },
      { ...MOCK_CODEBASE, id: 'a', name: 'alpha-project', repository_url: null },
    ]);

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ name: string }>;
    expect(body[0]?.name).toBe('alpha-project');
    expect(body[1]?.name).toBe('zebra-project');
  });

  test('deduplicates by repository_url (keeps most recently updated)', async () => {
    const older = {
      ...MOCK_CODEBASE,
      id: 'older',
      name: 'my-project',
      repository_url: 'https://github.com/user/repo',
      updated_at: '2024-01-01T00:00:00Z',
    };
    const newer = {
      ...MOCK_CODEBASE,
      id: 'newer',
      name: 'my-project',
      repository_url: 'https://github.com/user/repo.git',
      updated_at: '2024-06-01T00:00:00Z',
    };
    mockListCodebases.mockImplementationOnce(async () => [older, newer]);

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ id: string }>;
    // Only one entry should survive dedup (the newer one)
    expect(body.length).toBe(1);
    expect(body[0]?.id).toBe('newer');
  });

  test('parses commands when stored as JSON string', async () => {
    mockListCodebases.mockImplementationOnce(async () => [MOCK_CODEBASE_WITH_STRING_COMMANDS]);

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(200);

    const body = (await response.json()) as Array<{ commands: unknown }>;
    // Should be parsed object, not a string
    expect(typeof body[0]?.commands).toBe('object');
    expect(body[0]?.commands).not.toBeNull();
  });

  test('returns 500 when DB throws', async () => {
    mockListCodebases.mockImplementationOnce(async () => {
      throw new Error('DB unavailable');
    });

    const app = makeApp();
    const response = await app.request('/api/codebases');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to list codebases');
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/codebases/:id
// ---------------------------------------------------------------------------

describe('GET /api/codebases/:id', () => {
  beforeEach(() => {
    mockGetCodebase.mockReset();
  });

  test('returns codebase when found', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { id: string; name: string };
    expect(body.id).toBe('codebase-uuid-1');
    expect(body.name).toBe('my-project');
  });

  test('returns 404 when codebase not found', async () => {
    mockGetCodebase.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/codebases/unknown-id');
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('parses commands when stored as JSON string', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE_WITH_STRING_COMMANDS);

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-2');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: unknown };
    expect(typeof body.commands).toBe('object');
    expect(body.commands).not.toBeNull();
  });

  test('returns 500 when DB throws', async () => {
    mockGetCodebase.mockImplementationOnce(async () => {
      throw new Error('Connection error');
    });

    const app = makeApp();
    const response = await app.request('/api/codebases/any-id');
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to get codebase');
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/codebases
// ---------------------------------------------------------------------------

describe('POST /api/codebases', () => {
  beforeEach(() => {
    mockGetCodebase.mockReset();
    mockCloneRepository.mockReset();
    mockRegisterRepository.mockReset();
  });

  test('registers codebase by URL and returns 201', async () => {
    mockCloneRepository.mockImplementationOnce(async () => ({
      codebaseId: 'clone-uuid-1',
      alreadyExisted: false,
    }));
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/user/repo' }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { id: string };
    expect(body.id).toBe('codebase-uuid-1');
    expect(mockCloneRepository).toHaveBeenCalledWith('https://github.com/user/repo');
  });

  test('registers existing URL codebase with 200', async () => {
    mockCloneRepository.mockImplementationOnce(async () => ({
      codebaseId: 'clone-uuid-1',
      alreadyExisted: true,
    }));
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/user/repo' }),
    });
    expect(response.status).toBe(200);
  });

  test('registers codebase by local path and returns 201', async () => {
    mockRegisterRepository.mockImplementationOnce(async () => ({
      codebaseId: 'register-uuid-1',
      alreadyExisted: false,
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      id: 'register-uuid-1',
      repository_url: null,
    }));

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/home/user/my-repo' }),
    });
    expect(response.status).toBe(201);
    expect(mockRegisterRepository).toHaveBeenCalledWith('/home/user/my-repo');
  });

  test('returns 400 when both url and path are provided', async () => {
    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/x/y', path: '/local/path' }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('url');
    expect(body.error).toContain('path');
  });

  test('returns 400 when neither url nor path are provided', async () => {
    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('url');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    expect(response.status).toBe(400);
  });

  test('returns 500 when codebase record not found after creation', async () => {
    mockCloneRepository.mockImplementationOnce(async () => ({
      codebaseId: 'clone-uuid-1',
      alreadyExisted: false,
    }));
    mockGetCodebase.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/user/repo' }),
    });
    expect(response.status).toBe(500);
  });

  test('returns 500 when clone throws an error', async () => {
    mockCloneRepository.mockImplementationOnce(async () => {
      throw new Error('git clone failed: authentication required');
    });

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/private/repo' }),
    });
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('authentication required');
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/codebases/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/codebases/:id', () => {
  beforeEach(() => {
    mockGetCodebase.mockReset();
    mockDeleteCodebase.mockReset();
    mockListByCodebase.mockReset();
    mockRemoveWorktree.mockReset();
    mockUpdateStatus.mockReset();
  });

  test('deletes codebase with no isolation environments and returns success', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockListByCodebase.mockImplementationOnce(async () => []);
    mockDeleteCodebase.mockImplementationOnce(async () => {});

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(mockDeleteCodebase).toHaveBeenCalledWith('codebase-uuid-1');
  });

  test('removes worktrees before deleting codebase', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockListByCodebase.mockImplementationOnce(async () => [MOCK_ENV]);
    mockRemoveWorktree.mockImplementationOnce(async () => {});
    mockUpdateStatus.mockImplementationOnce(async () => {});
    mockDeleteCodebase.mockImplementationOnce(async () => {});

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    expect(response.status).toBe(200);

    // Worktree removal and status update should have been called
    expect(mockRemoveWorktree).toHaveBeenCalled();
    expect(mockUpdateStatus).toHaveBeenCalledWith('env-uuid-1', 'destroyed');
  });

  test('continues deletion even if worktree removal fails', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockListByCodebase.mockImplementationOnce(async () => [MOCK_ENV]);
    mockRemoveWorktree.mockImplementationOnce(async () => {
      throw new Error('worktree already gone');
    });
    mockUpdateStatus.mockImplementationOnce(async () => {});
    mockDeleteCodebase.mockImplementationOnce(async () => {});

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    // Should still succeed — worktree removal failure is logged and skipped
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(mockDeleteCodebase).toHaveBeenCalled();
  });

  test('returns 404 when codebase not found', async () => {
    mockGetCodebase.mockImplementationOnce(async () => null);

    const app = makeApp();
    const response = await app.request('/api/codebases/unknown-id', { method: 'DELETE' });
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  test('does not delete disk directory for external (non-Archon-managed) repos', async () => {
    // The codebase's default_cwd is outside the Archon workspaces root
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      default_cwd: '/home/user/my-external-repo',
    }));
    mockListByCodebase.mockImplementationOnce(async () => []);
    mockDeleteCodebase.mockImplementationOnce(async () => {});

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  test('returns 500 when DB delete throws', async () => {
    mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
    mockListByCodebase.mockImplementationOnce(async () => []);
    mockDeleteCodebase.mockImplementationOnce(async () => {
      throw new Error('FK constraint violation');
    });

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' });
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Failed to delete codebase');
  });
});

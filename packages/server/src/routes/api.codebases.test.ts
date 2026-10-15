import {
  ActiveContainerEnvironmentsError,
  ActiveWorktreeEnvironmentsError,
} from '@archon/core/db/codebase-delete-error';
import { mkdtemp, writeFile, unlink, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  findRepoRoot as realFindRepoRoot,
  removeWorktree as realRemoveWorktree,
} from '@archon/git';
import type { deleteCodebase } from '@archon/core/db/codebases';
import { ProjectRegistrationError } from '@archon/core/handlers/clone';
import type { ProjectBaseBranchInspection } from '@archon/core';
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { validationErrorHook } from './openapi-defaults';
import { makeIdleLockStats } from '../test/conversation-lock-fixtures';
import { makeListDashboardRunsMock, mockAllWorkflowModules } from '../test/workflow-mock-factories';

// ---------------------------------------------------------------------------
// Mock setup — must be declared before any dynamic imports of mocked modules
// ---------------------------------------------------------------------------

// Capture before Bun replaces the shared export with the route mock.
const detectRealRepoRoot = realFindRepoRoot;
const removeRealWorktree = realRemoveWorktree;

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
type MockCodebase = Omit<typeof MOCK_CODEBASE, 'repository_url'> & {
  repository_url: string | null;
};
const mockListCodebases = mock(async () => [] as MockCodebase[]);
const mockDeleteCodebase = mock<typeof deleteCodebase>(async () => {});
const mockRenameCodebase = mock(async (_id: string, _name: string) => ({
  ...MOCK_CODEBASE,
  name: _name,
}));
class CodebaseNotFoundError extends Error {}
class CodebaseNameTakenError extends Error {}
class CodebaseStorageIdentityChangeError extends Error {}
const mockCloneRepository = mock(async (_url: string) => ({
  codebaseId: 'clone-uuid-1',
  alreadyExisted: false,
}));
const mockRegisterRepository = mock(async (_path: string) => ({
  codebaseId: 'register-uuid-1',
  alreadyExisted: false,
}));
const mockRegisterFolder = mock(async (_path: string) => ({
  codebaseId: 'folder-uuid-1',
  alreadyExisted: false,
}));
// Default: a resolvable repo root so local-path registration routes to
// registerRepository. Folder-fallback tests override this to resolve null.
const mockFindRepoRoot = mock(async (p: string) => p as string | null);
const mockListByCodebase = mock(async (_id: string) => [] as unknown[]);
const mockRemoveWorktree = mock<typeof realRemoveWorktree>(async () => {});
const mockUpdateStatus = mock(async (_id: string, _status: string) => {});

const mockInspectBaseBranch = mock(
  async (): Promise<ProjectBaseBranchInspection> => ({
    kind: 'repo',
    defaultBranch: 'dev',
    reason: null,
  })
);
mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  ProjectRegistrationError,
  inspectProjectBaseBranch: mockInspectBaseBranch,
  cloneRepository: mockCloneRepository,
  registerRepository: mockRegisterRepository,
  registerFolder: mockRegisterFolder,
  ConversationNotFoundError: class ConversationNotFoundError extends Error {
    constructor(id: string) {
      super(`Conversation not found: ${id}`);
      this.name = 'ConversationNotFoundError';
    }
  },
  getArchonWorkspacesPath: () => '/tmp/.archon/workspaces',
  generateAndSetTitle: mock(async () => {}),
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
}));

mockAllWorkflowModules();

mock.module('@archon/git', () => ({
  removeWorktree: mockRemoveWorktree,
  toRepoPath: (p: string) => p,
  toWorktreePath: (p: string) => p,
  findRepoRoot: mockFindRepoRoot,
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
  renameCodebase: mockRenameCodebase,
  CodebaseNotFoundError,
  CodebaseNameTakenError,
  CodebaseStorageIdentityChangeError,
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  listByCodebase: mockListByCodebase,
  updateStatus: mockUpdateStatus,
}));

mock.module('@archon/core/db/workflows', () => ({
  listWorkflowRuns: mock(async () => []),
  listDashboardRuns: makeListDashboardRunsMock(),
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
  findCommandFiles: mock(async () => []),
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
  kind: 'repo',
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
  provider: 'worktree',
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

function makeApp(dependencies?: Parameters<typeof registerApiRoutes>[5]): OpenAPIHono {
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
    getStats: mock(makeIdleLockStats),
  } as unknown as ConversationLockManager;
  registerApiRoutes(app, mockWebAdapter, mockLockManager, undefined, undefined, dependencies);
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

  test('returns empty commands object when JSON is corrupted', async () => {
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      commands: '{not valid json',
    }));

    const app = makeApp();
    const response = await app.request('/api/codebases/codebase-uuid-1');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { commands: unknown };
    expect(body.commands).toEqual({});
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
// Tests: PATCH /api/codebases/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/codebases/:id', () => {
  beforeEach(() => {
    mockRenameCodebase.mockReset();
  });

  async function patchName(body: unknown, id = 'codebase-uuid-1'): Promise<Response> {
    return makeApp().request(`/api/codebases/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('renames the codebase and returns it', async () => {
    mockRenameCodebase.mockImplementationOnce(async (_id, name) => ({ ...MOCK_CODEBASE, name }));

    const response = await patchName({ name: '  qes  ' });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { name: string }).name).toBe('qes');
    expect(mockRenameCodebase).toHaveBeenCalledWith('codebase-uuid-1', 'qes');
  });

  test('returns 400 for an empty name', async () => {
    const response = await patchName({ name: '   ' });

    expect(response.status).toBe(400);
    expect(mockRenameCodebase).not.toHaveBeenCalled();
  });

  test('returns 400 for a name longer than 255 characters', async () => {
    const response = await patchName({ name: 'x'.repeat(256) });

    expect(response.status).toBe(400);
    expect(mockRenameCodebase).not.toHaveBeenCalled();
  });

  test('returns 400 when the request has no JSON body', async () => {
    const response = await makeApp().request('/api/codebases/codebase-uuid-1', {
      method: 'PATCH',
    });

    expect(response.status).toBe(400);
    expect(mockRenameCodebase).not.toHaveBeenCalled();
  });

  test('returns 404 when the codebase does not exist', async () => {
    mockRenameCodebase.mockImplementationOnce(async () => {
      throw new CodebaseNotFoundError('Codebase unknown-id not found');
    });

    const response = await patchName({ name: 'qes' }, 'unknown-id');

    expect(response.status).toBe(404);
  });

  test('returns 409 when another codebase uses the name', async () => {
    mockRenameCodebase.mockImplementationOnce(async () => {
      throw new CodebaseNameTakenError('A project named "qes" is already registered');
    });

    const response = await patchName({ name: 'qes' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('already registered');
  });

  test('returns 409 when the rename would move project storage', async () => {
    mockRenameCodebase.mockImplementationOnce(async () => {
      throw new CodebaseStorageIdentityChangeError('would move its Archon storage');
    });

    const response = await patchName({ name: 'repo' });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toContain('storage');
  });

  test('returns 500 when the DB throws', async () => {
    mockRenameCodebase.mockImplementationOnce(async () => {
      throw new Error('connection refused');
    });

    const response = await patchName({ name: 'qes' });

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBe('Failed to rename codebase');
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
    mockRegisterFolder.mockReset();
    // Restore the default "resolvable repo root" so a local path routes to
    // registerRepository unless a test opts into the folder fallback.
    mockFindRepoRoot.mockReset();
    mockFindRepoRoot.mockImplementation(async (p: string) => p);
  });

  test('passes the host App provider to URL registration and branch inspection', async () => {
    const githubAppAuth = { getInstallationToken: mock(async () => 'installation-secret') };
    mockCloneRepository.mockResolvedValueOnce({
      codebaseId: 'clone-uuid-1',
      alreadyExisted: false,
    });
    mockGetCodebase.mockResolvedValueOnce(MOCK_CODEBASE);
    const app = makeApp({ githubAppAuth });
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/owner/repo', base_branch: 'dev' }),
    });
    expect(response.status).toBe(201);
    expect(mockCloneRepository).toHaveBeenCalledWith('https://github.com/owner/repo', {
      baseBranch: 'dev',
      githubAppAuth,
    });
    const inspection = await app.request('/api/codebases/base-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/owner/repo' }),
    });
    expect(inspection.status).toBe(200);
    expect(mockInspectBaseBranch).toHaveBeenCalledWith(
      { url: 'https://github.com/owner/repo' },
      { githubAppAuth }
    );
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
    expect(mockCloneRepository).toHaveBeenCalledWith('https://github.com/user/repo', {
      baseBranch: undefined,
    });
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
    expect(mockRegisterRepository).toHaveBeenCalledWith('/home/user/my-repo', {
      baseBranch: undefined,
    });
    expect(mockRegisterFolder).not.toHaveBeenCalled();
  });

  test('explicit folder choice skips git detection even for a git root', async () => {
    mockRegisterFolder.mockResolvedValueOnce({
      codebaseId: 'folder-uuid-1',
      alreadyExisted: false,
    });
    mockGetCodebase.mockResolvedValueOnce({ ...MOCK_CODEBASE, id: 'folder-uuid-1' });
    const response = await makeApp().request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/repo', folder: true }),
    });
    expect(response.status).toBe(201);
    expect(mockFindRepoRoot).not.toHaveBeenCalled();
    expect(mockRegisterRepository).not.toHaveBeenCalled();
    expect(mockRegisterFolder).toHaveBeenCalledWith('/repo', undefined, { baseBranch: undefined });
  });

  test('URL registration rejects a folder override', async () => {
    const response = await makeApp().request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/repo', folder: true }),
    });
    expect(response.status).toBe(400);
    expect(mockCloneRepository).not.toHaveBeenCalled();
  });

  test('registers a non-git path as a folder project and returns 201', async () => {
    // A path that is NOT a git repository → findRepoRoot resolves null → folder.
    mockFindRepoRoot.mockResolvedValueOnce(null);
    mockRegisterFolder.mockImplementationOnce(async () => ({
      codebaseId: 'folder-uuid-1',
      alreadyExisted: false,
    }));
    mockGetCodebase.mockImplementationOnce(async () => ({
      ...MOCK_CODEBASE,
      id: 'folder-uuid-1',
      repository_url: null,
      kind: 'folder',
    }));

    const app = makeApp();
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/platform' }),
    });

    expect(response.status).toBe(201);
    expect(mockRegisterFolder).toHaveBeenCalledWith('/tmp/platform', undefined, {
      baseBranch: undefined,
    });
    expect(mockRegisterRepository).not.toHaveBeenCalled();
  });

  test('when findRepoRoot throws for a missing path, returns 400 without registration', async () => {
    const missingPath = '/nonexistent-archon-test/ambiguous';
    mockFindRepoRoot.mockRejectedValueOnce(new Error('git: cannot change directory'));
    const response = await makeApp().request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: missingPath }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `Path does not exist: ${missingPath}` });
    expect(mockRegisterFolder).not.toHaveBeenCalled();
    expect(mockRegisterRepository).not.toHaveBeenCalled();
    expect(mockGetCodebase).not.toHaveBeenCalled();
  });

  for (const failure of ['not a git repository-bad-config', 'missing gitdir']) {
    test(`real Git ${failure} returns 500 without registration`, async () => {
      const projectPath = await mkdtemp(join(tmpdir(), `archon-${failure}-`));
      try {
        if (failure.endsWith('bad-config')) {
          const init = Bun.spawn(['git', '-C', projectPath, 'init'], {
            stdout: 'ignore',
            stderr: 'pipe',
          });
          expect(await init.exited).toBe(0);
          await writeFile(join(projectPath, '.git', 'config'), 'invalid config line\n');
        } else {
          await writeFile(join(projectPath, '.git'), `gitdir: ${join(projectPath, 'missing')}\n`);
        }
        mockFindRepoRoot.mockImplementationOnce(detectRealRepoRoot);
        const response = await makeApp().request('/api/codebases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: projectPath }),
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: expect.stringContaining('Nothing was registered'),
        });
        expect(mockRegisterFolder).not.toHaveBeenCalled();
        expect(mockRegisterRepository).not.toHaveBeenCalled();
        expect(mockGetCodebase).not.toHaveBeenCalled();
      } finally {
        await removeTempTree(projectPath);
      }
    });
  }

  test('when findRepoRoot throws for an EXISTING path, returns 500 and registers NOTHING', async () => {
    // A genuine git failure (git missing, timeout, permission) on a path that
    // exists is ambiguous — registering would permanently misclassify a real
    // repo as kind:'folder'. Fail fast instead.
    mockFindRepoRoot.mockRejectedValueOnce(new Error('git: command timed out'));

    const app = makeApp();
    // process.cwd() exists on every platform (real existsSync decides the branch).
    const response = await app.request('/api/codebases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: process.cwd() }),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('git');
    expect(body.error).toContain('Nothing was registered');
    expect(mockRegisterFolder).not.toHaveBeenCalled();
    expect(mockRegisterRepository).not.toHaveBeenCalled();
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
    mockRemoveWorktree.mockResolvedValue(undefined);
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
    expect(mockDeleteCodebase).toHaveBeenCalledWith('codebase-uuid-1', {
      requireWorktreeCleanup: true,
    });
  });

  test('refuses deletion before any cleanup when active containers remain', async () => {
    mockGetCodebase.mockResolvedValueOnce(MOCK_CODEBASE);
    mockListByCodebase.mockResolvedValueOnce([
      MOCK_ENV,
      { ...MOCK_ENV, id: 'container-one', provider: 'container' },
      { ...MOCK_ENV, id: 'container-two', provider: 'container' },
    ]);
    const response = await makeApp().request('/api/codebases/codebase-uuid-1', {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('container-one');
    expect(body.error).toContain('container-two');
    expect(body.error).toContain('archon isolation cleanup 0');
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockDeleteCodebase).not.toHaveBeenCalled();
  });

  test('removes worktrees and marks them destroyed before guarded database deletion', async () => {
    mockGetCodebase.mockResolvedValueOnce(MOCK_CODEBASE);
    mockListByCodebase.mockResolvedValueOnce([{ ...MOCK_ENV, working_path: process.cwd() }]);
    mockDeleteCodebase.mockImplementationOnce(async () => {
      expect(mockRemoveWorktree).toHaveBeenCalledWith(MOCK_CODEBASE.default_cwd, process.cwd());
      expect(mockUpdateStatus).toHaveBeenCalledWith(MOCK_ENV.id, 'destroyed');
    });
    const response = await makeApp().request('/api/codebases/codebase-uuid-1', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(mockDeleteCodebase).toHaveBeenCalledWith('codebase-uuid-1', {
      requireWorktreeCleanup: true,
    });
  });

  test('keeps the project and cleanup handle if worktree removal fails', async () => {
    mockGetCodebase.mockResolvedValueOnce(MOCK_CODEBASE);
    mockListByCodebase.mockResolvedValueOnce([{ ...MOCK_ENV, working_path: process.cwd() }]);
    mockRemoveWorktree.mockRejectedValueOnce(new Error('dirty worktree'));
    const response = await makeApp().request('/api/codebases/codebase-uuid-1', {
      method: 'DELETE',
    });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain(MOCK_ENV.id);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockDeleteCodebase).not.toHaveBeenCalled();
  });

  test('retries a real dirty linked worktree without losing its cleanup handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-delete-worktree-'));
    const repo = join(root, 'repo');
    const checkout = join(root, 'checkout');
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args]);
      expect(result.exitCode).toBe(0);
    };
    try {
      git('init', repo);
      git(
        '-C',
        repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial'
      );
      git('-C', repo, 'worktree', 'add', '-b', 'cleanup-test', checkout);
      const dirtyFile = join(checkout, 'untracked.txt');
      await writeFile(dirtyFile, 'keep until the operator resolves it');
      mockGetCodebase.mockResolvedValue({ ...MOCK_CODEBASE, default_cwd: repo });
      mockListByCodebase.mockResolvedValue([{ ...MOCK_ENV, working_path: checkout }]);
      mockRemoveWorktree.mockImplementation(removeRealWorktree);
      const app = makeApp();
      expect(
        (await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' })).status
      ).toBe(500);
      expect(await Bun.file(dirtyFile).text()).toContain('keep until');
      expect(mockUpdateStatus).not.toHaveBeenCalled();
      expect(mockDeleteCodebase).not.toHaveBeenCalled();

      await unlink(dirtyFile);
      expect(
        (await app.request('/api/codebases/codebase-uuid-1', { method: 'DELETE' })).status
      ).toBe(200);
      expect(await stat(checkout).catch(error => error.code)).toBe('ENOENT');
      expect((await stat(repo)).isDirectory()).toBe(true);
      expect(mockUpdateStatus).toHaveBeenCalledWith(MOCK_ENV.id, 'destroyed');
      expect(mockDeleteCodebase).toHaveBeenCalledWith('codebase-uuid-1', {
        requireWorktreeCleanup: true,
      });
    } finally {
      await removeTempTree(root);
    }
  });

  test('finishes tracking an already removed worktree on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-delete-missing-'));
    try {
      mockGetCodebase.mockResolvedValueOnce(MOCK_CODEBASE);
      mockListByCodebase.mockResolvedValueOnce([
        { ...MOCK_ENV, working_path: join(root, 'missing') },
      ]);
      const response = await makeApp().request('/api/codebases/codebase-uuid-1', {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
      expect(mockUpdateStatus).toHaveBeenCalledWith(MOCK_ENV.id, 'destroyed');
    } finally {
      await removeTempTree(root);
    }
  });

  for (const failure of [
    new ActiveContainerEnvironmentsError(['new-container']),
    new ActiveWorktreeEnvironmentsError(['new-worktree']),
  ]) {
    test(`returns the transactional refusal: ${failure.name}`, async () => {
      mockGetCodebase.mockResolvedValueOnce(MOCK_CODEBASE);
      mockListByCodebase.mockResolvedValueOnce([]);
      mockDeleteCodebase.mockRejectedValueOnce(failure);
      const response = await makeApp().request('/api/codebases/codebase-uuid-1', {
        method: 'DELETE',
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe(failure.message);
    });
  }

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

test('base branch prefill is read-only and returns the detected remote name', async () => {
  mockCloneRepository.mockClear();
  mockRegisterRepository.mockClear();
  mockRegisterFolder.mockClear();
  const response = await makeApp().request('/api/codebases/base-branch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://github.com/user/repo' }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kind: 'repo', defaultBranch: 'dev', reason: null });
  expect(mockCloneRepository).not.toHaveBeenCalled();
  expect(mockRegisterRepository).not.toHaveBeenCalled();
  expect(mockRegisterFolder).not.toHaveBeenCalled();
});

test('registration forwards an explicit branch choice', async () => {
  mockCloneRepository.mockResolvedValue({ codebaseId: 'clone-uuid-1', alreadyExisted: false });
  mockGetCodebase.mockImplementationOnce(async () => MOCK_CODEBASE);
  const response = await makeApp().request('/api/codebases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://github.com/user/repo', base_branch: 'release' }),
  });
  expect(response.status).toBe(201);
  expect(mockCloneRepository).toHaveBeenLastCalledWith('https://github.com/user/repo', {
    baseBranch: 'release',
  });
});

test('prefill preserves unknown default and folder results', async () => {
  for (const result of [
    { kind: 'repo', defaultBranch: null, reason: 'unknown_head' },
    { kind: 'folder' },
  ] satisfies ProjectBaseBranchInspection[]) {
    mockInspectBaseBranch.mockResolvedValueOnce(result);
    const response = await makeApp().request('/api/codebases/base-branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/repo' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  }
});

test('registration reports typed branch and folder errors as bad requests', async () => {
  const { ProjectRegistrationError } = await import('@archon/core');
  mockRegisterFolder.mockRejectedValueOnce(
    new ProjectRegistrationError('Folder projects have no base branch; remove --base-branch.')
  );
  const response = await makeApp().request('/api/codebases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/git-root', folder: true, base_branch: 'release' }),
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain('Folder projects have no base branch');
});

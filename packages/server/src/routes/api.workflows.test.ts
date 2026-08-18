import { describe, test, expect, mock, spyOn } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { ConversationLockManager } from '@archon/core';
import type { WebAdapter } from '../adapters/web';
import { access, mkdir, readFile, rm, writeFile, symlink as fsSymlink } from 'fs/promises';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import * as archonPaths from '@archon/paths';
import { validationErrorHook } from './openapi-defaults';
import { makeTestWorkflow, makeTestWorkflowWithSource } from '@archon/workflows/test-utils';

/** Test app factory: includes defaultHook to format validation errors as { error: string }. */
function createTestApp(): OpenAPIHono {
  return new OpenAPIHono({ defaultHook: validationErrorHook });
}

const mockDiscoverWorkflows = mock(async (_cwd: string | null) => ({
  workflows: [makeTestWorkflowWithSource({ name: 'deploy', description: 'Deploy app' }, 'bundled')],
  errors: [
    { filename: '/tmp/.archon/workflows/bad.md', error: 'invalid', errorType: 'parse_error' },
  ],
}));

// Default: returns a valid workflow. Use mockReturnValueOnce in tests that need a parse failure.
const mockParseWorkflow = mock((content: string, _filename: string) => {
  const name = /^name:\s*['"]?([^'"\n]+)['"]?$/m.exec(content)?.[1] ?? 'test';
  return {
    workflow: makeTestWorkflow({ name, description: 'Test workflow' }),
    error: null,
  };
});

const mockLoadRepoConfig = mock(
  async (_repoPath: string) => ({}) as { recommendedWorkflows?: string[] }
);

mock.module('@archon/core', () => ({
  handleMessage: mock(async () => {}),
  getDatabaseType: () => 'sqlite',
  loadConfig: mock(async () => ({})),
  loadRepoConfig: mockLoadRepoConfig,
  getWorkflowFolderSearchPaths: mock(() => ['.archon/workflows']),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands', '.archon/commands/defaults']),
  getDefaultCommandsPath: mock(() => '/tmp/.archon-test-nonexistent/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/tmp/.archon-test-nonexistent/workflows/defaults'),
  cloneRepository: mock(async () => {}),
  registerRepository: mock(async () => ({ success: true })),
  removeWorktree: mock(async () => ({ success: true })),
  ConversationNotFoundError: class extends Error {},
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

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflows,
  isValidWorkflowFolderSegment: (name: string) =>
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !name.includes(':') &&
    !!name &&
    !name.startsWith('.'),
}));
mock.module('@archon/workflows/loader', () => ({
  parseWorkflow: mockParseWorkflow,
}));
mock.module('@archon/workflows/command-validation', () => {
  const isValidCommandName = (name: string) =>
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !!name &&
    !name.startsWith('.');
  return {
    isValidCommandName: mock(isValidCommandName),
    isValidWorkflowName: mock((name: string) => {
      if (!name) return false;
      const segments = name.split('/');
      if (segments.length > 2) return false;
      return segments.every(isValidCommandName);
    }),
  };
});
mock.module('@archon/workflows/defaults', () => ({
  BUNDLED_WORKFLOWS: {
    'archon-assist': 'name: archon-assist\ndescription: Archon Assist\nnodes: []',
    test: 'name: legacy\ndescription: Filename collision\nnodes: []',
    'definition-file': 'name: test\ndescription: Declared name match\nnodes: []',
  },
  BUNDLED_COMMANDS: {
    'archon-assist': '# archon-assist command',
  },
  isBinaryBuild: mock(() => false),
}));

// Note: @archon/core/defaults/bundled-defaults and @archon/core/utils/commands are NOT mocked.
// The real implementations are used. isBinaryBuild() returns false in Bun test environment, and
// the filesystem paths used by the routes point to non-existent directories, so access/readFile/unlink
// calls naturally fail with ENOENT without needing to mock fs/promises (which would leak globally).

mock.module('@archon/core/db/conversations', () => ({}));
mock.module('@archon/core/db/isolation-environments', () => ({}));
mock.module('@archon/core/db/workflows', () => ({}));
mock.module('@archon/core/db/workflow-events', () => ({}));
mock.module('@archon/core/db/messages', () => ({}));

const mockListCodebases = mock(async () => [{ default_cwd: '/tmp/project' }]);
mock.module('@archon/core/db/codebases', () => ({
  listCodebases: mockListCodebases,
}));

import { registerApiRoutes } from './api';

describe('GET /api/workflows', () => {
  test('returns a flat workflows array from discoverWorkflows result', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      workflows: Array<{ workflow: { name: string }; source: string }> & { workflows?: unknown };
      errors: unknown[];
    };

    expect(Array.isArray(body.workflows)).toBe(true);
    expect(body.workflows[0]?.workflow.name).toBe('deploy');
    expect(body.workflows[0]?.source).toBe('bundled');
    expect(body.workflows.workflows).toBeUndefined();
    expect(mockDiscoverWorkflows).toHaveBeenCalledWith('/tmp/project', expect.any(Function));
    expect(body.errors).toBeDefined();
    expect(Array.isArray(body.errors)).toBe(true);
  });

  test('reports the workflow-level provider/model the AUTHOR declared', async () => {
    // Composition collapses those fields onto the nodes and removes them from the
    // definition (#1764), so the list response layers the declared values back on. Without
    // that, every console workflow card silently loses its provider/model badge.
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockDiscoverWorkflows.mockImplementationOnce(async () => ({
      workflows: [
        makeTestWorkflowWithSource(
          { name: 'deploy', description: 'Deploy app', provider: 'codex', model: 'gpt-5.6-sol' },
          'bundled'
        ),
      ],
      errors: [],
    }));

    const response = await app.request('/api/workflows');
    const body = (await response.json()) as {
      workflows: { workflow: { provider?: string; model?: string; nodes: unknown[] } }[];
    };

    expect(body.workflows[0].workflow.provider).toBe('codex');
    expect(body.workflows[0].workflow.model).toBe('gpt-5.6-sol');
    // The EXPANDED node graph is what ships alongside it — the declared values are layered
    // over the definition, they do not replace it.
    expect(Array.isArray(body.workflows[0].workflow.nodes)).toBe(true);
  });

  test('falls back to null cwd when no cwd query and no codebases registered', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // No registered codebases → handler should call discovery with null cwd
    // so bundled + home-scoped workflows still surface.
    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      workflows: Array<{ workflow: { name: string }; source: string }>;
      recommended: string[];
    };

    // Discovery is invoked with null (not skipped), so bundled defaults can surface.
    expect(mockDiscoverWorkflows).toHaveBeenLastCalledWith(null, expect.any(Function));
    // The mocked discovery returns one bundled workflow regardless of cwd, so the
    // response is non-empty — proving the handler no longer short-circuits on no-cwd.
    expect(Array.isArray(body.workflows)).toBe(true);
    expect(body.workflows.length).toBeGreaterThan(0);
    expect(body.workflows[0]?.source).toBe('bundled');
    // No project context → recommended is always empty
    expect(body.recommended).toEqual([]);
  });

  test('returns recommended = [] when project has no recommendedWorkflows key', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockLoadRepoConfig.mockResolvedValueOnce({});

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { recommended: string[] };
    expect(body.recommended).toEqual([]);
  });

  test('returns recommended filtered to discovered names in declared order', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // Discovery returns three workflows; recommendedWorkflows references two of them
    // (in a non-discovery order) plus one stale name that must be filtered out.
    mockDiscoverWorkflows.mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'deploy' }, 'bundled'),
        makeTestWorkflowWithSource({ name: 'plan' }, 'project'),
        makeTestWorkflowWithSource({ name: 'fix' }, 'bundled'),
      ],
      errors: [],
    });
    mockLoadRepoConfig.mockResolvedValueOnce({
      recommendedWorkflows: ['fix', 'stale-name', 'plan'],
    });

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { recommended: string[] };
    expect(body.recommended).toEqual(['fix', 'plan']);
  });

  // #2213 — discovery records the keys the engine dropped; the console reads
  // this endpoint, so dropping the field here makes the warning unreachable on
  // the surface most authors edit workflows on.
  test('carries parseWarnings through to the response', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockDiscoverWorkflows.mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'clean' }, 'project'),
        makeTestWorkflowWithSource({ name: 'gated' }, 'project', [
          "Node 'plan': unknown key 'interactive' will be ignored.",
        ]),
      ],
      errors: [],
    });

    const response = await app.request('/api/workflows');
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      workflows: { workflow: { name: string }; parseWarnings?: string[] }[];
    };
    // Absent (not an empty array) on a clean workflow — presence is the signal.
    expect(body.workflows[0].parseWarnings).toBeUndefined();
    expect(body.workflows[1].parseWarnings).toEqual([
      "Node 'plan': unknown key 'interactive' will be ignored.",
    ]);
  });
});

describe('POST /api/workflows/validate', () => {
  test('returns valid:true for valid definition', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'my-workflow', description: 'test', nodes: [] } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  test('returns valid:false with errors for invalid definition', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockParseWorkflow.mockReturnValueOnce({
      workflow: null,
      error: { filename: 'test.yaml', error: 'parse error', errorType: 'validation_error' },
    });

    const response = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'my-workflow', description: 'bad' } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { valid: boolean; errors: string[] };
    expect(body.valid).toBe(false);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  test('returns 400 for missing definition', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ other: 'data' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('definition');
  });

  test('returns 400 for malformed JSON body', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all {{{',
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/workflows/:name', () => {
  test('returns 400 for invalid name (path traversal)', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/..secret');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid workflow name');
  });

  test('returns 404 when workflow not found', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // No cwd → no readFile attempt → checks BUNDLED_WORKFLOWS → not there → 404
    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows/nonexistent-workflow');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('nonexistent-workflow');
  });

  test('returns bundled workflow with source:bundled', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // No cwd → no readFile attempt → checks BUNDLED_WORKFLOWS → archon-assist found
    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows/archon-assist');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { source: string; filename: string; workflow: unknown };
    expect(body.source).toBe('bundled');
    expect(body.filename).toBe('archon-assist.yaml');
    expect(body.workflow).toBeDefined();
  });

  test('resolves a bundled workflow by declared name when its filename stem collides', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows/test');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      source: string;
      filename: string;
      workflow: { name: string };
    };
    expect(body.source).toBe('bundled');
    expect(body.filename).toBe('definition-file.yaml');
    expect(body.workflow.name).toBe('test');
  });

  test('returns project workflow with source:project when file exists on disk', async () => {
    const testDir = join(tmpdir(), `wf-get-test-${Date.now()}`);
    const workflowDir = join(testDir, '.archon', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'custom.yaml'),
      'name: custom\ndescription: My custom\nnodes:\n  - id: plan\n    command: plan\n'
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/custom?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        source: string;
        filename: string;
        workflow: { name: string };
      };
      expect(body.source).toBe('project');
      expect(body.filename).toBe('custom.yaml');
      expect(body.workflow).toBeDefined();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns project workflow when file uses .yml extension (matches discovery)', async () => {
    const testDir = join(tmpdir(), `wf-yml-test-${Date.now()}`);
    const workflowDir = join(testDir, '.archon', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'phase-0-spike.yml'),
      'name: phase-0-spike\ndescription: Spike\nnodes:\n  - id: plan\n    command: plan\n'
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/phase-0-spike?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        source: string;
        filename: string;
        workflow: { name: string };
      };
      expect(body.source).toBe('project');
      expect(body.filename).toBe('phase-0-spike.yml');
      expect(body.workflow).toBeDefined();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns a namespaced workflow (one subfolder deep) via percent-encoded slash', async () => {
    const testDir = join(tmpdir(), `wf-get-ns-test-${Date.now()}`);
    const workflowDir = join(testDir, '.archon', 'workflows', 'triage');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'review.yaml'),
      'name: review\ndescription: Triage review\nnodes:\n  - id: plan\n    command: plan\n'
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/triage%2Freview?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        source: string;
        filename: string;
        workflow: { name: string };
      };
      expect(body.source).toBe('project');
      expect(body.filename).toBe('triage/review.yaml');
      expect(body.workflow).toBeDefined();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns a namespaced workflow that declares its full namespace', async () => {
    const testDir = join(tmpdir(), `wf-get-full-ns-test-${Date.now()}`);
    const workflowDir = join(testDir, '.archon', 'workflows', 'triage');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'review.yaml'),
      'name: triage/review\ndescription: Triage review\nnodes: []\n'
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);

      const response = await app.request(`/api/workflows/triage%2Freview?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { workflow: { name: string } };
      expect(body.workflow.name).toBe('triage/review');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns home-scoped workflow when file uses .yml extension', async () => {
    const tmpHome = join(tmpdir(), `wf-home-yml-test-${Date.now()}`);
    const homeWorkflowsDir = join(tmpHome, 'workflows');
    await mkdir(homeWorkflowsDir, { recursive: true });
    await writeFile(
      join(homeWorkflowsDir, 'home-yml-only.yml'),
      'name: home-yml-only\ndescription: Home-scoped .yml workflow\nnodes:\n  - id: plan\n    command: plan\n'
    );

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      // No registered codebase → skips project-scope, falls through to home-scope
      mockListCodebases.mockImplementationOnce(async () => []);
      const response = await app.request('/api/workflows/home-yml-only');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        source: string;
        filename: string;
        workflow: unknown;
      };
      expect(body.source).toBe('global');
      expect(body.filename).toBe('home-yml-only.yml');
      expect(body.workflow).toBeDefined();
    } finally {
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  test('returns source-build default workflow when file uses .yml extension', async () => {
    const testDir = join(tmpdir(), `wf-defaults-yml-test-${Date.now()}`);
    const defaultsDir = join(testDir, 'workflows', 'defaults');
    await mkdir(defaultsDir, { recursive: true });
    await writeFile(
      join(defaultsDir, 'default-yml-wf.yml'),
      'name: default-yml-wf\ndescription: Default .yml workflow\nnodes:\n  - id: plan\n    command: plan\n'
    );

    // Point the defaults lookup at the temp dir; keep home-scope at a
    // nonexistent path so the handler falls through to the defaults source.
    const defaultsPathSpy = spyOn(archonPaths, 'getDefaultWorkflowsPath').mockReturnValue(
      defaultsDir
    );
    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(testDir, 'nonexistent-home');
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => []);
      const response = await app.request('/api/workflows/default-yml-wf');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        source: string;
        filename: string;
        workflow: unknown;
      };
      expect(body.source).toBe('bundled');
      expect(body.filename).toBe('default-yml-wf.yml');
      expect(body.workflow).toBeDefined();
    } finally {
      defaultsPathSpy.mockRestore();
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns home-scoped workflow with source:global when project/bundled miss', async () => {
    const tmpHome = join(tmpdir(), `wf-home-test-${Date.now()}`);
    const homeWorkflowsDir = join(tmpHome, 'workflows');
    await mkdir(homeWorkflowsDir, { recursive: true });
    await writeFile(
      join(homeWorkflowsDir, 'home-only.yaml'),
      'name: home-only\ndescription: Home-scoped workflow\nnodes:\n  - id: plan\n    command: plan\n'
    );

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      // No registered codebase → skips project-scope, falls through to home-scope
      mockListCodebases.mockImplementationOnce(async () => []);
      const response = await app.request('/api/workflows/home-only');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        source: string;
        filename: string;
        workflow: unknown;
      };
      expect(body.source).toBe('global');
      expect(body.filename).toBe('home-only.yaml');
      expect(body.workflow).toBeDefined();
    } finally {
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  test('returns 500 when home-scoped workflow file is malformed YAML', async () => {
    const tmpHome = join(tmpdir(), `wf-home-invalid-test-${Date.now()}`);
    const homeWorkflowsDir = join(tmpHome, 'workflows');
    await mkdir(homeWorkflowsDir, { recursive: true });
    await writeFile(join(homeWorkflowsDir, 'broken.yaml'), 'invalid: [yaml');

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      // No registered codebase → project scope skipped → home scope attempted.
      mockListCodebases.mockImplementationOnce(async () => []);
      // Force parseWorkflow to surface a parse error for the home file.
      mockParseWorkflow.mockReturnValueOnce({
        workflow: null,
        error: { filename: 'broken.yaml', error: 'unexpected token', errorType: 'parse_error' },
      });

      const response = await app.request('/api/workflows/broken');
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Home workflow file is invalid');
    } finally {
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(tmpHome, { recursive: true, force: true });
    }
  });

  test('project-scope shadows home-scope when same filename exists in both', async () => {
    const testDir = join(tmpdir(), `wf-shadow-test-${Date.now()}`);
    const projectDir = join(testDir, '.archon', 'workflows');
    const tmpHome = join(testDir, 'home');
    const homeWorkflowsDir = join(tmpHome, 'workflows');
    await mkdir(projectDir, { recursive: true });
    await mkdir(homeWorkflowsDir, { recursive: true });
    await writeFile(
      join(projectDir, 'shared.yaml'),
      'name: shared\ndescription: project version\nnodes:\n  - id: plan\n    command: plan\n'
    );
    await writeFile(
      join(homeWorkflowsDir, 'shared.yaml'),
      'name: shared\ndescription: home version\nnodes:\n  - id: plan\n    command: plan\n'
    );

    // Spy on readFile to prove home-scope is not even attempted when project
    // hit succeeds. `parseWorkflow` is globally mocked, so asserting on
    // `body.source` alone can't catch a regression that opens both files.
    const fsPromises = await import('fs/promises');
    const readFileSpy = spyOn(fsPromises, 'readFile');

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tmpHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/shared?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { source: string };
      // Project must shadow home — home lookup should not even be attempted.
      expect(body.source).toBe('project');

      const homePath = join(homeWorkflowsDir, 'shared.yaml');
      const homeWasRead = readFileSpy.mock.calls.some(args => String(args[0]) === homePath);
      expect(homeWasRead).toBe(false);
    } finally {
      readFileSpy.mockRestore();
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('returns WorkflowDefinition shape with expected top-level fields', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows/archon-assist');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workflow: Record<string, unknown>;
    };
    const wf = body.workflow;
    // Guard against silent spec drift if engine's workflowBaseSchema drops or renames fields
    expect(typeof wf['name']).toBe('string');
    expect(typeof wf['description']).toBe('string');
    expect(Array.isArray(wf['nodes'])).toBe(true);
  });

  test('returns a project packaged workflow by its declared name', async () => {
    const testDir = join(tmpdir(), `wf-get-packaged-${Date.now()}`);
    const packageDir = join(testDir, '.archon', 'workflows', 'author-pack', 'release-flow');
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(packageDir, 'definition.yaml'),
      'name: test\ndescription: Packaged\nnodes:\n  - id: plan\n    command: plan\n'
    );
    await writeFile(
      join(testDir, '.archon', 'workflows', 'test.yaml'),
      'name: legacy\ndescription: Filename collision\nnodes: []\n'
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);

      const response = await app.request(`/api/workflows/test?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { source: string; filename: string };
      expect(body.source).toBe('project');
      expect(body.filename).toBe('author-pack/release-flow/definition.yaml');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('surfaces malformed YAML in the requested packaged workflow', async () => {
    const testDir = join(tmpdir(), `wf-get-malformed-packaged-${Date.now()}`);
    const packageDir = join(testDir, '.archon', 'workflows', 'author-pack', 'test');
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'definition.yaml'), 'name: [invalid\nnodes: []\n');

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      mockParseWorkflow.mockReturnValueOnce({
        workflow: null,
        error: {
          filename: 'definition.yaml',
          error: 'unexpected token',
          errorType: 'parse_error',
        },
      });

      const response = await app.request(`/api/workflows/test?cwd=${testDir}`);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain('Workflow file is invalid');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('classifies a package in the app workflow root as bundled', async () => {
    const testDir = join(tmpdir(), `wf-get-source-bundle-${Date.now()}`);
    const workflowsRoot = join(testDir, '.archon', 'workflows');
    const packageDir = join(workflowsRoot, 'author-pack', 'release-flow');
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'definition.yaml'), 'name: test\nnodes: []\n');
    const defaultsPathSpy = spyOn(archonPaths, 'getDefaultWorkflowsPath').mockReturnValue(
      join(workflowsRoot, 'defaults')
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);

      const response = await app.request(`/api/workflows/test?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { source: string };
      expect(body.source).toBe('bundled');
    } finally {
      defaultsPathSpy.mockRestore();
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('keeps a flat workflow in the app workflow root project-scoped', async () => {
    const testDir = join(tmpdir(), `wf-get-source-project-${Date.now()}`);
    const workflowsRoot = join(testDir, '.archon', 'workflows');
    await mkdir(workflowsRoot, { recursive: true });
    await writeFile(join(workflowsRoot, 'test.yaml'), 'name: test\nnodes: []\n');
    const defaultsPathSpy = spyOn(archonPaths, 'getDefaultWorkflowsPath').mockReturnValue(
      join(workflowsRoot, 'defaults')
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);

      const response = await app.request(`/api/workflows/test?cwd=${testDir}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { source: string; filename: string };
      expect(body.source).toBe('project');
      expect(body.filename).toBe('test.yaml');
    } finally {
      defaultsPathSpy.mockRestore();
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/workflows/:name - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // default mock returns /tmp/project; /etc/secrets is not registered
    const response = await app.request('/api/workflows/archon-assist?cwd=/etc/secrets');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });
});

describe('PUT /api/workflows/:name', () => {
  test('returns 400 for invalid name', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/..secret', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'test' } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid workflow name');
  });

  test('returns 400 for missing definition', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/my-workflow', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ other: 'data' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('definition');
  });

  test('falls back to getArchonHome() when no cwd and no codebases registered', async () => {
    const testArchonHome = join(tmpdir(), `archon-home-test-${Date.now()}`);
    process.env.ARCHON_HOME = testArchonHome;

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => []);
      mockParseWorkflow.mockReturnValueOnce({
        workflow: makeTestWorkflow({ name: 'my-workflow', description: 'test' }),
        error: null,
      });

      const response = await app.request('/api/workflows/my-workflow', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: {
            name: 'my-workflow',
            description: 'test',
            nodes: [{ id: 'n1', command: 'assist' }],
          },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { workflow: object; source: string };
      expect(body.source).toBe('project');
    } finally {
      delete process.env.ARCHON_HOME;
      await rm(testArchonHome, { recursive: true, force: true });
    }
  });

  test('returns 400 when definition fails validation', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockParseWorkflow.mockReturnValueOnce({
      workflow: null,
      error: {
        filename: 'test.yaml',
        error: 'missing required fields',
        errorType: 'validation_error',
      },
    });

    const response = await app.request('/api/workflows/my-workflow', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'my-workflow', description: 'bad' } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toContain('invalid');
    expect(body.detail).toBeDefined();
  });

  test('saves valid workflow and returns parsed workflow with source:project', async () => {
    const testDir = join(tmpdir(), `wf-put-test-${Date.now()}`);

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/my-workflow?cwd=${testDir}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: {
            name: 'my-workflow',
            description: 'Test',
            nodes: [{ id: 'plan', command: 'plan' }],
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        workflow: { name: string };
        filename: string;
        source: string;
      };
      expect(body.workflow).toBeDefined();
      expect(body.filename).toBe('my-workflow.yaml');
      expect(body.source).toBe('project');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('saves valid workflow to ARCHON_HOME workflows when source=global', async () => {
    const testArchonHome = join(tmpdir(), `archon-home-put-global-${Date.now()}`);
    process.env.ARCHON_HOME = testArchonHome;

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      const response = await app.request('/api/workflows/global-workflow?source=global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: {
            name: 'global-workflow',
            description: 'Global workflow',
            nodes: [{ id: 'plan', command: 'plan' }],
          },
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        workflow: { name: string };
        filename: string;
        source: string;
      };
      expect(body.workflow).toBeDefined();
      expect(body.filename).toBe('global-workflow.yaml');
      expect(body.source).toBe('global');

      const saved = await readFile(
        join(testArchonHome, 'workflows', 'global-workflow.yaml'),
        'utf-8'
      );
      expect(saved).toContain('name: global-workflow');
    } finally {
      delete process.env.ARCHON_HOME;
      await rm(testArchonHome, { recursive: true, force: true });
    }
  });

  test('returns 400 when source is not project or global', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/some-workflow?source=bundled', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definition: {
          name: 'some-workflow',
          description: 'x',
          nodes: [{ id: 'a', command: 'a' }],
        },
      }),
    });
    expect(response.status).toBe(400);
  });

  test('updates a packaged workflow in place instead of creating a flat duplicate', async () => {
    const testDir = join(tmpdir(), `wf-put-packaged-${Date.now()}`);
    const packageDir = join(testDir, '.archon', 'workflows', 'author-pack', 'release-flow');
    const packagedPath = join(packageDir, 'definition.yaml');
    await mkdir(packageDir, { recursive: true });
    await writeFile(packagedPath, 'name: test\ndescription: Before\nnodes: []\n');
    const collidingFlatPath = join(testDir, '.archon', 'workflows', 'test.yaml');
    await writeFile(
      collidingFlatPath,
      'name: legacy\ndescription: Filename collision\nnodes: []\n'
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);

      const response = await app.request(`/api/workflows/test?cwd=${testDir}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: { name: 'test', description: 'After', nodes: [] },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { filename: string };
      expect(body.filename).toBe('author-pack/release-flow/definition.yaml');
      expect(await readFile(packagedPath, 'utf-8')).toContain('description: After');
      expect(await readFile(collidingFlatPath, 'utf-8')).toContain(
        'description: Filename collision'
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('does not update either package when declared workflow names collide', async () => {
    const testDir = join(tmpdir(), `wf-put-packaged-collision-${Date.now()}`);
    const first = join(testDir, '.archon', 'workflows', 'pack-a', 'flow-a', 'a.yaml');
    const second = join(testDir, '.archon', 'workflows', 'pack-b', 'flow-b', 'b.yaml');
    await mkdir(dirname(first), { recursive: true });
    await mkdir(dirname(second), { recursive: true });
    const firstContent = 'name: test\ndescription: First\nnodes: []\n';
    const secondContent = 'name: test\ndescription: Second\nnodes: []\n';
    await writeFile(first, firstContent);
    await writeFile(second, secondContent);

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/test?cwd=${testDir}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: { name: 'test', description: 'After', nodes: [] } }),
      });

      expect(response.status).toBe(500);
      expect(await readFile(first, 'utf-8')).toBe(firstContent);
      expect(await readFile(second, 'utf-8')).toBe(secondContent);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite a packaged workflow in the app bundled root', async () => {
    const testDir = join(tmpdir(), `wf-put-source-bundle-${Date.now()}`);
    const workflowsRoot = join(testDir, '.archon', 'workflows');
    const packageDir = join(workflowsRoot, 'author-pack', 'release-flow');
    const packagedPath = join(packageDir, 'definition.yaml');
    await mkdir(packageDir, { recursive: true });
    await writeFile(packagedPath, 'name: test\ndescription: Before\nnodes: []\n');
    const defaultsPathSpy = spyOn(archonPaths, 'getDefaultWorkflowsPath').mockReturnValue(
      join(workflowsRoot, 'defaults')
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/test?cwd=${testDir}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition: { name: 'test', description: 'After', nodes: [] } }),
      });

      expect(response.status).toBe(400);
      expect(await readFile(packagedPath, 'utf-8')).toContain('description: Before');
    } finally {
      defaultsPathSpy.mockRestore();
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe('DELETE /api/workflows/:name', () => {
  test('returns 400 for bundled default name', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // archon-assist is in the real BUNDLED_WORKFLOWS
    const response = await app.request('/api/workflows/archon-assist', { method: 'DELETE' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('archon-assist');
  });

  test('returns 404 when workflow file not found', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // Uses real unlink on a path that definitely does not exist → natural ENOENT → 404
    const response = await app.request('/api/workflows/test-nonexistent-workflow-xyz', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('test-nonexistent-workflow-xyz');
  });

  test('falls back to getArchonHome() when no cwd and no codebases, returns 404 for missing file', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    mockListCodebases.mockImplementationOnce(async () => []);

    const response = await app.request('/api/workflows/nonexistent-no-cwd-test', {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('nonexistent-no-cwd-test');
  });

  test('removes existing workflow file and returns deleted:true', async () => {
    const testDir = join(tmpdir(), `wf-del-test-${Date.now()}`);
    const workflowDir = join(testDir, '.archon', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'to-delete.yaml'),
      'name: x\ndescription: y\nnodes:\n  - id: z\n    command: z\n'
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/to-delete?cwd=${testDir}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { deleted: boolean; name: string };
      expect(body.deleted).toBe(true);
      expect(body.name).toBe('to-delete');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('removes workflow stored only as .yml and returns deleted:true', async () => {
    const testDir = join(tmpdir(), `wf-del-yml-test-${Date.now()}`);
    const workflowDir = join(testDir, '.archon', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    const ymlPath = join(workflowDir, 'to-delete-yml.yml');
    await writeFile(ymlPath, 'name: x\ndescription: y\nnodes:\n  - id: z\n    command: z\n');

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/to-delete-yml?cwd=${testDir}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { deleted: boolean; name: string };
      expect(body.deleted).toBe(true);
      expect(body.name).toBe('to-delete-yml');
      await expect(access(ymlPath)).rejects.toThrow();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('removes both .yaml and .yml twins so neither stays discoverable', async () => {
    const testDir = join(tmpdir(), `wf-del-twin-test-${Date.now()}`);
    const workflowDir = join(testDir, '.archon', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    const yamlPath = join(workflowDir, 'twin.yaml');
    const ymlPath = join(workflowDir, 'twin.yml');
    await writeFile(yamlPath, 'name: twin\ndescription: yaml\nnodes:\n  - id: z\n    command: z\n');
    await writeFile(ymlPath, 'name: twin\ndescription: yml\nnodes:\n  - id: z\n    command: z\n');

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/twin?cwd=${testDir}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { deleted: boolean; name: string };
      expect(body.deleted).toBe(true);
      expect(body.name).toBe('twin');
      // Both variants must be gone — a surviving twin would stay active.
      await expect(access(yamlPath)).rejects.toThrow();
      await expect(access(ymlPath)).rejects.toThrow();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('removes home-scoped .yml workflow when source=global', async () => {
    const testArchonHome = join(tmpdir(), `archon-home-del-yml-${Date.now()}`);
    const workflowDir = join(testArchonHome, 'workflows');
    await mkdir(workflowDir, { recursive: true });
    const ymlPath = join(workflowDir, 'home-yml-delete.yml');
    await writeFile(ymlPath, 'name: x\ndescription: y\nnodes:\n  - id: z\n    command: z\n');

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = testArchonHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      const response = await app.request('/api/workflows/home-yml-delete?source=global', {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { deleted: boolean; name: string };
      expect(body.deleted).toBe(true);
      expect(body.name).toBe('home-yml-delete');
      await expect(access(ymlPath)).rejects.toThrow();
    } finally {
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(testArchonHome, { recursive: true, force: true });
    }
  });

  test('removes home-scoped workflow file when source=global', async () => {
    const testArchonHome = join(tmpdir(), `archon-home-del-global-${Date.now()}`);
    const workflowDir = join(testArchonHome, 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'home-to-delete.yaml'),
      'name: home-to-delete\ndescription: y\nnodes:\n  - id: z\n    command: z\n'
    );

    const prevArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = testArchonHome;
    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

      const response = await app.request('/api/workflows/home-to-delete?source=global', {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { deleted: boolean; name: string };
      expect(body.deleted).toBe(true);
      expect(body.name).toBe('home-to-delete');

      // Confirm the file is gone from the home-scoped location.
      const fsPromises = await import('fs/promises');
      await expect(fsPromises.access(join(workflowDir, 'home-to-delete.yaml'))).rejects.toThrow();
    } finally {
      if (prevArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = prevArchonHome;
      }
      await rm(testArchonHome, { recursive: true, force: true });
    }
  });

  test('returns 400 when source is not project or global', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/some-workflow?source=bundled', {
      method: 'DELETE',
    });
    expect(response.status).toBe(400);
  });

  test('deletes a packaged workflow by its declared name', async () => {
    const testDir = join(tmpdir(), `wf-delete-packaged-${Date.now()}`);
    const packageDir = join(testDir, '.archon', 'workflows', 'author-pack', 'release-flow');
    const packagedPath = join(packageDir, 'definition.yaml');
    await mkdir(packageDir, { recursive: true });
    await writeFile(packagedPath, 'name: test\ndescription: Packaged\nnodes: []\n');

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);

      const response = await app.request(`/api/workflows/test?cwd=${testDir}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      await expect(access(packageDir)).rejects.toThrow();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('does not delete either package when declared workflow names collide', async () => {
    const testDir = join(tmpdir(), `wf-delete-packaged-collision-${Date.now()}`);
    const first = join(testDir, '.archon', 'workflows', 'pack-a', 'flow-a', 'a.yaml');
    const second = join(testDir, '.archon', 'workflows', 'pack-b', 'flow-b', 'b.yaml');
    await mkdir(dirname(first), { recursive: true });
    await mkdir(dirname(second), { recursive: true });
    await writeFile(first, 'name: test\nnodes: []\n');
    await writeFile(second, 'name: test\nnodes: []\n');

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/test?cwd=${testDir}`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(500);
      await access(first);
      await access(second);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test('refuses to delete a packaged workflow in the app bundled root', async () => {
    const testDir = join(tmpdir(), `wf-delete-source-bundle-${Date.now()}`);
    const workflowsRoot = join(testDir, '.archon', 'workflows');
    const packageDir = join(workflowsRoot, 'author-pack', 'release-flow');
    const packagedPath = join(packageDir, 'definition.yaml');
    await mkdir(packageDir, { recursive: true });
    await writeFile(packagedPath, 'name: test\nnodes: []\n');
    const defaultsPathSpy = spyOn(archonPaths, 'getDefaultWorkflowsPath').mockReturnValue(
      join(workflowsRoot, 'defaults')
    );

    try {
      const app = createTestApp();
      registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);
      mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: testDir }]);
      const response = await app.request(`/api/workflows/test?cwd=${testDir}`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(400);
      await access(packagedPath);
    } finally {
      defaultsPathSpy.mockRestore();
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/workflows - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // default mock returns /tmp/project; /etc is not registered
    const response = await app.request('/api/workflows?cwd=/etc');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });

  test('accepts cwd matching a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    // default mock returns /tmp/project
    const response = await app.request('/api/workflows?cwd=/tmp/project');
    expect(response.status).toBe(200);
  });
});

describe('PUT /api/workflows/:name - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/my-workflow?cwd=/etc/secrets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition: { name: 'my-workflow', description: 'test', nodes: [] } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });
});

describe('DELETE /api/workflows/:name - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/workflows/some-workflow?cwd=/etc/secrets', {
      method: 'DELETE',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });
});

describe('GET /api/commands - cwd validation', () => {
  test('returns 400 when cwd is not a registered codebase path', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/commands?cwd=/etc/secrets');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Invalid cwd');
  });
});

describe('GET /api/commands', () => {
  test('returns commands array', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    expect(Array.isArray(body.commands)).toBe(true);
  });

  test('includes bundled commands with source:bundled', async () => {
    const app = createTestApp();
    registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

    const response = await app.request('/api/commands');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commands: Array<{ name: string; source: string }> };
    // archon-assist is in the real BUNDLED_COMMANDS
    const archonAssist = body.commands.find(c => c.name === 'archon-assist');
    expect(archonAssist).toBeDefined();
    expect(archonAssist?.source).toBe('bundled');
  });

  test.skipIf(process.platform === 'win32')(
    'includes symlinked project command with source:project',
    async () => {
      const projectDir = join(
        tmpdir(),
        `archon-api-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const sourceDir = join(
        tmpdir(),
        `archon-api-commands-source-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );

      try {
        await mkdir(join(projectDir, '.archon', 'commands'), { recursive: true });
        await mkdir(sourceDir, { recursive: true });
        await writeFile(join(sourceDir, 'linked.md'), '# Linked command');
        await fsSymlink(
          join(sourceDir, 'linked.md'),
          join(projectDir, '.archon', 'commands', 'linked.md')
        );
        mockListCodebases.mockImplementationOnce(async () => [{ default_cwd: projectDir }]);

        const app = createTestApp();
        registerApiRoutes(app, {} as WebAdapter, {} as ConversationLockManager);

        const response = await app.request(`/api/commands?cwd=${encodeURIComponent(projectDir)}`);

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          commands: Array<{ name: string; source: string }>;
        };
        expect(body.commands).toContainEqual({ name: 'linked', source: 'project' });
      } finally {
        await rm(projectDir, { recursive: true, force: true });
        await rm(sourceDir, { recursive: true, force: true });
      }
    }
  );
});

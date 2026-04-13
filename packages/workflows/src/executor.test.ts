/**
 * Tests for executeWorkflow() — the top-level orchestration function.
 * Covers concurrent-run guards, model/provider resolution, and resume logic
 * that the inner dag-executor.test.ts cannot reach.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// --- Mock logger ---
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: mock(() => null),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
}));

// --- Mock git ---
mock.module('@archon/git', () => ({
  getDefaultBranch: mock(async () => 'main'),
  toRepoPath: mock((p: string) => p),
}));

// --- Mock dag-executor ---
const mockExecuteDagWorkflow = mock(async (): Promise<string | undefined> => undefined);
mock.module('./dag-executor', () => ({
  executeDagWorkflow: mockExecuteDagWorkflow,
}));

// --- Mock logger functions ---
mock.module('./logger', () => ({
  logWorkflowStart: mock(async () => {}),
  logWorkflowError: mock(async () => {}),
}));

// --- Mock event emitter ---
const mockEmitter = {
  registerRun: mock(() => {}),
  unregisterRun: mock(() => {}),
  emit: mock(() => {}),
};
mock.module('./event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => mockEmitter),
}));

// --- Bootstrap provider registry (after path mocks) ---
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// --- Import after mocks ---
import { executeWorkflow } from './executor';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowDefinition, WorkflowRun } from './schemas';

// --- Helpers ---

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    createWorkflowEvent: mock(async () => {}),
    findResumableRun: mock(async () => null),
    getCompletedDagNodeOutputs: mock(async () => new Map()),
    resumeWorkflowRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    ...overrides,
  };
}

function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(async () => {}),
    getPlatformType: mock(() => 'test' as const),
  } as unknown as IWorkflowPlatform;
}

function makeDeps(store?: IWorkflowStore): WorkflowDeps {
  return {
    store: store ?? makeStore(),
    loadConfig: mock(
      async (): Promise<WorkflowConfig> => ({
        assistant: 'claude' as const,
        assistants: {
          claude: {},
          codex: {},
        },
        baseBranch: '',
        commands: { folder: '' },
      })
    ),
    getAgentProvider: mock(() => ({
      run: mock(async () => {}),
    })),
  } as unknown as WorkflowDeps;
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'test-workflow',
    description: 'Test',
    nodes: [{ id: 'node1', prompt: 'Do something' }],
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    status: 'running',
    started_at: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

describe('executeWorkflow', () => {
  beforeEach(() => {
    mockLogFn.mockClear();
    mockExecuteDagWorkflow.mockClear();
    mockEmitter.registerRun.mockClear();
    mockEmitter.unregisterRun.mockClear();
    mockEmitter.emit.mockClear();
    mockExecuteDagWorkflow.mockImplementation(async (): Promise<string | undefined> => undefined);
  });

  // -------------------------------------------------------------------------
  // Concurrent-run guard
  // -------------------------------------------------------------------------

  describe('concurrent-run guard', () => {
    it('allows workflow when no active workflow exists', async () => {
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => null) });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.workflowRunId).toBe('run-123');
    });

    it('blocks workflow when active workflow check fails', async () => {
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => {
          throw new Error('DB connection lost');
        }),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });

    it('blocks workflow when another is actively running', async () => {
      const activeRun = makeRun({
        status: 'running',
        started_at: new Date().toISOString(), // Recent — not stale
      });
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => activeRun),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('already running');
    });
  });

  // -------------------------------------------------------------------------
  // Model/provider resolution
  // -------------------------------------------------------------------------

  describe('model/provider resolution', () => {
    it('uses default provider from config when workflow has no provider or model', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      // Should succeed — uses config.assistant (claude) as default
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    });

    it('infers claude provider when workflow sets a claude model alias', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      // config.assistant defaults to 'claude', model 'sonnet' is a claude alias
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ model: 'sonnet' }),
        'test message',
        'db-conv-1'
      );
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    });

    it('throws when model is incompatible with explicit provider', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await expect(
        executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ provider: 'codex', model: 'sonnet' }),
          'test message',
          'db-conv-1'
        )
      ).rejects.toThrow('not compatible');
    });
  });

  // -------------------------------------------------------------------------
  // $DOCS_DIR default resolution
  // -------------------------------------------------------------------------

  describe('docsDir resolution', () => {
    it('passes docs/ default when config.docsPath is undefined', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
      // docsDir is arg index 11 (0-indexed) of executeDagWorkflow
      const docsDir = mockExecuteDagWorkflow.mock.calls[0]?.[11];
      expect(docsDir).toBe('docs/');
    });

    it('passes configured docsPath when set', async () => {
      const store = makeStore();
      const deps = {
        store,
        loadConfig: mock(
          async (): Promise<WorkflowConfig> => ({
            assistant: 'claude' as const,
            assistants: { claude: {}, codex: {} },
            baseBranch: '',
            commands: { folder: '' },
            docsPath: 'packages/docs-web/src/content/docs',
          })
        ),
        getAgentProvider: mock(() => ({
          run: mock(async () => {}),
        })),
      } as unknown as WorkflowDeps;
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
      const docsDir = mockExecuteDagWorkflow.mock.calls[0]?.[11];
      expect(docsDir).toBe('packages/docs-web/src/content/docs');
    });
  });

  // -------------------------------------------------------------------------
  // Resume logic
  // -------------------------------------------------------------------------

  describe('resume logic', () => {
    it('starts fresh run when findResumableRun returns null', async () => {
      const store = makeStore({
        findResumableRun: mock(async () => null),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
      expect(result.workflowRunId).toBe('run-123');
    });

    it('starts fresh run when findResumableRun throws', async () => {
      const store = makeStore({
        findResumableRun: mock(async () => {
          throw new Error('DB error');
        }),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      // Should fall back to creating a fresh run
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
      expect(result.workflowRunId).toBe('run-123');
    });

    it('starts fresh run when prior run has 0 completed nodes', async () => {
      const failedRun = makeRun({ id: 'prior-run', status: 'failed' });
      const store = makeStore({
        findResumableRun: mock(async () => failedRun),
        getCompletedDagNodeOutputs: mock(async () => new Map()),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      // Should skip resume and create a fresh run
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
    });

    it('returns error when resumeWorkflowRun throws', async () => {
      const failedRun = makeRun({ id: 'prior-run', status: 'failed' });
      const priorNodes = new Map([['node1', 'output1']]);
      const store = makeStore({
        findResumableRun: mock(async () => failedRun),
        getCompletedDagNodeOutputs: mock(async () => priorNodes),
        resumeWorkflowRun: mock(async () => {
          throw new Error('Resume DB error');
        }),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error resuming');
    });
  });

  // -------------------------------------------------------------------------
  // Summary propagation
  // -------------------------------------------------------------------------

  describe('summary propagation', () => {
    it('passes dag summary from executeDagWorkflow into WorkflowExecutionResult', async () => {
      mockExecuteDagWorkflow.mockResolvedValueOnce('This is the workflow summary');
      const store = makeStore();
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.summary).toBe('This is the workflow summary');
      }
    });

    it('passes undefined summary when executeDagWorkflow returns undefined', async () => {
      mockExecuteDagWorkflow.mockResolvedValueOnce(undefined);
      const store = makeStore();
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.summary).toBeUndefined();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Pre-created run (uses existing row but still runs guards)
  // -------------------------------------------------------------------------

  describe('pre-created run', () => {
    it('uses pre-created run row but still runs concurrent-run check', async () => {
      const preRun = makeRun({ id: 'pre-run-1' });
      const store = makeStore();
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        undefined,
        undefined,
        undefined,
        undefined,
        preRun
      );
      // Guards still run (no bypass)
      expect(store.getActiveWorkflowRunByPath).toHaveBeenCalled();
      // But uses the pre-created run instead of creating a new one
      expect(store.createWorkflowRun).not.toHaveBeenCalled();
      expect(result.workflowRunId).toBe('pre-run-1');
    });
  });

  // -------------------------------------------------------------------------
  // DB env var merge
  // -------------------------------------------------------------------------

  describe('DB env var merge', () => {
    it('merges DB env vars on top of file config envVars when codebaseId provided', async () => {
      const store = makeStore({
        getCodebaseEnvVars: mock(async () => ({ DB_KEY: 'db_val' })),
      });
      const deps = makeDeps(store);
      // Override loadConfig to return file-level envVars
      (deps.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude' as const,
        assistants: { claude: {}, codex: {} },
        baseBranch: '',
        commands: { folder: '' },
        envVars: { FILE_KEY: 'file_val' },
      });

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        'codebase-1'
      );

      // DB env vars should have been fetched for the codebaseId
      expect(store.getCodebaseEnvVars).toHaveBeenCalledWith('codebase-1');

      // The config passed to executeDagWorkflow (arg index 12) should have merged envVars
      const configArg = mockExecuteDagWorkflow.mock.calls[0]?.[12] as WorkflowConfig | undefined;
      expect(configArg?.envVars).toEqual({ FILE_KEY: 'file_val', DB_KEY: 'db_val' });
    });

    it('does not call getCodebaseEnvVars when no codebaseId', async () => {
      const store = makeStore();
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
        // no codebaseId
      );

      expect(store.getCodebaseEnvVars).not.toHaveBeenCalled();
    });
  });
});

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
import { cleanWorkflowDescriptionForStartup, executeWorkflow } from './executor';
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

  describe('startup description cleanup', () => {
    it('strips Korean and English routing labels from startup descriptions', () => {
      const cleaned = cleanWorkflowDescriptionForStartup(
        `사용할 때: PR complexity에 맞춰 review할 때.
트리거 예시: "smart review".
하는 일: PR scope 수집 -> complexity 분류 -> 관련 review agent만 라우팅.
사용하지 않을 때: 모든 review agent가 필요할 때.
Use when: English metadata.
Does: English body remains.`,
        'archon-smart-pr-review'
      );

      expect(cleaned).toContain('하는 일: PR scope 수집');
      expect(cleaned).toContain('Does: English body remains.');
      expect(cleaned).not.toContain('사용할 때:');
      expect(cleaned).not.toContain('트리거 예시:');
      expect(cleaned).not.toContain('사용하지 않을 때:');
      expect(cleaned).not.toContain('Use when:');
    });

    it('falls back to workflow name when only routing labels remain', () => {
      const cleaned = cleanWorkflowDescriptionForStartup(
        `사용할 때: 다른 workflow가 맞지 않을 때.
트리거 예시: "assist".`,
        'archon-assist'
      );

      expect(cleaned).toBe('archon-assist');
    });
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
        id: 'other-run-456',
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
      expect(result.error).toContain('already active');
    });

    it('passes self-id and started_at to the lock query so self is excluded', async () => {
      // The guard runs AFTER workflowRun is finalized so we always have
      // a self-ID. Without these args, the dispatch's own row would match
      // and falsely trigger the guard.
      const selfRun = makeRun({ id: 'self-run-789', started_at: '2026-04-14T10:00:00.000Z' });
      const getActiveSpy = mock(async () => null);
      const store = makeStore({
        createWorkflowRun: mock(async () => selfRun),
        getActiveWorkflowRunByPath: getActiveSpy,
      });
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

      expect(getActiveSpy).toHaveBeenCalledWith(
        '/tmp',
        expect.objectContaining({ id: 'self-run-789', startedAt: expect.any(Date) })
      );
    });

    it('marks self as cancelled when guard fires (no zombie pending row)', async () => {
      const selfRun = makeRun({ id: 'self-run-789' });
      const otherRun = makeRun({ id: 'other-run-456', status: 'running' });
      const updateSpy = mock(async () => {});
      const store = makeStore({
        createWorkflowRun: mock(async () => selfRun),
        getActiveWorkflowRunByPath: mock(async () => otherRun),
        updateWorkflowRun: updateSpy,
      });
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

      // Without this, every guard-blocked dispatch would leak a `pending`
      // row that briefly blocks future dispatches via the lock query.
      expect(updateSpy).toHaveBeenCalledWith('self-run-789', { status: 'cancelled' });
    });

    it('uses the actionable "in use" message format with workflow name, duration, and short id', async () => {
      const otherRun = makeRun({
        id: 'abc12345-rest-of-uuid',
        workflow_name: 'archon-implement',
        status: 'running',
        started_at: new Date(Date.now() - 125000).toISOString(), // 2m 5s ago
      });
      const sendMessageSpy = mock(async () => {});
      const platform = {
        sendMessage: sendMessageSpy,
        getPlatformType: mock(() => 'test' as const),
      } as unknown as IWorkflowPlatform;
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => otherRun),
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        platform,
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );

      expect(sendMessageSpy).toHaveBeenCalled();
      const sentMessage = (sendMessageSpy.mock.calls[0] as [string, string])[1];
      expect(sentMessage).toContain('archon-implement');
      expect(sentMessage).toContain('abc12345');
      expect(sentMessage).toContain('2m 5s');
      // Concrete next actions — every line tells the user something to do.
      expect(sentMessage).toContain('/workflow status');
      expect(sentMessage).toContain('/workflow cancel abc12345');
      expect(sentMessage).toContain('--branch');
    });

    it('still returns failure when guard self-cancel update throws (best-effort)', async () => {
      const selfRun = makeRun({ id: 'self-run', status: 'pending' });
      const otherRun = makeRun({ id: 'other-run', status: 'running' });
      const updateSpy = mock(async (id: string) => {
        // Self-cancel attempt fails — must not crash, must still surface
        // the "in use" failure to the user.
        if (id === 'self-run') throw new Error('Update failed');
      });
      const store = makeStore({
        createWorkflowRun: mock(async () => selfRun),
        getActiveWorkflowRunByPath: mock(async () => otherRun),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test',
        'db-conv-1'
      );

      // Cleanup failure must not mask the "in use" outcome.
      expect(result.success).toBe(false);
      expect(result.error).toContain('already active');
    });
  });

  // -------------------------------------------------------------------------
  // Resume orphan cleanup
  // -------------------------------------------------------------------------

  describe('resume orphan cleanup', () => {
    it('cancels orphaned pre-created row when resume activates', async () => {
      // Orchestrator dispatched and pre-created this row before resume
      // detection ran. Once resume takes over (using resumableRun instead),
      // the pre-created row is a stale lock-token that would block the
      // user's next back-to-back resume.
      const preCreated = makeRun({ id: 'pre-created-orphan', status: 'pending' });
      const resumable = makeRun({ id: 'failed-prior-run', status: 'failed' });
      const updateSpy = mock(async () => {});
      const store = makeStore({
        findResumableRun: mock(async () => resumable),
        getCompletedDagNodeOutputs: mock(async () => new Map([['node1', 'output1']])),
        resumeWorkflowRun: mock(async () => makeRun({ id: 'failed-prior-run', status: 'running' })),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      await executeWorkflow(
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
        preCreated
      );

      // Find the orphan-cancellation call (there may be other updateWorkflowRun
      // calls during normal execution flow, e.g., status transitions).
      const orphanCancelCall = updateSpy.mock.calls.find(
        (call: unknown[]) =>
          call[0] === 'pre-created-orphan' &&
          (call[1] as { status?: string })?.status === 'cancelled'
      );
      expect(orphanCancelCall).toBeDefined();
    });

    it('proceeds with resume even if orphan cancellation fails (best-effort)', async () => {
      const preCreated = makeRun({ id: 'pre-created-orphan', status: 'pending' });
      const resumable = makeRun({ id: 'failed-prior-run', status: 'failed' });
      const updateSpy = mock(async (id: string) => {
        if (id === 'pre-created-orphan') throw new Error('DB busy');
      });
      const store = makeStore({
        findResumableRun: mock(async () => resumable),
        getCompletedDagNodeOutputs: mock(async () => new Map([['node1', 'output1']])),
        resumeWorkflowRun: mock(async () => makeRun({ id: 'failed-prior-run', status: 'running' })),
        updateWorkflowRun: updateSpy,
      });
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
        preCreated
      );

      // Resume must still complete — the 5-min stale-pending window is the
      // safety net for cleanup failures here.
      expect(result.workflowRunId).toBe('failed-prior-run');
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

  // -------------------------------------------------------------------------
  // Lock-token cleanup on pre-DAG failure paths (review #1)
  //
  // Any failure between row creation and DAG start that returns early must
  // release the lock token. Without this, ghost pending/running rows block
  // the path until the 5-min stale window or manual intervention.
  // -------------------------------------------------------------------------

  describe('lock cleanup on failure paths', () => {
    it('cancels pre-created row when resumeWorkflowRun throws', async () => {
      const preCreated = makeRun({ id: 'pre-created-orphan', status: 'pending' });
      const resumable = makeRun({ id: 'failed-prior-run', status: 'failed' });
      const updateSpy = mock(async () => {});
      const store = makeStore({
        findResumableRun: mock(async () => resumable),
        getCompletedDagNodeOutputs: mock(async () => new Map([['node1', 'out1']])),
        resumeWorkflowRun: mock(async () => {
          throw new Error('DB blew up during resume activation');
        }),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test',
        'db-conv-1',
        undefined,
        undefined,
        undefined,
        undefined,
        preCreated
      );

      expect(result.success).toBe(false);
      const cancelCall = updateSpy.mock.calls.find(
        (call: unknown[]) =>
          call[0] === 'pre-created-orphan' &&
          (call[1] as { status?: string })?.status === 'cancelled'
      );
      expect(cancelCall).toBeDefined();
    });

    it('cancels workflowRun when guard query throws (no zombie row)', async () => {
      const updateSpy = mock(async () => {});
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => {
          throw new Error('DB connection lost during guard');
        }),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test',
        'db-conv-1'
      );

      expect(result.success).toBe(false);
      const cancelCall = updateSpy.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: string })?.status === 'cancelled'
      );
      expect(cancelCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Status-aware blocking message (review #3)
  //
  // The lock query returns running, paused, AND fresh-pending rows.
  // Telling a user to "wait" when the holder is `paused` is misleading —
  // they need to approve/reject to unblock it.
  // -------------------------------------------------------------------------

  describe('blocking message status awareness', () => {
    it('uses paused-specific copy when blocker is paused', async () => {
      const pausedRun = makeRun({
        id: 'paused-run-id',
        workflow_name: 'archon-implement',
        status: 'paused',
        started_at: new Date(Date.now() - 10000).toISOString(),
      });
      const sendMessageSpy = mock(async () => {});
      const platform = {
        sendMessage: sendMessageSpy,
        getPlatformType: mock(() => 'test' as const),
      } as unknown as IWorkflowPlatform;
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => pausedRun) });
      const deps = makeDeps(store);

      await executeWorkflow(deps, platform, 'conv-1', '/tmp', makeWorkflow(), 'test', 'db-conv-1');

      const msg = (sendMessageSpy.mock.calls[0] as [string, string])[1];
      // Wrong action ("wait for it to finish") would let users sit forever
      // on a workflow waiting for their own approval.
      expect(msg).toContain('paused');
      expect(msg).toContain('/workflow approve');
      expect(msg).toContain('/workflow reject');
      expect(msg).not.toContain('Wait for it to finish');
    });

    it('uses pending-specific copy when blocker is just starting', async () => {
      const pendingRun = makeRun({
        id: 'pending-run',
        workflow_name: 'archon-implement',
        status: 'pending',
        started_at: new Date(Date.now() - 500).toISOString(),
      });
      const sendMessageSpy = mock(async () => {});
      const platform = {
        sendMessage: sendMessageSpy,
        getPlatformType: mock(() => 'test' as const),
      } as unknown as IWorkflowPlatform;
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => pendingRun) });
      const deps = makeDeps(store);

      await executeWorkflow(deps, platform, 'conv-1', '/tmp', makeWorkflow(), 'test', 'db-conv-1');

      const msg = (sendMessageSpy.mock.calls[0] as [string, string])[1];
      expect(msg).toContain('starting');
    });

    it('uses running copy by default', async () => {
      const runningRun = makeRun({
        id: 'running-run',
        workflow_name: 'archon-implement',
        status: 'running',
        started_at: new Date(Date.now() - 60000).toISOString(),
      });
      const sendMessageSpy = mock(async () => {});
      const platform = {
        sendMessage: sendMessageSpy,
        getPlatformType: mock(() => 'test' as const),
      } as unknown as IWorkflowPlatform;
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => runningRun) });
      const deps = makeDeps(store);

      await executeWorkflow(deps, platform, 'conv-1', '/tmp', makeWorkflow(), 'test', 'db-conv-1');

      const msg = (sendMessageSpy.mock.calls[0] as [string, string])[1];
      expect(msg).toContain('running 1m');
      expect(msg).toContain('Wait for it to finish');
    });
  });
});

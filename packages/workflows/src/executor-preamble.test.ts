/**
 * Tests for the executeWorkflow() preamble: concurrent-run guard, staleness
 * detection, and resume logic.  These run before DAG dispatch and are exercised
 * with minimal DAG workflow fixtures.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowDefinition, WorkflowRun } from './schemas';

// ---------------------------------------------------------------------------
// Mock logger (must precede all module-under-test imports)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock git
// ---------------------------------------------------------------------------

mock.module('@archon/git', () => ({
  getDefaultBranch: mock(async () => 'main'),
  toRepoPath: mock((p: string) => p),
}));

// ---------------------------------------------------------------------------
// Mock dag-executor (we only care about the preamble, not DAG execution)
// ---------------------------------------------------------------------------

const mockExecuteDagWorkflow = mock(async () => {});
mock.module('./dag-executor', () => ({
  executeDagWorkflow: mockExecuteDagWorkflow,
}));

// ---------------------------------------------------------------------------
// Mock logger / event-emitter modules
// ---------------------------------------------------------------------------

mock.module('./logger', () => ({
  logWorkflowStart: mock(async () => {}),
  logWorkflowError: mock(async () => {}),
}));

const mockEmitter = {
  registerRun: mock(() => {}),
  unregisterRun: mock(() => {}),
  emit: mock(() => {}),
};
mock.module('./event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => mockEmitter),
}));

// ---------------------------------------------------------------------------
// Bootstrap provider registry (executor calls isRegisteredProvider at workflow level)
// ---------------------------------------------------------------------------

import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { executeWorkflow } from './executor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    getWorkflowRunStatus: mock(async () => 'completed' as const),
    createWorkflowEvent: mock(async () => {}),
    findResumableRun: mock(async () => null),
    getCompletedDagNodeOutputs: mock(async () => new Map<string, string>()),
    resumeWorkflowRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    ...overrides,
  };
}

function makePlatform(): IWorkflowPlatform & { sendMessage: ReturnType<typeof mock> } {
  return {
    sendMessage: mock(async () => {}),
    getPlatformType: mock(() => 'test' as const),
  } as unknown as IWorkflowPlatform & { sendMessage: ReturnType<typeof mock> };
}

function makeDeps(store?: IWorkflowStore): WorkflowDeps {
  return {
    store: store ?? makeStore(),
    loadConfig: mock(
      async (): Promise<WorkflowConfig> => ({
        assistant: 'claude' as const,
        assistants: { claude: {}, codex: {} },
        baseBranch: '',
        commands: { folder: '' },
      })
    ),
    getAgentProvider: mock(() => ({
      run: mock(async () => {}),
    })),
  } as unknown as WorkflowDeps;
}

/** Minimal DAG workflow fixture — the preamble doesn't care about node details */
function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'test-workflow',
    description: 'Test',
    nodes: [{ id: 'test', command: 'test' }],
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

/** Find a platform message containing the given text */
function findMessage(platform: IWorkflowPlatform, text: string): unknown[] | undefined {
  const sendMessage = platform.sendMessage as ReturnType<typeof mock>;
  return sendMessage.mock.calls.find(
    (call: unknown[]) => typeof call[1] === 'string' && (call[1] as string).includes(text)
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeWorkflow preamble', () => {
  beforeEach(() => {
    mockLogFn.mockClear();
    mockExecuteDagWorkflow.mockClear();
    mockEmitter.registerRun.mockClear();
    mockEmitter.unregisterRun.mockClear();
    mockEmitter.emit.mockClear();
    mockExecuteDagWorkflow.mockImplementation(async () => {});
  });

  // -------------------------------------------------------------------------
  // Concurrent run guard (path-based)
  // -------------------------------------------------------------------------

  describe('concurrent run guard', () => {
    it('should block new workflow when a running workflow exists on the same path', async () => {
      const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const activeRun = makeRun({
        id: 'active-workflow-id',
        workflow_name: 'active-workflow',
        started_at: recentTime,
        status: 'running',
      });
      const updateSpy = mock(async () => {});
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => activeRun),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);
      const platform = makePlatform();

      const result = await executeWorkflow(
        deps,
        platform,
        'conv-123',
        '/tmp',
        makeWorkflow(),
        'User message',
        'db-conv-id'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('already active');

      // Actionable rejection message was sent (mentions worktree-in-use,
      // workflow name, and concrete next-action commands)
      const blockCall = findMessage(platform, 'in use');
      expect(blockCall).toBeDefined();
      const blockMsg = blockCall?.[1] as string;
      expect(blockMsg).toContain('active-workflow');
      expect(blockMsg).toContain('/workflow cancel');

      // The guard now runs AFTER the row is created (so it always has a
      // self-ID to exclude). On guard fire, the just-created row is marked
      // cancelled — preventing zombie pending rows that would block future
      // dispatches.
      expect((store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
      const cancelCall = updateSpy.mock.calls.find(
        (call: unknown[]) => (call[1] as { status?: string })?.status === 'cancelled'
      );
      expect(cancelCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent workflow detection
  // -------------------------------------------------------------------------

  describe('concurrent workflow detection', () => {
    it('should allow workflow when no active workflow for conversation', async () => {
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => null) });
      const deps = makeDeps(store);
      const platform = makePlatform();

      const result = await executeWorkflow(
        deps,
        platform,
        'conv-123',
        '/tmp',
        makeWorkflow(),
        'new workflow',
        'db-conv-123'
      );

      expect(
        (store.getActiveWorkflowRunByPath as ReturnType<typeof mock>).mock.calls.length
      ).toBeGreaterThan(0);
      expect(
        (store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length
      ).toBeGreaterThan(0);
      expect(result.workflowRunId).toBe('run-123');
    });

    it('should use working directory (cwd) for active workflow check', async () => {
      const store = makeStore();
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'platform-conv-456',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-456',
        'codebase-789'
      );

      const activeCheckCalls = (store.getActiveWorkflowRunByPath as ReturnType<typeof mock>).mock
        .calls;
      expect(activeCheckCalls.length).toBeGreaterThan(0);
      // Must use the working directory path, not the conversation ID
      expect(activeCheckCalls[0][0]).toBe('/tmp');
    });

    it('should block workflow when active workflow check fails', async () => {
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => {
          throw new Error('Database connection lost');
        }),
      });
      const deps = makeDeps(store);
      const platform = makePlatform();

      const result = await executeWorkflow(
        deps,
        platform,
        'conv-123',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');

      // The row is created BEFORE the guard runs (so the guard can exclude
      // self). When the lock query throws, we abort early — the just-created
      // row stays as 'pending' and falls out via the 5-min stale window.
      expect((store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);

      // Error message was sent
      const errorMsg =
        findMessage(platform, 'Unable to verify') || findMessage(platform, 'Workflow blocked');
      expect(errorMsg).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Workflow resume (DAG)
  // -------------------------------------------------------------------------

  describe('workflow resume', () => {
    it('uses caller-supplied preCreatedRun + priorCompletedNodes without re-querying the store', async () => {
      // The caller has already run hydrateResumableRun and hands the result
      // to executeWorkflow. The executor must NOT touch findResumableRun on
      // its own — that decision lives at the caller.
      const resumedRun = makeRun({ id: 'prior-run', status: 'running' });
      const priorCompletedNodes = new Map([['node-a', 'output from node-a']]);

      const findSpy = mock(async () => null);
      const store = makeStore({ findResumableRun: findSpy });
      const deps = makeDeps(store);
      const platform = makePlatform();

      const result = await executeWorkflow(
        deps,
        platform,
        'conv-123',
        '/tmp',
        makeWorkflow(),
        'User message',
        'db-conv-id',
        { preCreatedRun: resumedRun, priorCompletedNodes }
      );

      // Executor never queries findResumableRun (caller did it via hydrateResumableRun).
      expect(findSpy).not.toHaveBeenCalled();
      // No createWorkflowRun — caller supplied the resumed run.
      expect((store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
      // Resume notification was sent to user with the completed-node count.
      const resumeMsg = findMessage(platform, 'Resuming');
      expect(resumeMsg).toBeDefined();
      expect((resumeMsg as unknown[])[1]).toContain('1 already-completed node(s)');
      // Workflow run ID is the resumed run.
      expect(result.workflowRunId).toBe('prior-run');
    });

    it('sends interactive-loop notification when priorCompletedNodes is empty (paused approval gate)', async () => {
      const resumedRun = makeRun({ id: 'paused-loop-run', status: 'running' });
      const priorCompletedNodes = new Map<string, string>();

      const store = makeStore();
      const deps = makeDeps(store);
      const platform = makePlatform();

      const result = await executeWorkflow(
        deps,
        platform,
        'conv-123',
        '/tmp',
        makeWorkflow(),
        'User message',
        'db-conv-id',
        { preCreatedRun: resumedRun, priorCompletedNodes }
      );

      const resumeMsg = findMessage(platform, 'continuing interactive loop');
      expect(resumeMsg).toBeDefined();
      expect(result.workflowRunId).toBe('paused-loop-run');
    });

    it('does NOT send a Resuming notification on a fresh run (no preCreatedRun)', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      const platform = makePlatform();

      await executeWorkflow(
        deps,
        platform,
        'conv-123',
        '/tmp',
        makeWorkflow(),
        'User message',
        'db-conv-id'
      );

      // Fresh runs must not trigger the resume copy.
      const resumeMsg = findMessage(platform, 'Resuming');
      expect(resumeMsg).toBeUndefined();
      // A fresh run is created.
      expect((store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    });
  });
});

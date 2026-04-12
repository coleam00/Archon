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
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => activeRun),
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
      expect(result.error).toContain('already running');

      // Rejection message was sent
      const blockMsg = findMessage(platform, 'Workflow already running');
      expect(blockMsg).toBeDefined();

      // No new workflow was created
      expect((store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
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

      // No new workflow was created
      expect((store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);

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
    it('resumes a prior failed DAG run when completed nodes exist', async () => {
      const failedRun = makeRun({ id: 'prior-run', status: 'failed' });
      const priorNodes = new Map([['node-a', 'output from node-a']]);
      const resumedRun = makeRun({ id: 'prior-run', status: 'running' });

      const store = makeStore({
        findResumableRun: mock(async () => failedRun),
        getCompletedDagNodeOutputs: mock(async () => priorNodes),
        resumeWorkflowRun: mock(async () => resumedRun),
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

      // No createWorkflowRun — resume used existing run
      expect((store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);

      // resumeWorkflowRun was called with the prior run ID
      const resumeCalls = (store.resumeWorkflowRun as ReturnType<typeof mock>).mock.calls;
      expect(resumeCalls.length).toBe(1);
      expect(resumeCalls[0][0]).toBe('prior-run');

      // Resume notification was sent to user
      const resumeMsg = findMessage(platform, 'Resuming');
      expect(resumeMsg).toBeDefined();
      expect((resumeMsg as unknown[])[1]).toContain('1 already-completed node(s)');

      // Workflow run ID should be from the resumed run
      expect(result.workflowRunId).toBe('prior-run');
    });

    it('auto-resumes a prior failed DAG run when completed nodes exist (second test)', async () => {
      const interruptedRun = makeRun({ id: 'prior-int', status: 'failed' });
      const priorNodes = new Map([['node-a', 'output from node-a']]);
      const resumedRun = makeRun({ id: 'prior-int', status: 'running' });

      const store = makeStore({
        findResumableRun: mock(async () => interruptedRun),
        getCompletedDagNodeOutputs: mock(async () => priorNodes),
        resumeWorkflowRun: mock(async () => resumedRun),
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

      // No createWorkflowRun — resume used existing run
      expect((store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);

      // resumeWorkflowRun was called with the prior run ID
      const resumeCalls = (store.resumeWorkflowRun as ReturnType<typeof mock>).mock.calls;
      expect(resumeCalls.length).toBe(1);
      expect(resumeCalls[0][0]).toBe('prior-int');

      // Resume notification was sent to user
      const resumeMsg = findMessage(platform, 'Resuming');
      expect(resumeMsg).toBeDefined();

      // Workflow run ID should be from the resumed run
      expect(result.workflowRunId).toBe('prior-int');
    });

    it('returns error when DAG resumeWorkflowRun throws', async () => {
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
      expect(result.error).toContain('Database error resuming');

      // Error message sent to user
      const errorMsg = findMessage(platform, 'could not activate it');
      expect(errorMsg).toBeDefined();

      // No new run was created
      expect((store.createWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });
  });
});

/**
 * Tests for executeWorkflow() — the top-level orchestration function.
 * Covers concurrent-run guards, model/provider resolution, and resume logic
 * that the inner dag-executor.test.ts cannot reach.
 */
import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'path';

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
// Telemetry is fire-and-forget; mock as no-ops so the executor can call them.
// Hoisted so tests can assert on the completion call (outcome / exit reason).
const mockCaptureWorkflowInvoked = mock<typeof import('@archon/paths').captureWorkflowInvoked>(
  _props => {}
);
const mockCaptureWorkflowCompleted = mock<typeof import('@archon/paths').captureWorkflowCompleted>(
  _props => {}
);
/**
 * Deterministic stand-ins for the shared identity→paths resolver (#2200). They
 * mirror the real branch order and layout, so `resolveProjectPaths` is exercised
 * as delegation rather than re-implementation, while the asserted paths stay
 * readable literals rooted at `/tmp/ws`.
 */
type FakeStorageKey =
  | { kind: 'repo'; owner: string; repo: string }
  | { kind: 'folder'; slug: string }
  | { kind: 'cwd'; cwd: string };
function fakeResolveProjectStorageKey(
  codebase: { kind?: string | null; name: string; default_cwd: string } | null | undefined,
  cwd: string
): FakeStorageKey {
  if (codebase) {
    if (codebase.kind === 'folder') return { kind: 'folder', slug: codebase.name };
    const [owner, repo] = codebase.name.split('/');
    if (owner && repo) return { kind: 'repo', owner, repo };
    const base = codebase.default_cwd.split('/').filter(Boolean).pop();
    if (base && base !== '.' && base !== '..') return { kind: 'repo', owner: '_local', repo: base };
  }
  return { kind: 'cwd', cwd };
}
/** Root of the fake workspace tree; segments joined so win32 separators match. */
const WS = join('/tmp', 'ws');
function wsPath(...segments: string[]): string {
  return join(WS, ...segments);
}

function fakeStoragePathsForRoot(root: string): {
  root: string;
  artifactsRoot: string;
  logsDir: string;
  stateRoot: string;
} {
  // join(), not template literals — production composes these with join(), so a
  // forward-slash fake would never match on Windows.
  return {
    root,
    artifactsRoot: join(root, 'artifacts'),
    logsDir: join(root, 'logs'),
    stateRoot: join(root, 'state'),
  };
}
function fakeGetProjectStoragePaths(
  key: FakeStorageKey
): ReturnType<typeof fakeStoragePathsForRoot> {
  const root =
    key.kind === 'repo'
      ? wsPath(key.owner, key.repo)
      : key.kind === 'folder'
        ? wsPath('_folder', key.slug)
        : wsPath('_cwd', key.cwd.split('/').filter(Boolean).pop() ?? '_');
  return fakeStoragePathsForRoot(root);
}

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: mock(() => null),
  resolveRepoProjectIdentity: mock(() => null),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
  getProjectArtifactsPath: mock(() => '/tmp/artifacts-root'),
  resolveProjectStorageKey: mock(fakeResolveProjectStorageKey),
  getProjectStoragePaths: mock(fakeGetProjectStoragePaths),
  getStoragePathsForRoot: mock(fakeStoragePathsForRoot),
  // The fake tree is rooted at WS, so that is this suite's ARCHON_HOME.
  isInsideArchonHome: mock((candidate: string) => candidate.startsWith(WS)),
  slugifyFolderName: mock((name: string) => name),
  getFolderRunArtifactsPath: mock(
    (slug: string, runId: string) => `/tmp/_folder/${slug}/artifacts/runs/${runId}`
  ),
  getFolderProjectLogsPath: mock((slug: string) => `/tmp/_folder/${slug}/logs`),
  getFolderProjectArtifactsPath: mock((slug: string) => `/tmp/_folder/${slug}/artifacts`),
  getScopeArtifactsPath: mock((root: string, wf: string, scope: string) =>
    join(root, 'scopes', wf, scope)
  ),
  captureWorkflowInvoked: mockCaptureWorkflowInvoked,
  captureWorkflowCompleted: mockCaptureWorkflowCompleted,
}));

// --- Mock git ---
const mockGetDefaultBranch = mock(async () => 'main');
mock.module('@archon/git', () => ({
  getDefaultBranch: mockGetDefaultBranch,
  toRepoPath: mock((p: string) => p),
}));

// --- Mock dag-executor ---
type ExecuteDagWorkflow = typeof import('./dag-executor').executeDagWorkflow;
const mockExecuteDagWorkflow = mock<ExecuteDagWorkflow>(async () => undefined);
mock.module('./dag-executor', () => ({
  executeDagWorkflow: mockExecuteDagWorkflow,
  // Passthrough for the sub-run outcome mapper (#2121) — executor.ts imports it;
  // no test here exercises the sub-run path, but the export must exist so the
  // mocked module doesn't shadow it with `undefined`.
  childOutcomeFromRun: mock((run: { id: string; status: string }) => ({
    childRunId: run.id,
    status: run.status,
  })),
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
import {
  registerBuiltinProviders,
  registerCommunityProviders,
  clearRegistry,
} from '@archon/providers';
clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

// --- Import after mocks ---
import {
  executeWorkflow,
  hydrateResumableRun,
  inspectResumableRun,
  resolveProjectPaths,
  resolveScopeArtifactsDir,
} from './executor';
import { keepAwake } from './utils/keep-awake';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowDefinition, WorkflowRun, WorkflowRunNodeSession } from './schemas';
import { RUN_METADATA_KEYS, workflowDefinitionSchema } from './schemas';
import type { WorkflowRunConfigMetadata } from './schemas/run-config';
import { substituteWorkflowVariables } from './executor-shared';
import { TerminalStatusWriteError } from './terminal-status-write';

// --- Helpers ---

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    findChildRuns: mock(async () => []),
    getRunAncestry: mock(async () => []),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    getWorkflowRunStatus: mock(async () => 'completed' as const),
    createWorkflowEvent: mock(async () => {}),
    persistWorkflowEvent: mock(async () => {}),
    persistWorkflowEventIfRunning: mock(async () => ({ persisted: true })),
    findResumableRun: mock(async () => null),
    getDagResumeSnapshot: mock(async () => ({
      completedNodeOutputs: new Map(),
      fanOutSnapshots: new Map(),
      unresolvedNodeStarts: new Set<string>(),
      tokens: { input: 0, output: 0 },
      costUsd: 0,
    })),
    resumeWorkflowRun: mock(async () => makeRun()),
    recoverCancelledFanOutRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    updateWorkflowActivity: mock(async () => {}),
    completeWorkflowRun: mock(async () => {}),
    pauseWorkflowRun: mock(async () => {}),
    pauseWorkflowRunForWait: mock(async () => {}),
    clearWorkflowWaitContext: mock(async () => ({ cleared: true })),
    rewriteApprovalContext: mock(async () => ({ resolved: true })),
    claimWriteback: mock(async () => ({ claimed: true })),
    releaseWritebackClaim: mock(async () => {}),
    cancelWorkflowRun: mock(async () => ({ cancelled: false })),
    cancelFanOutRun: mock(async () => ({ cancelled: false })),
    getWorkflowNodeSession: mock(async () => null),
    listWorkflowRunNodeSessions: mock(async () => []),
    upsertWorkflowRunNodeSession: mock(async () => {}),
    upsertWorkflowNodeSession: mock(async () => {}),
    deleteWorkflowNodeSessions: mock(async () => ({ deleted: 0 })),
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
    nodes: [{ id: 'node1', kind: 'agent', source: { kind: 'inline', prompt: 'Do something' } }],
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'test message',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    adopted_from_run_id: null,
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
    mockGetDefaultBranch.mockClear();
    mockGetDefaultBranch.mockImplementation(async () => 'main');
    mockExecuteDagWorkflow.mockImplementation(async () => undefined);
  });

  it('rejects a structurally valid but semantically invalid outcome declaration before side effects', async () => {
    const workflow = workflowDefinitionSchema.parse({
      name: 'invalid-authored-outcome',
      description: 'missing selected return node',
      outcome_field: 'green',
      nodes: [{ id: 'node1', prompt: 'Do something' }],
    });
    const store = makeStore();
    const deps = makeDeps(store);

    await expect(
      executeWorkflow(deps, makePlatform(), 'conv-1', '/tmp/ops', workflow, 'msg', 'db-conv-1')
    ).rejects.toThrow('without returns:');

    expect(store.createWorkflowRun).not.toHaveBeenCalled();
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Container resume guard (Phase C)
  // -------------------------------------------------------------------------

  describe('container resume guard', () => {
    it('rejects a fresh container workflow with a durable wait before creating a run', async () => {
      const workflow = workflowDefinitionSchema.parse({
        name: 'container-wait',
        description: 'unsupported durable wait in container isolation',
        nodes: [{ id: 'delay', wait: { duration_ms: 1000 } }],
      });
      const store = makeStore();

      await expect(
        executeWorkflow(
          makeDeps(store),
          makePlatform(),
          'conv-1',
          '/tmp/ops',
          workflow,
          'msg',
          'db-conv-1',
          { execContext: { kind: 'container', containerId: 'cid' } }
        )
      ).rejects.toThrow('durable wait, which is not supported in container isolation');

      expect(store.createWorkflowRun).not.toHaveBeenCalled();
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });

    // The guard keys on "is this a fresh dispatch", not on who wrote the row. A row
    // pre-created by a launching process (#2872, `--detach`) is still a fresh dispatch.
    it('refuses the same durable wait when the fresh run row was pre-created', async () => {
      const workflow = workflowDefinitionSchema.parse({
        name: 'container-wait',
        description: 'unsupported durable wait in container isolation',
        nodes: [{ id: 'delay', wait: { duration_ms: 1000 } }],
      });

      await expect(
        executeWorkflow(
          makeDeps(makeStore()),
          makePlatform(),
          'conv-1',
          '/tmp/ops',
          workflow,
          'msg',
          'db-conv-1',
          {
            execContext: { kind: 'container', containerId: 'cid' },
            preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }),
          }
        )
      ).rejects.toThrow('durable wait, which is not supported in container isolation');
    });

    it('fails a container run resumed without a container context, pointing at the CLI', async () => {
      const failSpy = mock(async () => {});
      const store = makeStore({ failWorkflowRun: failSpy });
      const preCreatedRun = makeRun({
        id: 'crun',
        metadata: { isolation: 'container', isolation_env_id: 'env-x' },
      });
      const result = await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp/ops',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        { preCreatedRun, priorCompletedNodes: new Map([['node1', { output: 'out' }]]) }
      );
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected missing-container-context failure');
      expect(result.error).toMatch(/executed inside an isolation container/);
      expect(failSpy).toHaveBeenCalledTimes(1);
      // The DAG is never entered — the guard returns before any execution.
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });

    it('proceeds when the container context IS provided (guard passes)', async () => {
      const preCreatedRun = makeRun({
        id: 'crun2',
        metadata: { isolation: 'container', isolation_env_id: 'env-x' },
      });
      const backend = {
        suspend: mock(async () => {}),
        finalize: mock(async () => ({ requiresApproval: false })),
        applyChanges: mock(async () => ({ filesApplied: 0, filesDeleted: 0, warnings: [] })),
        discardChanges: mock(async () => {}),
      };
      const result = await executeWorkflow(
        makeDeps(),
        makePlatform(),
        'conv-1',
        '/tmp/ops',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        {
          preCreatedRun,
          priorCompletedNodes: new Map([['node1', { output: 'out' }]]),
          priorUsage: { tokens: { input: 40, output: 4 }, costUsd: 0.5 },
          execContext: { kind: 'container', containerId: 'cid' },
          container: { envId: 'env-x', writeBack: 'approve', backend },
        }
      );
      // Guard passed → DAG entered (mocked no-op) → run completes.
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[24]).toEqual({
        tokens: { input: 40, output: 4 },
        costUsd: 0.5,
      });
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Adopted-run directory on resume (#2747)
  // -------------------------------------------------------------------------

  describe('adopted run dir on resume', () => {
    it('resolves $ADOPTED_RUN_DIR on a resumed run from its persisted adopted_from_run_id', async () => {
      const store = makeStore({
        getWorkflowRun: mock(async (id: string) =>
          id === 'prior-run'
            ? makeRun({ id: 'prior-run', status: 'completed', output_root: '/tmp/roots/prior' })
            : { ...makeRun(), status: 'completed' as const }
        ),
      });
      let substituted = '';
      mockExecuteDagWorkflow.mockImplementationOnce(async () => {
        substituted = substituteWorkflowVariables(
          'Read $ADOPTED_RUN_DIR/report.md',
          'run-123',
          'msg',
          '/artifacts',
          'main',
          'docs'
        ).prompt;
        return undefined;
      });
      const result = await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp/ops',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        {
          preCreatedRun: makeRun({ status: 'running', adopted_from_run_id: 'prior-run' }),
          priorCompletedNodes: new Map([['node1', { output: 'out' }]]),
        }
      );
      expect(result.success).toBe(true);
      expect(store.getWorkflowRun).toHaveBeenCalledWith('prior-run');
      // path.join resolves platform-separator natively; the template's own
      // '/report.md' suffix stays a literal POSIX slash
      expect(substituted).toBe(
        `Read ${join('/tmp/roots/prior', 'artifacts', 'runs', 'prior-run')}/report.md`
      );
      // The adoption announcement is creation-only — a resume must not re-emit it.
      const adoptedEvents = (
        store.createWorkflowEvent as ReturnType<typeof mock>
      ).mock.calls.filter(
        c => (c[0] as { event_type: string }).event_type === 'workflow.run_adopted'
      );
      expect(adoptedEvents).toHaveLength(0);
    });
  });

  // --- Supersession is metadata-only (#3064): no estate, no output_root gate ---

  describe('supersession does not gate on output_root', () => {
    it('starts normally when the superseded run has no output_root (preflight-failed)', async () => {
      const supersededId = 'superseded-run';
      const store = makeStore({
        getWorkflowRun: mock(async (id: string) =>
          id === supersededId
            ? makeRun({ id: supersededId, status: 'failed', output_root: null })
            : { ...makeRun(), status: 'completed' as const }
        ),
      });
      const result = await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp/ops',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        {
          adoptedFromRunId: supersededId,
          continuationMode: 'supersede',
        }
      );
      expect(result.success).toBe(true);
      // Metadata stamp must record the continuation mode so resume reads it.
      expect(store.createWorkflowRun).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            continuation: { mode: 'supersede' },
          }),
        })
      );
      // Must NOT attempt to resolve output_root for supersession.
      expect(store.getWorkflowRun).not.toHaveBeenCalledWith(supersededId);
    });

    it('starts normally on resume when the superseded run has no output_root', async () => {
      const supersededId = 'superseded-run';
      const store = makeStore({
        getWorkflowRun: mock(async () => makeRun({ status: 'completed' as const })),
      });
      const result = await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp/ops',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        {
          preCreatedRun: makeRun({
            status: 'running',
            adopted_from_run_id: supersededId,
            metadata: { continuation: { mode: 'supersede' } },
          }),
          priorCompletedNodes: new Map([['node1', { output: 'out' }]]),
        }
      );
      expect(result.success).toBe(true);
      // The resumed supersession must not fetch the superseded run at all.
      expect(store.getWorkflowRun).not.toHaveBeenCalledWith(supersededId);
    });

    it('adoption with output_root still works (unchanged)', async () => {
      const adoptedId = 'prior-run';
      let capturedVar: string | undefined;
      mockExecuteDagWorkflow.mockImplementationOnce(async () => {
        capturedVar = substituteWorkflowVariables(
          'Read $ADOPTED_RUN_DIR/report.md',
          'run-123',
          'msg',
          '/artifacts',
          'main',
          'docs'
        ).prompt;
        return undefined;
      });
      const store = makeStore({
        getWorkflowRun: mock(async (id: string) =>
          id === adoptedId
            ? makeRun({ id: adoptedId, status: 'completed', output_root: '/tmp/roots/prior' })
            : id === 'run-123'
              ? makeRun({ id: 'run-123', status: 'completed' as const })
              : { ...makeRun(), status: 'completed' as const }
        ),
      });
      const result = await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp/ops',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        {
          adoptedFromRunId: adoptedId,
          continuationMode: 'adopt',
        }
      );
      expect(result.success).toBe(true);
      expect(capturedVar!).toBe(
        `Read ${join('/tmp/roots/prior', 'artifacts', 'runs', adoptedId)}/report.md`
      );
    });

    it('emits the run_adopted event with mode in data', async () => {
      const supersededId = 'superseded-run';
      const store = makeStore();
      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp/ops',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        {
          adoptedFromRunId: supersededId,
          continuationMode: 'supersede',
        }
      );
      const eventCalls = (store.createWorkflowEvent as ReturnType<typeof mock>).mock.calls.filter(
        c => (c[0] as { event_type: string }).event_type === 'workflow.run_adopted'
      );
      expect(eventCalls).toHaveLength(1);
      const eventData = (eventCalls[0]![0] as { data: Record<string, unknown> }).data;
      expect(eventData.adopted_from_run_id).toBe(supersededId);
      expect(eventData.mode).toBe('supersede');
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
      if (result.success) throw new Error('Expected workflow guard failure');
      expect(result.error).toContain('Database error');
      // Blocked before the execution window — keep-awake must never have fired.
      expect(keepAwake.activeCount()).toBe(0);
    });

    it('blocks workflow when another is actively running', async () => {
      const activeRun = makeRun({
        id: 'other-run-456',
        status: 'running',
        started_at: new Date(), // Recent — not stale
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
      if (result.success) throw new Error('Expected active-workflow rejection');
      expect(result.error).toContain('already active');
    });

    // -----------------------------------------------------------------------
    // Keep-awake pairing (acquire before the run's try, release in its finally)
    // -----------------------------------------------------------------------

    // Safe to spy on the real singleton: off-Windows its native fn is
    // undefined, so acquire/release only touch the refcount.
    it('acquires and releases keep-awake exactly once on a successful run', async () => {
      const acquireSpy = spyOn(keepAwake, 'acquire');
      const releaseSpy = spyOn(keepAwake, 'release');
      try {
        const result = await executeWorkflow(
          makeDeps(),
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow(),
          'test message',
          'db-conv-1'
        );
        expect(result.workflowRunId).toBe('run-123');
        expect(acquireSpy).toHaveBeenCalledTimes(1);
        expect(releaseSpy).toHaveBeenCalledTimes(1);
        expect(keepAwake.activeCount()).toBe(0);
      } finally {
        acquireSpy.mockRestore();
        releaseSpy.mockRestore();
      }
    });

    it('still releases keep-awake when the DAG throws an unhandled error', async () => {
      mockExecuteDagWorkflow.mockImplementationOnce(async () => {
        throw new Error('DAG exploded');
      });
      const acquireSpy = spyOn(keepAwake, 'acquire');
      const releaseSpy = spyOn(keepAwake, 'release');
      try {
        const result = await executeWorkflow(
          makeDeps(),
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow(),
          'test message',
          'db-conv-1'
        );
        expect(result.success).toBe(false);
        expect(acquireSpy).toHaveBeenCalledTimes(1);
        expect(releaseSpy).toHaveBeenCalledTimes(1);
        expect(keepAwake.activeCount()).toBe(0);
      } finally {
        acquireSpy.mockRestore();
        releaseSpy.mockRestore();
      }
    });

    it('passes self-id and started_at to the lock query so self is excluded', async () => {
      // The guard runs AFTER workflowRun is finalized so we always have
      // a self-ID. Without these args, the dispatch's own row would match
      // and falsely trigger the guard.
      const selfRun = makeRun({
        id: 'self-run-789',
        started_at: new Date('2026-04-14T10:00:00.000Z'),
      });
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
      const cancelSpy = mock(async () => ({ cancelled: true }));
      const store = makeStore({
        createWorkflowRun: mock(async () => selfRun),
        getActiveWorkflowRunByPath: mock(async () => otherRun),
        cancelWorkflowRun: cancelSpy,
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
      expect(cancelSpy).toHaveBeenCalledWith('self-run-789');
    });

    it('uses the actionable "in use" message format with workflow name, duration, and short id', async () => {
      const otherRun = makeRun({
        id: 'abc12345-rest-of-uuid',
        workflow_name: 'archon-implement',
        status: 'running',
        started_at: new Date(Date.now() - 125000), // 2m 5s ago
      });
      const sendMessageSpy = mock<IWorkflowPlatform['sendMessage']>(
        async (_conversationId, _message, _metadata) => {}
      );
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

    it('skips path-lock check when mutates_checkout is false', async () => {
      const getActiveSpy = mock(async () =>
        makeRun({ id: 'other-run', status: 'running' as const })
      );
      const store = makeStore({ getActiveWorkflowRunByPath: getActiveSpy });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ mutates_checkout: false }),
        'test message',
        'db-conv-1'
      );
      // Guard skipped: spy never called, run succeeds
      expect(getActiveSpy).not.toHaveBeenCalled();
      expect(result.workflowRunId).toBe('run-123');
    });

    it('still enforces path lock when mutates_checkout is true', async () => {
      const otherRun = makeRun({ id: 'other-run-456', status: 'running' as const });
      const store = makeStore({ getActiveWorkflowRunByPath: mock(async () => otherRun) });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ mutates_checkout: true }),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected checkout-lock rejection');
      expect(result.error).toContain('already active');
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
      if (result.success) throw new Error('Expected checkout-lock rejection');
      expect(result.error).toContain('already active');
    });
  });

  // -------------------------------------------------------------------------
  // Resume orphan cleanup
  // -------------------------------------------------------------------------

  // Resume-pipeline coverage lives in the "hydrateResumableRun" suite at the
  // bottom of this file (executor no longer queries findResumableRun on its
  // own, so there is no orphan to clean up).

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

    it('passes workflow.model through unchanged when workflow.provider is unset', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      // Provider falls back to config.assistant ('claude'); model is forwarded
      // verbatim. The SDK is the source of truth for what model strings work.
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

    it('passes provider+model through to the SDK without re-routing on model name', async () => {
      // Provider is explicit; the model string is forwarded verbatim to
      // whichever SDK the resolved provider names. A workflow that sets
      // provider:codex with a Claude-looking model gets the request handed
      // to the codex SDK as-is — the SDK decides whether to accept it.
      const store = makeStore();
      const deps = makeDeps(store);
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ provider: 'codex', model: 'sonnet' }),
        'test message',
        'db-conv-1'
      );
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    });

    it('throws when workflow.provider is not a registered provider', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await expect(
        executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ provider: 'claud', model: 'sonnet' }),
          'test message',
          'db-conv-1'
        )
      ).rejects.toThrow(/unknown provider 'claud'/);
    });
  });

  describe('run-scoped model bindings (#2481)', () => {
    it('rebinding large changes only large and records the effective profile', async () => {
      const createRun = mock<IWorkflowStore['createWorkflowRun']>(async () => makeRun());
      const store = makeStore({ createWorkflowRun: createRun });
      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ model: 'large' }),
        'msg',
        'db-conv-1',
        {
          modelOverrideLayer: {
            kind: 'raw',
            overrides: { tiers: { large: 'openai/gpt-5.6' } },
          },
        }
      );

      expect(mockExecuteDagWorkflow.mock.calls[0]?.[6]).toBe('pi');
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[7]).toBe('openai/gpt-5.6');
      const profile = mockExecuteDagWorkflow.mock.calls[0]?.[18];
      expect(profile?.aliases.large).toEqual({ provider: 'pi', model: 'openai/gpt-5.6' });
      expect(profile?.aliases.small?.provider).toBe('claude');
      expect(profile?.aliases.medium?.provider).toBe('claude');
      expect(
        (mockLogFn.mock.calls as unknown[][]).some(
          call =>
            call[1] === 'workflow_provider_resolved' &&
            (call[0] as { providerSource?: string }).providerSource === 'run-override'
        )
      ).toBe(true);

      const created = createRun.mock.calls[0]?.[0];
      expect(created?.metadata?.model_bindings).toMatchObject({
        overrides: { tiers: { large: { provider: 'pi', model: 'openai/gpt-5.6' } } },
        effective: { aliases: { large: { provider: 'pi', model: 'openai/gpt-5.6' } } },
      });
    });

    it('merges effective bindings onto a pre-created fresh run before DAG execution', async () => {
      const updateRun = mock<IWorkflowStore['updateWorkflowRun']>(async () => {});
      const preCreatedRun = makeRun({ id: 'pending-run', status: 'pending', metadata: {} });
      const store = makeStore({ updateWorkflowRun: updateRun });

      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ model: 'large' }),
        'msg',
        'db-conv-1',
        {
          preCreatedRun,
          modelOverrideLayer: {
            kind: 'raw',
            overrides: { tiers: { large: 'codex/gpt-5.6-sol' } },
          },
        }
      );

      expect(updateRun).toHaveBeenCalledWith(
        'pending-run',
        expect.objectContaining({
          metadata: expect.objectContaining({ model_bindings: expect.any(Object) }),
        })
      );
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[6]).toBe('codex');
    });

    // #2872 — `run --detach` writes the row before it forks, so `Started` names a
    // queryable run. Only the child knows the checkout, so it fills the path in.
    it('fills in the working path of a row created before its checkout existed', async () => {
      const updateRun = mock<IWorkflowStore['updateWorkflowRun']>(async () => {});
      const preCreatedRun = makeRun({ id: 'pending-run', status: 'pending', working_path: null });

      await executeWorkflow(
        makeDeps(makeStore({ updateWorkflowRun: updateRun })),
        makePlatform(),
        'conv-1',
        '/tmp/worktree',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        { preCreatedRun }
      );

      expect(updateRun).toHaveBeenCalledWith(
        'pending-run',
        expect.objectContaining({ working_path: '/tmp/worktree' })
      );
    });

    // Without this stamp a resume of a detached container run (#2872) would silently
    // restart in place on the live root instead of rediscovering its container.
    it('stamps container isolation onto a fresh pre-created row', async () => {
      const updateRun = mock<IWorkflowStore['updateWorkflowRun']>(async () => {});
      const backend = {
        suspend: mock(async () => {}),
        finalize: mock(async () => ({ requiresApproval: false })),
        applyChanges: mock(async () => ({ filesApplied: 0, filesDeleted: 0, warnings: [] })),
        discardChanges: mock(async () => {}),
      };

      await executeWorkflow(
        makeDeps(makeStore({ updateWorkflowRun: updateRun })),
        makePlatform(),
        'conv-1',
        '/tmp/ops',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        {
          preCreatedRun: makeRun({ id: 'pending-run', status: 'pending', working_path: null }),
          execContext: { kind: 'container', containerId: 'cid' },
          container: { envId: 'env-x', writeBack: 'approve', backend },
        }
      );

      expect(updateRun).toHaveBeenCalledWith(
        'pending-run',
        expect.objectContaining({
          metadata: expect.objectContaining({
            isolation: 'container',
            isolation_env_id: 'env-x',
          }),
        })
      );
    });

    it('never rewrites the working path of a row that already has one', async () => {
      const updateRun = mock<IWorkflowStore['updateWorkflowRun']>(async () => {});
      const preCreatedRun = makeRun({
        id: 'pending-run',
        status: 'pending',
        working_path: '/tmp/original',
      });

      await executeWorkflow(
        makeDeps(makeStore({ updateWorkflowRun: updateRun })),
        makePlatform(),
        'conv-1',
        '/tmp/somewhere-else',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        { preCreatedRun }
      );

      expect(updateRun.mock.calls[0]?.[1]).not.toHaveProperty('working_path');
    });

    it('fails a pre-created run when its effective bindings cannot be recorded', async () => {
      const updateRun = mock<IWorkflowStore['updateWorkflowRun']>(async () => {
        throw new Error('database unavailable');
      });
      const failRun = mock<IWorkflowStore['failWorkflowRun']>(async () => {});
      const preCreatedRun = makeRun({ id: 'pending-run', status: 'pending', metadata: {} });

      const result = await executeWorkflow(
        makeDeps(makeStore({ updateWorkflowRun: updateRun, failWorkflowRun: failRun })),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ model: 'large' }),
        'msg',
        'db-conv-1',
        {
          preCreatedRun,
          modelOverrideLayer: {
            kind: 'raw',
            overrides: { tiers: { large: 'codex/gpt-5.6-sol' } },
          },
        }
      );

      expect(result).toEqual({
        success: false,
        workflowRunId: 'pending-run',
        error: 'Database error recording workflow invocation settings',
      });
      expect(failRun).toHaveBeenCalledWith(
        'pending-run',
        'Database error recording workflow invocation settings'
      );
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });

    it('restores the persisted sparse layer on resume and refuses a new one', async () => {
      const preCreatedRun = makeRun({
        id: 'resume-model-run',
        status: 'running',
        metadata: {
          model_bindings: {
            overrides: {
              tiers: { large: { provider: 'pi', model: 'openai/gpt-5.6' } },
            },
            effective: {
              defaultProvider: 'claude',
              aliases: {
                small: { provider: 'claude', model: 'haiku' },
                medium: { provider: 'claude', model: 'sonnet' },
                large: { provider: 'pi', model: 'openai/gpt-5.6' },
              },
            },
          },
        },
      });

      await executeWorkflow(
        makeDeps(makeStore()),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ model: 'large' }),
        'msg',
        'db-conv-1',
        { preCreatedRun, priorCompletedNodes: new Map() }
      );
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[6]).toBe('pi');
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[7]).toBe('openai/gpt-5.6');

      await expect(
        executeWorkflow(
          makeDeps(makeStore()),
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ model: 'large' }),
          'msg',
          'db-conv-1',
          {
            preCreatedRun,
            priorCompletedNodes: new Map(),
            modelOverrideLayer: {
              kind: 'raw',
              overrides: { tiers: { large: 'codex/gpt-5.6-sol' } },
            },
          }
        )
      ).rejects.toThrow(/Cannot supply model overrides when resuming/);
    });

    it('terminalizes a resumed run before dispatch when persisted effort is ineffective', async () => {
      const failRun = mock<IWorkflowStore['failWorkflowRun']>(async () => {});
      const preCreatedRun = makeRun({
        id: 'resume-opencode-effort-run',
        status: 'running',
        metadata: {
          model_bindings: {
            overrides: {
              tiers: {
                large: {
                  provider: 'opencode',
                  model: 'anthropic/claude-sonnet-4-6',
                  effort: 'ultra',
                },
              },
            },
            effective: {
              defaultProvider: 'claude',
              aliases: {
                small: { provider: 'claude', model: 'haiku' },
                medium: { provider: 'claude', model: 'sonnet' },
                large: {
                  provider: 'opencode',
                  model: 'anthropic/claude-sonnet-4-6',
                  effort: 'ultra',
                },
              },
            },
          },
        },
      });

      await expect(
        executeWorkflow(
          makeDeps(makeStore({ failWorkflowRun: failRun })),
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ model: 'large' }),
          'msg',
          'db-conv-1',
          { preCreatedRun, priorCompletedNodes: new Map() }
        )
      ).rejects.toThrow(/cannot apply effort to provider 'opencode'/);

      expect(failRun).toHaveBeenCalledWith(
        'resume-opencode-effort-run',
        expect.stringContaining("cannot apply effort to provider 'opencode'")
      );
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });

    it('terminalizes a resumed run with an invalid persisted alias key', async () => {
      const failRun = mock<IWorkflowStore['failWorkflowRun']>(async () => {});
      const preCreatedRun = makeRun({
        id: 'resume-invalid-alias-run',
        status: 'running',
        metadata: {
          model_bindings: {
            overrides: {
              aliases: { planner: { provider: 'claude', model: 'opus' } },
            },
            effective: {
              defaultProvider: 'claude',
              aliases: {},
            },
          },
        },
      });

      await expect(
        executeWorkflow(
          makeDeps(makeStore({ failWorkflowRun: failRun })),
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ model: 'large' }),
          'msg',
          'db-conv-1',
          { preCreatedRun, priorCompletedNodes: new Map() }
        )
      ).rejects.toThrow(/invalid model_bindings aliases/);

      expect(failRun).toHaveBeenCalledWith(
        'resume-invalid-alias-run',
        expect.stringContaining('invalid model_bindings aliases')
      );
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });

    it('terminalizes a resumed run before dispatch when a persisted provider is unavailable', async () => {
      const failRun = mock<IWorkflowStore['failWorkflowRun']>(async () => {});
      const preCreatedRun = makeRun({
        id: 'resume-removed-provider-run',
        status: 'running',
        metadata: {
          model_bindings: {
            overrides: {
              tiers: { large: { provider: 'removed-provider', model: 'legacy-model' } },
            },
            effective: {
              defaultProvider: 'claude',
              aliases: {
                large: { provider: 'removed-provider', model: 'legacy-model' },
              },
            },
          },
        },
      });

      await expect(
        executeWorkflow(
          makeDeps(makeStore({ failWorkflowRun: failRun })),
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ model: 'large' }),
          'msg',
          'db-conv-1',
          { preCreatedRun, priorCompletedNodes: new Map() }
        )
      ).rejects.toThrow(/unknown provider 'removed-provider'/);

      expect(failRun).toHaveBeenCalledWith(
        'resume-removed-provider-run',
        expect.stringContaining("unknown provider 'removed-provider'")
      );
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });

    it('terminalizes a resumed run before dispatch when persisted thinking is ineffective', async () => {
      const failRun = mock<IWorkflowStore['failWorkflowRun']>(async () => {});
      const preset = {
        provider: 'copilot',
        model: 'gpt-5.6',
        thinking: { type: 'enabled' as const, budgetTokens: 1_000 },
      };
      const preCreatedRun = makeRun({
        id: 'resume-ignored-thinking-run',
        status: 'running',
        metadata: {
          model_bindings: {
            overrides: { tiers: { large: preset } },
            effective: {
              defaultProvider: 'claude',
              aliases: { large: preset },
            },
          },
        },
      });

      await expect(
        executeWorkflow(
          makeDeps(makeStore({ failWorkflowRun: failRun })),
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ model: 'large' }),
          'msg',
          'db-conv-1',
          { preCreatedRun, priorCompletedNodes: new Map() }
        )
      ).rejects.toThrow(/cannot apply Claude-shaped thinking options/);

      expect(failRun).toHaveBeenCalledWith(
        'resume-ignored-thinking-run',
        expect.stringContaining('cannot apply Claude-shaped thinking options')
      );
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });

    it('fails a pre-created row when a semantic binding error stops startup', async () => {
      const failRun = mock<IWorkflowStore['failWorkflowRun']>(async () => {});
      const preCreatedRun = makeRun({ id: 'invalid-model-run', status: 'pending', metadata: {} });

      await expect(
        executeWorkflow(
          makeDeps(makeStore({ failWorkflowRun: failRun })),
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ model: 'large' }),
          'msg',
          'db-conv-1',
          {
            preCreatedRun,
            modelOverrideLayer: {
              kind: 'raw',
              overrides: { aliases: { '@missing': 'codex/gpt-5.6-sol' } },
            },
          }
        )
      ).rejects.toThrow(/unknown alias '@missing'/);
      expect(failRun).toHaveBeenCalledWith(
        'invalid-model-run',
        expect.stringContaining("unknown alias '@missing'")
      );
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });

    it('keeps concurrent profiles isolated and leaves no residue', async () => {
      const workflow = makeWorkflow({ model: 'large', mutates_checkout: false });
      await Promise.all([
        executeWorkflow(
          makeDeps(makeStore({ createWorkflowRun: mock(async () => makeRun({ id: 'run-a' })) })),
          makePlatform(),
          'conv-a',
          '/tmp',
          workflow,
          'a',
          'db-a',
          {
            modelOverrideLayer: {
              kind: 'raw',
              overrides: { tiers: { large: 'openai/gpt-5.6' } },
            },
          }
        ),
        executeWorkflow(
          makeDeps(makeStore({ createWorkflowRun: mock(async () => makeRun({ id: 'run-b' })) })),
          makePlatform(),
          'conv-b',
          '/tmp',
          workflow,
          'b',
          'db-b',
          {
            modelOverrideLayer: {
              kind: 'raw',
              overrides: { tiers: { large: 'codex/gpt-5.6-sol' } },
            },
          }
        ),
      ]);

      const concurrent = mockExecuteDagWorkflow.mock.calls.slice(0, 2).map(call => ({
        provider: call[6],
        model: call[7],
      }));
      expect(concurrent).toContainEqual({ provider: 'pi', model: 'openai/gpt-5.6' });
      expect(concurrent).toContainEqual({ provider: 'codex', model: 'gpt-5.6-sol' });

      await executeWorkflow(
        makeDeps(makeStore({ createWorkflowRun: mock(async () => makeRun({ id: 'run-c' })) })),
        makePlatform(),
        'conv-c',
        '/tmp',
        workflow,
        'c',
        'db-c'
      );
      const cleanCall = mockExecuteDagWorkflow.mock.calls[2];
      expect(cleanCall?.[6]).toBe('claude');
      expect(cleanCall?.[7]).not.toBe('openai/gpt-5.6');
      expect(cleanCall?.[7]).not.toBe('gpt-5.6-sol');
    });
  });

  describe('run-scoped config layer (#2482)', () => {
    const sealedMetadata: WorkflowRunConfigMetadata = {
      version: 1,
      ciphertext: 'opaque-ciphertext',
      source: { kind: 'cli', label: 'config.minimax.yaml' },
      keys: ['assistant', 'env.SHARED', 'tiers.large'],
    };

    it('layers file content above DB/user config and explicit model mappings above the file', async () => {
      const createRun = mock<IWorkflowStore['createWorkflowRun']>(async data =>
        makeRun({ metadata: data.metadata })
      );
      const store = makeStore({
        createWorkflowRun: createRun,
        getCodebaseEnvVars: mock(async () => ({ SHARED: 'db', DB_ONLY: 'kept' })),
      });
      const sealRunConfig = mock(() => sealedMetadata);
      const deps: WorkflowDeps = {
        ...makeDeps(store),
        sealRunConfig,
        loadConfig: mock(async () => ({
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          tiers: { large: { provider: 'claude', model: 'opus' } },
          envVars: { SHARED: 'repo', REPO_ONLY: 'kept' },
          commands: {},
        })),
        getUserAiPrefs: mock(async () => ({
          defaultProvider: 'codex',
          tiers: { large: { provider: 'codex', model: 'gpt-5.5' } },
        })),
        isPerUserProviderKeysEnabled: () => true,
        getUserProviderEnv: mock(async () => ({
          env: { PROTECTED_TOKEN: 'credential-wins' },
          files: [],
          protectedValues: ['credential-wins'],
        })),
      };

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ model: 'large' }),
        'msg',
        'db-conv-1',
        {
          codebaseId: 'codebase-1',
          runConfig: {
            source: sealedMetadata.source,
            layer: {
              assistant: 'pi',
              tiers: { large: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
              envVars: { SHARED: 'run', PROTECTED_TOKEN: 'must-not-win' },
            },
          },
          modelOverrideLayer: {
            kind: 'raw',
            overrides: { tiers: { large: 'openai/gpt-5.6' } },
          },
          userId: 'user-1',
        }
      );

      expect(sealRunConfig).toHaveBeenCalledTimes(1);
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[6]).toBe('pi');
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[7]).toBe('openai/gpt-5.6');
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[13]).toMatchObject({
        assistant: 'pi',
        envVars: {
          REPO_ONLY: 'kept',
          DB_ONLY: 'kept',
          SHARED: 'run',
          PROTECTED_TOKEN: 'credential-wins',
        },
        protectedEnvKeys: ['PROTECTED_TOKEN'],
      });
      expect(createRun.mock.calls[0]?.[0].metadata).toMatchObject({
        run_config: sealedMetadata,
        model_bindings: {
          effective: {
            defaultProvider: 'pi',
            aliases: { large: { provider: 'pi', model: 'openai/gpt-5.6' } },
          },
        },
      });
    });

    it('restores the sealed layer on cold resume without caller input', async () => {
      const layer = {
        docsPath: 'handbook',
        envVars: { RUN_ONLY: 'restored' },
      };
      const unsealRunConfig = mock(() => layer);
      const preCreatedRun = makeRun({
        id: 'resume-config-run',
        status: 'running',
        metadata: { run_config: sealedMetadata },
      });

      await executeWorkflow(
        { ...makeDeps(makeStore()), unsealRunConfig },
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        { preCreatedRun, priorCompletedNodes: new Map() }
      );

      expect(unsealRunConfig).toHaveBeenCalledWith(sealedMetadata);
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[12]).toBe('handbook');
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[13]).toMatchObject({
        envVars: { RUN_ONLY: 'restored' },
      });
    });

    it('terminalizes a pre-created run when persisted config cannot be restored', async () => {
      const failRun = mock<IWorkflowStore['failWorkflowRun']>(async () => {});
      const preCreatedRun = makeRun({
        id: 'broken-config-run',
        status: 'running',
        metadata: { run_config: sealedMetadata },
      });

      await expect(
        executeWorkflow(
          {
            ...makeDeps(makeStore({ failWorkflowRun: failRun })),
            unsealRunConfig: () => {
              throw new Error('Workflow run config could not be decrypted.');
            },
          },
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow(),
          'msg',
          'db-conv-1',
          { preCreatedRun, priorCompletedNodes: new Map() }
        )
      ).rejects.toThrow('could not be decrypted');
      expect(failRun).toHaveBeenCalledWith(
        'broken-config-run',
        'Workflow run config could not be decrypted.'
      );
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
    });

    it('keeps concurrent run layers isolated and leaves no residue', async () => {
      const workflow = makeWorkflow({ model: 'large', mutates_checkout: false });
      const input = (id: string, provider: 'pi' | 'codex', model: string, marker: string) =>
        executeWorkflow(
          {
            ...makeDeps(makeStore({ createWorkflowRun: mock(async () => makeRun({ id })) })),
            sealRunConfig: () => sealedMetadata,
          },
          makePlatform(),
          `conv-${id}`,
          '/tmp',
          workflow,
          id,
          `db-${id}`,
          {
            runConfig: {
              source: sealedMetadata.source,
              layer: {
                tiers: { large: { provider, model } },
                envVars: { RUN_MARKER: marker },
              },
            },
          }
        );

      await Promise.all([
        input('config-a', 'pi', 'openai/gpt-5.6', 'a'),
        input('config-b', 'codex', 'gpt-5.6-sol', 'b'),
      ]);

      const concurrent = mockExecuteDagWorkflow.mock.calls.slice(0, 2).map(call => ({
        provider: call[6],
        model: call[7],
        marker: (call[13] as WorkflowConfig | undefined)?.envVars?.RUN_MARKER,
      }));
      expect(concurrent).toContainEqual({
        provider: 'pi',
        model: 'openai/gpt-5.6',
        marker: 'a',
      });
      expect(concurrent).toContainEqual({
        provider: 'codex',
        model: 'gpt-5.6-sol',
        marker: 'b',
      });

      await executeWorkflow(
        makeDeps(
          makeStore({ createWorkflowRun: mock(async () => makeRun({ id: 'config-clean' })) })
        ),
        makePlatform(),
        'conv-clean',
        '/tmp',
        workflow,
        'clean',
        'db-clean'
      );
      const cleanConfig = mockExecuteDagWorkflow.mock.calls[2]?.[13] as WorkflowConfig | undefined;
      expect(cleanConfig?.envVars?.RUN_MARKER).toBeUndefined();
      expect(mockExecuteDagWorkflow.mock.calls[2]?.[6]).toBe('claude');
    });
  });

  // -------------------------------------------------------------------------
  // Durable workflow_started configuration snapshot
  // -------------------------------------------------------------------------

  describe('workflow_started configuration snapshot', () => {
    it('persists the resolved configuration and top-level platform origin', async () => {
      const createEventSpy = mock<IWorkflowStore['createWorkflowEvent']>(async _data => {});
      const store = makeStore({
        createWorkflowRun: mock(async () =>
          makeRun({
            user_message: 'persisted input',
            user_id: 'user-1',
            parent_run_id: null,
          })
        ),
        createWorkflowEvent: createEventSpy,
      });
      const deps = {
        ...makeDeps(store),
        loadConfig: mock(
          async (): Promise<WorkflowConfig> => ({
            assistant: 'claude',
            assistants: { claude: {}, codex: {} },
            baseBranch: 'config-base',
            commands: { folder: '' },
            tiers: {
              large: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
            },
          })
        ),
        getUserAiPrefs: mock(async () => ({ defaultProvider: 'codex' })),
        sealRunConfig: mock(() => ({
          version: 1 as const,
          ciphertext: 'opaque',
          source: { kind: 'http' as const, label: 'inline' },
          keys: ['assistant'],
        })),
      } as WorkflowDeps;
      const platform = {
        sendMessage: mock(async () => {}),
        getPlatformType: mock(() => 'web'),
      } as unknown as IWorkflowPlatform;

      await executeWorkflow(
        deps,
        platform,
        'conv-1',
        '/tmp/worktree',
        makeWorkflow({ model: 'large' }),
        'caller input',
        'db-conv-1',
        {
          userId: 'user-1',
          baseBranch: 'caller-base',
          baseOverride: 'override-base',
          isolationContext: { branchName: 'feature/snapshot' },
          runConfig: {
            source: { kind: 'http', label: 'inline' },
            layer: { assistant: 'pi' },
          },
        }
      );

      const startedEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_started');
      expect(startedEvent?.data).toEqual({
        workflowName: 'test-workflow',
        defaultAssistant: 'pi',
        provider: 'codex',
        model: 'gpt-5.5',
        isolationMode: 'worktree',
        baseBranch: 'override-base',
        userId: 'user-1',
        userMessage: 'persisted input',
        origin: 'web',
      });
    });

    it('persists explicit nulls for an in-place run without a model or user', async () => {
      const createEventSpy = mock<IWorkflowStore['createWorkflowEvent']>(async _data => {});
      const store = makeStore({
        createWorkflowRun: mock(async () =>
          makeRun({ user_message: 'folder input', user_id: null, parent_run_id: null })
        ),
        createWorkflowEvent: createEventSpy,
      });

      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp/folder',
        makeWorkflow(),
        'folder input',
        'db-conv-1'
      );

      const startedEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_started');
      expect(startedEvent?.data).toMatchObject({
        workflowName: 'test-workflow',
        model: null,
        isolationMode: 'in-place',
        userId: null,
        origin: 'test',
      });
      expect(startedEvent?.data).toHaveProperty('model');
      expect(startedEvent?.data).toHaveProperty('userId');
    });

    it('classifies a container execution ahead of a worktree context', async () => {
      const createEventSpy = mock<IWorkflowStore['createWorkflowEvent']>(async _data => {});
      const store = makeStore({
        createWorkflowRun: mock(async () =>
          makeRun({ user_message: 'container input', user_id: null, parent_run_id: null })
        ),
        createWorkflowEvent: createEventSpy,
      });

      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp/container',
        makeWorkflow(),
        'container input',
        'db-conv-1',
        {
          execContext: { kind: 'container', containerId: 'container-1' },
          isolationContext: { branchName: 'feature/snapshot' },
        }
      );

      const startedEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_started');
      expect(startedEvent?.data?.isolationMode).toBe('container');
      expect(startedEvent?.data?.origin).toBe('test');
    });

    it('uses persisted child-run attribution and input instead of caller values', async () => {
      const createEventSpy = mock<IWorkflowStore['createWorkflowEvent']>(async _data => {});
      const preCreatedRun = makeRun({
        id: 'child-run',
        user_message: 'persisted child input',
        user_id: null,
        parent_run_id: 'parent-run',
      });
      const store = makeStore({ createWorkflowEvent: createEventSpy });

      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp/shared-worktree',
        makeWorkflow(),
        'transient caller input',
        'db-conv-1',
        { preCreatedRun, userId: 'transient-user' }
      );

      const startedEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_started');
      expect(startedEvent?.data).toMatchObject({
        workflowName: 'test-workflow',
        userId: null,
        userMessage: 'persisted child input',
        origin: 'workflow',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Parse warnings recorded on the run (#2213)
  // -------------------------------------------------------------------------

  describe('workflow_parse_warnings', () => {
    it('records the dropped keys on the run at start', async () => {
      // Recorded HERE rather than at the chat dispatch site so the finding does
      // not depend on a notification being deliverable — and so CLI- and
      // REST-started runs, which have no conversation to post into, get it too.
      const createEventSpy = mock<IWorkflowStore['createWorkflowEvent']>(async _data => {});
      const store = makeStore({ createWorkflowEvent: createEventSpy });

      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        { parseWarnings: ["Node 'plan': unknown key 'interactive' will be ignored."] }
      );

      const warnEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_parse_warnings');
      expect(warnEvent?.data).toEqual({
        workflowName: 'test-workflow',
        warnings: ["Node 'plan': unknown key 'interactive' will be ignored."],
      });
    });

    it('records nothing for a clean workflow', async () => {
      const createEventSpy = mock<IWorkflowStore['createWorkflowEvent']>(async _data => {});
      const store = makeStore({ createWorkflowEvent: createEventSpy });

      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        {}
      );

      const warnEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_parse_warnings');
      expect(warnEvent).toBeUndefined();
    });

    it('records even when the platform cannot be written to', async () => {
      // The engine's record must not be coupled to platform delivery in any
      // way — this is the whole reason the event exists rather than relying on
      // the best-effort chat message.
      const createEventSpy = mock<IWorkflowStore['createWorkflowEvent']>(async _data => {});
      const store = makeStore({ createWorkflowEvent: createEventSpy });
      const brokenPlatform = {
        sendMessage: mock(() => Promise.reject(new Error('platform down'))),
        getPlatformType: mock(() => 'slack'),
      } as unknown as IWorkflowPlatform;

      await executeWorkflow(
        makeDeps(store),
        brokenPlatform,
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        { parseWarnings: ['dropped a key'] }
      ).catch(() => {
        // A broken platform may fail the run downstream; irrelevant here.
      });

      const warnEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_parse_warnings');
      expect(warnEvent?.data).toMatchObject({ warnings: ['dropped a key'] });
    });
  });

  // -------------------------------------------------------------------------
  // Deprecation notice recorded on the run (#2781)
  // -------------------------------------------------------------------------

  describe('workflow_deprecation_notice', () => {
    it('records the composed notice for a deprecated workflow', async () => {
      const createEventSpy = mock<IWorkflowStore['createWorkflowEvent']>(async _data => {});
      const store = makeStore({ createWorkflowEvent: createEventSpy });

      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ deprecated: { message: 'Switch to the sdlc pack instead.' } }),
        'test message',
        'db-conv-1'
      );

      const noticeEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_deprecation_notice');
      expect(noticeEvent?.data).toEqual({
        workflowName: 'test-workflow',
        notice:
          '⚠️ `test-workflow` is deprecated and will be removed in an upcoming release. ' +
          'Switch to the sdlc pack instead. ' +
          'To keep using this workflow after removal, copy the workflow file into your project ' +
          '`.archon/workflows/` or your global `~/.archon/workflows/`.',
      });
    });

    it('records nothing for a workflow without the marker', async () => {
      const createEventSpy = mock<IWorkflowStore['createWorkflowEvent']>(async _data => {});
      const store = makeStore({ createWorkflowEvent: createEventSpy });

      await executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );

      const noticeEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_deprecation_notice');
      expect(noticeEvent).toBeUndefined();
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
      const docsDir = mockExecuteDagWorkflow.mock.calls[0]?.[12];
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
      const docsDir = mockExecuteDagWorkflow.mock.calls[0]?.[12];
      expect(docsDir).toBe('packages/docs-web/src/content/docs');
    });
  });

  // -------------------------------------------------------------------------
  // Base branch resolution ($BASE_BRANCH)
  // -------------------------------------------------------------------------

  describe('base branch resolution', () => {
    it('uses caller-provided baseBranch when repo config is unset', async () => {
      // Auto-detect would throw — the caller fallback must short-circuit before it.
      mockGetDefaultBranch.mockImplementation(async () => {
        throw new Error('Cannot detect default branch: neither origin/HEAD nor origin/main exist');
      });
      const deps = makeDeps();

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp/worktree',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        { baseBranch: 'develop' }
      );

      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[11]).toBe('develop');
    });

    it('prefers repo config baseBranch over caller-provided baseBranch', async () => {
      const deps = makeDeps();
      deps.loadConfig = mock(
        async (): Promise<WorkflowConfig> => ({
          assistant: 'claude' as const,
          assistants: { claude: {}, codex: {} },
          baseBranch: 'main',
          commands: { folder: '' },
        })
      ) as unknown as WorkflowDeps['loadConfig'];

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp/worktree',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        { baseBranch: 'develop' }
      );

      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[11]).toBe('main');
    });

    it('prefers baseOverride over repo config baseBranch', async () => {
      // The per-dispatch `--base` override is the top precedence level. Without
      // it ranked above config, a repo that sets `worktree.baseBranch` would cut
      // its worktree from the override but report the CONFIGURED branch as
      // $BASE_BRANCH — telling an AI node it works from a branch the worktree
      // was never cut from, and targeting `gh pr create --base` at the wrong one.
      const deps = makeDeps();
      deps.loadConfig = mock(
        async (): Promise<WorkflowConfig> => ({
          assistant: 'claude' as const,
          assistants: { claude: {}, codex: {} },
          baseBranch: 'main',
          commands: { folder: '' },
        })
      ) as unknown as WorkflowDeps['loadConfig'];

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp/worktree',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        { baseBranch: 'develop', baseOverride: 'epic/foo' }
      );

      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[11]).toBe('epic/foo');
    });

    it('falls back to git auto-detection when config and caller branch are unset', async () => {
      const deps = makeDeps();

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp/worktree',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );

      expect(mockGetDefaultBranch).toHaveBeenCalledWith('/tmp/worktree');
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[11]).toBe('main');
    });

    it('skips git auto-detection for a folder-kind codebase, no ERROR/WARN spam (#2159)', async () => {
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-folder',
          name: 'Ops Root',
          repository_url: null,
          default_cwd: '/tmp/ops',
          kind: 'folder' as const,
        })),
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp/ops',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        { codebaseId: 'cb-folder' }
      );

      // Non-git root: detection is never attempted (no git shell-out), so the
      // benign auto-detect WARN is never emitted and $BASE_BRANCH resolves to
      // empty (unresolved-but-not-referenced).
      expect(mockGetDefaultBranch).not.toHaveBeenCalled();
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[11]).toBe('');
      const warnedAutoDetect = (mockLogFn.mock.calls as unknown[][]).some(
        args => args[1] === 'workflow.base_branch_auto_detect_failed'
      );
      expect(warnedAutoDetect).toBe(false);
    });

    it('still auto-detects for a repo-kind codebase (folder skip does not over-trigger)', async () => {
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-repo',
          name: 'acme/widget',
          repository_url: 'https://github.com/acme/widget',
          default_cwd: '/repos/widget',
          kind: 'repo' as const,
        })),
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp/worktree',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        { codebaseId: 'cb-repo' }
      );

      expect(mockGetDefaultBranch).toHaveBeenCalledWith('/tmp/worktree');
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[11]).toBe('main');
    });
  });

  // -------------------------------------------------------------------------
  // Resume logic
  // -------------------------------------------------------------------------

  describe('resume logic', () => {
    it('does NOT call findResumableRun on its own', async () => {
      // Two back-to-back executions of the same workflow at the same cwd
      // must not cross-leak. Resume detection lives at the caller; the
      // executor must never touch findResumableRun on its own.
      const findSpy = mock(async () => makeRun({ id: 'stale-prior', status: 'failed' }));
      const store = makeStore({ findResumableRun: findSpy });
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
      expect(findSpy).not.toHaveBeenCalled();
      expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
    });

    it('runs the dag-executor with priorCompletedNodes when caller supplies them', async () => {
      const resumed = makeRun({ id: 'resumed-run', status: 'running' });
      const priorCompletedNodes = new Map([
        ['node-a', { output: 'a-output' }],
        ['node-b', { output: 'b-output' }],
      ]);
      const store = makeStore();
      const deps = makeDeps(store);
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        { preCreatedRun: resumed, priorCompletedNodes }
      );
      // dag-executor receives the priorCompletedNodes map at arg index 15.
      // dag-executor signature: deps, platform, conversationId, cwd, workflow,
      // workflowRun, provider, model, artifactsDir, logDir, baseBranch,
      // docsDir, config, configuredCommandFolder, issueContext, priorCompletedNodes
      const passedPriors = mockExecuteDagWorkflow.mock.calls[0]?.[16] as
        | Map<string, { output: string }>
        | undefined;
      expect(passedPriors).toBe(priorCompletedNodes);
      // No fresh row created when a preCreatedRun is supplied.
      expect(store.createWorkflowRun).not.toHaveBeenCalled();
    });

    it('rejects prior node sessions owned by a different workflow run at ingress', async () => {
      const preCreatedRun = makeRun({ id: 'run-a', status: 'running' });
      const foreignSession: WorkflowRunNodeSession = {
        workflow_run_id: 'run-b',
        node_id: 'source',
        provider: 'claude',
        provider_session_id: 'private-session',
        created_at: '2026-08-19T00:00:00Z',
        updated_at: '2026-08-19T00:00:00Z',
      };
      const store = makeStore();
      const deps = makeDeps(store);

      await expect(
        executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow(),
          'test message',
          'db-conv-1',
          {
            preCreatedRun,
            priorCompletedNodes: new Map([['source', { output: 'prior output' }]]),
            priorNodeSessions: [foreignSession],
          }
        )
      ).rejects.toThrow("Cannot resume workflow run 'run-a' with session state from run 'run-b'");

      expect(deps.loadConfig).not.toHaveBeenCalled();
      expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
      expect(store.createWorkflowRun).not.toHaveBeenCalled();
    });

    it('forwards a hydrated resume snapshot into resumed DAG execution', async () => {
      const candidate = makeRun({ id: 'failed-run', status: 'failed' });
      const resumed = makeRun({ id: 'failed-run', status: 'running' });
      const completedNodeOutputs = new Map([['node-a', { output: 'first output' }]]);
      const tokens = { input: 40, output: 4 };
      const costUsd = 0.25;
      const store = makeStore({
        getDagResumeSnapshot: mock(async () => ({
          completedNodeOutputs,
          fanOutSnapshots: new Map(),
          unresolvedNodeStarts: new Set<string>(),
          tokens,
          costUsd,
        })),
        listWorkflowRunNodeSessions: mock(async () => [
          {
            workflow_run_id: 'failed-run',
            node_id: 'node-a',
            provider: 'claude',
            provider_session_id: 'source-session',
            created_at: '2026-08-19T00:00:00Z',
            updated_at: '2026-08-19T00:00:00Z',
          },
        ]),
        resumeWorkflowRun: mock(async () => resumed),
      });
      const deps = makeDeps(store);

      const hydrated = await hydrateResumableRun(deps, candidate);
      expect(hydrated).not.toBeNull();
      if (!hydrated) throw new Error('Expected resumable workflow to hydrate');

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        hydrated
      );

      const dagCall = mockExecuteDagWorkflow.mock.calls[0];
      expect(dagCall?.[16]).toBe(completedNodeOutputs);
      // Both usage axes travel as one `priorUsage` bundle (#2469) — cost is restored
      // across resume exactly like tokens, so a resumed run's total never regresses.
      expect(dagCall?.[24]).toEqual({ tokens, costUsd });
      expect(dagCall?.[25]).toEqual(hydrated.priorNodeSessions);
      expect(store.createWorkflowRun).not.toHaveBeenCalled();
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
      if (!result.success || 'paused' in result) {
        throw new Error('Expected completed workflow result');
      }
      expect(result.summary).toBe('This is the workflow summary');
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
      if (!result.success || 'paused' in result) {
        throw new Error('Expected completed workflow result');
      }
      expect(result.summary).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Scope artifacts dir threading (#1846)
  // -------------------------------------------------------------------------

  describe('scope artifacts dir threading', () => {
    it('threads scopeArtifactsDir into executeDagWorkflow for persist_session workflows', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({
          nodes: [
            {
              id: 'node1',
              kind: 'agent',
              source: { kind: 'inline', prompt: 'Do something' },
              persist_session: true,
            },
          ],
        }),
        'test message',
        'db-conv-1'
      );
      // Positional arg 20 = scopeArtifactsDir (after workflowPreset). Root is the
      // unregistered-cwd project (`_cwd/tmp`, #2200); scope = workflow name +
      // conversation UUID ('conv-1' from the createWorkflowRun mock;
      // getScopeArtifactsPath is mocked to `${root}/scopes/${wf}/${scope}`).
      const scopeArg = mockExecuteDagWorkflow.mock.calls[0]?.[20] as string | undefined;
      expect(scopeArg).toBe(
        wsPath('_cwd', 'tmp', 'artifacts', 'scopes', 'test-workflow', 'conv-1')
      );
    });

    it('passes undefined scopeArtifactsDir when the workflow uses no session persistence', async () => {
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
      const scopeArg = mockExecuteDagWorkflow.mock.calls[0]?.[20] as string | undefined;
      expect(scopeArg).toBeUndefined();
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
        { preCreatedRun: preRun }
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
        { codebaseId: 'codebase-1' }
      );

      // DB env vars should have been fetched for the codebaseId
      expect(store.getCodebaseEnvVars).toHaveBeenCalledWith('codebase-1');

      // The config passed to executeDagWorkflow (arg index 12) should have merged envVars
      const configArg = mockExecuteDagWorkflow.mock.calls[0]?.[13] as WorkflowConfig | undefined;
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
  // User provider env injection (per-user AI-provider credentials)
  // -------------------------------------------------------------------------

  describe('user provider env injection', () => {
    it('skips injection when isPerUserProviderKeysEnabled returns false', async () => {
      const getUserProviderEnv = mock(async () => ({
        env: { SHOULD_NOT_APPEAR: '1' },
        files: [],
        protectedValues: ['1'],
      }));
      const deps: WorkflowDeps = {
        ...makeDeps(makeStore()),
        isPerUserProviderKeysEnabled: () => false,
        getUserProviderEnv,
      };
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-c1',
        { userId: 'u-1' }
      );
      expect(getUserProviderEnv).not.toHaveBeenCalled();
    });

    it('skips injection when userId is absent even if feature is enabled', async () => {
      const getUserProviderEnv = mock(async () => ({
        env: { SHOULD_NOT_APPEAR: '1' },
        files: [],
        protectedValues: ['1'],
      }));
      const deps: WorkflowDeps = {
        ...makeDeps(makeStore()),
        isPerUserProviderKeysEnabled: () => true,
        getUserProviderEnv,
      };
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-c1'
        // no userId
      );
      expect(getUserProviderEnv).not.toHaveBeenCalled();
    });

    it('merges user provider env LAST so it overrides DB env', async () => {
      const store = makeStore({
        getCodebaseEnvVars: mock(async () => ({
          DATABASE_URL: 'db_val',
          BASE_BRANCH: 'reserved-db-secret',
          SHARED_KEY: 'db',
        })),
      });
      const getUserProviderEnv = mock(async () => ({
        env: { SHARED_KEY: 'user_wins', USER_KEY: 'u_val' },
        files: [] as { path: string; contents: string }[],
        protectedValues: ['user_wins', 'u_val'],
      }));
      const deps: WorkflowDeps = {
        ...makeDeps(store),
        isPerUserProviderKeysEnabled: () => true,
        getUserProviderEnv,
      };
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-c1',
        { codebaseId: 'codebase-1', userId: 'u-1' }
      );
      const configArg = mockExecuteDagWorkflow.mock.calls[0]?.[13] as WorkflowConfig | undefined;
      expect(configArg?.envVars).toMatchObject({
        DATABASE_URL: 'db_val',
        BASE_BRANCH: 'reserved-db-secret',
        SHARED_KEY: 'user_wins',
        USER_KEY: 'u_val',
      });
      expect(configArg?.protectedEnvKeys).toEqual(['SHARED_KEY', 'USER_KEY']);
      expect(configArg?.protectedCredentialValues).toEqual([
        'db_val',
        'reserved-db-secret',
        'user_wins',
        'u_val',
      ]);
    });

    it('protects bot and per-user GitHub credentials beside provider credentials', async () => {
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'codebase-1',
          name: 'demo',
          repository_url: 'https://github.com/acme/demo',
          default_cwd: '/tmp',
          kind: 'repo' as const,
        })),
      });
      const deps: WorkflowDeps = {
        ...makeDeps(store),
        resolveBotGitHubToken: mock(async () => 'bot-token'),
        isPerUserGitHubEnabled: () => true,
        getUserGithubToken: mock(async () => 'user-token'),
        isPerUserProviderKeysEnabled: () => true,
        getUserProviderEnv: mock(async () => ({
          env: { ANTHROPIC_API_KEY: 'provider-token' },
          files: [],
          protectedValues: ['provider-token'],
        })),
      };

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-c1',
        { codebaseId: 'codebase-1', userId: 'u-1' }
      );

      const configArg = mockExecuteDagWorkflow.mock.calls[0]?.[13] as WorkflowConfig | undefined;
      expect(configArg?.envVars).toMatchObject({
        GH_TOKEN: 'user-token',
        GITHUB_TOKEN: 'user-token',
        COPILOT_GITHUB_TOKEN: '',
        ANTHROPIC_API_KEY: 'provider-token',
      });
      expect(configArg?.protectedEnvKeys).toEqual([
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'COPILOT_GITHUB_TOKEN',
        'ANTHROPIC_API_KEY',
      ]);
      expect(configArg?.protectedCredentialValues).toEqual(['provider-token']);
    });

    it('removes stale credential files before a credential refresh failure', async () => {
      const artifactsDir = wsPath('_cwd', 'tmp', 'artifacts', 'runs', 'run-123');
      const codexAuthPath = join(artifactsDir, 'codex-home', 'auth.json');
      const piAuthPath = join(artifactsDir, 'pi-home', 'auth.json');
      await mkdir(dirname(codexAuthPath), { recursive: true });
      await mkdir(dirname(piAuthPath), { recursive: true });
      await writeFile(codexAuthPath, 'stale-codex-secret');
      await writeFile(piAuthPath, 'stale-pi-secret');
      const deps: WorkflowDeps = {
        ...makeDeps(makeStore()),
        isPerUserProviderKeysEnabled: () => true,
        getUserProviderEnv: mock(async () => {
          throw new Error('network down');
        }),
      };
      try {
        await expect(
          executeWorkflow(deps, makePlatform(), 'conv-1', '/tmp', makeWorkflow(), 'msg', 'db-c1', {
            userId: 'u-1',
          })
        ).resolves.toBeDefined();
        await expect(readFile(codexAuthPath, 'utf8')).rejects.toThrow();
        await expect(readFile(piAuthPath, 'utf8')).rejects.toThrow();
      } finally {
        await rm(join(artifactsDir, 'codex-home'), { recursive: true, force: true });
        await rm(join(artifactsDir, 'pi-home'), { recursive: true, force: true });
      }
    });

    it('retains protected values when a later credential file write fails', async () => {
      const credentialValue = 'oauth-partial-write-secret';
      const deliveryRoot = await mkdtemp(join(tmpdir(), 'archon-provider-delivery-'));
      const firstFile = join(deliveryRoot, 'codex-auth.json');
      const impossibleSecondFile = join(firstFile, 'pi-auth.json');
      const deps: WorkflowDeps = {
        ...makeDeps(makeStore()),
        isPerUserProviderKeysEnabled: () => true,
        getUserProviderEnv: mock(async () => ({
          env: { CODEX_HOME: deliveryRoot },
          files: [
            { path: firstFile, contents: credentialValue },
            { path: impossibleSecondFile, contents: credentialValue },
          ],
          protectedValues: [credentialValue],
        })),
      };

      try {
        await expect(
          executeWorkflow(deps, makePlatform(), 'conv-1', '/tmp', makeWorkflow(), 'msg', 'db-c1', {
            userId: 'u-1',
          })
        ).resolves.toBeDefined();

        const configArg = mockExecuteDagWorkflow.mock.calls[0]?.[13] as WorkflowConfig | undefined;
        expect(await readFile(firstFile, 'utf8')).toBe(credentialValue);
        expect(configArg?.envVars).not.toHaveProperty('CODEX_HOME');
        expect(configArg?.protectedCredentialValues).toEqual([credentialValue]);
      } finally {
        await rm(deliveryRoot, { recursive: true, force: true });
      }
    });

    it('uses the persisted user identity to rebuild credential provenance on resume', async () => {
      const getUserProviderEnv = mock(async () => ({
        env: { CODEX_HOME: '/run/codex-home' },
        files: [],
        protectedValues: ['persisted-user-token'],
      }));
      const deps: WorkflowDeps = {
        ...makeDeps(makeStore()),
        isPerUserProviderKeysEnabled: () => true,
        getUserProviderEnv,
      };

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-c1',
        {
          preCreatedRun: makeRun({ user_id: 'persisted-user' }),
          userId: 'transient-resumer',
        }
      );

      expect(getUserProviderEnv).toHaveBeenCalledWith('persisted-user', expect.any(String));
      const configArg = mockExecuteDagWorkflow.mock.calls[0]?.[13] as WorkflowConfig | undefined;
      expect(configArg?.protectedCredentialValues).toEqual(['persisted-user-token']);
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
    // resumeWorkflowRun DB-error coverage lives in the hydrateResumableRun
    // suite — those errors surface at the caller now, not in the executor.

    it('cancels workflowRun when guard query throws (no zombie row)', async () => {
      const cancelSpy = mock(async () => ({ cancelled: true }));
      const store = makeStore({
        getActiveWorkflowRunByPath: mock(async () => {
          throw new Error('DB connection lost during guard');
        }),
        cancelWorkflowRun: cancelSpy,
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
      expect(cancelSpy).toHaveBeenCalledTimes(1);
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
        started_at: new Date(Date.now() - 10000),
      });
      const sendMessageSpy = mock<IWorkflowPlatform['sendMessage']>(
        async (_conversationId, _message, _metadata) => {}
      );
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
        started_at: new Date(Date.now() - 500),
      });
      const sendMessageSpy = mock<IWorkflowPlatform['sendMessage']>(
        async (_conversationId, _message, _metadata) => {}
      );
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
        started_at: new Date(Date.now() - 60000),
      });
      const sendMessageSpy = mock<IWorkflowPlatform['sendMessage']>(
        async (_conversationId, _message, _metadata) => {}
      );
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

  // #2304 — the persistence block must distinguish three `identityResolution` outcomes:
  //   • 'faulted'      → skip the `output_root` write, stamp the metadata flag
  //                      (`metadata.identity_unresolved = true`). The row keeps
  //                      `output_root` NULL so a later resume can self-heal.
  //   • 'unregistered' → cwd fallback IS the correct location for this row;
  //                      persist `output_root` exactly as before.
  //   • 'resolved'     → repo/folder/_local key; persist `output_root` as before.
  describe('output_root persistence branching (#2304)', () => {
    it('does NOT write output_root when identityResolution is "faulted"; stamps the metadata flag instead', async () => {
      const updateSpy = mock(async () => {});
      const store = makeStore({
        // Both attempts throw — the retry yields the same fault.
        getCodebase: mock(async () => {
          throw new Error('db down');
        }),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/repos/widget',
        makeWorkflow(),
        'test',
        'db-conv-1',
        { codebaseId: 'cb-boom' }
      );

      const writesWithOutputRoot = updateSpy.mock.calls.filter(
        (call: unknown[]) => typeof (call[1] as { output_root?: unknown })?.output_root === 'string'
      );
      expect(writesWithOutputRoot).toHaveLength(0);

      const flagWrite = updateSpy.mock.calls.find(
        (call: unknown[]) =>
          (call[1] as { metadata?: Record<string, unknown> })?.metadata?.[
            RUN_METADATA_KEYS.identityUnresolved
          ] === true
      );
      expect(flagWrite).toBeDefined();
      // The patch must not also write `output_root` — a NULL `output_root`
      // means a later resume can still self-heal.
      const patch = (flagWrite as unknown as [unknown, { output_root?: unknown }] | undefined)?.[1];
      expect(patch?.output_root).toBeUndefined();
    });

    it('persists output_root when identityResolution is "resolved" (a registered codebase)', async () => {
      const updateSpy = mock(async () => {});
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-repo',
          name: 'acme/widget',
          repository_url: 'https://github.com/acme/widget',
          default_cwd: '/repos/widget',
          kind: 'repo' as const,
        })),
        updateWorkflowRun: updateSpy,
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/repos/widget',
        makeWorkflow(),
        'test',
        'db-conv-1',
        { codebaseId: 'cb-repo' }
      );

      const write = updateSpy.mock.calls.find(
        (call: unknown[]) => typeof (call[1] as { output_root?: unknown })?.output_root === 'string'
      );
      expect(write).toBeDefined();
      // The metadata flag must NOT be stamped on a resolved row — that flag is the
      // faulted-only signal.
      const flagWrite = updateSpy.mock.calls.find(
        (call: unknown[]) =>
          (call[1] as { metadata?: Record<string, unknown> })?.metadata?.[
            RUN_METADATA_KEYS.identityUnresolved
          ] !== undefined
      );
      expect(flagWrite).toBeUndefined();
    });

    // #2304 — the contract is "Cleared by the same persistence block the moment
    // a later resume writes a real root". The faulted arm stamps `true`; the
    // else arm MUST ride the same atomic metadata write with `false` on the
    // heal, or a row that has resolved leaves the flag set and the
    // state-preflight gate (#2200) / maintainer-triage read it as still faulted.
    it('clears metadata.identity_unresolved when a faulted row heals (resolved on resume)', async () => {
      const updateSpy = mock(async () => {});
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-repo',
          name: 'acme/widget',
          repository_url: 'https://github.com/acme/widget',
          default_cwd: '/repos/widget',
          kind: 'repo' as const,
        })),
        updateWorkflowRun: updateSpy,
        // Simulate a previously-faulted row whose first run left `output_root`
        // NULL and stamped the flag. The next run arrives on a healthy registry
        // and hits the else-arm with that pre-existing metadata.
        createWorkflowRun: mock(async () =>
          makeRun({
            metadata: { [RUN_METADATA_KEYS.identityUnresolved]: true },
          })
        ),
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/repos/widget',
        makeWorkflow(),
        'test',
        'db-conv-1',
        { codebaseId: 'cb-repo' }
      );

      const healWrite = updateSpy.mock.calls.find(
        (call: unknown[]) => typeof (call[1] as { output_root?: unknown })?.output_root === 'string'
      );
      expect(healWrite).toBeDefined();
      const patch = (
        healWrite as unknown as
          | [unknown, { output_root?: unknown; metadata?: Record<string, unknown> }]
          | undefined
      )?.[1];
      // The output_root write still happens — a row that has resolved
      // gets a real root, that's the whole point of the resume.
      expect(typeof patch?.output_root).toBe('string');
      // AND the metadata flag rides the same write as `false`, not as
      // the stale `true` from the faulted arm.
      expect(patch?.metadata).toEqual({ [RUN_METADATA_KEYS.identityUnresolved]: false });
    });

    // Defensive neighbour: a row that never was faulted must not have its
    // metadata touched by the else-arm writer. The cleared-flag stamp is
    // conditional, not unconditional.
    it('does not touch metadata when the row was never flagged as faulted', async () => {
      const updateSpy = mock(async () => {});
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-repo',
          name: 'acme/widget',
          repository_url: 'https://github.com/acme/widget',
          default_cwd: '/repos/widget',
          kind: 'repo' as const,
        })),
        updateWorkflowRun: updateSpy,
        createWorkflowRun: mock(async () => makeRun({ metadata: {} })),
      });
      const deps = makeDeps(store);

      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/repos/widget',
        makeWorkflow(),
        'test',
        'db-conv-1',
        { codebaseId: 'cb-repo' }
      );

      const outputRootWrite = updateSpy.mock.calls.find(
        (call: unknown[]) => typeof (call[1] as { output_root?: unknown })?.output_root === 'string'
      );
      expect(outputRootWrite).toBeDefined();
      const patch = (
        outputRootWrite as unknown as [unknown, { metadata?: Record<string, unknown> }] | undefined
      )?.[1];
      expect(patch?.metadata).toBeUndefined();
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Terminal status writes outside the DAG (#2910)
//
// executeWorkflow records a run's terminal status from ten places, not just the
// four inside executeDagWorkflow. These cover the distinct shapes: a setup guard
// that would otherwise RETURN an ordinary failure, one that would otherwise
// RETHROW its own error, and the two main-path writes whose interaction decides
// whether the finally backstop fires a second, masking write.
// ───────────────────────────────────────────────────────────────────────────
describe('terminal status writes in executor setup', () => {
  beforeEach(() => {
    mockExecuteDagWorkflow.mockClear();
    mockExecuteDagWorkflow.mockImplementation(async () => undefined);
  });

  it('rejects instead of returning an ordinary failure when a setup guard cannot record it', async () => {
    // Invocation-metadata persistence fails, and so does the failWorkflowRun that
    // exists to recover it. Without the marker this returned `{ success: false }` —
    // a normal failed run, over a row still saying pending/running.
    const store = makeStore({
      updateWorkflowRun: mock(async () => {
        throw new Error('metadata write failed');
      }),
      failWorkflowRun: mock(async () => {
        throw new Error('recovery write failed');
      }),
    });

    await expect(
      executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        { preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }) }
      )
    ).rejects.toThrow('Failed to persist terminal workflow status');

    expect(mockExecuteDagWorkflow).not.toHaveBeenCalled();
  });

  it('still returns an ordinary failure when the setup guard CAN record it', async () => {
    // The other side of the branch: the recovery write succeeds, so the caller keeps
    // getting a plain failed result rather than a rejection.
    const store = makeStore({
      updateWorkflowRun: mock(async () => {
        throw new Error('metadata write failed');
      }),
    });

    const result = await executeWorkflow(
      makeDeps(store),
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'msg',
      'db-conv-1',
      { preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }) }
    );

    expect(result.success).toBe(false);
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('replaces a rethrown setup error with the marker when its record write fails', async () => {
    // The run-config guard rethrows its own error after recording it. A failed record
    // has to win: the caller must learn the status is unwritten, not just that config
    // sealing was unavailable.
    const store = makeStore({
      failWorkflowRun: mock(async () => {
        throw new Error('recovery write failed');
      }),
    });

    await expect(
      executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-conv-1',
        {
          preCreatedRun: makeRun({ id: 'pending-run', status: 'pending' }),
          // No `sealRunConfig` on the test deps, so the guard throws.
          runConfig: { layer: {}, source: 'cli' },
        } as unknown as Parameters<typeof executeWorkflow>[7]
      )
    ).rejects.toThrow('Failed to persist terminal workflow status');
  });

  it('does not let the finally backstop mask a failed catch-path write', async () => {
    // The catch's own failWorkflowRun fails. The backstop sees a row still at
    // 'running' and would fire a second write over the same channel — masking the
    // real error with "exited without finalizing". The flag has to stop it.
    mockExecuteDagWorkflow.mockRejectedValueOnce(new Error('dag boom'));
    const failWorkflowRun = mock(async () => {
      throw new Error('terminal failure write failed');
    });
    const store = makeStore({
      failWorkflowRun,
      getWorkflowRunStatus: mock(async () => 'running' as const),
    });

    await expect(
      executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-conv-1'
      )
    ).rejects.toThrow('terminal failure write failed');

    expect(failWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed backstop write instead of exiting cleanly', async () => {
    // The backstop is the last thing standing between a zombie row and a clean exit.
    // If its write fails, the process must not report a finished run.
    const store = makeStore({
      getWorkflowRunStatus: mock(async () => 'running' as const),
      failWorkflowRun: mock(async () => {
        throw new Error('backstop write failed');
      }),
    });

    await expect(
      executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-conv-1'
      )
    ).rejects.toThrow('Failed to persist terminal workflow status');
  });
});

describe('finally backstop', () => {
  it('calls failWorkflowRun when run is still running at finally', async () => {
    const failSpy = mock(async () => {});
    const store = makeStore({
      getWorkflowRunStatus: mock(async () => 'running' as const),
      failWorkflowRun: failSpy,
    });
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'test',
      'db-conv-1'
    );

    const call = (failSpy.mock.calls as unknown[][]).find(
      c => typeof c[1] === 'string' && (c[1] as string).includes('exited without finalizing')
    );
    expect(call).toBeDefined();
  });

  it('does not call failWorkflowRun when run already completed', async () => {
    const failSpy = mock(async () => {});
    const store = makeStore({
      getWorkflowRunStatus: mock(async () => 'completed' as const),
      failWorkflowRun: failSpy,
    });
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'test',
      'db-conv-1'
    );

    const backstopCall = (failSpy.mock.calls as unknown[][]).find(
      c => typeof c[1] === 'string' && (c[1] as string).includes('exited without finalizing')
    );
    expect(backstopCall).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Telemetry wiring
//
// captureWorkflowCompleted is mocked as a no-op; these tests assert it actually
// fires on the unhandled-throw path (and only there from the executor) and that
// the WorkflowSource is threaded into executeDagWorkflow. Telemetry regressions
// are otherwise invisible — a dropped call leaves no failing assertion.
// ───────────────────────────────────────────────────────────────────────────
describe('telemetry wiring', () => {
  beforeEach(() => {
    mockExecuteDagWorkflow.mockClear();
    mockCaptureWorkflowCompleted.mockClear();
    mockExecuteDagWorkflow.mockImplementation(async (): Promise<string | undefined> => undefined);
  });

  it('captures workflow_failed with unhandled_error when executeDagWorkflow throws', async () => {
    mockExecuteDagWorkflow.mockRejectedValueOnce(new Error('dag boom'));
    const store = makeStore();
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'msg',
      'db-conv-1'
    );

    // Exactly once — the executor catch must not double-emit with the DAG paths.
    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorkflowCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', exitReason: 'unhandled_error' })
    );
    expect(store.failWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.createWorkflowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'workflow_failed' })
    );
  });

  it('surfaces a failed terminal failure write', async () => {
    mockExecuteDagWorkflow.mockRejectedValueOnce(new Error('dag boom'));
    const store = makeStore({
      failWorkflowRun: mock(async () => {
        throw new Error('terminal failure write failed');
      }),
    });

    await expect(
      executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-conv-1'
      )
    ).rejects.toThrow('terminal failure write failed');
  });

  it('does not recover a rejected DAG terminal write with a second failure write', async () => {
    mockExecuteDagWorkflow.mockRejectedValueOnce(
      new TerminalStatusWriteError(new Error('terminal completion write failed'))
    );
    const failWorkflowRun = mock(async () => {});
    const store = makeStore({ failWorkflowRun });

    await expect(
      executeWorkflow(
        makeDeps(store),
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'msg',
        'db-conv-1'
      )
    ).rejects.toThrow('terminal completion write failed');

    expect(failWorkflowRun).not.toHaveBeenCalled();
  });

  it('reports feature-adoption booleans on workflow_invoked', async () => {
    mockCaptureWorkflowInvoked.mockClear();
    const store = makeStore();
    const deps = makeDeps(store);
    const workflow = makeWorkflow({
      persist_sessions: true,
      nodes: [
        {
          id: 'gen',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Generate.' },
          output_format: { type: 'object' },
          mcp: 'mcp.json',
        },
        {
          id: 'iterate',
          depends_on: ['gen'],
          kind: 'loop',
          loop: { prompt: 'Iterate.', until: 'DONE', fresh_context: true },
        },
        {
          id: 'summarize',
          depends_on: ['iterate'],
          kind: 'agent',
          source: { kind: 'inline', prompt: 'Summarize.' },
          output_type: 'report',
        },
      ],
    } as Partial<WorkflowDefinition>);

    await executeWorkflow(deps, makePlatform(), 'conv-1', '/tmp', workflow, 'msg', 'db-conv-1');

    expect(mockCaptureWorkflowInvoked).toHaveBeenCalledTimes(1);
    expect(mockCaptureWorkflowInvoked).toHaveBeenCalledWith(
      expect.objectContaining({
        usesOutputFormat: true,
        usesOutputType: true,
        usesPersistSession: true,
        usesMcp: true,
        usesFreshContext: true,
        usesSkills: false,
      })
    );
  });

  it('reports adoption booleans as false for a plain single-prompt workflow', async () => {
    mockCaptureWorkflowInvoked.mockClear();
    const store = makeStore();
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'msg',
      'db-conv-1'
    );

    expect(mockCaptureWorkflowInvoked).toHaveBeenCalledWith(
      expect.objectContaining({
        usesOutputFormat: false,
        usesOutputType: false,
        usesPersistSession: false,
        usesMcp: false,
        usesSkills: false,
        usesFreshContext: false,
      })
    );
  });

  it('does not fire executor-level completion telemetry on the success path', async () => {
    // The DAG executor owns success/partial-failure telemetry; the executor's
    // own captureWorkflowCompleted must fire only from the unhandled-throw catch.
    const store = makeStore();
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'msg',
      'db-conv-1'
    );

    expect(mockCaptureWorkflowCompleted).not.toHaveBeenCalled();
  });

  it('threads source through to executeDagWorkflow (arg index 16)', async () => {
    const store = makeStore();
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'msg',
      'db-conv-1',
      {
        source: 'bundled',
      }
    );

    expect(mockExecuteDagWorkflow.mock.calls[0]?.[17]).toBe('bundled');
  });

  it('resolves top-level workflow tier refs before calling the DAG executor', async () => {
    const store = makeStore();
    const deps = {
      ...makeDeps(store),
      loadConfig: mock(
        async (): Promise<WorkflowConfig> => ({
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          baseBranch: '',
          commands: { folder: '' },
          tiers: {
            large: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
          },
        })
      ),
    } as WorkflowDeps;

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ model: 'large' }),
      'msg',
      'db-conv-1'
    );

    expect(mockExecuteDagWorkflow.mock.calls[0]?.[6]).toBe('codex');
    expect(mockExecuteDagWorkflow.mock.calls[0]?.[7]).toBe('gpt-5.5');
    expect(mockExecuteDagWorkflow.mock.calls[0]?.[18]).toEqual(
      expect.objectContaining({
        aliases: expect.objectContaining({
          large: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
        }),
      })
    );
    expect(mockExecuteDagWorkflow.mock.calls[0]?.[19]).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    });
  });

  it('applies per-user AI prefs as the highest-precedence resolver layer', async () => {
    const store = makeStore();
    const getUserAiPrefs = mock(async () => ({
      tiers: { large: { provider: 'codex', model: 'gpt-5.5', effort: 'high' } },
    }));
    const deps = {
      ...makeDeps(store),
      loadConfig: mock(
        async (): Promise<WorkflowConfig> => ({
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          baseBranch: '',
          commands: { folder: '' },
          tiers: {
            large: { provider: 'claude', model: 'opus' },
          },
        })
      ),
      getUserAiPrefs,
    } as WorkflowDeps;

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ model: 'large' }),
      'msg',
      'db-conv-1',
      { userId: 'user-1' }
    );

    expect(getUserAiPrefs).toHaveBeenCalledWith('user-1');
    // User tier wins over the config tier for the same key.
    expect(mockExecuteDagWorkflow.mock.calls[0]?.[6]).toBe('codex');
    expect(mockExecuteDagWorkflow.mock.calls[0]?.[7]).toBe('gpt-5.5');
  });

  it('does not consult per-user AI prefs without a userId (solo unchanged)', async () => {
    const store = makeStore();
    const getUserAiPrefs = mock(async () => ({}));
    const deps = { ...makeDeps(store), getUserAiPrefs } as WorkflowDeps;

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'msg',
      'db-conv-1'
    );

    expect(getUserAiPrefs).not.toHaveBeenCalled();
  });

  it('a throwing getUserAiPrefs dep degrades to config-only (run still starts)', async () => {
    const store = makeStore();
    const deps = {
      ...makeDeps(store),
      getUserAiPrefs: mock(async () => {
        throw new Error('db down');
      }),
    } as WorkflowDeps;

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ model: 'large' }),
      'msg',
      'db-conv-1',
      { userId: 'user-1' }
    );

    // Config default is claude → built-in tier defaults resolve 'large'.
    expect(mockExecuteDagWorkflow.mock.calls[0]?.[6]).toBe('claude');
  });

  it('structurally invalid stored prefs degrade to config-only (run still starts)', async () => {
    const store = makeStore();
    const deps = {
      ...makeDeps(store),
      // An alias without the '@' prefix makes buildAiProfile throw.
      getUserAiPrefs: mock(async () => ({
        aliases: { fast: { provider: 'claude', model: 'haiku' } },
      })),
    } as WorkflowDeps;

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ model: 'large' }),
      'msg',
      'db-conv-1',
      { userId: 'user-1' }
    );

    expect(mockExecuteDagWorkflow.mock.calls[0]?.[6]).toBe('claude');
  });

  it("per-user default provider rebases tier defaults for the run's profile", async () => {
    const store = makeStore();
    const deps = {
      ...makeDeps(store),
      getUserAiPrefs: mock(async () => ({ defaultProvider: 'codex' })),
    } as WorkflowDeps;

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ model: 'large' }),
      'msg',
      'db-conv-1',
      { userId: 'user-1' }
    );

    // No tiers configured anywhere → built-in tier defaults follow the
    // user's default provider, not the install config's.
    expect(mockExecuteDagWorkflow.mock.calls[0]?.[6]).toBe('codex');
  });

  it('passes undefined source when the caller does not supply one', async () => {
    const store = makeStore();
    const deps = makeDeps(store);

    await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'msg',
      'db-conv-1'
    );

    expect(mockExecuteDagWorkflow.mock.calls[0]?.[17]).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// hydrateResumableRun
//
// Resume preparation is a caller-side primitive: callers look up the
// candidate themselves (via findResumableRun or
// findResumableRunByParentConversation) and call hydrateResumableRun to
// turn it into the form executeWorkflow expects. The executor only consumes
// what this returns.
// ───────────────────────────────────────────────────────────────────────────

describe('hydrateResumableRun', () => {
  it('inspects resumable state without claiming the run', async () => {
    const candidate = makeRun({ id: 'read-only-prior', status: 'paused' });
    const priorNodes = new Map([['n1', { output: 'out1' }]]);
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: priorNodes,
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        tokens: { input: 4, output: 1 },
        costUsd: 0.1,
      })),
    });

    const result = await inspectResumableRun(makeDeps(store), candidate);

    expect(result).toEqual({
      priorCompletedNodes: priorNodes,
      priorUsage: { tokens: { input: 4, output: 1 }, costUsd: 0.1 },
    });
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
    expect(store.listWorkflowRunNodeSessions).not.toHaveBeenCalled();
  });

  it('returns hydrated run + prior outputs for a candidate with completed nodes', async () => {
    const candidate = makeRun({ id: 'prior-failed', status: 'failed' });
    const resumed = makeRun({ id: 'prior-failed', status: 'running' });
    const priorNodes = new Map([['n1', { output: 'out1' }]]);
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: priorNodes,
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        tokens: { input: 40, output: 4 },
        costUsd: 0.75,
      })),
      listWorkflowRunNodeSessions: mock(async () => [
        {
          workflow_run_id: 'prior-failed',
          node_id: 'n1',
          provider: 'claude',
          provider_session_id: 'session-n1',
          created_at: '2026-08-19T00:00:00Z',
          updated_at: '2026-08-19T00:00:00Z',
        },
        {
          workflow_run_id: 'prior-failed',
          node_id: 'not-completed',
          provider: 'claude',
          provider_session_id: 'must-be-filtered',
          created_at: '2026-08-19T00:00:00Z',
          updated_at: '2026-08-19T00:00:00Z',
        },
      ]),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.preCreatedRun).toBe(resumed);
    expect(result?.priorCompletedNodes).toBe(priorNodes);
    expect(result?.priorUsage).toEqual({ tokens: { input: 40, output: 4 }, costUsd: 0.75 });
    expect(result?.priorNodeSessions.map(row => row.node_id)).toEqual(['n1']);
    expect(store.listWorkflowRunNodeSessions).toHaveBeenCalledWith('prior-failed');
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('prior-failed');
  });

  it('returns null when candidate has no completed nodes and no interactive-loop state', async () => {
    const candidate = makeRun({ id: 'empty-prior', status: 'failed' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).toBeNull();
    // Must not transition the run — there is nothing to resume.
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
  });

  it('hydrates fan-out-only recovery state before any inner node completed', async () => {
    const fanOutSnapshots = new Map([
      [
        'fan',
        [
          {
            ordinal: 0,
            identity: 'instance-a',
            item: 'a',
            inputs: { item: 'a' },
          },
        ],
      ],
    ]);
    const candidate = makeRun({ id: 'fan-out-only', status: 'failed' });
    const resumed = makeRun({ id: 'fan-out-only', status: 'running' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots,
        unresolvedNodeStarts: new Set(['fan__instance-a']),
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });

    const result = await hydrateResumableRun(makeDeps(store), candidate);

    expect(result).not.toBeNull();
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('fan-out-only');
  });

  it('returns hydrated run when interactive-loop state is present even with zero completed nodes', async () => {
    const candidate = makeRun({
      id: 'paused-loop',
      status: 'paused',
      metadata: {
        approval: { type: 'interactive_loop', nodeId: 'loop-1', message: 'Iterate?', iteration: 2 },
      },
    });
    const resumed = makeRun({ id: 'paused-loop', status: 'running' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.priorCompletedNodes.size).toBe(0);
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('paused-loop');
  });

  it.each([
    [
      'first-node wait',
      'paused',
      {
        wait: {
          owner: 'node',
          nodeId: 'delay',
          kind: 'time',
          waitingSince: '2026-08-24T10:00:00.000Z',
          resumeAt: '2026-08-24T11:00:00.000Z',
        },
      },
    ],
    [
      'first-node quota continuation',
      'failed',
      {
        scheduled_resume: {
          reason: 'quota',
          resumeAt: '2026-08-24T11:00:00.000Z',
          deadlineAt: '2026-08-25T11:00:00.000Z',
          attempt: 1,
          maxAttempts: 1,
          error: 'usage limit reached',
        },
      },
    ],
  ] as const)('hydrates a %s with zero completed nodes', async (_label, status, metadata) => {
    const candidate = makeRun({ id: 'first-node-continuation', status, metadata });
    const resumed = makeRun({ id: 'first-node-continuation', status: 'running', metadata });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });

    const result = await hydrateResumableRun(makeDeps(store), candidate);

    expect(result).not.toBeNull();
    expect(result?.priorCompletedNodes.size).toBe(0);
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('first-node-continuation');
  });

  it('#2714 regression: resumes a first-node legacy on_reject gate with a genuinely staged rework, even with zero completed nodes', async () => {
    // rejectWorkflow's stage-rework path (workflow-operations.ts) never writes
    // node_completed — it only stamps metadata.approval.resolved/rejection_reason
    // on the run. Before the reRunsOwnNodeOnResume fix, a first-node gate in
    // this state was unresumable: priorCompletedNodes.size === 0 and the old
    // hasReRunGateState check omitted 'approval' entirely.
    const candidate = makeRun({
      id: 'paused-first-gate',
      status: 'paused',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Please review',
          resolved: 'rejected',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
        },
        rejection_reason: 'needs more tests',
        rejection_count: 1,
      },
    });
    const resumed = makeRun({ id: 'paused-first-gate', status: 'running' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.priorCompletedNodes.size).toBe(0);
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('paused-first-gate');
  });

  it('#2714: an unresolved (not-yet-rejected) legacy on_reject gate with zero completed nodes is NOT resumable', async () => {
    // A fresh pause (nobody has rejected it yet) has onRejectPrompt set but no
    // rejection_reason and resolved !== 'rejected' — there is nothing staged
    // to re-run, so this must still return null (approve/reject, not resume,
    // is the correct next action).
    const candidate = makeRun({
      id: 'paused-unresolved-gate',
      status: 'paused',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'review',
          message: 'Please review',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
        },
      },
    });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).toBeNull();
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
  });

  it('#2707 new-mode gate needs no carve-out: resolving it writes node_completed, so priorCompletedNodes already covers resume', async () => {
    // A new-mode gate (no onRejectPrompt) never stages anything outside a
    // node_completed event — this is the structural closure argument for
    // #2714: the bug's mechanism (resolved-but-zero-completed-nodes) cannot
    // occur for this path. Simulated here via the ORDINARY completed-nodes
    // route, not the gate-state carve-out.
    const candidate = makeRun({ id: 'paused-new-mode-gate', status: 'paused' });
    const resumed = makeRun({ id: 'paused-new-mode-gate', status: 'running' });
    const priorNodes = new Map([
      ['review', { output: JSON.stringify({ decision: 'reject', text: 'needs changes' }) }],
    ]);
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: priorNodes,
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.priorCompletedNodes).toBe(priorNodes);
  });

  it('propagates DB errors from getDagResumeSnapshot (no silent fallback)', async () => {
    const candidate = makeRun({ id: 'prior-failed', status: 'failed' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => {
        throw new Error('DB read failed');
      }),
    });
    const deps = makeDeps(store);
    await expect(hydrateResumableRun(deps, candidate)).rejects.toThrow('DB read failed');
  });

  it('propagates DB errors from resumeWorkflowRun (no silent fallback)', async () => {
    const candidate = makeRun({ id: 'prior-failed', status: 'failed' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map([['n1', { output: 'v1' }]]),
        fanOutSnapshots: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })),
      resumeWorkflowRun: mock(async () => {
        throw new Error('DB write failed');
      }),
    });
    const deps = makeDeps(store);
    await expect(hydrateResumableRun(deps, candidate)).rejects.toThrow('DB write failed');
  });
});

describe('resolveProjectPaths', () => {
  const RUN_ID = 'run-xyz';

  it('routes folder projects to _folder/<slug>/ storage', async () => {
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-folder',
        name: 'My Platform',
        repository_url: null,
        default_cwd: '/tmp/platform',
        kind: 'folder' as const,
      })),
    });
    const deps = makeDeps(store);

    const paths = await resolveProjectPaths(deps, '/tmp/platform', RUN_ID, 'cb-folder');

    expect(paths.artifactsDir).toBe(
      wsPath('_folder', 'My Platform', 'artifacts', 'runs', 'run-xyz')
    );
    expect(paths.logDir).toBe(wsPath('_folder', 'My Platform', 'logs'));
    expect(paths.artifactsRoot).toBe(wsPath('_folder', 'My Platform', 'artifacts'));
    expect(paths.stateDir).toBe(wsPath('_folder', 'My Platform', 'state'));
    expect(paths.outputRoot).toBe(wsPath('_folder', 'My Platform'));
  });

  // #2304: a transient lookup fault used to drop the run onto `_cwd/<basename>` and,
  // because `output_root` is write-once, pin it there for the run's whole life —
  // including its `$STATE_DIR`, so a stateful workflow silently read an empty state
  // directory. Asserting the RESOLVED PATH rather than the call count: the failure is
  // success-shaped (a valid location, no error), so only the destination proves it.
  it('retries a transient getCodebase fault instead of pinning the cwd fallback (#2304)', async () => {
    let calls = 0;
    const store = makeStore({
      getCodebase: mock(async () => {
        calls++;
        if (calls === 1) throw new Error('connection reset by peer');
        return {
          id: 'cb-repo',
          name: 'acme/widget',
          repository_url: 'https://github.com/acme/widget',
          default_cwd: '/repos/widget',
          kind: 'repo' as const,
        };
      }),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo');

    expect(calls).toBe(2);
    expect(result.artifactsDir).toBe(wsPath('acme', 'widget', 'artifacts', 'runs', 'run-xyz'));
    expect(result.stateDir).toBe(wsPath('acme', 'widget', 'state'));
    expect(result.outputRoot).toBe(wsPath('acme', 'widget'));
  });

  // The retry addresses the TRANSIENT case only. A sustained fault must still reach the
  // fallback rather than throwing — the fallback exists precisely so a registry outage
  // does not kill a run, and that trade was settled before #2304.
  it('still falls back to cwd storage when the fault persists across the retry', async () => {
    let calls = 0;
    const store = makeStore({
      getCodebase: mock(async () => {
        calls++;
        throw new Error('connection reset by peer');
      }),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo');

    expect(calls).toBe(2);
    expect(result.artifactsDir).toBe(wsPath('_cwd', 'widget', 'artifacts', 'runs', 'run-xyz'));
  });

  it('routes repo projects to owner/repo/ storage (unchanged)', async () => {
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-repo',
        name: 'acme/widget',
        repository_url: 'https://github.com/acme/widget',
        default_cwd: '/repos/widget',
        kind: 'repo' as const,
      })),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo');

    expect(result.artifactsDir).toBe(wsPath('acme', 'widget', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(wsPath('acme', 'widget', 'logs'));
    expect(result.artifactsRoot).toBe(wsPath('acme', 'widget', 'artifacts'));
    expect(result.stateDir).toBe(wsPath('acme', 'widget', 'state'));
    expect(result.outputRoot).toBe(wsPath('acme', 'widget'));
  });

  it('routes a no-remote local repo to _local/<basename> storage (#2132)', async () => {
    const paths = await import('@archon/paths');
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-local',
        name: 'workspace',
        repository_url: null,
        default_cwd: '/home/username/workspace',
        kind: 'repo' as const,
      })),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/home/username/workspace', RUN_ID, 'cb-local');

    // Delegates to the ONE shared resolver rather than re-deriving identity.
    expect(paths.resolveProjectStorageKey).toHaveBeenCalled();
    expect(result.artifactsDir).toBe(wsPath('_local', 'workspace', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(wsPath('_local', 'workspace', 'logs'));
    expect(result.stateDir).toBe(wsPath('_local', 'workspace', 'state'));
  });

  it('routes an unregistered cwd to _cwd/<basename> UNDER ARCHON_HOME, never into the repo', async () => {
    const store = makeStore({ getCodebase: mock(async () => null) });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID, 'missing-id');

    // Breaking change (#2200 A4): this used to be <cwd>/.archon/artifacts/...
    expect(result.artifactsDir).toBe(wsPath('_cwd', 'cwd', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(wsPath('_cwd', 'cwd', 'logs'));
    expect(result.stateDir).toBe(wsPath('_cwd', 'cwd', 'state'));
    // Positive form: asserting only `!startsWith('/some/cwd')` passes trivially
    // on win32 (where the result is backslash-separated), so assert the path is
    // actually rooted in the workspace tree.
    expect(result.artifactsDir.startsWith(wsPath('_cwd'))).toBe(true);
  });

  it('routes to _cwd/<basename> when no codebaseId is provided', async () => {
    const deps = makeDeps();

    const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID);

    expect(result.artifactsDir).toBe(wsPath('_cwd', 'cwd', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(wsPath('_cwd', 'cwd', 'logs'));
    expect(result.artifactsRoot).toBe(wsPath('_cwd', 'cwd', 'artifacts'));
    expect(result.stateDir).toBe(wsPath('_cwd', 'cwd', 'state'));
  });

  it('still returns all five paths when the codebase lookup throws', async () => {
    const store = makeStore({
      getCodebase: mock(() => Promise.reject(new Error('db down'))),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID, 'cb-boom');

    expect(result.artifactsDir).toBe(wsPath('_cwd', 'cwd', 'artifacts', 'runs', 'run-xyz'));
    expect(result.stateDir).toBe(wsPath('_cwd', 'cwd', 'state'));
    expect(result.outputRoot).toBe(wsPath('_cwd', 'cwd'));
  });

  it('a persisted output_root short-circuits identity resolution entirely', async () => {
    const paths = await import('@archon/paths');
    const getCodebase = mock(async () => ({
      id: 'cb-repo',
      name: 'acme/renamed-since',
      repository_url: null,
      default_cwd: '/repos/widget',
      kind: 'repo' as const,
    }));
    const deps = makeDeps(makeStore({ getCodebase }));
    (paths.resolveProjectStorageKey as ReturnType<typeof mock>).mockClear();

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo', {
      persistedOutputRoot: wsPath('acme', 'original'),
    });

    // The codebase was renamed since the run started — the durable pointer wins
    // and the row is never even read (#1192 decoupling).
    expect(getCodebase).not.toHaveBeenCalled();
    expect(paths.resolveProjectStorageKey).not.toHaveBeenCalled();
    expect(result.outputRoot).toBe(wsPath('acme', 'original'));
    expect(result.artifactsDir).toBe(wsPath('acme', 'original', 'artifacts', 'runs', 'run-xyz'));
    expect(result.logDir).toBe(wsPath('acme', 'original', 'logs'));
    expect(result.stateDir).toBe(wsPath('acme', 'original', 'state'));
  });

  it('an output_root outside ARCHON_HOME is refused and re-derived', async () => {
    // The engine only ever persists an in-tree root, so this is corruption or a
    // hand edit. Acting on it would scatter artifacts AND shared state under the
    // server's cwd. Two shapes that both escape: absolute-elsewhere and relative.
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-repo',
        name: 'acme/widget',
        repository_url: null,
        default_cwd: '/repos/widget',
        kind: 'repo' as const,
      })),
    });
    const deps = makeDeps(store);

    for (const hostile of ['/etc', '   ', 'relative/path']) {
      const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo', {
        persistedOutputRoot: hostile,
      });
      expect(result.outputRoot).toBe(wsPath('acme', 'widget'));
      expect(result.stateDir).toBe(wsPath('acme', 'widget', 'state'));
    }
  });

  it('a null persisted output_root re-derives from identity', async () => {
    const store = makeStore({
      getCodebase: mock(async () => ({
        id: 'cb-repo',
        name: 'acme/widget',
        repository_url: null,
        default_cwd: '/repos/widget',
        kind: 'repo' as const,
      })),
    });
    const deps = makeDeps(store);

    const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo', {
      persistedOutputRoot: null,
    });

    expect(result.outputRoot).toBe(wsPath('acme', 'widget'));
  });

  // #2304: identityResolution is the row-level flag the persistence block reads to
  // decide whether to write `output_root` or stamp `metadata.identity_unresolved`.
  // The five cases below cover every branch in `resolveProjectPaths`:
  //   • registered repo / folder / _local  → 'resolved'
  //   • codebase row exists, no identity   → 'unregistered' (the WARN arm)
  //   • no codebaseId                      → 'unregistered' (no lookup attempted)
  //   • codebase lookup returns null       → 'unregistered' (no row)
  //   • both attempts throw                → 'faulted' (the ERROR arm)
  //   • persisted-output-root short-circuit → undefined (a resume, no fresh flag)
  describe('identityResolution (#2304)', () => {
    it('is "resolved" for a repo codebase', async () => {
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-repo',
          name: 'acme/widget',
          repository_url: 'https://github.com/acme/widget',
          default_cwd: '/repos/widget',
          kind: 'repo' as const,
        })),
      });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo');

      expect(result.identityResolution).toBe('resolved');
    });

    it('is "resolved" for a folder codebase', async () => {
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-folder',
          name: 'My Platform',
          repository_url: null,
          default_cwd: '/tmp/platform',
          kind: 'folder' as const,
        })),
      });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/tmp/platform', RUN_ID, 'cb-folder');

      expect(result.identityResolution).toBe('resolved');
    });

    it('is "unregistered" when the lookup returns a codebase row that resolves to a cwd key (WARN arm)', async () => {
      // The fake resolver only falls back to { kind: 'cwd', cwd } when the basename
      // is '.' or '..' (the corner that excludes owner/repo and `_local` derivation).
      const store = makeStore({
        getCodebase: mock(async () => ({
          id: 'cb-noop',
          name: 'orphan',
          repository_url: null,
          default_cwd: '/tmp/.',
          kind: 'repo' as const,
        })),
      });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/tmp/.', RUN_ID, 'cb-noop');

      expect(result.identityResolution).toBe('unregistered');
    });

    it('is "unregistered" when no codebaseId is provided (no lookup attempted)', async () => {
      const deps = makeDeps();

      const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID);

      expect(result.identityResolution).toBe('unregistered');
    });

    it('is "unregistered" when the lookup returns null (no codebase row)', async () => {
      const store = makeStore({ getCodebase: mock(async () => null) });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID, 'missing-id');

      expect(result.identityResolution).toBe('unregistered');
    });

    it('is "faulted" when both getCodebase attempts throw (ERROR arm)', async () => {
      const store = makeStore({
        getCodebase: mock(async () => {
          throw new Error('db down');
        }),
      });
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/some/cwd', RUN_ID, 'cb-boom');

      expect(result.identityResolution).toBe('faulted');
    });

    it('is undefined on the persisted-output-root short-circuit (resume reading an existing row)', async () => {
      // A resume reads its `output_root` from the row and re-derives nothing; the
      // persistence block has nothing to flag on a branch that never resolved.
      const store = makeStore();
      const deps = makeDeps(store);

      const result = await resolveProjectPaths(deps, '/repos/widget', RUN_ID, 'cb-repo', {
        persistedOutputRoot: wsPath('acme', 'original'),
      });

      expect(result.identityResolution).toBeUndefined();
      // The resolved paths still come from the persisted root, not from a fresh lookup.
      expect(result.outputRoot).toBe(wsPath('acme', 'original'));
    });
  });
});

describe('resolveScopeArtifactsDir', () => {
  // join()-built: getScopeArtifactsPath composes with join(), so a template
  // literal expectation is forward-slashed and never matches on win32.
  const ROOT = join('/tmp', 'artifacts-root');
  const scopeDir = (wf: string, scope: string): string => join(ROOT, 'scopes', wf, scope);

  it('returns the scope dir for a workflow with a persist_session node', () => {
    const workflow = {
      name: 'feature-dev',
      nodes: [
        {
          id: 'planner',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'plan' },
          persist_session: true,
        },
      ] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, 'conv-1', ROOT)).toBe(
      scopeDir('feature-dev', 'conv-1')
    );
  });

  it('returns the scope dir for workflow-level persist_sessions', () => {
    const workflow = {
      name: 'feature-dev',
      persist_sessions: true,
      nodes: [
        { id: 'planner', kind: 'agent', source: { kind: 'inline', prompt: 'plan' } },
      ] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, 'conv-1', ROOT)).toBe(
      scopeDir('feature-dev', 'conv-1')
    );
  });

  it('returns undefined when the workflow uses no session persistence (opt-in)', () => {
    const workflow = {
      name: 'plain',
      nodes: [
        { id: 'a', kind: 'agent', source: { kind: 'inline', prompt: 'x' } },
      ] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, 'conv-1', ROOT)).toBeUndefined();
  });

  it('returns undefined without a conversation scope (same guard as persistScopeKey)', () => {
    const workflow = {
      name: 'feature-dev',
      persist_sessions: true,
      nodes: [] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, null, ROOT)).toBeUndefined();
    expect(resolveScopeArtifactsDir(workflow, undefined, ROOT)).toBeUndefined();
  });
});

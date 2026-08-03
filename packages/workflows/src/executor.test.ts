/**
 * Tests for executeWorkflow() — the top-level orchestration function.
 * Covers concurrent-run guards, model/provider resolution, and resume logic
 * that the inner dag-executor.test.ts cannot reach.
 */
import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import { join } from 'path';

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
const mockCaptureWorkflowInvoked = mock(() => {});
const mockCaptureWorkflowCompleted = mock(() => {});
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
const mockExecuteDagWorkflow = mock(async (): Promise<string | undefined> => undefined);
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
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// --- Import after mocks ---
import {
  executeWorkflow,
  hydrateResumableRun,
  resolveProjectPaths,
  resolveScopeArtifactsDir,
} from './executor';
import { keepAwake } from './utils/keep-awake';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowDefinition, WorkflowRun } from './schemas';

// --- Helpers ---

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    findChildRuns: mock(async () => []),
    getRunAncestry: mock(async () => []),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    getWorkflowRunStatus: mock(async () => 'completed' as const),
    createWorkflowEvent: mock(async () => {}),
    findResumableRun: mock(async () => null),
    getDagResumeSnapshot: mock(async () => ({
      completedNodeOutputs: new Map(),
      tokens: { input: 0, output: 0 },
    })),
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
    mockGetDefaultBranch.mockClear();
    mockGetDefaultBranch.mockImplementation(async () => 'main');
    mockExecuteDagWorkflow.mockImplementation(async (): Promise<string | undefined> => undefined);
  });

  // -------------------------------------------------------------------------
  // Container resume guard (Phase C)
  // -------------------------------------------------------------------------

  describe('container resume guard', () => {
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
        { preCreatedRun, priorCompletedNodes: new Map([['node1', 'out']]) }
      );
      expect(result.success).toBe(false);
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
          priorCompletedNodes: new Map([['node1', 'out']]),
          priorTokenUsage: { input: 40, output: 4 },
          execContext: { kind: 'container', containerId: 'cid' },
          container: { envId: 'env-x', writeBack: 'approve', backend },
        }
      );
      // Guard passed → DAG entered (mocked no-op) → run completes.
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
      expect(mockExecuteDagWorkflow.mock.calls[0]?.[24]).toEqual({ input: 40, output: 4 });
      expect(result.success).toBe(true);
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
      // Blocked before the execution window — keep-awake must never have fired.
      expect(keepAwake.activeCount()).toBe(0);
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

  // -------------------------------------------------------------------------
  // Durable workflow_started configuration snapshot
  // -------------------------------------------------------------------------

  describe('workflow_started configuration snapshot', () => {
    it('persists the resolved configuration and top-level platform origin', async () => {
      const createEventSpy = mock(async () => {});
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
        }
      );

      const startedEvent = createEventSpy.mock.calls
        .map(call => call[0])
        .find(event => event.event_type === 'workflow_started');
      expect(startedEvent?.data).toEqual({
        workflowName: 'test-workflow',
        defaultAssistant: 'codex',
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
      const createEventSpy = mock(async () => {});
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
      const createEventSpy = mock(async () => {});
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
      const createEventSpy = mock(async () => {});
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
      const createEventSpy = mock(async () => {});
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
      const createEventSpy = mock(async () => {});
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
      const createEventSpy = mock(async () => {});
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
        ['node-a', 'a-output'],
        ['node-b', 'b-output'],
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
        | Map<string, string>
        | undefined;
      expect(passedPriors).toBe(priorCompletedNodes);
      // No fresh row created when a preCreatedRun is supplied.
      expect(store.createWorkflowRun).not.toHaveBeenCalled();
    });

    it('forwards a hydrated resume snapshot into resumed DAG execution', async () => {
      const candidate = makeRun({ id: 'failed-run', status: 'failed' });
      const resumed = makeRun({ id: 'resumed-run', status: 'running' });
      const completedNodeOutputs = new Map([['node-a', 'first output']]);
      const tokens = { input: 40, output: 4 };
      const store = makeStore({
        getDagResumeSnapshot: mock(async () => ({ completedNodeOutputs, tokens })),
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
      expect(dagCall?.[24]).toEqual(tokens);
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
        makeWorkflow({ nodes: [{ id: 'node1', prompt: 'Do something', persist_session: true }] }),
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
      const getUserProviderEnv = mock(async () => ({ env: { SHOULD_NOT_APPEAR: '1' }, files: [] }));
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
      const getUserProviderEnv = mock(async () => ({ env: { SHOULD_NOT_APPEAR: '1' }, files: [] }));
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
        getCodebaseEnvVars: mock(async () => ({ DB_KEY: 'db_val', SHARED_KEY: 'db' })),
      });
      const getUserProviderEnv = mock(async () => ({
        env: { SHARED_KEY: 'user_wins', USER_KEY: 'u_val' },
        files: [] as { path: string; contents: string }[],
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
        DB_KEY: 'db_val',
        SHARED_KEY: 'user_wins',
        USER_KEY: 'u_val',
      });
    });

    it('returns {} and does not throw when getUserProviderEnv rejects', async () => {
      const deps: WorkflowDeps = {
        ...makeDeps(makeStore()),
        isPerUserProviderKeysEnabled: () => true,
        getUserProviderEnv: mock(async () => {
          throw new Error('network down');
        }),
      };
      await expect(
        executeWorkflow(deps, makePlatform(), 'conv-1', '/tmp', makeWorkflow(), 'msg', 'db-c1', {
          userId: 'u-1',
        })
      ).resolves.toBeDefined();
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
  });

  it('reports feature-adoption booleans on workflow_invoked', async () => {
    mockCaptureWorkflowInvoked.mockClear();
    const store = makeStore();
    const deps = makeDeps(store);
    const workflow = makeWorkflow({
      persist_sessions: true,
      nodes: [
        { id: 'gen', prompt: 'Generate.', output_format: { type: 'object' }, mcp: 'mcp.json' },
        {
          id: 'iterate',
          depends_on: ['gen'],
          loop: { prompt: 'Iterate.', until: 'DONE', fresh_context: true },
        },
        { id: 'summarize', depends_on: ['iterate'], prompt: 'Summarize.', output_type: 'report' },
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
  it('returns hydrated run + prior outputs for a candidate with completed nodes', async () => {
    const candidate = makeRun({ id: 'prior-failed', status: 'failed' });
    const resumed = makeRun({ id: 'prior-failed', status: 'running' });
    const priorNodes = new Map([['n1', 'out1']]);
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: priorNodes,
        tokens: { input: 40, output: 4 },
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.preCreatedRun).toBe(resumed);
    expect(result?.priorCompletedNodes).toBe(priorNodes);
    expect(result?.priorTokenUsage).toEqual({ input: 40, output: 4 });
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('prior-failed');
  });

  it('returns null when candidate has no completed nodes and no interactive-loop state', async () => {
    const candidate = makeRun({ id: 'empty-prior', status: 'failed' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        tokens: { input: 0, output: 0 },
      })),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).toBeNull();
    // Must not transition the run — there is nothing to resume.
    expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
  });

  it('returns hydrated run when interactive-loop state is present even with zero completed nodes', async () => {
    const candidate = makeRun({
      id: 'paused-loop',
      status: 'paused',
      metadata: { approval: { type: 'interactive_loop', nodeId: 'loop-1', iteration: 2 } },
    });
    const resumed = makeRun({ id: 'paused-loop', status: 'running' });
    const store = makeStore({
      getDagResumeSnapshot: mock(async () => ({
        completedNodeOutputs: new Map(),
        tokens: { input: 0, output: 0 },
      })),
      resumeWorkflowRun: mock(async () => resumed),
    });
    const deps = makeDeps(store);
    const result = await hydrateResumableRun(deps, candidate);
    expect(result).not.toBeNull();
    expect(result?.priorCompletedNodes.size).toBe(0);
    expect(store.resumeWorkflowRun).toHaveBeenCalledWith('paused-loop');
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
        completedNodeOutputs: new Map([['n1', 'v1']]),
        tokens: { input: 0, output: 0 },
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
        { id: 'planner', prompt: 'plan', persist_session: true },
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
      nodes: [{ id: 'planner', prompt: 'plan' }] as WorkflowDefinition['nodes'],
    };
    expect(resolveScopeArtifactsDir(workflow, 'conv-1', ROOT)).toBe(
      scopeDir('feature-dev', 'conv-1')
    );
  });

  it('returns undefined when the workflow uses no session persistence (opt-in)', () => {
    const workflow = {
      name: 'plain',
      nodes: [{ id: 'a', prompt: 'x' }] as WorkflowDefinition['nodes'],
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

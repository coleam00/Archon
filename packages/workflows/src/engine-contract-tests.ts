/**
 * Shared contract-test suite for `IWorkflowEngine` implementations (issue
 * #3334, M1). Authored from scratch — there is no prior `IWorkflowStore` /
 * `IWorkflowPlatform` contract-test suite to extend.
 *
 * Runs the REAL `executeWorkflow` / `hydrateResumableRun` call path (via
 * whichever engine `makeEngine()` builds) against fixture `IWorkflowStore` /
 * `WorkflowDeps` objects — same fixture-building convention as
 * `executor.test.ts` (`makeStore`/`makeDeps`/`makeRun`/`makeWorkflow`
 * overriding a fully-mocked baseline). It intentionally does NOT mock
 * `executeWorkflow` itself: see `workflow-resume-service.test.ts` /
 * `orchestrator-agent.test.ts` for the `mock.module('@archon/workflows/executor', ...)`
 * anti-pattern this port removes.
 *
 * A caller must mock `@archon/paths`, `@archon/git`, `./dag-executor`,
 * `./event-emitter` and `./logger` (via `bun:test`'s `mock.module`) BEFORE
 * importing this file or `./executor`/`./in-process-engine` — see
 * `in-process-engine.test.ts` for the required setup, mirroring
 * `executor.test.ts`'s own "Mock ... / Import after mocks" ordering.
 */
import { describe, it, expect } from 'bun:test';
import { resolveWorkflow } from './graph-plan';
import type { IWorkflowEngine } from './engine-port';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore, DagResumeSnapshot } from './store';
import type { ResolvedWorkflow, WorkflowDefinition, WorkflowRun } from './schemas';

/**
 * Local stand-in for `@archon/core`'s `WorkflowNotResumableError` (thrown by
 * the real `resumeWorkflowRun` DB implementation on a lost CAS race).
 * `@archon/workflows` has no dependency on `@archon/core`, and
 * `hydrateResumableRun`/`executeWorkflow` never catch or rewrap whatever
 * `deps.store.resumeWorkflowRun` throws — they let it propagate — so a
 * fixture store throwing this class exercises the exact same unwrapped-throw
 * path a real lost race takes in production.
 */
export class WorkflowNotResumableError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentStatus: string
  ) {
    super(`Workflow run is not resumable (id: ${runId}, status: ${currentStatus}).`);
    this.name = 'WorkflowNotResumableError';
  }
}

function emptyDagResumeSnapshot(): DagResumeSnapshot {
  return {
    completedNodeOutputs: new Map(),
    fanOutSnapshots: new Map(),
    unresolvedNodeStarts: new Set<string>(),
    tokens: { input: 0, output: 0 },
    costUsd: 0,
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

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): ResolvedWorkflow {
  return resolveWorkflow({
    name: 'test-workflow',
    description: 'Test',
    nodes: [{ id: 'node1', kind: 'agent', source: { kind: 'inline', prompt: 'Do something' } }],
    ...overrides,
  });
}

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  const noop = async (): Promise<void> => undefined;
  return {
    getActiveWorkflowRunByPath: async () => null,
    findChildRuns: async () => [],
    getRunAncestry: async () => [],
    createWorkflowRun: async () => makeRun(),
    updateWorkflowRun: noop,
    failWorkflowRun: noop,
    getWorkflowRun: async () => ({ ...makeRun(), status: 'completed' as const }),
    getWorkflowRunStatus: async () => 'completed' as const,
    createWorkflowEvent: noop,
    persistWorkflowEvent: noop,
    persistWorkflowEventIfRunning: async () => ({ persisted: true }),
    getMaxEventOrder: async () => 0,
    getGlobalMaxEventOrder: async () => 0,
    listWorkflowEventsAfter: async () => [],
    findResumableRun: async () => null,
    getDagResumeSnapshot: async () => emptyDagResumeSnapshot(),
    resumeWorkflowRun: async () => makeRun(),
    recoverCancelledFanOutRun: async () => makeRun(),
    getCodebase: async () => null,
    getCodebaseEnvVars: async () => ({}),
    updateWorkflowActivity: noop,
    completeWorkflowRun: noop,
    pauseWorkflowRun: noop,
    pauseWorkflowRunForWait: noop,
    failPausedAttentionWait: async () => ({ failed: true }),
    clearWorkflowWaitContext: async (id, _wait, completion) => ({
      cleared: true as const,
      nodeEvent: {
        workflow_run_id: id,
        event_type: 'node_completed' as const,
        step_name: completion.stepName,
      },
    }),
    rewriteApprovalContext: async () => ({ resolved: true }),
    claimWriteback: async () => ({ claimed: true }),
    releaseWritebackClaim: noop,
    cancelWorkflowRun: async () => ({ cancelled: false }),
    cancelFanOutRun: async () => ({ cancelled: false }),
    getWorkflowNodeSession: async () => null,
    listWorkflowRunNodeSessions: async () => [],
    upsertWorkflowRunNodeSession: noop,
    upsertWorkflowNodeSession: noop,
    deleteWorkflowNodeSessions: async () => ({ deleted: 0 }),
    ...overrides,
  } as IWorkflowStore;
}

function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: async (): Promise<void> => undefined,
    getPlatformType: () => 'test' as const,
  } as unknown as IWorkflowPlatform;
}

function makeDeps(store?: IWorkflowStore): WorkflowDeps {
  return {
    store: store ?? makeStore(),
    loadConfig: async (): Promise<WorkflowConfig> => ({
      assistant: 'claude' as const,
      assistants: { claude: {}, codex: {} },
      baseBranch: '',
      commands: { folder: '' },
    }),
    getAgentProvider: () => ({ run: async (): Promise<void> => undefined }),
  } as unknown as WorkflowDeps;
}

/**
 * Runs the `IWorkflowEngine` contract suite against `makeEngine()`'s
 * implementation. Call from a test file that has already set up the
 * required `mock.module` calls (see file-level doc comment above).
 */
export function runWorkflowEngineContractTests(makeEngine: () => IWorkflowEngine): void {
  describe('IWorkflowEngine contract', () => {
    it('submit() of a fresh run succeeds', async () => {
      const engine = makeEngine();
      const store = makeStore(); // default getWorkflowRun status: 'completed'
      const result = await engine.submit({
        deps: makeDeps(store),
        platform: makePlatform(),
        conversationId: 'conv-1',
        cwd: '/tmp/ops',
        workflow: makeWorkflow(),
        userMessage: 'hello',
        conversationDbId: 'db-conv-1',
      });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      expect(result.workflowRunId).toBe('run-123');
      expect('paused' in result).toBe(false);
    });

    it('resume() of a paused run succeeds and is narrowed correctly via `paused in result`', async () => {
      const engine = makeEngine();
      const candidate = makeRun({ id: 'paused-run', status: 'paused' });
      const resumed = makeRun({ id: 'paused-run', status: 'running' });
      const store = makeStore({
        getDagResumeSnapshot: async () => ({
          ...emptyDagResumeSnapshot(),
          completedNodeOutputs: new Map([['node1', { output: 'out1' }]]),
        }),
        resumeWorkflowRun: async () => resumed,
        // The DAG re-pauses again after resuming (e.g. still blocked on the
        // same wait) — this is what exercises the `{success:true, paused:true}`
        // arm of `WorkflowExecutionResult`, which structurally overlaps plain
        // success (both have `success: true` — the type is NOT a clean 3-way
        // discriminated union; see schemas/workflow.ts).
        getWorkflowRun: async () => ({ ...resumed, status: 'paused' as const }),
      });

      const result = await engine.resume({
        deps: makeDeps(store),
        platform: makePlatform(),
        conversationId: 'conv-1',
        cwd: '/tmp/ops',
        workflow: makeWorkflow(),
        userMessage: 'hello',
        conversationDbId: 'db-conv-1',
        run: candidate,
      });

      expect(result.success).toBe(true);
      // Narrowing check: `'paused' in result` must correctly select the paused
      // member without assuming a 3-way tag — do not write `switch` code
      // assuming a `status`/kind discriminant here, only `success` + `'paused' in`.
      if ('paused' in result) {
        expect(result.paused).toBe(true);
        expect(result.workflowRunId).toBe('paused-run');
      } else {
        throw new Error('expected a paused result, got a plain success/failure result');
      }
    });

    it('resume() surfaces a lost CAS race as an unwrapped WorkflowNotResumableError', async () => {
      const engine = makeEngine();
      const candidate = makeRun({ id: 'raced-run', status: 'failed' });
      const store = makeStore({
        getDagResumeSnapshot: async () => ({
          ...emptyDagResumeSnapshot(),
          completedNodeOutputs: new Map([['node1', { output: 'out1' }]]),
        }),
        resumeWorkflowRun: async () => {
          throw new WorkflowNotResumableError('raced-run', 'running');
        },
      });

      let caught: unknown;
      try {
        await engine.resume({
          deps: makeDeps(store),
          platform: makePlatform(),
          conversationId: 'conv-1',
          cwd: '/tmp/ops',
          workflow: makeWorkflow(),
          userMessage: 'hello',
          conversationDbId: 'db-conv-1',
          run: candidate,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(WorkflowNotResumableError);
    });
  });
}

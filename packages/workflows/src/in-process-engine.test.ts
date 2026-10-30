// @archon-test-isolated
import { WorkflowExecutionHandoffError } from './engine-port';
/**
 * Wires the shared `IWorkflowEngine` contract-test suite
 * (`engine-contract-tests.ts`) against `InProcessWorkflowEngine`
 * (issue #3334).
 *
 * Mock setup mirrors `executor/test-utils.ts`, the scaffolding of the
 * `executor.*.test.ts` files — `InProcessWorkflowEngine` delegates straight through to the
 * real `executeWorkflow`/`hydrateResumableRun`, so the same fs/git/dag-executor
 * seams need stubbing here too. This file deliberately does NOT mock
 * `./executor` or `@archon/workflows/executor` itself.
 */
import { providerRegistry } from '@archon/providers';
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { getRunArtifactsDirForRoot, getRunScratchDir } from '@archon/paths/archon-paths';

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
  resolveRepoProjectIdentity: mock(() => null),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
  getProjectArtifactsPath: mock(() => '/tmp/artifacts-root'),
  resolveProjectStorageKey: mock(() => ({ kind: 'cwd', cwd: '/tmp/ops' })),
  getProjectStoragePaths: mock(() => ({
    root: '/tmp/ws',
    artifactsRoot: '/tmp/ws/artifacts',
    logsDir: '/tmp/ws/logs',
    stateRoot: '/tmp/ws/state',
    workflowSourceRoot: '/tmp/ws/workflow-source',
  })),
  getStoragePathsForRoot: mock((root: string) => ({
    root,
    artifactsRoot: `${root}/artifacts`,
    logsDir: `${root}/logs`,
    stateRoot: `${root}/state`,
    workflowSourceRoot: `${root}/workflow-source`,
  })),
  isInsideArchonHome: mock(() => true),
  slugifyFolderName: mock((name: string) => name),
  getFolderRunArtifactsPath: mock(
    (slug: string, runId: string) => `/tmp/_folder/${slug}/artifacts/runs/${runId}`
  ),
  getFolderProjectLogsPath: mock((slug: string) => `/tmp/_folder/${slug}/logs`),
  getFolderProjectArtifactsPath: mock((slug: string) => `/tmp/_folder/${slug}/artifacts`),
  getScopeArtifactsPath: mock(
    (root: string, wf: string, scope: string) => `${root}/scopes/${wf}/${scope}`
  ),
  captureWorkflowInvoked: mock(() => {}),
}));

mock.module('@archon/git', () => ({
  getDefaultBranch: mock(async () => 'main'),
  getDefaultRemote: mock(async () => 'origin'),
  toRepoPath: mock((p: string) => p),
}));

// --- Mock dag-executor: the DAG loop itself is out of scope for this suite
// (dag-executor.test.ts / child-runs.*.test.ts own that); this suite only proves
// the InProcessWorkflowEngine -> executeWorkflow/hydrateResumableRun wiring. ---
type ExecuteDagWorkflow = typeof import('./dag-executor').executeDagWorkflow;
let executedWorkflow: Parameters<ExecuteDagWorkflow>[0]['workflow'] | undefined;
/** Stands in for the DAG body in the subscription cases, which need it to write rows. */
let dagBody: ExecuteDagWorkflow | undefined;
const mockExecuteDagWorkflow = mock<ExecuteDagWorkflow>(async input => {
  executedWorkflow = input.workflow;
  return dagBody?.(input);
});
mock.module('./dag-executor', () => ({
  executeDagWorkflow: mockExecuteDagWorkflow,
}));

mock.module('./logger', () => ({
  logWorkflowStart: mock(async () => {}),
  logWorkflowResume: mock(async () => {}),
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

// --- Bootstrap provider registry (after path mocks), same as executor/test-utils.ts ---
import { clearRegistry } from '@archon/providers';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

// --- Import after mocks ---
import { InProcessWorkflowEngine } from './in-process-engine';
import { runWorkflowEngineContractTests } from './engine-contract-tests';
import { executeWorkflow } from './executor';
import { createFileWorkflowStore } from './file-store';
import { resolveWorkflow } from './graph-plan';
import type { IWorkflowPlatform, WorkflowDeps } from './deps';
import type { WorkflowRunDelivery } from './engine-port';
import { executionClaim, type IWorkflowStore } from './store';

runWorkflowEngineContractTests(providerRegistry, deps => new InProcessWorkflowEngine(deps), {
  executedWorkflow: () => executedWorkflow,
});

describe('InProcessWorkflowEngine', () => {
  const roots = trackTempRoots();
  const originalArchonHome = process.env.ARCHON_HOME;
  afterEach(() => {
    dagBody = undefined;
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
  });

  const platform = {
    sendMessage: async (): Promise<void> => undefined,
    getPlatformType: () => 'test' as const,
  } as unknown as IWorkflowPlatform;
  const parent = resolveWorkflow({
    name: 'parent',
    description: 'Parent',
    nodes: [
      { id: 'first', kind: 'agent', source: { kind: 'inline', prompt: 'One' } },
      { id: 'child', kind: 'workflow', workflow: 'child', depends_on: ['first'] },
    ],
  });
  const child = resolveWorkflow({
    name: 'child',
    description: 'Child',
    nodes: [{ id: 'inner', kind: 'agent', source: { kind: 'inline', prompt: 'Two' } }],
  });

  async function makeEngine(): Promise<{
    engine: InProcessWorkflowEngine;
    store: IWorkflowStore;
    deps: WorkflowDeps;
  }> {
    const store = await createFileWorkflowStore({
      root: roots(await mkdtemp(join(tmpdir(), 'archon-engine-subscribe-'))),
    });
    const deps = {
      providers: providerRegistry,
      store,
      loadConfig: async () => ({
        assistant: 'claude',
        assistants: { claude: {}, codex: {} },
        baseBranch: '',
        commands: { folder: '' },
      }),
      getAgentProvider: () => ({
        checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
        run: async (): Promise<void> => undefined,
      }),
    } as unknown as WorkflowDeps;
    return { engine: new InProcessWorkflowEngine(deps), store, deps };
  }

  describe.each(['pending', 'claimed'] as const)('%s continuation submission', state => {
    it.each([
      [
        'mode',
        { mode: 'supersede' },
        'ancestor',
        'ancestor',
        'adopt',
        'conflicts with recorded continuation mode',
      ],
      [
        'ancestor',
        { mode: 'adopt' },
        'ancestor',
        'other',
        'adopt',
        'conflicts with recorded continuation ancestor',
      ],
      [
        'malformed stamp',
        { mode: 'unsupported' },
        'ancestor',
        'ancestor',
        'adopt',
        'Invalid recorded continuation metadata.',
      ],
      [
        'legacy mode',
        undefined,
        'ancestor',
        'ancestor',
        'supersede',
        'conflicts with recorded continuation mode',
      ],
      [
        'absent ancestor',
        undefined,
        undefined,
        'ancestor',
        'adopt',
        'conflicts with recorded continuation ancestor',
      ],
    ] as const)(
      'submit refuses a pending row with conflicting %s before inheritance',
      async (_label, stamp, recordedId, callerId, callerMode, message) => {
        const { engine, store } = await makeEngine();
        const pending = await store.createWorkflowRun({
          workflow_name: parent.name,
          user_message: '',
          adopted_from_run_id: recordedId,
          metadata: stamp ? { continuation: stamp } : {},
        });
        if (state === 'claimed') await store.claimPendingWorkflowRun(pending.id, '/other-worker');
        const before = await store.getWorkflowRun(pending.id);
        const read = spyOn(store, 'getWorkflowRun');
        let executed = false;
        dagBody = async () => {
          executed = true;
          return undefined;
        };
        await expect(
          engine.submit({
            platform,
            conversationId: 'conv-1',
            cwd: '/tmp/ops',
            workflow: parent,
            userMessage: '',
            options: {
              preCreatedRun: pending,
              adoptedFromRunId: callerId,
              continuationMode: callerMode,
            },
          })
        ).rejects.toThrow(message);
        expect(read).not.toHaveBeenCalledWith(callerId);
        expect(executed).toBe(false);
        read.mockRestore();
        expect(await store.getWorkflowRun(pending.id)).toEqual(before);
      }
    );
  });

  it.each(['pending', 'claimed'] as const)(
    'configuration refusal preserves an unowned %s row',
    async state => {
      const { engine, store } = await makeEngine();
      const pending = await store.createWorkflowRun({
        workflow_name: parent.name,
        user_message: '',
        metadata: { ai_configuration: { version: 2 } },
      });
      if (state === 'claimed') await store.claimPendingWorkflowRun(pending.id, '/other-worker');
      const before = await store.getWorkflowRun(pending.id);
      const execute = spyOn(store, 'claimPendingWorkflowRun');
      await expect(
        engine.submit({
          platform,
          conversationId: 'conv-1',
          cwd: '/tmp/ops',
          workflow: parent,
          userMessage: '',
          options: { preCreatedRun: pending },
        })
      ).rejects.toThrow('Invalid recorded run AI configuration');
      expect(execute).not.toHaveBeenCalled();
      execute.mockRestore();
      expect(await store.getWorkflowRun(pending.id)).toEqual(before);
    }
  );

  it.each(['initial', 'resumed', 'replaced'] as const)(
    'configuration failure only terminalizes the owned resume claim (%s)',
    async claim => {
      const { store, deps } = await makeEngine();
      const run = await store.createWorkflowRun({
        workflow_name: parent.name,
        user_message: '',
        metadata: { ai_configuration: { version: 2 } },
      });
      let owned = await store.claimPendingWorkflowRun(run.id);
      if (!owned) throw new Error('expected initial claim');
      if (claim !== 'initial') {
        await store.failWorkflowRun(run.id, 'interrupted');
        owned = await store.resumeWorkflowRun(run.id);
      }
      if (claim === 'replaced') {
        await store.failWorkflowRun(run.id, 'interrupted');
        await store.resumeWorkflowRun(run.id);
      }
      const before = await store.getWorkflowRun(run.id);
      await expect(
        executeWorkflow(deps, platform, 'conv-1', '/tmp/ops', parent, '', undefined, {
          preCreatedRun: owned,
          priorCompletedNodes: new Map(),
        })
      ).rejects.toThrow('Invalid recorded run AI configuration');
      const after = await store.getWorkflowRun(run.id);
      if (claim === 'replaced') expect(after).toEqual(before);
      else expect(after?.status).toBe('failed');
    }
  );

  const completeNode = (store: IWorkflowStore, runId: string, step: string): Promise<void> =>
    store.persistWorkflowEvent({
      workflow_run_id: runId,
      event_type: 'node_completed',
      step_name: step,
      data: { node_output: step },
    });

  const lifecycle = (deliveries: WorkflowRunDelivery[]): string[] =>
    deliveries
      .filter(({ event }) => event.event_type.startsWith('workflow_') || event.step_name)
      .map(({ event }) => `${event.workflow_run_id}:${event.event_type}:${event.step_name ?? ''}`);

  it.each(['read', 'post-publication', 'pre-publication'] as const)(
    'preserves ownership across a %s rejection on resume',
    async kind => {
      const { engine, store } = await makeEngine();
      const run = await store.createWorkflowRun({ workflow_name: parent.name, user_message: '' });
      await completeNode(store, run.id, 'first');
      await store.failWorkflowRun(run.id, 'interrupted');
      const failed = await store.getWorkflowRun(run.id);
      if (failed?.status !== 'failed') throw new Error('expected failed run');
      const cause = new Error('required operation failed');
      let read: ReturnType<typeof spyOn> | undefined;
      dagBody = async ({ workflowRun }) => {
        if (kind === 'pre-publication') throw cause;
        const context = {
          type: 'approval' as const,
          nodeId: 'review',
          message: '',
          pauseId: 'published',
        };
        await store.pauseWorkflowRun(workflowRun.id, context);
        await store.resumeWorkflowRun(workflowRun.id);
        if (kind === 'read') {
          const get = store.getWorkflowRun.bind(store);
          read = spyOn(store, 'getWorkflowRun')
            .mockImplementation(get)
            .mockImplementationOnce(async () => {
              throw cause;
            });
        }
        if (kind === 'post-publication')
          throw new WorkflowExecutionHandoffError(workflowRun.id, cause);
        return {
          kind: 'container_pause',
          pause: { kind: 'gate', context },
        };
      };
      try {
        const admission = await engine.resume({
          platform,
          conversationId: 'conv-1',
          cwd: '/tmp/ops',
          userMessage: '',
          run: failed,
          legacyWorkflow: parent,
        });
        if (!admission.accepted) throw new Error('expected resume');
        if (kind === 'pre-publication') {
          expect(await admission.settled).toMatchObject({ success: false, error: cause.message });
        } else {
          await expect(admission.settled).rejects.toMatchObject({
            name: 'WorkflowExecutionHandoffError',
            workflowRunId: run.id,
            cause,
          });
        }
        expect(await store.getWorkflowRunStatus(run.id)).toBe(
          kind === 'pre-publication' ? 'failed' : 'running'
        );
      } finally {
        read?.mockRestore();
      }
    }
  );

  it('keeps the execution error when resume cannot mark the run failed', async () => {
    const { engine, store } = await makeEngine();
    const run = await store.createWorkflowRun({ workflow_name: parent.name, user_message: '' });
    await completeNode(store, run.id, 'first');
    await store.failWorkflowRun(run.id, 'interrupted');
    const failed = await store.getWorkflowRun(run.id);
    if (failed?.status !== 'failed') throw new Error('expected failed run');
    const persistError = new Error('SQLITE_BUSY');
    const failRun = spyOn(store, 'failWorkflowRun').mockRejectedValue(persistError);
    try {
      const admission = await engine.resume({
        platform,
        conversationId: 'conv-1',
        cwd: '/tmp/ops',
        userMessage: '',
        run: failed,
        // The executor refuses a run budget over a `workflow:` node before its own
        // terminal-write boundary, so only the engine's catch can record the failure.
        legacyWorkflow: resolveWorkflow({
          name: parent.name,
          description: 'Budgeted parent',
          budget: { max_work_units: 5 },
          nodes: [{ id: 'child', kind: 'workflow', workflow: 'child' }],
        }),
      });
      if (!admission.accepted) throw new Error('expected resume');
      await expect(admission.settled).rejects.toMatchObject({
        name: 'TerminalStatusWriteError',
        cause: persistError,
        failure: expect.objectContaining({ message: expect.stringContaining("node 'child'") }),
      });
      expect(await store.getWorkflowRunStatus(run.id)).toBe('running');
    } finally {
      failRun.mockRestore();
    }
  });

  it('resume settles before the host drains scratch cleanup', async () => {
    const { engine, store } = await makeEngine();
    const home = roots(await mkdtemp(join(tmpdir(), 'archon-engine-resume-scratch-')));
    process.env.ARCHON_HOME = home;
    const root = join(home, 'project');
    const run = await store.createWorkflowRun({
      workflow_name: parent.name,
      user_message: '',
    });
    await store.updateWorkflowRun(run.id, { output_root: root });
    await completeNode(store, run.id, 'first');
    await store.failWorkflowRun(run.id, 'interrupted');
    const failed = await store.getWorkflowRun(run.id);
    if (failed?.status !== 'failed') throw new Error('expected a failed run');
    const scratch = getRunScratchDir(getRunArtifactsDirForRoot(root, run.id));
    await mkdir(scratch, { recursive: true });
    dagBody = async ({ deps, workflowRun }) => {
      await completeNode(deps.store, workflowRun.id, 'child');
      await deps.store.completeWorkflowRun(workflowRun.id, { duration_ms: 1 });
      return undefined;
    };
    const cleanups: (() => Promise<void>)[] = [];

    const admission = await engine.resume({
      platform,
      conversationId: 'conv-1',
      cwd: root,
      userMessage: '',
      run: failed,
      legacyWorkflow: parent,
      options: { deferScratchCleanup: cleanup => cleanups.push(cleanup) },
    });
    if (!admission.accepted) throw new Error('expected resume');
    const result = await admission.settled;

    expect(result).toMatchObject({ success: true, workflowRunId: run.id });
    expect(await store.getWorkflowRunStatus(run.id)).toBe('completed');
    expect(cleanups).toHaveLength(1);
    expect(existsSync(scratch)).toBe(true);
    await Promise.all(cleanups.map(cleanup => cleanup()));
    expect(existsSync(scratch)).toBe(false);
  });

  it('delivers the run and its workflow child in commit order', async () => {
    const { engine, store } = await makeEngine();
    let childRunId = '';
    dagBody = async ({ deps, workflow, workflowRun }) => {
      if (workflow.name === 'parent') {
        await completeNode(deps.store, workflowRun.id, 'first');
        const childRun = await deps.store.createWorkflowRun({
          workflow_name: 'child',
          user_message: '',
          parent_run_id: workflowRun.id,
        });
        childRunId = childRun.id;
        await executeWorkflow(deps, platform, 'conv-1', '/tmp/ops', child, '', undefined, {
          preCreatedRun: childRun,
        });
        await completeNode(deps.store, workflowRun.id, 'child');
      } else {
        await completeNode(deps.store, workflowRun.id, 'inner');
      }
      await deps.store.completeWorkflowRun(workflowRun.id, { duration_ms: 1 });
      return undefined;
    };
    const unrelated = await store.createWorkflowRun({ workflow_name: 'other', user_message: '' });
    const runId = '00000000-0000-4000-8000-000000000001';
    const pending = await store.createWorkflowRun({
      id: runId,
      workflow_name: 'parent',
      user_message: '',
    });
    const deliveries: WorkflowRunDelivery[] = [];
    const subscription = await engine.subscribe(runId, delivery => deliveries.push(delivery));

    const result = await engine.submit({
      platform,
      conversationId: 'conv-1',
      cwd: '/tmp/ops',
      workflow: parent,
      userMessage: '',
      options: { preCreatedRun: pending },
    });
    await store.persistWorkflowEvent({
      workflow_run_id: unrelated.id,
      event_type: 'workflow_started',
    });
    await subscription.close();

    expect(result).toMatchObject({ success: true, workflowRunId: runId });
    expect(lifecycle(deliveries)).toEqual([
      `${runId}:workflow_started:`,
      `${runId}:node_completed:first`,
      `${childRunId}:workflow_started:`,
      `${childRunId}:node_completed:inner`,
      `${childRunId}:workflow_completed:`,
      `${runId}:node_completed:child`,
      `${runId}:workflow_completed:`,
    ]);
    expect(deliveries.some(({ event }) => event.workflow_run_id === unrelated.id)).toBe(false);
  });

  it('a subscription opened before resume sees only the new segment', async () => {
    const { engine, store } = await makeEngine();
    const claims: (string | null)[] = [];
    const onExecutionClaimed = (claim: string | null): void => {
      claims.push(claim);
    };
    dagBody = async ({ deps, workflowRun, priorCompletedNodes }) => {
      expect(claims).toHaveLength(priorCompletedNodes?.has('first') ? 2 : 1);
      expect(claims.at(-1)).toBe(executionClaim(workflowRun.metadata));
      if (priorCompletedNodes?.has('first')) {
        await completeNode(deps.store, workflowRun.id, 'child');
        await deps.store.completeWorkflowRun(workflowRun.id, { duration_ms: 1 });
      } else {
        await completeNode(deps.store, workflowRun.id, 'first');
        await deps.store.failWorkflowRun(workflowRun.id, 'interrupted');
      }
      return undefined;
    };
    const first = await engine.submit({
      platform,
      conversationId: 'conv-1',
      cwd: '/tmp/ops',
      workflow: parent,
      userMessage: '',
      options: { onExecutionClaimed },
    });
    const failed = await store.getWorkflowRun(first.workflowRunId ?? '');
    if (failed?.status !== 'failed') throw new Error('expected a failed first segment');
    const deliveries: WorkflowRunDelivery[] = [];
    const subscription = await engine.subscribe(failed.id, delivery => deliveries.push(delivery));

    const admission = await engine.resume({
      platform,
      conversationId: 'conv-1',
      cwd: '/tmp/ops',
      userMessage: '',
      run: failed,
      legacyWorkflow: parent,
      options: { onExecutionClaimed },
    });
    if (!admission.accepted) throw new Error('expected resume');
    await admission.settled;
    expect(claims[0]).toBeNull();
    expect(typeof claims[1]).toBe('string');
    await subscription.close();

    expect(lifecycle(deliveries)).toEqual([
      `${failed.id}:workflow_resumed:`,
      `${failed.id}:workflow_started:`,
      `${failed.id}:node_completed:child`,
      `${failed.id}:workflow_completed:`,
    ]);
  });
});

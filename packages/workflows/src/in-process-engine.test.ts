/**
 * Wires the shared `IWorkflowEngine` contract-test suite
 * (`engine-contract-tests.ts`) against `InProcessWorkflowEngine`
 * (issue #3334).
 *
 * Mock setup mirrors `executor.test.ts`'s "Mock ... / Import after mocks"
 * convention — `InProcessWorkflowEngine` delegates straight through to the
 * real `executeWorkflow`/`hydrateResumableRun`, so the same fs/git/dag-executor
 * seams need stubbing here too. This file deliberately does NOT mock
 * `./executor` or `@archon/workflows/executor` itself.
 */
import { providerRegistry } from '@archon/providers';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

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
// (dag-executor.test.ts / subrun.test.ts own that); this suite only proves
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
  childOutcomeFromRun: mock((run: { id: string; status: string }) => ({
    childRunId: run.id,
    status: run.status,
  })),
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

// --- Bootstrap provider registry (after path mocks), same as executor.test.ts ---
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
import type { IWorkflowStore } from './store';

runWorkflowEngineContractTests(providerRegistry, deps => new InProcessWorkflowEngine(deps), {
  executedWorkflow: () => executedWorkflow,
});

describe('InProcessWorkflowEngine.subscribe', () => {
  const roots = trackTempRoots();
  afterEach(() => {
    dagBody = undefined;
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

  async function makeEngine(): Promise<{ engine: InProcessWorkflowEngine; store: IWorkflowStore }> {
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
    return { engine: new InProcessWorkflowEngine(deps), store };
  }

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
      await deps.store.completeWorkflowRun(workflowRun.id);
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
    dagBody = async ({ deps, workflowRun, priorCompletedNodes }) => {
      if (priorCompletedNodes?.has('first')) {
        await completeNode(deps.store, workflowRun.id, 'child');
        await deps.store.completeWorkflowRun(workflowRun.id);
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
    });
    if (!admission.accepted) throw new Error('expected resume');
    await admission.settled;
    await subscription.close();

    expect(lifecycle(deliveries)).toEqual([
      `${failed.id}:workflow_resumed:`,
      `${failed.id}:workflow_started:`,
      `${failed.id}:node_completed:child`,
      `${failed.id}:workflow_completed:`,
    ]);
  });
});

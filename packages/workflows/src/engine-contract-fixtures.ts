import type { ProviderRegistry } from '@archon/provider-contract';

import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveWorkflow } from './graph-plan';
import { captureWorkflowSource } from './workflow-source';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { WorkflowEngineSubmitInput, WorkflowResumeInput } from './engine-port';
import type { DagResumeSnapshot, IWorkflowStore } from './store';
import type { ResolvedWorkflow, WorkflowDefinition, WorkflowRun } from './schemas';

export async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

export function emptySnapshot(): DagResumeSnapshot {
  return {
    completedNodeOutputs: new Map(),
    fanOutSnapshots: new Map(),
    failedNodes: new Map(),
    unresolvedNodeStarts: new Set<string>(),
    budget: { workUnits: 0, spendUsd: 0 },
    tokens: { input: 0, output: 0 },
    costUsd: 0,
  };
}

export function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: { conversationId: 'conv-1' },
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
    checkout_baseline: null,
    adopted_from_run_id: null,
    ...overrides,
  };
}

export function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): ResolvedWorkflow {
  return resolveWorkflow({
    name: 'test-workflow',
    description: 'Test',
    nodes: [{ id: 'node1', kind: 'agent', source: { kind: 'inline', prompt: 'Do something' } }],
    ...overrides,
  });
}

export function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  const noop = async (): Promise<void> => undefined;
  return {
    getWorkflowEventHead: async () => {
      throw new Error('Unexpected event feed read');
    },
    readWorkflowEventsAfter: async () => {
      throw new Error('Unexpected event feed read');
    },
    getStateDocument: async () => null,
    listStateRevisions: async () => [],
    listStateDocuments: async () => [],
    getStateDocuments: async () => [],
    putStateDocument: async () => {
      throw new Error('Unsupported state documents');
    },
    patchStateDocument: async () => {
      throw new Error('Unsupported state documents');
    },
    deleteStateDocument: async () => {
      throw new Error('Unsupported state documents');
    },
    pruneStateRevisions: async () => ({ count: 0 }),
    getActiveWorkflowRunByPath: async () => null,
    findChildRuns: async () => [],
    getRunAncestry: async () => [],
    createWorkflowRun: async () => makeRun(),
    claimPendingWorkflowRun: async () => makeRun(),
    recordWorkflowRunCheckoutBaseline: async (_id, baseline) => baseline,
    updateWorkflowRun: noop,
    failWorkflowRun: async () => ({ failed: true }),
    getWorkflowRun: async () => ({ ...makeRun(), status: 'completed' as const }),
    getWorkflowRunStatus: async () => 'completed' as const,
    createWorkflowEvent: noop,
    persistWorkflowEvent: noop,
    persistWorkflowEventIfRunning: async () => ({ persisted: true }),
    findResumableRun: async () => null,
    listProviderEvents: async () => [],
    getDagResumeSnapshot: async () => emptySnapshot(),
    resumeWorkflowRun: async () => makeRun(),
    recoverCancelledFanOutRun: async () => makeRun(),
    getCodebase: async () => null,
    getCodebaseEnvVars: async () => ({}),
    updateWorkflowActivity: noop,
    completeWorkflowRun: noop,
    pauseWorkflowRun: noop,
    pauseWorkflowRunForWait: noop,
    clearWorkflowWaitContext: async (id, _wait, completion) => ({
      cleared: true as const,
      nodeEvent: {
        workflow_run_id: id,
        event_type: 'node_completed' as const,
        step_name: completion.stepName,
      },
    }),
    claimWriteback: async () => ({ claimed: true }),
    releaseWritebackClaim: noop,
    cancelWorkflowRun: async () => ({ cancelled: false }),
    cancelFanOutRun: async () => ({ cancelled: false }),
    listWorkflowNodeSessions: async () => [],
    listWorkflowRunNodeSessions: async () => [],
    upsertWorkflowRunNodeSession: noop,
    upsertWorkflowNodeSession: noop,
    ...overrides,
  } as IWorkflowStore;
}

export function makePlatform(onSendMessage?: (id: string) => void): IWorkflowPlatform {
  return {
    sendMessage: async (id: string): Promise<void> => onSendMessage?.(id),
    getPlatformType: () => 'test' as const,
  } as unknown as IWorkflowPlatform;
}

export function defaultConfig(): WorkflowConfig {
  return {
    assistant: 'claude',
    assistants: { claude: {}, codex: {} },
    baseBranch: '',
    commands: { folder: '' },
  };
}

export function makeDeps(
  providers: ProviderRegistry,
  store: IWorkflowStore = makeStore(),
  overrides: Partial<WorkflowDeps> = {}
): WorkflowDeps {
  return {
    providers,
    store,
    loadConfig: async () => defaultConfig(),
    getAgentProvider: () => ({
      checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
      run: async (): Promise<void> => undefined,
    }),
    ...overrides,
  } as WorkflowDeps;
}

export function callInput(): Omit<WorkflowEngineSubmitInput, 'options'> {
  return {
    platform: makePlatform(),
    conversationId: 'conv-1',
    cwd: '/tmp/ops',
    workflow: makeWorkflow(),
    userMessage: 'hello',
    origin: { conversationId: 'db-conv-1' },
  };
}

export function resumeCallInput(): Omit<WorkflowResumeInput, 'run' | 'cursor' | 'options'> {
  const { workflow, ...input } = callInput();
  return { ...input, legacyWorkflow: workflow };
}

export function resumableStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return makeStore({
    getDagResumeSnapshot: async () => ({
      ...emptySnapshot(),
      completedNodeOutputs: new Map([['node1', { output: 'out1' }]]),
    }),
    ...overrides,
  });
}

export async function capturedRun(
  trackTempRoot: (root: string) => string,
  workflowYaml: string,
  overrides: Partial<WorkflowRun> = {}
): Promise<WorkflowRun> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-engine-capture-')));
  const source = join(root, 'source');
  await mkdir(join(source, '.archon', 'workflows'), { recursive: true });
  await writeFile(join(source, '.archon', 'workflows', 'test.yaml'), workflowYaml);
  const capture = await captureWorkflowSource({
    sourceRoot: source,
    captureRoot: join(root, 'capture'),
  });
  return makeRun({
    status: 'paused',
    metadata: {
      workflow_source: {
        version: 1,
        root: capture.anchor.root,
        origin: capture.origin,
        captured_at: capture.manifest.captured_at,
        digest: capture.manifest.digest,
        source_config: capture.manifest.source_config,
        file_count: capture.manifest.file_count,
        byte_count: capture.manifest.byte_count,
      },
    },
    ...overrides,
  });
}

/**
 * Shared scaffolding for the `executor.*.test.ts` files beside executor.ts, which drive
 * executeWorkflow() — the top-level orchestration the inner dag-executor tests cannot reach.
 *
 * Importing this module replaces `@archon/paths`, `@archon/git`, `./dag-executor`, `./logger`
 * and `./event-emitter` with test doubles and registers the built-in providers, so an
 * importing test file must start with `// @archon-test-isolated` (mock.module is
 * process-global and irreversible). Call `resetExecutorMocks` in each file's `beforeEach`.
 */
import { mock, type Mock } from 'bun:test';
import { join, relative } from 'path';
import * as realStorage from '@archon/paths/archon-paths';
import { clearRegistry, providerRegistry } from '@archon/providers';
import { registerBuiltinProviders, registerCommunityProviders } from '@archon/providers/in-process';
import type { WorkflowEmitterEvent } from '../event-emitter';
import type { IWorkflowPlatform, WorkflowConfig, WorkflowDeps } from '../deps';
import { executeWorkflow, type ExecuteWorkflowOptions } from '../executor';
import { resolveWorkflow } from '../graph-plan';
import type { ResolvedWorkflow, WorkflowDefinition, WorkflowRun } from '../schemas';
import type { CheckoutObservation } from '../schemas/checkout-observation';
import type { IWorkflowStore, ObservabilityEventInput, PersistedNodeOutput } from '../store';
import { substituteWorkflowVariables } from '../workflow-variables';

// --- Mock logger ---
export const mockLogFn = mock(() => undefined);
export const mockLogger = {
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

/** The data of every `event` the executor logged under the shared mock logger. */
export function logged(event: string): unknown[] {
  return (mockLogFn.mock.calls as unknown[][])
    .filter(call => call[1] === event)
    .map(call => call[0]);
}

// Telemetry is fire-and-forget; hoisted so tests can assert what the executor reports.
export const mockCaptureWorkflowInvoked = mock<
  typeof import('@archon/paths').captureWorkflowInvoked
>(_props => undefined);
export const mockCaptureWorkflowTerminal = mock<
  typeof import('@archon/paths').captureWorkflowTerminal
>(_props => undefined);

const realGetProjectStoragePaths = realStorage.getProjectStoragePaths;
const realGetStoragePathsForRoot = realStorage.getStoragePathsForRoot;
const realGetArchonWorkspacesPath = realStorage.getArchonWorkspacesPath;
/** Root of the fake workspace tree, this suite's ARCHON_HOME; joined so win32 separators match. */
export const WS = join('/tmp', 'ws');

function fakeGetProjectStoragePaths(
  key: realStorage.ProjectStorageKey
): ReturnType<typeof realGetStoragePathsForRoot> {
  const root = join(
    WS,
    relative(realGetArchonWorkspacesPath(), realGetProjectStoragePaths(key).root)
  );
  return realGetStoragePathsForRoot(root);
}
/** A path under the storage root of an unregistered `cwd`. */
export function cwdPath(cwd: string, ...segments: string[]): string {
  return join(fakeGetProjectStoragePaths({ kind: 'cwd', cwd }).root, ...segments);
}

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: mock(realStorage.parseOwnerRepo),
  resolveRepoProjectIdentity: mock(realStorage.resolveRepoProjectIdentity),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
  getProjectArtifactsPath: mock(() => '/tmp/artifacts-root'),
  resolveProjectStorageKey: mock(realStorage.resolveProjectStorageKey),
  getProjectStoragePaths: mock(fakeGetProjectStoragePaths),
  getStoragePathsForRoot: mock(realGetStoragePathsForRoot),
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
  captureWorkflowTerminal: mockCaptureWorkflowTerminal,
}));

export const mockGetDefaultBranch = mock(async () => 'main');
mock.module('@archon/git', () => ({
  getDefaultBranch: mockGetDefaultBranch,
  getDefaultRemote: mock(async () => 'origin'),
  toRepoPath: mock((p: string) => p),
  // The checkout baseline of a container run probes the container through here. Tests use
  // container ids that do not exist, so answer the way a real `docker exec` would.
  execFileAsync: mock(async () => {
    throw new Error('Error response from daemon: No such container');
  }),
}));

type ExecuteDagWorkflow = typeof import('../dag-executor').executeDagWorkflow;
export const mockExecuteDagWorkflow = mock<ExecuteDagWorkflow>(async () => undefined);
mock.module('../dag-executor', () => ({ executeDagWorkflow: mockExecuteDagWorkflow }));

/** The options of the `index`th DAG execution. */
export function dagCall(index = 0): Parameters<ExecuteDagWorkflow>[0] | undefined {
  return mockExecuteDagWorkflow.mock.calls[index]?.[0];
}

mock.module('../logger', () => ({
  logWorkflowStart: mock(async () => undefined),
  logWorkflowResume: mock(async () => undefined),
  logWorkflowError: mock(async () => undefined),
}));

export const mockEmitter = {
  registerRun: mock(() => undefined),
  unregisterRun: mock(() => undefined),
  emit: mock((_event: WorkflowEmitterEvent) => undefined),
};
mock.module('../event-emitter', () => ({ getWorkflowEventEmitter: mock(() => mockEmitter) }));

clearRegistry();
registerBuiltinProviders();
registerCommunityProviders();

export function resetExecutorMocks(): void {
  mockLogFn.mockClear();
  mockEmitter.registerRun.mockClear();
  mockEmitter.unregisterRun.mockClear();
  mockEmitter.emit.mockClear();
  mockCaptureWorkflowInvoked.mockClear();
  mockCaptureWorkflowTerminal.mockClear();
  mockGetDefaultBranch.mockClear();
  mockGetDefaultBranch.mockImplementation(async () => 'main');
  mockExecuteDagWorkflow.mockClear();
  mockExecuteDagWorkflow.mockImplementation(async () => undefined);
}

/** The mock behind a fake's method, typed for reading its calls. */
export function mocked<T extends (...args: never[]) => unknown>(fn: T): Mock<T> {
  return fn as unknown as Mock<T>;
}

const unexpected = (name: string) => () => {
  throw new Error(`Unexpected ${name}`);
};

export function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getWorkflowEventHead: mock(unexpected('event feed read')),
    readWorkflowEventsAfter: mock(unexpected('event feed read')),
    getStateDocument: mock(unexpected('getStateDocument')),
    putStateDocument: mock(unexpected('putStateDocument')),
    patchStateDocument: mock(unexpected('patchStateDocument')),
    deleteStateDocument: mock(unexpected('deleteStateDocument')),
    listStateRevisions: mock(unexpected('listStateRevisions')),
    listStateDocuments: mock(unexpected('listStateDocuments')),
    getStateDocuments: mock(unexpected('getStateDocuments')),
    pruneStateRevisions: mock(unexpected('pruneStateRevisions')),
    admitResourceStart: mock(unexpected('admitResourceStart')),
    drainResourceStarts: mock(unexpected('drainResourceStarts')),
    hasStartReceiptForDelivery: mock(unexpected('hasStartReceiptForDelivery')),
    acceptStartReceipt: mock(unexpected('acceptStartReceipt')),
    getStartReceipt: mock(unexpected('getStartReceipt')),
    listStartReceipts: mock(unexpected('listStartReceipts')),
    listPendingStartBindings: mock(unexpected('listPendingStartBindings')),
    getResourceStartRequest: mock(unexpected('getResourceStartRequest')),
    listQueuedResourceStartsForHost: mock(unexpected('listQueuedResourceStartsForHost')),
    withdrawQueuedResourceStart: mock(unexpected('withdrawQueuedResourceStart')),
    claimStartBindingPreparation: mock(unexpected('claimStartBindingPreparation')),
    completeStartBindingPreparation: mock(unexpected('completeStartBindingPreparation')),
    failStartBindingPreparation: mock(unexpected('failStartBindingPreparation')),
    resetStartBindingPreparation: mock(unexpected('resetStartBindingPreparation')),
    listDueWorkflowContinuations: mock(unexpected('listDueWorkflowContinuations')),
    deferWorkflowContinuation: mock(unexpected('deferWorkflowContinuation')),
    releaseRunForUnreadableSource: mock(unexpected('releaseRunForUnreadableSource')),
    releasePausedRunSlot: mock(async () => ({ released: false })),
    answerAttentionWait: mock(unexpected('answerAttentionWait')),
    labelAttentionWait: mock(unexpected('labelAttentionWait')),
    listAttentionQueueRows: mock(unexpected('listAttentionQueueRows')),
    signalWorkflowWait: mock(unexpected('signalWorkflowWait')),
    resolveApprovalGate: mock(unexpected('resolveApprovalGate')),
    resolveAndCancelApprovalGate: mock(unexpected('resolveAndCancelApprovalGate')),
    cancelResumableRunsForConversation: mock(unexpected('cancelResumableRunsForConversation')),
    deleteWorkflowNodeSessions: mock(unexpected('deleteWorkflowNodeSessions')),
    findOpenWorkRuns: mock(unexpected('findOpenWorkRuns')),
    findAdoptingRuns: mock(unexpected('findAdoptingRuns')),
    deleteOldWorkflowRuns: mock(unexpected('deleteOldWorkflowRuns')),
    listWorkflowEvents: mock(unexpected('listWorkflowEvents')),
    listEventsForRuns: mock(unexpected('listEventsForRuns')),
    findWorkflowRunsByIdPrefix: mock(async () => []),
    listWorkflowRuns: mock(unexpected('listWorkflowRuns')),
    getActiveWorkflowRunByPath: mock(async () => null),
    findChildRuns: mock(async () => []),
    getRunAncestry: mock(async () => []),
    createWorkflowRun: mock(async () => makeRun()),
    claimPendingWorkflowRun: mock(async () => makeRun()),
    recordWorkflowRunCheckoutBaseline: mock(
      async (_id: string, baseline: CheckoutObservation) => baseline
    ),
    updateWorkflowRunMetadataIfRunning: mock<IWorkflowStore['updateWorkflowRunMetadataIfRunning']>(
      async () => true
    ),
    updateWorkflowRun: mock(async () => undefined),
    failWorkflowRun: mock(async () => ({ failed: true })),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    getWorkflowRunStatus: mock(async () => 'completed' as const),
    setToolCallAttention: mock(async () => true),
    createWorkflowEvent: mock(async () => undefined),
    persistWorkflowEvent: mock(async () => undefined),
    persistWorkflowEventIfRunning: mock(async () => ({ persisted: true })),
    findResumableRun: mock(async () => null),
    listProviderEvents: mock(async () => []),
    getDagResumeSnapshot: mock(async () => ({
      completedNodeOutputs: new Map(),
      fanOutSnapshots: new Map(),
      failedNodes: new Map(),
      unresolvedNodeStarts: new Set<string>(),
      budget: { workUnits: 0, spendUsd: 0 },
      tokens: { input: 0, output: 0 },
      costUsd: 0,
    })),
    resumeWorkflowRun: mock(async () => makeRun()),
    recoverCancelledFanOutRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    updateWorkflowActivity: mock(async () => undefined),
    completeWorkflowRun: mock(async () => undefined),
    pauseWorkflowRun: mock(async () => undefined),
    pauseWorkflowRunForWait: mock(async () => undefined),
    clearWorkflowWaitContext: mock(
      async (id: string, _wait: unknown, completion: { stepName: string }) => ({
        cleared: true as const,
        nodeEvent: {
          workflow_run_id: id,
          event_type: 'node_completed' as const,
          step_name: completion.stepName,
          data: {},
        },
      })
    ),
    claimWriteback: mock(async () => ({ claimed: true })),
    releaseWritebackClaim: mock(async () => undefined),
    cancelWorkflowRun: mock(async () => ({ cancelled: false })),
    cancelFanOutRun: mock(async () => ({ cancelled: false })),
    listWorkflowNodeSessions: mock(async () => []),
    listWorkflowRunNodeSessions: mock(async () => []),
    upsertWorkflowRunNodeSession: mock(async () => undefined),
    upsertWorkflowNodeSession: mock(async () => undefined),
    ...overrides,
  };
}

/** The data of every `type` event the run wrote through `createWorkflowEvent`. */
export function recordedEvents(store: IWorkflowStore, type: string): ObservabilityEventInput[] {
  return mocked(store.createWorkflowEvent)
    .mock.calls.map(([event]) => event)
    .filter(event => event.event_type === type);
}

export function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(async () => undefined),
    getPlatformType: mock(() => 'test' as const),
  } as unknown as IWorkflowPlatform;
}

/** A platform that spells commands the way the CLI adapter does. */
export function makeCliPlatform(): IWorkflowPlatform {
  return {
    ...makePlatform(),
    getPlatformType: mock(() => 'cli' as const),
    formatWorkflowCommand: (command: string) => `archon workflow ${command}`,
  } as unknown as IWorkflowPlatform;
}

export function sentMessages(platform: IWorkflowPlatform): string[] {
  return mocked(platform.sendMessage).mock.calls.map(call => String(call[1]));
}

/** The repository config `makeDeps` loads, with `overrides` on top. */
export function configWith(overrides: Partial<WorkflowConfig> = {}): WorkflowDeps['loadConfig'] {
  return mock(
    async (): Promise<WorkflowConfig> => ({
      assistant: 'claude',
      assistants: { claude: {}, codex: {} },
      baseBranch: '',
      commands: { folder: '' },
      ...overrides,
    })
  );
}

export function makeDeps(store?: IWorkflowStore): WorkflowDeps {
  return {
    providers: providerRegistry,
    store: store ?? makeStore(),
    getUserProviderCredential: mock(async () => ({
      kind: 'api_key' as const,
      getStatus: async () => ({ state: 'usable' as const, source: 'archon' as const }),
    })),
    loadConfig: configWith(),
    getAgentProvider: mock(() => ({
      run: mock(async () => undefined),
      checkCredential: mock(async () => ({ state: 'not_checked', source: 'native' })),
    })),
  } as unknown as WorkflowDeps;
}

export function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): ResolvedWorkflow {
  return resolveWorkflow({
    name: 'test-workflow',
    description: 'Test',
    nodes: [{ id: 'node1', kind: 'agent', source: { kind: 'inline', prompt: 'Do something' } }],
    ...overrides,
  });
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

/** The options that continue `run` with these nodes already completed. */
export function resumeOf(
  run: WorkflowRun,
  completed: [string, PersistedNodeOutput][] = []
): { preCreatedRun: WorkflowRun; priorCompletedNodes: Map<string, PersistedNodeOutput> } {
  return { preCreatedRun: run, priorCompletedNodes: new Map(completed) };
}

export const repoCodebase = {
  id: 'cb-repo',
  name: 'acme/widget',
  repository_url: 'https://github.com/acme/widget',
  default_cwd: '/repos/widget',
  kind: 'repo' as const,
};

export function containerBackend(): NonNullable<ExecuteWorkflowOptions['container']>['backend'] {
  return {
    suspend: mock(async () => undefined),
    prepareSuspend: mock(async () => mock(async () => undefined)),
    finalize: mock(async () => ({ requiresApproval: false })),
    applyChanges: mock(async () => ({ filesApplied: 0, filesDeleted: 0, warnings: [] })),
    discardChanges: mock(async () => undefined),
  };
}

/** Arranges for the next DAG execution to report what `$ADOPTED_RUN_DIR` resolves to. */
export function captureAdoptedRunDir(): () => string {
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
  return () => substituted;
}

export interface StartInput {
  deps?: WorkflowDeps;
  /** The store of default deps; ignored when `deps` is given. */
  store?: IWorkflowStore;
  platform?: IWorkflowPlatform;
  conversationId?: string;
  cwd?: string;
  workflow?: ResolvedWorkflow;
  message?: string;
  origin?: Parameters<typeof executeWorkflow>[6];
  options?: ExecuteWorkflowOptions;
}

/** executeWorkflow with this suite's defaults for every argument a test does not name. */
export function startWorkflow(input: StartInput = {}): ReturnType<typeof executeWorkflow> {
  return executeWorkflow(
    input.deps ?? makeDeps(input.store),
    input.platform ?? makePlatform(),
    input.conversationId ?? 'conv-1',
    input.cwd ?? '/tmp',
    input.workflow ?? makeWorkflow(),
    input.message ?? 'msg',
    input.origin ?? { conversationId: 'db-conv-1' },
    input.options
  );
}

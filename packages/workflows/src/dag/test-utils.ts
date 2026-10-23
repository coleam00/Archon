import { inMemoryEventRows } from '../test-utils';
import { afterEach, expect, mock, spyOn, type Mock } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';
import * as git from '@archon/git';
import { clearRegistry, getProviderCapabilities, providerRegistry } from '@archon/providers';
import {
  registerBuiltinProviders,
  registerPiProvider,
  registerOpencodeProvider,
} from '@archon/providers/in-process';
import type { ProviderCapabilities, ProviderRegistry } from '@archon/provider-contract';
import { settlingProvider } from '../test-settling-provider';
import * as nodeEventWrite from '../node-event-write';
import * as subprocess from '../subprocess';
import type { ExecuteDagWorkflowOptions } from '../dag-executor';
import { substituteNodeOutputRefs as substituteNodeOutputRefsInScopes } from './references';
import { resolveWorkflow } from '../graph-plan';
import { readNodeArtifacts } from '../artifacts-index';
import type {
  AgentNode,
  DagNode,
  IncludeDirective,
  NodeOutput,
  WorkflowRun,
  WorkflowDefinition,
  ResolvedWorkflow,
} from '../schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from '../deps';
import type { IWorkflowStore } from '../store';
import { waitCompletionEvents } from '../store';
import { composeFanOutScopeSegment } from '../fan-out-identity';
import { CONTAINER_MARKER_PROBE } from '../checkout-observation';

/**
 * Shared scaffolding for the DAG executor tests. Importing this module replaces
 * `@archon/paths` with a mock rooted at an unreachable home and registers the built-in
 * providers, so an importing test file must start with `// @archon-test-isolated`.
 */

export const mockLogFn = mock((_data: unknown, _message?: string): void => undefined);
export const mockLogger = {
  level: 'info',
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
/**
 * The Archon home the artifact-pointer gate (#2453) resolves run artifact roots under.
 * Mutable so the pointer suite can point it at its own temp tree; every other suite
 * leaves it on the unreachable default, where no pointer can validate.
 */
export let mockArtifactHome = '/nonexistent/home';
export let mockWorkflowHome = '/nonexistent/home/workflows';
export function setMockArtifactHome(home: string): void {
  mockArtifactHome = home;
}
export function setMockWorkflowHome(home: string): void {
  mockWorkflowHome = home;
}
// Captured before the module mock below replaces it.
const actualPaths = await import('@archon/paths');
const { isPathInside } = actualPaths;
mock.module('@archon/paths', () => ({
  ...actualPaths,
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  getWorkflowFolderSearchPaths: () => ['.archon/workflows'],
  getBundledWorkflowsPath: () => '/nonexistent/defaults/workflows',
  getHomeWorkflowsPath: () => mockWorkflowHome,
  getArchonHome: () => '/nonexistent/home',
  // Real semantics, rooted at the mutable fake home above, so the artifact-pointer
  // containment rules are exercised rather than stubbed away.
  isInsideArchonHome: (candidate: string): boolean =>
    isPathInside(mockArtifactHome, candidate, { includeRoot: true, lexical: true }),
  getRunArtifactsDirForRoot: (root: string, runId: string): string =>
    join(root, 'artifacts', 'runs', runId),
}));

clearRegistry();
registerBuiltinProviders();
// Pi is a community provider (best-effort structured output) — register it so the
// reask-loop tests can resolve `getProviderCapabilities('pi')` to 'best-effort'.
// deps.getAgentProvider is mocked, so the real Pi SDK is never loaded.
registerPiProvider();
// OpenCode is the only registered provider with `effortControl: false` — it is what
// makes `resolvePresetEffort`'s rejection branch reachable at this call site (#2556).
registerOpencodeProvider();

export function composeScope(
  nodeId = 'fan',
  loopGroupPath: readonly { groupId: string; iteration: number }[] = []
): string {
  return composeFanOutScopeSegment(nodeId, loopGroupPath);
}

export function composeInnerStep(
  identity: string,
  innerNodeId: string,
  nodeId = 'fan',
  loopGroupPath: readonly { groupId: string; iteration: number }[] = []
): string {
  const scope = composeScope(nodeId, loopGroupPath);
  return `${scope}__${identity}__${nodeId}__${identity}__${innerNodeId}`;
}

// --- Mock helpers ---

// This fixture's createWorkflowEvent mock collects both durable and best-effort writes.
// The production IWorkflowStore interface separately restricts the best-effort route.
export type MockWorkflowEventCollector = Mock<IWorkflowStore['persistWorkflowEvent']>;
export type MockWorkflowStore = {
  [K in Exclude<keyof IWorkflowStore, 'createWorkflowEvent'>]: IWorkflowStore[K] extends (
    ...args: infer Args
  ) => infer Result
    ? Mock<(...args: Args) => Result>
    : IWorkflowStore[K];
} & { createWorkflowEvent: MockWorkflowEventCollector };

export function mockWorkflowRun(id = 'mock-run-id'): WorkflowRun {
  return {
    origin: { conversationId: 'conv-mock' },
    id,
    workflow_name: 'mock',
    conversation_id: 'conv-mock',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'mock message',
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
  };
}

export function createMockStore(): MockWorkflowStore {
  const createWorkflowEvent = mock<IWorkflowStore['persistWorkflowEvent']>(
    async _data => undefined
  );
  const getWorkflowRunStatus = mock<IWorkflowStore['getWorkflowRunStatus']>(async _id => 'running');
  return {
    getWorkflowEventHead: mock<IWorkflowStore['getWorkflowEventHead']>(() => {
      throw new Error('Unexpected event feed read');
    }),
    readWorkflowEventsAfter: mock<IWorkflowStore['readWorkflowEventsAfter']>(() => {
      throw new Error('Unexpected event feed read');
    }),
    getStateDocument: mock<IWorkflowStore['getStateDocument']>(() => {
      throw new Error('Unexpected getStateDocument');
    }),
    putStateDocument: mock<IWorkflowStore['putStateDocument']>(() => {
      throw new Error('Unexpected putStateDocument');
    }),
    patchStateDocument: mock<IWorkflowStore['patchStateDocument']>(() => {
      throw new Error('Unexpected patchStateDocument');
    }),
    deleteStateDocument: mock<IWorkflowStore['deleteStateDocument']>(() => {
      throw new Error('Unexpected deleteStateDocument');
    }),
    listStateRevisions: mock<IWorkflowStore['listStateRevisions']>(() => {
      throw new Error('Unexpected listStateRevisions');
    }),
    listStateDocuments: mock<IWorkflowStore['listStateDocuments']>(() => {
      throw new Error('Unexpected listStateDocuments');
    }),
    getStateDocuments: mock<IWorkflowStore['getStateDocuments']>(() => {
      throw new Error('Unexpected getStateDocuments');
    }),
    pruneStateRevisions: mock<IWorkflowStore['pruneStateRevisions']>(() => {
      throw new Error('Unexpected pruneStateRevisions');
    }),
    setToolCallAttention: mock<IWorkflowStore['setToolCallAttention']>(async () => true),
    admitResourceStart: mock<IWorkflowStore['admitResourceStart']>(() => {
      throw new Error('Unexpected admitResourceStart');
    }),
    drainResourceStarts: mock<IWorkflowStore['drainResourceStarts']>(() => {
      throw new Error('Unexpected drainResourceStarts');
    }),
    hasStartReceiptForDelivery: mock<IWorkflowStore['hasStartReceiptForDelivery']>(() => {
      throw new Error('Unexpected hasStartReceiptForDelivery');
    }),
    acceptStartReceipt: mock<IWorkflowStore['acceptStartReceipt']>(() => {
      throw new Error('Unexpected acceptStartReceipt');
    }),
    getStartReceipt: mock<IWorkflowStore['getStartReceipt']>(() => {
      throw new Error('Unexpected getStartReceipt');
    }),
    listStartReceipts: mock<IWorkflowStore['listStartReceipts']>(() => {
      throw new Error('Unexpected listStartReceipts');
    }),
    listPendingStartBindings: mock<IWorkflowStore['listPendingStartBindings']>(() => {
      throw new Error('Unexpected listPendingStartBindings');
    }),
    getResourceStartRequest: mock<IWorkflowStore['getResourceStartRequest']>(() => {
      throw new Error('Unexpected getResourceStartRequest');
    }),
    listQueuedResourceStartsForHost: mock<IWorkflowStore['listQueuedResourceStartsForHost']>(() => {
      throw new Error('Unexpected listQueuedResourceStartsForHost');
    }),
    withdrawQueuedResourceStart: mock<IWorkflowStore['withdrawQueuedResourceStart']>(() => {
      throw new Error('Unexpected withdrawQueuedResourceStart');
    }),
    claimStartBindingPreparation: mock<IWorkflowStore['claimStartBindingPreparation']>(() => {
      throw new Error('Unexpected claimStartBindingPreparation');
    }),
    completeStartBindingPreparation: mock<IWorkflowStore['completeStartBindingPreparation']>(() => {
      throw new Error('Unexpected completeStartBindingPreparation');
    }),
    failStartBindingPreparation: mock<IWorkflowStore['failStartBindingPreparation']>(() => {
      throw new Error('Unexpected failStartBindingPreparation');
    }),
    resetStartBindingPreparation: mock<IWorkflowStore['resetStartBindingPreparation']>(() => {
      throw new Error('Unexpected resetStartBindingPreparation');
    }),
    listDueWorkflowContinuations: mock<IWorkflowStore['listDueWorkflowContinuations']>(() => {
      throw new Error('Unexpected listDueWorkflowContinuations');
    }),
    deferWorkflowContinuation: mock<IWorkflowStore['deferWorkflowContinuation']>(() => {
      throw new Error('Unexpected deferWorkflowContinuation');
    }),
    releaseRunForUnreadableSource: mock<IWorkflowStore['releaseRunForUnreadableSource']>(
      async (_id, _release, beforePublish) => {
        await beforePublish?.();
        getWorkflowRunStatus.mockImplementation(async () => 'paused');
        return { released: true };
      }
    ),
    releasePausedRunSlot: mock<IWorkflowStore['releasePausedRunSlot']>(() =>
      Promise.resolve({ released: false })
    ),
    answerAttentionWait: mock<IWorkflowStore['answerAttentionWait']>(() => {
      throw new Error('Unexpected answerAttentionWait');
    }),
    labelAttentionWait: mock<IWorkflowStore['labelAttentionWait']>(() => {
      throw new Error('Unexpected labelAttentionWait');
    }),
    listAttentionQueueRows: mock<IWorkflowStore['listAttentionQueueRows']>(() => {
      throw new Error('Unexpected listAttentionQueueRows');
    }),
    signalWorkflowWait: mock<IWorkflowStore['signalWorkflowWait']>(() => {
      throw new Error('Unexpected signalWorkflowWait');
    }),
    resolveApprovalGate: mock<IWorkflowStore['resolveApprovalGate']>(() => {
      throw new Error('Unexpected resolveApprovalGate');
    }),
    resolveAndCancelApprovalGate: mock<IWorkflowStore['resolveAndCancelApprovalGate']>(() => {
      throw new Error('Unexpected resolveAndCancelApprovalGate');
    }),
    cancelResumableRunsForConversation: mock<IWorkflowStore['cancelResumableRunsForConversation']>(
      () => {
        throw new Error('Unexpected cancelResumableRunsForConversation');
      }
    ),
    deleteWorkflowNodeSessions: mock<IWorkflowStore['deleteWorkflowNodeSessions']>(() => {
      throw new Error('Unexpected deleteWorkflowNodeSessions');
    }),
    findOpenWorkRuns: mock<IWorkflowStore['findOpenWorkRuns']>(async () => {
      throw new Error('Not used by this test');
    }),
    findAdoptingRuns: mock<IWorkflowStore['findAdoptingRuns']>(async () => {
      throw new Error('Not used by this test');
    }),
    deleteOldWorkflowRuns: mock<IWorkflowStore['deleteOldWorkflowRuns']>(async () => {
      throw new Error('Not used by this test');
    }),
    listWorkflowEvents: mock<IWorkflowStore['listWorkflowEvents']>(async runId =>
      inMemoryEventRows(createWorkflowEvent.mock.calls.map(([event]) => event)).filter(
        event => event.workflow_run_id === runId
      )
    ),
    listEventsForRuns: mock<IWorkflowStore['listEventsForRuns']>(async () => {
      throw new Error('Not used by this test');
    }),
    findWorkflowRunsByIdPrefix: mock<IWorkflowStore['findWorkflowRunsByIdPrefix']>(async () => []),
    listWorkflowRuns: mock<IWorkflowStore['listWorkflowRuns']>(() => {
      throw new Error('Unexpected listWorkflowRuns');
    }),
    createWorkflowRun: mock<IWorkflowStore['createWorkflowRun']>(async _data => mockWorkflowRun()),
    claimPendingWorkflowRun: mock<IWorkflowStore['claimPendingWorkflowRun']>(async _id =>
      mockWorkflowRun()
    ),
    recordWorkflowRunCheckoutBaseline: mock<IWorkflowStore['recordWorkflowRunCheckoutBaseline']>(
      async (_id, baseline) => baseline
    ),
    getWorkflowRun: mock<IWorkflowStore['getWorkflowRun']>(async _id => null),
    findChildRuns: mock<IWorkflowStore['findChildRuns']>(async _parentRunId => []),
    getRunAncestry: mock<IWorkflowStore['getRunAncestry']>(async _runId => []),
    getActiveWorkflowRunByPath: mock<IWorkflowStore['getActiveWorkflowRunByPath']>(
      async (_workingPath, _self) => null
    ),
    findResumableRun: mock<IWorkflowStore['findResumableRun']>(
      async (_workflowName, _workingPath) => null
    ),
    resumeWorkflowRun: mock<IWorkflowStore['resumeWorkflowRun']>(async _id => mockWorkflowRun()),
    recoverCancelledFanOutRun: mock<IWorkflowStore['recoverCancelledFanOutRun']>(async _id =>
      mockWorkflowRun()
    ),
    updateWorkflowRunMetadataIfRunning: mock<IWorkflowStore['updateWorkflowRunMetadataIfRunning']>(
      async () => true
    ),
    updateWorkflowRun: mock<IWorkflowStore['updateWorkflowRun']>(
      async (_id, _updates) => undefined
    ),
    updateWorkflowActivity: mock<IWorkflowStore['updateWorkflowActivity']>(async _id => undefined),
    getWorkflowRunStatus,
    completeWorkflowRun: mock<IWorkflowStore['completeWorkflowRun']>(
      async (_id, _completion, _metadata) => undefined
    ),
    failWorkflowRun: mock<IWorkflowStore['failWorkflowRun']>(async () => ({ failed: true })),
    pauseWorkflowRun: mock<IWorkflowStore['pauseWorkflowRun']>(
      async (_id, _approvalContext, _extraMetadata, event) => {
        if (event) await createWorkflowEvent(event);
      }
    ),
    pauseWorkflowRunForWait: mock<NonNullable<IWorkflowStore['pauseWorkflowRunForWait']>>(
      async (_id, _waitContext) => undefined
    ),
    clearWorkflowWaitContext: mock<IWorkflowStore['clearWorkflowWaitContext']>(
      async (id, _waitContext, completion) => ({
        cleared: true,
        nodeEvent: waitCompletionEvents(id, completion).node,
      })
    ),
    claimWriteback: mock<IWorkflowStore['claimWriteback']>(async _id => ({ claimed: true })),
    releaseWritebackClaim: mock<IWorkflowStore['releaseWritebackClaim']>(async _id => undefined),
    cancelWorkflowRun: mock<IWorkflowStore['cancelWorkflowRun']>(async _id => ({
      cancelled: false,
    })),
    cancelFanOutRun: mock<IWorkflowStore['cancelFanOutRun']>(async (_id, _reason) => ({
      cancelled: false,
    })),
    createWorkflowEvent,
    persistWorkflowEvent: mock<IWorkflowStore['persistWorkflowEvent']>(async data => {
      await createWorkflowEvent(data);
    }),
    persistWorkflowEventIfRunning: mock<IWorkflowStore['persistWorkflowEventIfRunning']>(
      async data => {
        await createWorkflowEvent(data);
        return { persisted: true };
      }
    ),
    listProviderEvents: mock<IWorkflowStore['listProviderEvents']>(async () => []),
    getDagResumeSnapshot: mock<IWorkflowStore['getDagResumeSnapshot']>(async _workflowRunId =>
      Promise.resolve({
        completedNodeOutputs: new Map<string, { output: string }>(),
        fanOutSnapshots: new Map(),
        failedNodes: new Map(),
        unresolvedNodeStarts: new Set(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })
    ),
    getCodebase: mock<IWorkflowStore['getCodebase']>(async _id => null),
    getCodebaseEnvVars: mock<IWorkflowStore['getCodebaseEnvVars']>(async _codebaseId => ({})),
    listWorkflowNodeSessions: mock<IWorkflowStore['listWorkflowNodeSessions']>(async _scope => []),
    listWorkflowRunNodeSessions: mock<IWorkflowStore['listWorkflowRunNodeSessions']>(
      async _workflowRunId => []
    ),
    upsertWorkflowRunNodeSession: mock<IWorkflowStore['upsertWorkflowRunNodeSession']>(
      async _params => undefined
    ),
    upsertWorkflowNodeSession: mock<IWorkflowStore['upsertWorkflowNodeSession']>(
      async _params => undefined
    ),
  };
}

/**
 * The run-level usage metadata the executor persisted, in call order (#2469). Usage is
 * written through `updateWorkflowRun` at the run tail on EVERY disposition, so this is
 * the single surface a usage assertion should read — regardless of whether the run then
 * completed, failed, was cancelled, or paused. Other `updateWorkflowRun` writes
 * (output_root, evidence_validation, …) are filtered out by key.
 */
export function runUsageWrites(
  store: ReturnType<typeof createMockStore>
): Record<string, unknown>[] {
  return (store.updateWorkflowRun as ReturnType<typeof mock>).mock.calls
    .map((call: unknown[]) => (call[1] as { metadata?: Record<string, unknown> })?.metadata)
    .filter(
      (metadata): metadata is Record<string, unknown> =>
        metadata !== undefined &&
        ('total_cost_usd' in metadata ||
          'total_tokens_in' in metadata ||
          'total_tokens_out' in metadata)
    );
}

/** Authored-outcome writes, excluding lifecycle/metadata/root updates. */
export function authoredOutcomeWrites(
  store: ReturnType<typeof createMockStore>
): Array<'succeeded' | 'failed'> {
  return (store.updateWorkflowRun as ReturnType<typeof mock>).mock.calls
    .map((call: unknown[]) => (call[1] as { outcome?: 'succeeded' | 'failed' }).outcome)
    .filter((outcome): outcome is 'succeeded' | 'failed' => outcome !== undefined);
}

export function withProviderCapabilities(
  providers: ProviderRegistry,
  provider: string,
  capabilities: ProviderCapabilities
): ProviderRegistry {
  const descriptor = providers.get(provider);
  if (!descriptor) throw new Error(`Missing test provider '${provider}'`);
  const replacement = { ...descriptor, capabilities };
  return {
    get: id => (id === provider ? replacement : providers.get(id)),
    list: () => providers.list().map(entry => (entry.id === provider ? replacement : entry)),
    unavailable: id => providers.unavailable?.(id),
  };
}

export const mockClaudeCapabilities = (): ProviderCapabilities => ({
  ...getProviderCapabilities('claude'),
  backgroundWork: 'unobserved',
});

export const mockProviderRegistry = withProviderCapabilities(
  providerRegistry,
  'claude',
  mockClaudeCapabilities()
);

/** Canonical capabilities for Codex-backed test nodes. */
export const mockCodexCapabilities = (): ReturnType<typeof getProviderCapabilities> =>
  getProviderCapabilities('codex');

/** Mock AI sendQuery generator */
export const mockSendQueryDag = mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
  async function* (_prompt, _cwd, _resumeSessionId, _options) {
    yield { type: 'agent_message_chunk', text: 'DAG AI response' };
    yield { type: 'result', sessionId: 'dag-session-id' };
  }
);

export const mockGetAgentProviderDag = mock<WorkflowDeps['getAgentProvider']>(_provider => ({
  sendQuery: mockSendQueryDag,
  checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
  getType: () => 'claude',
  getCapabilities: mockClaudeCapabilities,
}));

export type MockWorkflowDeps<TStore extends IWorkflowStore> = Omit<
  WorkflowDeps,
  'store' | 'getAgentProvider' | 'loadConfig'
> & {
  store: TStore;
  getAgentProvider: WorkflowDeps['getAgentProvider'];
  loadConfig: Mock<WorkflowDeps['loadConfig']>;
};

export function createMockDeps<TStore extends IWorkflowStore = MockWorkflowStore>(
  storeOverride?: TStore,
  providers: ProviderRegistry = mockProviderRegistry
): MockWorkflowDeps<TStore> {
  const store = storeOverride ?? createMockStore();
  return {
    providers,
    store: store as TStore,
    // Mock providers settle like real ones; see settlingProvider.
    getAgentProvider: provider =>
      settlingProvider({
        ...mockGetAgentProviderDag(provider),
        getCapabilities: () => {
          const descriptor = providers.get(provider);
          if (!descriptor) throw new Error(`Missing test provider '${provider}'`);
          return descriptor.capabilities;
        },
      }),
    loadConfig: mock<WorkflowDeps['loadConfig']>(async _cwd => ({
      assistant: 'claude' as const,
      commands: {},
      defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
      assistants: { claude: {}, codex: {} },
    })),
  };
}

export type MockWorkflowPlatform = {
  sendMessage: Mock<IWorkflowPlatform['sendMessage']>;
  getStreamingMode: Mock<IWorkflowPlatform['getStreamingMode']>;
  getPlatformType: Mock<IWorkflowPlatform['getPlatformType']>;
  sendStructuredEvent: Mock<NonNullable<IWorkflowPlatform['sendStructuredEvent']>>;
};

export function createMockPlatform(): MockWorkflowPlatform {
  return {
    sendMessage: mock<IWorkflowPlatform['sendMessage']>(
      async (_conversationId, _message, _metadata) => undefined
    ),
    getStreamingMode: mock<IWorkflowPlatform['getStreamingMode']>(() => 'batch'),
    getPlatformType: mock<IWorkflowPlatform['getPlatformType']>(() => 'test'),
    sendStructuredEvent: mock<NonNullable<IWorkflowPlatform['sendStructuredEvent']>>(
      async (_conversationId, _event) => undefined
    ),
  };
}

/**
 * Every message the run delivered to the platform, in call order.
 *
 * Assertions on this list should name an exact message. Operator prose is not a
 * wire format: a `find(m => m.includes(a) && m.includes(b))` guard passes for
 * any message that happens to contain both fragments, and breaks on a reword
 * that changes no behavior (#3167). Where the outcome has a structured surface
 * — a node status, a persisted event, a typed error — assert on that instead.
 */
export function deliveredMessages(platform: MockWorkflowPlatform): string[] {
  return platform.sendMessage.mock.calls.map(call => call[1]);
}

/** The workflow events the run persisted, in call order. */
export function persistedEvents(store: MockWorkflowStore) {
  return store.createWorkflowEvent.mock.calls.map(([event]) => event);
}

/** `loopIterations` lives only on the in-memory record, so read it where the record is written. */
export async function failedLoopIterations(nodeId: string, run: () => Promise<unknown>) {
  const recordSpy = spyOn(nodeEventWrite, 'recordNodeState');
  try {
    await run();
    const failed = recordSpy.mock.calls
      .map(([, record]) => record)
      .find(
        record =>
          !('cache' in record) && record.lifecycle.status === 'failed' && record.node.id === nodeId
      );
    return failed && !('cache' in failed) ? failed.diagnostics?.loopIterations : undefined;
  } finally {
    recordSpy.mockRestore();
  }
}

export const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

/**
 * `deps`, `cwd`, `workflow`, and `workflowRun` carry each test's own fixtures, so every call
 * supplies them; the run directories derive from `cwd` the way every call site built them.
 */
export type TestWorkflowDefinition = Omit<WorkflowDefinition, 'description' | 'nodes'> & {
  description?: string;
  nodes: readonly (DagNode | IncludeDirective)[];
};

export type DagOptionsOverrides = Omit<Partial<ExecuteDagWorkflowOptions>, 'workflow'> &
  Pick<ExecuteDagWorkflowOptions, 'deps' | 'cwd' | 'workflowRun'> & {
    workflow: TestWorkflowDefinition;
  };

export function resolveTestWorkflow(workflow: TestWorkflowDefinition): ResolvedWorkflow {
  return resolveWorkflow({
    ...workflow,
    description: workflow.description ?? workflow.name,
    nodes: [...workflow.nodes],
  });
}

/**
 * Answer every `execFileAsync` call the way `docker exec` answers for a container that does
 * not exist. Container-run tests use made-up container ids, and each node start probes the
 * container's checkout through `execFileAsync`; left alone, that probe spawns a real
 * `docker`, which can take longer than a test's whole budget on a CI runner.
 */
export function stubMissingContainer(): ReturnType<typeof spyOn<typeof git, 'execFileAsync'>> {
  return spyOn(git, 'execFileAsync').mockImplementation(async () => {
    throw new Error('Error response from daemon: No such container');
  });
}

/**
 * Spy on `execFileAsync` as the transport of a host bash or script node. On Windows such a
 * node runs through the owned process group instead, so its deadline can end the whole tree;
 * that path is routed into the same spy until the test ends.
 */
export function spyOnNodeExec(): ReturnType<typeof spyOn<typeof git, 'execFileAsync'>> {
  const execSpy = spyOn(git, 'execFileAsync');
  if (process.platform === 'win32')
    ownedGroupSpy = spyOn(subprocess, 'execOwnedProcessGroup').mockImplementation(
      (cmd, args, options) => git.execFileAsync(cmd, args, options)
    );
  return execSpy;
}
let ownedGroupSpy: { mockRestore(): void } | undefined;
afterEach(() => {
  ownedGroupSpy?.mockRestore();
  ownedGroupSpy = undefined;
});

/** The `docker` calls that dispatch node work, leaving out the checkout observation's probe. */
export function nodeDockerCalls(
  calls: Parameters<typeof git.execFileAsync>[]
): Parameters<typeof git.execFileAsync>[] {
  return calls.filter(
    ([command, args]) => command === 'docker' && args.at(-1) !== CONTAINER_MARKER_PROBE
  );
}

/**
 * Options for a direct `executeDagWorkflow` call, built from only what a test varies. The
 * defaults are the exact values these tests used to spell out at every call site, so a test
 * reads as the run it configures rather than as the fields it does not care about.
 *
 * Supplying `workflowModel` here is a convenience for tests only. It stays a required
 * `string | undefined` on `ExecuteDagWorkflowOptions` so a production caller cannot omit a
 * resolved model decision (#2302); this builder is not that guard's audience.
 */
export function dagOptions(overrides: DagOptionsOverrides): ExecuteDagWorkflowOptions {
  const { cwd, workflow, ...rest } = overrides;
  return {
    platform: createMockPlatform(),
    conversationId: 'conv-dag',
    workflowProvider: 'claude',
    workflowModel: undefined,
    artifactsDir: join(cwd, 'artifacts'),
    stateDir: join(cwd, 'state'),
    logDir: join(cwd, 'logs'),
    baseBranch: 'main',
    docsDir: 'docs/',
    config: minimalConfig,
    ...rest,
    cwd,
    workflow: resolveTestWorkflow(workflow),
  };
}

// --- Helpers ---

export function ready(wf: TestWorkflowDefinition): ResolvedWorkflow {
  return resolveTestWorkflow(wf);
}

export function node(id: string, depends_on?: string[], opts?: Partial<AgentNode>): AgentNode {
  return {
    id,
    kind: 'agent',
    source: { kind: 'command', name: id },
    ...(depends_on?.length ? { depends_on } : {}),
    ...opts,
  };
}

/** Substitution outside any loop_group: no enclosing loop scope. */
export function substituteNodeOutputRefs(
  prompt: string,
  nodeOutputs: Map<string, NodeOutput>,
  escapedForBash?: boolean,
  artifactsDir?: string,
  requiredContext?: Parameters<typeof substituteNodeOutputRefsInScopes>[5]
): string {
  return substituteNodeOutputRefsInScopes(
    prompt,
    nodeOutputs,
    [],
    escapedForBash,
    artifactsDir,
    requiredContext
  );
}

/**
 * Build a NodeOutput fixture for substitution tests.
 * Omits `structuredOutput` when undefined so the `'structuredOutput' in nodeOutput` presence
 * check in substituteNodeOutputRefs matches real producer behavior (Pi/Codex/Claude populate
 * it; older providers and the pending/skipped states leave it off).
 */
export function makeOutput(
  state: NodeOutput['state'],
  output = '',
  structuredOutput?: unknown,
  declaredFields?: string[]
): NodeOutput {
  const extra = {
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(declaredFields !== undefined
      ? { declaredOutputPaths: declaredFields.map(field => [field]) }
      : {}),
  };
  if (state === 'failed') {
    return { state, output, error: 'error', ...extra } as NodeOutput;
  }
  if (state === 'pending' || state === 'skipped') {
    return state === 'skipped'
      ? { state, output, cause: { kind: 'condition', expr: 'false' } }
      : { state, output };
  }
  return { state, output, ...extra } as NodeOutput;
}

/**
 * The reader's grouped result flattened across types, the whole-run view these
 * executor tests assert; scope filtering is proved in artifacts-index.test.ts.
 */
export async function readAllArtifacts(artifactsDir: string) {
  const { artifactsByType } = await readNodeArtifacts(artifactsDir, { scope: 'resolved-scope' });
  return Object.values(artifactsByType).flat();
}

export function makeWorkflowRun(
  id = 'dag-test-run-id',
  overrides?: Partial<WorkflowRun>
): WorkflowRun {
  return {
    origin: { conversationId: 'conv-dag' },
    id,
    workflow_name: 'dag-test',
    conversation_id: 'conv-dag',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'dag test message',
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

export function expectLoopGateEvidence(
  store: MockWorkflowStore,
  platform: MockWorkflowPlatform,
  statusLine: string,
  completionSignaled: boolean
): void {
  const pauseCalls = store.pauseWorkflowRun.mock.calls;
  expect(pauseCalls.length).toBe(1);
  const approval = pauseCalls[0][1];
  expect(approval).toMatchObject({ completionSignaled });
  expect(approval.message.startsWith(statusLine)).toBe(true);

  const approvalRequested = store.createWorkflowEvent.mock.calls
    .map(([event]) => event)
    .filter(event => event.event_type === 'approval_requested');
  expect(approvalRequested.length).toBe(1);
  expect(approvalRequested[0].data).toMatchObject({
    message: approval.message,
    completionSignaled,
  });

  const sentMessages = platform.sendMessage.mock.calls.map(([, message]) => message);
  expect(sentMessages.some(message => message.includes(approval.message))).toBe(true);
}

export function loaderBypassingWorkflow(
  workflow: TestWorkflowDefinition & {
    modelReasoningEffort: string;
  }
): ResolvedWorkflow & { modelReasoningEffort: string } {
  return Object.assign(resolveTestWorkflow(workflow), {
    modelReasoningEffort: workflow.modelReasoningEffort,
  });
}

/**
 * A run's JSONL transcript, parsed. Module-scoped so every describe reads a run's
 * transcript the same way.
 */
export const readTranscript = async (
  logDir: string,
  runId: string
): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(logDir, `${runId}.jsonl`), 'utf-8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);

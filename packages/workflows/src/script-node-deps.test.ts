// @archon-test-isolated
/**
 * Tests for US-005: dependency installation (deps field) in script nodes.
 *
 * These tests mock @archon/git's execFileAsync to verify command construction
 * without actually running uv/bun, and are isolated from dag-executor.test.ts
 * to avoid mock.module() pollution.
 */
import { providerRegistry } from '@archon/providers';
import { settlingProvider } from './test-settling-provider';
import type { CheckoutObservation } from './schemas/checkout-observation';
import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// --- Mock @archon/git BEFORE any imports that depend on it ---

const mockExecFileAsync = mock(
  async (_cmd: string, _args: string[], _opts?: unknown) =>
    ({ stdout: '', stderr: '' }) as { stdout: string; stderr: string }
);

mock.module('@archon/git', () => ({
  execFileAsync: mockExecFileAsync,
  mkdirAsync: mock(async () => undefined),
}));

// --- Mock logger (MUST come before module-under-test imports) ---

const mockLogFn = mock(() => {});
let testDir: string;
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getCommandFolderSearchPaths: (folder?: string) => {
    const paths = ['.archon/commands'];
    if (folder) paths.unshift(folder);
    return paths;
  },
  // This fixture has project scripts and no installed bundled source tree.
  getBundledWorkflowsPath: () => join(testDir, 'absent-bundle', 'workflows'),
}));

// --- Imports (after all mock.module calls) ---
import { executeDagWorkflow, type ExecuteDagWorkflowOptions } from './dag-executor';
import { resolveWorkflow } from './graph-plan';
import type { ExecNode, WorkflowDefinition, WorkflowRun } from './schemas';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import { workflowStoreDouble } from './test-utils';
import * as subprocess from './subprocess';

// --- Helpers ---

function createMockStore(): IWorkflowStore {
  return workflowStoreDouble<IWorkflowStore>({
    listSkippedItemStarts: mock<IWorkflowStore['listSkippedItemStarts']>(
      async itemIds => new Map(itemIds.map(id => [id, []]))
    ),
    listWaitedItemHolders: mock<IWorkflowStore['listWaitedItemHolders']>(async () => []),
    releasePausedRunSlot: mock<IWorkflowStore['releasePausedRunSlot']>(() =>
      Promise.resolve({ released: false })
    ),
    listEventsForRuns: mock<IWorkflowStore['listEventsForRuns']>(
      async runIds => new Map(runIds.map(runId => [runId, []]))
    ),
    listMetricRecords: mock<IWorkflowStore['listMetricRecords']>(async () => []),
    listAttentionWaitStarts: mock<IWorkflowStore['listAttentionWaitStarts']>(async () => []),
    listWorkflowNoticeRows: mock<IWorkflowStore['listWorkflowNoticeRows']>(async () => []),
    findWorkflowRunsByIdPrefix: mock<IWorkflowStore['findWorkflowRunsByIdPrefix']>(async () => []),
    createWorkflowRun: mock(() =>
      Promise.resolve({
        origin: { conversationId: 'conv-mock' },
        id: 'mock-run-id',
        workflow_name: 'mock',
        conversation_id: 'conv-mock',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running' as const,
        outcome: null,
        completed_outcome: null,
        user_message: 'mock message',
        metadata: {},
        active_phase_started_at: null,
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
        user_id: null,
        parent_run_id: null,
        output_root: null,
        checkout_baseline: null,
        item_id: null,
        adopted_from_run_id: null,
      })
    ),
    claimPendingWorkflowRun: mock(async () => null),
    recordWorkflowRunCheckoutBaseline: mock(
      async (_id: string, baseline: CheckoutObservation) => baseline
    ),
    getWorkflowRun: mock(() => Promise.resolve(null)),
    getWorkflowRunsByIds: mock(() => Promise.resolve([])),
    findChildRuns: mock(() => Promise.resolve([])),
    getRunAncestry: mock(() => Promise.resolve([])),
    getActiveWorkflowRunByPath: mock(() => Promise.resolve(null)),
    resumeWorkflowRun: mock(() =>
      Promise.resolve({
        origin: { conversationId: 'conv-mock' },
        id: 'mock-run-id',
        workflow_name: 'mock',
        conversation_id: 'conv-mock',
        parent_conversation_id: null,
        codebase_id: null,
        status: 'running' as const,
        outcome: null,
        completed_outcome: null,
        user_message: 'mock message',
        metadata: {},
        active_phase_started_at: null,
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
        user_id: null,
        parent_run_id: null,
        output_root: null,
        checkout_baseline: null,
        item_id: null,
        adopted_from_run_id: null,
      })
    ),
    updateWorkflowRunMetadataIfRunning: mock<IWorkflowStore['updateWorkflowRunMetadataIfRunning']>(
      async () => true
    ),
    updateWorkflowRun: mock(() => Promise.resolve()),
    updateWorkflowActivity: mock(() => Promise.resolve()),
    getWorkflowRunStatus: mock(() => Promise.resolve('running' as const)),
    completeWorkflowRun: mock(() => Promise.resolve({ startReceipts: [] })),
    failWorkflowRun: mock(() => Promise.resolve({ failed: true })),
    pauseWorkflowRun: mock(() => Promise.resolve()),
    pauseWorkflowRunForWait: mock(() => Promise.resolve()),
    clearWorkflowWaitContext: mock((id: string, _wait: unknown, completion: { stepName: string }) =>
      Promise.resolve({
        cleared: true as const,
        nodeEvent: {
          workflow_run_id: id,
          event_type: 'node_completed' as const,
          step_name: completion.stepName,
          data: {},
        },
      })
    ),
    claimWriteback: mock(() => Promise.resolve({ claimed: true })),
    releaseWritebackClaim: mock(() => Promise.resolve()),
    cancelWorkflowRun: mock(() => Promise.resolve({ cancelled: false })),
    cancelFanOutRun: mock(() => Promise.resolve({ cancelled: false })),
    setToolCallAttention: mock<IWorkflowStore['setToolCallAttention']>(async () => true),
    createWorkflowEvent: mock(() => Promise.resolve()),
    persistWorkflowEvent: mock(() => Promise.resolve()),
    persistWorkflowEventIfRunning: mock(() => Promise.resolve({ persisted: true })),
    listProviderEvents: mock(() => Promise.resolve([])),
    getDagResumeSnapshot: mock(() =>
      Promise.resolve({
        completedNodeOutputs: new Map<string, { output: string }>(),
        fanOutSnapshots: new Map(),
        failedNodes: new Map(),
        unresolvedNodeStarts: new Set<string>(),
        budget: { workUnits: 0, spendUsd: 0 },
        tokens: { input: 0, output: 0 },
        costUsd: 0,
      })
    ),
    getCodebase: mock(() => Promise.resolve(null)),
    getCodebaseEnvVars: mock(() => Promise.resolve({})),
    listWorkflowNodeSessions: mock(() => Promise.resolve([])),
    listWorkflowRunNodeSessions: mock(() => Promise.resolve([])),
    upsertWorkflowRunNodeSession: mock(() => Promise.resolve()),
    upsertWorkflowNodeSession: mock(() => Promise.resolve()),
  });
}

const mockSendQuery = mock<ReturnType<WorkflowDeps['getAgentProvider']>['sendQuery']>(
  async function* (_prompt, _cwd, _resumeSessionId, _options) {
    yield { type: 'agent_message_chunk', text: 'AI response' };
    yield { type: 'result', sessionId: 'session-id' };
  }
);

const mockGetAgentProvider = mock<WorkflowDeps['getAgentProvider']>(_provider => ({
  sendQuery: mockSendQuery,
  checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
  getType: () => 'claude',
  getCapabilities: () => ({
    backgroundWork: 'unobserved' as const,
    sessionResume: true,
    mcp: true,
    hooks: true,
    skills: true,
    plugins: false,
    agents: true,
    toolRestrictions: true,
    structuredOutput: 'enforced' as const,
    envInjection: true,
    costControl: true,
    costReporting: true,
    effortControl: true,
    fallbackModel: true,
    sandbox: true,
    settingSources: true,
    nativeTools: true,
    containerExec: true,
    requiresAllPropertiesRequired: false,
  }),
}));

function createMockDeps(): WorkflowDeps {
  return {
    providers: providerRegistry,
    store: createMockStore(),
    getAgentProvider: provider => settlingProvider(mockGetAgentProvider(provider)),
    loadConfig: mock(() =>
      Promise.resolve({
        assistant: 'claude' as const,
        commands: {},
        defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        assistants: { claude: {}, codex: {} },
      })
    ),
  };
}

function createMockPlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

function makeWorkflowRun(id: string): WorkflowRun {
  return {
    origin: { conversationId: 'conv-deps' },
    id,
    workflow_name: 'deps-test',
    conversation_id: 'conv-deps',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    completed_outcome: null,
    user_message: 'test',
    metadata: {},
    active_phase_started_at: null,
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    checkout_baseline: null,
    item_id: null,
    adopted_from_run_id: null,
  };
}

const minimalConfig: WorkflowConfig = {
  assistant: 'claude',
  assistants: { claude: {}, codex: {} },
  commands: {},
  defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
};

/**
 * `deps`, `cwd`, `workflow`, and `workflowRun` carry each test's own fixtures, so every call
 * supplies them; the run directories derive from `cwd` the way every call site built them.
 */
type TestWorkflowDefinition = Omit<WorkflowDefinition, 'description'> & {
  description?: string;
};

type DagOptionsOverrides = Omit<Partial<ExecuteDagWorkflowOptions>, 'workflow'> &
  Pick<ExecuteDagWorkflowOptions, 'deps' | 'cwd' | 'workflowRun'> & {
    workflow: TestWorkflowDefinition;
  };

/**
 * Options for a direct `executeDagWorkflow` call, built from only what a test varies. The
 * defaults are the exact values these tests used to spell out at every call site. They are
 * this file's own fixtures — `dag-executor.test.ts` has a builder of the same shape over its
 * own mocks, and the two do not have to agree.
 */
function dagOptions(overrides: DagOptionsOverrides): ExecuteDagWorkflowOptions {
  const { cwd, workflow, ...rest } = overrides;
  return {
    platform: createMockPlatform(),
    conversationId: 'conv-deps',
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
    workflow: resolveWorkflow({
      ...workflow,
      description: workflow.description ?? workflow.name,
    }),
  };
}

describe('script node deps field — command construction', () => {
  let ownedGroupSpy: { mockRestore(): void } | undefined;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `script-deps-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(testDir, { recursive: true });
    mockExecFileAsync.mockClear();
    mockSendQuery.mockClear();
    mockGetAgentProvider.mockClear();
    // On Windows a script node runs through the owned process group so its deadline can end
    // the whole tree; route that path into the same mock.
    if (process.platform === 'win32')
      ownedGroupSpy = spyOn(subprocess, 'execOwnedProcessGroup').mockImplementation(
        (cmd, args, options) => mockExecFileAsync(cmd, args, options)
      );
  });

  afterEach(async () => {
    ownedGroupSpy?.mockRestore();
    ownedGroupSpy = undefined;
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('uv inline with deps uses uv run --with flags', async () => {
    const node: ExecNode = {
      id: 'fetch-data',
      kind: 'exec',
      script: 'import httpx; print(httpx.get("https://example.com").status_code)',
      runtime: 'uv',
      deps: ['httpx', 'beautifulsoup4'],
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: { name: 'deps-test', nodes: [node] },
        workflowRun: makeWorkflowRun('deps-run-1'),
      })
    );

    const calls = mockExecFileAsync.mock.calls;
    const scriptCall = calls.find(c => (c[0] as string) === 'uv');
    expect(scriptCall).toBeDefined();
    const [cmd, args] = scriptCall as [string, string[]];
    expect(cmd).toBe('uv');
    expect(args[0]).toBe('run');
    expect(args).toContain('--with');
    expect(args).toContain('httpx');
    expect(args).toContain('beautifulsoup4');
    expect(args).toContain('python');
    expect(args).toContain('-c');
    // run --with httpx --with beautifulsoup4 python -c <code>
    expect(args.indexOf('--with')).toBeLessThan(args.indexOf('python'));
    expect(args[args.indexOf('python') + 1]).toBe('-c');
  });

  it('uv named script with deps uses uv run --with flags', async () => {
    // Create a named Python script
    const scriptsDir = join(testDir, '.archon', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    const { writeFile } = await import('fs/promises');
    await writeFile(join(scriptsDir, 'analyze.py'), 'import httpx\nprint("ok")');

    const node: ExecNode = {
      id: 'run-analyze',
      kind: 'exec',
      script: 'analyze',
      runtime: 'uv',
      deps: ['httpx'],
    };

    await executeDagWorkflow(
      dagOptions({
        deps: createMockDeps(),
        cwd: testDir,
        workflow: { name: 'deps-test', nodes: [node] },
        workflowRun: makeWorkflowRun('deps-run-6'),
      })
    );

    const calls = mockExecFileAsync.mock.calls;
    const scriptCall = calls.find(c => (c[0] as string) === 'uv');
    expect(scriptCall).toBeDefined();
    const [cmd, args] = scriptCall as [string, string[]];
    expect(cmd).toBe('uv');
    expect(args[0]).toBe('run');
    expect(args).toContain('--with');
    expect(args).toContain('httpx');
    // --with httpx comes before the file path
    const withIdx = args.indexOf('--with');
    const httpxIdx = args.indexOf('httpx');
    expect(httpxIdx).toBe(withIdx + 1);
    // Last arg is the script path
    expect(args[args.length - 1]).toContain('analyze.py');
  });
});

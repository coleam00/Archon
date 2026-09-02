/**
 * Tests for workflow commands
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  spyOn,
  mock,
  jest,
  type Mock,
  afterAll,
} from 'bun:test';
import {
  existsSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getArchonHome, isDocker } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  getProjectStoragePaths as getProjectStoragePathsReal,
  getRunArtifactsDirForRoot as getRunArtifactsDirForRootReal,
  getRunLogPathForRoot as getRunLogPathForRootReal,
  isInsideArchonHome as isInsideArchonHomeReal,
  resolveProjectStorageKey as resolveProjectStorageKeyReal,
  resolveRunStorageRoot as resolveRunStorageRootReal,
} from '@archon/paths/archon-paths';
import type { WorkflowEmitterEvent } from '@archon/workflows/event-emitter';
import type * as WorkflowDiscovery from '@archon/workflows/workflow-discovery';
import type * as WorkflowExecutor from '@archon/workflows/executor';
import type * as DetachedRunControl from '../utils/detached-run-control';
import {
  makeTestComposedWorkflow,
  makeTestResolvedWorkflow,
  makeTestWorkflow,
  makeTestWorkflowWithSource,
  withObservableCapturedSource,
} from '@archon/workflows/test-utils';
import type { WorkflowEventRow } from '@archon/core/schemas/workflow-event';
import {
  workflowListCommand,
  workflowRunCommand,
  workflowStatusCommand,
  workflowGetCommand,
  workflowLogsCommand,
  workflowWaitCommand,
  workflowRunsCommand,
  workflowResumeCommand,
  workflowAbandonCommand,
  workflowCancelCommand,
  workflowApproveCommand,
  workflowRejectCommand,
  workflowRespondCommand,
  workflowEventEmitCommand,
  workflowCleanupCommand,
  workflowTestCommand,
  workflowResetSessionsCommand,
  buildDetachedRunCmd,
  resolveDetachedRunEncryptionEnv,
  maybePrintTierNotice,
  resolveContainerBackendConfig,
  hasUnresolvedWriteback,
  buildNodeSummaries,
  resolveCliExitCode,
  WorkflowRunFailedError,
  DETACHED_RUN_FAILED_EXIT_CODE,
} from './workflow';

beforeAll(async () => {
  const { registerBuiltinProviders, registerCommunityProviders } =
    await import('@archon/providers');
  registerBuiltinProviders();
  registerCommunityProviders();
});

const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

const mockDetachedTargetStop = mock((): Promise<void> => Promise.resolve());
const mockDetachedTargetRelease = mock((): undefined => undefined);
const mockReclaimContainerEnv = mock((): Promise<void> => Promise.resolve());
const mockRequestDetachedRunStop = mock<typeof DetachedRunControl.requestDetachedRunStop>(() =>
  Promise.resolve({ stop: mockDetachedTargetStop, release: mockDetachedTargetRelease })
);
const mockRunLiveOwnerClose = mock((): Promise<void> => Promise.resolve());
const mockAssertDetachedRunProcessOwner = mock((): undefined => undefined);
let mockDetachedStopRequested = false;
const mockStartRunLiveOwner = mock(
  (
    _runId: string
  ): Promise<{
    close: typeof mockRunLiveOwnerClose;
    isStopRequested: () => boolean;
  }> =>
    Promise.resolve({
      close: mockRunLiveOwnerClose,
      isStopRequested: (): boolean => mockDetachedStopRequested,
    })
);

mock.module(
  '../utils/detached-run-control',
  (): {
    assertDetachedRunProcessOwner: typeof mockAssertDetachedRunProcessOwner;
    DETACHED_RUN_OWNER_ENV: string;
    requestDetachedRunStop: typeof mockRequestDetachedRunStop;
  } => ({
    assertDetachedRunProcessOwner: mockAssertDetachedRunProcessOwner,
    DETACHED_RUN_OWNER_ENV: 'ARCHON_DETACHED_RUN_OWNER',
    requestDetachedRunStop: mockRequestDetachedRunStop,
  })
);

mock.module('@archon/core/services/run-live-owner', () => ({
  startRunLiveOwner: mockStartRunLiveOwner,
}));

mock.module(
  '@archon/core/services/cleanup-service',
  (): {
    reclaimContainerEnv: typeof mockReclaimContainerEnv;
  } => ({
    reclaimContainerEnv: mockReclaimContainerEnv,
  })
);

// The waiter itself is proven in @archon/core and against a real detached run in
// workflow-wait.integration.spec.ts. Here the command's OWN responsibilities are
// under test: prefix resolution, both output modes, and the exit code per outcome.
const mockWaitForRunAttention = mock(
  (
    _runId: string,
    _opts?: { onAttached?: (observedStatus: string) => void | Promise<void> }
  ): Promise<unknown> => Promise.resolve({ kind: 'not_found', runId: 'unset' })
);
mock.module('@archon/core/services/run-attention-watch', () => ({
  waitForRunAttention: mockWaitForRunAttention,
}));

const mockCreateWorkflowEvent = mock(() => Promise.resolve());
const mockFolderBackendPrepare = mock(() =>
  Promise.resolve({
    cwd: '/test/path',
    execContext: { kind: 'host' as const },
    envId: 'container-env-1',
    overlayMode: 'volume-copy' as const,
  })
);
const mockFolderBackendDestroy = mock(() => Promise.resolve());
const mockResolveFolderBackend = mock(() => ({
  prepare: mockFolderBackendPrepare,
  resumeEnv: mockFolderBackendPrepare,
  destroy: mockFolderBackendDestroy,
}));

const mockIsDocker = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.WORKSPACE_PATH === '/workspace' ||
  (env.HOME === '/root' && Boolean(env.WORKSPACE_PATH)) ||
  env.ARCHON_DOCKER === 'true';
const mockExpandTilde = (path: string): string =>
  path.startsWith('~') ? join(homedir(), path.slice(1).replace(/^[/\\]/, '')) : path;

// Mock @archon/paths (createLogger moved here from @archon/core)
mock.module('@archon/paths', () => ({
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
  expandTilde: mockExpandTilde,
  isDocker: mockIsDocker,
  getArchonHome: mock((env: NodeJS.ProcessEnv = process.env) =>
    mockIsDocker(env)
      ? '/.archon'
      : env.ARCHON_HOME
        ? mockExpandTilde(env.ARCHON_HOME)
        : '/home/test/.archon'
  ),
  getProjectStoragePaths: getProjectStoragePathsReal,
  getRunArtifactsDirForRoot: getRunArtifactsDirForRootReal,
  getRunLogPathForRoot: getRunLogPathForRootReal,
  isInsideArchonHome: isInsideArchonHomeReal,
  resolveProjectStorageKey: resolveProjectStorageKeyReal,
  resolveRunStorageRoot: resolveRunStorageRootReal,
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: '0.0.0-test',
  readTierNoticeState: mock(() => null),
  markTierNoticeShown: mock(() => undefined),
}));

// Mock @archon/isolation (getIsolationProvider moved here from @archon/core)
mock.module('@archon/isolation', () => ({
  configureIsolation: mock(() => undefined),
  classifyIsolationError: (error: Error) => error.message,
  getIsolationProvider: mock(() => ({
    create: mock(() =>
      Promise.resolve({
        provider: 'worktree',
        id: '/test/path',
        workingPath: '/test/path',
        branchName: 'test-branch',
        status: 'active',
        createdAt: new Date(),
        metadata: { adopted: false },
      })
    ),
    healthCheck: mock(() => Promise.resolve(true)),
  })),
  resolveFolderBackend: mockResolveFolderBackend,
}));

// Mock the @archon/core modules
mock.module('@archon/core', () => ({
  registerRepository: mock(() =>
    Promise.resolve({
      codebaseId: 'cb-auto',
      name: 'test/repo',
      repositoryUrl: null,
      defaultCwd: '/test/path',
      commandCount: 0,
      alreadyExisted: false,
    })
  ),
  registerFolder: mock(() =>
    Promise.resolve({
      codebaseId: 'cb-folder',
      name: 'platform',
      repositoryUrl: null,
      defaultCwd: '/test/path',
      defaultBranch: null,
      commandCount: 0,
      alreadyExisted: false,
    })
  ),
  loadConfig: mock(() => Promise.resolve({ defaults: {} })),
  generateAndSetTitle: mock(() => Promise.resolve()),
  loadRepoConfig: mock(() => Promise.resolve(null)),
  getUserAiPrefs: mock(() => Promise.resolve({})),
  createWorkflowStore: mock(() => ({ createWorkflowEvent: mockCreateWorkflowEvent })),
  // requires: [github] gate. Default to a solo-install posture (disabled) so the
  // gate is a no-op for every existing test; the gate-specific tests below flip
  // isPerUserGitHubEnabled on per-invocation.
  isPerUserGitHubEnabled: mock(() => false),
  getDecryptedAccessToken: mock(() => Promise.resolve(null)),
}));

mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(() => Promise.resolve({ id: 'user-cli-1' })),
}));

mock.module('@archon/core/operations/workflow-adoption', () => ({
  // No test adopts unless it opts in; a loud default keeps an unexpected lane from
  // silently falling through to a fresh run.
  resolveWorkflowAdoption: mock(() => Promise.reject(new Error('adoption not expected'))),
}));

const mockDiscoverWorkflowsWithConfig = mock<typeof WorkflowDiscovery.discoverWorkflowsWithConfig>(
  () => Promise.resolve({ workflows: [], errors: [] })
);
mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));
mock.module('@archon/workflows/fixture-runner', () => ({
  runFixtures: mock(() => Promise.resolve({ results: [], passed: 0, failed: 0 })),
  formatFixtureReport: mock(() => 'FIXTURE REPORT'),
}));
/**
 * Ownership calls the run path makes on its capture, in order.
 *
 * `withCapturedSource` is stubbed as a faithful pass-through rather than mocked away: the
 * wrapper's whole job is that an unadopted capture gets reclaimed, and a stub that swallows
 * the owner would let a dropped `adopt()` — which deletes a live run's source — pass here.
 */
const capturedSourceOwnerCalls: string[] = [];
/** The full owned roots shape a continuation carries — shared between the prepare and
 *  continuation mocks so the two cannot drift on which fields a `ResolvedContinuation`
 *  promises its consumer. */
const CAPTURED_SOURCE_ROOTS: WorkflowExecutor.WorkflowSourceRoots = {
  project: '/test/capture/project',
  globalWorkflows: '/test/capture/global/workflows',
  globalCommands: '/test/capture/global/commands',
  globalScripts: '/test/capture/global/scripts',
  bundledWorkflows: '/test/capture/bundled/workflows',
  bundledCommands: '/test/capture/bundled/commands/defaults',
  kind: 'captured',
  anchor: {
    root: '/test/capture',
    digest: 'test-digest',
    config: {
      load_default_workflows: true,
      load_default_commands: true,
    },
  },
};
const mockResolveContinuationWorkflow = mock<typeof WorkflowExecutor.resolveContinuationWorkflow>(
  // Default: the run predates captures, so the caller keeps live discovery — what the
  // resume tests below already assume. Tests that care about the frozen graph override
  // it per invocation.
  () => Promise.resolve(undefined)
);

const mockArtifactsRoot = mkdtempSync(join(tmpdir(), 'archon-cli-container-artifacts-'));
afterAll(async () => {
  await removeTempTree(mockArtifactsRoot);
});

mock.module('@archon/workflows/executor', () => ({
  // Mirrors the real executor's adopt site (#2690): rename happens, then the wrap's
  // `capturedSourceOwner.adopt()` is called. For a continuation (no `preparedSource`)
  // the executor takes the legacy branch and does not adopt, so the wrap reclaims.
  executeWorkflow: mock((...args: unknown[]) => {
    const opts = args[7] as
      | {
          preparedSource?: unknown;
          capturedSourceOwner?: { adopt: () => void };
        }
      | undefined;
    if (opts?.preparedSource) opts.capturedSourceOwner?.adopt();
    return Promise.resolve({ success: true, workflowRunId: 'test-run-id' });
  }),
  hydrateResumableRun: mock(() => Promise.resolve(null)),
  withCapturedSource: mock((body: Parameters<typeof withObservableCapturedSource>[1]) =>
    withObservableCapturedSource(capturedSourceOwnerCalls, body)
  ),
  // Every resume form reaches this now, including `run <name> --resume`. Default: the run
  // predates captures, so the caller keeps live discovery — what the resume tests below
  // already assume. Tests that care about the frozen graph override it per invocation.
  resolveContinuationWorkflow: mockResolveContinuationWorkflow,
  // Source capture is real filesystem work the run path now performs BEFORE discovery.
  // Stubbed so these tests keep exercising flag validation and gating rather than disk.
  prepareWorkflowSource: mock(() =>
    Promise.resolve({
      runId: 'test-run-id',
      origin: '/test/path',
      manifest: {
        version: 1,
        engine_version: 'test',
        origin: '/test/path',
        captured_at: '2026-08-21T00:00:00.000Z',
        digest: 'test-digest',
        file_count: 0,
        byte_count: 0,
        scopes: [],
        source_config: {
          load_default_workflows: true,
          load_default_commands: true,
        },
      },
      anchor: CAPTURED_SOURCE_ROOTS.anchor,
      roots: CAPTURED_SOURCE_ROOTS,
    })
  ),
  recordSelectedWorkflow: mock(() => Promise.resolve()),
  disposeWorkflowSource: mock(() => Promise.resolve()),
  finalizeWorkflowSource: mock((_deps: unknown, prepared: unknown) => Promise.resolve(prepared)),
  // The container dispatch resolves the run's artifacts directory to bind it into the
  // container and creates it on the host first, so hand it a real, reclaimed temp path.
  resolveProjectPaths: mock(() =>
    Promise.resolve({
      artifactsDir: join(mockArtifactsRoot, 'artifacts', 'runs', 'test-run-id'),
      workflowSourceDir: join(mockArtifactsRoot, 'workflow-source', 'runs', 'test-run-id'),
      logDir: join(mockArtifactsRoot, 'logs'),
      artifactsRoot: join(mockArtifactsRoot, 'artifacts'),
      stateDir: join(mockArtifactsRoot, 'state'),
      outputRoot: mockArtifactsRoot,
      identityResolution: 'resolved' as const,
    })
  ),
}));
mock.module('@archon/workflows/dry-run', () => ({
  loadDryRunStubs: mock(() => Promise.resolve({ node: 'stubbed output' })),
  writeDryRunStubScaffold: mock(() => Promise.resolve({ first: 'TODO', second: 'TODO' })),
  dryRunWorkflow: mock(() =>
    Promise.resolve({
      workflow: 'plan',
      outcome: 'completed',
      authoredOutcome: null,
      trace: [
        {
          nodeId: 'node',
          nodeType: 'command',
          state: 'stubbed',
          resolvedText: 'command:test-command',
          output: 'stubbed output',
        },
      ],
      missingStubs: [],
      toleratedMissingStubs: [],
      unusedStubs: [],
      summary: 'stubbed output',
    })
  ),
  formatDryRunTrace: mock(() => 'DRY RUN TRACE'),
}));

// Capture the subscription handler so tests can trigger events
let capturedSubscribeHandler: ((event: WorkflowEmitterEvent) => void) | null = null;
const mockUnsubscribe = mock(() => undefined);

mock.module('@archon/workflows/event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => ({
    subscribeForConversation: mock(
      (_convId: string, handler: (event: WorkflowEmitterEvent) => void) => {
        capturedSubscribeHandler = handler;
        return mockUnsubscribe;
      }
    ),
  })),
}));

class MockCanonicalRepoPathUnavailableError extends Error {
  constructor(
    readonly checkoutPath: string,
    readonly commonGitDir: string
  ) {
    super(`Cannot determine the primary checkout for ${checkoutPath}`);
    this.name = 'CanonicalRepoPathUnavailableError';
  }
}

mock.module('@archon/git', () => ({
  findRepoRoot: mock(() => Promise.resolve(null)),
  getCanonicalRepoPath: mock((path: string) => Promise.resolve(path)),
  getGitCheckoutIdentity: mock((path: string) =>
    Promise.resolve({
      gitDir: `${path}/.git`,
      commonGitDir: `${path}/.git`,
      linkedWorktree: false,
    })
  ),
  CanonicalRepoPathUnavailableError: MockCanonicalRepoPathUnavailableError,
  getRemoteUrl: mock(() => Promise.resolve(null)),
  checkout: mock(() => Promise.resolve()),
  toRepoPath: mock((path: string) => path),
  toWorktreePath: mock((path: string) => path),
  toBranchName: mock((branch: string) => branch),
  getDefaultBranch: mock(() => Promise.resolve('dev')),
  isAncestorOf: mock(() => Promise.resolve(true)),
}));

mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mock(() =>
    Promise.resolve({ id: 'conv-123', platform_type: 'cli', platform_conversation_id: 'cli-123' })
  ),
  getConversationById: mock(() => Promise.resolve(null)),
  updateConversation: mock(() => Promise.resolve()),
}));

mock.module('@archon/core/db/codebases', () => ({
  findCodebaseByDefaultCwd: mock(() => Promise.resolve(null)),
  listCodebases: mock(() => Promise.resolve([])),
  findCodebaseByPathPrefix: mock(() => Promise.resolve(null)),
  getCodebase: mock(() => Promise.resolve(null)),
}));

mock.module('@archon/core/db/isolation-environments', () => ({
  createIsolationStore: mock(() => ({})),
  getById: mock((): Promise<null> => Promise.resolve(null)),
  findActiveByWorkflow: mock(() => Promise.resolve(null)),
  create: mock(() => Promise.resolve({ id: 'iso-123' })),
  // Reached only by the --resume path. mock.module() MERGES over the real
  // module, so omitting this would leave the REAL implementation in place and
  // open a live SQLite handle rather than failing loudly (#2240).
  listByCodebase: mock(() => Promise.resolve([])),
}));

mock.module('@archon/core/db/messages', () => ({
  addMessage: mock(() => Promise.resolve()),
}));

/**
 * The row a `--detach` parent writes before forking (#2872). Only `id` is read by the
 * launch path; the child hands the whole row to `executeWorkflow` as `preCreatedRun`.
 */
const mockCreateWorkflowRun = mock((data: { workflow_name: string; conversation_id: string }) =>
  Promise.resolve({
    id: 'run-detached-created',
    workflow_name: data.workflow_name,
    conversation_id: data.conversation_id,
    status: 'pending',
    working_path: null,
    started_at: new Date(),
    metadata: {},
  })
);

const EMPTY_STATUS_COUNTS = {
  all: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  pending: 0,
  paused: 0,
};
const mockListDashboardRuns = mock(() =>
  Promise.resolve({ runs: [] as unknown[], total: 0, counts: EMPTY_STATUS_COUNTS })
);
function statusRuns(runs: unknown[]): {
  runs: unknown[];
  total: number;
  counts: typeof EMPTY_STATUS_COUNTS;
} {
  return { runs, total: runs.length, counts: EMPTY_STATUS_COUNTS };
}

mock.module('@archon/core/db/workflows', () => ({
  createWorkflowRun: mockCreateWorkflowRun,
  getActiveWorkflowRun: mock(() => Promise.resolve(null)),
  getWorkflowRunStatus: mock(() => Promise.resolve(null)),
  failWorkflowRun: mock(() => Promise.resolve()),
  cancelWorkflowRun: mock(() => Promise.resolve({ cancelled: true })),
  findChildRuns: mock(() => Promise.resolve([])),
  findResumableRun: mock(() => Promise.resolve(null)),
  resumeWorkflowRun: mock(() => Promise.resolve(null)),
  getWorkflowRun: mock(() => Promise.resolve(null)),
  findAdoptingRuns: mock(() => Promise.resolve([])),
  findWorkflowRunsByIdPrefix: mock(() => Promise.resolve([])),
  updateWorkflowRun: mock(() => Promise.resolve()),
  // CAS gate resolvers (#2113) — approve/reject stamp the resolution here;
  // resolveAndCancelApprovalGate atomically resolves+cancels terminal rejects.
  resolveApprovalGate: mock(() => Promise.resolve({ resolved: true })),
  resolveAndCancelApprovalGate: mock(() => Promise.resolve({ resolved: true })),
  listWorkflowRuns: mock(() => Promise.resolve([])),
  listDashboardRuns: mockListDashboardRuns,
  deleteOldWorkflowRuns: mock(() => Promise.resolve({ count: 0 })),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(() => Promise.resolve([])),
  createWorkflowEvent: mock(() => Promise.resolve()),
}));

// Reset-sessions runs the real resetWorkflowNodeSessions operation over this mocked
// DB layer (same pattern as the other workflow commands in this file). Safe from
// mock.module pollution: workflow.test.ts is its own isolated `bun test` invocation.
const mockDeleteNodeSessions = mock(() => Promise.resolve({ deleted: 0 }));
mock.module('@archon/core/db/workflow-node-sessions', () => ({
  deleteWorkflowNodeSessions: mockDeleteNodeSessions,
  getWorkflowNodeSession: mock(() => Promise.resolve(null)),
  upsertWorkflowNodeSession: mock(() => Promise.resolve()),
}));

/**
 * Capture machine-readable (`--json`) payloads.
 *
 * They are emitted through `writeJsonLine()` (src/utils/stdout.ts) — i.e.
 * `process.stdout.write` with a completion callback — rather than `console.log`,
 * so a piped consumer can never receive a truncated document (#2384).
 *
 * This helper only CAPTURES what a command emitted. That the bytes actually
 * survive a real pipe is proven end-to-end in src/utils/stdout.test.ts, which
 * spawns the CLI through a genuine shell pipeline — deliberately not here,
 * because a test that mocks `process.stdout.write` cannot observe the truncation
 * this fix is about.
 */
function spyOnJsonStdout(): ReturnType<typeof spyOn> {
  return spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function');
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  });
}

/** The same delivery-confirming shim for stderr, where progress lines go. */
function spyOnStderr(): ReturnType<typeof spyOn> {
  return spyOn(process.stderr, 'write').mockImplementation((...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function');
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  });
}

/** The first `--json` document a command wrote, trailing newline stripped. */
function firstJsonPayload(spy: ReturnType<typeof spyOn>): string {
  return ((spy.mock.calls[0]?.[0] as string) ?? '').trimEnd();
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    cause => cause
  );
  if (!(error instanceof Error)) throw new Error('Expected command to reject with an Error');
  return error;
}

type DetachedSpawnOptions = Bun.Spawn.SpawnOptions<'ignore', 'pipe', 'inherit'> & {
  cmd: string[];
};

function firstDetachedSpawnOptions(spawnSpy: ReturnType<typeof spyOn>): DetachedSpawnOptions {
  const value: unknown = spawnSpy.mock.calls[0]?.[0];
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected Bun.spawn to receive an options object');
  }

  if (
    !('cmd' in value) ||
    !Array.isArray(value.cmd) ||
    !value.cmd.every((arg: unknown): arg is string => typeof arg === 'string')
  ) {
    throw new Error('Expected Bun.spawn options to include a string command array');
  }
  return value as DetachedSpawnOptions;
}

/**
 * Stand-in for the child `spawnDetachedWorkflowRun` starts. `node:child_process`'s
 * spawn routes through `Bun.spawn` under Bun, so spying on `Bun.spawn` intercepts it
 * and Bun wraps this object into the ChildProcess whose events the startup window
 * listens on. Shared by both detach suites — `run` and the control verbs.
 */
function createDetachedChildFixture(pid: number | null = 12345): {
  child: ReturnType<typeof Bun.spawn>;
  unref: ReturnType<typeof mock>;
} {
  const unref = mock(() => undefined);
  const child = {
    pid: pid ?? undefined,
    unref,
  };

  return {
    child: child as unknown as ReturnType<typeof Bun.spawn>,
    unref,
  };
}

/**
 * Drive a detach command past `waitForDetachedStartup` (#2279). The command awaits a
 * 500 ms window in which a dying child would reject, so a test that never advances
 * the fake timer hangs — and one that never awaits the command silently skips the
 * window altogether. Both suites go through here so neither can pass by accident.
 */
async function finishStartupWindow(
  commandPromise: Promise<void>,
  spawnSpy: ReturnType<typeof spyOn>,
  expectedSpawnCount = 1
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 20 && spawnSpy.mock.calls.length < expectedSpawnCount;
    attempt++
  ) {
    await Promise.resolve();
  }
  expect(spawnSpy).toHaveBeenCalledTimes(expectedSpawnCount);
  jest.advanceTimersByTime(500);
  await commandPromise;
}

describe('workflowListCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('should display message when no workflows found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Discovering workflows'));
    expect(consoleSpy).toHaveBeenCalledWith('\nNo workflows found.');
  });

  it('should list workflows with names and descriptions', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'General assistance workflow' }),
        makeTestWorkflowWithSource({
          name: 'plan',
          description: 'Create implementation plan',
          provider: 'claude',
        }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found 2 workflow(s)'));
    expect(consoleSpy).toHaveBeenCalledWith('  assist');
    expect(consoleSpy).toHaveBeenCalledWith('    General assistance workflow');
    expect(consoleSpy).toHaveBeenCalledWith('  plan');
    expect(consoleSpy).toHaveBeenCalledWith('    Create implementation plan');
    expect(consoleSpy).toHaveBeenCalledWith('    Provider: claude');
  });

  it('should output JSON when json flag is true', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'General assistance workflow' }),
        makeTestWorkflowWithSource({
          name: 'plan',
          description: 'Create implementation plan',
          provider: 'claude',
        }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = firstJsonPayload(stdoutSpy);
    const parsed = JSON.parse(output) as { workflows: unknown[]; errors: unknown[] };
    expect(parsed.workflows).toHaveLength(2);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.workflows[0]).toEqual({
      name: 'assist',
      description: 'General assistance workflow',
      descriptionTruncated: false,
    });
    expect(parsed.workflows[1]).toEqual({
      name: 'plan',
      description: 'Create implementation plan',
      descriptionTruncated: false,
      provider: 'claude',
    });
  });

  it('marks and bounds long descriptions in JSON discovery output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Choose this workflow for focused fixes.\n\n${'Detailed routing constraints. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'fix', description })],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{ description: string; descriptionTruncated: boolean }>;
    };
    expect(parsed.workflows[0]).toMatchObject({
      description: 'Choose this workflow for focused fixes.',
      descriptionTruncated: true,
    });
    expect(parsed.workflows[0].description).not.toContain('Detailed routing constraints');
  });

  it('preserves short descriptions byte-for-byte', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = 'Keep this short description\n\nexactly as authored.';
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'short', description })],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{ description: string; descriptionTruncated: boolean }>;
    };
    expect(parsed.workflows[0].description).toBe(description);
    expect(parsed.workflows[0].descriptionTruncated).toBe(false);
  });

  it('does not infer JSON truncation state from authored description text', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = 'Use when the authored label ends in [truncated]';
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'literal-marker', description })],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{ description: string; descriptionTruncated: boolean }>;
    };
    expect(parsed.workflows[0]).toMatchObject({
      description,
      descriptionTruncated: false,
    });
  });

  it('uses the same bounded preview in human-readable output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Choose this workflow for focused fixes.\n\n${'Detailed routing constraints. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'fix', description })],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(
      '    Choose this workflow for focused fixes. [truncated]'
    );
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('Detailed routing constraints');
  });

  it('caps fallback previews at Unicode code-point and word boundaries', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const emojiPrefix = '🙂'.repeat(150);
    const description = `${emojiPrefix} boundaryword continues without punctuation`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'unicode', description })],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{ description: string; descriptionTruncated: boolean }>;
    };
    expect(parsed.workflows[0].description).toBe(emojiPrefix);
    expect(parsed.workflows[0].descriptionTruncated).toBe(true);
    expect(parsed.workflows[0].description).not.toContain('\uFFFD');
    expect(Array.from(parsed.workflows[0].description)).toHaveLength(150);
  });

  it('returns untouched descriptions for the full catalog', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Choose this workflow first.\n\n${'Keep every detail. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'long', description }),
        makeTestWorkflowWithSource({ name: 'short', description: 'Short description' }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true, full: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: Array<{
        name: string;
        description: string;
        descriptionTruncated: boolean;
      }>;
    };
    expect(parsed.workflows).toEqual([
      { name: 'long', description, descriptionTruncated: false },
      { name: 'short', description: 'Short description', descriptionTruncated: false },
    ]);
  });

  it('prints only the selected workflow untouched in human full-detail output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Choose this workflow first.\n\n${'Keep every detail. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'selected', description }),
        makeTestWorkflowWithSource({ name: 'other', description: 'Other workflow' }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { name: 'selected', full: true });

    expect(consoleSpy).toHaveBeenCalledWith('  selected');
    expect(consoleSpy).toHaveBeenCalledWith(`    ${description}`);
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('other');
    expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain(' [truncated]');
  });

  it('filters by workflow name while preserving metadata, warnings, and discovery errors', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const description = `Complete workflow description.\n\n${'Detailed constraint. '.repeat(20)}`;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist' }),
        makeTestWorkflowWithSource(
          {
            name: 'archon-plan',
            description,
            provider: 'codex',
            model: 'gpt-5.6-sol',
            effort: 'high',
            webSearchMode: 'live',
          },
          'project',
          ["Node 'plan': unknown key 'interactive' will be ignored."]
        ),
      ],
      errors: [{ filename: 'bad.yaml', error: 'Invalid YAML', errorType: 'parse_error' }],
    });

    await workflowListCommand('/test/path', { json: true, name: 'archon-plan', full: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: unknown[];
      errors: unknown[];
    };
    expect(parsed.workflows).toEqual([
      {
        name: 'archon-plan',
        description,
        descriptionTruncated: false,
        provider: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        webSearchMode: 'live',
        parseWarnings: ["Node 'plan': unknown key 'interactive' will be ignored."],
      },
    ]);
    expect(parsed.errors).toEqual([
      { filename: 'bad.yaml', error: 'Invalid YAML', errorType: 'parse_error' },
    ]);
  });

  it('fails when a requested workflow name is missing', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-assist' }),
        makeTestWorkflowWithSource({ name: 'archon-plan' }),
      ],
      errors: [],
    });

    await expect(workflowListCommand('/test/path', { name: 'missing' })).rejects.toThrow(
      "Workflow 'missing' not found.\n\nAvailable workflows:\n  - archon-assist\n  - archon-plan"
    );
  });

  it('carries discovery errors when a requested workflow name is missing', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const loadError = {
      filename: 'bad.yaml',
      error: 'Invalid YAML',
      errorType: 'parse_error' as const,
    };
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'archon-plan' })],
      errors: [loadError],
    });

    const error = await captureError(
      workflowListCommand('/test/path', { name: 'missing', json: true })
    );

    expect(error).toMatchObject({ loadErrors: [loadError] });
  });

  it('fails when a requested workflow name is ambiguous', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-review' }),
        makeTestWorkflowWithSource({ name: 'custom-review' }),
      ],
      errors: [],
    });

    await expect(workflowListCommand('/test/path', { name: 'review' })).rejects.toThrow(
      "Ambiguous workflow 'review'"
    );
  });

  it('carries discovery errors when a requested workflow name is ambiguous', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const loadError = {
      filename: 'bad.yaml',
      error: 'Invalid YAML',
      errorType: 'parse_error' as const,
    };
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-review' }),
        makeTestWorkflowWithSource({ name: 'custom-review' }),
      ],
      errors: [loadError],
    });

    const error = await captureError(
      workflowListCommand('/test/path', { name: 'review', json: true })
    );

    expect(error).toMatchObject({ loadErrors: [loadError] });
  });

  it('reduces catalogs dominated by long descriptions by at least 10x', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflows = Array.from({ length: 20 }, (_, index) =>
      makeTestWorkflowWithSource({
        name: `workflow-${String(index).padStart(2, '0')}`,
        description: `Route suitable work here. ${'Detailed routing constraint '.repeat(200)}`,
      })
    );
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>)
      .mockResolvedValueOnce({ workflows, errors: [] })
      .mockResolvedValueOnce({ workflows, errors: [] });

    await workflowListCommand('/test/path', { json: true });
    await workflowListCommand('/test/path', { json: true, full: true });

    const compactBytes = Buffer.byteLength(
      (stdoutSpy.mock.calls[0]?.[0] as string | undefined) ?? '',
      'utf8'
    );
    const fullBytes = Buffer.byteLength(
      (stdoutSpy.mock.calls[1]?.[0] as string | undefined) ?? '',
      'utf8'
    );
    expect(fullBytes / compactBytes).toBeGreaterThanOrEqual(10);
  });

  it('should include errors in JSON output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [{ filename: 'bad.yaml', error: 'Invalid YAML', errorType: 'parse_error' }],
    });

    await workflowListCommand('/test/path', { json: true });

    const output = firstJsonPayload(stdoutSpy);
    const parsed = JSON.parse(output) as {
      workflows: unknown[];
      errors: Array<{ filename: string; error: string; errorType: string }>;
    };
    expect(parsed.workflows).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toEqual({
      filename: 'bad.yaml',
      error: 'Invalid YAML',
      errorType: 'parse_error',
    });
  });

  it('should not print header text in JSON mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    // Exactly one JSON document written, and no "Discovering workflows" header
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = firstJsonPayload(stdoutSpy);
    expect(output).not.toContain('Discovering workflows');
    // Output must be valid JSON
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('should include effort and webSearchMode in JSON output when present', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'plan',
          description: 'Planning workflow',
          provider: 'codex',
          model: 'gpt-5.6-sol',
          // #2556: `effort:` is the one spelling. The deprecated field is
          // translated into it at load, so it can never reach this surface.
          effort: 'xhigh',
          webSearchMode: 'live',
        }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const output = firstJsonPayload(stdoutSpy);
    const parsed = JSON.parse(output) as {
      workflows: Array<Record<string, string | boolean>>;
      errors: unknown[];
    };
    expect(parsed.workflows[0]).toEqual({
      name: 'plan',
      description: 'Planning workflow',
      descriptionTruncated: false,
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      webSearchMode: 'live',
    });
  });

  it('should produce text output when json flag is false', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'General assistance' }),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: false });

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Discovering workflows'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 workflow(s)'));
  });

  it('calls discoverWorkflowsWithConfig with (cwd, loadConfig) — home scope is internal', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await workflowListCommand('/test/path');

    // After the globalSearchPath refactor, discovery reads ~/.archon/workflows/
    // on every call with no option — every caller inherits home-scope for free.
    expect(discoverWorkflowsWithConfig).toHaveBeenCalledWith('/test/path', expect.any(Function));
  });

  it('should throw error when discoverWorkflows fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Permission denied')
    );

    await expect(workflowListCommand('/test/path')).rejects.toThrow(
      'Error loading workflows: Permission denied'
    );
  });

  // #2213 — a key the engine drops has to reach the author on the surface they
  // use, not only in `archon validate workflows` (which nothing requires them
  // to run).
  it('prints parse warnings inline with the workflow that raised them', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'clean' }, 'project'),
        makeTestWorkflowWithSource({ name: 'gated' }, 'project', [
          "Node 'plan': unknown key 'interactive' will be ignored.",
        ]),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path');

    expect(consoleSpy).toHaveBeenCalledWith(
      "    Warning: Node 'plan': unknown key 'interactive' will be ignored."
    );
  });

  it('carries parse warnings in --json output', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'clean' }, 'project'),
        makeTestWorkflowWithSource({ name: 'gated' }, 'project', ["dropped 'interactive'"]),
      ],
      errors: [],
    });

    await workflowListCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      workflows: { name: string; parseWarnings?: string[] }[];
    };
    // Absent (not an empty array) on a clean workflow, so the field's presence
    // alone is the signal.
    expect(parsed.workflows[0].parseWarnings).toBeUndefined();
    expect(parsed.workflows[1].parseWarnings).toEqual(["dropped 'interactive'"]);
  });
});

describe('workflowRunCommand — dry-run', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    stdoutSpy = spyOnJsonStdout();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const dryRun = await import('@archon/workflows/dry-run');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (dryRun.loadDryRunStubs as ReturnType<typeof mock>).mockClear();
    (dryRun.writeDryRunStubScaffold as ReturnType<typeof mock>).mockClear();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();
    (dryRun.formatDryRunTrace as ReturnType<typeof mock>).mockClear();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValue({
      workflow: 'plan',
      outcome: 'completed',
      authoredOutcome: null,
      trace: [],
      missingStubs: [],
      toleratedMissingStubs: [],
      unusedStubs: [],
      summary: 'done',
    });
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('runs the simulator before real-run setup and writes one JSON document', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const dryRun = await import('@archon/workflows/dry-run');

    await workflowRunCommand('/test/path', 'plan', 'hello', {
      dryRun: true,
      stubsPath: 'fixtures.yaml',
      defaultStubs: true,
      execCode: true,
      pauseAtGates: true,
      json: true,
    });

    expect(dryRun.loadDryRunStubs).toHaveBeenCalledWith(join('/test/path', 'fixtures.yaml'));
    expect(dryRun.dryRunWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: 'hello',
        cwd: '/test/path',
        defaultStubs: true,
        execCode: true,
        pauseAtGates: true,
      })
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      workflow: 'plan',
      outcome: 'completed',
    });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('emits authored outcome in JSON without using it as the exit verdict', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'completed',
      authoredOutcome: 'failed',
      trace: [],
      missingStubs: [],
      toleratedMissingStubs: [],
      unusedStubs: [],
    });

    await expect(
      workflowRunCommand('/test/path', 'plan', '', { dryRun: true, json: true })
    ).resolves.toBeUndefined();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      outcome: 'completed',
      authoredOutcome: 'failed',
    });
  });

  it('layers acting-user preferences before resolving dry-run model bindings', async () => {
    const previousUserId = process.env.ARCHON_USER_ID;
    process.env.ARCHON_USER_ID = 'dry-run-user';
    try {
      const core = await import('@archon/core');
      const dryRun = await import('@archon/workflows/dry-run');
      (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude',
        tiers: {},
        aliases: {},
      });
      (core.getUserAiPrefs as ReturnType<typeof mock>).mockResolvedValueOnce({
        defaultProvider: 'codex',
        aliases: {
          '@personal': { provider: 'claude', model: 'opus' },
          '@planner': { provider: 'pi', model: 'openai/gpt-5.6' },
        },
      });

      await workflowRunCommand('/test/path', 'plan', 'hello', {
        dryRun: true,
        modelAssignments: ['large=@personal', '@planner=openai/next-model'],
      });

      const options = (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
        aiProfile: {
          defaultProvider: string;
          aliases: Record<string, { provider: string; model: string }>;
        };
      };
      expect(options.aiProfile.defaultProvider).toBe('codex');
      expect(options.aiProfile.aliases.large).toEqual({ provider: 'claude', model: 'opus' });
      expect(options.aiProfile.aliases['@planner']).toEqual({
        provider: 'pi',
        model: 'openai/next-model',
      });
    } finally {
      if (previousUserId === undefined) Reflect.deleteProperty(process.env, 'ARCHON_USER_ID');
      else process.env.ARCHON_USER_ID = previousUserId;
    }
  });

  it('applies the config file and then replaces only the explicit model binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-cli-dry-run-config-'));
    const configPath = join(dir, 'config.minimax.yaml');
    appendFileSync(
      configPath,
      'tiers:\n  large: { provider: pi, model: minimax/MiniMax-M3 }\nenv:\n  BENCH_MODE: "1"\n'
    );
    try {
      const core = await import('@archon/core');
      const dryRun = await import('@archon/workflows/dry-run');
      (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        assistant: 'claude',
        assistants: { claude: {}, pi: {} },
        tiers: {
          small: { provider: 'claude', model: 'haiku' },
          medium: { provider: 'claude', model: 'sonnet' },
          large: { provider: 'claude', model: 'opus' },
        },
        aliases: {},
        envVars: { LOWER: 'kept' },
        commands: {},
      });

      await workflowRunCommand('/test/path', 'plan', 'hello', {
        dryRun: true,
        configPath,
        modelAssignments: ['large=openai/gpt-5.6'],
      });

      const options = (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mock.calls[0]?.[0] as {
        config: { envVars?: Record<string, string> };
        aiProfile: {
          aliases: Record<string, { provider: string; model: string }>;
        };
      };
      expect(options.config.envVars).toEqual({ LOWER: 'kept', BENCH_MODE: '1' });
      expect(options.aiProfile.aliases.large).toEqual({
        provider: 'pi',
        model: 'openai/gpt-5.6',
      });
      expect(options.aiProfile.aliases.small).toEqual({
        provider: 'claude',
        model: 'haiku',
      });
      expect(options.aiProfile.aliases.medium).toEqual({
        provider: 'claude',
        model: 'sonnet',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a scaffold from the discovered workflow and exits before simulation', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const dryRun = await import('@archon/workflows/dry-run');

    await workflowRunCommand('/test/path', 'plan', '', {
      dryRun: true,
      stubsInitPath: 'fixtures/generated.yaml',
      json: true,
    });

    expect(dryRun.writeDryRunStubScaffold).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'plan' }),
      join('/test/path', 'fixtures/generated.yaml')
    );
    expect(dryRun.loadDryRunStubs).not.toHaveBeenCalled();
    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      workflow: 'plan',
      stubsPath: join('/test/path', 'fixtures/generated.yaml'),
      nodeCount: 2,
    });
  });

  it('writes the human trace through guaranteed stdout delivery', async () => {
    const dryRun = await import('@archon/workflows/dry-run');

    await workflowRunCommand('/test/path', 'plan', '', { dryRun: true });

    expect(dryRun.formatDryRunTrace).toHaveBeenCalled();
    expect(firstJsonPayload(stdoutSpy)).toBe('DRY RUN TRACE');
  });

  it('fails the dry run when the config is unreadable instead of reporting against defaults', async () => {
    // `loadConfig` returns defaults when there is no config file, so a throw means a
    // MALFORMED one. Swallowing it would print a clean-looking trace claiming every node
    // resolves to the default assistant — a plausible report of a run that cannot happen.
    const dryRun = await import('@archon/workflows/dry-run');
    const core = await import('@archon/core');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();
    (core.loadConfig as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('bad yaml at .archon/config.yaml:7')
    );

    await expect(workflowRunCommand('/test/path', 'plan', 'go', { dryRun: true })).rejects.toThrow(
      /bad yaml/
    );

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('rejects dry-run-only and incompatible lifecycle flags', async () => {
    await expect(
      workflowRunCommand('/test/path', 'plan', '', { stubsPath: 'fixtures.yaml' })
    ).rejects.toThrow('--stubs requires --dry-run');

    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand('/test/path', 'plan', '', { stubsInitPath: 'fixtures.yaml' })
    ).rejects.toThrow('--stubs-init requires --dry-run');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand('/test/path', 'plan', '', { defaultStubs: true })
    ).rejects.toThrow('--default-stubs requires --dry-run');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand('/test/path', 'plan', '', { dryRun: true, detach: true })
    ).rejects.toThrow('--dry-run cannot be combined with --detach');
  });

  it('rejects scaffold mode combined with simulation stub options', async () => {
    await expect(
      workflowRunCommand('/test/path', 'plan', '', {
        dryRun: true,
        stubsInitPath: 'generated.yaml',
        stubsPath: 'overrides.yaml',
      })
    ).rejects.toThrow('--stubs-init cannot be combined with --stubs');

    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
    await expect(
      workflowRunCommand('/test/path', 'plan', '', {
        dryRun: true,
        stubsInitPath: 'generated.yaml',
        defaultStubs: true,
      })
    ).rejects.toThrow('--stubs-init cannot be combined with --default-stubs');
  });

  it('emits failure JSON before returning a nonzero-worthy error', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'failed',
      authoredOutcome: 'succeeded',
      trace: [],
      missingStubs: ['node'],
      toleratedMissingStubs: [],
      unusedStubs: [],
    });

    await expect(
      workflowRunCommand('/test/path', 'plan', '', { dryRun: true, json: true })
    ).rejects.toThrow('missing stubs: node');
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      outcome: 'failed',
      authoredOutcome: 'succeeded',
    });
  });

  it('names only blocking missing stubs, never one an all_done join tolerated', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'failed',
      trace: [],
      missingStubs: ['join', 'node'],
      toleratedMissingStubs: ['join'],
      unusedStubs: [],
    });

    // The join never blocked anything, so pointing the reader at it alongside the
    // real cause sends them to the wrong node (#2869). One call, one mocked result:
    // asserting the absence in a second call would read the default mock instead.
    const error = await workflowRunCommand('/test/path', 'plan', '', {
      dryRun: true,
      json: true,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown as Error
    );
    expect(error?.message).toBe('Dry-run failed; missing stubs: node');
  });

  it('falls back to the generic message when every missing stub was tolerated', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflow: 'plan',
      outcome: 'failed',
      trace: [],
      missingStubs: ['join'],
      toleratedMissingStubs: ['join'],
      unusedStubs: [],
    });

    await expect(
      workflowRunCommand('/test/path', 'plan', '', { dryRun: true, json: true })
    ).rejects.toThrow('See the trace for details');
  });
});

describe('workflowRunCommand — requires: [github] gate', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let priorArchonUserId: string | undefined;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    // Deterministic CLI identity (resolveCliUserId reads ARCHON_USER_ID).
    priorArchonUserId = process.env.ARCHON_USER_ID;
    process.env.ARCHON_USER_ID = 'cli-tester';

    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const usersDb = await import('@archon/core/db/users');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockClear();
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockClear();
    (usersDb.findOrCreateUserByPlatformIdentity as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (priorArchonUserId === undefined) delete process.env.ARCHON_USER_ID;
    else process.env.ARCHON_USER_ID = priorArchonUserId;
  });

  it('blocks a requires:[github] workflow before any cost when enabled and not connected', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand('/repo/root', 'ship', 'go', { noWorktree: true })
    ).rejects.toThrow(/connected github identity/i);

    // Hard-blocked before any worktree/AI cost — executeWorkflow never ran.
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('blocks a parent whose requirement came only from a COMPOSED block', async () => {
    // The parent declares no `requires:` of its own — the requirement unions upward from
    // the block during expansion (#1764). Without that union this refusal never happens
    // and the run fails mid-block instead, inside a file the parent cannot inspect.
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const composed = makeTestComposedWorkflow(
      [
        makeTestWorkflow({
          name: 'gh-block',
          requires: ['github'],
          nodes: [{ id: 'work', prompt: 'work' }],
        }),
        makeTestWorkflow({ name: 'composes-gh', nodes: [{ id: 'sub', include: 'gh-block' }] }),
      ],
      'composes-gh'
    );
    // The union is what the gate reads — assert it before relying on it.
    expect(composed.requires).toEqual(['github']);

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [{ workflow: composed, source: 'project' }],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand('/repo/root', 'composes-gh', 'go', { noWorktree: true })
    ).rejects.toThrow(/connected github identity/i);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('allows the run when the acting CLI user has a connected GitHub identity', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (getDecryptedAccessToken as ReturnType<typeof mock>).mockResolvedValueOnce('gho_token');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand('/repo/root', 'ship', 'go', { noWorktree: true });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on solo installs (per-user GitHub disabled) even when github is required', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    // Default mock returns false; be explicit for readability.
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(false);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand('/repo/root', 'ship', 'go', { noWorktree: true });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // Gate short-circuited on the env check — no token lookup happened.
    expect(getDecryptedAccessToken).not.toHaveBeenCalled();
  });

  it('does not resolve GitHub connection for a workflow without requires', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });
    // Even with per-user GitHub enabled, a workflow with no `requires` skips the lookup.
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand('/repo/root', 'assist', 'go', { noWorktree: true });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    expect(getDecryptedAccessToken).not.toHaveBeenCalled();
  });

  it('fails closed when the acting CLI user identity cannot be resolved', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled, getDecryptedAccessToken } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);

    // No resolvable CLI identity → resolveCliUserId() returns null → treated as
    // "not connected" (fail closed). Clear every identity source for this test.
    const savedUser = process.env.USER;
    const savedUsername = process.env.USERNAME;
    delete process.env.ARCHON_USER_ID;
    delete process.env.USER;
    delete process.env.USERNAME;
    try {
      await expect(
        workflowRunCommand('/repo/root', 'ship', 'go', { noWorktree: true })
      ).rejects.toThrow(/connected github identity/i);
    } finally {
      if (savedUser !== undefined) process.env.USER = savedUser;
      if (savedUsername !== undefined) process.env.USERNAME = savedUsername;
    }

    // Never resolved a token, and never reached execution.
    expect(getDecryptedAccessToken).not.toHaveBeenCalled();
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('fails closed when the identity/token lookup throws', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { isPerUserGitHubEnabled } = await import('@archon/core');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const usersDb = await import('@archon/core/db/users');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'ship', requires: ['github'] }, 'project')],
      errors: [],
    });
    (isPerUserGitHubEnabled as ReturnType<typeof mock>).mockReturnValueOnce(true);
    (usersDb.findOrCreateUserByPlatformIdentity as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('db unavailable')
    );

    // Lookup failure is swallowed inside the gate and defaults to "not connected".
    await expect(
      workflowRunCommand('/repo/root', 'ship', 'go', { noWorktree: true })
    ).rejects.toThrow(/connected github identity/i);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });
});

describe('workflowRunCommand — --input declared inputs (#2554)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  /** Stub discovery with one workflow declaring a required + a defaulted input. */
  async function stubInputWorkflow(): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource(
          {
            name: 'review-block',
            inputs: { diff: { required: true }, style: { default: 'strict' } },
          },
          'project'
        ),
      ],
      errors: [],
    });
  }

  it('runs a required-input workflow when --input supplies the value', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand('/repo/root', 'review-block', 'go', {
      noWorktree: true,
      inputs: ['diff=D1'],
    });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // Only the supplied value is threaded through; `style` stays a derived default.
    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      inputs?: Record<string, string>;
    };
    expect(opts.inputs).toEqual({ diff: 'D1' });
  });

  it('still refuses a required-input workflow when nothing is supplied, before any cost', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();

    await expect(
      workflowRunCommand('/repo/root', 'review-block', 'go', { noWorktree: true })
    ).rejects.toThrow(/requires input 'diff'/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an undeclared --input name before any cost', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();

    await expect(
      workflowRunCommand('/repo/root', 'review-block', 'go', {
        noWorktree: true,
        inputs: ['diff=D1', 'stlye=terse'],
      })
    ).rejects.toThrow(/does not declare input 'stlye'/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('rejects a malformed --input assignment before any cost', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubInputWorkflow();

    await expect(
      workflowRunCommand('/repo/root', 'review-block', 'go', {
        noWorktree: true,
        inputs: ['diff'],
      })
    ).rejects.toThrow(/expected 'name=value'/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('passes gate-resolved inputs to dryRunWorkflow (#2610)', async () => {
    // Only the SUPPLIED entries travel: the simulator derives declared defaults
    // itself, mirroring the executor's `defaultRunInputs` merge at run start.
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand('/repo/root', 'review-block', 'go', {
      dryRun: true,
      inputs: ['diff=D1'],
    });

    expect(dryRun.dryRunWorkflow).toHaveBeenCalledTimes(1);
    const opts = (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mock.calls[0][0] as {
      inputs?: Record<string, string>;
    };
    expect(opts.inputs).toEqual({ diff: 'D1' });
  });

  it('fails a dry run of a required-input workflow at the gate, like a real run', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand('/repo/root', 'review-block', 'go', { dryRun: true })
    ).rejects.toThrow(/requires input 'diff'/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('reports the incompatible flag, not an input error, for --dry-run --resume --input', async () => {
    // The incompatible-flags check must stay ahead of the input gate: with --input no
    // longer in that list, only ordering keeps the triple reporting the flag conflict.
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand('/repo/root', 'review-block', 'go', {
        dryRun: true,
        resume: true,
        inputs: ['diff=D1'],
      })
    ).rejects.toThrow(/--dry-run cannot be combined with --resume/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an undeclared --input name on a dry run at the gate', async () => {
    const dryRun = await import('@archon/workflows/dry-run');
    await stubInputWorkflow();
    (dryRun.dryRunWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand('/repo/root', 'review-block', 'go', {
        dryRun: true,
        inputs: ['diff=D1', 'stlye=terse'],
      })
    ).rejects.toThrow(/does not declare input 'stlye'/);

    expect(dryRun.dryRunWorkflow).not.toHaveBeenCalled();
  });

  it('does not re-gate a --resume of a required-input workflow', async () => {
    // The gate is deliberately skipped on resume: the run row already carries inputs
    // validated at creation, and a resume supplies nothing. A refactor that hoists
    // `resolveTopLevelInputs` out of the `if (!options.resume)` guard would make every
    // CLI resume of a required-input workflow throw instead — this is what catches it.
    // (The `--input` + `--resume` test below cannot: it fails on the mutual-exclusion
    // check before ever reaching the gate.)
    const { executeWorkflow, hydrateResumableRun } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    await stubInputWorkflow();

    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-prior', workflow_name: 'review-block' },
      priorCompletedNodes: new Map([['node-a', 'done']]),
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-resume',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-resume',
      default_cwd: '/repo/root',
      default_branch: 'develop',
    });
    // working_path null keeps the resume on the caller cwd, skipping the existsSync probe.
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-prior',
      working_path: null,
      workflow_name: 'review-block',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-prior',
    });

    // No --input, and the workflow declares a required one: this must NOT throw.
    await workflowRunCommand('/repo/root', 'review-block', 'go', { resume: true });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
    // The resume branch carries the row's own inputs; it never re-stamps from a flag.
    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      inputs?: Record<string, string>;
    };
    expect(opts.inputs).toBeUndefined();
  });

  it('rejects --input combined with --resume rather than silently ignoring it', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    // Flag validation runs after name resolution (as every other flag check does),
    // so discovery still has to resolve for the conflict to be reached.
    await stubInputWorkflow();

    await expect(
      workflowRunCommand('/repo/root', 'review-block', 'go', {
        resume: true,
        inputs: ['diff=D1'],
      })
    ).rejects.toThrow(/--resume and --input are mutually exclusive/);

    expect(executeWorkflow).not.toHaveBeenCalled();
  });
});

describe('workflowRunCommand — sparse model bindings (#2481)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  async function stubWorkflow(): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'bench' }, 'project')],
      errors: [],
    });
  }

  it('passes one sparse tier and alias map to the executor', async () => {
    const { executeWorkflow } = await import('@archon/workflows/executor');
    await stubWorkflow();
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-models',
    });

    await workflowRunCommand('/repo/root', 'bench', 'go', {
      noWorktree: true,
      modelAssignments: ['large=openai/gpt-5.6', '@planner=codex/gpt-5.6-sol'],
    });

    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      modelOverrideLayer?: unknown;
    };
    expect(opts.modelOverrideLayer).toEqual({
      kind: 'raw',
      overrides: {
        tiers: { large: 'openai/gpt-5.6' },
        aliases: { '@planner': 'codex/gpt-5.6-sol' },
      },
    });
  });

  it('rejects bare and duplicate mappings before execution', async () => {
    const { executeWorkflow, prepareWorkflowSource } = await import('@archon/workflows/executor');
    const prepareCallsBefore = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls.length;
    await expect(
      workflowRunCommand('/repo/root', 'bench', 'go', {
        noWorktree: true,
        modelAssignments: ['openai/gpt-5.6'],
      })
    ).rejects.toThrow(/Expected/);
    expect(executeWorkflow).not.toHaveBeenCalled();
    expect((prepareWorkflowSource as ReturnType<typeof mock>).mock.calls).toHaveLength(
      prepareCallsBefore
    );

    await expect(
      workflowRunCommand('/repo/root', 'bench', 'go', {
        noWorktree: true,
        modelAssignments: ['large=   '],
      })
    ).rejects.toThrow(/Expected/);
    expect((prepareWorkflowSource as ReturnType<typeof mock>).mock.calls).toHaveLength(
      prepareCallsBefore
    );

    await expect(
      workflowRunCommand('/repo/root', 'bench', 'go', {
        noWorktree: true,
        modelAssignments: ['large=x', 'large=y'],
      })
    ).rejects.toThrow(/Duplicate/);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('refuses new model bindings on resume', async () => {
    await stubWorkflow();
    await expect(
      workflowRunCommand('/repo/root', 'bench', 'go', {
        resume: true,
        modelAssignments: ['large=openai/gpt-5.6'],
      })
    ).rejects.toThrow(/--resume and --model/);
  });
});

describe('workflowRunCommand — sparse config file (#2482)', () => {
  let tempRoot: string;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'archon-cli-run-config-'));
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function stubWorkflow(): Promise<void> {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'bench' }, 'project')],
      errors: [],
    });
  }

  it('passes validated file content beside explicit model mappings', async () => {
    const path = join(tempRoot, 'config.minimax.yaml');
    appendFileSync(
      path,
      'tiers:\n  large: { provider: pi, model: minimax/MiniMax-M3 }\nenv:\n  BENCH: "yes"\n'
    );
    await stubWorkflow();
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-config',
    });

    await workflowRunCommand(tempRoot, 'bench', 'go', {
      noWorktree: true,
      configPath: './config.minimax.yaml',
      modelAssignments: ['large=openai/gpt-5.6'],
    });

    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][7] as {
      runConfig?: unknown;
      modelOverrideLayer?: unknown;
    };
    expect(opts.runConfig).toEqual({
      source: { kind: 'cli', label: 'config.minimax.yaml' },
      layer: {
        tiers: { large: { provider: 'pi', model: 'minimax/MiniMax-M3' } },
        envVars: { BENCH: 'yes' },
      },
    });
    expect(opts.modelOverrideLayer).toEqual({
      kind: 'raw',
      overrides: { tiers: { large: 'openai/gpt-5.6' } },
    });
  });

  it('rejects an ineffective key before source capture or execution', async () => {
    const path = join(tempRoot, 'bad.yaml');
    appendFileSync(path, 'commands:\n  folder: custom\n');
    const { executeWorkflow, prepareWorkflowSource } = await import('@archon/workflows/executor');
    const prepareCallsBefore = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls.length;

    await expect(
      workflowRunCommand('/repo/root', 'bench', 'go', { configPath: path })
    ).rejects.toThrow("Run config key 'commands' cannot apply");
    expect((prepareWorkflowSource as ReturnType<typeof mock>).mock.calls).toHaveLength(
      prepareCallsBefore
    );
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  it('refuses config on resume without trying to read the path', async () => {
    await expect(
      workflowRunCommand('/repo/root', 'bench', 'go', {
        resume: true,
        configPath: join(tempRoot, 'does-not-exist.yaml'),
      })
    ).rejects.toThrow(/--resume and --config/);
  });
});

describe('workflowRunCommand — continuation and capture ownership (#2646)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    capturedSourceOwnerCalls.length = 0;
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    mockResolveContinuationWorkflow.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('executes the graph the run froze on `run <name> --resume`, not the one in the checkout', async () => {
    // The name form names its run indirectly, so it used to reach the resumable row only
    // after the graph was already chosen from live discovery — while the executor still
    // fed that graph the frozen commands and scripts. Two vintages in one run, on the one
    // resume form that never carried a run object.
    const { executeWorkflow, hydrateResumableRun } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    const frozen = makeTestResolvedWorkflow({ name: 'review-block', description: 'frozen' });
    // What the checkout holds NOW: same name, edited since the run paused. Set as the
    // standing answer rather than a queued one — a continuation must never consume it, and
    // a queued value nothing consumes leaks into the next test.
    const discoverMock = discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockClear();
    discoverMock.mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'review-block', description: 'edited' })],
      errors: [],
    });
    mockResolveContinuationWorkflow.mockResolvedValueOnce({
      workflow: frozen,
      roots: CAPTURED_SOURCE_ROOTS,
      workflows: [{ workflow: frozen, source: 'project' }],
      errors: [],
    });
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-prior',
      working_path: null,
      workflow_name: 'review-block',
    });
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-prior', workflow_name: 'review-block' },
      priorCompletedNodes: new Map([['node-a', 'done']]),
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-resume',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-resume',
      default_cwd: '/repo/root',
      default_branch: 'develop',
    });
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-prior',
    });

    try {
      await workflowRunCommand('/repo/root', 'review-block', 'go', { resume: true });
    } finally {
      discoverMock.mockResolvedValue({ workflows: [], errors: [] });
    }

    // Live discovery never even runs: the continuation carries the discovery it paid for.
    expect(discoverMock).not.toHaveBeenCalled();
    // The row is resolved before discovery and handed to the shared entry point...
    expect(mockResolveContinuationWorkflow).toHaveBeenCalledTimes(1);
    const continuedRun = mockResolveContinuationWorkflow.mock.calls[0]?.[1] as unknown as {
      id: string;
    };
    expect(continuedRun.id).toBe('run-prior');
    // ...and its answer, not the edited checkout, is what runs.
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls[0][4] as {
      description?: string;
    };
    expect(executed.description).toBe('frozen');
    // A continuation captures nothing: there is nothing new to freeze.
    expect(capturedSourceOwnerCalls).toEqual([]);
  });

  it('hands the capture to the run that starts, and keeps holding it when none does', async () => {
    // The wrapper only protects anything if the run path actually calls its owner. Assert
    // both edges: a dropped `adopt()` deletes a live run's source, and a missing `hold()`
    // strands a full frozen tree under staged-source on every refusal. Under #2690 the
    // run path passes `capturedSourceOwner` through and the (mocked) executor adopts;
    // the implementation override below mirrors that.
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce((...args: unknown[]) => {
      const opts = args[7] as
        | {
            preparedSource?: unknown;
            capturedSourceOwner?: { adopt: () => void };
          }
        | undefined;
      if (opts?.preparedSource) opts.capturedSourceOwner?.adopt();
      return Promise.resolve({ success: true, workflowRunId: 'run-ok' });
    });

    await workflowRunCommand('/repo/root', 'assist', 'go', { noWorktree: true });
    expect(capturedSourceOwnerCalls).toEqual(['hold:/test/capture', 'adopt']);

    capturedSourceOwnerCalls.length = 0;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await expect(
      workflowRunCommand('/repo/root', 'assist', 'go', { noWorktree: true })
    ).rejects.toThrow('No workflows found');
    expect(capturedSourceOwnerCalls).toEqual(['hold:/test/capture', 'reclaim:/test/capture']);
  });

  it('reclaims the finalized container capture when backend preparation fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { finalizeWorkflowSource } = await import('@archon/workflows/executor');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      default_branch: null,
      kind: 'folder',
    });
    (finalizeWorkflowSource as ReturnType<typeof mock>).mockResolvedValueOnce({
      runId: 'test-run-id',
      origin: '/test/path',
      manifest: {
        version: 1,
        engine_version: 'test',
        origin: '/test/path',
        captured_at: '2026-08-21T00:00:00.000Z',
        digest: 'test-digest',
        file_count: 0,
        byte_count: 0,
        scopes: [],
      },
      anchor: {
        root: '/test/finalized/workflow-source',
        digest: 'test-digest',
        config: {
          load_default_workflows: true,
          load_default_commands: true,
        },
      },
      roots: {
        project: '/test/finalized/workflow-source/project',
        globalWorkflows: '/test/finalized/workflow-source/global/workflows',
        globalCommands: '/test/finalized/workflow-source/global/commands',
        globalScripts: '/test/finalized/workflow-source/global/scripts',
        bundledWorkflows: '/test/finalized/workflow-source/bundled/workflows',
        bundledCommands: '/test/finalized/workflow-source/bundled/commands/defaults',
        kind: 'captured',
        anchor: {
          root: '/test/finalized/workflow-source',
          digest: 'test-digest',
          config: {
            load_default_workflows: true,
            load_default_commands: true,
          },
        },
      },
    });
    mockFolderBackendPrepare.mockRejectedValueOnce(new Error('container unavailable'));

    await expect(
      workflowRunCommand('/test/path', 'assist', 'go', { container: true })
    ).rejects.toThrow('container unavailable');

    expect(capturedSourceOwnerCalls).toEqual([
      'hold:/test/capture',
      'hold:/test/finalized/workflow-source',
      'reclaim:/test/finalized/workflow-source',
    ]);
  });

  it('binds the run artifacts directory into the container, created on the host first', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      default_branch: null,
      kind: 'folder',
    });
    const expectedArtifacts = join(mockArtifactsRoot, 'artifacts', 'runs', 'test-run-id');
    // Ownership matters: a bind target Docker creates itself is root-owned on a rootful
    // daemon, so the directory must already exist when prepare() is reached.
    let existedAtPrepare: boolean | undefined;
    mockFolderBackendPrepare.mockImplementationOnce((req?: unknown) => {
      const artifactsMount = (req as { artifactsMount?: string } | undefined)?.artifactsMount;
      existedAtPrepare = artifactsMount !== undefined && existsSync(artifactsMount);
      return Promise.resolve({
        cwd: '/test/path',
        execContext: { kind: 'host' as const },
        envId: 'container-env-1',
        overlayMode: 'volume-copy' as const,
      });
    });

    await workflowRunCommand('/test/path', 'assist', 'go', { container: true });

    expect(mockFolderBackendPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMount: '/test/capture',
        artifactsMount: expectedArtifacts,
      })
    );
    expect(existedAtPrepare).toBe(true);
  });
});

describe('workflowRunCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.info.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw error when no workflows found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [],
    });

    await expect(workflowRunCommand('/test/path', 'assist', 'hello')).rejects.toThrow(
      'No workflows found in .archon/workflows/'
    );
  });

  it('logs effective discovery root and source breakdown for every run', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist' }, 'bundled'),
        makeTestWorkflowWithSource({ name: 'home-helper' }, 'global'),
        makeTestWorkflowWithSource({ name: 'project-flow' }, 'project'),
      ],
      errors: [],
    });

    await workflowRunCommand('/repo/root', 'assist', 'hello', { noWorktree: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      'Discovery: root=/repo/root workflows=3 bundled=1 global=1 project=1'
    );
  });

  it('uses discoveryCwd in the discovery diagnostic when supplied', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    await workflowRunCommand('/tmp/worktree', 'assist', 'hello', {
      noWorktree: true,
      discoveryCwd: '/repo/source',
    });

    // The source is captured from the discovery root; discovery then reads that capture,
    // so the call carries the target cwd plus the capture's roots.
    const executorDiag = await import('@archon/workflows/executor');
    expect(executorDiag.prepareWorkflowSource as ReturnType<typeof mock>).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceRoot: '/repo/source' })
    );
    expect(discoverWorkflowsWithConfig).toHaveBeenCalledWith(
      '/test/path',
      expect.any(Function),
      expect.objectContaining({ project: '/test/capture/project' })
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      'Discovery: root=/repo/source workflows=1 bundled=0 global=0 project=1'
    );
  });

  it('does not print discovery diagnostic in json mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    try {
      await workflowRunCommand('/repo/root', 'assist', 'hello', {
        json: true,
        noWorktree: true,
      });
    } catch {
      // Downstream failure is acceptable; this test only verifies diagnostic suppression.
    }

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Discovery: root='));
  });

  // #2213 — `--json` silences Pino entirely (cli.ts sets the level to 'silent'),
  // so stderr is the only channel left. Note this asserts only the CHANNEL
  // (console.warn, not console.log); the JSON payload itself goes through
  // `writeJsonLine` on the `--detach` branch, covered in the detach describe.
  it('warns on stderr about keys the engine drops, even in json mode', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }, 'project', [
            "Node 'plan': unknown key 'interactive' will be ignored.",
          ]),
        ],
        errors: [],
      });

      try {
        await workflowRunCommand('/repo/root', 'assist', 'hello', {
          json: true,
          noWorktree: true,
        });
      } catch {
        // Downstream failure is acceptable; this test only checks the warning.
      }

      expect(warnSpy).toHaveBeenCalledWith("Warning: 'assist' declares keys the engine ignores:");
      expect(warnSpy).toHaveBeenCalledWith(
        "  - Node 'plan': unknown key 'interactive' will be ignored."
      );
      // Never on stdout — a --json caller must still get a parseable payload.
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('unknown key'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent when the resolved workflow has no parse warnings', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({ name: 'assist' }, 'project'),
          // A DIFFERENT workflow's warnings must not leak into this run.
          makeTestWorkflowWithSource({ name: 'other' }, 'project', ["dropped 'interactive'"]),
        ],
        errors: [],
      });

      await workflowRunCommand('/repo/root', 'assist', 'hello', { noWorktree: true });

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('the engine ignores'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // #2781 — the deprecation notice rides the same stderr channel as the parse
  // warnings above, with the same --json-purity rationale.
  it('warns on stderr about a deprecated workflow', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({
            name: 'assist',
            deprecated: { message: 'Switch to the sdlc pack instead.' },
          }),
        ],
        errors: [],
      });

      try {
        await workflowRunCommand('/repo/root', 'assist', 'hello', { noWorktree: true });
      } catch {
        // Downstream failure is acceptable; this test only checks the notice.
      }

      expect(warnSpy).toHaveBeenCalledWith(
        '⚠️ `assist` is deprecated and will be removed in an upcoming release. ' +
          'Switch to the sdlc pack instead. ' +
          'To keep using this workflow after removal, copy the workflow file into your project ' +
          '`.archon/workflows/` or your global `~/.archon/workflows/`.'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stays silent when the resolved workflow is not deprecated', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
      (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
        errors: [],
      });

      try {
        await workflowRunCommand('/repo/root', 'assist', 'hello', { noWorktree: true });
      } catch {
        // Downstream failure is acceptable; this test only checks silence.
      }

      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('will be removed in an upcoming release')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not print discovery diagnostic in quiet mode', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist' }, 'project')],
      errors: [],
    });

    try {
      await workflowRunCommand('/repo/root', 'assist', 'hello', {
        quiet: true,
        noWorktree: true,
      });
    } catch {
      // Downstream failure is acceptable; this test only verifies diagnostic suppression.
    }

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Discovery: root='));
  });

  it('should throw error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'plan', description: 'Plan' }),
      ],
      errors: [],
    });

    await expect(workflowRunCommand('/test/path', 'nonexistent', 'hello')).rejects.toThrow(
      "Workflow 'nonexistent' not found"
    );
  });

  it('should include available workflows in error when workflow not found', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'plan', description: 'Plan' }),
      ],
      errors: [],
    });

    try {
      await workflowRunCommand('/test/path', 'nonexistent', 'hello');
    } catch (error) {
      const err = error as Error;
      expect(err.message).toContain('Available workflows:');
      expect(err.message).toContain('- assist');
      expect(err.message).toContain('- plan');
    }
  });

  it('should resolve workflow by suffix match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'archon-plan', description: 'Plan' }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });

    // Should resolve successfully — "assist" suffix-matches "archon-assist"
    await workflowRunCommand('/test/path', 'assist', 'hello');

    // Verify suffix matching tier was used
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requested: 'assist', matched: 'archon-assist' }),
      'workflow.resolve_suffix_match'
    );
  });

  it('should resolve workflow by substring match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-smart-pr-review', description: 'Smart review' }),
        makeTestWorkflowWithSource({ name: 'archon-assist', description: 'Help' }),
      ],
      errors: [],
    });

    // "smart" substring-matches only "archon-smart-pr-review"
    // Will fail downstream at executeWorkflow mock, but must NOT throw "not found"
    const error = await workflowRunCommand('/test/path', 'smart', 'hello').catch(
      (e: unknown) => e as Error
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('not found');
    expect((error as Error).message).not.toContain('Did you mean');
  });

  it('should prefer case-insensitive exact match over suffix match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }),
        makeTestWorkflowWithSource({ name: 'archon-assist', description: 'Long' }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });

    // "ASSIST" case-insensitive matches "assist" at tier 2, should not reach suffix tier
    await workflowRunCommand('/test/path', 'ASSIST', 'hello');

    // Verify case-insensitive match was used, not suffix match
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requested: 'ASSIST', matched: 'assist' }),
      'workflow.resolve_case_insensitive_match'
    );
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'workflow.resolve_suffix_match'
    );
  });

  it('should throw ambiguous error for multiple suffix matches', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'archon-review', description: 'Review' }),
        makeTestWorkflowWithSource({ name: 'custom-review', description: 'Custom review' }),
      ],
      errors: [],
    });

    await expect(workflowRunCommand('/test/path', 'review', 'hello')).rejects.toThrow(
      "Ambiguous workflow 'review'. Did you mean:"
    );
  });

  it('should throw ambiguous error for multiple substring matches', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'archon-comprehensive-pr-review',
          description: 'Full review',
        }),
        makeTestWorkflowWithSource({ name: 'archon-smart-pr-review', description: 'Smart review' }),
      ],
      errors: [],
    });

    await expect(workflowRunCommand('/test/path', 'pr-review', 'hello')).rejects.toThrow(
      "Ambiguous workflow 'pr-review'. Did you mean:"
    );
  });

  it('should prefer exact match over suffix match', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Short name' }),
        makeTestWorkflowWithSource({ name: 'archon-assist', description: 'Long name' }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });

    // "assist" exact-matches "assist", should NOT go to suffix matching
    await workflowRunCommand('/test/path', 'assist', 'hello');

    // Should not have logged suffix/substring match — exact match takes priority
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ requested: 'assist' }),
      'workflow_run_suffix_match'
    );
  });

  it('should throw error when database access fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Connection refused')
    );

    await expect(workflowRunCommand('/test/path', 'assist', 'hello')).rejects.toThrow(
      'Failed to access database: Connection refused'
    );
  });

  it('should throw when codebase lookup fails (isolation is default)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );

    await expect(workflowRunCommand('/test/path', 'assist', 'hello')).rejects.toThrow(
      'Cannot create worktree: database lookup failed'
    );
  });

  it('should continue when codebase lookup fails with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // With --no-worktree, DB failure is non-fatal — user explicitly opted out of isolation
    await workflowRunCommand('/test/path', 'assist', 'hello', { noWorktree: true });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/test/path' }),
      'cli.codebase_lookup_failed'
    );
  });

  it('should throw error when workflow execution fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: false,
      error: 'Step failed: assist',
    });

    // Use --no-worktree since no codebase is available (isolation would error)
    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', { noWorktree: true })
    ).rejects.toThrow('Workflow failed: Step failed: assist');
  });

  it('should call generateAndSetTitle with workflow name and user message', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const core = await import('@archon/core');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
      ai_assistant_type: 'claude',
    });
    // Return a codebase so isolation can proceed (default behavior requires isolation)
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });
    (core.generateAndSetTitle as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand('/test/path', 'assist', 'hello world');

    expect(core.generateAndSetTitle).toHaveBeenCalledWith(
      'conv-123',
      'hello world',
      'claude',
      '/test/path',
      'assist',
      {}
    );
  });

  it('uses the workflow provider for title generation', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const core = await import('@archon/core');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'figma-mcp-smoke',
          description: 'Smoke test Figma MCP',
          provider: 'codex',
        }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
      ai_assistant_type: 'claude',
    });
    (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      assistant: 'claude',
      assistants: { codex: { model: 'gpt-5.4' } },
      defaults: {},
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });
    (core.generateAndSetTitle as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand('/test/path', 'figma-mcp-smoke', 'check figma', { noWorktree: true });

    expect(core.generateAndSetTitle).toHaveBeenCalledWith(
      'conv-123',
      'check figma',
      'codex',
      '/test/path',
      'figma-mcp-smoke',
      { model: 'gpt-5.4' }
    );
  });

  it('passes --from as a new task branch start point', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand('/test/path', 'assist', 'hello', {
      branchName: 'test-adapters',
      fromBranch: 'feature/extract-adapters',
    });

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;

    expect(provider?.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'task',
        identifier: 'test-adapters',
        taskBranch: {
          kind: 'new',
          branch: 'test-adapters',
          fromBranch: 'feature/extract-adapters',
        },
      })
    );
  });

  it('throws when --branch is used with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    // Validation throws before codebase lookup — no need to mock findCodebaseByDefaultCwd
    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', {
        branchName: 'test-branch',
        noWorktree: true,
      })
    ).rejects.toThrow('--branch and --no-worktree are mutually exclusive');
  });

  it('throws when --from is used with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    // Validation throws before codebase lookup — no need to mock findCodebaseByDefaultCwd
    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', {
        fromBranch: 'dev',
        noWorktree: true,
      })
    ).rejects.toThrow('--from/--from-branch has no effect with --no-worktree');
  });

  // ── Folder projects ──────────────────────────────────────────────────────
  it('registers a folder project and runs in place with --folder', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const core = await import('@archon/core');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // No codebase found → auto-register as folder (registerFolder mock returns cb-folder)
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const registerSpy = core.registerFolder as ReturnType<typeof mock>;
    const execBefore = executeSpy.mock.calls.length;
    const registerBefore = registerSpy.mock.calls.length;
    executeSpy.mockResolvedValueOnce({ success: true, workflowRunId: 'run-folder' });

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    let printed = '';
    try {
      await workflowRunCommand('/test/path', 'assist', 'do it', { folder: true });
      printed = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
    } finally {
      consoleSpy.mockRestore();
    }

    // registerFolder was invoked for the non-git cwd
    expect(registerSpy.mock.calls.length).toBe(registerBefore + 1);
    // The run executed in place
    expect(executeSpy.mock.calls.length).toBe(execBefore + 1);
    // The in-place notice was printed
    expect(printed).toContain('running in place');
  });

  it('rejects --branch against a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // Registered folder project resolved by the main lookup (Once — never leak
    // the folder kind into sibling tests via a persistent mock).
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', { branchName: 'feature-x' })
    ).rejects.toThrow('Worktree options require a git-repo project');
  });

  it('rejects --base against a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    // A folder project creates no worktree, so --base cannot drive a cut-from —
    // but it WOULD still reach $BASE_BRANCH. Half-applied is worse than rejected.
    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', { baseBranch: 'epic/foo' })
    ).rejects.toThrow('Worktree options require a git-repo project');
  });

  it('rejects --folder --branch synchronously (flag-based, before any DB/registration)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const registerSpy = core.registerFolder as ReturnType<typeof mock>;
    const registerBefore = registerSpy.mock.calls.length;

    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', { folder: true, branchName: 'x' })
    ).rejects.toThrow('Worktree options require a git-repo project');
    // The flag-based guard fires before any registration work.
    expect(registerSpy.mock.calls.length).toBe(registerBefore);
  });

  it('rejects a worktree-pinned workflow against a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'assist',
          description: 'Help',
          worktree: { enabled: true },
        }),
      ],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    await expect(workflowRunCommand('/test/path', 'assist', 'hello', {})).rejects.toThrow(
      'requires a worktree'
    );
  });

  it('creates worktree with auto-generated branch when no --branch given', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');
    const isolationDb = await import('@archon/core/db/isolation-environments');

    // Snapshot call counts before this test (process-global mocks)
    const findActiveCallsBefore = (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mock
      .calls.length;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // No branchName, no noWorktree — should auto-isolate
    await workflowRunCommand('/test/path', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;

    // provider.create should have been called with an auto-generated identifier
    expect(provider?.create).toHaveBeenCalled();
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      identifier: string;
      workflowType: string;
    };
    expect(lastCreateCall.workflowType).toBe('task');
    expect(lastCreateCall.identifier).toMatch(/^assist-\d+$/);

    // findActiveByWorkflow should NOT have been called during this test (no explicit --branch)
    const findActiveCallsAfter = (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mock
      .calls.length;
    expect(findActiveCallsAfter).toBe(findActiveCallsBefore);
  });

  it('skips isolation when --no-worktree flag is set', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    // Snapshot provider.create call count before this test
    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const providerBefore = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsBefore = providerBefore?.create.mock.calls.length ?? 0;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand('/test/path', 'assist', 'hello', { noWorktree: true });

    // provider.create should NOT have been called during this test
    const providerAfter = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsAfter = providerAfter?.create.mock.calls.length ?? 0;
    expect(createCallsAfter).toBe(createCallsBefore);
  });

  // -------------------------------------------------------------------------
  // Stale workspace source-symlink → truthful CLI error
  // -------------------------------------------------------------------------

  it('surfaces auto-registration failures instead of claiming the repo is invalid', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { registerRepository } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce('/test/path');
    (registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error(
        'Source symlink at /home/test/.archon/workspaces/acme/widget/source already points to ' +
          '/home/test/.archon/workspaces/widget, expected /test/path'
      )
    );

    const error = await captureError(workflowRunCommand('/test/path', 'assist', 'hello', {}));

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Cannot create worktree: repository registration failed.');
    expect(error.message).toContain(
      'Remove the stale workspace entry at /home/test/.archon/workspaces/acme/widget and retry'
    );
    expect(error.message).not.toContain('not in a git repository');
  });

  it('surfaces auto-registration failures on --resume instead of claiming the repo is invalid', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { registerRepository } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce('/test/path');
    (registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error(
        'Source symlink at /home/test/.archon/workspaces/acme/widget/source already points to ' +
          '/home/test/.archon/workspaces/widget, expected /test/path'
      )
    );

    const error = await captureError(
      workflowRunCommand('/test/path', 'assist', 'hello', { resume: true })
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Cannot resume: repository registration failed.');
    expect(error.message).toContain(
      'Remove the stale workspace entry at /home/test/.archon/workspaces/acme/widget and retry'
    );
    expect(error.message).not.toContain('Not in a git repository');
  });

  it('falls back to generic workspace hint when registration error has an unrecognized shape', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { registerRepository } = await import('@archon/core');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce('/test/path');
    (registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("EACCES: permission denied, mkdir '/home/test/.archon/workspaces/acme'")
    );

    const error = await captureError(workflowRunCommand('/test/path', 'assist', 'hello', {}));

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Cannot create worktree: repository registration failed.');
    expect(error.message).toContain('EACCES: permission denied');
    // Path-separator-agnostic check: on Windows path.join normalizes to `\`,
    // on POSIX to `/`. Assert the hint prefix + the final segment separately.
    expect(error.message).toContain('Check your Archon workspace registration under');
    expect(error.message).toMatch(/workspaces\b/);
    expect(error.message).not.toContain('Remove the stale workspace entry');
  });

  // -------------------------------------------------------------------------
  // Workflow-level `worktree.enabled` policy
  // -------------------------------------------------------------------------

  it('skips isolation when workflow YAML pins worktree.enabled: false', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const providerBefore = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsBefore = providerBefore?.create.mock.calls.length ?? 0;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // No flags — policy alone should disable isolation
    await workflowRunCommand('/test/path', 'triage', 'go', {});

    const providerAfter = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const createCallsAfter = providerAfter?.create.mock.calls.length ?? 0;
    expect(createCallsAfter).toBe(createCallsBefore);
  });

  it('throws when workflow pins worktree.enabled: false but caller passes --branch', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand('/test/path', 'triage', 'go', { branchName: 'feat-x' })
    ).rejects.toThrow(/worktree\.enabled: false/);
  });

  it('throws when workflow pins worktree.enabled: false but caller passes --from', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand('/test/path', 'triage', 'go', { fromBranch: 'dev' })
    ).rejects.toThrow(/worktree\.enabled: false/);
  });

  it('throws when workflow pins worktree.enabled: false but caller passes --base', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });

    // A live-checkout run cuts no worktree, so --base can only half-apply:
    // it would still move $BASE_BRANCH. Reject it like --from rather than
    // silently retargeting the PR of a run that has no worktree.
    await expect(
      workflowRunCommand('/test/path', 'triage', 'go', { baseBranch: 'epic/foo' })
    ).rejects.toThrow(/worktree\.enabled: false/);
  });

  it('accepts worktree.enabled: false + --no-worktree as redundant (no error)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'triage',
          description: 'Read-only triage',
          worktree: { enabled: false },
        }),
      ],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // Should not throw — redundant, not contradictory
    await workflowRunCommand('/test/path', 'triage', 'go', { noWorktree: true });
  });

  it('throws when workflow pins worktree.enabled: true but caller passes --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({
          name: 'build',
          description: 'Requires a worktree',
          worktree: { enabled: true },
        }),
      ],
      errors: [],
    });

    await expect(
      workflowRunCommand('/test/path', 'build', 'go', { noWorktree: true })
    ).rejects.toThrow(/worktree\.enabled: true/);
  });

  it('throws when isolation cannot be created due to missing codebase', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    // No codebase found
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    // Not in a git repo
    (gitModule.findRepoRoot as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowRunCommand('/test/path', 'assist', 'hello', {})).rejects.toThrow(
      'Cannot create worktree: not in a git repository'
    );
  });

  it('emits warning when reused worktree has mismatched base branch', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(false);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand('/test/path', 'assist', 'hello', { branchName: 'my-feature' });
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("not based on 'dev'"));
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('warns that --base did not change the cut-from when reusing a worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    // Base is valid, so the mismatch warning stays silent and this test asserts
    // only the reuse notice.
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(true);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand('/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
        baseBranch: 'epic/foo',
      });
      // Unlike --from (which is fully ignored on reuse), --base is PARTIALLY
      // applied: the cut-from is already fixed, but $BASE_BRANCH still moves.
      // The wording has to say so, or it trades one silent surprise for another.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('--base epic/foo did not change the cut-from')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('it still applies to the PR target')
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('validates a reused worktree against --base rather than repo config', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(false);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand('/test/path', 'assist', 'hello', {
        branchName: 'my-feature',
        baseBranch: 'epic/foo',
      });
      // Repo config says 'dev'; the dispatch said 'epic/foo'. Checking ancestry
      // against 'dev' would report a mismatch nobody asked about.
      expect(gitModule.isAncestorOf as ReturnType<typeof mock>).toHaveBeenCalledWith(
        '/worktrees/feat',
        'origin/epic/foo'
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("not based on 'epic/foo'")
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('does not emit base branch warning when reused worktree is valid', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      branch_name: 'feature-valid',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    // isAncestorOf returns true by default — no warning expected
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand('/test/path', 'assist', 'hello', { branchName: 'my-feature' });
      const baseBranchWarnCalls = consoleWarnSpy.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('not based on')
      );
      expect(baseBranchWarnCalls).toHaveLength(0);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('uses codebase default_branch for reuse validation instead of git auto-detection', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolationDb = await import('@archon/core/db/isolation-environments');
    const gitModule = await import('@archon/git');

    const getDefaultBranchCallsBefore = (gitModule.getDefaultBranch as ReturnType<typeof mock>).mock
      .calls.length;

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (isolationDb.findActiveByWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'env-1',
      working_path: '/worktrees/feat',
      branch_name: 'feature-old',
      workflow_type: 'task',
      workflow_id: 'my-feature',
    });
    (gitModule.isAncestorOf as ReturnType<typeof mock>).mockResolvedValueOnce(false);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand('/test/path', 'assist', 'hello', { branchName: 'my-feature' });
      // Warning names the codebase default branch, not the auto-detected 'dev'
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("not based on 'develop'")
      );
      // The stored default branch short-circuits git auto-detection entirely
      const getDefaultBranchCallsAfter = (gitModule.getDefaultBranch as ReturnType<typeof mock>)
        .mock.calls.length;
      expect(getDefaultBranchCallsAfter).toBe(getDefaultBranchCallsBefore);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('threads codebase default_branch into provider.create and executeWorkflow opts', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // No branchName, no noWorktree — auto-isolates via provider.create
    await workflowRunCommand('/test/path', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      baseBranch?: string;
    };
    expect(lastCreateCall.baseBranch).toBe('develop');

    // executeWorkflow opts (trailing arg) carry the same fallback for $BASE_BRANCH
    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as { baseBranch?: string };
    expect(opts.baseBranch).toBe('develop');
  });

  it('rejects --base combined with --no-worktree', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });

    await expect(
      workflowRunCommand('/test/path', 'assist', 'go', { noWorktree: true, baseBranch: 'epic/foo' })
    ).rejects.toThrow(/--base has no effect with --no-worktree/i);
  });

  it('threads --base override into provider.create (baseOverride) and executeWorkflow opts (PR target)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    // --base epic/foo dispatched via the baseBranch option (from the CLI flag)
    await workflowRunCommand('/test/path', 'assist', 'hello', { baseBranch: 'epic/foo' });

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      baseBranch?: string;
      baseOverride?: string;
    };
    // Flag flows as the override (wins over config + codebase default in the
    // provider); codebase default stays in the request as the fallback.
    expect(lastCreateCall.baseOverride).toBe('epic/foo');
    expect(lastCreateCall.baseBranch).toBe('develop');

    // PR target / $BASE_BRANCH: the flag rides its own `baseOverride` channel so
    // it outranks `worktree.baseBranch` inside executeWorkflow. `baseBranch`
    // keeps carrying the codebase default as the fallback — the same split the
    // provider request uses above. Asserting the flag in `baseBranch` here would
    // pass while $BASE_BRANCH still resolved to repo config (see the
    // 'prefers baseOverride over repo config baseBranch' test in
    // packages/workflows/src/executor.test.ts, which covers the resolution).
    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as {
      baseBranch?: string;
      baseOverride?: string;
    };
    expect(opts.baseOverride).toBe('epic/foo');
    expect(opts.baseBranch).toBe('develop');
  });

  it('warns that --base did not change the cut-from when resuming a run', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow, hydrateResumableRun } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // A null hydration aborts the resume before executeWorkflow, so the run must
    // carry prior state for this path to reach the dispatch.
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-prior', workflow_name: 'assist' },
      priorCompletedNodes: new Map([['node-a', 'done']]),
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    // working_path null keeps the resume on the caller cwd, skipping the
    // existsSync probe (fs is deliberately not mocked in this suite).
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-prior',
      working_path: null,
      workflow_name: 'assist',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await workflowRunCommand('/test/path', 'assist', 'hello', {
        resume: true,
        baseBranch: 'epic/foo',
      });
      // --resume adopts the prior run's worktree, so its cut-from is as fixed as
      // it is on --branch reuse -- but flagBase still reaches executeWorkflow as
      // baseOverride and moves $BASE_BRANCH. Same half-applied shape, same
      // warning.
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('--base epic/foo did not change the cut-from')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('it still applies to the PR target')
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it('lets --from win the cut-from while --base still drives the PR target', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: 'develop',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand('/test/path', 'assist', 'hello', {
      fromBranch: 'origin/release/2.0',
      baseBranch: 'dev',
    });

    // INTENTIONAL, not an oversight: --base sets both halves of "base" by
    // default, and --from is the lever that decouples them. Combining them is
    // how you express "branch from release/2.0, but open the PR against dev" —
    // the one case a single flag cannot say. Making one flag win outright would
    // delete that capability, so this pairing is deliberately left unguarded.
    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      taskBranch?: { kind: string; fromBranch?: string };
      baseOverride?: string;
    };
    expect(lastCreateCall.taskBranch).toEqual({
      kind: 'new',
      fromBranch: 'origin/release/2.0',
    });
    expect(lastCreateCall.baseOverride).toBe('dev');

    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as { baseOverride?: string };
    expect(opts.baseOverride).toBe('dev');
  });

  it('threads codebase name into provider.create so single-segment checkout paths resolve', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    // Single-segment checkout path — the stored owner/repo name must reach the
    // provider so worktrees use the registered identity instead of the
    // _local/<basename> path fallback (#2022, #2227).
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      name: 'owner/repo',
      default_cwd: '/workspace',
      default_branch: 'main',
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand('/workspace', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      codebaseName?: string;
    };
    expect(lastCreateCall.codebaseName).toBe('owner/repo');
  });

  it('omits baseBranch when the codebase has no stored default_branch', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const isolation = await import('@archon/isolation');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-123',
      default_cwd: '/test/path',
      default_branch: null,
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-123',
    });

    await workflowRunCommand('/test/path', 'assist', 'hello', {});

    const getIsolationProviderMock = isolation.getIsolationProvider as ReturnType<typeof mock>;
    const provider = getIsolationProviderMock.mock.results.at(-1)?.value as
      | { create: ReturnType<typeof mock> }
      | undefined;
    const lastCreateCall = provider?.create.mock.calls.at(-1)?.[0] as {
      baseBranch?: string;
    };
    expect(lastCreateCall.baseBranch).toBeUndefined();

    const executeSpy = executeWorkflow as ReturnType<typeof mock>;
    const lastExecuteArgs = executeSpy.mock.calls.at(-1) as unknown[];
    const opts = lastExecuteArgs[lastExecuteArgs.length - 1] as { baseBranch?: string };
    expect(opts.baseBranch).toBeUndefined();
  });

  it('sends dispatch message before executeWorkflow with correct metadata', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const messagesDb = await import('@archon/core/db/messages');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    // Track call order for assistant messages only (user message is added first via addMessage directly)
    const callOrder: string[] = [];
    (messagesDb.addMessage as ReturnType<typeof mock>).mockImplementation(
      async (_dbId: unknown, role: unknown, content: unknown) => {
        if (role === 'assistant') {
          callOrder.push(`addMessage:${String(content)}`);
        }
      }
    );
    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(async () => {
      callOrder.push('executeWorkflow');
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'assist', 'hello', { noWorktree: true });

    // Dispatch assistant message fires before executeWorkflow
    expect(callOrder[0]).toContain('Dispatching workflow');
    expect(callOrder[1]).toBe('executeWorkflow');

    // Correct metadata shape
    expect(messagesDb.addMessage).toHaveBeenCalledWith(
      expect.any(String),
      'assistant',
      'Dispatching workflow: **assist**',
      expect.objectContaining({
        category: 'workflow_dispatch_status',
        workflowDispatch: expect.objectContaining({
          workflowName: 'assist',
          workerConversationId: expect.stringMatching(/^cli-/),
        }),
      })
    );
  });

  it('sends result card when executeWorkflow returns a summary', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const messagesDb = await import('@archon/core/db/messages');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-42',
      summary: 'All steps completed. Branch pushed.',
    });
    (messagesDb.addMessage as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand('/test/path', 'assist', 'hello', { noWorktree: true });

    expect(messagesDb.addMessage).toHaveBeenCalledWith(
      expect.any(String),
      'assistant',
      'All steps completed. Branch pushed.',
      expect.objectContaining({
        category: 'workflow_result',
        workflowResult: { workflowName: 'assist', runId: 'run-42' },
      })
    );
  });

  it('does not send result card when executeWorkflow has no summary', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const messagesDb = await import('@archon/core/db/messages');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-1',
      // no summary field
    });
    (messagesDb.addMessage as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand('/test/path', 'assist', 'hello', { noWorktree: true });

    // Only dispatch addMessage call, no result card
    const resultCalls = (messagesDb.addMessage as ReturnType<typeof mock>).mock.calls.filter(
      (args: unknown[]) => {
        const meta = args[3] as Record<string, unknown> | undefined;
        return meta?.category === 'workflow_result';
      }
    );
    expect(resultCalls).toHaveLength(0);
  });

  it('does not throw and logs warn when result message DB persist fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const messagesDb = await import('@archon/core/db/messages');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-1',
      summary: 'Done.',
    });
    // addMessage is called three times: user message persist, dispatch, result
    // CLIAdapter internally catches DB errors — it logs 'cli_message_persist_failed' and does not throw.
    // Verify workflowRunCommand does not throw even when the result DB write fails.
    (messagesDb.addMessage as ReturnType<typeof mock>)
      .mockResolvedValueOnce(undefined) // user message persist succeeds
      .mockResolvedValueOnce(undefined) // dispatch succeeds
      .mockRejectedValueOnce(new Error('DB gone')); // result fails (caught inside CLIAdapter)

    // Should not throw — the CLIAdapter swallows the DB error and logs a warn
    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', { noWorktree: true })
    ).resolves.toBeUndefined();

    // CLIAdapter logs 'cli_message_persist_failed' when addMessage throws internally
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'cli_message_persist_failed'
    );
  });

  it('does not throw and continues to executeWorkflow when dispatch sendMessage fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const messagesDb = await import('@archon/core/db/messages');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-1',
    });
    // First addMessage (user message persist) succeeds, second (dispatch) fails
    (messagesDb.addMessage as ReturnType<typeof mock>)
      .mockResolvedValueOnce(undefined) // user message persist succeeds
      .mockRejectedValueOnce(new Error('DB gone')); // dispatch fails (caught inside CLIAdapter)

    // Should not throw — dispatch failure must not block workflow execution
    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', { noWorktree: true })
    ).resolves.toBeUndefined();

    // executeWorkflow was still called despite dispatch failure
    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('does not send result card when workflow is paused even with summary', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const messagesDb = await import('@archon/core/db/messages');

    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-123',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-paused',
      paused: true,
      summary: 'Steps completed so far.',
    });
    (messagesDb.addMessage as ReturnType<typeof mock>).mockClear();

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await workflowRunCommand('/test/path', 'assist', 'hello', { noWorktree: true });

      // Paused guard fires before summary check — no result card despite having a summary
      const resultCalls = (messagesDb.addMessage as ReturnType<typeof mock>).mock.calls.filter(
        (args: unknown[]) => {
          const meta = args[3] as Record<string, unknown> | undefined;
          return meta?.category === 'workflow_result';
        }
      );
      expect(resultCalls).toHaveLength(0);

      // Confirm paused message was printed
      expect(consoleSpy).toHaveBeenCalledWith('\nWorkflow paused — waiting for approval.');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

const VERBOSE_EVENTS_FIXTURE: WorkflowEventRow[] = [
  {
    id: 'event-without-node',
    workflow_run_id: 'run-verbose-json',
    event_type: 'tool_completed',
    step_name: 'ignored-tool',
    step_index: null,
    data: {},
    created_at: '2026-08-03T10:00:00.000Z',
  },
  {
    id: 'zeta-started',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_started',
    step_name: 'zeta',
    step_index: 0,
    data: {},
    created_at: '2026-08-03T10:00:01.000Z',
  },
  {
    id: 'alpha-started',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_started',
    step_name: 'alpha',
    step_index: 1,
    data: {},
    created_at: '2026-08-03T10:00:02.000Z',
  },
  {
    id: 'middle-skipped',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_skipped_prior_success',
    step_name: 'middle',
    step_index: 2,
    data: {},
    created_at: '2026-08-03T10:00:03.000Z',
  },
  {
    id: 'zeta-completed',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_completed',
    step_name: 'zeta',
    step_index: 0,
    data: { node_output: 'x'.repeat(200) },
    created_at: '2026-08-03T10:00:04.000Z',
  },
  {
    id: 'alpha-failed',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_failed',
    step_name: 'alpha',
    step_index: 1,
    data: {},
    created_at: '2026-08-03T10:00:07.000Z',
  },
  {
    id: 'beta-started',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_started',
    step_name: 'beta',
    step_index: 3,
    data: {},
    created_at: '2026-08-03T10:00:08.000Z',
  },
  {
    id: 'orphan-completed',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_completed',
    step_name: 'orphan',
    step_index: 4,
    data: { node_output: 'y'.repeat(201) },
    created_at: '2026-08-03T10:00:09.000Z',
  },
  {
    id: 'plain-skipped',
    workflow_run_id: 'run-verbose-json',
    event_type: 'node_skipped',
    step_name: 'skip-plain',
    step_index: 5,
    data: {},
    created_at: '2026-08-03T10:00:10.000Z',
  },
];

const EXPECTED_VERBOSE_NODES = JSON.parse(
  JSON.stringify(buildNodeSummaries(VERBOSE_EVENTS_FIXTURE))
) as Array<Record<string, unknown>>;

describe('workflowStatusCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockListDashboardRuns.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('scopes active runs to the cwd-resolved codebase', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-project-a',
      name: 'owner/project-a',
      default_cwd: '/workspace/project-a',
    });
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand('/workspace/project-a', { json: true });

    expect(mockListDashboardRuns).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-project-a' })
    );
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(false);
  });

  it('scopes a linked worktree to its registered primary checkout', async () => {
    const git = await import('@archon/git');
    const codebaseDb = await import('@archon/core/db/codebases');
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockResolvedValueOnce(
      '/workspace/project-a'
    );
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'cb-project-a',
        name: 'owner/project-a',
        default_cwd: '/workspace/project-a',
      });
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand('/workspace/project-a-worktree', { json: true });

    expect(git.getCanonicalRepoPath).toHaveBeenCalledWith('/workspace/project-a-worktree');
    expect(codebaseDb.findCodebaseByDefaultCwd).toHaveBeenCalledWith('/workspace/project-a');
    expect(mockListDashboardRuns).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-project-a' })
    );
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(false);
  });

  it('uses install-wide active runs for --all without resolving the cwd', async () => {
    const git = await import('@archon/git');
    const codebaseDb = await import('@archon/core/db/codebases');
    const findSpy = codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>;
    const canonicalSpy = git.getCanonicalRepoPath as ReturnType<typeof mock>;
    findSpy.mockClear();
    canonicalSpy.mockClear();
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand('/workspace/project-a', { all: true, json: true });

    expect(findSpy).not.toHaveBeenCalled();
    expect(canonicalSpy).not.toHaveBeenCalled();
    expect(mockListDashboardRuns).toHaveBeenCalledWith({
      status: ['running', 'paused'],
      limit: 50,
    });
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(false);
  });

  it('flags an unregistered cwd when JSON falls back to install-wide active runs', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand('/workspace/unregistered', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(true);
  });

  it('announces an unregistered-cwd fallback in human output', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand('/workspace/unregistered');

    expect(consoleSpy).toHaveBeenCalledWith('(not a registered project — showing all runs)');
    expect(consoleSpy).toHaveBeenCalledWith('No active workflows.');
  });

  it('fails instead of returning install-wide runs when project lookup fails', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('lookup unavailable')
    );

    const error = await captureError(workflowStatusCommand('/workspace/project-a', { json: true }));

    expect(error.message).toBe('Failed to resolve workflow status project: lookup unavailable');
    expect(mockListDashboardRuns).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('fetches verbose raw events only for runs selected by the project scope', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-project-a',
      name: 'owner/project-a',
      default_cwd: '/workspace/project-a',
    });
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-project-a',
          workflow_name: 'implement',
          working_path: '/workspace/project-a-worktree',
          status: 'running',
          started_at: new Date(),
          active_nodes: [],
        },
      ])
    );
    const eventsSpy = workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>;
    eventsSpy.mockClear();
    eventsSpy.mockResolvedValueOnce([]);

    await workflowStatusCommand('/workspace/project-a', {
      json: true,
      verbose: true,
      rawEvents: true,
    });

    expect(mockListDashboardRuns).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-project-a' })
    );
    expect(eventsSpy).toHaveBeenCalledTimes(1);
    expect(eventsSpy).toHaveBeenCalledWith('run-project-a');
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      scopeFallback: boolean;
      runs: Array<{ id: string; events: unknown[] }>;
    };
    expect(parsed.scopeFallback).toBe(false);
    expect(parsed.runs).toEqual([expect.objectContaining({ id: 'run-project-a', events: [] })]);
  });

  it('should print message when no active runs', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand('/test/path', { all: true });

    expect(consoleSpy).toHaveBeenCalledWith('No active workflows.');
  });

  it('should list active runs with ID, name, path, status, and age', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-abc',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
          active_nodes: ['parallel-a', 'parallel-b'],
        },
      ])
    );

    await workflowStatusCommand('/test/path', { all: true });

    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('run-abc'))).toBe(true);
    expect(calls.some(c => c.includes('implement'))).toBe(true);
    expect(calls.some(c => c.includes('/path/to/worktree'))).toBe(true);
    expect(calls.some(c => c.includes('running'))).toBe(true);
    expect(calls.some(c => c.includes('Active nodes: parallel-a, parallel-b'))).toBe(true);
  });

  it('should label authored outcome separately from active execution status', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-paused',
          workflow_name: 'review',
          working_path: '/path/to/worktree',
          status: 'paused',
          outcome: 'succeeded',
          started_at: new Date(),
          active_nodes: ['parallel-a', 'parallel-b'],
        },
      ])
    );

    await workflowStatusCommand('/test/path', { all: true });

    expect(consoleSpy).toHaveBeenCalledWith('  Status: paused');
    expect(consoleSpy).toHaveBeenCalledWith('  Authored outcome: succeeded');
  });

  it('should output JSON when json=true', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(statusRuns([]));

    await workflowStatusCommand('/test/path', { json: true, all: true });

    expect(stdoutSpy).toHaveBeenCalledWith(
      `${JSON.stringify({ runs: [], scopeFallback: false }, null, 2)}\n`,
      expect.any(Function)
    );
  });

  it('keeps parallel active nodes in non-verbose JSON', async () => {
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-parallel',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(),
          active_nodes: ['parallel-a', 'parallel-b'],
        },
      ])
    );

    await workflowStatusCommand('/test/path', { json: true, all: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      runs: Array<{ active_nodes: string[] }>;
    };
    expect(parsed.runs[0]?.active_nodes).toEqual(['parallel-a', 'parallel-b']);
  });

  it('should show node summaries in verbose mode', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-verbose',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(Date.now() - 30 * 1000),
          active_nodes: ['plan'],
        },
      ])
    );

    const startTime = new Date(Date.now() - 25 * 1000).toISOString();
    const endTime = new Date(Date.now() - 15 * 1000).toISOString();
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'e1',
        workflow_run_id: 'run-verbose',
        event_type: 'node_started',
        step_name: 'plan',
        step_index: null,
        data: {},
        created_at: startTime,
      },
      {
        id: 'e2',
        workflow_run_id: 'run-verbose',
        event_type: 'node_completed',
        step_name: 'plan',
        step_index: null,
        data: { node_output: 'Plan output here' },
        created_at: endTime,
      },
    ]);

    await workflowStatusCommand('/test/path', { verbose: true, all: true });

    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('Nodes:'))).toBe(true);
    expect(calls.some(c => c.includes('✓') && c.includes('plan'))).toBe(true);
    expect(calls.some(c => c.includes('Plan output here'))).toBe(true);
  });

  it('should show error message for failed node in verbose mode', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-failed',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(Date.now() - 30 * 1000),
          active_nodes: ['implement'],
        },
      ])
    );

    const startTime = new Date(Date.now() - 20 * 1000).toISOString();
    const endTime = new Date(Date.now() - 10 * 1000).toISOString();
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'e3',
        workflow_run_id: 'run-failed',
        event_type: 'node_started',
        step_name: 'implement',
        step_index: null,
        data: {},
        created_at: startTime,
      },
      {
        id: 'e4',
        workflow_run_id: 'run-failed',
        event_type: 'node_failed',
        step_name: 'implement',
        step_index: null,
        data: { error: 'Compilation failed' },
        created_at: endTime,
      },
    ]);

    await workflowStatusCommand('/test/path', { verbose: true, all: true });

    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('✗') && c.includes('implement'))).toBe(true);
    expect(calls.some(c => c.includes('Compilation failed'))).toBe(true);
  });

  it('should not show nodes section when no events in verbose mode', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-empty',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(Date.now() - 5 * 1000),
          active_nodes: [],
        },
      ])
    );
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([]);

    await workflowStatusCommand('/test/path', { verbose: true, all: true });

    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('Nodes:'))).toBe(false);
  });

  it('emits the shared ordered node summaries in verbose JSON by default', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-verbose-json',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(),
          active_nodes: ['beta'],
        },
      ])
    );
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce(
      VERBOSE_EVENTS_FIXTURE
    );

    await workflowStatusCommand('/test/path', { json: true, verbose: true, all: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      runs: Array<{ nodes: Array<Record<string, unknown>>; events?: unknown[] }>;
    };
    expect(parsed.runs[0]?.nodes).toEqual(EXPECTED_VERBOSE_NODES);
    expect(parsed.runs[0]?.events).toBeUndefined();
    expect(parsed.runs[0]?.nodes.map(node => node.nodeId)).toEqual([
      'zeta',
      'alpha',
      'middle',
      'beta',
      'orphan',
      'skip-plain',
    ]);

    const [zeta, alpha, middle, beta, orphan] = parsed.runs[0]?.nodes ?? [];
    expect(zeta).toMatchObject({
      state: 'completed',
      startedAt: '2026-08-03T10:00:01.000Z',
      durationMs: 3_000,
      outputPreview: 'x'.repeat(200),
    });
    expect(alpha).toMatchObject({
      state: 'failed',
      startedAt: '2026-08-03T10:00:02.000Z',
      durationMs: 5_000,
      error: 'Unknown error',
    });
    // A prior-success replay reports the success it describes, with no start
    // time to derive a duration from (#2973).
    expect(middle?.state).toBe('completed');
    expect(middle?.startedAt).toBeUndefined();
    expect(middle?.durationMs).toBeUndefined();
    expect(beta).toMatchObject({
      state: 'running',
      startedAt: '2026-08-03T10:00:08.000Z',
    });
    expect(beta?.durationMs).toBeUndefined();
    expect(orphan?.startedAt).toBeUndefined();
    expect(orphan?.durationMs).toBeUndefined();
    expect(orphan?.outputPreview).toBe(`${'y'.repeat(200)}...`);
    expect(String(orphan?.outputPreview)).not.toContain('…');
  });

  it('emits raw events in verbose JSON when events=true', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-verbose-json',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(),
          active_nodes: ['beta'],
        },
      ])
    );
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce(
      VERBOSE_EVENTS_FIXTURE
    );

    await workflowStatusCommand('/test/path', {
      json: true,
      verbose: true,
      rawEvents: true,
      all: true,
    });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      runs: Array<{ events: WorkflowEventRow[]; nodes?: unknown[] }>;
    };
    expect(parsed.runs[0]?.events).toEqual(VERBOSE_EVENTS_FIXTURE);
    expect(parsed.runs[0]?.nodes).toBeUndefined();
  });

  it('degrades a verbose JSON event-query failure to an empty node payload', async () => {
    const workflowEventsDb = await import('@archon/core/db/workflow-events');
    mockListDashboardRuns.mockResolvedValueOnce(
      statusRuns([
        {
          id: 'run-unavailable',
          workflow_name: 'implement',
          working_path: '/path/to/worktree',
          status: 'running',
          started_at: new Date(),
          active_nodes: ['beta'],
        },
      ])
    );
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('events unavailable')
    );

    await workflowStatusCommand('/test/path', { json: true, verbose: true, all: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      runs: Array<{ nodes: unknown[] }>;
    };
    expect(parsed.runs[0]?.nodes).toEqual([]);
  });
});

const EMPTY_COUNTS = {
  all: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  pending: 0,
  paused: 0,
};

describe('workflowGetCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('prints not-found (human) and exits non-zero for a missing run', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand('nope');

    expect(consoleSpy).toHaveBeenCalledWith('Workflow run not found: nope');
    // Exit 1 so `get <id> && ...` and CI checks react to a missing run.
    expect(code).toBe(1);
  });

  it('emits {ok:false, error:not_found} JSON and exits non-zero for a missing run', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand('nope', true);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: false,
      runId: 'nope',
      error: 'not_found',
    });
    expect(code).toBe(1);
  });

  // #2213 — the read path for a run whose warnings were recorded but never
  // delivered to a conversation (CLI/REST runs, or a failed chat send).
  it('surfaces recorded parse warnings in verbose output', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-pw',
      workflow_name: 'gated',
      working_path: '/repo',
      status: 'completed',
      started_at: new Date(),
      metadata: {},
    });
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'e1',
        workflow_run_id: 'run-pw',
        event_type: 'workflow_parse_warnings',
        step_name: null,
        step_index: null,
        data: { workflowName: 'gated', warnings: ["Node 'plan': unknown key 'interactive'"] },
        created_at: new Date().toISOString(),
      },
    ]);

    const code = await workflowGetCommand('run-pw', false, true);

    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('Ignored keys (1)'))).toBe(true);
    expect(calls.some(c => c.includes("unknown key 'interactive'"))).toBe(true);
    expect(code).toBe(0);
  });

  it('carries recorded parse warnings on the verbose --json payload', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowEventsDb = await import('@archon/core/db/workflow-events');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-pw',
      workflow_name: 'gated',
      working_path: '/repo',
      status: 'completed',
      started_at: new Date(),
      metadata: {},
    });
    (workflowEventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        id: 'e1',
        workflow_run_id: 'run-pw',
        event_type: 'workflow_parse_warnings',
        step_name: null,
        step_index: null,
        data: { workflowName: 'gated', warnings: ["Node 'plan': unknown key 'interactive'"] },
        created_at: new Date().toISOString(),
      },
    ]);

    await workflowGetCommand('run-pw', true, true);

    const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as { parseWarnings?: string[] };
    expect(payload.parseWarnings).toEqual(["Node 'plan': unknown key 'interactive'"]);
  });

  it('emits {ok:false} JSON (never throws) when the DB lookup fails', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('connection refused')
    );

    await workflowGetCommand('run-x', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      runId: string;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.runId).toBe('run-x');
    expect(parsed.error).toContain('connection refused');
  });

  it('prints run detail (human) including the error from metadata', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-xyz',
      workflow_name: 'implement',
      status: 'failed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: { error: 'Step failed: build' },
    });

    await workflowGetCommand('run-xyz');

    expect(consoleSpy).toHaveBeenCalledWith('  ID:     run-xyz');
    expect(consoleSpy).toHaveBeenCalledWith('  Name:   implement');
    expect(consoleSpy).toHaveBeenCalledWith('  Status: failed');
    expect(consoleSpy).toHaveBeenCalledWith('  Error:  Step failed: build');
  });

  it('prints contradictory status and authored outcome as separate fields', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-contradictory',
      workflow_name: 'review',
      status: 'completed',
      outcome: 'failed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    await workflowGetCommand('run-contradictory');

    expect(consoleSpy).toHaveBeenCalledWith('  Status: completed');
    expect(consoleSpy).toHaveBeenCalledWith('  Authored outcome: failed');
  });

  it('emits the raw run as a single clean JSON object', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-json',
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    const code = await workflowGetCommand('run-json', true);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      id: string;
      status: string;
    };
    expect(parsed.id).toBe('run-json');
    expect(parsed.status).toBe('completed');
    expect(code).toBe(0);
  });

  it('exposes the transcript path from a trusted persisted output root', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-transcript-home');
    process.env.ARCHON_HOME = archonHome;
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      const outputRoot = join(archonHome, 'workspaces', 'acme', 'widget');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-transcript',
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: outputRoot,
        codebase_id: 'cb-1',
      });

      await workflowGetCommand('run-transcript', true);

      expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
        transcript_path: join(outputRoot, 'logs', 'run-transcript.jsonl'),
      });
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  it('re-derives an out-of-tree historical path through the run codebase', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-relocated-home');
    process.env.ARCHON_HOME = archonHome;
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      const codebaseDb = await import('@archon/core/db/codebases');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-relocated',
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: '/old-machine/.archon/workspaces/old/name',
        codebase_id: 'cb-relocated',
      });
      // Both readers in workflow get consult the codebase row; the resolver
      // re-derives identically on each call against the same id.
      (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValue({
        id: 'cb-relocated',
        kind: 'repo',
        name: 'new/widget',
        default_cwd: '/repos/widget',
      });

      await workflowGetCommand('run-relocated', true);

      expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
        transcript_path: join(
          archonHome,
          'workspaces',
          'new',
          'widget',
          'logs',
          'run-relocated.jsonl'
        ),
      });
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  });

  it('reports an unavailable transcript without failing an otherwise readable legacy run', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-legacy',
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
      output_root: null,
      codebase_id: null,
    });

    const code = await workflowGetCommand('run-legacy', true);

    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({ transcript_path: null });
    expect(code).toBe(0);
  });

  // #3097 — every persisted-root reader in `workflow get` must go through the
  // shared resolver's containment check. The leave-behind artifact list was the
  // last path that still walked `run.output_root` directly. These tests pin
  // both halves of the fix: the resolver is consulted, and the same refusal
  // surface the transcript reader already exposes applies.
  it('refuses to walk an out-of-tree persisted output_root even when the dir exists (#3097)', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-artifact-refused-home');
    const decoyRoot = mkdtempSync(join(tmpdir(), 'archon-get-artifact-decoy-'));
    const decoyArtifactsDir = join(decoyRoot, 'artifacts', 'runs', 'run-artifact-refused');
    mkdirSync(decoyArtifactsDir, { recursive: true });
    writeFileSync(join(decoyArtifactsDir, 'should-not-be-listed.txt'), 'poison');
    process.env.ARCHON_HOME = archonHome;
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: 'run-artifact-refused',
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: decoyRoot,
        codebase_id: null,
      });

      await workflowGetCommand('run-artifact-refused', true);

      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        leave_behind?: { artifactFiles?: string[] };
      };
      expect(parsed.leave_behind).toBeDefined();
      expect(parsed.leave_behind?.artifactFiles).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      await removeTempTree(archonHome);
      await removeTempTree(decoyRoot);
    }
  });

  it('re-derives a relocated leave-behind artifact dir through the run codebase (#3097)', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-artifact-relocated-home');
    process.env.ARCHON_HOME = archonHome;
    const runId = 'run-artifact-relocated';
    const rederivedArtifactsDir = join(
      archonHome,
      'workspaces',
      'new',
      'widget',
      'artifacts',
      'runs',
      runId
    );
    mkdirSync(rederivedArtifactsDir, { recursive: true });
    writeFileSync(join(rederivedArtifactsDir, 'marker.txt'), 'ok');
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      const codebaseDb = await import('@archon/core/db/codebases');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        // Out-of-tree persisted root — the resolver must re-derive under the
        // current ARCHON_HOME via the run's codebase row, not walk the original
        // path.
        output_root: '/old-machine/.archon/workspaces/old/name',
        codebase_id: 'cb-relocated-artifact',
      });
      // Both readers in workflow get consult the codebase row; the resolver
      // re-derives identically on each call against the same id.
      (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValue({
        id: 'cb-relocated-artifact',
        kind: 'repo',
        name: 'new/widget',
        default_cwd: '/repos/widget',
      });

      await workflowGetCommand(runId, true);

      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        leave_behind?: { artifactFiles?: string[] };
      };
      expect(parsed.leave_behind?.artifactFiles).toContain('marker.txt');
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      await removeTempTree(archonHome);
    }
  });

  it('walks the leave-behind artifact dir under a trusted persisted output_root (#3097)', async () => {
    const previousHome = process.env.ARCHON_HOME;
    const archonHome = join(tmpdir(), 'archon-get-artifact-trusted-home');
    process.env.ARCHON_HOME = archonHome;
    const runId = 'run-artifact-trusted';
    const outputRoot = join(archonHome, 'workspaces', 'acme', 'widget');
    const artifactsDir = join(outputRoot, 'artifacts', 'runs', runId);
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, 'note.txt'), 'ok');
    try {
      const workflowDb = await import('@archon/core/db/workflows');
      (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'completed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {},
        output_root: outputRoot,
        codebase_id: 'cb-1',
      });

      await workflowGetCommand(runId, true);

      const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
        leave_behind?: { artifactFiles?: string[] };
      };
      expect(parsed.leave_behind?.artifactFiles).toContain('note.txt');
    } finally {
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      await removeTempTree(archonHome);
    }
  });

  it('emits the full metadata.approval (incl. completionSignaled) in --json for a paused interactive_loop run (#2074 E)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-gate-json',
      workflow_name: 'validate',
      status: 'paused',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          message: 'gate',
          iteration: 2,
          completionSignaled: true,
          signaledOutput: 'REPORT',
        },
      },
    });

    const code = await workflowGetCommand('run-gate-json', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      metadata: { approval: { completionSignaled: boolean; signaledOutput: string } };
    };
    // The agent read surface: the C fields flow through the CLI --json dump unchanged.
    expect(parsed.metadata.approval.completionSignaled).toBe(true);
    expect(parsed.metadata.approval.signaledOutput).toBe('REPORT');
    expect(code).toBe(0);
  });

  it('prints aggregate completion-condition state for a paused interactive_loop run (#2074 E)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-gate-human',
      workflow_name: 'validate',
      status: 'paused',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'refine',
          message: 'gate',
          iteration: 2,
          completionSignaled: true,
          signaledOutput: 'REPORT',
        },
      },
    });

    await workflowGetCommand('run-gate-human');

    expect(consoleSpy).toHaveBeenCalledWith(
      '  Gate:   awaiting approval — completion condition met: yes (iteration 2)'
    );
  });

  it('prints durable wait and scheduled quota continuation state', async (): Promise<void> => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        id: 'run-wait-human',
        workflow_name: 'validate',
        status: 'paused',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {
          wait: {
            owner: 'node',
            nodeId: 'checks',
            kind: 'event',
            event: 'checks.complete',
            waitingSince: '2026-08-24T10:00:00.000Z',
            resumeAt: '2026-08-25T10:00:00.000Z',
          },
        },
      })
      .mockResolvedValueOnce({
        id: 'run-quota-human',
        workflow_name: 'deliver',
        status: 'failed',
        working_path: '/tmp/wt',
        started_at: new Date(),
        metadata: {
          scheduled_resume: {
            reason: 'quota',
            resumeAt: '2026-08-25T11:00:00.000Z',
            deadlineAt: '2026-08-26T10:00:00.000Z',
            attempt: 1,
            maxAttempts: 2,
            error: 'usage limit reached',
          },
        },
      });

    await workflowGetCommand('run-wait-human');
    await workflowGetCommand('run-quota-human');

    expect(consoleSpy).toHaveBeenCalledWith(
      "  Wait:   event 'checks.complete' until 2026-08-25T10:00:00.000Z"
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '  Resume: scheduled for 2026-08-25T11:00:00.000Z (attempt 1/2)'
    );
  });

  it('prints an action-required wait with its explicit resume command', async (): Promise<void> => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-action-human',
      workflow_name: 'deliver',
      status: 'paused',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {
        approval: {
          type: 'interactive_loop',
          nodeId: 'old-gate',
          message: 'Stale approval',
          iteration: 1,
        },
        wait: {
          owner: 'node',
          nodeId: 'rerun-ci',
          kind: 'attention',
          waitingSince: '2026-08-24T10:00:00.000Z',
          message: 'Re-run CI, then resume.',
        },
      },
    });

    await workflowGetCommand('run-action-human');

    expect(consoleSpy).toHaveBeenCalledWith(
      '  Wait:   action required — Re-run CI, then resume. (resume with: archon workflow resume run-action-human)'
    );
    expect(consoleSpy.mock.calls.flat().join(' ')).not.toContain('Gate:');
  });

  it('emits the same shared node summaries in verbose JSON by default', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const eventsDb = await import('@archon/core/db/workflow-events');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-v',
      workflow_name: 'implement',
      status: 'running',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });
    (eventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce(
      VERBOSE_EVENTS_FIXTURE
    );

    await workflowGetCommand('run-v', true, true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      nodes: Array<Record<string, unknown>>;
      events?: unknown[];
      transcript_path?: string | null;
    };
    expect(parsed.nodes).toEqual(EXPECTED_VERBOSE_NODES);
    expect(parsed.nodes.map(node => node.state)).toEqual(
      buildNodeSummaries(VERBOSE_EVENTS_FIXTURE).map(node => node.state)
    );
    expect(parsed.events).toBeUndefined();
    expect(parsed.transcript_path).toBeNull();
  });

  it('emits raw events in verbose JSON when events=true', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const eventsDb = await import('@archon/core/db/workflow-events');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-v',
      workflow_name: 'implement',
      status: 'running',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });
    (eventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockResolvedValueOnce(
      VERBOSE_EVENTS_FIXTURE
    );

    await workflowGetCommand('run-v', true, true, undefined, true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      events: WorkflowEventRow[];
      nodes?: unknown[];
      transcript_path?: string | null;
    };
    expect(parsed.events).toEqual(VERBOSE_EVENTS_FIXTURE);
    expect(parsed.nodes).toBeUndefined();
    expect(parsed.transcript_path).toBeNull();
  });

  it('degrades a raw verbose JSON event-query failure to an empty events payload', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const eventsDb = await import('@archon/core/db/workflow-events');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-v',
      workflow_name: 'implement',
      status: 'running',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });
    (eventsDb.listWorkflowEvents as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('events unavailable')
    );

    await workflowGetCommand('run-v', true, true, undefined, true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { events: unknown[] };
    expect(parsed.events).toEqual([]);
  });
});

describe('workflowLogsCommand', () => {
  let fixtureRoot: string;
  let archonHome: string;
  let projectRoot: string;
  let transcriptPath: string;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let previousHome: string | undefined;

  const run = (status: 'pending' | 'running' | 'paused' | 'completed' | 'failed') => ({
    id: '11111111-2222-3333-4444-555555555555',
    workflow_name: 'transcript-test',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'cb-1',
    status,
    outcome: null,
    user_message: 'test',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/tmp/worktree',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: projectRoot,
  });

  const stdoutText = (): string =>
    stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('');
  const stderrText = (): string =>
    stderrSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('');

  beforeEach(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'archon-workflow-logs-'));
    archonHome = join(fixtureRoot, 'home');
    projectRoot = join(archonHome, 'workspaces', 'acme', 'widget');
    transcriptPath = join(projectRoot, 'logs', '11111111-2222-3333-4444-555555555555.jsonl');
    mkdirSync(join(projectRoot, 'logs'), { recursive: true });
    previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = archonHome;
    stdoutSpy = spyOnJsonStdout();
    stderrSpy = spyOnStderr();

    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(null);
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockReset();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValue([]);
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValue(null);
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockReset();
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (previousHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = previousHome;
    await removeTempTree(fixtureRoot);
  });

  it('prints the exact snapshot and resolves a unique project-scoped prefix', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const row = `${JSON.stringify({ type: 'workflow_start', content: 'hello' })}\n`;
    writeFileSync(transcriptPath, row);
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      kind: 'repo',
      name: 'acme/widget',
      default_cwd: '/repo',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: run('completed').id },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(run('completed'));

    const code = await workflowLogsCommand('11111111', false, '/repo');

    expect(code).toBe(0);
    expect(stdoutText()).toBe(row);
    expect(stderrText()).toBe('');
    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('11111111', 'cb-1');
  });

  it('re-derives a relocated transcript from the run codebase', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const row = `${JSON.stringify({ type: 'workflow_start', content: 'relocated' })}\n`;
    writeFileSync(transcriptPath, row);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...run('completed'),
      output_root: '/previous/archon/home/workspaces/acme/widget',
    });
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      kind: 'repo',
      name: 'acme/widget',
      default_cwd: '/home/u/widget',
    });

    expect(await workflowLogsCommand(run('completed').id, false)).toBe(0);
    expect(stdoutText()).toBe(row);
    expect(stderrText()).toBe('');
  });

  it('preserves UTF-8 characters split across read chunks', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const content = `${'a'.repeat(64 * 1024 - 1)}🙂\n`;
    writeFileSync(transcriptPath, content);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(run('completed'));

    expect(await workflowLogsCommand(run('completed').id, false)).toBe(0);
    expect(stdoutText()).toBe(content);
  });

  it('guides an active snapshot reader to --follow when the file is absent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(run('running'));

    expect(await workflowLogsCommand(run('running').id, false)).toBe(1);
    expect(stdoutText()).toBe('');
    expect(stderrText()).toContain('Use --follow to wait for it');
  });

  it('fails explicitly for missing and empty terminal transcripts', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce(run('failed'))
      .mockResolvedValueOnce(run('completed'));

    expect(await workflowLogsCommand(run('failed').id, false)).toBe(1);
    writeFileSync(transcriptPath, '');
    expect(await workflowLogsCommand(run('completed').id, false)).toBe(1);

    expect(stdoutText()).toBe('');
    expect(stderrText()).toContain('is failed, but its transcript is missing or empty');
    expect(stderrText()).toContain('is completed, but its transcript is missing or empty');
  });

  it('follows paused, running, and completed states and drains after terminal status', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const startRow = `${JSON.stringify({ type: 'workflow_start' })}\n`;
    const terminalRow = `${JSON.stringify({ type: 'workflow_complete' })}\n`;
    writeFileSync(transcriptPath, startRow);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce(run('paused'))
      .mockResolvedValueOnce(run('running'))
      .mockImplementationOnce(() => {
        appendFileSync(transcriptPath, terminalRow);
        return Promise.resolve(run('completed'));
      });
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowDb.resumeWorkflowRun as ReturnType<typeof mock>).mockClear();

    const code = await workflowLogsCommand(run('paused').id, true);

    expect(code).toBe(0);
    expect(stdoutText()).toBe(startRow + terminalRow);
    expect(stderrText()).toContain(`Following transcript: ${transcriptPath}`);
    expect(workflowDb.updateWorkflowRun).not.toHaveBeenCalled();
    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(workflowDb.resumeWorkflowRun).not.toHaveBeenCalled();
  });

  it('fails if the transcript shrinks behind the current offset', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    writeFileSync(transcriptPath, `${JSON.stringify({ type: 'workflow_start' })}\n`);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce(run('running'))
      .mockImplementationOnce(() => {
        truncateSync(transcriptPath, 0);
        return Promise.resolve(run('running'));
      });

    const following = workflowLogsCommand(run('running').id, true);

    expect(await following).toBe(1);
    expect(stderrText()).toContain('Transcript was truncated');
  });
});

describe('run-id prefix resolution (short ids from `workflow runs`)', () => {
  const FULL_ID = '0b1ee8da-1111-2222-3333-444455556666';
  const CODEBASE = { id: 'cb-1', name: 'proj', default_cwd: '/repo' };
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockClear();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockClear();
    mockCreateWorkflowEvent.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('resolves a unique short prefix to the full run id (get)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: FULL_ID,
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    const code = await workflowGetCommand('0b1ee8da', true, undefined, '/repo');

    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-1');
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(FULL_ID);
    expect(code).toBe(0);
  });

  it('skips codebase and prefix lookups entirely for a full UUID', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: FULL_ID,
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    const code = await workflowGetCommand(FULL_ID, true, undefined, '/repo');

    expect(codebaseDb.findCodebaseByDefaultCwd).not.toHaveBeenCalled();
    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(FULL_ID);
    expect(code).toBe(0);
  });

  it('skips lookups for a 32-char undashed full id (SQLite id shape)', async () => {
    const undashedId = 'e1f890f05e5bab0d906921593bf500c4';
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: undashedId,
      workflow_name: 'implement',
      status: 'completed',
      working_path: '/tmp/wt',
      started_at: new Date(),
      metadata: {},
    });

    const code = await workflowGetCommand(undashedId, true, undefined, '/repo');

    expect(codebaseDb.findCodebaseByDefaultCwd).not.toHaveBeenCalled();
    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(undashedId);
    expect(code).toBe(0);
  });

  it('throws on an ambiguous prefix (human mode)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(workflowResumeCommand('0b1ee8da', undefined, '/repo')).rejects.toThrow(
      '0b1ee8da-1111-2222-3333-444455556666\n  0b1ee8da-9999-8888-7777-666655554444'
    );
  });

  it('emits {ok:false} JSON on an ambiguous prefix (never throws in --json)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await workflowAbandonCommand('0b1ee8da', true, '/repo');

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      runId: string;
      action: string;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.runId).toBe('0b1ee8da');
    expect(parsed.action).toBe('abandon');
    expect(parsed.error).toContain('matches more than one run');
  });

  it('passes the id through unchanged when cwd is not a registered project', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand('deadbeef', true, undefined, '/somewhere');

    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith('deadbeef');
    expect(code).toBe(1);
  });

  it('passes the id through when the prefix matches nothing in this project', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand('deadbeef', true, undefined, '/repo');

    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith('deadbeef');
    expect(code).toBe(1);
  });

  it('abandons by short prefix and reports the resolved full id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: FULL_ID,
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand('0b1ee8da', true, '/repo');

    expect(workflowDb.cancelWorkflowRun).toHaveBeenCalledWith(FULL_ID);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      runId: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.runId).toBe(FULL_ID);
  });

  it('approves by short prefix and reports the resolved full id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: FULL_ID,
      workflow_name: 'implement',
      status: 'paused',
      working_path: '/tmp/wt',
      codebase_id: 'cb',
      conversation_id: 'conv',
      user_message: 'go',
      metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
    });

    await workflowApproveCommand('0b1ee8da', 'lgtm', true, '/repo');

    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(FULL_ID);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, runId: FULL_ID, action: 'approve' });
  });

  it('rejects by short prefix and reports the resolved full id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: FULL_ID,
      workflow_name: 'implement',
      status: 'paused',
      working_path: '/tmp/wt',
      codebase_id: 'cb',
      conversation_id: 'conv',
      user_message: 'go',
      metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowRejectCommand('0b1ee8da', 'nope', true, '/repo');

    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(FULL_ID);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: FULL_ID,
      action: 'reject',
      cancelled: true,
    });
  });

  it('emits an event using the resolved full run id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);

    await workflowEventEmitCommand('0b1ee8da', 'workflow_started', undefined, '/repo');

    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: FULL_ID,
      event_type: 'workflow_started',
      data: undefined,
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      `Event submitted (best-effort): workflow_started for run ${FULL_ID}`
    );
  });

  it('resolves an event prefix from a workspace-scoped worktree', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockResolvedValueOnce('/canonical/repo');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(CODEBASE);
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);

    await workflowEventEmitCommand(
      '0b1ee8da',
      'workflow_started',
      undefined,
      '/home/test/.archon/workspaces/owner/proj/worktrees/archon/task-2611'
    );

    expect(codebaseDb.findCodebaseByDefaultCwd).toHaveBeenCalledWith('/canonical/repo');
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: FULL_ID,
      event_type: 'workflow_started',
      data: undefined,
    });
  });

  it('resolves an event prefix from an exact registered linked worktree', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const canonicalSpy = git.getCanonicalRepoPath as ReturnType<typeof mock>;
    canonicalSpy.mockClear();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);

    await workflowEventEmitCommand(
      '0b1ee8da',
      'workflow_started',
      undefined,
      '/workspace/registered-worktree'
    );

    expect(canonicalSpy).not.toHaveBeenCalled();
    expect(mockCreateWorkflowEvent).toHaveBeenCalledWith({
      workflow_run_id: FULL_ID,
      event_type: 'workflow_started',
      data: undefined,
    });
  });

  it('rejects an unmatched event prefix before creating an event', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([]);

    await expect(
      workflowEventEmitCommand('deadbeef', 'workflow_started', undefined, '/repo')
    ).rejects.toThrow("No workflow run matches prefix 'deadbeef' in this project.");
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  it('rejects an event prefix outside a registered project before creating an event', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowEventEmitCommand('deadbeef', 'workflow_started', undefined, '/unregistered')
    ).rejects.toThrow("Cannot resolve run id prefix 'deadbeef' outside a registered project.");
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous event prefix before creating an event', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(
      CODEBASE
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowEventEmitCommand('0b1ee8da', 'workflow_started', undefined, '/repo')
    ).rejects.toThrow('matches more than one run');
    expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
  });

  it('skips resolution when no cwd is provided (exact lookup only)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const code = await workflowGetCommand('deadbeef', true);

    expect(codebaseDb.findCodebaseByDefaultCwd).not.toHaveBeenCalled();
    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(code).toBe(1);
  });
});

describe('workflowRunsCommand', () => {
  let consoleSpy: Mock<(...args: unknown[]) => void>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('scopes to the cwd-resolved codebase id', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const canonicalSpy = git.getCanonicalRepoPath as ReturnType<typeof mock>;
    canonicalSpy.mockClear();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-proj',
      name: 'owner/repo',
      default_cwd: '/test/path',
    });
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockClear();
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand('/test/path', {});

    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-proj', limit: 20 })
    );
    expect(canonicalSpy).not.toHaveBeenCalled();
  });

  it('scopes a linked worktree to its registered primary checkout', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockResolvedValueOnce(
      '/registered/primary'
    );
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'cb-primary',
        name: 'owner/repo',
        default_cwd: '/registered/primary',
      });
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockClear();
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand('/workspace/sibling-worktree', {});

    expect(git.getCanonicalRepoPath).toHaveBeenCalledWith('/workspace/sibling-worktree');
    expect(codebaseDb.findCodebaseByDefaultCwd).toHaveBeenCalledWith('/registered/primary');
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-primary', limit: 20 })
    );
    expect(consoleSpy).not.toHaveBeenCalledWith('(not a registered project — showing all runs)');
  });

  it('preserves a codebase registered at the exact linked-worktree path', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const canonicalSpy = git.getCanonicalRepoPath as ReturnType<typeof mock>;
    canonicalSpy.mockClear();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-worktree',
      name: 'owner/repo-worktree',
      default_cwd: '/workspace/registered-worktree',
    });
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockClear();
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand('/workspace/registered-worktree', {});

    expect(canonicalSpy).not.toHaveBeenCalled();
    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-worktree', limit: 20 })
    );
  });

  it('scopes an external-git-dir worktree through its registered Git identity', async () => {
    const git = await import('@archon/git');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const cwd = '/workspace/external-linked';
    const commonGitDir = '/metadata/repository';
    const registered = {
      id: 'cb-external',
      name: 'owner/repo',
      default_cwd: '/workspace/primary',
      kind: 'repo',
    };
    (git.getCanonicalRepoPath as ReturnType<typeof mock>).mockRejectedValueOnce(
      new git.CanonicalRepoPathUnavailableError(cwd, commonGitDir)
    );
    (git.getGitCheckoutIdentity as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        gitDir: `${commonGitDir}/worktrees/linked`,
        commonGitDir,
        linkedWorktree: true,
      })
      .mockResolvedValueOnce({
        gitDir: commonGitDir,
        commonGitDir,
        linkedWorktree: false,
      });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.listCodebases as ReturnType<typeof mock>).mockResolvedValueOnce([registered]);
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand(cwd, {});

    expect(listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-external', limit: 20 })
    );
  });

  it('prints the unregistered-cwd note and lists globally when no codebase resolves', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.listDashboardRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      runs: [],
      total: 0,
      counts: EMPTY_COUNTS,
    });

    await workflowRunsCommand('/unregistered', {});

    expect(consoleSpy).toHaveBeenCalledWith('(not a registered project — showing all runs)');
  });

  it('emits the full dashboard result as JSON', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.listDashboardRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      runs: [
        {
          id: 'r1',
          workflow_name: 'assist',
          status: 'completed',
          outcome: 'failed',
          active_nodes: ['parallel-a', 'parallel-b'],
          current_step_name: null,
          total_steps: null,
          started_at: new Date(),
        },
      ],
      total: 1,
      counts: { ...EMPTY_COUNTS, all: 1, completed: 1 },
    });

    await workflowRunsCommand('/test/path', { json: true });

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      runs: Array<{ status: string; outcome: string | null; active_nodes: string[] }>;
      total: number;
      scopeFallback: boolean;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]).toMatchObject({ status: 'completed', outcome: 'failed' });
    expect(parsed.runs[0]?.active_nodes).toEqual(['parallel-a', 'parallel-b']);
    // codebase did not resolve → result is a global fallback, flagged for agents
    expect(parsed.scopeFallback).toBe(true);
  });

  it('shows authored outcome separately in the human run list', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-proj',
      name: 'owner/repo',
      default_cwd: '/test/path',
    });
    (workflowDb.listDashboardRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      runs: [
        {
          id: 'r1-contradictory',
          workflow_name: 'review',
          status: 'completed',
          outcome: 'failed',
          active_nodes: ['parallel-a', 'parallel-b'],
          current_step_name: null,
          total_steps: null,
          started_at: new Date(),
        },
      ],
      total: 1,
      counts: { ...EMPTY_COUNTS, all: 1, completed: 1 },
    });

    await workflowRunsCommand('/test/path');

    const output = consoleSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(output).toContain('completed');
    expect(output).toContain('authored outcome: failed');
    expect(output).toContain('active node(s): parallel-a, parallel-b');
  });

  it('marks scopeFallback false in --json when the project scope resolves', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-proj',
      name: 'owner/repo',
      default_cwd: '/test/path',
    });
    (workflowDb.listDashboardRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      runs: [],
      total: 0,
      counts: EMPTY_COUNTS,
    });

    await workflowRunsCommand('/test/path', { json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as { scopeFallback: boolean };
    expect(parsed.scopeFallback).toBe(false);
  });

  it('passes --all (no codebase scope) plus --status/--limit through to listDashboardRuns', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const findSpy = codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>;
    findSpy.mockClear();
    const listSpy = workflowDb.listDashboardRuns as ReturnType<typeof mock>;
    listSpy.mockClear();
    listSpy.mockResolvedValueOnce({ runs: [], total: 0, counts: EMPTY_COUNTS });

    await workflowRunsCommand('/test/path', { all: true, status: 'running', limit: 5 });

    // --all skips the codebase lookup entirely
    expect(findSpy).not.toHaveBeenCalled();
    const arg = listSpy.mock.calls[0][0] as { codebaseId?: string; status?: string; limit: number };
    expect(arg.codebaseId).toBeUndefined();
    expect(arg.status).toBe('running');
    expect(arg.limit).toBe(5);
  });

  it('throws on an invalid --status', async () => {
    await expect(workflowRunsCommand('/test/path', { status: 'bogus' })).rejects.toThrow(
      /Invalid --status 'bogus'/
    );
  });

  it('emits {ok:false} JSON (never throws) on an invalid --status in --json mode', async () => {
    await workflowRunsCommand('/test/path', { status: 'bogus', json: true });

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("Invalid --status 'bogus'");
  });
});

describe('write command --json output', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('abandon --json emits a structured cancelled result', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-ab',
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand('run-ab', true);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: true,
      runId: 'run-ab',
      action: 'abandon',
      status: 'cancelled',
      workflowName: 'implement',
    });
  });

  it('abandon --json emits {ok:false} on a not-found run (never throws)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await workflowAbandonCommand('missing', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Workflow run not found');
  });

  it('approve --json records the decision and does NOT auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const discovery = await import('@archon/workflows/workflow-discovery');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-ap',
      workflow_name: 'implement',
      status: 'paused',
      working_path: '/tmp/wt',
      codebase_id: 'cb',
      conversation_id: 'conv',
      user_message: 'go',
      metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
    });
    const discoverSpy = discovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await workflowApproveCommand('run-ap', 'lgtm', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-ap',
      action: 'approve',
      type: 'approval_gate',
      resumable: true,
    });
    // No inline resume → workflowRunCommand (whose first step is discovery) never ran
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('reject --json reports cancelled + resumable correctly without auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const discovery = await import('@archon/workflows/workflow-discovery');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-rj',
      workflow_name: 'implement',
      status: 'paused',
      working_path: '/tmp/wt',
      codebase_id: 'cb',
      conversation_id: 'conv',
      user_message: 'go',
      metadata: { approval: { nodeId: 'gate', message: 'ok?' } },
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });
    const discoverSpy = discovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await workflowRejectCommand('run-rj', 'nope', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    // No onRejectPrompt in approval metadata → run is cancelled, not resumable
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-rj',
      action: 'reject',
      cancelled: true,
      resumable: false,
    });
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('resume --json validates resumability without executing (executed:false)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const discovery = await import('@archon/workflows/workflow-discovery');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-rs',
      workflow_name: 'implement',
      status: 'failed',
      working_path: '/tmp/wt',
    });
    const discoverSpy = discovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await workflowResumeCommand('run-rs', true);

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-rs',
      action: 'resume',
      executed: false,
      status: 'failed',
    });
    expect(discoverSpy).not.toHaveBeenCalled();
  });
});

/**
 * The launcher/child exit-status protocol behind the startup window. The window can only
 * see that the child's process is gone; whether the run ever started is the child's to
 * report, and this is the channel it reports on.
 */
describe('resolveCliExitCode', () => {
  it('reserves a distinct status for a detached child reporting its own run failure', () => {
    expect(resolveCliExitCode(new WorkflowRunFailedError('node failed', true))).toBe(
      DETACHED_RUN_FAILED_EXIT_CODE
    );
  });

  it('keeps the ordinary status for a run that failed on a terminal', () => {
    expect(resolveCliExitCode(new WorkflowRunFailedError('node failed', false))).toBe(1);
  });

  it('reads the run outcome through a continuation command re-throw', () => {
    // `resume`/`approve`/`reject`/`respond` re-throw with their own explanation, so the
    // outermost error is never the run's. Losing the cause here would make every
    // detached continuation of a fast-failing run look like a launch failure again.
    const wrapped = new Error("Approved but failed to resume workflow 'assist': Workflow failed", {
      cause: new WorkflowRunFailedError('node failed', true),
    });
    expect(resolveCliExitCode(wrapped)).toBe(DETACHED_RUN_FAILED_EXIT_CODE);
  });

  it('reports a failure that is not a run outcome as an ordinary failure', () => {
    // The startup deaths #2914 exists to surface land here: the launcher must keep
    // reading these as a launch that never took.
    expect(resolveCliExitCode(new Error('Cannot determine git remote'))).toBe(1);
    expect(resolveCliExitCode('not an error')).toBe(1);
  });
});

describe('workflowRunCommand — detach', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    jest.useFakeTimers();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    // A real detached launch resolves a project — the pre-flight refuses an isolating
    // run that has no project to isolate (#2872 R1), the same refusal the isolation
    // block makes. Tests that want that refusal override this per invocation.
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue({
      id: 'cb-detach',
      name: 'test/repo',
      default_cwd: '/test/path',
      default_branch: 'main',
      kind: 'repo',
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  it('spawns a detached child (minus --detach, plus --branch/--conversation-id) and does NOT await executeWorkflow', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    // Force the log-file path to fall back to 'ignore' so the test writes no files
    (paths.getArchonHome as ReturnType<typeof mock>)
      .mockImplementationOnce(() => '/home/test/.archon')
      .mockImplementationOnce(() => {
        throw new Error('no home in test');
      });

    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    // Capture call data BEFORE mockRestore() — restoring a spy clears its recorded calls.
    let spawnCallCount = 0;
    let spawnCmd: string[] = [];
    let spawnOptions: DetachedSpawnOptions | undefined;
    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', 'hello', { detach: true });
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCallCount = spawnSpy.mock.calls.length;
      spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnCmd = (spawnOptions?.cmd ?? []).slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnCallCount).toBe(1);
    // The actual Windows fix: the child must be spawned into its own process
    // group, or the launching shell's teardown kills it (~1s in).
    expect(spawnOptions?.detached).toBe(true);
    expect(spawnOptions?.windowsHide).toBe(true);
    expect(spawnOptions?.env?.ARCHON_DETACHED_RUN_OWNER).toBe('1');
    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('--branch');
    expect(spawnCmd).toContain('--conversation-id');
    expect(spawnCmd).toContain('--cwd');
    const cwdIdx = spawnCmd.indexOf('--cwd');
    expect(spawnCmd[cwdIdx + 1]).toBe('/test/path');
    expect(spawnOptions?.cwd).toBe('/test/path');
    // Generated branch is `assist-<timestamp>`
    const branchIdx = spawnCmd.indexOf('--branch');
    expect(spawnCmd[branchIdx + 1]).toMatch(/^assist-\d+$/);
    // executeWorkflow must NOT run in the detaching parent
    const execAfter = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    expect(execAfter).toBe(execBefore);
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith("Started 'assist' in the background.");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^Transcript: .*\.jsonl$/));
  });

  it('resolves an adopted run prefix before passing it to the detached child', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
    // The parent resolves the declared adoption before forking (#2872), so this test
    // now has to give it a project and a resolvable lane to pass through.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: adoptedRunId },
    ]);
    (resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
      adoptedRun: { id: adoptedRunId, status: 'completed', working_path: '/test/worktree' },
      lane: { kind: 'reuse-worktree', workingPath: '/test/worktree' },
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRunCommand('/test/path/subdir', 'assist', 'hello', {
        detach: true,
        adoptRunId: '0b1ee8da',
      });
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const adoptIndex = spawnCmd.indexOf('--adopt');
    expect(adoptIndex).toBeGreaterThan(-1);
    expect(spawnCmd[adoptIndex + 1]).toBe(adoptedRunId);
    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-1');
    expect(resolveWorkflowAdoption).toHaveBeenCalledWith(expect.objectContaining({ adoptedRunId }));
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ adopted_from_run_id: adoptedRunId })
    );
    expect(spawnCmd).not.toContain('--branch');
  });

  // #2872 — the launch printed `Started` and exited 0 while the child died on adoption
  // resolution, so no run row was ever created and the failure existed only inside the
  // detached child's log. The refusal has to reach the launching terminal.
  it('refuses an unresolvable --adopt synchronously instead of acking Started (#2872)', async () => {
    // Real timers: pre-fix this path spawns and waits out the startup window, so the
    // assertions below must be reachable rather than parked on an unadvanced fake timer.
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const { resolveWorkflowAdoption } = await import('@archon/core/operations/workflow-adoption');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/repo',
      default_cwd: '/test/path',
      default_branch: 'main',
      kind: 'repo',
    });
    (resolveWorkflowAdoption as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error(
        "Cannot adopt: no workflow run 'run-missing' exists. Check the id with `workflow runs`."
      )
    );

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      await expect(
        workflowRunCommand('/test/path', 'assist', 'hello', {
          detach: true,
          adoptRunId: 'run-missing',
        })
      ).rejects.toThrow(/Cannot adopt: no workflow run 'run-missing' exists/);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(consoleSpy).not.toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  it('hands the detached child the sealed validated layer instead of a mutable path', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const paths = await import('@archon/paths');
    const { unsealWorkflowRunConfig } = await import('@archon/core/config');
    const { workflowRunConfigMetadataSchema } =
      await import('@archon/workflows/schemas/run-config');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    const savedArchonHome = process.env.ARCHON_HOME;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    delete process.env.ARCHON_HOME;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      '--config',
      '/caller/config.yaml',
      '--detach',
    ];

    let payload: string | undefined;
    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', '', {
        detach: true,
        configPath: '/caller/config.yaml',
        detachedRunConfig: {
          source: { kind: 'cli', label: 'config.yaml' },
          layer: { docsPath: 'accepted', envVars: { SNAPSHOT: 'original' } },
        },
      });
      await finishStartupWindow(commandPromise, spawnSpy);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      const payloadIndex = spawnOptions.cmd.indexOf('--internal-detached-run-config');
      payload = payloadIndex >= 0 ? spawnOptions.cmd[payloadIndex + 1] : undefined;
      expect(spawnOptions.env?.ARCHON_INTERNAL_DETACHED_RUN_CONFIG).toBeUndefined();
      expect(spawnOptions.env?.TOKEN_ENCRYPTION_KEY).toBe('ab'.repeat(32));
      expect(spawnOptions.env?.ARCHON_HOME).toBe('');
    } finally {
      process.argv = savedArgv;
      if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
      if (savedArchonHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = savedArchonHome;
      spawnSpy.mockRestore();
    }

    expect(payload).toBeDefined();
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    try {
      const metadata = workflowRunConfigMetadataSchema.parse(JSON.parse(payload ?? ''));
      expect(unsealWorkflowRunConfig(metadata)).toMatchObject({
        docsPath: 'accepted',
        envVars: { SNAPSHOT: 'original' },
      });
    } finally {
      if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    }
  });

  // #2213 — the headline `--json` claim. `writeJsonLine` (not console.log) is
  // what emits the payload, and it is only reached on this `--detach` branch,
  // so this is the only place the "stdout stays exactly the payload" guarantee
  // can actually be observed. Asserts the captured stdout still JSON.parse()s
  // while the warning went to stderr.
  it('keeps stdout a parseable JSON payload while warning on stderr', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [
        makeTestWorkflowWithSource({ name: 'assist', description: 'Help' }, 'project', [
          "Node 'plan': unknown key 'interactive' will be ignored.",
        ]),
      ],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      'hello',
      '--detach',
      '--json',
    ];

    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', 'hello', {
        detach: true,
        json: true,
      });
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // stdout: exactly one line, and it parses.
    const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as {
      ok: boolean;
      action: string;
      workflow: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.action).toBe('run');
    expect(payload.workflow).toBe('assist');
    // The warning reached the user — on stderr, not in the payload.
    expect(warnSpy).toHaveBeenCalledWith("Warning: 'assist' declares keys the engine ignores:");
    expect(JSON.stringify(payload)).not.toContain('unknown key');
    warnSpy.mockRestore();
  });

  it('does NOT pin a --branch on the detached child for a registered folder project', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const paths = await import('@archon/paths');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
    // Detach folder probe: exact miss, then path-prefix resolves a folder project.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-folder',
      name: 'platform',
      default_cwd: '/test/path',
      kind: 'folder',
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];
    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', 'hello', { detach: true });
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).not.toContain('--branch'); // folder project → no worktree branch
    expect(spawnCmd).toContain('--conversation-id');
  });

  // #2872 — a continuation already owns a run row, so the ack names it without
  // creating anything. `wait <run-id>` behind `run --resume --detach` needs the id
  // just as much as behind a fresh launch.
  it('--resume --detach acks the continuation run id without creating a row', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-paused',
      workflow_name: 'assist',
      working_path: null,
    });
    mockCreateWorkflowRun.mockClear();

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      'hello',
      '--resume',
      '--detach',
      '--json',
    ];

    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', 'hello', {
        resume: true,
        detach: true,
        json: true,
      });
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed.runId).toBe('run-paused');
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });

  it('--detach --json emits a structured ack', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const paths = await import('@archon/paths');
    const tempHome = mkdtempSync(join(tmpdir(), 'archon-detached-paths-'));
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = tempHome;
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>)
      .mockImplementationOnce(() => tempHome)
      .mockImplementationOnce(() => tempHome);
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'run',
      'assist',
      'hello',
      '--detach',
      '--json',
    ];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', 'hello', {
        detach: true,
        json: true,
      });
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
      await removeTempTree(tempHome);
    }

    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, action: 'run', detached: true, workflow: 'assist' });
    expect(typeof parsed.conversationId).toBe('string');
    // #2872: the ack hands back the row this launch created, and the child is told to
    // execute that row rather than creating a second one.
    expect(parsed.runId).toBe('run-detached-created');
    expect(parsed.transcriptPath).toBe(
      join(tempHome, 'workspaces', 'test', 'repo', 'logs', 'run-detached-created.jsonl')
    );
    expect(typeof parsed.logPath).toBe('string');
    expect(parsed.logPath).not.toBe(parsed.transcriptPath);
    expect(mockCreateWorkflowRun).toHaveBeenCalled();
    const idIndex = spawnCmd.indexOf('--internal-detached-run-id');
    expect(idIndex).toBeGreaterThan(-1);
    expect(spawnCmd[idIndex + 1]).toBe('run-detached-created');
  });

  // #2872 R1 — the plain launch, with no --folder/--adopt/--supersedes/--resume, is the
  // most common invocation and had no pre-flight refusal at all: an isolating run with
  // no project to isolate sailed past, printed `Started`, and died on the identical
  // check in the child.
  it('refuses an isolating launch whose project lookup fails, before forking', async () => {
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('ECONNREFUSED')
    );

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowRunCommand('/test/path', 'assist', 'hello', { detach: true })
      ).rejects.toThrow(/Cannot create worktree: database lookup failed/);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
    expect(consoleSpy).not.toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  it('refuses an isolating launch outside a git repository, before forking', async () => {
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    mockCreateWorkflowRun.mockClear();
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowRunCommand('/test/path', 'assist', 'hello', { detach: true })
      ).rejects.toThrow(/Cannot create worktree: not in a git repository/);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
    // Refused before the row exists, so there is nothing to leave behind.
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
  });

  it('still launches without a project when isolation is not wanted', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];
    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', 'hello', {
        detach: true,
        noWorktree: true,
      });
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
    expect(consoleSpy).toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  // A one-node workflow that fails legitimately finishes inside the 500 ms startup
  // window on a fast machine. #2914 read the child's non-zero exit as a launch failure,
  // so the same command passed or failed depending on how quickly the machine got
  // through the run — locally it broke `bun run validate` outright. The child now names
  // its run's own failure, and only that reading acks it.
  it('acks a run whose workflow failed inside the startup window', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', 'hello', { detach: true });
      for (let attempt = 0; attempt < 20 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, DETACHED_RUN_FAILED_EXIT_CODE, null);
      await commandPromise;
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(consoleSpy).toHaveBeenCalledWith("Started 'assist' in the background.");
    // The run recorded its own failure. A launcher that fails the row here would
    // overwrite the run's reason with a launch failure that never happened.
    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
  });

  // #2872 — the parent is the row's only owner until the child claims it. A child that
  // never starts must not leave a `pending` row nobody can explain.
  it('fails the run row it created when the detached child dies during startup', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', 'hello', { detach: true });
      for (let attempt = 0; attempt < 20 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, 1, null);
      await expect(commandPromise).rejects.toThrow(/exit code 1/);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
      'run-detached-created',
      expect.stringContaining('Detached launch failed')
    );
    expect(consoleSpy).not.toHaveBeenCalledWith("Started 'assist' in the background.");
  });

  it('rejects an immediate non-zero child exit with the log tail and no success ack', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const paths = await import('@archon/paths');
    const tempHome = mkdtempSync(join(tmpdir(), 'archon-detached-failure-'));
    const conversationId = 'cli-detached-failure';
    const logPath = join(tempHome, 'logs', `detached-run-${conversationId}.log`);
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>)
      .mockImplementationOnce(() => tempHome)
      .mockImplementationOnce(() => tempHome);
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const commandPromise = workflowRunCommand('/test/path', 'assist', 'hello', {
        detach: true,
        json: true,
        conversationId,
      });
      for (let attempt = 0; attempt < 20 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      appendFileSync(logPath, 'database unavailable during startup\n');
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, 1, null);

      await expect(commandPromise).rejects.toThrow(
        /exit code 1[\s\S]*database unavailable during startup/
      );
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
      rmSync(tempHome, { recursive: true, force: true });
    }

    expect(child.unref).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('writes a delimiter for every invocation sharing a conversation id', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const paths = await import('@archon/paths');
    const tempHome = mkdtempSync(join(tmpdir(), 'archon-detached-delimiters-'));
    const conversationId = 'cli-shared-conversation';
    const firstChild = createDetachedChildFixture();
    const secondChild = createDetachedChildFixture();
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
        errors: [],
      });
    (paths.getArchonHome as ReturnType<typeof mock>)
      .mockImplementationOnce(() => tempHome)
      .mockImplementationOnce(() => tempHome)
      .mockImplementationOnce(() => tempHome)
      .mockImplementationOnce(() => tempHome);
    const spawnSpy = spyOn(Bun, 'spawn')
      .mockReturnValueOnce(firstChild.child)
      .mockReturnValueOnce(secondChild.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      const firstRun = workflowRunCommand('/test/path', 'assist', 'hello', {
        detach: true,
        conversationId,
      });
      await finishStartupWindow(firstRun, spawnSpy);
      const secondRun = workflowRunCommand('/test/path', 'assist', 'hello', {
        detach: true,
        conversationId,
      });
      await finishStartupWindow(secondRun, spawnSpy, 2);

      const log = readFileSync(
        join(tempHome, 'logs', `detached-run-${conversationId}.log`),
        'utf8'
      );
      const delimiters = log
        .split('\n')
        .filter(line => line.startsWith(`--- detached workflow invocation: ${conversationId} at `));
      expect(delimiters).toHaveLength(2);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('throws (no false success ack) when the detached child fails to spawn', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
    // Node's spawn does not throw synchronously on a bad executable — the only
    // synchronous failure signal is an undefined pid.
    const child = createDetachedChildFixture(null);
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    try {
      await expect(
        workflowRunCommand('/test/path', 'assist', 'hello', { detach: true })
      ).rejects.toThrow(/Failed to start detached workflow child/);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
    // The success ack must never have been printed.
    const logged: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged).not.toContain("Started 'assist' in the background.");
  });
});

// #2707 step 2 / #1991 — an interactive-class workflow dispatched via `--detach` used to
// hang indefinitely: the detached child paused with nobody watching, exited 0, and nothing
// ever resumed it. Refused synchronously now, before the fork.
// ---------------------------------------------------------------------------
// #2872 — the detached child executes the run its launcher created. Without this
// the child wrote a SECOND row, so the id the parent acked named nothing.
// ---------------------------------------------------------------------------

describe('workflowRunCommand — detached child adopts the pre-created run (#2872)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  const preCreatedRow = {
    id: 'run-precreated',
    workflow_name: 'plan',
    conversation_id: 'conv-1',
    status: 'pending',
    working_path: null,
    started_at: new Date(),
    metadata: {},
  };

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    mockStartRunLiveOwner.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.ARCHON_DETACHED_RUN_OWNER;
  });

  it('executes the launcher’s row and files its capture under that id', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow, prepareWorkflowSource } = await import('@archon/workflows/executor');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(preCreatedRow);
    (prepareWorkflowSource as ReturnType<typeof mock>).mockClear();
    (executeWorkflow as ReturnType<typeof mock>).mockClear();

    await workflowRunCommand('/test/path', 'plan', 'hello', {
      detachedRunId: 'run-precreated',
      conversationId: 'cli-123',
      noWorktree: true,
    });

    expect(prepareWorkflowSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: 'run-precreated' })
    );
    const opts = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1)?.[7] as {
      preCreatedRun?: { id: string };
      priorCompletedNodes?: unknown;
    };
    expect(opts.preCreatedRun?.id).toBe('run-precreated');
    // A fresh pre-created row is NOT a resume: prior state would make the executor
    // skip nodes that never ran.
    expect(opts.priorCompletedNodes).toBeUndefined();
    // The live-owner endpoint is keyed on the run this process owns, and only a
    // detached child exposes active stop.
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('run-precreated', {
      detachedProcessPid: process.pid,
    });
  });

  // #2872 R2 — everything between the handover and the executor claiming the row can
  // throw, and the launcher is gone by then. Without this the row sits `pending`
  // forever and the reason lives only in the child's log: the same silent failure,
  // moved one process later.
  it('fails the handed-over row when it throws before the executor claims it', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(preCreatedRow);
    // No project resolves, so the isolation gate throws after the row was handed over.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValueOnce('pending');
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand('/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/Cannot create worktree/);

    expect(workflowDb.failWorkflowRun).toHaveBeenCalledWith(
      'run-precreated',
      expect.stringContaining('Detached run failed to start')
    );
  });

  it('leaves a row the executor already claimed to its own lifecycle', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(preCreatedRow);
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    // The run got as far as executing — its lifecycle is not this handler's to mutate.
    (workflowDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValueOnce('running');
    (workflowDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand('/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/Cannot create worktree/);

    expect(workflowDb.failWorkflowRun).not.toHaveBeenCalled();
  });

  // #2872 R3 — the flag names a row this process will execute AS. Both halves are
  // checked: that this really is a detached child, and that the row is claimable.
  it('refuses the flag outside a detached child', async () => {
    delete process.env.ARCHON_DETACHED_RUN_OWNER;

    await expect(
      workflowRunCommand('/test/path', 'plan', 'hello', { detachedRunId: 'run-precreated' })
    ).rejects.toThrow(/set by a detached launch for its own child/);
  });

  it('refuses a row that is not awaiting its first execution', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...preCreatedRow,
      status: 'completed',
    });

    await expect(
      workflowRunCommand('/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/it is completed, not a run awaiting its first execution/);
  });

  it('refuses a row belonging to a different workflow', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...preCreatedRow,
      workflow_name: 'something-else',
    });

    await expect(
      workflowRunCommand('/test/path', 'plan', 'hello', {
        detachedRunId: 'run-precreated',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/belongs to workflow 'something-else', not 'plan'/);
  });

  it('fails loudly when the row its launcher promised is gone', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(
      workflowRunCommand('/test/path', 'plan', 'hello', {
        detachedRunId: 'run-vanished',
        conversationId: 'cli-123',
      })
    ).rejects.toThrow(/cannot find the run 'run-vanished'/);
  });
});

describe('workflowRunCommand — detach refuses an interactive-class workflow (#2707 step 2 / #1991)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    jest.useFakeTimers();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleSpy.mockRestore();
  });

  it('refuses before the fork, naming the workflow and its class', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'guided', interactive: true }, 'project')],
      errors: [],
    });

    const spawnSpy = spyOn(Bun, 'spawn');

    try {
      await expect(
        workflowRunCommand('/test/path', 'guided', 'hello', { detach: true })
      ).rejects.toThrow(/interactive-class/i);
    } finally {
      spawnSpy.mockRestore();
    }

    // Refused before the fork — no child process, no "started" ack.
    expect(spawnSpy).not.toHaveBeenCalled();
    const logged: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(logged).not.toContain("Started 'guided' in the background.");
  });

  it('allows the same workflow to run in the foreground (no --detach)', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'guided', interactive: true }, 'project')],
      errors: [],
    });
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-ok',
    });

    await workflowRunCommand('/test/path', 'guided', 'hello', { noWorktree: true });

    expect(executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('does not refuse a continuation (--resume --detach) on an already-paused interactive-class run', async () => {
    // A continuation is exempt from the launch refusal (isContinuation guard) — proven by
    // asserting the class error never fires, regardless of what (if anything) an
    // unrelated missing mock throws afterward. Real timers: this test does not exercise
    // the fake-timer-gated startup window the sibling tests in this block do.
    jest.useRealTimers();
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const { hydrateResumableRun } = await import('@archon/workflows/executor');
    const conversationDb = await import('@archon/core/db/conversations');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'guided', interactive: true }, 'project')],
      errors: [],
    });
    (hydrateResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      preCreatedRun: { id: 'run-paused', workflow_name: 'guided' },
      priorCompletedNodes: new Map(),
    });
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-resume',
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (workflowDb.findResumableRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-paused',
      workflow_name: 'guided',
      working_path: null,
    });
    // Real spawn must never actually run — mock it even though this test doesn't assert
    // on it, since --detach forks if every mock above happens to line up.
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);

    try {
      await workflowRunCommand('/test/path', 'guided', 'hello', {
        resume: true,
        detach: true,
      });
    } catch (error) {
      expect((error as Error).message).not.toMatch(/interactive-class/i);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});

describe('workflowApproveCommand / workflowRejectCommand / workflowResumeCommand — detach', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  // working_path is deliberately a distro-style path: the child must spawn with
  // the PARENT's cwd (it re-resolves by run-id), because a container run's
  // working_path is unreachable on the host and would ENOENT the spawn.
  const pausedRun = {
    id: 'run-123',
    status: 'paused',
    workflow_name: 'assist',
    working_path: '/distro/only/path',
    conversation_id: 'conv-123',
    user_message: 'hello',
    metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
  };

  /** Suppress the log file so the test writes nothing to disk (logPath becomes null). */
  const silenceLogFile = async (): Promise<void> => {
    const paths = await import('@archon/paths');
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
  };

  it('approve --detach spawns a detached child (minus --detach) and performs ZERO writes in the parent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    await silenceLogFile();

    const updateBefore = (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls
      .length;
    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', 'ship it', '--detach'];

    let spawnCmd: string[] = [];
    let spawnOptions: DetachedSpawnOptions | undefined;
    try {
      // Signature: (runId, comment, json, cwd, detach) — detach is the 5th arg,
      // layered after upstream's cwd.
      const commandPromise = workflowApproveCommand(
        'run-123',
        'ship it',
        undefined,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnCmd = (spawnOptions?.cmd ?? []).slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnOptions?.detached).toBe(true);
    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('approve');
    expect(spawnCmd).toContain('run-123');
    // Parent cwd, never the run's working_path (see pausedRun comment above).
    expect(spawnOptions?.cwd).toBe(process.cwd());
    expect(spawnCmd).not.toContain('/distro/only/path');
    // ZERO state mutation in the detaching parent — the child owns the approve
    // (a parent-side approve would record the decision twice).
    expect((workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(
      updateBefore
    );
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls.length).toBe(execBefore);
    expect(consoleSpy).toHaveBeenCalledWith("Started 'approve' for run run-123 in the background.");
    // No log file could be opened, so the child's output is discarded — say so.
    expect(warnSpy).toHaveBeenCalledWith(
      'Warning: could not open a log file — child output will not be captured.'
    );
  });

  it('approve --detach --json emits a structured ack on stdout without approving', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    await silenceLogFile();
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', '--detach', '--json'];

    try {
      const commandPromise = workflowApproveCommand('run-123', undefined, true, undefined, true);
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // The ack goes through writeJsonLine (flushed stdout), not console.log — a
    // console.log ack can be truncated on a pipe (#2384).
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      runId: 'run-123',
      action: 'approve',
      detached: true,
      workflowName: 'assist',
    });
    // logPath is a path or null — never a serialized Promise, which is what an
    // un-awaited spawnDetachedWorkflowRun produces ({} through JSON.stringify).
    expect(parsed.logPath).toBeNull();
  });

  it('--detach --json spawns a child WITHOUT --json (so it continues) and says so in the ack', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    await silenceLogFile();
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', '--detach', '--json'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowApproveCommand('run-123', undefined, true, undefined, true);
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    // Both flags are stripped: the child runs the ordinary inline path, which
    // auto-resumes. That is deliberate — --detach exists to host that execution.
    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).not.toContain('--json');
    // ...so the ack must tell the caller it does NOT own continuation.
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, detached: true, continues: true });
  });

  it('threads a caller-supplied --cwd to the child instead of the parent process.cwd()', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    await silenceLogFile();
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = [
      'bun',
      '/abs/cli.ts',
      'workflow',
      'approve',
      'run-123',
      '--cwd',
      '/caller/repo',
      '--detach',
    ];

    let spawnCmd: string[] = [];
    let spawnOptions: DetachedSpawnOptions | undefined;
    try {
      const commandPromise = workflowApproveCommand(
        'run-123',
        undefined,
        undefined,
        '/caller/repo',
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnCmd = (spawnOptions?.cmd ?? []).slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnOptions?.cwd).toBe('/caller/repo');
    // buildDetachedRunCmd appends --cwd LAST (parser is last-wins), so the
    // appended value is what the child actually resolves.
    const lastCwdIdx = spawnCmd.lastIndexOf('--cwd');
    expect(spawnCmd[lastCwdIdx + 1]).toBe('/caller/repo');
  });

  it('approve --detach rejects an immediate non-zero child exit instead of acking success', async () => {
    // The parent awaits spawnDetachedWorkflowRun's startup window (#2279). Without
    // that await the failure arrives as an unhandled rejection AFTER `{ok:true}`
    // has already been printed — the exact hole --detach exists to close.
    const workflowDb = await import('@archon/core/db/workflows');
    const tempHome = mkdtempSync(join(tmpdir(), 'archon-detached-control-failure-'));
    const logPath = join(tempHome, 'logs', 'detached-run-run-123.log');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    const paths = await import('@archon/paths');
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => tempHome);
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'approve', 'run-123', '--detach', '--json'];

    try {
      const commandPromise = workflowApproveCommand('run-123', undefined, true, undefined, true);
      for (let attempt = 0; attempt < 20 && spawnSpy.mock.calls.length === 0; attempt++) {
        await Promise.resolve();
      }
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      appendFileSync(logPath, 'database unavailable during startup\n');
      const spawnOptions = firstDetachedSpawnOptions(spawnSpy);
      spawnOptions.onExit?.(child.child, 1, null);
      await commandPromise;
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
      rmSync(tempHome, { recursive: true, force: true });
    }

    // --json turns the throw into the standard { ok: false } line; either way the
    // caller never sees a success ack for a child that died on startup.
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: false, runId: 'run-123', action: 'approve' });
    expect(String(parsed.error)).toMatch(/exit code 1[\s\S]*database unavailable during startup/);
  });

  it('approve --detach refuses a non-paused run synchronously and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'running',
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);

    let spawnCallCount = -1;
    try {
      await expect(
        workflowApproveCommand('run-123', undefined, undefined, undefined, true)
      ).rejects.toThrow("Cannot approve run with status 'running'");
      spawnCallCount = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }
    expect(spawnCallCount).toBe(0);
  });

  it('approve --detach --json reports a refusal as { ok: false } and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'completed',
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);

    let spawnCallCount = -1;
    try {
      await workflowApproveCommand('run-123', undefined, true, undefined, true);
      spawnCallCount = spawnSpy.mock.calls.length;
    } finally {
      spawnSpy.mockRestore();
    }

    expect(spawnCallCount).toBe(0);
    const parsed = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: false, runId: 'run-123', action: 'approve' });
    expect(String(parsed.error)).toContain("Cannot approve run with status 'completed'");
  });

  it('approve --detach refuses a child_workflow-blocked parent and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {
        approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', childRunId: 'c-9' },
      },
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand('run-123', undefined, undefined, undefined, true)
      ).rejects.toThrow('Approve or reject the child run instead: /workflow approve c-9');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('approve --detach refuses an already-resolved gate and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: { approval: { nodeId: 'gate', message: 'Approve?', resolved: 'approved' } },
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand('run-123', undefined, undefined, undefined, true)
      ).rejects.toThrow('was already approved and is awaiting resume');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('approve --detach refuses a missing approval context and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {},
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand('run-123', undefined, undefined, undefined, true)
      ).rejects.toThrow('Workflow run is paused but missing approval context.');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('approve --detach refuses a run with no recorded working path and spawns nothing', async () => {
    // The child always auto-resumes after approving, and a resume needs a working
    // path. Refuse in the parent rather than letting the child throw into its log.
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      working_path: null,
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(
        workflowApproveCommand('run-123', undefined, undefined, undefined, true)
      ).rejects.toThrow('has no working path recorded');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('resume --detach refuses a run with no recorded working path and spawns nothing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
      working_path: null,
    });
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    try {
      await expect(workflowResumeCommand('run-123', undefined, undefined, true)).rejects.toThrow(
        'has no working path recorded'
      );
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it('reject --detach refuses a child_workflow-blocked parent but TOLERATES missing context', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {
        approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', childRunId: 'c-9' },
      },
    });
    const blockedChild = createDetachedChildFixture();
    let spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(blockedChild.child);
    try {
      await expect(
        workflowRejectCommand('run-123', undefined, undefined, undefined, true)
      ).rejects.toThrow('Reject the child run instead: /workflow reject c-9');
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally {
      spawnSpy.mockRestore();
    }

    // reject has no nodeId requirement — a malformed context must still spawn.
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      metadata: {},
    });
    await silenceLogFile();
    const child = createDetachedChildFixture();
    spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'reject', 'run-123', '--detach'];
    try {
      const commandPromise = workflowRejectCommand(
        'run-123',
        undefined,
        undefined,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }
  });

  it('reject --detach spawns a detached child (minus --detach) and performs ZERO writes in the parent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({ ...pausedRun });
    await silenceLogFile();

    const updateBefore = (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls
      .length;
    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'reject', 'run-123', 'not good', '--detach'];

    let spawnCmd: string[] = [];
    try {
      const commandPromise = workflowRejectCommand(
        'run-123',
        'not good',
        undefined,
        undefined,
        true
      );
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('reject');
    expect(spawnCmd).toContain('run-123');
    expect((workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mock.calls.length).toBe(
      updateBefore
    );
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls.length).toBe(execBefore);
    expect(consoleSpy).toHaveBeenCalledWith("Started 'reject' for run run-123 in the background.");
  });

  it('resume --detach spawns a detached child (minus --detach) and does NOT execute in the parent', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    // resume validates read-only via resumeWorkflowOp, which reads getWorkflowRun;
    // a failed run is resumable.
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      ...pausedRun,
      status: 'failed',
    });
    await silenceLogFile();

    const execBefore = (executeWorkflow as ReturnType<typeof mock>).mock.calls.length;
    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'resume', 'run-123', '--detach'];

    let spawnCmd: string[] = [];
    try {
      // Signature: (runId, json, cwd, detach) — detach is the 4th arg.
      const commandPromise = workflowResumeCommand('run-123', undefined, undefined, true);
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    expect(spawnCmd).not.toContain('--detach');
    expect(spawnCmd).toContain('resume');
    expect(spawnCmd).toContain('run-123');
    expect((executeWorkflow as ReturnType<typeof mock>).mock.calls.length).toBe(execBefore);
  });
});

describe('buildDetachedRunCmd', () => {
  // BUNDLED_IS_BINARY is a module-level const (mocked false), so the binary
  // branch is unreachable through spawnDetachedWorkflowRun — exercise both
  // branches directly via the pure builder.

  it('dev mode: keeps [execPath, entryScript], slices argv(2), drops --detach/--json', () => {
    const cmd = buildDetachedRunCmd(
      false,
      '/path/to/bun',
      ['/path/to/bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach', '--json'],
      '/abs/cwd',
      ['--branch', 'assist-123', '--conversation-id', 'cli-1']
    );

    expect(cmd[0]).toBe('/path/to/bun');
    expect(cmd[1]).toBe('/abs/cli.ts');
    expect(cmd).not.toContain('--detach');
    expect(cmd).not.toContain('--json');
    expect(cmd).toContain('assist');
    // --cwd pinned absolute, then extra flags
    const cwdIdx = cmd.indexOf('--cwd');
    expect(cmd[cwdIdx + 1]).toBe('/abs/cwd');
    expect(cmd).toContain('--branch');
    expect(cmd).toContain('--conversation-id');
  });

  // A Bun single-file executable's argv is NOT [binary, ...userArgs]. Bun
  // injects a virtual entry path at argv[1] and reports argv[0] as 'bun':
  //   ['bun', '/$bunfs/root/archon', 'workflow', 'run', ...]
  // Verified against a real `bun build --compile` artifact. The previous
  // fixture modelled a compiled argv with no argv[1] at all, which is why
  // #2248 (detached child dies with `Unknown command: B:/~BUN/root/...`)
  // shipped green.
  // `--input` is the first repeatable flag in the tree (#2554). Nothing here handles
  // repetition specially — argv is forwarded verbatim — so this pins the property a
  // future change to the argv rebuild could silently break, turning a detached run into
  // one that starts with its inputs missing instead of failing.
  it('forwards every repeated --input to the detached child', () => {
    const cmd = buildDetachedRunCmd(
      false,
      '/path/to/bun',
      [
        '/path/to/bun',
        '/abs/cli.ts',
        'workflow',
        'run',
        'review-block',
        '--input',
        'diff=D1',
        '--input',
        'style=terse',
        '--detach',
      ],
      '/abs/cwd',
      []
    );

    expect(cmd.filter(arg => arg === '--input')).toHaveLength(2);
    expect(cmd).toContain('diff=D1');
    expect(cmd).toContain('style=terse');
    expect(cmd).not.toContain('--detach');
  });

  it('binary mode: uses [execPath] only (no duplicated entry arg), drops the Bun SFE virtual argv[1]', () => {
    const cmd = buildDetachedRunCmd(
      true,
      '/usr/local/bin/archon',
      ['bun', '/$bunfs/root/archon', 'workflow', 'run', 'assist', 'hello', '--detach', '--json'],
      '/abs/cwd',
      ['--branch', 'assist-123']
    );

    expect(cmd[0]).toBe('/usr/local/bin/archon');
    // The binary path must appear exactly once — never duplicated as argv[1].
    expect(cmd.filter(arg => arg === '/usr/local/bin/archon')).toHaveLength(1);
    // The virtual entry path must never reach the child: cli.ts parses
    // process.argv.slice(2), so a leaked argv[1] becomes the child's command.
    expect(cmd.some(arg => arg.includes('$bunfs'))).toBe(false);
    expect(cmd[1]).toBe('workflow');
    expect(cmd).not.toContain('--detach');
    expect(cmd).not.toContain('--json');
    const cwdIdx = cmd.indexOf('--cwd');
    expect(cmd[cwdIdx + 1]).toBe('/abs/cwd');
    expect(cmd.slice(cwdIdx + 2)).toEqual(['--branch', 'assist-123']);
  });

  it('binary mode: drops the Windows Bun SFE virtual argv[1] (#2248 repro)', () => {
    const cmd = buildDetachedRunCmd(
      true,
      'C:\\Users\\dev\\archon.exe',
      [
        'bun',
        'B:/~BUN/root/archon-windows-x64.exe',
        'workflow',
        'run',
        'assist',
        'hello',
        '--detach',
        '--json',
      ],
      'C:\\checkout',
      ['--branch', 'assist-123']
    );

    expect(cmd[0]).toBe('C:\\Users\\dev\\archon.exe');
    // The exact token that appeared as `Unknown command: ...` in the report.
    expect(cmd).not.toContain('B:/~BUN/root/archon-windows-x64.exe');
    expect(cmd[1]).toBe('workflow');
    expect(cmd[2]).toBe('run');
  });
});

describe('resolveDetachedRunEncryptionEnv', () => {
  it('pins both absence and a relative home before the child changes cwd', () => {
    expect(resolveDetachedRunEncryptionEnv({}, '/parent/repo')).toEqual({
      TOKEN_ENCRYPTION_KEY: '',
      ARCHON_HOME: '',
      ARCHON_DOCKER: '',
      WORKSPACE_PATH: '',
      HOME: '',
    });
    expect(
      resolveDetachedRunEncryptionEnv(
        { TOKEN_ENCRYPTION_KEY: 'install-key', ARCHON_HOME: './relative-home' },
        '/parent/repo'
      )
    ).toEqual({
      TOKEN_ENCRYPTION_KEY: 'install-key',
      ARCHON_HOME: resolve('/parent/repo', 'relative-home'),
      ARCHON_DOCKER: '',
      WORKSPACE_PATH: '',
      HOME: '',
    });
    expect(resolveDetachedRunEncryptionEnv({ ARCHON_HOME: '~/.archon-custom' }, '/parent')).toEqual(
      {
        TOKEN_ENCRYPTION_KEY: '',
        ARCHON_HOME: join(homedir(), '.archon-custom'),
        ARCHON_DOCKER: '',
        WORKSPACE_PATH: '',
        HOME: '',
      }
    );
    const dockerHandoff = resolveDetachedRunEncryptionEnv(
      { ARCHON_DOCKER: 'true', ARCHON_HOME: '/ignored-custom-home' },
      '/parent'
    );
    expect(dockerHandoff).toEqual({
      TOKEN_ENCRYPTION_KEY: '',
      ARCHON_HOME: '/.archon',
      ARCHON_DOCKER: 'true',
      WORKSPACE_PATH: '',
      HOME: '',
    });
    expect(isDocker(dockerHandoff)).toBe(true);
    expect(getArchonHome(dockerHandoff)).toBe('/.archon');
  });
});

describe('workflowResumeCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowResumeCommand('missing-id')).rejects.toThrow(
      'Workflow run not found: missing-id'
    );
  });

  it('should throw when run is not resumable', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'test',
      status: 'completed',
    });

    await expect(workflowResumeCommand('run-1')).rejects.toThrow(
      "Cannot resume run with status 'completed'"
    );
  });

  it('should print resume info and delegate to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
    });

    // workflowResumeCommand calls workflowRunCommand internally which needs many
    // mocks. The --resume execution flow is tested separately in workflowRunCommand tests.
    // Here we only verify the initial output by catching the downstream error.
    try {
      await workflowResumeCommand('run-1');
    } catch {
      // workflowRunCommand will fail due to missing mocks — that's fine
    }

    // Printed resume message before delegating to workflowRunCommand
    expect(consoleSpy).toHaveBeenCalledWith('Resuming workflow: implement');
    expect(consoleSpy).toHaveBeenCalledWith('Path: /tmp/test-worktree');
  });

  it('should throw when run has no working path', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-no-path',
      workflow_name: 'implement',
      status: 'failed',
      working_path: null,
    });

    await expect(workflowResumeCommand('run-no-path')).rejects.toThrow(
      'has no working path recorded'
    );
  });

  it('should pass codebase_id from run record to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-existing',
    });

    // Return a matching workflow so workflowRunCommand doesn't throw before codebase lookup
    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    // Simulate getCodebase returning the codebase found by ID
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-existing',
      name: 'owner/repo',
      default_cwd: '/path/to/main-checkout', // different from working_path
    });

    try {
      await workflowResumeCommand('run-1');
    } catch {
      // workflowRunCommand may fail on other mocks — that's fine
    }

    // getCodebase SHOULD have been called with the stored codebase_id
    expect(codebaseDb.getCodebase).toHaveBeenCalledWith('cb-existing');
  });

  it('fails loudly when getCodebase throws during resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-err',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-bad',
    });

    // getCodebase throws — simulates DB hiccup
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('connection refused')
    );

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(workflowResumeCommand('run-err')).rejects.toThrow(
      "Failed to load codebase 'cb-bad' for workflow run 'run-err'"
    );

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-bad' }),
      'cli.workflow_resume_codebase_lookup_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith('/tmp/test-worktree', expect.any(Function));
  });

  it('fails loudly when codebase row is missing during resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-missing-codebase',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-missing',
    });
    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(workflowResumeCommand('run-missing-codebase')).rejects.toThrow(
      "references codebase 'cb-missing', but that codebase no longer exists"
    );
    expect(discoverSpy).not.toHaveBeenCalledWith('/tmp/test-worktree', expect.any(Function));
  });

  it('should discover workflows from codebase.default_cwd, not working_path', async () => {
    // Regression test for #1663: when working_path is a worktree or workspace
    // clone that lacks the user's local workflow YAML, discovery must fall back
    // to codebase.default_cwd so the file is still found.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1663',
      workflow_name: 'my-approval-workflow',
      status: 'failed',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-with-yaml',
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-with-yaml',
      name: 'owner/repo',
      default_cwd: '/users/me/source-repo-with-yaml',
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowResumeCommand('run-1663');
    } catch {
      // downstream failure is acceptable — we only need to assert the discovery cwd
    }

    // A continuation takes no new capture, so discovery still reads the codebase source
    // path directly — #1663's guarantee, unchanged.
    expect(discoverSpy).toHaveBeenCalledWith(
      '/users/me/source-repo-with-yaml',
      expect.any(Function)
    );
  });

  it('should fall back to working_path for discovery when codebase_id is missing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-no-codebase',
      workflow_name: 'legacy',
      status: 'failed',
      user_message: 'go',
      working_path: '/tmp/old-worktree',
      codebase_id: null,
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowResumeCommand('run-no-codebase');
    } catch {
      // downstream failure is acceptable
    }

    // No codebase → falls back to working_path (preserves existing behavior)
    expect(discoverSpy).toHaveBeenCalledWith('/tmp/old-worktree', expect.any(Function));
  });

  it('resolves the covering codebase by path prefix instead of re-registering the worktree working_path (#2127)', async () => {
    // Regression for #2127: resuming from a worktree working_path whose run has
    // no codebase_id must resolve the covering registered codebase via prefix
    // lookup (like `workflow run` does) — NOT fall through to auto-registration,
    // which trips the source-symlink guard for an already-covered path.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const { registerRepository } = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-2127',
      workflow_name: 'implement',
      status: 'failed',
      user_message: 'go',
      working_path: '/registered/root/worktrees/feat',
      codebase_id: null,
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    // Exact default_cwd match misses (worktree path != registered root); the
    // path-prefix lookup resolves the covering repo codebase.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-registered',
      name: 'coleam00/Archon',
      default_cwd: '/registered/root',
      kind: 'repo',
    });

    // If resolution regressed to auto-registration, this is what would run — and
    // fail with the source-symlink-mismatch guard the issue reported. Clear the
    // module-level mock's history first so the not-called assertion is scoped to
    // this test (other tests in the file exercise auto-registration).
    (registerRepository as ReturnType<typeof mock>).mockClear();
    (registerRepository as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('Source symlink at ~/.archon/workspaces/coleam00/Archon/source already points to')
    );

    // With the codebase resolved, resume proceeds past the registration step and fails
    // later, on the working path this fixture never creates. The point is that it does NOT
    // surface the registration-failure error. (It used to stop one step earlier, on a
    // re-lookup by name; an id-form resume now continues the run it was handed, so it
    // reaches the working-path probe instead.)
    await expect(workflowResumeCommand('run-2127')).rejects.toThrow(
      'the working path from the run no longer exists'
    );

    expect(codebaseDb.findCodebaseByPathPrefix).toHaveBeenCalledWith(
      '/registered/root/worktrees/feat'
    );
    expect(registerRepository).not.toHaveBeenCalled();
  });
});

describe('workflowApproveCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowApproveCommand('missing-id')).rejects.toThrow(
      'Workflow run not found: missing-id'
    );
  });

  it('should pass codebase_id from run record to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-1',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-existing',
      metadata: { approval: { nodeId: 'review-node' } },
    });

    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-existing',
      name: 'owner/repo',
      default_cwd: '/path/to/main-checkout',
    });

    try {
      await workflowApproveCommand('run-approve-1');
    } catch {
      // downstream failure is acceptable
    }

    expect(codebaseDb.getCodebase).toHaveBeenCalledWith('cb-existing');
  });

  it('fails loudly when codebase row is missing during approve auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-missing-codebase',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-missing',
      metadata: { approval: { type: 'approval', nodeId: 'review-node', message: 'Approve?' } },
    });
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockResolvedValueOnce(null);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(workflowApproveCommand('run-approve-missing-codebase')).rejects.toThrow(
      "Approved but failed to resume workflow 'implement': Workflow run 'run-approve-missing-codebase' references codebase 'cb-missing', but that codebase no longer exists"
    );
    expect(discoverSpy).not.toHaveBeenCalledWith('/tmp/test-worktree', expect.any(Function));
  });

  it('fails with recorded-approval recovery when getCodebase throws during approve auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-codebase-error',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-bad',
      metadata: { approval: { type: 'approval', nodeId: 'review-node', message: 'Approve?' } },
    });
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockRejectedValueOnce(new Error('database offline'));

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(workflowApproveCommand('run-approve-codebase-error')).rejects.toThrow(
      "Approved but failed to resume workflow 'implement': Failed to load codebase 'cb-bad' for workflow run 'run-approve-codebase-error': database offline\n" +
        'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
        'Fix the codebase lookup problem, then retry.\n' +
        "The approval was recorded. Run 'bun run cli workflow resume run-approve-codebase-error' to retry."
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-bad' }),
      'cli.workflow_approve_codebase_lookup_failed'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-approve-codebase-error' }),
      'cli.workflow_approve_resume_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith('/tmp/test-worktree', expect.any(Function));
  });

  it('should pass original platform conversation ID through to workflowRunCommand', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const conversationsDb = await import('@archon/core/db/conversations');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-conv',
      workflow_name: 'implement',
      status: 'paused',
      user_message: 'add auth',
      working_path: '/tmp/test-worktree',
      codebase_id: 'cb-existing',
      conversation_id: 'db-uuid-original',
      metadata: { approval: { nodeId: 'review-node', message: 'Approve?' } },
    });

    // Return a conversation with the original platform ID
    (conversationsDb.getConversationById as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'db-uuid-original',
      platform_type: 'cli',
      platform_conversation_id: 'cli-original-123',
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'implement' })],
      errors: [],
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-existing',
      name: 'owner/repo',
      default_cwd: '/path/to/main-checkout',
    });

    // Clear call history before our test so we can assert precisely
    (conversationsDb.getOrCreateConversation as ReturnType<typeof mock>).mockClear();

    try {
      await workflowApproveCommand('run-approve-conv');
    } catch {
      // downstream failure is acceptable — we only need to reach getOrCreateConversation
    }

    // Verify the original platform conversation ID was passed through
    expect(conversationsDb.getConversationById).toHaveBeenCalledWith('db-uuid-original');
    expect(conversationsDb.getOrCreateConversation).toHaveBeenCalledWith('cli', 'cli-original-123');
  });

  it('should discover workflows from codebase.default_cwd, not working_path', async () => {
    // Regression test for #1663: auto-resume after approve must look up the
    // workflow YAML in the source repo (codebase.default_cwd), not the
    // worktree/workspace working_path that may lack the file.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-approve-1663',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-with-yaml',
      metadata: { approval: { nodeId: 'gate', message: 'Approve?' } },
    });

    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-with-yaml',
      name: 'owner/repo',
      default_cwd: '/users/me/source-repo-with-yaml',
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowApproveCommand('run-approve-1663');
    } catch {
      // downstream failure is acceptable
    }

    expect(discoverSpy).toHaveBeenCalledWith(
      '/users/me/source-repo-with-yaml',
      expect.any(Function)
    );
  });
});

describe('workflowAbandonCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowAbandonCommand('missing-id')).rejects.toThrow(
      'Workflow run not found: missing-id'
    );
  });

  it('should throw when run is not abandonable', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'test',
      status: 'completed',
    });

    await expect(workflowAbandonCommand('run-1')).rejects.toThrow(
      "Cannot abandon run with status 'completed'"
    );
  });

  it('should abandon a running workflow', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'implement',
      status: 'running',
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      cancelled: true,
    });

    await workflowAbandonCommand('run-1');

    expect(workflowDb.cancelWorkflowRun).toHaveBeenCalledWith('run-1');
    expect(consoleSpy).toHaveBeenCalledWith('Abandoned workflow run: run-1');
  });
});

describe('workflowCancelCommand', () => {
  const runId = '12345678-1234-1234-1234-123456789abc';
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockRequestDetachedRunStop.mockReset();
    mockRequestDetachedRunStop.mockResolvedValue({
      stop: mockDetachedTargetStop,
      release: mockDetachedTargetRelease,
    });
    mockDetachedTargetStop.mockReset();
    mockDetachedTargetStop.mockResolvedValue();
    mockDetachedTargetRelease.mockClear();
    mockReclaimContainerEnv.mockReset();
    mockReclaimContainerEnv.mockResolvedValue();

    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      cancelled: true,
    });
    (workflowDb.findChildRuns as ReturnType<typeof mock>).mockReset();
    (workflowDb.findChildRuns as ReturnType<typeof mock>).mockResolvedValue([]);
    (isolationDb.getById as ReturnType<typeof mock>).mockReset();
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('stops the live process tree before recording cancellation', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const order: string[] = [];
    const row = { id: runId, workflow_name: 'implement', status: 'running' };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue(row);
    mockRequestDetachedRunStop.mockImplementation(async () => {
      order.push('owner');
      return {
        stop: async () => {
          order.push('terminate');
        },
        release: mockDetachedTargetRelease,
      };
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockImplementation(async () => {
      order.push('cancel-state');
      return { cancelled: true };
    });

    await workflowCancelCommand(runId);

    expect(order).toEqual(['owner', 'terminate', 'cancel-state']);
    expect(mockRequestDetachedRunStop).toHaveBeenCalledWith(runId);
    expect(consoleSpy).toHaveBeenCalledWith(
      'Host process tree stopped before run state was changed.'
    );
  });

  it('leaves run state unchanged when no live detached owner answers', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
    });
    mockRequestDetachedRunStop.mockRejectedValue(
      new Error('No live detached owner; run unchanged')
    );

    await workflowCancelCommand(runId, true);

    expect(mockDetachedTargetStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      runId,
      action: 'cancel',
      error: 'No live detached owner; run unchanged',
    });
  });

  it('leaves run state unchanged when process-tree termination fails', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
    });
    mockDetachedTargetStop.mockRejectedValue(new Error('process still exists'));

    await workflowCancelCommand(runId, true);

    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: 'process still exists',
    });
  });

  it('confirms container teardown before recording cancellation', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    const order: string[] = [];
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'container-env-1' },
    });
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue({
      id: 'container-env-1',
      provider: 'container',
    });
    mockDetachedTargetStop.mockImplementation(async (): Promise<void> => {
      order.push('terminate-owner');
    });
    mockReclaimContainerEnv.mockImplementation(async (): Promise<void> => {
      order.push('reclaim-container');
    });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockImplementation(
      async (): Promise<{ cancelled: boolean }> => {
        order.push('cancel-state');
        return { cancelled: true };
      }
    );

    await workflowCancelCommand(runId, true);

    expect(order).toEqual([
      'terminate-owner',
      'reclaim-container',
      'cancel-state',
      'reclaim-container',
    ]);
    expect(mockReclaimContainerEnv).toHaveBeenCalledTimes(2);
    expect(mockReclaimContainerEnv).toHaveBeenCalledWith('container-env-1');
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: true,
      processStopped: true,
      status: 'cancelled',
    });
  });

  it('leaves state unchanged when container teardown cannot be confirmed', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'container-env-1' },
    });
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue({
      id: 'container-env-1',
      provider: 'container',
    });
    mockReclaimContainerEnv.mockRejectedValue(new Error('docker daemon unavailable'));

    await workflowCancelCommand(runId, true);

    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining(
        'isolation container could not be confirmed stopped. Run state was not changed'
      ),
    });
  });

  it('does not stop the owner when container tracking is unavailable', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container', isolation_env_id: 'missing-env' },
    });
    (isolationDb.getById as ReturnType<typeof mock>).mockResolvedValue(null);

    await workflowCancelCommand(runId, true);

    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining('Cannot confirm the isolation container'),
    });
  });

  it('does not stop the owner when a container run has no tracking ID', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    const isolationDb = require('@archon/core/db/isolation-environments');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'running',
      metadata: { isolation: 'container' },
    });

    await workflowCancelCommand(runId, true);

    expect(isolationDb.getById).not.toHaveBeenCalled();
    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining('container tracking ID is missing'),
    });
  });

  it('does not report cancellation when the state transition loses a race', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>)
      .mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'running',
      })
      .mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'running',
      })
      .mockResolvedValueOnce({
        id: runId,
        workflow_name: 'implement',
        status: 'completed',
      });
    (workflowDb.cancelWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      cancelled: false,
    });

    await workflowCancelCommand(runId, true);

    expect(mockDetachedTargetStop).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'cancel',
      error: expect.stringContaining(
        'The run status is completed; it was not reported as cancelled'
      ),
    });
  });

  it('refuses a non-running run without contacting a process owner', async () => {
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValue({
      id: runId,
      workflow_name: 'implement',
      status: 'cancelled',
    });

    await expect(workflowCancelCommand(runId)).rejects.toThrow(
      "Cannot actively cancel run with status 'cancelled'"
    );
    expect(mockRequestDetachedRunStop).not.toHaveBeenCalled();
    expect(workflowDb.cancelWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('workflowCleanupCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should print deletion count when runs are deleted', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      count: 5,
    });

    await workflowCleanupCommand(30);

    expect(consoleSpy).toHaveBeenCalledWith('Deleted 5 workflow run(s) older than 30 days.');
  });

  it('should print no-op message when count is 0', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockResolvedValueOnce({
      count: 0,
    });

    await workflowCleanupCommand(7);

    expect(consoleSpy).toHaveBeenCalledWith('No workflow runs older than 7 days to clean up.');
  });

  it('should throw when deleteOldWorkflowRuns fails', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.deleteOldWorkflowRuns as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('disk full')
    );

    await expect(workflowCleanupCommand(7)).rejects.toThrow(
      'Failed to clean up workflow runs: disk full'
    );
  });
});

describe('workflowRejectCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    mockLogger.error.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('should throw when run not found', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(null);

    await expect(workflowRejectCommand('missing-id')).rejects.toThrow();
  });

  it('should throw when run is not paused', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-1',
      workflow_name: 'my-wf',
      status: 'running',
      metadata: {},
    });

    await expect(workflowRejectCommand('run-1')).rejects.toThrow('Cannot reject run');
  });

  it('cancels immediately when no on_reject configured', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-plain',
      workflow_name: 'plain-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: { approval: { type: 'approval', nodeId: 'gate', message: 'Approve?' } },
    });
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    await workflowRejectCommand('run-plain', 'not good');

    // Terminal reject resolves + cancels atomically (#2113); the audit event
    // rides the same transaction (#2146).
    expect(workflowDb.resolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-plain',
      [
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: { decision: 'rejected', reason: 'not good' },
        },
      ],
      { step_name: 'gate', reason: 'approval_rejected' }
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected and cancelled'));
  });

  it('plain mode: rejecting with no reason defaults structured output text to "Rejected" (#2740)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-new-mode',
      workflow_name: 'new-mode-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });

    try {
      await workflowRejectCommand('run-new-mode');
    } catch {
      // A new-mode reject stays resumable and auto-resumes inline; the
      // downstream workflowRunCommand failure (no workflow discovered in this
      // unit test's fake cwd) is acceptable here — this test only cares about
      // what was recorded before that point.
    }

    // No `reason` argument at all — the CLI must default it to 'Rejected'
    // before it reaches rejectWorkflow, otherwise the new-mode structured
    // output (#2707) records an empty string instead (#2740).
    const structuredOutput = { decision: 'reject', text: 'Rejected' };
    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-new-mode',
      {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
          resolved: 'rejected',
        },
      },
      [
        {
          event_type: 'node_completed',
          step_name: 'gate',
          data: {
            node_output: JSON.stringify(structuredOutput),
            approval_decision: 'rejected',
            structured_output: structuredOutput,
          },
        },
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: { decision: 'rejected', reason: 'Rejected' },
        },
      ]
    );
  });

  it('--json mode: rejecting with no reason defaults structured output text to "Rejected" (#2740)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const jsonStdoutSpy = spyOnJsonStdout();

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-new-mode-json',
      workflow_name: 'new-mode-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'reject' }],
          decisionsAuthored: true,
        },
      },
    });

    await workflowRejectCommand('run-new-mode-json', undefined, true);

    const structuredOutput = { decision: 'reject', text: 'Rejected' };
    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-new-mode-json',
      expect.objectContaining({
        approval: expect.objectContaining({ resolved: 'rejected' }),
      }),
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'node_completed',
          step_name: 'gate',
          data: expect.objectContaining({ structured_output: structuredOutput }),
        }),
      ])
    );
    const parsed = JSON.parse(firstJsonPayload(jsonStdoutSpy)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ ok: true, runId: 'run-new-mode-json', action: 'reject' });
    jsonStdoutSpy.mockRestore();
  });

  it('updates metadata and auto-resumes when on_reject configured and under limit', async () => {
    const workflowDb = await import('@archon/core/db/workflows');

    const runData = {
      id: 'run-on-reject',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);

    try {
      await workflowRejectCommand('run-on-reject', 'needs work');
    } catch {
      // downstream workflowRunCommand failure is acceptable in this unit test
    }

    // Stays 'paused' (no status write) — rework staged atomically via the CAS on
    // the approval context (#2075/#2113), with the audit event in the same
    // transaction (#2146)
    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-on-reject',
      {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
          resolved: 'rejected',
        },
        rejection_reason: 'needs work',
        rejection_count: 1,
      },
      [
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: { decision: 'rejected', reason: 'needs work' },
        },
      ]
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Rejected workflow'));
  });

  it('should pass original platform conversation ID through on reject-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const conversationsDb = await import('@archon/core/db/conversations');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-conv',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      conversation_id: 'db-uuid-reject',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    // rejectWorkflow reads the run twice internally (getRunOrThrow + updateWorkflowRun check)
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);

    // Return a conversation with the original platform ID
    (conversationsDb.getConversationById as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'db-uuid-reject',
      platform_type: 'cli',
      platform_conversation_id: 'cli-reject-456',
    });

    (
      workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>
    ).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'my-wf' })],
      errors: [],
    });

    // Clear call history before our test so we can assert precisely
    (conversationsDb.getOrCreateConversation as ReturnType<typeof mock>).mockClear();

    try {
      await workflowRejectCommand('run-reject-conv', 'needs work');
    } catch {
      // downstream workflowRunCommand failure is acceptable — we only need to reach getOrCreateConversation
    }

    // Verify the original platform conversation ID was passed through
    expect(conversationsDb.getConversationById).toHaveBeenCalledWith('db-uuid-reject');
    expect(conversationsDb.getOrCreateConversation).toHaveBeenCalledWith('cli', 'cli-reject-456');
  });

  it('cancels when max attempts reached', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const core = await import('@archon/core');

    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-max',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 2,
      },
    });
    (core.createWorkflowStore as ReturnType<typeof mock>).mockReturnValueOnce({
      createWorkflowEvent: mock(() => Promise.resolve()),
    });

    await workflowRejectCommand('run-max', 'still bad');

    // Terminal reject resolves + cancels atomically (#2113); the audit event
    // rides the same transaction (#2146).
    expect(workflowDb.resolveAndCancelApprovalGate).toHaveBeenCalledWith(
      'run-max',
      [
        {
          event_type: 'approval_received',
          step_name: 'gate',
          data: { decision: 'rejected', reason: 'still bad' },
        },
      ],
      { step_name: 'gate', reason: 'approval_rejected' }
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('max attempts reached'));
  });

  it('throws when on_reject configured but working_path is null', async () => {
    const workflowDb = await import('@archon/core/db/workflows');

    const runData = {
      id: 'run-no-path',
      workflow_name: 'my-wf',
      status: 'paused',
      user_message: 'build it',
      working_path: null,
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    await expect(workflowRejectCommand('run-no-path', 'bad')).rejects.toThrow('no working path');
  });

  it('should discover workflows from codebase.default_cwd on reject-resume, not working_path', async () => {
    // Regression for #1663: reject with on_reject configured re-invokes
    // workflowRunCommand. Discovery must use the source repo, not the worktree.
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-1663',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-with-yaml',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    (codebaseDb.getCodebase as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-with-yaml',
      name: 'owner/repo',
      default_cwd: '/users/me/source-repo-with-yaml',
    });

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowRejectCommand('run-reject-1663', 'needs work');
    } catch {
      // downstream failure is acceptable
    }

    // A continuation takes no new capture, so discovery still reads the codebase source
    // path directly — #1663's guarantee, unchanged.
    expect(discoverSpy).toHaveBeenCalledWith(
      '/users/me/source-repo-with-yaml',
      expect.any(Function)
    );
  });

  it('fails loudly when getCodebase throws during reject auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-codebase-error',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-bad',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockRejectedValueOnce(new Error('database offline'));

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(workflowRejectCommand('run-reject-codebase-error', 'needs work')).rejects.toThrow(
      "Rejected but failed to resume workflow 'my-approval-workflow': Failed to load codebase 'cb-bad' for workflow run 'run-reject-codebase-error'"
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ codebaseId: 'cb-bad' }),
      'cli.workflow_reject_codebase_lookup_failed'
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-reject-codebase-error' }),
      'cli.workflow_reject_resume_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/worktree-without-yaml',
      expect.any(Function)
    );
  });

  it('fails with recorded-rejection recovery when codebase row is missing during reject auto-resume', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-missing-codebase',
      workflow_name: 'my-approval-workflow',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/worktree-without-yaml',
      codebase_id: 'cb-missing',
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);
    const getCodebaseMock = codebaseDb.getCodebase as ReturnType<typeof mock>;
    getCodebaseMock.mockReset();
    getCodebaseMock.mockResolvedValueOnce(null);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();

    await expect(
      workflowRejectCommand('run-reject-missing-codebase', 'needs work')
    ).rejects.toThrow(
      "Rejected but failed to resume workflow 'my-approval-workflow': Workflow run 'run-reject-missing-codebase' references codebase 'cb-missing', but that codebase no longer exists.\n" +
        'Cannot safely discover workflows from the run worktree because project workflow files may be missing.\n' +
        'Re-register the project or restore the codebase row, then retry.\n' +
        "The rejection was recorded. Run 'bun run cli workflow resume run-reject-missing-codebase' to retry."
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-reject-missing-codebase' }),
      'cli.workflow_reject_resume_failed'
    );
    expect(discoverSpy).not.toHaveBeenCalledWith(
      '/tmp/worktree-without-yaml',
      expect.any(Function)
    );
  });

  it('should fall back to working_path for discovery on reject when codebase_id is missing', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const workflowDiscovery = await import('@archon/workflows/workflow-discovery');

    const runData = {
      id: 'run-reject-no-codebase',
      workflow_name: 'legacy',
      status: 'paused',
      user_message: 'go',
      working_path: '/tmp/old-worktree',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          onRejectPrompt: 'Fix: $REJECTION_REASON',
          onRejectMaxAttempts: 3,
        },
        rejection_count: 0,
      },
    };
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(runData);
    (workflowDb.updateWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce(undefined);

    const discoverSpy = workflowDiscovery.discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverSpy.mockClear();
    discoverSpy.mockResolvedValueOnce({ workflows: [], errors: [] });

    try {
      await workflowRejectCommand('run-reject-no-codebase', 'bad');
    } catch {
      // downstream failure is acceptable
    }

    // No codebase → falls back to working_path (preserves existing behavior)
    expect(discoverSpy).toHaveBeenCalledWith('/tmp/old-worktree', expect.any(Function));
  });
});

// #2707 step 2 — the general drive verb. `approve`/`reject` are sugar (delegated
// directly to the existing commands); any other decision resolves through the new
// declared-decision path.
describe('workflowRespondCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("delegates 'approve' to the exact same resolution as workflowApproveCommand", async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-approve',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });

    try {
      await workflowRespondCommand('run-respond-approve', 'approve', 'looks good');
    } catch {
      // downstream workflowRunCommand failure is acceptable in this unit test
    }

    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-respond-approve',
      expect.objectContaining({
        approval: expect.objectContaining({ resolved: 'approved' }),
      }),
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'node_completed',
          data: expect.objectContaining({
            structured_output: { decision: 'approve', text: 'looks good' },
          }),
        }),
      ])
    );
  });

  it('resolves a declared non-default decision with the caller-supplied id', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-revise',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });

    try {
      await workflowRespondCommand('run-respond-revise', 'revise', 'needs more detail');
    } catch {
      // downstream workflowRunCommand failure is acceptable in this unit test
    }

    expect(workflowDb.resolveApprovalGate).toHaveBeenCalledWith(
      'run-respond-revise',
      expect.objectContaining({ approval_response: 'revise' }),
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'node_completed',
          data: expect.objectContaining({
            structured_output: { decision: 'revise', text: 'needs more detail' },
          }),
        }),
      ])
    );
  });

  it('rejects a decision the gate does not declare, naming the actual options', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-invalid',
      workflow_name: 'guided',
      status: 'paused',
      user_message: 'go',
      working_path: '/repo',
      codebase_id: null,
      metadata: {
        approval: {
          type: 'approval',
          nodeId: 'gate',
          message: 'Approve?',
          decisions: [{ id: 'approve' }, { id: 'revise' }],
          decisionsAuthored: true,
        },
      },
    });
    const resolveGateSpy = workflowDb.resolveApprovalGate as ReturnType<typeof mock>;
    resolveGateSpy.mockClear();

    await expect(
      workflowRespondCommand('run-respond-invalid', 'escalate', 'not sure')
    ).rejects.toThrow(/does not declare decision 'escalate'.*approve, revise/s);

    expect(resolveGateSpy).not.toHaveBeenCalled();
  });

  it('--detach validates read-only via assertRespondable before forking', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'run-respond-detach',
      workflow_name: 'guided',
      status: 'completed',
      working_path: '/repo',
      metadata: {},
    });
    const spawnSpy = spyOn(Bun, 'spawn');

    try {
      await expect(
        workflowRespondCommand('run-respond-detach', 'revise', undefined, false, undefined, true)
      ).rejects.toThrow(/Only paused runs can be approved/);
    } finally {
      spawnSpy.mockRestore();
    }
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('workflowRunCommand — progress rendering', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  type OutcomeExecutionResult =
    | { success: true; workflowRunId: string; paused?: true }
    | { success: false; workflowRunId: string; error: string };

  function setupWorkflowMocks(withAuthoredOutcome = false): void {
    // These need to be set up for each test since workflowRunCommand has many dependencies
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    const workflow = withAuthoredOutcome
      ? makeTestWorkflowWithSource({
          name: 'plan',
          description: 'Plan work',
          returns: 'result',
          outcome_field: 'ready',
          nodes: [
            {
              id: 'result',
              command: 'test-command',
              output_format: {
                type: 'object',
                properties: { ready: { type: 'boolean' } },
                required: ['ready'],
              },
            },
          ],
        })
      : makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' });
    discoverMock.mockResolvedValueOnce({
      workflows: [workflow],
      errors: [],
    });

    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });

    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });
  }

  async function runOutcomeFixture(
    execution: OutcomeExecutionResult,
    status: 'completed' | 'failed' | 'paused',
    outcome: 'succeeded' | 'failed' | null
  ): Promise<unknown> {
    setupWorkflowMocks(true);
    const { executeWorkflow } = require('@archon/workflows/executor');
    const workflowDb = require('@archon/core/db/workflows');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce(execution);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: execution.workflowRunId,
      status,
      outcome,
    });

    try {
      await workflowRunCommand('/test/path', 'plan', 'hello', {});
      return undefined;
    } catch (error) {
      return error;
    }
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    capturedSubscribeHandler = null;
    mockDetachedStopRequested = false;
    mockUnsubscribe.mockClear();
    mockStartRunLiveOwner.mockClear();
    mockRunLiveOwnerClose.mockClear();
    delete process.env.ARCHON_DETACHED_RUN_OWNER;
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('renders aligned completed execution and succeeded authored outcome', async () => {
    await runOutcomeFixture({ success: true, workflowRunId: 'run-1' }, 'completed', 'succeeded');

    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow finished.\n  Status: completed\n  Authored outcome: succeeded'
    );
  });

  it('renders completed execution separately from a failed authored outcome', async () => {
    await runOutcomeFixture({ success: true, workflowRunId: 'run-1' }, 'completed', 'failed');

    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow finished.\n  Status: completed\n  Authored outcome: failed'
    );
  });

  it('keeps a failed execution non-zero when the authored outcome succeeded', async () => {
    const thrown = await runOutcomeFixture(
      { success: false, workflowRunId: 'run-1', error: 'later node failed' },
      'failed',
      'succeeded'
    );

    expect(resolveCliExitCode(thrown)).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow finished.\n  Status: failed\n  Authored outcome: succeeded'
    );
  });

  it('renders a persisted succeeded outcome while execution is paused', async () => {
    await runOutcomeFixture(
      { success: true, paused: true, workflowRunId: 'run-1' },
      'paused',
      'succeeded'
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow paused — waiting for approval.\n  Status: paused\n  Authored outcome: succeeded'
    );
  });

  it('preserves the existing completion text when authored outcome is null', async () => {
    await runOutcomeFixture({ success: true, workflowRunId: 'run-1' }, 'completed', null);

    expect(consoleSpy).toHaveBeenCalledWith('\nWorkflow completed successfully.');
  });

  it('distinguishes an unavailable outcome read from an undeclared outcome', async () => {
    setupWorkflowMocks(true);
    const { executeWorkflow } = require('@archon/workflows/executor');
    const workflowDb = require('@archon/core/db/workflows');
    (executeWorkflow as ReturnType<typeof mock>).mockResolvedValueOnce({
      success: true,
      workflowRunId: 'run-1',
    });
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('database unavailable')
    );

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(consoleSpy).toHaveBeenCalledWith(
      '\nWorkflow finished.\n  Status: completed\n  Authored outcome: unavailable — failed to read persisted run'
    );
  });

  it('should subscribe to emitter when not quiet', async () => {
    setupWorkflowMocks();

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    // capturedSubscribeHandler is set when subscribeForConversation is called
    expect(capturedSubscribeHandler).not.toBeNull();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('renders the executor-owned transcript path at workflow start unless quiet', async () => {
    const { executeWorkflow } = require('@archon/workflows/executor');
    const emitWorkflowStart = async (): Promise<{ success: true; workflowRunId: string }> => {
      capturedSubscribeHandler?.({
        type: 'workflow_started',
        runId: 'run-1',
        workflowName: 'plan',
        conversationId: 'conv-1',
        transcriptPath: '/archon/workspaces/acme/widget/logs/run-1.jsonl',
      });
      return { success: true, workflowRunId: 'run-1' };
    };
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(emitWorkflowStart);

    setupWorkflowMocks();
    await workflowRunCommand('/test/path', 'plan', 'hello', {});
    expect(stderrSpy).toHaveBeenCalledWith(
      '[workflow] Transcript: /archon/workspaces/acme/widget/logs/run-1.jsonl\n'
    );

    stderrSpy.mockClear();
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(emitWorkflowStart);
    setupWorkflowMocks();
    await workflowRunCommand('/test/path', 'plan', 'hello', { quiet: true });
    expect(stderrSpy).not.toHaveBeenCalledWith(
      '[workflow] Transcript: /archon/workspaces/acme/widget/logs/run-1.jsonl\n'
    );
  });

  it('should subscribe (for run-id tracking) but not render when quiet', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_started',
          runId: 'run-1',
          nodeId: 'classify',
          nodeName: 'classify',
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', { quiet: true });

    // quiet still subscribes — the handler tracks the owned run id for the
    // signal cleanup guard (#1123) — but renders no progress output.
    expect(capturedSubscribeHandler).not.toBeNull();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalledWith('[classify] Started\n');
  });

  it('should call unsubscribe after executeWorkflow completes', async () => {
    setupWorkflowMocks();

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('should write node_started event to stderr', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_started',
          runId: 'run-1',
          nodeId: 'classify',
          nodeName: 'classify',
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith('[classify] Started\n');
  });

  it('should write node_started with provider/model/tier suffix for tier-resolved nodes', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_started',
          runId: 'run-1',
          nodeId: 'implement',
          nodeName: 'implement',
          provider: 'claude',
          model: 'opus',
          tier: 'large',
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith('[implement] Started  (claude/opus ← large)\n');
  });

  it('should write node_started with provider/model suffix (no tier) for literal-model nodes', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_started',
          runId: 'run-1',
          nodeId: 'classify',
          nodeName: 'classify',
          provider: 'claude',
          model: 'claude-haiku-4-5',
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith('[classify] Started  (claude/claude-haiku-4-5)\n');
  });

  it('should write a bare node_started line when no provider/model (bash/script node)', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_started',
          runId: 'run-1',
          nodeId: 'build',
          nodeName: 'build',
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith('[build] Started\n');
  });

  it('should write node_completed event with duration to stderr', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_completed',
          runId: 'run-1',
          nodeId: 'classify',
          nodeName: 'classify',
          duration: 12400,
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith('[classify] Completed (12.4s)\n');
  });

  it('should write node_failed event to stderr', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_failed',
          runId: 'run-1',
          nodeId: 'classify',
          nodeName: 'classify',
          error: 'timeout exceeded',
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith('[classify] Failed: timeout exceeded\n');
  });

  it('should write node_skipped event to stderr', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_skipped',
          runId: 'run-1',
          nodeId: 'deploy',
          nodeName: 'deploy',
          reason: 'when_condition',
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith('[deploy] Skipped (when_condition)\n');
  });

  it('should write approval_pending event to stderr', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'approval_pending',
          runId: 'run-1',
          nodeId: 'review',
          message: 'Please review the changes',
        });
      }
      return { success: true, workflowRunId: 'run-1', paused: true };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith(
      '[review] Waiting for approval: Please review the changes\n'
    );
  });

  it('should not write tool_started without verbose', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'tool_started',
          runId: 'run-1',
          toolName: 'Bash',
          stepName: 'classify',
          toolCallId: 'call-1',
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('tool: Bash'));
  });

  it('should write tool_started with verbose', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'tool_started',
          runId: 'run-1',
          toolName: 'Bash',
          stepName: 'classify',
          toolCallId: 'call-1',
        });
        capturedSubscribeHandler({
          type: 'tool_completed',
          runId: 'run-1',
          toolName: 'Bash',
          stepName: 'classify',
          durationMs: 42,
          toolCallId: 'call-1',
          toolOutcome: 'error',
          exitCode: 1,
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', { verbose: true });

    expect(stderrSpy).toHaveBeenCalledWith('[classify] tool: Bash (started, call-1)\n');
    expect(stderrSpy).toHaveBeenCalledWith('[classify] tool: Bash (42ms, call-1, error, exit 1)\n');
  });

  it('should render a legacy tool completion without optional metadata', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'tool_completed',
          runId: 'run-1',
          toolName: 'Bash',
          stepName: 'classify',
          durationMs: 42,
          toolCallId: 'call-1',
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', { verbose: true });

    expect(stderrSpy).toHaveBeenCalledWith('[classify] tool: Bash (42ms, call-1)\n');
  });

  it('should call unsubscribe even when executeWorkflow throws', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error('executor crashed');
    });

    await expect(workflowRunCommand('/test/path', 'plan', 'hello', {})).rejects.toThrow(
      'executor crashed'
    );

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('should write node_completed with sub-second duration to stderr', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_completed',
          runId: 'run-1',
          nodeId: 'fast',
          nodeName: 'fast',
          duration: 500,
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith('[fast] Completed (500ms)\n');
  });

  it('should write node_completed with minutes duration to stderr', async () => {
    setupWorkflowMocks();

    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      if (capturedSubscribeHandler) {
        capturedSubscribeHandler({
          type: 'node_completed',
          runId: 'run-1',
          nodeId: 'slow',
          nodeName: 'slow',
          duration: 90000,
        });
      }
      return { success: true, workflowRunId: 'run-1' };
    });

    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(stderrSpy).toHaveBeenCalledWith('[slow] Completed (1m30s)\n');
  });
});

// ---------------------------------------------------------------------------
// Signal cleanup guard (#1123) — SIGTERM/SIGINT handlers must be run-scoped,
// status-guarded, and removed once executeWorkflow settles.
// ---------------------------------------------------------------------------

describe('workflowRunCommand — signal cleanup guard (#1123)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  function setupWorkflowMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan work' })],
      errors: [],
    });

    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-1',
      platform: 'cli',
      platform_conversation_id: 'cli-123',
      title: null,
      is_active: true,
      codebase_id: null,
    });

    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test-repo',
      default_cwd: '/test/path',
    });
  }

  /** Flush the cleanup handler's fire-and-forget promise chain. */
  async function settleCleanup(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /** The SIGTERM listeners added since `baseline` (i.e. by the command under test). */
  function addedSigtermListeners(baseline: readonly unknown[]): Array<() => void> {
    return process.listeners('SIGTERM').filter(listener => !baseline.includes(listener)) as Array<
      () => void
    >;
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    // The cleanup chain ends in process.exit(1) — neuter it so invoking the
    // handler in-process doesn't kill the test runner.
    exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    capturedSubscribeHandler = null;
    mockDetachedStopRequested = false;
    mockAssertDetachedRunProcessOwner.mockReset();
    mockAssertDetachedRunProcessOwner.mockImplementation(() => undefined);
    mockStartRunLiveOwner.mockClear();
    mockRunLiveOwnerClose.mockClear();
    mockUnsubscribe.mockClear();

    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.failWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowsDb.getActiveWorkflowRun as ReturnType<typeof mock>).mockClear();
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockReset();
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.ARCHON_DETACHED_RUN_OWNER;
  });

  it('removes SIGTERM/SIGINT handlers once executeWorkflow settles (no leak, no stacking)', async () => {
    const sigtermBaseline = process.listenerCount('SIGTERM');
    const sigintBaseline = process.listenerCount('SIGINT');

    let duringRunSigterm = 0;
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(async () => {
      duringRunSigterm = process.listenerCount('SIGTERM');
      return { success: true, workflowRunId: 'run-1' };
    });

    setupWorkflowMocks();
    await workflowRunCommand('/test/path', 'plan', 'hello', {});
    expect(duringRunSigterm).toBe(sigtermBaseline + 1);
    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('test-run-id', {});
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBaseline);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);

    // A second invocation in the same process must not stack handlers either.
    setupWorkflowMocks();
    await workflowRunCommand('/test/path', 'plan', 'hello', {});
    expect(duringRunSigterm).toBe(sigtermBaseline + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBaseline);
    expect(process.listenerCount('SIGINT')).toBe(sigintBaseline);

    (executeWorkflow as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({ success: true, workflowRunId: 'test-run-id' })
    );
  });

  it('does not fail the run when it is paused at a new gate at signal time', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    // The run this process drives has committed its pause at the next gate.
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue('paused');

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      // The executor announced the run this process owns…
      capturedSubscribeHandler?.({
        type: 'workflow_started',
        runId: 'run-1',
        workflowName: 'plan',
        conversationId: 'conv-1',
        transcriptPath: '/logs/run-1.jsonl',
      });
      // …then the signal lands while the handler is still registered.
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      return { success: true, workflowRunId: 'run-1', paused: true };
    });

    setupWorkflowMocks();
    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    // Paused-at-gate is an external transition the signal handler must respect.
    expect(workflowsDb.failWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('still fails the run on a genuine mid-run interrupt (legacy behavior)', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue('running');
    const shutdownOrder: string[] = [];
    mockRunLiveOwnerClose.mockImplementationOnce(async () => {
      shutdownOrder.push('owner-close');
    });
    exitSpy.mockImplementationOnce((() => {
      shutdownOrder.push('exit');
    }) as never);

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      capturedSubscribeHandler?.({
        type: 'workflow_started',
        runId: 'run-1',
        workflowName: 'plan',
        conversationId: 'conv-1',
        transcriptPath: '/logs/run-1.jsonl',
      });
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      return { success: false, workflowRunId: 'run-1', error: 'interrupted' };
    });

    setupWorkflowMocks();
    await expect(workflowRunCommand('/test/path', 'plan', 'hello', {})).rejects.toThrow(
      'Workflow failed'
    );

    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      'Process terminated (SIGTERM)'
    );
    expect(shutdownOrder).toEqual(['owner-close', 'exit']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('lets an exact-run cancel controller own the lifecycle transition', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    // A detached child learns its run from the row its launcher handed over (#2872) —
    // the only shape the CLI produces for a fresh detached run.
    (workflowsDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'test-run-id',
      workflow_name: 'plan',
      status: 'pending',
      working_path: null,
      metadata: {},
    });

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    // Captured inside the run, once the signal handler has settled: the assertion is
    // that the SIGNAL path never consulted status, which a global "never called" no
    // longer isolates now that the startup-failure net reads it on the way out.
    let statusReadsAtSignalTime = -1;
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      mockDetachedStopRequested = true;
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      statusReadsAtSignalTime = (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mock
        .calls.length;
      return { success: false, workflowRunId: 'test-run-id', error: 'interrupted' };
    });

    setupWorkflowMocks();
    await expect(
      workflowRunCommand('/test/path', 'plan', 'hello', { detachedRunId: 'test-run-id' })
    ).rejects.toThrow('Workflow failed');

    expect(mockStartRunLiveOwner).toHaveBeenCalledWith('test-run-id', {
      detachedProcessPid: process.pid,
    });
    expect(statusReadsAtSignalTime).toBe(0);
    expect(workflowsDb.failWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRunLiveOwnerClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a detached marker when this process does not own its process group', async () => {
    process.env.ARCHON_DETACHED_RUN_OWNER = '1';
    mockAssertDetachedRunProcessOwner.mockImplementationOnce(() => {
      throw new Error('does not own process group');
    });

    await expect(workflowRunCommand('/test/path', 'plan', 'hello', {})).rejects.toThrow(
      'does not own process group'
    );

    expect(mockStartRunLiveOwner).not.toHaveBeenCalled();
    expect(process.env.ARCHON_DETACHED_RUN_OWNER).toBeUndefined();
  });

  it('uses the source-reserved run id before workflow_started is emitted', async () => {
    const workflowsDb = require('@archon/core/db/workflows');
    (workflowsDb.getWorkflowRunStatus as ReturnType<typeof mock>).mockResolvedValue('running');

    const sigtermBefore = process.listeners('SIGTERM');
    const { executeWorkflow } = require('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      // No workflow_started event is needed: source capture reserved the exact id
      // before execution or its live-owner endpoint became visible.
      const [handler] = addedSigtermListeners(sigtermBefore);
      expect(handler).toBeDefined();
      handler();
      await settleCleanup();
      return { success: true, workflowRunId: 'run-1' };
    });

    setupWorkflowMocks();
    await workflowRunCommand('/test/path', 'plan', 'hello', {});

    expect(workflowsDb.failWorkflowRun).toHaveBeenCalledWith(
      'test-run-id',
      'Process terminated (SIGTERM)'
    );
    expect(workflowsDb.getActiveWorkflowRun).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// extractStaleWorkspaceEntry — parser edge cases
// ---------------------------------------------------------------------------

describe('extractStaleWorkspaceEntry', () => {
  it('extracts the workspace dir from a POSIX source-symlink error', async () => {
    const { extractStaleWorkspaceEntry } = await import('./workflow');
    expect(
      extractStaleWorkspaceEntry(
        'Source symlink at /home/user/.archon/workspaces/acme/widget/source already points to /other, expected /here'
      )
    ).toBe('/home/user/.archon/workspaces/acme/widget');
  });

  it('extracts the workspace dir from a Windows source-symlink error (backslash sep)', async () => {
    const { extractStaleWorkspaceEntry } = await import('./workflow');
    expect(
      extractStaleWorkspaceEntry(
        'Source symlink at C:\\Users\\me\\.archon\\workspaces\\acme\\widget\\source already points to D:\\x, expected D:\\y'
      )
    ).toBe('C:\\Users\\me\\.archon\\workspaces\\acme\\widget');
  });

  it('returns null when the prefix does not match (unrelated error)', async () => {
    const { extractStaleWorkspaceEntry } = await import('./workflow');
    expect(extractStaleWorkspaceEntry('ENOENT: no such file or directory')).toBeNull();
  });

  it('returns null when the prefix matches but the delimiter is missing', async () => {
    const { extractStaleWorkspaceEntry } = await import('./workflow');
    expect(
      extractStaleWorkspaceEntry('Source symlink at /some/path (truncated message)')
    ).toBeNull();
  });

  it('returns null when the source path has no path separator at all', async () => {
    const { extractStaleWorkspaceEntry } = await import('./workflow');
    expect(
      extractStaleWorkspaceEntry('Source symlink at bareword already points to /x, expected /y')
    ).toBeNull();
  });

  it('returns null on an empty input', async () => {
    const { extractStaleWorkspaceEntry } = await import('./workflow');
    expect(extractStaleWorkspaceEntry('')).toBeNull();
  });
});

describe('workflowResetSessionsCommand', () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockDeleteNodeSessions.mockClear();
    mockDeleteNodeSessions.mockResolvedValue({ deleted: 0 });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('refuses a cross-scope reset without --scope and without --yes', async () => {
    await expect(workflowResetSessionsCommand('feature-dev', {})).rejects.toThrow(/Refusing/);
    expect(mockDeleteNodeSessions).not.toHaveBeenCalled();
  });

  it('proceeds across all scopes when --yes is given (no scope filter)', async () => {
    mockDeleteNodeSessions.mockResolvedValueOnce({ deleted: 4 });

    await workflowResetSessionsCommand('feature-dev', { yes: true });

    expect(mockDeleteNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'feature-dev',
      scope_key: undefined,
      node_id: undefined,
    });
    const calls: string[] = consoleSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls.some(c => c.includes('4') && c.includes('across all scopes'))).toBe(true);
  });

  it('proceeds with --scope and no --yes, narrowing to that scope', async () => {
    mockDeleteNodeSessions.mockResolvedValueOnce({ deleted: 1 });

    await workflowResetSessionsCommand('feature-dev', { scope: 'conv-1', node: 'planner' });

    expect(mockDeleteNodeSessions).toHaveBeenCalledWith({
      workflow_name: 'feature-dev',
      scope_key: 'conv-1',
      node_id: 'planner',
    });
  });

  it('emits machine-readable JSON when --json is set', async () => {
    mockDeleteNodeSessions.mockResolvedValueOnce({ deleted: 2 });

    await workflowResetSessionsCommand('feature-dev', { scope: 'conv-1', json: true });

    expect(firstJsonPayload(stdoutSpy)).toBe(
      JSON.stringify({ workflow: 'feature-dev', deleted: 2, scope: 'conv-1', node: null })
    );
  });
});

describe('maybePrintTierNotice', () => {
  const { loadConfig, getUserAiPrefs } = require('@archon/core') as {
    loadConfig: ReturnType<typeof mock>;
    getUserAiPrefs: ReturnType<typeof mock>;
  };
  const { readTierNoticeState, markTierNoticeShown } = require('@archon/paths') as {
    readTierNoticeState: ReturnType<typeof mock>;
    markTierNoticeShown: ReturnType<typeof mock>;
  };

  let stderrSpy: ReturnType<typeof spyOn>;

  function makeTierWorkflow(nodeModel?: string, workflowModel?: string) {
    return makeTestWorkflow({
      name: 'tier-test',
      ...(workflowModel !== undefined ? { model: workflowModel } : {}),
      nodes: [
        { id: 'n1', command: 'test-cmd', ...(nodeModel !== undefined ? { model: nodeModel } : {}) },
      ],
    });
  }

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    (readTierNoticeState as ReturnType<typeof mock>).mockReturnValue(null);
    (markTierNoticeShown as ReturnType<typeof mock>).mockClear();
    // assistant: 'claude' — a provider WITH built-in tier defaults, so the
    // notice has something truthful to announce (the no-built-ins case is
    // covered by its own test below).
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: {},
      assistant: 'claude',
    });
    (getUserAiPrefs as ReturnType<typeof mock>).mockResolvedValue({});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints nothing and returns when quiet=true', async () => {
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(workflow, '/cwd', undefined, true);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints nothing when no nodes use tier keywords', async () => {
    const workflow = makeTierWorkflow(undefined);
    await maybePrintTierNotice(workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('detects workflow-level tier keyword even when no per-node model is set', async () => {
    const workflow = makeTierWorkflow(undefined, 'large');
    await maybePrintTierNotice(workflow, '/cwd', undefined, false);
    expect(stderrSpy).toHaveBeenCalled();
    expect(markTierNoticeShown).toHaveBeenCalledWith('0.0.0-test');
  });

  it('prints nothing when the used tier is explicitly configured in install config', async () => {
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: { large: { provider: 'claude', model: 'opus' } },
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints nothing when the notice was already shown for this version', async () => {
    (readTierNoticeState as ReturnType<typeof mock>).mockReturnValue({
      shownForVersion: '0.0.0-test',
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(workflow, '/cwd', undefined, false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints the notice and marks shown when tier is unconfigured and not yet shown', async () => {
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(workflow, '/cwd', undefined, false);
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('model tiers');
    expect(markTierNoticeShown).toHaveBeenCalledWith('0.0.0-test');
  });

  it('prints nothing for a provider with no built-in tier defaults (and keeps the notice unshown)', async () => {
    (loadConfig as ReturnType<typeof mock>).mockResolvedValue({
      defaults: {},
      tiers: {},
      assistant: 'pi',
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(workflow, '/cwd', undefined, false);
    // No built-ins exist, so claiming "using built-in defaults" would be false —
    // the run's tier-resolution error owns the guidance. Not marked shown, so a
    // later provider switch still gets its one-time notice.
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('returns silently when loadConfig throws', async () => {
    (loadConfig as ReturnType<typeof mock>).mockRejectedValue(new Error('parse error'));
    const workflow = makeTierWorkflow('large');
    await expect(maybePrintTierNotice(workflow, '/cwd', undefined, false)).resolves.toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });

  it('prints nothing when user prefs already configure the tier', async () => {
    (getUserAiPrefs as ReturnType<typeof mock>).mockResolvedValue({
      tiers: { large: { provider: 'claude', model: 'claude-opus-4-8' } },
    });
    const workflow = makeTierWorkflow('large');
    await maybePrintTierNotice(workflow, '/cwd', 'user-1', false);
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(markTierNoticeShown).not.toHaveBeenCalled();
  });
});

describe('hasUnresolvedWriteback (H2 teardown-preserve decision)', () => {
  it('true when the gate was raised but never resolved (failed/partial apply)', () => {
    expect(hasUnresolvedWriteback({ pending_writeback: { envId: 'e' } })).toBe(true);
  });
  it('false once the write-back resolved (applied/discarded)', () => {
    expect(
      hasUnresolvedWriteback({ pending_writeback: { envId: 'e' }, writeback_resolved: true })
    ).toBe(false);
  });
  it('false for a run that never raised a write-back gate', () => {
    expect(hasUnresolvedWriteback({ isolation: 'container' })).toBe(false);
    expect(hasUnresolvedWriteback(undefined)).toBe(false);
  });
});

describe('resolveContainerBackendConfig', () => {
  it('applies defaults when config is absent', () => {
    const cfg = resolveContainerBackendConfig(undefined);
    expect(cfg).toEqual({
      image: 'archon-runner:latest',
      network: 'bridge',
      memoryMb: 4096,
      pidsLimit: 512,
    });
  });

  it('passes through valid values', () => {
    const cfg = resolveContainerBackendConfig({
      image: '  my-runner:1  ',
      network: 'none',
      memoryMb: 2048,
      pidsLimit: 256,
    });
    expect(cfg).toEqual({
      image: 'my-runner:1',
      network: 'none',
      memoryMb: 2048,
      pidsLimit: 256,
    });
  });

  it('rejects a non bridge/none network (no silent --network host)', () => {
    expect(() => resolveContainerBackendConfig({ network: 'host' })).toThrow(/bridge.*none/);
  });

  it('rejects a fractional memoryMb (docker --memory needs an integer)', () => {
    expect(() => resolveContainerBackendConfig({ memoryMb: 512.5 })).toThrow(/positive integer/);
  });

  it('rejects a non-integer / non-positive pidsLimit', () => {
    expect(() => resolveContainerBackendConfig({ pidsLimit: 10.5 })).toThrow(/positive integer/);
    expect(() => resolveContainerBackendConfig({ pidsLimit: 0 })).toThrow(/positive integer/);
  });
});

describe('workflowTestCommand', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    stdoutSpy = spyOnJsonStdout();
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockClear();
    (fixtureRunner.formatFixtureReport as ReturnType<typeof mock>).mockClear();
    mockDiscoverWorkflowsWithConfig.mockResolvedValue({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [],
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('emits one JSON document and exits 0 when every fixture passes', async () => {
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [
        {
          fixture: 'sdlc/plan/fixtures/ready.stubs.yaml',
          workflow: 'plan',
          expect: 'completed',
          outcome: 'completed',
          pass: true,
          missingStubs: [],
          toleratedMissingStubs: [],
          unusedStubs: ['spare'],
        },
      ],
      passed: 1,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', undefined, { json: true });

    expect(exit).toBe(0);
    expect(fixtureRunner.runFixtures).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/test/path' })
    );
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(firstJsonPayload(stdoutSpy));
    expect(payload.passed).toBe(1);
    expect(payload.failed).toBe(0);
    expect(payload.results[0]).toMatchObject({ fixture: 'sdlc/plan/fixtures/ready.stubs.yaml' });
  });

  it('keeps the invoking directory for relative fixture path targets', async () => {
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 0,
      failed: 0,
    });

    await workflowTestCommand('/test/repository', 'local-pack', {
      targetCwd: '/test/repository/tools',
    });

    expect(fixtureRunner.runFixtures).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/test/repository', targetCwd: '/test/repository/tools' })
    );
  });

  it('exits 1 when a fixture fails', async () => {
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [
        {
          fixture: 'f.stubs.yaml',
          workflow: 'plan',
          expect: 'completed',
          outcome: 'failed',
          pass: false,
          failureReason: 'expected completed, dry-run reported failed',
          missingStubs: [],
          toleratedMissingStubs: [],
          unusedStubs: [],
        },
      ],
      passed: 0,
      failed: 1,
    });

    const exit = await workflowTestCommand('/test/path', 'plan');
    expect(exit).toBe(1);
  });

  it('exits 1 when an explicitly named target has no fixtures', async () => {
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 0,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', 'no-fixtures');
    expect(exit).toBe(1);
  });

  it('exits 0 with no fixtures when no target was named', async () => {
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 0,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', undefined);
    expect(exit).toBe(0);
    expect(fixtureRunner.formatFixtureReport).toHaveBeenCalled();
  });

  it('reports load failures alongside passing fixture results and exits 1', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [
        {
          filename: 'broken.yaml',
          error: 'YAML parse error: unexpected end of document',
          errorType: 'parse_error',
        },
      ],
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 1,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', undefined);

    expect(exit).toBe(1);
    expect(fixtureRunner.runFixtures).toHaveBeenCalledWith(
      expect.objectContaining({
        workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      })
    );
    expect(firstJsonPayload(stdoutSpy)).toContain('1 workflow(s) failed to load:');
    expect(firstJsonPayload(stdoutSpy)).toContain(
      '  broken.yaml: YAML parse error: unexpected end of document'
    );
  });

  it('includes load failures in JSON fixture reports and exits 1', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    const error = {
      filename: 'broken.yaml',
      error: 'YAML parse error: unexpected end of document',
      errorType: 'parse_error' as const,
    };
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'plan' }, 'project')],
      errors: [error],
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 1,
      failed: 0,
    });

    const exit = await workflowTestCommand('/test/path', undefined, { json: true });

    expect(exit).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      results: [],
      passed: 1,
      failed: 0,
      errors: [error],
    });
  });

  it('reports load failures when fixture target selection fails', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [
        {
          filename: 'broken.yaml',
          error: 'YAML parse error: unexpected end of document',
          errorType: 'parse_error',
        },
      ],
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("No fixtures found for 'missing'.")
    );

    const exit = await workflowTestCommand('/test/path', 'missing');

    expect(exit).toBe(1);
    expect(firstJsonPayload(stdoutSpy)).toContain("Error: No fixtures found for 'missing'.");
    expect(firstJsonPayload(stdoutSpy)).toContain('1 workflow(s) failed to load:');
    expect(firstJsonPayload(stdoutSpy)).toContain(
      '  broken.yaml: YAML parse error: unexpected end of document'
    );
  });

  it('includes load failures when fixture target selection fails in JSON', async () => {
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    const error = {
      filename: 'broken.yaml',
      error: 'YAML parse error: unexpected end of document',
      errorType: 'parse_error' as const,
    };
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [],
      errors: [error],
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error("No fixtures found for 'missing'.")
    );

    const exit = await workflowTestCommand('/test/path', 'missing', { json: true });

    expect(exit).toBe(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: false,
      error: "No fixtures found for 'missing'.",
      errors: [error],
    });
  });

  it("freezes the repo's own command policy, not the default folders (#2851)", async () => {
    // The capture decides which directories a fixture can resolve a command from, so a
    // repo that moved `commands.folder` must have THAT folder frozen. Reading the value
    // here is the only place it can be read; `runFixtures` cannot load config itself.
    const core = await import('@archon/core');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (core.loadConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      commands: { folder: '.archon/prompts' },
      defaults: { loadDefaultCommands: false },
    });
    (fixtureRunner.runFixtures as ReturnType<typeof mock>).mockResolvedValue({
      results: [],
      passed: 0,
      failed: 0,
    });

    await workflowTestCommand('/test/path', undefined);

    expect(fixtureRunner.runFixtures).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceConfig: {
          load_default_workflows: true,
          load_default_commands: false,
          command_folder: '.archon/prompts',
        },
      })
    );
  });

  it('fails the fixture run when the config is unreadable instead of freezing defaults', async () => {
    // `loadConfig` returns defaults when there is no config file, so a throw means a
    // MALFORMED one. Proceeding would capture the standard folders and report green on
    // fixtures whose commands the real run would never find.
    const core = await import('@archon/core');
    const fixtureRunner = await import('@archon/workflows/fixture-runner');
    (core.loadConfig as ReturnType<typeof mock>).mockRejectedValueOnce(
      new Error('bad yaml at .archon/config.yaml:7')
    );

    await expect(workflowTestCommand('/test/path', undefined)).rejects.toThrow(/bad yaml/);
    expect(fixtureRunner.runFixtures).not.toHaveBeenCalled();
  });
});

describe('workflowRunCommand — adopt lane source recapture (#2660/#2747)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function setupAdoptMocks(
    lane:
      | {
          kind: 'reuse-worktree';
          workingPath: string;
          envId?: string;
        }
      | { kind: 'checkout-branch'; taskBranch: { kind: 'existing'; branch: string } } = {
      kind: 'reuse-worktree',
      workingPath: '/wt/adopted',
      envId: 'env-9',
    }
  ): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    const prepareMock = require('@archon/workflows/executor').prepareWorkflowSource as ReturnType<
      typeof mock
    >;
    discoverMock.mockReset();
    prepareMock.mockClear();
    // First discovery runs against the invoking checkout; the second must run against
    // the adopted lane's worktree and resolve the branch's vintage of the workflow.
    discoverMock
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Parent vintage' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Branch vintage' })],
        errors: [],
      });

    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'conv-adopt',
      platform_type: 'cli',
      platform_conversation_id: 'cli-adopt',
      title: null,
      is_active: true,
      codebase_id: null,
    });
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockResolvedValue(undefined);
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });

    const adoption = require('@archon/core/operations/workflow-adoption');
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockResolvedValueOnce({
      adoptedRun: { id: 'run-old' },
      lane,
    });
  }

  it('adopts a normal run from a unique short run id prefix', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: adoptedRunId },
    ]);

    await workflowRunCommand('/test/path/subdir', 'assist', 'hello', { adoptRunId: '0b1ee8da' });

    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-adopt');
    expect(adoption.resolveWorkflowAdoption).toHaveBeenCalledWith(
      expect.objectContaining({ adoptedRunId })
    );
  });

  it('rejects an ambiguous adopted run prefix with its candidates', async () => {
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-adopt',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', { adoptRunId: '0b1ee8da' })
    ).rejects.toThrow(
      '0b1ee8da-1111-2222-3333-444455556666\n  0b1ee8da-9999-8888-7777-666655554444'
    );
    expect(adoption.resolveWorkflowAdoption).not.toHaveBeenCalled();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockReset();
  });

  it('passes a full adopted run id through unchanged', async () => {
    const adoptedRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockClear();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockClear();
    setupAdoptMocks();

    await workflowRunCommand('/test/path', 'assist', 'hello', { adoptRunId: adoptedRunId });

    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(adoption.resolveWorkflowAdoption).toHaveBeenCalledWith(
      expect.objectContaining({ adoptedRunId })
    );
  });

  it('re-freezes workflow source from the inherited worktree on the reuse-worktree lane', async () => {
    setupAdoptMocks();
    const { executeWorkflow, prepareWorkflowSource } = await import('@archon/workflows/executor');

    await workflowRunCommand('/test/path', 'assist', 'hello', { adoptRunId: 'run-old' });

    const prepareCalls = (prepareWorkflowSource as ReturnType<typeof mock>).mock.calls;
    expect(prepareCalls).toHaveLength(2);
    expect((prepareCalls[0][1] as { sourceRoot: string }).sourceRoot).toBe('/test/path');
    expect((prepareCalls[1][1] as { sourceRoot: string }).sourceRoot).toBe('/wt/adopted');
    // The executor receives the branch-vintage graph, not the parent checkout's.
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect((executed[4] as { description: string }).description).toBe('Branch vintage');
    expect(executed[3]).toBe('/wt/adopted');
  });

  it('checks out the exact adopted branch when the prior worktree is gone', async () => {
    setupAdoptMocks({
      kind: 'checkout-branch',
      taskBranch: { kind: 'existing', branch: 'feature/live-pr' },
    });
    const isolation = await import('@archon/isolation');
    const { executeWorkflow } = await import('@archon/workflows/executor');
    const create = mock(() =>
      Promise.resolve({
        provider: 'worktree' as const,
        id: '/wt/recreated',
        workingPath: '/wt/recreated',
        branchName: 'feature/live-pr',
        status: 'active' as const,
        createdAt: new Date(),
        metadata: { adopted: true },
      })
    );
    (isolation.getIsolationProvider as ReturnType<typeof mock>).mockReturnValueOnce({
      create,
      healthCheck: mock(() => Promise.resolve(true)),
    });

    await workflowRunCommand('/test/path', 'assist', 'hello', { adoptRunId: 'run-old' });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowType: 'task',
        taskBranch: { kind: 'existing', branch: 'feature/live-pr' },
      })
    );
    const executed = (executeWorkflow as ReturnType<typeof mock>).mock.calls.at(-1) as unknown[];
    expect(executed[3]).toBe('/wt/recreated');
    const opts = executed.at(-1) as { adoptedFromRunId?: string };
    expect(opts.adoptedFromRunId).toBe('run-old');
  });

  it('re-judges the declared-input gate against the branch vintage after recapture', async () => {
    // The parent checkout's YAML declares no inputs, so the invocation gate on entry
    // passes an input-less call; only the adopted branch's YAML requires one.
    setupAdoptMocks();
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockReset();
    discoverMock
      .mockResolvedValueOnce({
        workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Parent vintage' })],
        errors: [],
      })
      .mockResolvedValueOnce({
        workflows: [
          makeTestWorkflowWithSource({
            name: 'assist',
            description: 'Branch vintage',
            inputs: { diff: { required: true } },
          }),
        ],
        errors: [],
      });
    const { executeWorkflow } = await import('@archon/workflows/executor');
    (executeWorkflow as ReturnType<typeof mock>).mockClear();

    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', { adoptRunId: 'run-old' })
    ).rejects.toThrow(/requires input/);
    expect(executeWorkflow).not.toHaveBeenCalled();
  });
});

describe('workflowRunCommand — supersedes run-id prefix resolution (#2990)', () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  // The suites above leave queued mockOnce values and call history behind on the shared
  // module mocks. Re-install the module-mock defaults so this describe starts from a
  // clean queue and leaves one behind for the suites after it.
  function resetSharedMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockReset();
    discoverMock.mockImplementation(() => Promise.resolve({ workflows: [], errors: [] }));
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockReset();
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );
    const conversationDb = require('@archon/core/db/conversations');
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockReset();
    (conversationDb.getOrCreateConversation as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve({
        id: 'conv-123',
        platform_type: 'cli',
        platform_conversation_id: 'cli-123',
      })
    );
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockReset();
    (conversationDb.updateConversation as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(undefined)
    );
    const workflowDb = require('@archon/core/db/workflows');
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockReset();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve(null)
    );
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockReset();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([])
    );
    mockCreateWorkflowRun.mockReset();
    mockCreateWorkflowRun.mockImplementation(
      (data: { workflow_name: string; conversation_id: string }) =>
        Promise.resolve({
          id: 'run-detached-created',
          workflow_name: data.workflow_name,
          conversation_id: data.conversation_id,
          status: 'pending',
          working_path: null,
          started_at: new Date(),
          metadata: {},
        })
    );
    const adoption = require('@archon/core/operations/workflow-adoption');
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockReset();
    (adoption.resolveWorkflowAdoption as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.reject(new Error('adoption not expected'))
    );
  }

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    resetSharedMocks();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    resetSharedMocks();
  });

  function setupSupersedesMocks(): void {
    const discoverMock = require('@archon/workflows/workflow-discovery')
      .discoverWorkflowsWithConfig as ReturnType<typeof mock>;
    discoverMock.mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    const codebaseDb = require('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-sup',
      name: 'test-repo',
      default_cwd: '/test/path',
      kind: 'repo',
    });
  }

  it('supersedes a run from a unique short run-id prefix', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    setupSupersedesMocks();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'completed',
    });

    await workflowRunCommand('/test/path', 'assist', 'hello', {
      supersedesRunId: '0b1ee8da',
      noWorktree: true,
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-sup');
    // The terminality check sees the resolved full id, not the typed prefix.
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(supersededRunId);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Superseding run ${supersededRunId}`)
    );
  });

  it('rejects an ambiguous supersedes run prefix with its candidates', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const adoption = await import('@archon/core/operations/workflow-adoption');
    setupSupersedesMocks();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: '0b1ee8da-1111-2222-3333-444455556666' },
      { id: '0b1ee8da-9999-8888-7777-666655554444' },
    ]);

    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', {
        supersedesRunId: '0b1ee8da',
        noWorktree: true,
      })
    ).rejects.toThrow(
      '0b1ee8da-1111-2222-3333-444455556666\n  0b1ee8da-9999-8888-7777-666655554444'
    );
    expect(workflowDb.getWorkflowRun).not.toHaveBeenCalled();
    expect(adoption.resolveWorkflowAdoption).not.toHaveBeenCalled();
  });

  it('passes a full supersedes run id through unchanged', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    setupSupersedesMocks();
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'completed',
    });

    await workflowRunCommand('/test/path', 'assist', 'hello', {
      supersedesRunId: supersededRunId,
      noWorktree: true,
    });

    expect(workflowDb.findWorkflowRunsByIdPrefix).not.toHaveBeenCalled();
    expect(workflowDb.getWorkflowRun).toHaveBeenCalledWith(supersededRunId);
  });

  it('keeps the unknown-id refusal for a prefix that matches nothing', async () => {
    setupSupersedesMocks();

    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', {
        supersedesRunId: 'deadbeef',
        noWorktree: true,
      })
    ).rejects.toThrow("Cannot supersede: no workflow run 'deadbeef' exists.");
  });

  it('still refuses a supersedes run that is not terminal', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const workflowDb = await import('@archon/core/db/workflows');
    setupSupersedesMocks();
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'running',
    });

    await expect(
      workflowRunCommand('/test/path', 'assist', 'hello', {
        supersedesRunId: '0b1ee8da',
        noWorktree: true,
      })
    ).rejects.toThrow(`Cannot supersede run '${supersededRunId}': it is still running.`);
  });

  it('resolves a supersedes run prefix before passing it to the detached child', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
    // The detach pre-flight resolves the project the same way the adopt pre-flight
    // does: a subdir cwd misses the exact default-cwd lookup, then the path-prefix
    // lookup resolves the covering folder project.
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: supersededRunId,
      status: 'completed',
    });

    const child = createDetachedChildFixture();
    const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(child.child);
    const savedArgv = process.argv;
    process.argv = ['bun', '/abs/cli.ts', 'workflow', 'run', 'assist', 'hello', '--detach'];

    let spawnCmd: string[] = [];
    // finishStartupWindow advances the 500 ms startup window on fake timers.
    jest.useFakeTimers();
    try {
      const commandPromise = workflowRunCommand('/test/path/subdir', 'assist', 'hello', {
        detach: true,
        supersedesRunId: '0b1ee8da',
      });
      await finishStartupWindow(commandPromise, spawnSpy);
      spawnCmd = firstDetachedSpawnOptions(spawnSpy).cmd.slice();
    } finally {
      jest.useRealTimers();
      process.argv = savedArgv;
      spawnSpy.mockRestore();
    }

    const supIndex = spawnCmd.indexOf('--supersedes');
    expect(supIndex).toBeGreaterThan(-1);
    expect(spawnCmd[supIndex + 1]).toBe(supersededRunId);
    expect(workflowDb.findWorkflowRunsByIdPrefix).toHaveBeenCalledWith('0b1ee8da', 'cb-1');
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ adopted_from_run_id: supersededRunId })
    );
  });

  it('refuses a non-terminal supersedes run in the detach pre-flight before forking', async () => {
    const supersededRunId = '0b1ee8da-1111-2222-3333-444455556666';
    const { discoverWorkflowsWithConfig } = await import('@archon/workflows/workflow-discovery');
    const codebaseDb = await import('@archon/core/db/codebases');
    const workflowDb = await import('@archon/core/db/workflows');
    const paths = await import('@archon/paths');
    (discoverWorkflowsWithConfig as ReturnType<typeof mock>).mockResolvedValueOnce({
      workflows: [makeTestWorkflowWithSource({ name: 'assist', description: 'Help' })],
      errors: [],
    });
    (paths.getArchonHome as ReturnType<typeof mock>).mockImplementationOnce(() => {
      throw new Error('no home in test');
    });
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce(null);
    (codebaseDb.findCodebaseByPathPrefix as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'test/folder',
      default_cwd: '/test/path',
      kind: 'folder',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: supersededRunId },
    ]);
    // Argument-aware on purpose: the queued-value mocks are argument-blind, which
    // would let terminality pass here even if it ran on the raw prefix.
    (workflowDb.getWorkflowRun as ReturnType<typeof mock>).mockImplementation(async (id: string) =>
      id === supersededRunId ? { id: supersededRunId, status: 'running' } : null
    );

    const spawnSpy = spyOn(Bun, 'spawn');
    try {
      // The refusal names the resolved full id, so terminality is checked on the
      // resolution, not on the raw prefix.
      await expect(
        workflowRunCommand('/test/path/subdir', 'assist', 'hello', {
          detach: true,
          supersedesRunId: '0b1ee8da',
        })
      ).rejects.toThrow(`Cannot supersede run '${supersededRunId}': it is still running.`);
    } finally {
      spawnSpy.mockRestore();
    }

    // The refusal reached the parent: no child was forked and no pending run row
    // was left behind for a launch that cannot proceed (#2872).
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('workflowWaitCommand', () => {
  const FULL_ID = '0b1ee8da-1111-2222-3333-444455556666';
  let consoleSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    stdoutSpy = spyOnJsonStdout();
    mockWaitForRunAttention.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  const terminal = (status: string) => ({
    kind: 'attention',
    attention: { kind: 'terminal', runId: FULL_ID, status, at: new Date('2026-08-28T12:00:00Z') },
  });

  it('exits 0 and names the terminal status', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce(terminal('failed'));

    const code = await workflowWaitCommand(FULL_ID, undefined, '/repo');

    expect(code).toBe(0);
    // A failed run is a successful WAIT — mapping run state onto the exit code would
    // make a legitimately cancelled run look like a broken command.
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain(`Run ${FULL_ID} failed.`);
  });

  it('names the child run when the gate lives below the run being watched', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId: 'child-9',
        respondTo: { runId: 'child-9', nodeId: 'review' },
        message: 'Approve?',
      },
    });

    const code = await workflowWaitCommand(FULL_ID, undefined, '/repo');

    expect(code).toBe(0);
    const printed = consoleSpy.mock.calls.flat().join(' ');
    expect(printed).toContain('blocked on sub-run child-9');
    expect(printed).toContain("gate 'review'");
  });

  it('names the outside action and explicit resume command', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'attention',
      attention: {
        kind: 'action_required',
        runId: FULL_ID,
        nodeId: 'rerun-ci',
        message: 'Re-run CI, then resume.',
      },
    });

    const code = await workflowWaitCommand(FULL_ID, undefined, '/repo');

    expect(code).toBe(0);
    const printed = consoleSpy.mock.calls.flat().join(' ');
    expect(printed).toContain('Re-run CI, then resume.');
    expect(printed).toContain(`archon workflow resume ${FULL_ID}`);
  });

  it('exits 3 with the observed status when the deadline passes', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'deadline',
      runId: FULL_ID,
      observedStatus: 'running',
    });

    const code = await workflowWaitCommand(FULL_ID, true, '/repo', 5);

    expect(code).toBe(3);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: true,
      action: 'wait',
      runId: FULL_ID,
      result: 'deadline',
      observedStatus: 'running',
    });
    expect(mockWaitForRunAttention).toHaveBeenCalledWith(FULL_ID, {
      deadlineMs: 5000,
      onAttached: expect.any(Function),
    });
  });

  it('renders owner loss as an unchanged non-terminal run with an abandon action', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'owner_lost',
      runId: FULL_ID,
      observedStatus: 'running',
    });

    const code = await workflowWaitCommand(FULL_ID, undefined, '/repo');

    expect(code).toBe(0);
    const printed = consoleSpy.mock.calls.flat().join(' ');
    expect(printed).toContain(`lost its execution owner while still running`);
    expect(printed).toContain('The run was not changed');
    expect(printed).toContain(`archon workflow abandon ${FULL_ID}`);
  });

  it('emits owner_lost JSON without inventing attention or terminal status', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'owner_lost',
      runId: FULL_ID,
      observedStatus: 'paused',
    });

    const code = await workflowWaitCommand(FULL_ID, true, '/repo');
    const payload = JSON.parse(firstJsonPayload(stdoutSpy)) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(payload).toEqual({
      ok: true,
      action: 'wait',
      runId: FULL_ID,
      result: 'owner_lost',
      observedStatus: 'paused',
    });
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('attention');
  });

  it('announces the attachment on stderr, leaving stdout one --json document', async () => {
    const stderrSpy = spyOnStderr();
    mockWaitForRunAttention.mockImplementationOnce(async (_runId, opts) => {
      await opts?.onAttached?.('running');
      return terminal('cancelled');
    });

    const code = await workflowWaitCommand(FULL_ID, true, '/repo');

    expect(code).toBe(0);
    // stderr is the whole point: a progress line on stdout would break the --json
    // contract that a consumer gets exactly one document.
    expect(stdoutSpy.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(stderrSpy.mock.calls[0]?.[0]))).toEqual({
      ok: true,
      action: 'wait',
      runId: FULL_ID,
      result: 'waiting',
      observedStatus: 'running',
    });
    stderrSpy.mockRestore();
  });

  it('names the run and the status it attached on in human mode', async () => {
    const stderrSpy = spyOnStderr();
    mockWaitForRunAttention.mockImplementationOnce(async (_runId, opts) => {
      await opts?.onAttached?.('paused');
      return terminal('completed');
    });

    await workflowWaitCommand(FULL_ID, undefined, '/repo');

    expect(String(stderrSpy.mock.calls[0]?.[0])).toBe(
      `Waiting on run ${FULL_ID} — currently paused.\n`
    );
    stderrSpy.mockRestore();
  });

  it('fails the wait when the attachment line cannot be delivered', async () => {
    // The line carries an ordering, so losing it silently is the one outcome that
    // defeats it — and `console.error` to a closed pipe is exactly that no-op.
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((...args: unknown[]) => {
      const callback = args.find(arg => typeof arg === 'function');
      if (typeof callback === 'function') {
        (callback as (error: Error) => void)(
          Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
        );
      }
      return true;
    });
    mockWaitForRunAttention.mockImplementationOnce(async (_runId, opts) => {
      await opts?.onAttached?.('running');
      return terminal('completed');
    });

    const code = await workflowWaitCommand(FULL_ID, true, '/repo');

    expect(code).toBe(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'wait',
      error: 'write EPIPE',
    });
    stderrSpy.mockRestore();
  });

  it('waits indefinitely when no timeout is given', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce(terminal('completed'));

    await workflowWaitCommand(FULL_ID, undefined, '/repo');

    expect(mockWaitForRunAttention).toHaveBeenCalledWith(FULL_ID, {
      onAttached: expect.any(Function),
    });
  });

  it('exits 1 with an {ok:false} line for an unknown run', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({ kind: 'not_found', runId: FULL_ID });

    const code = await workflowWaitCommand(FULL_ID, true, '/repo');

    expect(code).toBe(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'wait',
      error: 'not_found',
    });
  });

  it('emits the attention value verbatim under --json', async () => {
    mockWaitForRunAttention.mockResolvedValueOnce({
      kind: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId: FULL_ID,
        respondTo: { runId: FULL_ID, nodeId: 'review' },
        message: 'Approve?',
      },
    });

    const code = await workflowWaitCommand(FULL_ID, true, '/repo');

    expect(code).toBe(0);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toEqual({
      ok: true,
      action: 'wait',
      runId: FULL_ID,
      result: 'attention',
      attention: {
        kind: 'awaiting_response',
        runId: FULL_ID,
        respondTo: { runId: FULL_ID, nodeId: 'review' },
        message: 'Approve?',
      },
    });
  });

  it('resolves a short prefix before waiting (#2871 defect class)', async () => {
    const workflowDb = await import('@archon/core/db/workflows');
    const codebaseDb = await import('@archon/core/db/codebases');
    (codebaseDb.findCodebaseByDefaultCwd as ReturnType<typeof mock>).mockResolvedValueOnce({
      id: 'cb-1',
      name: 'proj',
      default_cwd: '/repo',
    });
    (workflowDb.findWorkflowRunsByIdPrefix as ReturnType<typeof mock>).mockResolvedValueOnce([
      { id: FULL_ID },
    ]);
    mockWaitForRunAttention.mockResolvedValueOnce(terminal('completed'));

    const code = await workflowWaitCommand('0b1ee8da', undefined, '/repo');

    expect(code).toBe(0);
    expect(mockWaitForRunAttention).toHaveBeenCalledWith(FULL_ID, {
      onAttached: expect.any(Function),
    });
  });

  it('never throws in --json mode when the wait itself fails', async () => {
    mockWaitForRunAttention.mockRejectedValueOnce(new Error('database unreachable'));

    const code = await workflowWaitCommand(FULL_ID, true, '/repo');

    expect(code).toBe(1);
    expect(JSON.parse(firstJsonPayload(stdoutSpy))).toMatchObject({
      ok: false,
      action: 'wait',
      error: 'database unreachable',
    });
  });

  it('throws in human mode when the wait itself fails', async () => {
    mockWaitForRunAttention.mockRejectedValueOnce(new Error('database unreachable'));

    await expect(workflowWaitCommand(FULL_ID, undefined, '/repo')).rejects.toThrow(
      'Failed to wait for workflow run: database unreachable'
    );
  });
});

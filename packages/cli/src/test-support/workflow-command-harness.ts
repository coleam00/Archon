import type * as WorkflowRunSource from '@archon/workflows/run-source';
/**
 * Shared mocks, fixtures and helpers for the workflow command suites.
 * Importing this module registers every `mock.module()` that the workflow command suites rely on.
 */
import { PROVIDER_EVENT_ROW_TYPES } from '@archon/workflows/store';
import { expect, beforeAll, beforeEach, afterEach, spyOn, mock, jest, afterAll } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDocker } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  getProjectStoragePaths as getProjectStoragePathsReal,
  getRunArtifactsDirForRoot as getRunArtifactsDirForRootReal,
  getRunLogPathForRoot as getRunLogPathForRootReal,
  isInsideArchonHome as isInsideArchonHomeReal,
  resolveProjectStorageKey as resolveProjectStorageKeyReal,
  resolveRunStorageRoot as resolveRunStorageRootReal,
} from '@archon/paths/archon-paths';
import type { WorkflowEventCursor } from '@archon/workflows/store';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type * as WorkflowDiscovery from '@archon/workflows/workflow-discovery';
import type * as RunOwnerStop from '@archon/core/services/run-owner-stop';
import { withObservableCapturedSource } from '@archon/workflows/test-utils';
import type { WorkflowEventRow } from '@archon/core/schemas/workflow-event';
import { DetachedRunOwnerUnavailableError as RealDetachedRunOwnerUnavailableError } from '@archon/core/services/run-owner-stop';
mock.module('@archon/core/services/provider-admission', () => ({
  getAgentProvider: () => ({
    checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
  }),
}));

const realRunConfig = await import('@archon/core/config/run-config');
const realSealRunConfig = realRunConfig.sealWorkflowRunConfig;
mock.module('@archon/core/config/run-config', () => ({
  sealWorkflowRunConfig: (...args: Parameters<typeof realSealRunConfig>) => {
    const previous = process.env.TOKEN_ENCRYPTION_KEY;
    try {
      process.env.TOKEN_ENCRYPTION_KEY ??= 'ab'.repeat(32);
      return realSealRunConfig(...args);
    } finally {
      if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previous;
    }
  },
}));
mock.module('@archon/core/credentials/config', () => ({
  isPerUserProviderKeysEnabled: () => false,
}));
mock.module('@archon/core/db/env-vars', () => ({ getCodebaseEnvVars: async () => ({}) }));
mock.module('@archon/core/workflows/branch-launch-source', () => ({
  withBranchLaunchSource: async (
    _repo: string,
    _branch: string,
    prepare: (path: string) => Promise<unknown>
  ) => prepare('/adopted/snapshot'),
}));

beforeAll(async () => {
  const { registerBuiltinProviders, registerCommunityProviders } = await import(
    '@archon/providers/in-process'
  );
  registerBuiltinProviders();
  registerCommunityProviders();
});

export let testHome: string;
let inheritedHome: string | undefined;
let inheritedDocker: string | undefined;
let inheritedWorkspace: string | undefined;

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'archon-workflow-test-home-'));
  inheritedHome = process.env.ARCHON_HOME;
  inheritedDocker = process.env.ARCHON_DOCKER;
  inheritedWorkspace = process.env.WORKSPACE_PATH;
  process.env.ARCHON_DOCKER = '';
  process.env.WORKSPACE_PATH = '';
  process.env.ARCHON_HOME = testHome;
  const core = await import('@archon/core');
  (core.loadConfig as ReturnType<typeof mock>).mockResolvedValue({
    defaults: {},
    assistant: 'claude',
    assistants: { claude: {} },
    aliases: { '@planner': { provider: 'claude', model: 'sonnet' } },
    commands: {},
  });
});

afterEach(async () => {
  if (inheritedHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = inheritedHome;
  if (inheritedDocker === undefined) delete process.env.ARCHON_DOCKER;
  else process.env.ARCHON_DOCKER = inheritedDocker;
  if (inheritedWorkspace === undefined) delete process.env.WORKSPACE_PATH;
  else process.env.WORKSPACE_PATH = inheritedWorkspace;
  await removeTempTree(testHome);
});

export const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => mockLogger),
};

export const mockDetachedTargetStop = mock((): Promise<void> => Promise.resolve());
export const mockDetachedTargetRelease = mock((): undefined => undefined);
export const mockReclaimContainerEnv = mock((): Promise<void> => Promise.resolve());
export const mockRequestDetachedRunStop = mock<typeof RunOwnerStop.requestDetachedRunStop>(() =>
  Promise.resolve({ pid: 4242, stop: mockDetachedTargetStop, release: mockDetachedTargetRelease })
);
export const mockRunLiveOwnerClose = mock((): Promise<void> => Promise.resolve());
export const mockAssertDetachedRunProcessOwner = mock((): undefined => undefined);
let mockDetachedStopRequested = false;
export function setMockDetachedStopRequested(value: boolean): void {
  mockDetachedStopRequested = value;
}
export const mockStartRunLiveOwner = mock(
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
  } => ({
    assertDetachedRunProcessOwner: mockAssertDetachedRunProcessOwner,
    DETACHED_RUN_OWNER_ENV: 'ARCHON_DETACHED_RUN_OWNER',
  })
);

// Capture the real class before mock.module replaces the module, so the mock
// can re-export it without a hand-declared copy that would silently drift.
mock.module('@archon/core/services/run-owner-stop', () => ({
  requestDetachedRunStop: mockRequestDetachedRunStop,
  DetachedRunOwnerUnavailableError: RealDetachedRunOwnerUnavailableError,
}));
/** Abandon's owner probe when nothing listens at the run's endpoint. */
export function noOwnerAnswers(): Promise<never> {
  return Promise.reject(new RealDetachedRunOwnerUnavailableError('run-1', 'ENOENT', 'unreachable'));
}

/** Whether a sub-run's root owner answers; cancel asks when the sub-run's own is silent. */
export const mockIsRunOwnerAnswering = mock((_runId: string) => Promise.resolve(false));
mock.module('@archon/core/services/run-live-owner', () => ({
  startRunLiveOwner: mockStartRunLiveOwner,
  // The CLI never executes the run it cancels: cancel is a separate process.
  isRunOwnedByThisProcess: () => false,
  isRunOwnerAnswering: mockIsRunOwnerAnswering,
}));

mock.module(
  '@archon/core/services/cleanup-service',
  (): {
    reclaimRunWorktree: () => Promise<{ warnings: string[] }>;
    reclaimContainerEnv: typeof mockReclaimContainerEnv;
  } => ({
    reclaimRunWorktree: async () => ({ warnings: [] }),
    reclaimContainerEnv: mockReclaimContainerEnv,
  })
);

// The waiter itself is proven in @archon/core and against a real detached run in
// workflow-wait.integration.spec.ts. Here the command's OWN responsibilities are
// under test: prefix resolution, both output modes, and the exit code per outcome.
export const mockWaitForRunAttention = mock(
  (
    _store: import('@archon/workflows/store').IWorkflowStore,
    _runId: string,
    _opts?: {
      onAttached?: (
        observedStatus: string,
        ownerLiveness?: import('@archon/core/services/run-attention-watch').UnknownOwnerLiveness
      ) => void | Promise<void>;
    }
  ): Promise<unknown> => Promise.resolve({ kind: 'not_found', runId: 'unset' })
);
const realRunAttentionWatch = await import('@archon/core/services/run-attention-watch');
mock.module('@archon/core/services/run-attention-watch', () => ({
  ...realRunAttentionWatch,
  waitForRunAttention: mockWaitForRunAttention,
}));

export const mockCreateWorkflowEvent = mock(() => Promise.resolve());
export const mockPersistWorkflowEvent = mock(() => Promise.resolve());
export const mockFolderBackendPrepare = mock(
  async (): Promise<import('@archon/isolation').PreparedEnv> => ({
    cwd: '/test/path',
    execContext: { kind: 'host' },
    envId: 'container-env-1',
    overlayMode: 'fuse',
  })
);
export const mockFolderBackendDestroy = mock(() => Promise.resolve());
export const mockResolveFolderBackend = mock(() => ({
  prepare: mockFolderBackendPrepare,
  resumeEnv: mockFolderBackendPrepare,
  destroy: mockFolderBackendDestroy,
}));

const mockExpandTilde = (path: string): string =>
  path.startsWith('~') ? join(homedir(), path.slice(1).replace(/^[/\\]/, '')) : path;
// Identity by default: fixture paths are fake and must keep their spelling on Windows.
export const mockCanonicalizeProjectPath = mock(async (path: string) => path);

// Mock @archon/paths (createLogger moved here from @archon/core)
mock.module('@archon/paths', () => ({
  canonicalizeProjectPath: mockCanonicalizeProjectPath,
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
  expandTilde: mockExpandTilde,
  isDocker,
  getArchonHome: mock((env: NodeJS.ProcessEnv = process.env) =>
    isDocker(env) ? '/.archon' : env.ARCHON_HOME ? mockExpandTilde(env.ARCHON_HOME) : testHome
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
const { worktreeRegistrationMetadata } = await import('@archon/isolation');
mock.module('@archon/isolation', () => ({
  worktreeRegistrationMetadata,
  configureIsolation: mock(() => undefined),
  // Marked rather than reimplemented: these tests prove a failure path routes
  // through the classifier, while what the real one produces is the isolation
  // package's own test.
  classifyIsolationError: (error: Error) => `classified: ${error.message}`,
  getIsolationProvider: mock(() => ({
    create: mock(() =>
      Promise.resolve({
        provider: 'worktree',
        id: '/test/path',
        workingPath: '/test/path',
        branchName: 'test-branch',
        status: 'active',
        createdAt: new Date(),
        metadata: {
          provenance: 'created',
          adopted: false,
          creationId: '58e2e55c-b565-4cca-8786-4bc9b86d6fa8',
          branchCreated: true,
        },
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
  loadConfig: mock(() =>
    Promise.resolve({ defaults: {}, assistant: 'claude', assistants: { claude: {} }, commands: {} })
  ),
  generateAndSetTitle: mock(() => Promise.resolve()),
  resolveTitleRequest: mock((provider: string) => Promise.resolve({ provider, options: {} })),
  loadRepoConfig: mock(() => Promise.resolve({})),
  getUserAiPrefs: mock(() => Promise.resolve({})),
  createWorkflowStore: mock(() => ({
    getCodebaseEnvVars: async () => ({}),
    createWorkflowEvent: mockCreateWorkflowEvent,
    persistWorkflowEvent: mockPersistWorkflowEvent,
  })),
  // requires: [github] gate. Default to a solo-install posture (disabled) so the
  // gate is a no-op for every existing test; the gate-specific tests below flip
  // isPerUserGitHubEnabled on per-invocation.
  isPerUserGitHubEnabled: mock(() => false),
  getDecryptedAccessToken: mock(() => Promise.resolve(null)),
}));

class MockProjectRegistrationError extends Error {}
const mockedCore = await import('@archon/core');
mock.module('@archon/core/config/config-loader', () => ({
  loadConfig: (...args: Parameters<typeof mockedCore.loadConfig>) => mockedCore.loadConfig(...args),
  loadRepoConfig: (...args: Parameters<typeof mockedCore.loadRepoConfig>) =>
    mockedCore.loadRepoConfig(...args),
}));
mock.module('@archon/core/handlers/clone', () => ({
  registerRepository: (
    _records: unknown,
    ...args: Parameters<typeof mockedCore.registerRepository>
  ) => mockedCore.registerRepository(...args),
  registerFolder: (_records: unknown, ...args: Parameters<typeof mockedCore.registerFolder>) =>
    mockedCore.registerFolder(...args),
  ProjectRegistrationError: MockProjectRegistrationError,
}));

mock.module('@archon/core/db/users', () => ({
  findOrCreateUserByPlatformIdentity: mock(() => Promise.resolve({ id: 'user-cli-1' })),
}));

mock.module('@archon/core/operations/workflow-adoption', () => ({
  // No test adopts unless it opts in; a loud default keeps an unexpected lane from
  // silently falling through to a fresh run.
  resolveWorkflowAdoption: mock(() => Promise.reject(new Error('adoption not expected'))),
}));

export const mockDiscoverWorkflowsWithConfig = mock<
  typeof WorkflowDiscovery.discoverWorkflowsWithConfig
>(() => Promise.resolve({ workflows: [], errors: [] }));
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
export const capturedSourceOwnerCalls: string[] = [];
/** The full owned roots shape a continuation carries — shared between the prepare and
 *  continuation mocks so the two cannot drift on which fields a `ResolvedContinuation`
 *  promises its consumer. */
export const CAPTURED_SOURCE_ROOTS: WorkflowRunSource.WorkflowSourceRoots = {
  project: '/test/capture/project',
  globalWorkflows: '/test/capture/global/workflows',
  globalCommands: '/test/capture/global/commands',
  globalScripts: '/test/capture/global/scripts',
  bundledWorkflows: '/test/capture/bundled/workflows',
  bundledCommands: '/test/capture/bundled/commands/defaults',
  installed: { kind: 'captured', captureRoot: '/test/capture' },
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
export const mockResolveContinuationWorkflow = mock<
  typeof WorkflowRunSource.resolveContinuationWorkflow
>(
  // Default: the run predates captures, so the caller keeps live discovery — what the
  // resume tests below already assume. Tests that care about the frozen graph override
  // it per invocation.
  () => Promise.resolve(undefined)
);

export const mockArtifactsRoot = mkdtempSync(join(tmpdir(), 'archon-cli-container-artifacts-'));
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
}));
mock.module('@archon/workflows/run-resume', () => ({
  hydrateResumableRun: mock(() => Promise.resolve(null)),
}));
mock.module('@archon/workflows/run-source', () => ({
  withCapturedSource: mock((body: Parameters<typeof withObservableCapturedSource>[1]) =>
    withObservableCapturedSource(capturedSourceOwnerCalls, body)
  ),
  resolveContinuationWorkflow: mockResolveContinuationWorkflow,
  // Stub capture so routing tests do not freeze real source trees.
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
  preparedWorkflowSourceRecord: (
    prepared: import('@archon/workflows/run-source').PreparedWorkflowSource
  ) => ({
    version: 1,
    root: prepared.anchor.root,
    origin: prepared.origin,
    captured_at: prepared.manifest.captured_at,
    digest: prepared.manifest.digest,
    source_config: prepared.anchor.config,
    file_count: prepared.manifest.file_count,
    byte_count: prepared.manifest.byte_count,
  }),
}));
mock.module('@archon/workflows/run-paths', () => ({
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

mock.module('@archon/workflows/event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => ({ emit: mock(() => undefined) })),
}));

/**
 * The committed event feed behind every test host: rows a mocked executor commits with
 * `commitTestEvent` are what the foreground's run subscription reads and renders.
 */
let committedTestEvents: WorkflowEventRow[] = [];
export function resetCommittedTestEvents(): void {
  committedTestEvents = [];
}
export const testRunParents = new Map<string, string>();
let failTestFeedReads = false;
export function setFailTestFeedReads(value: boolean): void {
  failTestFeedReads = value;
}
export function commitTestEvent(
  row: Omit<WorkflowEventRow, 'id' | 'created_at' | 'step_index'>
): void {
  committedTestEvents.push({
    id: `event-${String(committedTestEvents.length + 1)}`,
    step_index: null,
    created_at: '2026-10-14T00:00:00.000Z',
    ...row,
  });
}
const testFeedCursor = (position: number): WorkflowEventCursor =>
  `test:${String(position)}` as WorkflowEventCursor;

class MockCanonicalRepoPathUnavailableError extends Error {
  constructor(
    readonly checkoutPath: string,
    readonly commonGitDir: string
  ) {
    super(`Cannot determine the primary checkout for ${checkoutPath}`);
    this.name = 'CanonicalRepoPathUnavailableError';
  }
}

export const mockGetCurrentBranchStrict = mock(
  async (): Promise<string | null> => 'feature/adopted'
);
mock.module('@archon/git', () => ({
  getCurrentBranchStrict: mockGetCurrentBranchStrict,
  verifyWorktreeOwnership: mock(async () => undefined),
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
  getDefaultRemote: mock(() => Promise.resolve('origin')),
  isAncestorOf: mock(() => Promise.resolve(true)),
}));

mock.module('@archon/core/db/conversations', () => ({
  getOrCreateConversation: mock(() =>
    Promise.resolve({ id: 'conv-123', platform_type: 'cli', platform_conversation_id: 'cli-123' })
  ),
  getConversationById: mock(() =>
    Promise.resolve({
      id: 'conv-123',
      platform_type: 'cli',
      platform_conversation_id: 'cli-123',
    })
  ),
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
  updateMetadata: mock(async () => undefined),
  getById: mock((): Promise<null> => Promise.resolve(null)),
  findActiveByWorkflow: mock(() => Promise.resolve(null)),
  create: mock(() => Promise.resolve({ id: 'iso-123' })),
  listActive: mock(() => Promise.resolve([])),
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
export const mockCreateWorkflowRun = mock(
  (data: {
    workflow_name: string;
    id?: string;
    origin?: import('@archon/workflows/schemas/workflow-run').WorkflowRunOrigin;
  }) =>
    Promise.resolve({
      origin: data.origin ?? null,
      id: data.id ?? 'run-detached-created',
      workflow_name: data.workflow_name,
      conversation_id: data.origin?.conversationId ?? null,
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
export const mockListDashboardRuns = mock(() =>
  Promise.resolve({ runs: [] as unknown[], total: 0, counts: EMPTY_STATUS_COUNTS })
);
export function statusRuns(runs: unknown[]): {
  runs: unknown[];
  total: number;
  counts: typeof EMPTY_STATUS_COUNTS;
} {
  return { runs, total: runs.length, counts: EMPTY_STATUS_COUNTS };
}

export const mockLookupWorkflowRun = mock<
  typeof import('@archon/core/db/workflows').getWorkflowRun
>(async () => null);
export const mockCancelWorkflowRunCommand = mock<
  typeof import('@archon/core/db/workflows').cancelWorkflowRun
>(async () => ({ cancelled: true }));

mock.module('@archon/core/db/workflows', () => ({
  insertWorkflowRun: async (): Promise<never> => {
    throw new Error('Unexpected admission run insert');
  },
  createWorkflowRun: mockCreateWorkflowRun,
  getActiveWorkflowRun: mock(() => Promise.resolve(null)),
  getWorkflowRunStatus: mock(() => Promise.resolve(null)),
  failWorkflowRun: mock(() => Promise.resolve({ failed: true })),
  cancelWorkflowRun: mockCancelWorkflowRunCommand,
  findChildRuns: mock(() => Promise.resolve([])),
  getRunAncestry: mock(() => Promise.resolve([])),
  findResumableRun: mock(() => Promise.resolve(null)),
  resumeWorkflowRun: mock(() => Promise.resolve(null)),
  getWorkflowRun: mockLookupWorkflowRun,
  findAdoptingRuns: mock(() => Promise.resolve([])),
  findWorkflowRunsByIdPrefix: mock(() => Promise.resolve([])),
  updateWorkflowRun: mock(() => Promise.resolve()),
  // CAS gate resolvers (#2113) — approve/reject stamp the resolution here;
  // resolveAndCancelApprovalGate atomically resolves+cancels terminal rejects.
  resolveApprovalGate: mock(() => Promise.resolve({ resolved: true })),
  resolveAndCancelApprovalGate: mock(() => Promise.resolve({ resolved: true })),
  listWorkflowRuns: mock(() => Promise.resolve([])),
  listDashboardRuns: mockListDashboardRuns,
  findOpenWorkRuns: mock(() => Promise.resolve([])),
  deleteOldWorkflowRuns: mock(() => Promise.resolve({ count: 0 })),
  deleteWorkflowRun: mock(() => Promise.resolve()),
}));

mock.module('@archon/core/db/workflow-events', () => ({
  listWorkflowEvents: mock(() => Promise.resolve([])),
  listEventsForRuns: mock(() => Promise.resolve(new Map())),
  createWorkflowEvent: mock(() => Promise.resolve()),
  PROVIDER_EVENT_ROW_TYPES,
}));

// Reset-sessions runs the real resetWorkflowNodeSessions operation over this mocked
// DB layer (same pattern as the other workflow commands in this file). Safe from
// mock.module pollution: workflow.test.ts is its own isolated `bun test` invocation.
export const mockDeleteNodeSessions = mock(() => Promise.resolve({ deleted: 0 }));
mock.module('@archon/core/db/workflow-node-sessions', () => ({
  deleteWorkflowNodeSessions: mockDeleteNodeSessions,
  listWorkflowNodeSessions: mock(() => Promise.resolve([])),
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
export function spyOnJsonStdout(): ReturnType<typeof spyOn> {
  return spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function');
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  });
}

/** The same delivery-confirming shim for stderr, where progress lines go. */
export function spyOnStderr(): ReturnType<typeof spyOn> {
  return spyOn(process.stderr, 'write').mockImplementation((...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function');
    if (typeof callback === 'function') (callback as () => void)();
    return true;
  });
}

/** The first `--json` document a command wrote, trailing newline stripped. */
export function firstJsonPayload(spy: ReturnType<typeof spyOn>): string {
  return ((spy.mock.calls[0]?.[0] as string) ?? '').trimEnd();
}

export async function captureError(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    cause => cause
  );
  if (!(error instanceof Error)) throw new Error('Expected command to reject with an Error');
  return error;
}

export type DetachedSpawnOptions = Bun.Spawn.SpawnOptions<'ignore', 'pipe', 'inherit'> & {
  cmd: string[];
};

export function firstDetachedSpawnOptions(
  spawnSpy: ReturnType<typeof spyOn>
): DetachedSpawnOptions {
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
export function createDetachedChildFixture(pid: number | null = 12345): {
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
export async function finishStartupWindow(
  commandPromise: Promise<unknown>,
  spawnSpy: ReturnType<typeof spyOn>,
  expectedSpawnCount = 1
): Promise<void> {
  for (
    let attempt = 0;
    attempt < 200 && spawnSpy.mock.calls.length < expectedSpawnCount;
    attempt++
  ) {
    await Promise.resolve();
  }
  expect(spawnSpy).toHaveBeenCalledTimes(expectedSpawnCount);
  jest.advanceTimersByTime(500);
  await commandPromise;
}

const { createWorkflowOperations } = await import('@archon/core/operations/workflow-operations');
const operationWorkflowDb = await import('@archon/core/db/workflows');
const operationSessionDb = await import('@archon/core/db/workflow-node-sessions');
const operationIsolationDb = await import('@archon/core/db/isolation-environments');
const hostCodebases = await import('@archon/core/db/codebases');
const hostUsers = await import('@archon/core/db/users');
const hostConversations = await import('@archon/core/db/conversations');
const hostMessages = await import('@archon/core/db/messages');
const realCreateSqlWorkflowHost = (await import('@archon/core/workflows/sql-host'))
  .createSqlWorkflowHost;
mock.module('@archon/core/workflows/sql-host', () => ({
  createSqlWorkflowHost: realCreateSqlWorkflowHost,
  createWorkflowHostStore: () => ({
    codebases: hostCodebases,
    users: hostUsers,
    conversations: hostConversations,
    messages: hostMessages,
    isolation: { ...operationIsolationDb.createIsolationStore(), ...operationIsolationDb },
  }),
  createSqlWorkflowOperations: () =>
    createWorkflowOperations({
      getUserRole: async () => undefined,
      store: {
        signalWorkflowWait: (...args) => operationWorkflowDb.signalWorkflowWait(...args),
        deleteWorkflowRun: (...args) => operationWorkflowDb.deleteWorkflowRun(...args),
        getWorkflowRun: (...args) => operationWorkflowDb.getWorkflowRun(...args),
        findChildRuns: (...args) => operationWorkflowDb.findChildRuns(...args),
        getRunAncestry: (...args) => operationWorkflowDb.getRunAncestry(...args),
        cancelWorkflowRun: (...args) => operationWorkflowDb.cancelWorkflowRun(...args),
        resolveApprovalGate: (...args) => operationWorkflowDb.resolveApprovalGate(...args),
        resolveAndCancelApprovalGate: (...args) =>
          operationWorkflowDb.resolveAndCancelApprovalGate(...args),
        answerAttentionWait: (...args) => operationWorkflowDb.answerAttentionWait(...args),
        labelAttentionWait: (...args) => operationWorkflowDb.labelAttentionWait(...args),
        cancelResumableRunsForConversation: (...args) =>
          operationWorkflowDb.cancelResumableRunsForConversation(...args),
        deleteWorkflowNodeSessions: (...args) =>
          operationSessionDb.deleteWorkflowNodeSessions(...args),
        findWorkflowRunsByIdPrefix: (...args) =>
          operationWorkflowDb.findWorkflowRunsByIdPrefix(...args),
        listWorkflowRuns: (...args) => operationWorkflowDb.listDashboardRuns(...args),
      },
      hostStore: {
        isolation: {
          ...operationIsolationDb.createIsolationStore(),
          getById: (...args) => operationIsolationDb.getById(...args),
        },
      },
      requestDetachedRunStop: mockRequestDetachedRunStop,
      isRunOwnedByThisProcess: () => false,
      isRunOwnerAnswering: mockIsRunOwnerAnswering,
      reclaimRunWorktree: async () => ({ warnings: [] }),
      reclaimContainerEnv: mockReclaimContainerEnv,
    }),
}));

const { createSqlWorkflowHost } = await import('@archon/core/workflows/sql-host');
const coreCapabilities = await import('@archon/core');
const { createSqlWorkflowOperations } = await import('@archon/core/workflows/sql-host');
export function createTestWorkflowHost(): import('@archon/core/workflows/host-store').WorkflowHost {
  const host = createSqlWorkflowHost();
  host.deps.store.pruneStateRevisions = mock(async () => ({ count: 0 }));
  host.deps.store.createWorkflowEvent = mockCreateWorkflowEvent;
  host.deps.store.persistWorkflowEvent = mockPersistWorkflowEvent;
  host.deps.store.getWorkflowEventHead = async () => testFeedCursor(committedTestEvents.length);
  host.deps.store.readWorkflowEventsAfter = async (after, { limit }) => {
    if (failTestFeedReads) throw new Error('event feed unavailable');
    const start = Number(after.slice('test:'.length));
    const page = committedTestEvents.slice(start, start + limit);
    return {
      events: page.map((event, index) => ({ cursor: testFeedCursor(start + index + 1), event })),
      next: testFeedCursor(start + page.length),
    };
  };
  host.deps.store.getRunAncestry = async id => {
    const parent = testRunParents.get(id);
    return parent === undefined ? [] : [{ id: parent } as WorkflowRun];
  };
  host.deps.loadConfig = coreCapabilities.loadConfig;
  host.deps.getUserAiPrefs = coreCapabilities.getUserAiPrefs;
  host.deps.isPerUserGitHubEnabled = coreCapabilities.isPerUserGitHubEnabled;
  host.deps.getUserGithubToken = async id =>
    (await coreCapabilities.getDecryptedAccessToken(id)) ?? undefined;
  host.operations = createSqlWorkflowOperations();
  return host;
}

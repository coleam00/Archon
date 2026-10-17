/**
 * Shared mocks and fixture builders for `orchestrator/orchestrator-agent.test.ts`.
 * Importing this module registers every `mock.module()` that suite relies on.
 */
import type { RunActor } from '../operations/run-authorization';
import type { ProviderRegistry } from '@archon/provider-contract';
import { mock, beforeEach } from 'bun:test';
import { createMockLogger } from './mocks/logger';
import { withObservableCapturedSource } from '@archon/workflows/test-utils';
import type { Codebase, Conversation, IPlatformAdapter } from '../types';
import type { MergedConfig } from '../config/config-types';
import type { MessageRow } from '../schemas/message';
import type { Session } from '../schemas/session';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { toBranchName } from '@archon/git';
import type { IAgentProvider, ProviderCapabilities } from '@archon/providers/types';
import type * as Git from '@archon/git';
import type * as ConfigLoader from '../config/config-loader';
import type * as ConversationDb from '../db/conversations';
import type * as CodebaseDb from '../db/codebases';
import type * as SessionDb from '../db/sessions';
import type * as CommandHandler from '../handlers/command-handler';
import type * as WorkflowDiscovery from '@archon/workflows/workflow-discovery';
import type * as WorkflowExecutor from '@archon/workflows/executor';
import type * as WorkflowDb from '../db/workflows';
import type * as WorkflowEventDb from '../db/workflow-events';
import type * as WorkflowAdoption from '../operations/workflow-adoption';
import type * as Orchestrator from '../orchestrator/orchestrator';
import type * as MessageDb from '../db/messages';
import type * as WorkflowSourceRoot from '../utils/workflow-source-root';
import type * as TitleGenerator from '../services/title-generator';
import type * as UserProviderKeyStore from '../db/user-provider-key-store';
import type { ResolvedCredential } from '../credentials/delivery';
import type * as Paths from '@archon/paths';
import type * as RunLiveOwnerModule from '../services/run-live-owner';

mock.module('../workflows/branch-launch-source', () => ({
  withBranchLaunchSource: async (
    _repo: string,
    _branch: string,
    prepare: (path: string) => Promise<unknown>
  ) => prepare('/adopted/snapshot'),
}));

export const operator: RunActor = { kind: 'operator' };

// ─── Mock setup (ALL mocks must come before the module under test import) ────

export const mockSyncWorkspace = mock<typeof Git.syncWorkspace>(() =>
  Promise.resolve({
    branch: toBranchName('main'),
    synced: true,
    mode: 'fast-forward',
    state: 'in_sync',
    previousHead: 'abc12345',
    newHead: 'abc12345',
    updated: false,
  })
);
// Remote auto-detection defaults to 'origin' (standard repos)
export const mockGetDefaultRemote = mock<typeof Git.getDefaultRemote>(() =>
  Promise.resolve('origin')
);
// Repo config defaults to empty (no worktree.remote configured)
export const mockLoadRepoConfig = mock<typeof ConfigLoader.loadRepoConfig>(() =>
  Promise.resolve({})
);
export const mockGetOrCreateConversation = mock<typeof ConversationDb.getOrCreateConversation>(() =>
  Promise.resolve({
    id: 'conv-1-db',
    platform_type: 'web',
    platform_conversation_id: 'conv-1',
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: null,
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  })
);
export const mockGetCodebase = mock<typeof CodebaseDb.getCodebase>(() => Promise.resolve(null));
// Simulates the rename-then-adopt order real `executeWorkflow` runs (#2690): adoption
// happens INSIDE the executor at the rename success site, not from the caller. The
// rename (and therefore the adopt) only runs for a non-continuation with a prepared
// source — a continuation re-uses the capture its own row recorded and never re-adopts
// here. Tests that observe `capturedSourceOwnerCalls` see the wrap finally behave the
// same way the real one would.
export const mockExecuteWorkflow = mock<typeof WorkflowExecutor.executeWorkflow>((...args) => {
  const opts = args[7];
  if (opts?.preparedSource) {
    opts.capturedSourceOwner?.adopt();
  }
  return Promise.resolve({ success: true, workflowRunId: 'run-1' });
});
export const mockHandleCommand = mock<typeof CommandHandler.handleCommand>(() =>
  Promise.resolve({ success: true, message: 'ok' })
);
export const mockSendQuery = mock<IAgentProvider['sendQuery']>(async function* () {
  yield { type: 'agent_message_chunk', text: 'test response' };
  yield { type: 'result', sessionId: 'session-1' };
});
export const mockGetCodebaseEnvVars = mock(() => Promise.resolve({}));
export const mockLoadConfig = mock<typeof ConfigLoader.loadConfig>(() =>
  Promise.resolve(makeConfig())
);

export const mockLogger = createMockLogger();

export const mockCloseRunLiveOwner = mock(() => Promise.resolve());
const mockRunLiveOwner: RunLiveOwnerModule.RunLiveOwner = {
  close: mockCloseRunLiveOwner,
  isStopRequested: () => false,
};
export const mockStartRunLiveOwner = mock<typeof RunLiveOwnerModule.startRunLiveOwner>(() =>
  Promise.resolve(mockRunLiveOwner)
);
export const mockWithRunLiveOwner = mock<typeof RunLiveOwnerModule.withRunLiveOwner>(
  async (_runId, _options, body) => body(mockRunLiveOwner)
);
mock.module('../services/run-live-owner', () => ({
  startRunLiveOwner: mockStartRunLiveOwner,
  withRunLiveOwner: mockWithRunLiveOwner,
}));

export const mockEnsureArchonWorkspacesPath = mock(() =>
  Promise.resolve('/home/test/.archon/workspaces')
);
export const mockCaptureChatTurn = mock<typeof Paths.captureChatTurn>(() => undefined);
export const mockCaptureApprovalResolved = mock(() => undefined);
// The one canonicalizer every `default_cwd` writer resolves through (#2927).
// Tests below derive their expected path from it rather than from a POSIX
// literal: it makes a path absolute, and on Windows `resolve('/path')` is
// drive-qualified (`D:\path`).
export const { canonicalizeProjectPath, getProjectStoragePaths, resolveProjectStorageKey } =
  await import('@archon/paths');
mock.module('@archon/paths', () => ({
  BUNDLED_IS_BINARY: false,
  BUNDLED_VERSION: 'test',
  getProjectStoragePaths,
  resolveProjectStorageKey,
  captureApprovalResolved: mockCaptureApprovalResolved,
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  ensureArchonWorkspacesPath: mockEnsureArchonWorkspacesPath,
  getArchonHome: mock(() => '/home/test/.archon'),
  getCredentialKeyPath: mock(() => '/home/test/.archon/credential-key'),
  captureChatTurn: mockCaptureChatTurn,
  captureCodebaseRegistered: mock(() => undefined),
}));

export const mockUpdateConversation = mock<typeof ConversationDb.updateConversation>(() =>
  Promise.resolve()
);
export const mockDetachConversationProject =
  mock<typeof ConversationDb.detachConversationProject>();
export const mockGetConversationByPlatformId = mock<
  typeof ConversationDb.getConversationByPlatformId
>(() => Promise.resolve(null));
mock.module('../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  getConversationByPlatformId: mockGetConversationByPlatformId,
  detachConversationProject: mockDetachConversationProject,
  updateConversation: mockUpdateConversation,
  touchConversation: mock(() => Promise.resolve()),
}));

export const mockListCodebases = mock<typeof CodebaseDb.listCodebases>(() => Promise.resolve([]));
export const mockCreateCodebase = mock<typeof CodebaseDb.createCodebase>(() =>
  Promise.resolve({
    id: 'new-codebase-id',
    name: 'test-project',
    repository_url: null,
    default_cwd: '/repos/test-project',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  })
);
export const mockRepairCodebaseRegistration = mock<typeof CodebaseDb.repairCodebaseRegistration>(
  () => Promise.resolve()
);
export const mockUpdateCodebase = mock<typeof CodebaseDb.updateCodebase>(() => Promise.resolve());
export const mockDeleteCodebase = mock<typeof CodebaseDb.deleteCodebase>(() => Promise.resolve());
export class MockCodebaseNotFoundError extends Error {
  constructor(public codebaseId: string) {
    super(`Codebase ${codebaseId} not found`);
    this.name = 'CodebaseNotFoundError';
  }
}
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  listCodebases: mockListCodebases,
  listCodebaseRegistrations: async () =>
    (await mockListCodebases()).map(row => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      stored_default_cwd: row.default_cwd,
    })),
  createCodebase: mockCreateCodebase,
  updateCodebase: mockUpdateCodebase,
  repairCodebaseRegistration: mockRepairCodebaseRegistration,
  deleteCodebase: mockDeleteCodebase,
  CodebaseNotFoundError: MockCodebaseNotFoundError,
}));

export const mockGetActiveSession = mock<typeof SessionDb.getActiveSession>(() =>
  Promise.resolve(null)
);
export const mockDeactivateSession = mock<typeof SessionDb.deactivateSession>(() =>
  Promise.resolve()
);
export const mockUpdateSession = mock<typeof SessionDb.updateSession>(() => Promise.resolve());
export const mockTransitionSession = mock<typeof SessionDb.transitionSession>(() =>
  Promise.resolve({
    id: 'session-1',
    conversation_id: 'conv-1-db',
    codebase_id: null,
    ai_assistant_type: 'claude',
    assistant_session_id: null,
    active: true,
    metadata: {},
    started_at: new Date(),
    ended_at: null,
    parent_session_id: null,
    transition_reason: null,
    ended_reason: null,
  })
);
export class MockSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}
mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
  updateSession: mockUpdateSession,
  transitionSession: mockTransitionSession,
  SessionNotFoundError: MockSessionNotFoundError,
}));

export const mockRegisterFolder = mock(async (path: string, name?: string) => ({
  codebaseId: 'folder-id',
  name: name ?? 'platform',
  defaultCwd: path,
  alreadyExisted: false,
}));
export const mockRegisterRepository = mock(
  async (path: string, options: { name?: string } = {}) => ({
    codebaseId: 'repo-id',
    name: options.name ?? 'repo',
    defaultCwd: path,
    alreadyExisted: false,
  })
);
mock.module('../handlers/sql-registration', () => ({
  registerFolder: mockRegisterFolder,
  registerRepository: mockRegisterRepository,
}));

export const mockParseCommand = mock<typeof CommandHandler.parseCommand>(() => ({
  command: 'help',
  args: [],
}));
export const mockStartWorkflow = mock<typeof CommandHandler.startWorkflow>(() =>
  Promise.resolve({ success: true, message: 'ok' })
);
mock.module('../handlers/command-handler', () => ({
  parseCommand: mockParseCommand,
  handleCommand: mockHandleCommand,
  startWorkflow: mockStartWorkflow,
}));

mock.module('@archon/workflows/utils/tool-formatter', () => ({
  formatToolCall: mock((toolName: string) => `🔧 ${toolName}`),
}));
export const mockDiscoverWorkflowsWithConfig = mock<
  typeof WorkflowDiscovery.discoverWorkflowsWithConfig
>(() => Promise.resolve({ workflows: [], errors: [] }));
export const { discoverWorkflowsWithConfig: realDiscoverWorkflowsWithConfig } = await import(
  '@archon/workflows/workflow-discovery'
);
mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));
mock.module('@archon/workflows/router', () => ({
  findWorkflow: mock((name: string, workflows: WorkflowDefinition[]) =>
    workflows.find(w => w.name === name)
  ),
}));
export const mockHydrateResumableRun = mock<typeof WorkflowExecutor.hydrateResumableRun>(
  async (_deps, candidate) => ({
    preCreatedRun: { ...candidate, status: 'running' },
    priorCompletedNodes: new Map([['n1', { output: 'v1' }]]),
    priorUsage: { costUsd: 0 },
    priorNodeSessions: [],
  })
);
export const mockInspectResumableRun = mock<typeof WorkflowExecutor.inspectResumableRun>(() =>
  Promise.resolve({
    priorCompletedNodes: new Map([['n1', { output: 'v1' }]]),
    priorUsage: { costUsd: 0 },
  })
);
export const CAPTURED_SOURCE_ROOTS = {
  project: '/capture/project',
  globalWorkflows: '/capture/global/workflows',
  globalCommands: '/capture/global/commands',
  globalScripts: '/capture/global/scripts',
  bundledWorkflows: '/capture/bundled/workflows',
  bundledCommands: '/capture/bundled/commands/defaults',
  installed: { kind: 'captured', captureRoot: '/capture' },
  kind: 'captured',
  anchor: {
    root: '/capture',
    digest: 'test-digest',
    config: {
      load_default_workflows: true,
      load_default_commands: true,
    },
  },
} satisfies WorkflowExecutor.WorkflowSourceRoots;
export const mockPrepareWorkflowSource = mock<typeof WorkflowExecutor.prepareWorkflowSource>(() =>
  Promise.resolve({
    runId: 'prepared-run-id',
    origin: '/origin',
    manifest: {
      version: 1,
      engine_version: 'test',
      origin: '/origin',
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
);
export const { resolveContinuationWorkflow: realResolveContinuationWorkflow } = await import(
  '@archon/workflows/executor'
);
export const mockResolveContinuationWorkflow = mock<
  typeof WorkflowExecutor.resolveContinuationWorkflow
>(() => Promise.resolve(undefined));
/** Ownership calls the dispatch path makes on its capture, in order. */
export const capturedSourceOwnerCalls: string[] = [];

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
  finalizeWorkflowSource: mock(
    async (_deps: unknown, source: WorkflowExecutor.PreparedWorkflowSource) => source
  ),
  preparedWorkflowSourceRecord: (source: WorkflowExecutor.PreparedWorkflowSource) => ({
    version: 1,
    root: source.anchor.root,
    origin: source.origin,
    captured_at: source.manifest.captured_at,
    digest: source.manifest.digest,
    source_config: source.anchor.config,
    file_count: source.manifest.file_count,
    byte_count: source.manifest.byte_count,
  }),
  hydrateResumableRun: mockHydrateResumableRun,
  inspectResumableRun: mockInspectResumableRun,
  // Source capture runs before dispatch and does real filesystem work; stub it so these
  // tests stay about routing. `mock.module` MERGES, so an export omitted here keeps its
  // REAL implementation — which is exactly how a stub silently starts doing disk I/O.
  prepareWorkflowSource: mockPrepareWorkflowSource,
  recordSelectedWorkflow: mock(() => Promise.resolve()),
  disposeWorkflowSource: mock(() => Promise.resolve()),
  resolveContinuationWorkflow: mockResolveContinuationWorkflow,
  withCapturedSource: mock((body: Parameters<typeof withObservableCapturedSource>[1]) =>
    withObservableCapturedSource(capturedSourceOwnerCalls, body)
  ),
}));

/** Baseline capabilities the mocked registry reports. Tests that narrow this
 *  must restore THIS object, not a hand-written subset — dropping a flag here
 *  leaks into every later test in the file (it is how `effortControl` went
 *  missing for `resolveTitleRequest`). */
export const DEFAULT_PROVIDER_CAPS: ProviderCapabilities = {
  backgroundWork: 'unobserved' as const,
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  plugins: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: true,
  costControl: false,
  costReporting: false,
  effortControl: true,
  fallbackModel: false,
  sandbox: false,
  settingSources: false,
  nativeTools: false,
  containerExec: false,
  requiresAllPropertiesRequired: false,
};

const mockGetProviderCapabilities = mock(() => ({ ...DEFAULT_PROVIDER_CAPS }));

const providerRegistry: ProviderRegistry = {
  get: id => ({
    id,
    displayName: id,
    builtIn: true,
    capabilities: mockGetProviderCapabilities(),
    parseConfig: raw => raw,
    credentials: {
      kind: 'static',
      specs: [{ vendor: 'anthropic', displayName: 'Anthropic', kinds: ['api_key'] }],
      vendorFor: () => 'anthropic',
    },
  }),
  list: () => [],
};

// The vendor a chat turn's provider needs; per-test overrides pick another.
export const mockChatVendor = mock((_model?: string): string | undefined => 'anthropic');
export const mockIsRegisteredProvider = mock((_provider: string): boolean => true);
mock.module('@archon/providers', () => ({
  providerRegistry,
  getRegistration: (provider: string) => {
    // The real registry throws for an unknown id.
    if (!mockIsRegisteredProvider(provider)) throw new Error(`Unknown provider: ${provider}`);
    return {
      parseConfig: (raw: Record<string, unknown>) => raw,
      credentials: {
        kind: 'static',
        specs: ['anthropic', 'openai'].map(vendor => ({
          vendor,
          displayName: vendor,
          kinds: ['api_key', 'subscription'],
        })),
        vendorFor: (model?: string) => mockChatVendor(model),
      },
    };
  },
  getAgentProvider: mock(() => ({
    sendQuery: mockSendQuery,
    getType: mock(() => 'claude'),
    getCapabilities: mock(() => ({})),
  })),
  getProviderCapabilities: mockGetProviderCapabilities,
  isRegisteredProvider: (provider: string) => mockIsRegisteredProvider(provider),
  getRegisteredProviders: mock(() => []),
  // Vendor → env-var map consumed by credentials/delivery (#1955). A realistic
  // subset of the generated map (the chat inject tests deliver through it).
  PI_PROVIDER_ENV_VARS: {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    'github-copilot': 'COPILOT_GITHUB_TOKEN',
    openrouter: 'OPENROUTER_API_KEY',
    google: 'GEMINI_API_KEY',
    huggingface: 'HF_TOKEN',
  },
  PI_AMBIENT_VENDORS: ['amazon-bedrock', 'google-vertex'],
}));

mock.module('../db/env-vars', () => ({
  getCodebaseEnvVars: mockGetCodebaseEnvVars,
}));

mock.module('../utils/error-formatter', () => ({
  classifyAndFormatError: mock((err: Error) => `Error: ${err.message}`),
}));

mock.module('../utils/error', () => ({
  toError: mock((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
}));

export const mockFailPreparedRun = mock<
  import('@archon/workflows/store').IWorkflowStore['failWorkflowRun']
>(async () => ({ failed: true }));

mock.module('../workflows/store-adapter', () => ({
  createWorkflowDeps: mock(() => ({
    providers: providerRegistry,
    store: {
      getCodebaseEnvVars: async () => ({}),
      createWorkflowRun: async (
        data: Parameters<import('@archon/workflows/store').IWorkflowStore['createWorkflowRun']>[0]
      ) =>
        makeRun({
          id: data.id,
          workflow_name: data.workflow_name,
          status: 'pending',
          metadata: data.metadata ?? {},
          working_path: null,
        }),
      updateWorkflowRun: async () => {},
      failWorkflowRun: mockFailPreparedRun,
    },
    sealRunConfig: (_layer: unknown, source: unknown) => ({
      version: 1,
      ciphertext: 'sealed',
      source,
      keys: [],
    }),
    getAgentProvider: () => ({
      checkCredential: async () => ({ state: 'not_checked', source: 'native' }),
    }),
    loadConfig: async () => ({
      assistant: 'claude',
      assistants: { claude: {} },
      aliases: { '@planner': { provider: 'claude', model: 'sonnet' } },
      commands: {},
    }),
  })),
}));

export const mockGetPausedWorkflowRun = mock<typeof WorkflowDb.getPausedWorkflowRun>(() =>
  Promise.resolve(null)
);
export const mockFindResumableRunByParentConversation = mock<
  typeof WorkflowDb.findResumableRunByParentConversation
>(() => Promise.resolve(null));
export const mockUpdateWorkflowRun = mock<typeof WorkflowDb.updateWorkflowRun>(() =>
  Promise.resolve()
);
// approveWorkflow stamps the resolution atomically via this CAS (#2113), not
// updateWorkflowRun. Defaults to "won the race".
export const mockResolveApprovalGate = mock<typeof WorkflowDb.resolveApprovalGate>(() =>
  Promise.resolve({ resolved: true })
);
// approveWorkflow (operations/workflow-operations, called by the NL approval
// path) re-reads the run via getWorkflowRun before recording the resolution.
export const mockGetWorkflowRunDb = mock<typeof WorkflowDb.getWorkflowRun>(() =>
  Promise.resolve(null)
);
// rejectWorkflow's terminal path (no on_reject staged) resolves + cancels in one CAS.
export const mockResolveAndCancelApprovalGate = mock<
  typeof WorkflowDb.resolveAndCancelApprovalGate
>(() => Promise.resolve({ resolved: true }));
// manage_run resolves every by-id action through this project-scoped prefix lookup.
export const mockFindWorkflowRunsByIdPrefix = mock<typeof WorkflowDb.findWorkflowRunsByIdPrefix>(
  () => Promise.resolve([])
);
const mockListDashboardRuns = mock<typeof WorkflowDb.listDashboardRuns>(() =>
  Promise.resolve({
    runs: [],
    total: 0,
    counts: { all: 0, running: 0, completed: 0, failed: 0, cancelled: 0, pending: 0, paused: 0 },
  })
);
class MockWorkflowNotResumableError extends Error {
  constructor(
    readonly runId: string,
    readonly currentStatus: WorkflowRun['status']
  ) {
    super(`Workflow run is not resumable (id: ${runId}, status: ${currentStatus}).`);
    this.name = 'WorkflowNotResumableError';
  }
}
mock.module('../db/workflows', () => ({
  getPausedWorkflowRun: mockGetPausedWorkflowRun,
  getWorkflowRun: mockGetWorkflowRunDb,
  findResumableRunByParentConversation: mockFindResumableRunByParentConversation,
  updateWorkflowRun: mockUpdateWorkflowRun,
  resolveApprovalGate: mockResolveApprovalGate,
  resolveAndCancelApprovalGate: mockResolveAndCancelApprovalGate,
  findWorkflowRunsByIdPrefix: mockFindWorkflowRunsByIdPrefix,
  listDashboardRuns: mockListDashboardRuns,
  WorkflowNotResumableError: MockWorkflowNotResumableError,
}));

export const mockCreateWorkflowEvent = mock<typeof WorkflowEventDb.createWorkflowEvent>(() =>
  Promise.resolve()
);
mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

mock.module('../config/config-loader', () => ({
  loadConfig: mockLoadConfig,
  loadRepoConfig: mockLoadRepoConfig,
}));

export const mockGenerateAndSetTitle = mock<typeof TitleGenerator.generateAndSetTitle>(() =>
  Promise.resolve()
);
mock.module('../services/title-generator', () => ({
  generateAndSetTitle: mockGenerateAndSetTitle,
}));

export const mockDispatchBackgroundWorkflow = mock<typeof Orchestrator.dispatchBackgroundWorkflow>(
  () => Promise.resolve()
);
export const mockValidateAndResolveIsolation = mock<
  typeof Orchestrator.validateAndResolveIsolation
>(() => Promise.resolve({ cwd: '/test/cwd', status: 'none', env: null }));
mock.module('../orchestrator/orchestrator', () => ({
  validateAndResolveIsolation: mockValidateAndResolveIsolation,
  dispatchBackgroundWorkflow: mockDispatchBackgroundWorkflow,
}));

export const mockResolveWorkflowAdoption = mock<typeof WorkflowAdoption.resolveWorkflowAdoption>(
  () => Promise.reject(new Error('Workflow adoption mock is not configured'))
);
mock.module('../operations/workflow-adoption', () => ({
  resolveWorkflowAdoption: mockResolveWorkflowAdoption,
  WorkflowAdoptionError: class WorkflowAdoptionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WorkflowAdoptionError';
    }
  },
}));

mock.module('../orchestrator/prompt-builder', () => ({
  buildOrchestratorPrompt: mock(() => 'orchestrator system prompt'),
  buildProjectScopedPrompt: mock(() => 'project scoped system prompt'),
  buildOrchestratorSystemAppend: mock(() => 'orchestrator system append'),
  buildRunManagementSection: mock(() => '## Managing Workflow Runs\n(mocked)'),
  formatWorkflowContextSection: mock((results: unknown[]) =>
    results.length > 0 ? '## Recent Workflow Results\n\n...' : ''
  ),
}));

export const mockAddMessage = mock<typeof MessageDb.addMessage>((conversationId, role, content) =>
  Promise.resolve(makeMessage({ conversation_id: conversationId, role, content }))
);
export const mockGetRecentWorkflowResultMessages = mock<
  typeof MessageDb.getRecentWorkflowResultMessages
>(() => Promise.resolve([]));
export const mockAdoptionMetadata = mock<
  typeof import('../db/isolation-environments').updateMetadata
>(async () => {});
export const mockResumedEnvironment = mock(
  async (): Promise<ReturnType<typeof makeIsolationEnvironment> | null> => null
);
export const mockAdoptedEnvironment = mock(
  async (): Promise<AgentIsolationEnvironment | null> =>
    makeIsolationEnvironment({ working_path: '/wt/adopted' })
);
mock.module('../db/isolation-environments', () => ({
  getById: mockAdoptedEnvironment,
  findLatestByCodebaseAndWorkingPath: mockResumedEnvironment,
  updateMetadata: mockAdoptionMetadata,
}));

mock.module('../db/messages', () => ({
  addMessage: mockAddMessage,
  listMessages: mock(() => Promise.resolve([])),
  getRecentWorkflowResultMessages: mockGetRecentWorkflowResultMessages,
}));

mock.module('@archon/isolation', () => ({
  IsolationBlockedError: class IsolationBlockedError extends Error {
    public reason: string;
    constructor(reason: string) {
      super(reason);
      this.reason = reason;
      this.name = 'IsolationBlockedError';
    }
  },
  // Loaded transitively via orchestrator-agent → child-isolation-resolver (PR-A).
  getIsolationProvider: mock(() => ({})),
  classifyIsolationError: (err: Error) => err.message,
}));

export const mockResolveWorkflowSourceRoot = mock<
  typeof WorkflowSourceRoot.resolveWorkflowSourceRoot
>(() => Promise.resolve(undefined));
mock.module('../utils/workflow-source-root', () => ({
  resolveWorkflowSourceRoot: mockResolveWorkflowSourceRoot,
}));

export const mockGetCurrentBranchStrict = mock(
  async (): Promise<string | null> => 'feature/adopted'
);
mock.module('@archon/git', () => ({
  getCurrentBranchStrict: mockGetCurrentBranchStrict,
  verifyWorktreeOwnership: mock(async () => {}),
  getDefaultRemote: mockGetDefaultRemote,
  syncWorkspace: mockSyncWorkspace,
  // /register-project probes git-ness via findRepoRoot; a non-null root marks
  // the registered path as a repo project (kind: 'repo').
  findRepoRoot: mock((p: string) => Promise.resolve(p)),
  // Stubs for post-message-reminder (loaded transitively by orchestrator-agent).
  // Return null/0/false so the reminder short-circuits without emitting an event.
  getCurrentBranch: mock(() => Promise.resolve(null)),
  countCommitsAhead: mock(() => Promise.resolve(0)),
  hasUncommittedChanges: mock(() => Promise.resolve(false)),
}));

// Hoisted so individual tests can make a specific path report as missing (the
// conversation-cwd guard in handleMessage). Default: everything exists.
export const mockExistsSync = mock((_path: string) => true);

mock.module('fs', () => ({
  existsSync: mockExistsSync,
  // token-crypto.ts imports these from node:fs for the auto-provisioned credential
  // key. readFileSync returns a valid 64-hex key so getEncryptionKey() resolves
  // without any real disk write when the per-user credential path is exercised.
  readFileSync: mock(() => 'a'.repeat(64)),
  writeFileSync: mock(() => undefined),
  mkdirSync: mock(() => undefined),
  chmodSync: mock(() => undefined),
}));

// Credential feature mocks (per-user AI-provider credentials).
// Default: feature disabled — existing tests are unaffected.
export const mockIsPerUserProviderKeysEnabled = mock(() => false);
mock.module('../credentials/config', () => ({
  isPerUserProviderKeysEnabled: mockIsPerUserProviderKeysEnabled,
}));

// The user's stored credentials: a usable credential, or the status a broken one reports.
type StoredFixture =
  | { provider: string; cred: ResolvedCredential }
  | {
      provider: string;
      status: Exclude<UserProviderKeyStore.StoredCredential, { state: 'usable' }>;
    };
export const mockStoredProviderCredentials = mock<(userId: string) => Promise<StoredFixture[]>>(
  async () => []
);
export const mockListUserProviderKeys = mock(async (userId: string) =>
  (await mockStoredProviderCredentials(userId)).map(row => ({
    provider: row.provider,
    kind: 'cred' in row ? row.cred.kind : ('api_key' as const),
    label: null,
  }))
);
mock.module('../db/user-provider-key-store', () => ({
  saveUserProviderKey: mock(() => Promise.resolve()),
  getUserProviderKeyRecord: mock(() => Promise.resolve(null)),
  listUserProviderKeys: mockListUserProviderKeys,
  deleteUserProviderKey: mock(() => Promise.resolve()),
  getDecryptedProviderCredential: mock(
    async (userId: string, provider: string): Promise<UserProviderKeyStore.StoredCredential> => {
      const row = (await mockStoredProviderCredentials(userId)).find(r => r.provider === provider);
      if (!row) return { state: 'not_connected', source: 'archon' };
      return 'cred' in row
        ? { state: 'usable', source: 'archon', credential: row.cred }
        : row.status;
    }
  ),
}));

// Per-user AI prefs (Phase 3). Default: empty — config-only behavior.
export const mockGetUserAiPrefsDb = mock(
  async (_userId: string) => ({}) as Record<string, unknown>
);
mock.module('../db/user-ai-prefs-store', () => ({
  getUserAiPrefs: mockGetUserAiPrefsDb,
  setUserTiers: mock(() => Promise.resolve()),
  setUserAliases: mock(() => Promise.resolve()),
  setUserDefault: mock(() => Promise.resolve()),
  clearUserAiPrefs: mock(() => Promise.resolve()),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The only `Codebase` literal in this file. Every variant is an override of it. */
export function makeCodebase(overrides: Partial<Codebase> = {}): Codebase {
  return {
    id: 'codebase-1',
    name: 'test-repo',
    repository_url: null,
    default_cwd: '/repos/test-repo',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Positional form for tests that identify a project by name: the name drives id and cwd. */
export function makeNamedCodebase(name: string, id = `id-${name}`): Codebase {
  return makeCodebase({ id, name, default_cwd: `/repos/${name}` });
}

/** The only `WorkflowRun` literal in this file. Every variant is an override of it. */
export function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    origin: { conversationId: 'conv-1' },
    id: 'run-1',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    parent_conversation_id: null,
    codebase_id: 'codebase-1',
    status: 'paused',
    outcome: null,
    user_message: 'original prompt',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: '/repos/test-repo',
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    checkout_baseline: null,
    ...overrides,
  };
}

// `existsSync` is one shared mock for the whole file, so whatever predicate the
// last test left behind is what the next one inherits. Resetting it inside a
// single describe is not enough: everything below that block would run against a
// leaked predicate, including the `/setproject` and `/update-project` suites,
// which drive the existsSync call sites in handleSetProject and
// handleUpdateProject. Today a leak is survivable only because the predicates
// here reject one literal path — that is luck, not a guarantee, and it stops
// being true the moment a test rejects something broader. Reset before every
// test so no describe can poison another.
//
// Deliberately no count here: any number rots on the next test added, and the
// mechanism is the argument.
beforeEach(() => {
  mockExistsSync.mockImplementation(() => true);
});

// ─── Helpers for handleMessage tests ─────────────────────────────────────────

export function chatDispatchLogs(): Record<string, unknown>[] {
  return mockLogger.info.mock.calls
    .filter(c => c[1] === 'orchestrator.chat_dispatch_started')
    .map(c => c[0] as Record<string, unknown>);
}

export function makePlatform() {
  return {
    capabilities: { messagePersistence: 'adapter', defaultWorkflowDispatch: 'background' } as const,
    sendMessage: mock<IPlatformAdapter['sendMessage']>(() => Promise.resolve()),
    ensureThread: mock<NonNullable<IPlatformAdapter['ensureThread']>>(id => Promise.resolve(id)),
    getStreamingMode: mock<IPlatformAdapter['getStreamingMode']>(() => 'batch'),
    getPlatformType: mock<IPlatformAdapter['getPlatformType']>(() => 'web'),
    start: mock<IPlatformAdapter['start']>(() => Promise.resolve()),
    stop: mock<IPlatformAdapter['stop']>(() => {}),
  } satisfies IPlatformAdapter;
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    // DB primary key deliberately differs from platform_conversation_id — the
    // real schemas always generate `id` independently, and identical defaults
    // masked the /setproject platform-id bug (id-conflating tests passed
    // against the broken code).
    id: 'conv-1-db',
    platform_type: 'web',
    platform_conversation_id: 'conv-1',
    codebase_id: null,
    cwd: null,
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: 'Test Conversation',
    hidden: false,
    deleted_at: null,
    last_activity_at: null,
    user_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<MergedConfig> = {}): MergedConfig {
  return {
    botName: 'Archon',
    assistant: 'claude',
    assistants: { claude: {}, codex: {} },
    streaming: { telegram: 'stream', discord: 'batch', slack: 'batch' },
    attentionNotices: [],
    concurrency: { maxConversations: 10 },
    workflows: {
      autoResumeOnQuotaReset: false,
    },
    commands: { autoLoad: true },
    defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
    envVars: {},
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'message-1',
    conversation_id: 'conv-1-db',
    role: 'assistant',
    content: 'test message',
    metadata: '{}',
    user_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    conversation_id: 'conv-1-db',
    codebase_id: null,
    ai_assistant_type: 'claude',
    assistant_session_id: null,
    active: true,
    metadata: {},
    started_at: new Date(),
    ended_at: null,
    parent_session_id: null,
    transition_reason: null,
    ended_reason: null,
    ...overrides,
  };
}

type AgentIsolationEnvironment = Extract<
  Awaited<ReturnType<typeof Orchestrator.validateAndResolveIsolation>>,
  { status: 'new' }
>['env'];

export function makeIsolationEnvironment(
  overrides: Partial<AgentIsolationEnvironment> = {}
): AgentIsolationEnvironment {
  return {
    id: 'env-1',
    codebase_id: 'codebase-1',
    workflow_type: 'task',
    workflow_id: 'workflow-1',
    provider: 'worktree',
    working_path: '/wt/from-branch',
    branch_name: 'feature/adopted',
    status: 'active',
    created_at: new Date('2026-01-01'),
    created_by_platform: 'web',
    created_by_user_id: null,
    metadata: {},
    ...overrides,
  };
}

/** The sync suites need a codebase with a remote; nothing else differs. */
export function makeCodebaseForSync(): Codebase {
  return makeCodebase({ repository_url: 'https://github.com/test/repo' });
}

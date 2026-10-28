import type * as WorkflowRunSource from '@archon/workflows/run-source';
/** Shared handleMessage mocks and fixtures; importing registers the suites' module mocks. */
import type { RunActor } from '../operations/run-authorization';
import type { ProviderRegistry } from '@archon/provider-contract';
import { mock, beforeEach } from 'bun:test';
import {
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
} from '@archon/isolation/types';
import { createMockLogger } from './mocks/logger';
export * from './orchestrator-agent-db-mocks';
export * from './orchestrator-agent-fixtures';
import {
  MockCodebaseNotFoundError,
  MockSessionNotFoundError,
  MockWorkflowNotResumableError,
  mockAddMessage,
  mockAdoptedEnvironment,
  mockAdoptionMetadata,
  mockCreateCodebase,
  mockCreateWorkflowEvent,
  mockDeactivateSession,
  mockDeleteCodebase,
  mockDetachConversationProject,
  mockFindResumableRunByParentConversation,
  mockFindWorkflowRunsByIdPrefix,
  mockGetActiveSession,
  mockGetCodebase,
  mockGetCodebaseEnvVars,
  mockGetConversationByPlatformId,
  mockGetOrCreateConversation,
  mockGetPausedWorkflowRun,
  mockGetRecentWorkflowResultMessages,
  mockGetUserAiPrefsDb,
  mockGetWorkflowRunDb,
  mockListCodebases,
  mockListDashboardRuns,
  mockListUserProviderKeys,
  mockRegisterFolder,
  mockRegisterRepository,
  mockRepairCodebaseRegistration,
  mockResolveAndCancelApprovalGate,
  mockResolveApprovalGate,
  mockResumedEnvironment,
  mockStoredProviderCredentials,
  mockTransitionSession,
  mockUpdateCodebase,
  mockUpdateConversation,
  mockUpdateSession,
  mockUpdateWorkflowRun,
} from './orchestrator-agent-db-mocks';
import { makeConfig, makeConversation, makeRun } from './orchestrator-agent-fixtures';
import {
  makeTestWorkflowWithSource,
  withObservableCapturedSource,
} from '@archon/workflows/test-utils';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { toBranchName } from '@archon/git';
import type { IAgentProvider, ProviderCapabilities } from '@archon/providers/types';
import type * as Git from '@archon/git';
import type * as ConfigLoader from '../config/config-loader';
import type * as CommandHandler from '../handlers/command-handler';
import type * as WorkflowDiscovery from '@archon/workflows/workflow-discovery';
import type * as WorkflowExecutor from '@archon/workflows/executor';
import type * as WorkflowRunResume from '@archon/workflows/run-resume';
import type * as WorkflowAdoption from '../operations/workflow-adoption';
import type * as IsolationResolver from '../orchestrator/dispatch/isolation-resolver';
import type * as BackgroundDispatch from '../orchestrator/dispatch/background';
import type * as WorkflowSourceRoot from '../utils/workflow-source-root';
import type * as TitleGenerator from '../services/title-generator';
import type * as Paths from '@archon/paths';
import type * as UserProviderKeyStore from '../db/user-provider-key-store';
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
export const mockLoadConfig = mock<typeof ConfigLoader.loadConfig>(() =>
  Promise.resolve(makeConfig())
);

export const mockLogger = createMockLogger();
export const mockCloseRunLiveOwner = mock(() => Promise.resolve());
const mockRunLiveOwner: RunLiveOwnerModule.RunLiveOwner = {
  close: mockCloseRunLiveOwner,
  isStopRequested: () => false,
  registerTerminationPreparation: () => () => undefined,
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
export const mockCaptureWorkflowNoMatch = mock<typeof Paths.captureWorkflowNoMatch>(
  () => undefined
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
  captureWorkflowNoMatch: mockCaptureWorkflowNoMatch,
  captureCodebaseRegistered: mock(() => undefined),
}));

mock.module('../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  getConversationByPlatformId: mockGetConversationByPlatformId,
  detachConversationProject: mockDetachConversationProject,
  updateConversation: mockUpdateConversation,
  touchConversation: mock(() => Promise.resolve()),
}));
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
mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
  updateSession: mockUpdateSession,
  transitionSession: mockTransitionSession,
  SessionNotFoundError: MockSessionNotFoundError,
}));
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
export const mockHydrateResumableRun = mock<typeof WorkflowRunResume.hydrateResumableRun>(
  async (_deps, candidate) => ({
    preCreatedRun: { ...candidate, status: 'running' },
    priorCompletedNodes: new Map([['n1', { output: 'v1' }]]),
    priorFailedNodes: new Map(),
    resumeCause: candidate.status === 'paused' ? 'continue_after_wait' : 'retry_failed',
    priorUsage: { costUsd: 0 },
    priorNodeSessions: [],
  })
);
export const mockInspectResumableRun = mock<typeof WorkflowRunResume.inspectResumableRun>(() =>
  Promise.resolve({
    priorCompletedNodes: new Map([['n1', { output: 'v1' }]]),
    priorFailedNodes: new Map(),
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
} satisfies WorkflowRunSource.WorkflowSourceRoots;
export const mockPrepareWorkflowSource = mock<typeof WorkflowRunSource.prepareWorkflowSource>(() =>
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
  '@archon/workflows/run-source'
);
export const mockResolveContinuationWorkflow = mock<
  typeof WorkflowRunSource.resolveContinuationWorkflow
>(() => Promise.resolve(undefined));
export const capturedSourceOwnerCalls: string[] = [];

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));
mock.module('@archon/workflows/run-resume', () => ({
  hydrateResumableRun: mockHydrateResumableRun,
  inspectResumableRun: mockInspectResumableRun,
}));
mock.module('@archon/workflows/run-source', () => ({
  finalizeWorkflowSource: mock(
    async (_deps: unknown, source: WorkflowRunSource.PreparedWorkflowSource) => source
  ),
  preparedWorkflowSourceRecord: (source: WorkflowRunSource.PreparedWorkflowSource) => ({
    version: 1,
    root: source.anchor.root,
    origin: source.origin,
    captured_at: source.manifest.captured_at,
    digest: source.manifest.digest,
    source_config: source.anchor.config,
    file_count: source.manifest.file_count,
    byte_count: source.manifest.byte_count,
  }),
  // Bun merges module mocks: stub each capture export to avoid real I/O.
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

export const mockCreateWorkflowRun = mock<
  import('@archon/workflows/store').IWorkflowStore['createWorkflowRun']
>(async data =>
  makeRun({
    id: data.id,
    workflow_name: data.workflow_name,
    status: 'pending',
    metadata: data.metadata ?? {},
    adopted_from_run_id: data.adopted_from_run_id ?? null,
    working_path: null,
  })
);

mock.module('../workflows/store-adapter', () => ({
  createWorkflowDeps: mock(() => ({
    providers: providerRegistry,
    store: {
      getCodebaseEnvVars: async () => ({}),
      createWorkflowRun: mockCreateWorkflowRun,
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

export const mockDispatchBackgroundWorkflow = mock<
  typeof BackgroundDispatch.dispatchBackgroundWorkflow
>(() => Promise.resolve());
export const mockValidateAndResolveIsolation = mock<
  typeof IsolationResolver.validateAndResolveIsolation
>(() => Promise.resolve({ cwd: '/test/cwd', status: 'none', env: null }));
mock.module('../orchestrator/dispatch/isolation-resolver', () => ({
  ensureIsolationConfigured: mock(() => undefined),
  validateAndResolveIsolation: mockValidateAndResolveIsolation,
}));
mock.module('../orchestrator/dispatch/background', () => ({
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
  formatWorkflowContextSection: mock((results: unknown[]) =>
    results.length > 0 ? '## Recent Workflow Results\n\n...' : ''
  ),
}));

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
  ISOLATION_PROVIDER_TYPES,
  ISOLATION_WORKFLOW_TYPES,
  ENVIRONMENT_STATUSES,
  WORKTREE_REMOVAL_OWNER,
  WorktreeRemovalInProgressError,
  IsolationBlockedError: class IsolationBlockedError extends Error {
    public reason: string;
    constructor(reason: string) {
      super(reason);
      this.reason = reason;
      this.name = 'IsolationBlockedError';
    }
  },
  // Loaded transitively via workflow-dispatch → child-isolation-resolver.
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
  // /register-project marks a path whose findRepoRoot root is non-null as kind: 'repo'.
  findRepoRoot: mock((p: string) => Promise.resolve(p)),
  trustRegisteredPath: mock(async () => {}),
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
mock.module('../db/user-ai-prefs-store', () => ({
  getUserAiPrefs: mockGetUserAiPrefsDb,
  setUserTiers: mock(() => Promise.resolve()),
  setUserAliases: mock(() => Promise.resolve()),
  setUserDefault: mock(() => Promise.resolve()),
  clearUserAiPrefs: mock(() => Promise.resolve()),
}));
// Reset the shared filesystem predicate across all suites, including project
// commands, so a dispatch test cannot leak its filesystem assumptions.
beforeEach(() => {
  mockExistsSync.mockImplementation(() => true);
});

// ─── Helpers for handleMessage tests ─────────────────────────────────────────

export function chatDispatchLogs(): Record<string, unknown>[] {
  return mockLogger.info.mock.calls
    .filter(c => c[1] === 'orchestrator.chat_dispatch_started')
    .map(c => c[0] as Record<string, unknown>);
}

const resumableRuns = new Map<string, WorkflowRun>();

export function makeResumableRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  const run = makeRun({
    id: 'resumable-run-1',
    origin: { conversationId: 'conv-1', parentConversationId: 'conv-1' },
    parent_conversation_id: 'conv-1',
    status: 'failed',
    user_message: 'old failed prompt',
    working_path: '/repos/test-repo/worktrees/feature',
    ...overrides,
  });
  resumableRuns.set(run.id, run);
  return run;
}

/** Mock resets shared by the dispatch-routing and typed-chat-tool suites. */
export function resetDispatchMocks(): void {
  resumableRuns.clear();
  mockGetWorkflowRunDb.mockReset();
  mockGetWorkflowRunDb.mockImplementation(async id => resumableRuns.get(id) ?? null);
  capturedSourceOwnerCalls.length = 0;
  mockCreateWorkflowRun.mockClear();
  mockFailPreparedRun.mockReset();
  mockFailPreparedRun.mockResolvedValue({ failed: true });
  mockExecuteWorkflow.mockClear();
  mockDispatchBackgroundWorkflow.mockClear();
  mockFindResumableRunByParentConversation.mockClear();
  mockHydrateResumableRun.mockClear();
  mockInspectResumableRun.mockReset();
  mockInspectResumableRun.mockImplementation(() =>
    Promise.resolve({
      priorCompletedNodes: new Map([['n1', { output: 'v1' }]]),
      priorFailedNodes: new Map(),
      priorUsage: { costUsd: 0 },
    })
  );
  mockUpdateWorkflowRun.mockClear();
  mockUpdateWorkflowRun.mockImplementation(() => Promise.resolve());
  mockResolveApprovalGate.mockClear();
  mockResolveApprovalGate.mockImplementation(() => Promise.resolve({ resolved: true }));
  mockHandleCommand.mockReset();
  mockHandleCommand.mockImplementation(() =>
    Promise.resolve({ success: true, message: 'ok', workflow: undefined })
  );
  mockParseCommand.mockClear();
  mockStartWorkflow.mockClear();
  mockGetOrCreateConversation.mockReset();
  mockGetOrCreateConversation.mockImplementation(() => Promise.resolve(makeConversation()));
  mockGetCodebase.mockReset();
  mockGetCodebase.mockImplementation(() => Promise.resolve(null));
  mockValidateAndResolveIsolation.mockReset();
  mockValidateAndResolveIsolation.mockResolvedValue({
    status: 'none',
    cwd: '/test/cwd',
    env: null,
  });
  mockResolveWorkflowAdoption.mockClear();
  mockUpdateConversation.mockClear();
  mockResolveWorkflowSourceRoot.mockClear();
  mockResolveWorkflowSourceRoot.mockResolvedValue(undefined);
  mockDiscoverWorkflowsWithConfig.mockReset();
  mockDiscoverWorkflowsWithConfig.mockResolvedValue({
    workflows: [makeTestWorkflowWithSource({ name: 'test-workflow' })],
    errors: [],
  });
  mockStartRunLiveOwner.mockClear();
  mockWithRunLiveOwner.mockClear();
  mockCloseRunLiveOwner.mockClear();
}

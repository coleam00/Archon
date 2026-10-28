// @archon-test-isolated
import type * as WorkflowRunSource from '@archon/workflows/run-source';
import type { RunActor } from '../operations/run-authorization';
import type { ProviderRegistry } from '@archon/provider-contract';
mock.module('../workflows/branch-launch-source', () => ({
  withBranchLaunchSource: async (
    _repo: string,
    _branch: string,
    prepare: (path: string) => Promise<unknown>
  ) => prepare('/adopted/snapshot'),
}));
import * as git from '@archon/git';
import { mock, describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { mkdtemp, realpath, writeFile } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { MockPlatformAdapter } from '../test/mocks/platform';
import { createMockLogger } from '../test/mocks/logger';
import {
  makeTestResolvedWorkflow,
  withObservableCapturedSource,
} from '@archon/workflows/test-utils';
import type { Conversation, Codebase, Session } from '../types';
import { ConversationNotFoundError } from '../types';
import type { IAgentProvider, ProviderCapabilities } from '@archon/providers/types';
import type * as Providers from '@archon/providers';
import type * as CodebaseDb from '../db/codebases';
import type * as ConversationDb from '../db/conversations';
import type * as SessionDb from '../db/sessions';
import type * as CommandHandler from '../handlers/command-handler';
import type * as ConfigLoader from '../config/config-loader';
import type * as WorkflowDiscovery from '@archon/workflows/workflow-discovery';
import type * as WorkflowExecutor from '@archon/workflows/executor';
import type * as WorkflowRouter from '@archon/workflows/router';
import type * as WorkflowSourceRoot from '../utils/workflow-source-root';
import type * as IsolationResolver from './dispatch/isolation-resolver';
import type * as BackgroundDispatch from './dispatch/background';
import type * as RunLiveOwnerModule from '../services/run-live-owner';
import type * as PromptBuilder from './prompt-builder';
import type * as TitleGenerator from '../services/title-generator';
import type * as WorkflowDb from '../db/workflows';

// ─── Mock setup (BEFORE importing module under test) ─────────────────────────

const operator: RunActor = { kind: 'operator' };

const mockLogger = createMockLogger();
// Stands in for the real shared canonicalizer. Tests build their expected
// `default_cwd` by calling THIS function, so the expectation can never drift
// from what the product resolved, on any platform.
async function canonicalizeForTest(p: string): Promise<string> {
  const absolute = resolve(p);
  return await realpath(absolute).catch(() => absolute);
}
const { getProjectStoragePaths, resolveProjectStorageKey } = await import('@archon/paths');
const mockCanonicalizeProjectPath = mock(canonicalizeForTest);
mock.module('@archon/paths', () => ({
  canonicalizeProjectPath: mockCanonicalizeProjectPath,
  getProjectStoragePaths,
  resolveProjectStorageKey,
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  ensureArchonWorkspacesPath: mock(() => Promise.resolve('/home/test/.archon/workspaces')),
  getArchonHome: mock(() => '/home/test/.archon'),
  getCredentialKeyPath: mock(() => '/home/test/.archon/credential-key'),
  captureChatTurn: mock(() => undefined),
  captureCodebaseRegistered: mock(() => undefined),
}));

// DB mocks
const mockGetOrCreateConversation = mock<typeof ConversationDb.getOrCreateConversation>(() =>
  Promise.resolve({
    id: 'conv-123',
    platform_type: 'telegram',
    platform_conversation_id: 'chat-456',
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
const mockGetConversationByPlatformId = mock<typeof ConversationDb.getConversationByPlatformId>(
  () => Promise.resolve(null)
);
const mockUpdateConversation = mock<typeof ConversationDb.updateConversation>(() =>
  Promise.resolve()
);
const mockTouchConversation = mock<typeof ConversationDb.touchConversation>(() =>
  Promise.resolve()
);

mock.module('../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  getConversationByPlatformId: mockGetConversationByPlatformId,
  updateConversation: mockUpdateConversation,
  touchConversation: mockTouchConversation,
}));

const mockGetCodebase = mock<typeof CodebaseDb.getCodebase>(() => Promise.resolve(null));
const mockListCodebases = mock<typeof CodebaseDb.listCodebases>(() => Promise.resolve([]));
const mockCreateCodebase = mock<typeof CodebaseDb.createCodebase>(() =>
  Promise.resolve({
    id: 'new-codebase-id',
    name: 'test-project',
    repository_url: 'https://github.com/user/repo',
    default_cwd: '/workspace/test-project',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  })
);
const mockRepairCodebaseRegistration = mock<typeof CodebaseDb.repairCodebaseRegistration>(() =>
  Promise.resolve()
);
const mockUpdateCodebase = mock<typeof CodebaseDb.updateCodebase>(() => Promise.resolve());

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
}));

// Registration itself is covered in ../handlers; these tests cover how chat routes to it.
const registered = (path: string, name = 'my-app') => ({
  codebaseId: 'new-id',
  name,
  repositoryUrl: null,
  defaultCwd: path,
  defaultBranch: null,
  commandCount: 0,
  alreadyExisted: false,
});
const mockRegisterFolder = mock(async (path: string, name?: string) => registered(path, name));
const mockRegisterRepository = mock(async (path: string, options: { name?: string } = {}) =>
  registered(path, options.name)
);
mock.module('../handlers/sql-registration', () => ({
  registerFolder: mockRegisterFolder,
  registerRepository: mockRegisterRepository,
}));

const mockGetActiveSession = mock<typeof SessionDb.getActiveSession>(() => Promise.resolve(null));
const mockCreateSession = mock<typeof SessionDb.createSession>(() =>
  Promise.resolve({
    id: 'session-abc',
    conversation_id: 'conv-123',
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
const mockUpdateSession = mock<typeof SessionDb.updateSession>(() => Promise.resolve());
const mockDeactivateSession = mock<typeof SessionDb.deactivateSession>(() => Promise.resolve());
const mockTransitionSession = mock<typeof SessionDb.transitionSession>(
  async (conversationId, reason, data) => {
    const current = await mockGetActiveSession(conversationId);
    if (current) {
      await mockDeactivateSession(current.id, reason);
    }
    return mockCreateSession({
      conversation_id: conversationId,
      codebase_id: data.codebase_id,
      ai_assistant_type: data.ai_assistant_type,
      parent_session_id: current?.id,
      transition_reason: reason,
    });
  }
);

mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  createSession: mockCreateSession,
  updateSession: mockUpdateSession,
  deactivateSession: mockDeactivateSession,
  transitionSession: mockTransitionSession,
}));

// handleMessage persists the assistant reply for every non-web platform, and the
// fixture adapter reports 'mock'. Without this stub those calls reach the real
// lazy getDatabase() singleton on every test — and both call sites swallow the
// resulting error (addMessage into a .catch, getRecentWorkflowResultMessages into
// its own try/catch), so the I/O is invisible rather than red. #2982
mock.module('../db/messages', () => ({
  addMessage: mock(() => Promise.resolve()),
  listMessages: mock(() => Promise.resolve([])),
  getRecentWorkflowResultMessages: mock(() => Promise.resolve([])),
}));

// Same shape as the messages gap above: the chat path loads per-codebase env
// vars for any conversation carrying a codebase_id, and its failure lands in a
// `codebase_env_vars_load_failed` warn on the mocked logger. #2982
mock.module('../db/env-vars', () => ({
  getCodebaseEnvVars: mock(() => Promise.resolve({})),
}));

// Command handler mock
const mockHandleCommand = mock<typeof CommandHandler.handleCommand>(() =>
  Promise.resolve({ message: '', modified: false, success: true })
);
const mockParseCommand = mock<typeof CommandHandler.parseCommand>((message: string) => {
  const parts = message.split(/\s+/);
  return { command: parts[0].substring(1), args: parts.slice(1) };
});

mock.module('../handlers/command-handler', () => ({
  handleCommand: mockHandleCommand,
  parseCommand: mockParseCommand,
}));

// AI provider mock
const mockGetAgentProvider = mock<typeof Providers.getAgentProvider>(() => {
  throw new Error('Agent provider mock is not configured');
});
const providerCapabilities: ProviderCapabilities = {
  backgroundWork: 'unobserved' as const,
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  plugins: false,
  agents: true,
  toolRestrictions: true,
  structuredOutput: 'enforced',
  envInjection: true,
  costControl: true,
  costReporting: true,
  effortControl: true,
  fallbackModel: true,
  sandbox: true,
  settingSources: true,
  // Model the CLI transport for providers without in-process tools.
  nativeTools: false,
  containerExec: true,
  requiresAllPropertiesRequired: false,
};
const mockGetProviderCapabilities = mock<typeof Providers.getProviderCapabilities>(
  () => providerCapabilities
);

const providerRegistry: ProviderRegistry = {
  get: id => ({
    id,
    displayName: id,
    builtIn: true,
    capabilities: mockGetProviderCapabilities(id),
    parseConfig: raw => raw,
    credentials: { kind: 'static', specs: [], vendorFor: () => 'anthropic' },
  }),
  list: () => [],
};

mock.module('@archon/providers', () => ({
  providerRegistry,
  getRegistration: () => ({
    parseConfig: (raw: Record<string, unknown>) => raw,
    credentials: { vendorFor: () => 'anthropic' },
  }),
  getAgentProvider: mockGetAgentProvider,
  getProviderCapabilities: mockGetProviderCapabilities,
  isRegisteredProvider: mock(() => true),
  getRegisteredProviders: mock(() => []),
  // credentials/delivery (#1955) imports these from '@archon/providers'.
  PI_PROVIDER_ENV_VARS: { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' },
  PI_AMBIENT_VENDORS: ['amazon-bedrock', 'google-vertex'],
}));

// Workflow mocks
const mockDiscoverWorkflows = mock<typeof WorkflowDiscovery.discoverWorkflowsWithConfig>(() =>
  Promise.resolve({ workflows: [], errors: [] })
);
const mockExecuteWorkflow = mock<typeof WorkflowExecutor.executeWorkflow>(() =>
  Promise.resolve({ success: true, workflowRunId: 'run-1' })
);
const mockFindWorkflow = mock<typeof WorkflowRouter.findWorkflow>((name, workflows) =>
  workflows.find(w => w.name === name)
);

mock.module('../workflows/store-adapter', () => ({
  createWorkflowDeps: mock(() => ({
    providers: providerRegistry,
    store: {
      getCodebaseEnvVars: async () => ({}),
      createWorkflowRun: async (
        data: Parameters<import('@archon/workflows/store').IWorkflowStore['createWorkflowRun']>[0]
      ): Promise<import('@archon/workflows/schemas/workflow-run').WorkflowRun> => ({
        id: data.id ?? 'run-1',
        workflow_name: data.workflow_name,
        status: 'pending',
        outcome: null,
        origin: data.origin ?? null,
        conversation_id: data.origin?.conversationId ?? null,
        parent_conversation_id: data.origin?.parentConversationId ?? null,
        user_id: data.origin?.userId ?? null,
        codebase_id: data.codebase_id ?? null,
        user_message: data.user_message,
        metadata: data.metadata ?? {},
        started_at: new Date(),
        completed_at: null,
        last_activity_at: null,
        working_path: null,
        parent_run_id: null,
        adopted_from_run_id: null,
        output_root: null,
        checkout_baseline: null,
      }),
      updateWorkflowRun: async () => {},
      failWorkflowRun: async () => ({ failed: true }),
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
    loadConfig: async () => ({ assistant: 'claude', assistants: { claude: {} }, commands: {} }),
  })),
}));

// Config mock
const mockLoadConfig = mock<typeof ConfigLoader.loadConfig>(() =>
  Promise.resolve({
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
  })
);

mock.module('../config/config-loader', () => ({
  loadConfig: mockLoadConfig,
  loadRepoConfig: mock<typeof ConfigLoader.loadRepoConfig>(() => Promise.resolve({})),
}));

// Workflow source root: undefined = "read the cwd", the non-worktree behavior.
const mockResolveWorkflowSourceRoot = mock<typeof WorkflowSourceRoot.resolveWorkflowSourceRoot>(
  (_cwd: string) => Promise.resolve<string | undefined>(undefined)
);

mock.module('../utils/workflow-source-root', () => ({
  resolveWorkflowSourceRoot: mockResolveWorkflowSourceRoot,
}));

// Orchestrator (isolation & dispatch) mocks
const mockValidateAndResolveIsolation = mock<typeof IsolationResolver.validateAndResolveIsolation>(
  () =>
    Promise.resolve({
      status: 'existing',
      cwd: '/workspace/project',
      env: {
        id: 'env-1',
        codebase_id: 'codebase-789',
        workflow_type: 'task',
        workflow_id: 'task-1',
        provider: 'worktree',
        working_path: '/workspace/project',
        branch_name: 'task-1',
        status: 'active',
        created_at: new Date(),
        created_by_platform: 'test',
        created_by_user_id: null,
        metadata: {},
      },
    })
);
const mockDispatchBackgroundWorkflow = mock<typeof BackgroundDispatch.dispatchBackgroundWorkflow>(
  () => Promise.resolve()
);

mock.module('./dispatch/isolation-resolver', () => ({
  ensureIsolationConfigured: mock(() => undefined),
  validateAndResolveIsolation: mockValidateAndResolveIsolation,
}));
mock.module('./dispatch/background', () => ({
  dispatchBackgroundWorkflow: mockDispatchBackgroundWorkflow,
}));

// The real live owner opens a socket and a lock file keyed by the run id, and every dispatch
// here shares 'prepared-run-id'. On Windows that socket is a machine-global named pipe.
const mockRunLiveOwner: RunLiveOwnerModule.RunLiveOwner = {
  close: () => Promise.resolve(),
  isStopRequested: () => false,
  registerTerminationPreparation: () => () => undefined,
};
const realRunLiveOwner = { ...(await import('../services/run-live-owner')) };
mock.module('../services/run-live-owner', () => ({
  ...realRunLiveOwner,
  startRunLiveOwner: mock(() => Promise.resolve(mockRunLiveOwner)),
  withRunLiveOwner: mock<typeof RunLiveOwnerModule.withRunLiveOwner>(
    async (_runId, _options, body) => body(mockRunLiveOwner)
  ),
}));

// Prompt builder mock
const mockBuildOrchestratorPrompt = mock<typeof PromptBuilder.buildOrchestratorPrompt>(
  () => 'You are the orchestrator agent.'
);
const mockBuildProjectScopedPrompt = mock<typeof PromptBuilder.buildProjectScopedPrompt>(
  async () => 'You are scoped to project X.'
);
const mockBuildOrchestratorSystemAppend = mock<typeof PromptBuilder.buildOrchestratorSystemAppend>(
  async () => 'orchestrator system append'
);

mock.module('./prompt-builder', () => ({
  buildOrchestratorPrompt: mockBuildOrchestratorPrompt,
  buildProjectScopedPrompt: mockBuildProjectScopedPrompt,
  buildOrchestratorSystemAppend: mockBuildOrchestratorSystemAppend,
}));

// Error/tool formatter mocks
mock.module('../utils/error-formatter', () => ({
  classifyAndFormatError: mock((err: Error) => `⚠️ Error: ${err.message}`),
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflows,
}));
const capturedSourceOwnerCalls: string[] = [];

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));
mock.module('@archon/workflows/run-resume', () => ({
  hydrateResumableRun: mock(() => Promise.resolve(null)),
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
  prepareWorkflowSource: mock(() =>
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
      anchor: {
        root: '/capture',
        digest: 'test-digest',
        config: {
          load_default_workflows: true,
          load_default_commands: true,
        },
      },
      roots: {
        project: '/capture/project',
        globalWorkflows: '/capture/global/workflows',
        globalCommands: '/capture/global/commands',
        globalScripts: '/capture/global/scripts',
        bundledWorkflows: '/capture/bundled/workflows',
        bundledCommands: '/capture/bundled/commands/defaults',
        kind: 'captured',
        anchor: {
          root: '/capture',
          digest: 'test-digest',
          config: {
            load_default_workflows: true,
            load_default_commands: true,
          },
        },
      },
    })
  ),
  recordSelectedWorkflow: mock(() => Promise.resolve()),
  disposeWorkflowSource: mock(() => Promise.resolve()),
  resolveContinuationWorkflow: mock(() => Promise.resolve(undefined)),
  withCapturedSource: mock((body: Parameters<typeof withObservableCapturedSource>[1]) =>
    withObservableCapturedSource(capturedSourceOwnerCalls, body)
  ),
}));
mock.module('@archon/workflows/router', () => ({
  findWorkflow: mockFindWorkflow,
  // Statically imported by the background dispatch path (see dispatch/background.ts).
  resolveWorkflowName: mock((name: string, workflows: { name: string }[]) =>
    workflows.find(w => w.name === name)
  ),
}));
mock.module('@archon/workflows/utils/tool-formatter', () => ({
  formatToolCall: mock((toolName: string, _toolInput: unknown) => `🔧 ${toolName.toUpperCase()}`),
}));

// fs mock for existsSync
const mockExistsSync = mock<typeof import('fs').existsSync>(() => true);
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

// Title generator mock
const mockGenerateAndSetTitle = mock<typeof TitleGenerator.generateAndSetTitle>(() =>
  Promise.resolve()
);
mock.module('../services/title-generator', () => ({
  generateAndSetTitle: mockGenerateAndSetTitle,
}));

// Workflow DB mock — dispatchOrchestratorWorkflow now consults findResumableRunByParentConversation
// for all platforms (not just web), so this module must be stubbed even when these tests don't
// exercise the resume path. The default null return keeps execution on the "fresh run" branch.
mock.module('../db/workflows', () => ({
  findResumableRunByParentConversation: mock<
    typeof WorkflowDb.findResumableRunByParentConversation
  >(() => Promise.resolve(null)),
  getPausedWorkflowRun: mock<typeof WorkflowDb.getPausedWorkflowRun>(() => Promise.resolve(null)),
  updateWorkflowRun: mock<typeof WorkflowDb.updateWorkflowRun>(() => Promise.resolve()),
}));

// ─── Import module under test (AFTER all mocks) ─────────────────────────────

import { handleMessage } from './orchestrator-agent';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const mockConversation: Conversation = {
  id: 'conv-123',
  platform_type: 'telegram',
  platform_conversation_id: 'chat-456',
  ai_assistant_type: 'claude',
  codebase_id: null,
  cwd: null,
  isolation_env_id: null,
  title: null,
  hidden: false,
  deleted_at: null,
  last_activity_at: null,
  user_id: null,
  created_at: new Date(),
  updated_at: new Date(),
};

const mockConversationWithProject: Conversation = {
  ...mockConversation,
  codebase_id: 'codebase-789',
  cwd: '/workspace/project',
};

const mockCodebase: Codebase = {
  id: 'codebase-789',
  name: 'test-project',
  repository_url: 'https://github.com/user/repo',
  default_cwd: '/workspace/test-project',
  default_branch: null,
  ai_assistant_type: 'claude',
  kind: 'repo',
  commands: {},
  created_at: new Date(),
  updated_at: new Date(),
};

const mockSession: Session = {
  id: 'session-abc',
  conversation_id: 'conv-123',
  codebase_id: null,
  ai_assistant_type: 'claude',
  assistant_session_id: 'claude-session-xyz',
  active: true,
  metadata: {},
  started_at: new Date(),
  ended_at: null,
  parent_session_id: null,
  transition_reason: null,
  ended_reason: null,
};

const mockClientSendQuery = mock<IAgentProvider['sendQuery']>(async function* () {
  yield { type: 'result', sessionId: 'session-id' };
});
const mockClient = {
  sendQuery: mockClientSendQuery,
  checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
  getType: mock(() => 'claude'),
  getCapabilities: mock(() => providerCapabilities),
} satisfies IAgentProvider;

// ─── Helpers ────────────────────────────────────────────────────────────────

function clearAllMocks(): void {
  mockLogger.fatal.mockClear();
  mockLogger.error.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.info.mockClear();
  mockLogger.debug.mockClear();
  mockLogger.trace.mockClear();

  mockGetOrCreateConversation.mockClear();
  mockGetConversationByPlatformId.mockClear();
  mockUpdateConversation.mockClear();
  mockTouchConversation.mockClear();
  mockGetCodebase.mockClear();
  mockListCodebases.mockClear();
  mockCreateCodebase.mockClear();
  mockRegisterFolder.mockClear();
  mockRegisterRepository.mockClear();
  mockGetActiveSession.mockClear();
  mockCreateSession.mockClear();
  mockUpdateSession.mockClear();
  mockDeactivateSession.mockClear();
  mockTransitionSession.mockClear();
  mockHandleCommand.mockClear();
  mockParseCommand.mockClear();
  mockGetAgentProvider.mockClear();
  mockGetProviderCapabilities.mockClear();
  mockDiscoverWorkflows.mockClear();
  mockExecuteWorkflow.mockClear();
  mockFindWorkflow.mockClear();
  mockResolveWorkflowSourceRoot.mockClear();
  mockResolveWorkflowSourceRoot.mockImplementation(() => Promise.resolve(undefined));
  mockValidateAndResolveIsolation.mockClear();
  mockDispatchBackgroundWorkflow.mockClear();
  mockBuildOrchestratorPrompt.mockClear();
  mockBuildProjectScopedPrompt.mockClear();
  mockBuildOrchestratorSystemAppend.mockClear();
  mockLoadConfig.mockClear();
  mockExistsSync.mockClear();
  mockUpdateCodebase.mockClear();
  mockRepairCodebaseRegistration.mockClear();
  // Reset, not clear: a `mockImplementationOnce` that its test never reached
  // (because the handler returned early) would otherwise be consumed by the
  // next test and report a second, misleading failure.
  mockCanonicalizeProjectPath.mockReset();
  mockCanonicalizeProjectPath.mockImplementation(canonicalizeForTest);
  mockGenerateAndSetTitle.mockClear();
  mockClient.sendQuery.mockClear();
  mockClient.getType.mockClear();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('orchestrator-agent handleMessage', () => {
  let platform: MockPlatformAdapter;

  beforeEach(() => {
    clearAllMocks();
    platform = new MockPlatformAdapter();

    // Default mocks
    mockGetOrCreateConversation.mockResolvedValue(mockConversation);
    mockListCodebases.mockResolvedValue([]);
    mockGetActiveSession.mockResolvedValue(null);
    mockCreateSession.mockResolvedValue(mockSession);
    mockTransitionSession.mockResolvedValue(mockSession);
    mockGetAgentProvider.mockReturnValue(mockClient);
    mockGetProviderCapabilities.mockReturnValue(providerCapabilities);
    mockDiscoverWorkflows.mockResolvedValue({ workflows: [], errors: [] });
    mockParseCommand.mockImplementation((message: string) => {
      const parts = message.split(/\s+/);
      return { command: parts[0].substring(1), args: parts.slice(1) };
    });
  });

  // ─── Slash Commands ─────────────────────────────────────────────────────

  describe('slash commands', () => {
    test('delegates /status to command handler', async () => {
      mockHandleCommand.mockResolvedValue({
        message: 'Status info',
        modified: false,
        success: true,
      });

      await handleMessage(platform, 'chat-456', '/status', { actor: operator });

      expect(mockHandleCommand).toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Status info');
      expect(mockGetAgentProvider).not.toHaveBeenCalled();
    });

    test('delegates /help to command handler', async () => {
      mockHandleCommand.mockResolvedValue({
        message: 'Help text',
        modified: false,
        success: true,
      });

      await handleMessage(platform, 'chat-456', '/help', { actor: operator });

      expect(mockHandleCommand).toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Help text');
    });

    test('delegates /reset to command handler', async () => {
      mockHandleCommand.mockResolvedValue({
        message: 'Session cleared',
        modified: false,
        success: true,
      });

      await handleMessage(platform, 'chat-456', '/reset', { actor: operator });

      expect(mockHandleCommand).toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Session cleared');
    });

    test('uses CommandResult workflow definition without rediscovery for /workflow run', async () => {
      const workflowDefinition = makeTestResolvedWorkflow({
        name: 'test-workflow',
        description: 'A test workflow',
      });
      mockGetOrCreateConversation.mockResolvedValue(mockConversationWithProject);
      mockGetCodebase.mockResolvedValue(mockCodebase);
      mockHandleCommand.mockResolvedValue({
        success: true,
        message: 'Starting workflow: `test-workflow`',
        workflow: { kind: 'start', definition: workflowDefinition, args: 'payload' },
      });

      await handleMessage(platform, 'chat-456', '/workflow run test-workflow payload', {
        actor: operator,
      });

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'Starting workflow: `test-workflow`'
      );
      expect(mockDiscoverWorkflows).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).toHaveBeenCalled();
    });

    test('non-deterministic commands go to AI orchestrator', async () => {
      // /unknown-command should NOT be routed to command handler
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'I can help with that.' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/unknown-command', { actor: operator });

      expect(mockHandleCommand).not.toHaveBeenCalled();
      // Should go through AI path
      expect(mockClient.sendQuery).toHaveBeenCalled();
    });
  });

  // ─── Regular Messages (AI Orchestrator Path) ───────────────────────────

  describe('AI orchestrator path', () => {
    test('sends message to AI and streams response', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'I can help you with that!' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'Hello, help me', { actor: operator });

      expect(mockClient.sendQuery).toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'I can help you with that!');
    });

    test('does NOT require a codebase to function', async () => {
      // Conversation has no codebase_id — this is fine for the orchestrator
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Hello!' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hi', { actor: operator });

      // Should NOT send an error about missing codebase
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Hello!');
    });

    test('loads all codebases for prompt context', async () => {
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help me', { actor: operator });

      expect(mockListCodebases).toHaveBeenCalled();
      expect(mockBuildOrchestratorSystemAppend).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        [mockCodebase],
        expect.any(Array),
        'cli'
      );
    });

    test('teaches the typed tools to a provider with in-process tools', async () => {
      mockGetProviderCapabilities.mockImplementation(() => ({
        ...providerCapabilities,
        nativeTools: true,
      }));
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      try {
        await handleMessage(platform, 'chat-456', 'help me', { actor: operator });
      } finally {
        mockGetProviderCapabilities.mockImplementation(() => providerCapabilities);
      }

      expect(mockBuildOrchestratorSystemAppend).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Array),
        expect.any(Array),
        'tools'
      );
    });

    test('builds project-scoped prompt when conversation has codebase_id', async () => {
      mockGetOrCreateConversation.mockResolvedValue(mockConversationWithProject);
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockGetCodebase.mockResolvedValue(mockCodebase);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Scoped response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help', { actor: operator });

      expect(mockBuildOrchestratorSystemAppend).toHaveBeenCalledWith(
        expect.objectContaining({ codebase_id: 'codebase-789' }),
        [mockCodebase],
        expect.any(Array),
        'cli'
      );
    });

    test('calls touchConversation for activity tracking', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      expect(mockTouchConversation).toHaveBeenCalledWith('conv-123');
    });
  });

  // ─── Session Management ────────────────────────────────────────────────

  describe('session management', () => {
    test('creates new session when none exists', async () => {
      mockGetActiveSession.mockResolvedValue(null);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      expect(mockTransitionSession).toHaveBeenCalledWith('conv-123', 'first-message', {
        ai_assistant_type: 'claude',
      });
    });

    test('reuses existing session', async () => {
      mockGetActiveSession.mockResolvedValue(mockSession);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'new-ai-session' };
      });

      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      expect(mockTransitionSession).not.toHaveBeenCalled();
      // Should pass existing assistant_session_id to AI provider
      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'claude-session-xyz',
        expect.any(Object)
      );
    });

    test('persists new AI session ID', async () => {
      mockGetActiveSession.mockResolvedValue(mockSession);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'new-ai-session-456' };
      });

      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      expect(mockUpdateSession).toHaveBeenCalledWith('session-abc', 'new-ai-session-456');
    });
  });

  // ─── settingSources forwarding ────────────────────────────────────────

  describe('assistantConfig forwarding', () => {
    test('passes assistantConfig with settingSources for claude', async () => {
      mockLoadConfig.mockResolvedValueOnce({
        botName: 'Archon',
        assistant: 'claude',
        assistants: {
          claude: { settingSources: ['project', 'user'] },
          codex: {},
        },
        streaming: { telegram: 'stream', discord: 'batch', slack: 'batch' },
        attentionNotices: [],
        concurrency: { maxConversations: 10 },
        workflows: {
          autoResumeOnQuotaReset: false,
        },
        commands: { autoLoad: true },
        defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
      });

      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.anything(),
        expect.objectContaining({
          assistantConfig: expect.objectContaining({ settingSources: ['project', 'user'] }),
        })
      );
    });

    test('passes codex assistantConfig for codex assistant', async () => {
      const codexConversation: Conversation = {
        ...mockConversation,
        ai_assistant_type: 'codex',
      };
      mockGetOrCreateConversation.mockResolvedValueOnce(codexConversation);
      mockLoadConfig.mockResolvedValueOnce({
        botName: 'Archon',
        assistant: 'codex',
        assistants: {
          claude: { settingSources: ['project', 'user'] },
          codex: {},
        },
        streaming: { telegram: 'stream', discord: 'batch', slack: 'batch' },
        attentionNotices: [],
        concurrency: { maxConversations: 10 },
        workflows: {
          autoResumeOnQuotaReset: false,
        },
        commands: { autoLoad: true },
        defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
      });

      const codexSendQuery = mock<IAgentProvider['sendQuery']>(async function* () {
        yield { type: 'result', sessionId: 'codex-session' };
      });
      const codexClient = {
        sendQuery: codexSendQuery,
        checkCredential: async () => ({ state: 'not_checked' as const, source: 'native' as const }),
        getType: () => 'codex',
        getCapabilities: () => providerCapabilities,
      } satisfies IAgentProvider;
      mockGetAgentProvider.mockReturnValueOnce(codexClient);

      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      // Should pass codex assistantConfig, not claude's
      const callArgs = codexClient.sendQuery.mock.calls[0];
      const requestOptions = callArgs?.[3];
      expect(requestOptions).toBeDefined();
      expect(requestOptions).not.toHaveProperty('settingSources');
      expect(requestOptions?.assistantConfig).toBeDefined();
    });

    test('uses repo tiers for direct chat and title generation', async () => {
      mockLoadConfig.mockResolvedValueOnce({
        botName: 'Archon',
        assistant: 'claude',
        assistants: {
          claude: {},
          codex: {},
        },
        tiers: {
          large: { provider: 'codex', model: 'gpt-5.5', effort: 'high' },
          small: { provider: 'claude', model: 'haiku' },
        },
        streaming: { telegram: 'stream', discord: 'batch', slack: 'batch' },
        attentionNotices: [],
        concurrency: { maxConversations: 10 },
        workflows: {
          autoResumeOnQuotaReset: false,
        },
        commands: { autoLoad: true },
        defaults: { loadDefaultCommands: true, loadDefaultWorkflows: true },
      });

      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      expect(mockGetAgentProvider).toHaveBeenCalledWith('codex');
      expect(mockClient.sendQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.anything(),
        expect.objectContaining({
          model: 'gpt-5.5',
          // #2556: a tier's `effort` goes on the one nodeConfig channel for
          // every provider; Codex translates it to modelReasoningEffort itself.
          nodeConfig: expect.objectContaining({ effort: 'high' }),
        })
      );
      expect(mockGenerateAndSetTitle).toHaveBeenCalledWith(
        'conv-123',
        'hello',
        'claude',
        expect.any(String),
        undefined,
        expect.any(Object),
        expect.objectContaining({ model: 'haiku' })
      );
    });
  });

  // ─── Streaming Mode ────────────────────────────────────────────────────

  describe('stream mode', () => {
    beforeEach(() => {
      platform.getStreamingMode.mockReturnValue('stream');
    });

    test('streams assistant messages immediately', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'First chunk' };
        yield { type: 'agent_message_chunk', text: 'Second chunk' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help', { actor: operator });

      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'First chunk');
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Second chunk');
    });

    test('streams tool calls with formatted message', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'tool_call',
          toolCallId: 'call-1',
          name: 'Bash',
          rawInput: { command: 'ls' },
        };
        yield { type: 'agent_message_chunk', text: 'Done' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'list files', { actor: operator });

      // formatToolCall mock returns '🔧 BASH'
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', '🔧 BASH', {
        category: 'tool_call_formatted',
      });
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Done');
    });
  });

  // ─── Batch Mode ────────────────────────────────────────────────────────

  describe('batch mode', () => {
    beforeEach(() => {
      platform.getStreamingMode.mockReturnValue('batch');
    });

    test('accumulates messages and sends final clean response', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Part 1' };
        yield { type: 'agent_message_chunk', text: 'Part 2\n\nFinal summary' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help', { actor: operator });

      // Batch mode should send ONE combined message
      expect(platform.sendMessage).toHaveBeenCalledTimes(1);
      const sentMessage = platform.sendMessage.mock.calls[0][1] as string;
      expect(sentMessage).toContain('Part 1');
      expect(sentMessage).toContain('Final summary');
    });

    test('filters emoji tool indicators from batch response', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: '🔧 BASH\nnpm test\n\nClean summary here' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'run tests', { actor: operator });

      const sentMessage = platform.sendMessage.mock.calls[0][1] as string;
      expect(sentMessage).not.toContain('🔧');
      expect(sentMessage).toContain('Clean summary');
    });

    test('sends nothing when AI returns empty response', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      expect(platform.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ─── Workflow Discovery ────────────────────────────────────────────────

  describe('workflow discovery', () => {
    test('discovers global workflows from workspaces path', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help', { actor: operator });

      // Discovery is called positionally with (cwd, loadConfig) — no options arg.
      // Home-scoped workflows (~/.archon/workflows/) are discovered internally.
      expect(mockDiscoverWorkflows).toHaveBeenCalledWith(
        '/home/test/.archon/workspaces',
        expect.any(Function),
        providerRegistry
      );
    });

    test('also discovers repo-specific workflows when conversation has project', async () => {
      mockGetOrCreateConversation.mockResolvedValue(mockConversationWithProject);
      mockGetCodebase.mockResolvedValue(mockCodebase);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help', { actor: operator });

      // Should call discoverWorkflows twice: global + repo-specific
      expect(mockDiscoverWorkflows).toHaveBeenCalledTimes(2);
      expect(mockDiscoverWorkflows).toHaveBeenCalledWith(
        '/workspace/project',
        expect.any(Function),
        providerRegistry,
        undefined // non-worktree cwd: source root is the cwd itself
      );
    });

    test('discovers repo workflows from the authoring root, not the worktree', async () => {
      // The old behavior copied the canonical repo's `.archon` INTO the worktree and then
      // discovered from the worktree. Reading the authoring root directly finds the same
      // workflows and writes nothing into the target.
      mockGetOrCreateConversation.mockResolvedValue(mockConversationWithProject);
      mockGetCodebase.mockResolvedValue(mockCodebase);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });
      mockResolveWorkflowSourceRoot.mockImplementation(() =>
        Promise.resolve('/workspace/canonical')
      );

      const seenRoots: (string | undefined)[] = [];
      mockDiscoverWorkflows.mockImplementation(async (cwd, _loadConfig, _providers, roots) => {
        if (cwd === '/workspace/project') seenRoots.push(roots?.project ?? undefined);
        return { workflows: [], errors: [] };
      });

      await handleMessage(platform, 'chat-456', 'help', { actor: operator });

      expect(mockResolveWorkflowSourceRoot).toHaveBeenCalledWith('/workspace/project');
      // Discovery is pointed at the canonical repo's source, not the worktree's.
      expect(seenRoots).toEqual(['/workspace/canonical']);
    });

    test('handles workflow discovery failure gracefully', async () => {
      mockDiscoverWorkflows.mockRejectedValue(new Error('No .archon/workflows directory'));
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'I can still help!' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      // Should not throw
      await handleMessage(platform, 'chat-456', 'help me', { actor: operator });

      // AI should still be called, just without workflows
      expect(mockClient.sendQuery).toHaveBeenCalled();
    });
  });

  // ─── Error Handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    test('sends classified error message on failure', async () => {
      mockGetOrCreateConversation.mockRejectedValue(new Error('Database error'));

      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', '⚠️ Error: Database error');
    });

    test('handles error during error notification gracefully', async () => {
      mockGetOrCreateConversation.mockRejectedValue(new Error('DB error'));
      platform.sendMessage.mockRejectedValueOnce(new Error('Send failed'));

      // Should not throw
      await handleMessage(platform, 'chat-456', 'hello', { actor: operator });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'chat-456' }),
        'error_notification_failed'
      );
    });
  });

  // ─── Thread Context Inheritance ────────────────────────────────────────

  describe('thread context inheritance', () => {
    const threadConversation: Conversation = {
      ...mockConversation,
      id: 'conv-thread',
      platform_type: 'discord',
      platform_conversation_id: 'thread-123',
      ai_assistant_type: 'claude',
      codebase_id: null,
      cwd: null,
      isolation_env_id: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const parentConversation: Conversation = {
      ...mockConversation,
      id: 'conv-parent',
      platform_type: 'discord',
      platform_conversation_id: 'channel-456',
      ai_assistant_type: 'claude',
      codebase_id: 'codebase-789',
      cwd: '/workspace/project',
      isolation_env_id: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const inheritedConversation: Conversation = {
      ...threadConversation,
      codebase_id: 'codebase-789',
      cwd: '/workspace/project',
    };

    test('inherits codebase_id and cwd from parent when thread has no codebase', async () => {
      mockGetOrCreateConversation
        .mockResolvedValueOnce(threadConversation)
        .mockResolvedValueOnce(inheritedConversation);
      mockGetConversationByPlatformId.mockResolvedValueOnce(parentConversation);
      mockGetCodebase.mockResolvedValue(mockCodebase);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'thread-123', 'hello', {
        actor: operator,
        parentConversationId: 'channel-456',
      });

      expect(mockGetConversationByPlatformId).toHaveBeenCalledWith('mock', 'channel-456');
      expect(mockUpdateConversation).toHaveBeenCalledWith('conv-thread', {
        codebase_id: 'codebase-789',
        cwd: '/workspace/project',
      });
      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(2);
    });

    test('does NOT inherit when thread already has codebase_id', async () => {
      const threadWithCodebase: Conversation = {
        ...threadConversation,
        codebase_id: 'existing-codebase',
        cwd: '/other/path',
      };
      mockGetOrCreateConversation.mockResolvedValue(threadWithCodebase);
      mockGetCodebase.mockResolvedValue(mockCodebase);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'thread-123', 'hello', {
        actor: operator,
        parentConversationId: 'channel-456',
      });

      expect(mockGetConversationByPlatformId).not.toHaveBeenCalled();
    });

    test('handles missing parent gracefully', async () => {
      mockGetOrCreateConversation.mockResolvedValue(threadConversation);
      mockGetConversationByPlatformId.mockResolvedValueOnce(null);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'thread-123', 'hello', {
        actor: operator,
        parentConversationId: 'channel-456',
      });

      expect(mockGetConversationByPlatformId).toHaveBeenCalledWith('mock', 'channel-456');
      expect(mockUpdateConversation).not.toHaveBeenCalled();
    });

    test('handles ConversationNotFoundError during update gracefully', async () => {
      mockGetOrCreateConversation.mockResolvedValue(threadConversation);
      mockGetConversationByPlatformId.mockResolvedValueOnce(parentConversation);
      mockUpdateConversation.mockRejectedValueOnce(new ConversationNotFoundError('conv-thread'));
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'thread-123', 'hello', {
        actor: operator,
        parentConversationId: 'channel-456',
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-thread' }),
        'thread_inheritance_failed'
      );
      // Conversation NOT reloaded since update failed
      expect(mockGetOrCreateConversation).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Project Registration ──────────────────────────────────────────────

  describe('project registration', () => {
    for (const failure of [
      'invalid gitfile',
      'missing gitdir',
      'not a git repository-bad-config',
    ]) {
      for (const repair of [false, true]) {
        test(`/register-project refuses ${failure} during ${repair ? 'repair' : 'creation'}`, async () => {
          const projectPath = await mkdtemp(join(tmpdir(), `archon-${failure}-`));
          try {
            if (failure.endsWith('bad-config')) {
              const init = Bun.spawn(['git', '-C', projectPath, 'init'], {
                stdout: 'ignore',
                stderr: 'pipe',
              });
              expect(await init.exited).toBe(0);
              await writeFile(join(projectPath, '.git', 'config'), 'invalid config line\n');
            } else {
              await writeFile(
                join(projectPath, '.git'),
                failure === 'missing gitdir'
                  ? `gitdir: ${join(projectPath, 'missing')}\n`
                  : 'invalid gitfile\n'
              );
            }
            mockExistsSync.mockReturnValue(true);
            mockListCodebases.mockResolvedValue(
              repair
                ? [{ ...mockCodebase, name: 'my-app', default_cwd: 'legacy/path', kind: 'folder' }]
                : []
            );
            await handleMessage(platform, 'chat-456', `/register-project my-app ${projectPath}`, {
              actor: operator,
            });
            expect(platform.sendMessage).toHaveBeenCalledWith(
              'chat-456',
              expect.stringContaining('Nothing was registered')
            );
            expect(mockCreateCodebase).not.toHaveBeenCalled();
            expect(mockUpdateCodebase).not.toHaveBeenCalled();
            expect(mockRepairCodebaseRegistration).not.toHaveBeenCalled();
          } finally {
            await removeTempTree(projectPath);
          }
        });
      }
    }

    test('explicit project registration reports detection failure without persistence', async () => {
      const projectPath = await mkdtemp(join(tmpdir(), 'archon-agent-registration-failure-'));
      try {
        await writeFile(join(projectPath, '.git'), `gitdir: ${join(projectPath, 'missing')}\n`);
        mockExistsSync.mockReturnValue(true);
        mockListCodebases.mockResolvedValue([]);
        await handleMessage(platform, 'chat-456', `/register-project my-app ${projectPath}`, {
          actor: operator,
        });
        expect(platform.sendMessage).toHaveBeenCalledWith(
          'chat-456',
          expect.stringContaining('Nothing was registered')
        );
        expect(mockCreateCodebase).not.toHaveBeenCalled();
        expect(mockUpdateCodebase).not.toHaveBeenCalled();
        expect(mockRepairCodebaseRegistration).not.toHaveBeenCalled();
      } finally {
        await removeTempTree(projectPath);
      }
    });

    test('/register-project refuses a path that disappears during detection', async () => {
      const canonicalPath = await canonicalizeForTest('/vanished/path');
      const repoSpy = spyOn(git, 'findRepoRoot').mockImplementation(async () => {
        mockExistsSync.mockReturnValue(false);
        throw new Error('git: cannot change directory');
      });
      try {
        mockExistsSync.mockReturnValue(true);
        mockListCodebases.mockResolvedValue([]);
        await handleMessage(platform, 'chat-456', '/register-project my-app /vanished/path', {
          actor: operator,
        });
        expect(platform.sendMessage).toHaveBeenCalledWith(
          'chat-456',
          `Could not register project: Path does not exist: ${canonicalPath}`
        );
        expect(mockCreateCodebase).not.toHaveBeenCalled();
        expect(mockUpdateCodebase).not.toHaveBeenCalled();
        expect(mockRepairCodebaseRegistration).not.toHaveBeenCalled();
      } finally {
        repoSpy.mockRestore();
        mockExistsSync.mockReturnValue(true);
      }
    });

    for (const kind of ['repo', 'folder'] as const) {
      test(`/register-project reports a persistence refusal when repairing to ${kind}`, async () => {
        const canonicalPath = await canonicalizeForTest('/new/path');
        const repoSpy = spyOn(git, 'findRepoRoot').mockResolvedValue(
          kind === 'repo' ? git.toRepoPath(canonicalPath) : null
        );
        try {
          mockRepairCodebaseRegistration.mockRejectedValueOnce(
            new Error('would move its Archon storage')
          );
          mockExistsSync.mockReturnValue(true);
          mockListCodebases.mockResolvedValue([
            {
              ...mockCodebase,
              name: 'my-app',
              default_cwd: 'legacy/path',
              kind: kind === 'repo' ? 'folder' : 'repo',
            },
          ]);
          await handleMessage(platform, 'chat-456', '/register-project my-app /new/path', {
            actor: operator,
          });
          expect(mockRepairCodebaseRegistration).toHaveBeenCalledWith(mockCodebase.id, {
            default_cwd: canonicalPath,
            kind,
          });
          expect(mockUpdateCodebase).not.toHaveBeenCalled();
          expect(mockCreateCodebase).not.toHaveBeenCalled();
          expect(platform.sendMessage).toHaveBeenCalledWith(
            'chat-456',
            expect.stringContaining('would move its Archon storage')
          );
        } finally {
          repoSpy.mockRestore();
        }
      });
    }

    for (const trace of [
      '',
      'GIT_TRACE',
      'GIT_TRACE_PERFORMANCE',
      'GIT_TRACE2',
      'GIT_TRACE2_EVENT',
      'GIT_TRACE2_PERF',
      'GIT_TRACE_SETUP',
    ]) {
      test(`/register-project on a real non-git dir creates a folder project with ${trace || 'no tracing'}`, async () => {
        const projectPath = await mkdtemp(join(tmpdir(), 'archon-register-folder-'));
        const canonicalPath = await mockCanonicalizeProjectPath(projectPath);
        const previousTrace = trace ? process.env[trace] : undefined;
        if (trace) process.env[trace] = '1';
        try {
          mockExistsSync.mockReturnValue(true);
          mockListCodebases.mockResolvedValue([]);

          await handleMessage(platform, 'chat-456', `/register-project my-app ${projectPath}`, {
            actor: operator,
          });

          expect(mockRegisterFolder).toHaveBeenCalledWith(canonicalPath, 'my-app');
          expect(platform.sendMessage).toHaveBeenCalledWith(
            'chat-456',
            expect.stringContaining('registered successfully')
          );
        } finally {
          if (trace) {
            if (previousTrace === undefined) delete process.env[trace];
            else process.env[trace] = previousTrace;
          }
          await removeTempTree(projectPath);
        }
      });
    }

    for (const target of ['normalTarget', 'eventTarget', 'perfTarget']) {
      for (const destination of [1, 2]) {
        test(`/register-project registers a non-git folder with global trace2.${target}=${destination}`, async () => {
          const projectPath = await mkdtemp(join(tmpdir(), 'archon-global-trace-'));
          const configPath = join(projectPath, 'gitconfig');
          const previousConfig = process.env.GIT_CONFIG_GLOBAL;
          await writeFile(configPath, `[trace2]\n${target} = ${destination}\n`);
          process.env.GIT_CONFIG_GLOBAL = configPath;
          try {
            mockExistsSync.mockReturnValue(true);
            mockListCodebases.mockResolvedValue([]);
            await handleMessage(platform, 'chat-456', `/register-project my-app ${projectPath}`, {
              actor: operator,
            });
            expect(mockRegisterFolder).toHaveBeenCalledWith(
              await mockCanonicalizeProjectPath(projectPath),
              'my-app'
            );
            expect(platform.sendMessage).toHaveBeenCalledWith(
              'chat-456',
              expect.stringContaining('registered successfully')
            );
          } finally {
            if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
            else process.env.GIT_CONFIG_GLOBAL = previousConfig;
            await removeTempTree(projectPath);
          }
        });
      }
    }

    test('/register-project stores no branch choice and asks nothing', async () => {
      const projectPath = await mkdtemp(join(tmpdir(), 'archon-register-project-'));
      // handleRegisterProject canonicalizes before storing (macOS tmpdir lives
      // under /var → /private/var), so the stored default_cwd is canonical.
      const canonicalPath = await mockCanonicalizeProjectPath(projectPath);
      const repoSpy = spyOn(git, 'findRepoRoot').mockResolvedValue(git.toRepoPath(canonicalPath));
      try {
        mockExistsSync.mockReturnValue(true);
        mockListCodebases.mockResolvedValue([]);

        await handleMessage(platform, 'chat-456', `/register-project my-app ${projectPath}`, {
          actor: operator,
        });

        expect(mockRegisterRepository).toHaveBeenCalledWith(canonicalPath, { name: 'my-app' });
      } finally {
        repoSpy.mockRestore();
        await removeTempTree(projectPath);
      }
    });

    test('/register-project rejects non-existent path', async () => {
      mockExistsSync.mockReturnValue(false);

      await handleMessage(platform, 'chat-456', '/register-project my-app /nonexistent/path', {
        actor: operator,
      });

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Path does not exist')
      );
      expect(mockCreateCodebase).not.toHaveBeenCalled();
    });

    test('/register-project shows usage for missing args', async () => {
      await handleMessage(platform, 'chat-456', '/register-project', { actor: operator });

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Usage')
      );
    });

    // ── default_cwd canonicalization seam (#2927) ────────────────────────
    // Both chat writers must store the SHARED canonicalizer's output, not a
    // path they resolved themselves. These make the canonicalizer answer a
    // different real directory than the one passed in, which no second
    // realpath call could ever produce — so a writer that goes its own way
    // fails here on every platform, not only on the Windows short paths that
    // exposed the split.
    test('/register-project stores exactly the shared canonicalizer output', async () => {
      const suppliedPath = await mkdtemp(join(tmpdir(), 'archon-register-supplied-'));
      const canonicalPath = await mkdtemp(join(tmpdir(), 'archon-register-canonical-'));
      mockCanonicalizeProjectPath.mockImplementationOnce(() => Promise.resolve(canonicalPath));
      try {
        mockExistsSync.mockReturnValue(true);
        mockListCodebases.mockResolvedValue([]);

        await handleMessage(platform, 'chat-456', `/register-project my-app ${suppliedPath}`, {
          actor: operator,
        });

        expect(mockRegisterFolder).toHaveBeenCalledWith(canonicalPath, 'my-app');
      } finally {
        await removeTempTree(suppliedPath);
        await removeTempTree(canonicalPath);
      }
    });

    // Chat input gets no shell expansion, so `~/work` arrives literally and only
    // the canonicalizer can resolve it. Canonicalizing after the existence check
    // rejected a path that exists — and validated a different string than the one
    // it would have stored.
    test('/register-project validates the canonical path, not the raw argument', async () => {
      const realPath = await mkdtemp(join(tmpdir(), 'archon-register-tilde-'));
      mockCanonicalizeProjectPath.mockImplementationOnce(() => Promise.resolve(realPath));
      // Only the canonical path exists; the literal argument does not.
      mockExistsSync.mockImplementation(p => p.toString() === realPath);
      try {
        mockListCodebases.mockResolvedValue([]);

        await handleMessage(platform, 'chat-456', '/register-project my-app ~/some-project', {
          actor: operator,
        });

        expect(mockRegisterFolder).toHaveBeenCalledWith(realPath, 'my-app');
      } finally {
        mockExistsSync.mockReturnValue(true);
        await removeTempTree(realPath);
      }
    });

    test('/update-project stores exactly the shared canonicalizer output', async () => {
      const suppliedPath = await mkdtemp(join(tmpdir(), 'archon-update-supplied-'));
      const canonicalPath = await mkdtemp(join(tmpdir(), 'archon-update-canonical-'));
      mockCanonicalizeProjectPath.mockImplementationOnce(() => Promise.resolve(canonicalPath));
      try {
        mockExistsSync.mockReturnValue(true);
        mockListCodebases.mockResolvedValue([mockCodebase]);

        await handleMessage(
          platform,
          'chat-456',
          `/update-project ${mockCodebase.name} ${suppliedPath}`,
          { actor: operator }
        );

        expect(mockUpdateCodebase).toHaveBeenCalledWith(
          expect.objectContaining({ id: mockCodebase.id, name: mockCodebase.name }),
          {
            default_cwd: canonicalPath,
          }
        );
      } finally {
        await removeTempTree(suppliedPath);
        await removeTempTree(canonicalPath);
      }
    });
  });

  // ─── Prompt Construction ───────────────────────────────────────────────

  describe('prompt construction', () => {
    test('includes issueContext in prompt', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'On it' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix this', {
        actor: operator,
        issueContext: 'Issue #42: "Login bug"\nLabels: bug',
      });

      const prompt = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(prompt).toContain('Issue #42');
      expect(prompt).toContain('Additional Context');
    });

    test('includes threadContext in prompt', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'agent_message_chunk', text: 'On it' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'continue', {
        actor: operator,
        threadContext: 'Previous: user said hello\nAssistant: Hi there!',
      });

      const prompt = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(prompt).toContain('Thread Context');
      expect(prompt).toContain('Previous: user said hello');
    });
  });

  // ─── Title Generation ──────────────────────────────────────────────────

  describe('title generation', () => {
    test('triggers title generation for untitled conversation with regular message', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'Hello world', { actor: operator });

      expect(mockGenerateAndSetTitle).toHaveBeenCalledTimes(1);
      expect(mockGenerateAndSetTitle).toHaveBeenCalledWith(
        'conv-123',
        'Hello world',
        'claude',
        '/home/test/.archon/workspaces',
        undefined,
        {},
        expect.objectContaining({
          model: 'haiku',
          assistantConfig: {},
        })
      );
    });

    test('does NOT trigger title generation for slash commands', async () => {
      mockHandleCommand.mockResolvedValue({
        message: 'Status info',
        modified: false,
        success: true,
      });

      await handleMessage(platform, 'chat-456', '/status', { actor: operator });

      expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
    });

    test('does NOT trigger title generation for already-titled conversations', async () => {
      mockGetOrCreateConversation.mockResolvedValue({
        ...mockConversation,
        title: 'Existing Title',
      });

      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'Hello world', { actor: operator });

      expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
    });
  });
});

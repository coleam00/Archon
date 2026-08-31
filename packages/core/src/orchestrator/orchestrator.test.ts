import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { mkdtemp, realpath } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { MockPlatformAdapter } from '../test/mocks/platform';
import { createMockLogger } from '../test/mocks/logger';
import {
  makeTestWorkflow,
  makeTestWorkflowList,
  withObservableCapturedSource,
} from '@archon/workflows/test-utils';
import type { Conversation, Codebase, Session } from '../types';
import { ConversationNotFoundError } from '../types';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
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
import type * as Orchestrator from './orchestrator';
import type * as PromptBuilder from './prompt-builder';
import type * as TitleGenerator from '../services/title-generator';
import type * as WorkflowDb from '../db/workflows';

// ─── Mock setup (BEFORE importing module under test) ─────────────────────────

const mockLogger = createMockLogger();
// Stands in for the real shared canonicalizer. Tests build their expected
// `default_cwd` by calling THIS function, so the expectation can never drift
// from what the product resolved, on any platform.
async function canonicalizeForTest(p: string): Promise<string> {
  const absolute = resolve(p);
  return await realpath(absolute).catch(() => absolute);
}
const mockCanonicalizeProjectPath = mock(canonicalizeForTest);
mock.module('@archon/paths', () => ({
  canonicalizeProjectPath: mockCanonicalizeProjectPath,
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
const mockUpdateCodebase = mock<typeof CodebaseDb.updateCodebase>(() => Promise.resolve());

mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  listCodebases: mockListCodebases,
  createCodebase: mockCreateCodebase,
  updateCodebase: mockUpdateCodebase,
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
  sessionResume: true,
  mcp: true,
  hooks: true,
  skills: true,
  agents: true,
  toolRestrictions: true,
  structuredOutput: 'enforced',
  envInjection: true,
  costControl: true,
  effortControl: true,
  thinkingControl: true,
  fallbackModel: true,
  sandbox: true,
  settingSources: true,
  nativeTools: true,
  containerExec: true,
};
const mockGetProviderCapabilities = mock<typeof Providers.getProviderCapabilities>(
  () => providerCapabilities
);

mock.module('@archon/providers', () => ({
  getAgentProvider: mockGetAgentProvider,
  getProviderCapabilities: mockGetProviderCapabilities,
  // `validEffortsForProvider` (@archon/workflows/model-validation) reads the
  // registry to decide whether a tier's `effort` reaches this provider (#2556).
  // Without this the REAL implementation runs against an empty registry and
  // every provider looks unregistered.
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
    store: {},
    getAgentProvider: () => ({}),
    loadConfig: async () => ({}),
  })),
}));

// Config mock
const mockLoadConfig = mock<typeof ConfigLoader.loadConfig>(() =>
  Promise.resolve({
    botName: 'Archon',
    assistant: 'claude',
    assistants: { claude: {}, codex: {} },
    streaming: { telegram: 'stream', discord: 'batch', slack: 'batch' },
    paths: { workspaces: '/tmp', worktrees: '/tmp' },
    concurrency: { maxConversations: 10 },
    workflows: {
      autoResumeOnQuotaReset: false,
      quotaMaxAttempts: 1,
      quotaDeadlineMs: 86_400_000,
    },
    commands: { autoLoad: true },
    defaults: { copyDefaults: true, loadDefaultCommands: true, loadDefaultWorkflows: true },
  })
);

mock.module('../config/config-loader', () => ({
  loadConfig: mockLoadConfig,
  // orchestrator.ts imports createChildWorktreeResolver, which imports
  // loadRepoConfig by name. This factory replaces the module process-wide, so
  // omitting it fails that import at module-eval even though no test calls it.
  loadRepoConfig: mock(() => Promise.resolve(null)),
}));

// Workflow source root: undefined = "read the cwd", the non-worktree behavior.
const mockResolveWorkflowSourceRoot = mock<typeof WorkflowSourceRoot.resolveWorkflowSourceRoot>(
  (_cwd: string) => Promise.resolve<string | undefined>(undefined)
);

mock.module('../utils/workflow-source-root', () => ({
  resolveWorkflowSourceRoot: mockResolveWorkflowSourceRoot,
}));

// Orchestrator (isolation & dispatch) mocks
const mockValidateAndResolveIsolation = mock<typeof Orchestrator.validateAndResolveIsolation>(() =>
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
const mockDispatchBackgroundWorkflow = mock<typeof Orchestrator.dispatchBackgroundWorkflow>(() =>
  Promise.resolve()
);

mock.module('./orchestrator', () => ({
  validateAndResolveIsolation: mockValidateAndResolveIsolation,
  dispatchBackgroundWorkflow: mockDispatchBackgroundWorkflow,
  IsolationBlockedError: class IsolationBlockedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'IsolationBlockedError';
    }
  },
}));

// Prompt builder mock
const mockBuildOrchestratorPrompt = mock<typeof PromptBuilder.buildOrchestratorPrompt>(
  () => 'You are the orchestrator agent.'
);
const mockBuildProjectScopedPrompt = mock<typeof PromptBuilder.buildProjectScopedPrompt>(
  () => 'You are scoped to project X.'
);
const mockBuildOrchestratorSystemAppend = mock<typeof PromptBuilder.buildOrchestratorSystemAppend>(
  () => 'orchestrator system append'
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
/** Ownership calls the dispatch path makes on its capture, in order. */
const capturedSourceOwnerCalls: string[] = [];

mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
  hydrateResumableRun: mock(() => Promise.resolve(null)),
  // Source capture runs before dispatch and does real filesystem work; stub it so these
  // tests stay about routing. `mock.module` MERGES, so an export omitted here keeps its
  // REAL implementation — which is exactly how a stub silently starts doing disk I/O.
  prepareWorkflowSource: mock(() =>
    Promise.resolve({
      runId: 'prepared-run-id',
      captureRoot: '/capture',
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
      roots: {
        project: '/capture/project',
        globalWorkflows: '/capture/global/workflows',
        globalCommands: '/capture/global/commands',
        globalScripts: '/capture/global/scripts',
        bundledWorkflows: '/capture/bundled',
        bundledCommands: '/capture/bundled/commands/defaults',
        kind: 'captured',
        config: {
          load_default_workflows: true,
          load_default_commands: true,
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
  // Statically imported by the background dispatch path (see orchestrator.ts).
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

import { handleMessage, parseOrchestratorCommands } from './orchestrator-agent';

// Also import wrapCommandForExecution which still lives in orchestrator.ts
import { wrapCommandForExecution } from './orchestrator';

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

const testWorkflowDefs = makeTestWorkflowList(['fix-bug', 'add-feature', 'archon-assist']);
const testWorkflows = testWorkflowDefs.map(w => ({
  workflow: w,
  source: 'bundled' as const,
}));

const mockClientSendQuery = mock<IAgentProvider['sendQuery']>(async function* () {
  yield { type: 'result', sessionId: 'session-id' };
});
const mockClient = {
  sendQuery: mockClientSendQuery,
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

describe('parseOrchestratorCommands', () => {
  const codebases: Codebase[] = [mockCodebase];
  const workflows: WorkflowDefinition[] = testWorkflowDefs;

  test('parses /invoke-workflow with --project', () => {
    const response = 'I will fix this.\n/invoke-workflow fix-bug --project test-project';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).not.toBeNull();
    expect(result.workflowInvocation?.workflowName).toBe('fix-bug');
    expect(result.workflowInvocation?.projectName).toBe('test-project');
    expect(result.workflowInvocation?.remainingMessage).toBe('I will fix this.');
  });

  test('case-insensitive project name matching', () => {
    const response = '/invoke-workflow fix-bug --project TEST-PROJECT';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).not.toBeNull();
    expect(result.workflowInvocation?.projectName).toBe('test-project');
  });

  test('returns null for unknown workflow name', () => {
    const response = '/invoke-workflow nonexistent --project test-project';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).toBeNull();
  });

  test('returns null for unknown project name', () => {
    const response = '/invoke-workflow fix-bug --project unknown-project';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).toBeNull();
  });

  test('parses /register-project', () => {
    const response = 'Sure!\n/register-project my-app /home/user/my-app';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.projectRegistration).not.toBeNull();
    expect(result.projectRegistration?.projectName).toBe('my-app');
    expect(result.projectRegistration?.projectPath).toBe('/home/user/my-app');
  });

  test('returns empty commands when no commands in text', () => {
    const response = 'Just a conversational response.';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).toBeNull();
    expect(result.projectRegistration).toBeNull();
  });

  test('extracts remaining message before /invoke-workflow', () => {
    const response =
      'Let me analyze this for you.\n\n/invoke-workflow fix-bug --project test-project';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation?.remainingMessage).toBe('Let me analyze this for you.');
  });

  test('handles --project= (equals syntax)', () => {
    const response = '/invoke-workflow fix-bug --project=test-project';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).not.toBeNull();
    expect(result.workflowInvocation?.projectName).toBe('test-project');
  });

  test('parses --prompt with double quotes', () => {
    const response =
      'I will analyze this.\n/invoke-workflow archon-assist --project test-project --prompt "Analyze the orchestrator module architecture"';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).not.toBeNull();
    expect(result.workflowInvocation?.workflowName).toBe('archon-assist');
    expect(result.workflowInvocation?.projectName).toBe('test-project');
    expect(result.workflowInvocation?.synthesizedPrompt).toBe(
      'Analyze the orchestrator module architecture'
    );
    expect(result.workflowInvocation?.remainingMessage).toBe('I will analyze this.');
  });

  test('parses --prompt with single quotes', () => {
    const response =
      "/invoke-workflow fix-bug --project test-project --prompt 'Fix the null pointer in data processor'";
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation?.synthesizedPrompt).toBe(
      'Fix the null pointer in data processor'
    );
  });

  test('returns undefined synthesizedPrompt when --prompt not provided', () => {
    const response = '/invoke-workflow fix-bug --project test-project';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).not.toBeNull();
    expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
  });

  test('parses --prompt with spaces in the quoted value', () => {
    const response =
      '/invoke-workflow archon-assist --project test-project --prompt "Analyze the database schema and migration patterns in the project, focusing on table structure and relationships"';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation?.synthesizedPrompt).toBe(
      'Analyze the database schema and migration patterns in the project, focusing on table structure and relationships'
    );
  });

  test('backwards compatibility: existing format without --prompt still works', () => {
    const response = 'I will fix this.\n/invoke-workflow fix-bug --project test-project';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation).not.toBeNull();
    expect(result.workflowInvocation?.workflowName).toBe('fix-bug');
    expect(result.workflowInvocation?.projectName).toBe('test-project');
    expect(result.workflowInvocation?.remainingMessage).toBe('I will fix this.');
    expect(result.workflowInvocation?.synthesizedPrompt).toBeUndefined();
  });

  test('parses --prompt with --project= equals syntax', () => {
    const response =
      '/invoke-workflow archon-assist --project=test-project --prompt "Summarize the README"';
    const result = parseOrchestratorCommands(response, codebases, workflows);

    expect(result.workflowInvocation?.projectName).toBe('test-project');
    expect(result.workflowInvocation?.synthesizedPrompt).toBe('Summarize the README');
  });

  test('matches partial project name (last path segment)', () => {
    const namespacedCodebases: Codebase[] = [
      { ...mockCodebase, name: 'dynamous-community/test-project' },
    ];
    const response = '/invoke-workflow fix-bug --project test-project --prompt "Fix the bug"';
    const result = parseOrchestratorCommands(response, namespacedCodebases, workflows);

    expect(result.workflowInvocation).not.toBeNull();
    expect(result.workflowInvocation?.projectName).toBe('dynamous-community/test-project');
    expect(result.workflowInvocation?.synthesizedPrompt).toBe('Fix the bug');
  });
});

describe('wrapCommandForExecution', () => {
  test('wraps command with tags', () => {
    const result = wrapCommandForExecution('plan', 'Plan the feature');
    expect(result).toContain('plan');
    expect(result).toContain('Plan the feature');
  });
});

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

      await handleMessage(platform, 'chat-456', '/status');

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

      await handleMessage(platform, 'chat-456', '/help');

      expect(mockHandleCommand).toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Help text');
    });

    test('delegates /reset to command handler', async () => {
      mockHandleCommand.mockResolvedValue({
        message: 'Session cleared',
        modified: false,
        success: true,
      });

      await handleMessage(platform, 'chat-456', '/reset');

      expect(mockHandleCommand).toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Session cleared');
    });

    test('uses CommandResult workflow definition without rediscovery for /workflow run', async () => {
      const workflowDefinition = makeTestWorkflow({
        name: 'test-workflow',
        description: 'A test workflow',
      });
      mockGetOrCreateConversation.mockResolvedValue(mockConversationWithProject);
      mockGetCodebase.mockResolvedValue(mockCodebase);
      mockHandleCommand.mockResolvedValue({
        success: true,
        message: 'Starting workflow: `test-workflow`',
        workflow: { definition: workflowDefinition, args: 'payload' },
      });

      await handleMessage(platform, 'chat-456', '/workflow run test-workflow payload');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'Starting workflow: `test-workflow`'
      );
      expect(mockDiscoverWorkflows).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).toHaveBeenCalled();
    });

    test('validates workflow exists in auto-selected project before dispatch', async () => {
      const workflowDefinition = makeTestWorkflow({
        name: 'test-workflow',
        description: 'A test workflow',
      });
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockHandleCommand.mockResolvedValue({
        success: true,
        message: 'Starting workflow: `test-workflow`',
        workflow: { definition: workflowDefinition, args: 'payload' },
      });
      mockDiscoverWorkflows.mockResolvedValue({
        workflows: [
          {
            workflow: { ...workflowDefinition, name: 'other-workflow' },
            source: 'bundled' as const,
          },
        ],
        errors: [],
      });

      await handleMessage(platform, 'chat-456', '/workflow run test-workflow payload');

      expect(mockDiscoverWorkflows).toHaveBeenCalledWith(
        '/workspace/test-project',
        expect.any(Function),
        undefined // non-worktree cwd: source root is the cwd itself
      );
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        'Workflow `test-workflow` not found.\n\nUse /workflow list to see available workflows.'
      );
      expect(mockUpdateConversation).not.toHaveBeenCalled();
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('non-deterministic commands go to AI orchestrator', async () => {
      // /unknown-command should NOT be routed to command handler
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'I can help with that.' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', '/unknown-command');

      expect(mockHandleCommand).not.toHaveBeenCalled();
      // Should go through AI path
      expect(mockClient.sendQuery).toHaveBeenCalled();
    });
  });

  // ─── Regular Messages (AI Orchestrator Path) ───────────────────────────

  describe('AI orchestrator path', () => {
    test('sends message to AI and streams response', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'I can help you with that!' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'Hello, help me');

      expect(mockClient.sendQuery).toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'I can help you with that!');
    });

    test('does NOT require a codebase to function', async () => {
      // Conversation has no codebase_id — this is fine for the orchestrator
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'Hello!' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hi');

      // Should NOT send an error about missing codebase
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Hello!');
    });

    test('loads all codebases for prompt context', async () => {
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help me');

      expect(mockListCodebases).toHaveBeenCalled();
      expect(mockBuildOrchestratorSystemAppend).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        [mockCodebase],
        expect.any(Array)
      );
    });

    test('builds project-scoped prompt when conversation has codebase_id', async () => {
      mockGetOrCreateConversation.mockResolvedValue(mockConversationWithProject);
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockGetCodebase.mockResolvedValue(mockCodebase);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'Scoped response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help');

      expect(mockBuildOrchestratorSystemAppend).toHaveBeenCalledWith(
        expect.objectContaining({ codebase_id: 'codebase-789' }),
        [mockCodebase],
        expect.any(Array)
      );
    });

    test('calls touchConversation for activity tracking', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hello');

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

      await handleMessage(platform, 'chat-456', 'hello');

      expect(mockTransitionSession).toHaveBeenCalledWith('conv-123', 'first-message', {
        ai_assistant_type: 'claude',
      });
    });

    test('reuses existing session', async () => {
      mockGetActiveSession.mockResolvedValue(mockSession);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'new-ai-session' };
      });

      await handleMessage(platform, 'chat-456', 'hello');

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

      await handleMessage(platform, 'chat-456', 'hello');

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
        paths: { workspaces: '/tmp', worktrees: '/tmp' },
        concurrency: { maxConversations: 10 },
        workflows: {
          autoResumeOnQuotaReset: false,
          quotaMaxAttempts: 1,
          quotaDeadlineMs: 86_400_000,
        },
        commands: { autoLoad: true },
        defaults: { copyDefaults: true, loadDefaultCommands: true, loadDefaultWorkflows: true },
      });

      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hello');

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
        paths: { workspaces: '/tmp', worktrees: '/tmp' },
        concurrency: { maxConversations: 10 },
        workflows: {
          autoResumeOnQuotaReset: false,
          quotaMaxAttempts: 1,
          quotaDeadlineMs: 86_400_000,
        },
        commands: { autoLoad: true },
        defaults: { copyDefaults: true, loadDefaultCommands: true, loadDefaultWorkflows: true },
      });

      const codexSendQuery = mock<IAgentProvider['sendQuery']>(async function* () {
        yield { type: 'result', sessionId: 'codex-session' };
      });
      const codexClient = {
        sendQuery: codexSendQuery,
        getType: () => 'codex',
        getCapabilities: () => providerCapabilities,
      } satisfies IAgentProvider;
      mockGetAgentProvider.mockReturnValueOnce(codexClient);

      await handleMessage(platform, 'chat-456', 'hello');

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
        paths: { workspaces: '/tmp', worktrees: '/tmp' },
        concurrency: { maxConversations: 10 },
        workflows: {
          autoResumeOnQuotaReset: false,
          quotaMaxAttempts: 1,
          quotaDeadlineMs: 86_400_000,
        },
        commands: { autoLoad: true },
        defaults: { copyDefaults: true, loadDefaultCommands: true, loadDefaultWorkflows: true },
      });

      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hello');

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
        yield { type: 'assistant', content: 'First chunk' };
        yield { type: 'assistant', content: 'Second chunk' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help');

      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'First chunk');
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Second chunk');
    });

    test('streams tool calls with formatted message', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'tool', toolName: 'Bash', toolInput: { command: 'ls' } };
        yield { type: 'assistant', content: 'Done' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'list files');

      // formatToolCall mock returns '🔧 BASH'
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', '🔧 BASH', {
        category: 'tool_call_formatted',
      });
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Done');
    });

    test('silences further output after /invoke-workflow detected but captures sessionId', async () => {
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockDiscoverWorkflows.mockResolvedValue({ workflows: testWorkflows, errors: [] });
      mockFindWorkflow.mockImplementation(
        (name: string, workflows: readonly WorkflowDefinition[]) =>
          workflows.find(w => w.name === name)
      );

      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          // Trailing \n terminates the line so INVOKE_WORKFLOW_FULL_RE fires immediately,
          // setting commandFullyParsed=true before the second chunk is processed.
          content: '/invoke-workflow fix-bug --project test-project\n',
        };
        // These are silenced (not sent to platform) but loop continues to capture result
        yield { type: 'assistant', content: 'This should not appear' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the bug');

      // Should dispatch the workflow
      expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
      // The /invoke-workflow chunk itself should NOT be streamed to the frontend
      expect(platform.sendMessage).not.toHaveBeenCalledWith(
        'chat-456',
        '/invoke-workflow fix-bug --project test-project'
      );
      // Subsequent chunks should also NOT be sent
      expect(platform.sendMessage).not.toHaveBeenCalledWith('chat-456', 'This should not appear');
    });

    test('streams prefix text but not the /invoke-workflow chunk', async () => {
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockDiscoverWorkflows.mockResolvedValue({ workflows: testWorkflows, errors: [] });
      mockFindWorkflow.mockImplementation(
        (name: string, workflows: readonly WorkflowDefinition[]) =>
          workflows.find(w => w.name === name)
      );

      mockClient.sendQuery.mockImplementation(async function* () {
        // First chunk: user-visible explanation text - should be streamed
        yield { type: 'assistant', content: "I'll help with that." };
        // Second chunk: the command - should NOT be streamed
        yield {
          type: 'assistant',
          content: '\n/invoke-workflow fix-bug --project test-project',
        };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the bug');

      // Prefix text streamed to platform
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', "I'll help with that.");
      // Command chunk NOT sent
      expect(platform.sendMessage).not.toHaveBeenCalledWith(
        'chat-456',
        '\n/invoke-workflow fix-bug --project test-project'
      );
      // Workflow should be dispatched
      expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
    });

    test('suppresses /register-project chunk in stream mode', async () => {
      mockExistsSync.mockReturnValue(true);
      mockListCodebases.mockResolvedValue([]);
      mockCreateCodebase.mockResolvedValue({
        ...mockCodebase,
        id: 'new-id',
        name: 'my-app',
        default_cwd: '/home/user/my-app',
      });

      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          content: '/register-project my-app /home/user/my-app',
        };
        yield { type: 'assistant', content: 'This should not appear' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'set up my app');

      // The /register-project chunk itself should NOT be streamed
      expect(platform.sendMessage).not.toHaveBeenCalledWith(
        'chat-456',
        '/register-project my-app /home/user/my-app'
      );
      // Subsequent chunks should also NOT be sent
      expect(platform.sendMessage).not.toHaveBeenCalledWith('chat-456', 'This should not appear');
    });

    test('sends partial command text when command is split across chunks', async () => {
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockDiscoverWorkflows.mockResolvedValue({ workflows: testWorkflows, errors: [] });
      mockFindWorkflow.mockImplementation(
        (name: string, workflows: readonly WorkflowDefinition[]) =>
          workflows.find(w => w.name === name)
      );

      mockClient.sendQuery.mockImplementation(async function* () {
        // Chunk 1: partial command — does not match regex yet, so it IS sent
        yield { type: 'assistant', content: '/invoke-work' };
        // Chunk 2: completes the command — accumulated string matches, NOT sent
        yield { type: 'assistant', content: 'flow fix-bug --project test-project' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the bug');

      // Partial chunk is sent (pre-existing behavior: detection fires on accumulated text)
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', '/invoke-work');
      // Completing chunk is NOT sent
      expect(platform.sendMessage).not.toHaveBeenCalledWith(
        'chat-456',
        'flow fix-bug --project test-project'
      );
      // Workflow is still dispatched
      expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
    });

    test('dispatches workflow when command body arrives after /invoke-workflow detection', async () => {
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockDiscoverWorkflows.mockResolvedValue({ workflows: testWorkflows, errors: [] });
      mockFindWorkflow.mockImplementation(
        (name: string, workflows: readonly WorkflowDefinition[]) =>
          workflows.find(w => w.name === name)
      );

      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: '/invoke-workflow ' };
        yield { type: 'assistant', content: 'fix-bug ' };
        yield { type: 'assistant', content: '--project test-project' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the bug');

      expect(
        platform.sendMessage.mock.calls.some(
          ([id, content]) =>
            id === 'chat-456' && typeof content === 'string' && content.includes('/invoke-workflow')
        )
      ).toBe(false);
      expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
    });
  });

  // ─── Batch Mode ────────────────────────────────────────────────────────

  describe('batch mode', () => {
    beforeEach(() => {
      platform.getStreamingMode.mockReturnValue('batch');
    });

    test('accumulates messages and sends final clean response', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'Part 1' };
        yield { type: 'assistant', content: 'Part 2\n\nFinal summary' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help');

      // Batch mode should send ONE combined message
      expect(platform.sendMessage).toHaveBeenCalledTimes(1);
      const sentMessage = platform.sendMessage.mock.calls[0][1] as string;
      expect(sentMessage).toContain('Part 1');
      expect(sentMessage).toContain('Final summary');
    });

    test('filters emoji tool indicators from batch response', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: '🔧 BASH\nnpm test\n\nClean summary here' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'run tests');

      const sentMessage = platform.sendMessage.mock.calls[0][1] as string;
      expect(sentMessage).not.toContain('🔧');
      expect(sentMessage).toContain('Clean summary');
    });

    test('sends nothing when AI returns empty response', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'hello');

      expect(platform.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ─── Workflow Routing ──────────────────────────────────────────────────

  describe('workflow routing via AI', () => {
    beforeEach(() => {
      mockListCodebases.mockResolvedValue([mockCodebase]);
      mockDiscoverWorkflows.mockResolvedValue({ workflows: testWorkflows, errors: [] });
      mockFindWorkflow.mockImplementation(
        (name: string, workflows: readonly WorkflowDefinition[]) =>
          workflows.find(w => w.name === name)
      );
    });

    test('dispatches workflow when AI responds with /invoke-workflow', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          content: 'I will fix this bug.\n/invoke-workflow fix-bug --project test-project',
        };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the login bug');

      // Should dispatch to workflow after validation
      expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
    });

    test('sends remaining message before dispatching workflow', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          content: 'Let me investigate this.\n/invoke-workflow fix-bug --project test-project',
        };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix it');

      // First sendMessage should be the explanation text
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Let me investigate this.');
    });

    test('sends error for unknown project in workflow invocation', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          content: '/invoke-workflow fix-bug --project nonexistent-project',
        };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix it');

      // Since parseOrchestratorCommands won't match (unknown project), the response
      // is sent as-is in stream mode
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    test('conversational response passes through without routing', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'Let me help you with that!' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'what can you do?');

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
      expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', 'Let me help you with that!');
    });

    test('batch mode dispatches workflow correctly', async () => {
      platform.getStreamingMode.mockReturnValue('batch');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          content: 'Fixing the bug.\n/invoke-workflow fix-bug --project test-project',
        };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the bug');

      expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
    });

    test('batch mode dispatches workflow when command body arrives after detection', async () => {
      platform.getStreamingMode.mockReturnValue('batch');
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: '/invoke-workflow ' };
        yield { type: 'assistant', content: 'fix-bug ' };
        yield { type: 'assistant', content: '--project test-project' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the bug');

      expect(mockValidateAndResolveIsolation).toHaveBeenCalled();
      expect(
        platform.sendMessage.mock.calls.some(
          ([id, content]) =>
            id === 'chat-456' && typeof content === 'string' && content.includes('/invoke-workflow')
        )
      ).toBe(false);
    });

    test('passes synthesizedPrompt to workflow dispatch instead of original message', async () => {
      platform.getStreamingMode.mockReturnValue('batch');
      const synthesized = 'Analyze the orchestrator module architecture in detail';

      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          content: `Running analysis.\n/invoke-workflow archon-assist --project test-project --prompt "${synthesized}"`,
        };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'do that analysis thing');

      // userMessage (position 5) carries the synthesized prompt; the opts bag
      // (trailing arg) carries parentConversationId for approve/reject resume.
      expect(mockExecuteWorkflow).toHaveBeenCalledWith(
        expect.anything(), // deps
        expect.anything(), // platform
        expect.anything(), // conversationId
        expect.anything(), // cwd
        expect.anything(), // workflow
        synthesized, // synthesizedPrompt, not original message
        expect.anything(), // conversation.id
        expect.objectContaining({
          parentConversationId: expect.anything() as unknown, // web approval auto-resume
        })
      );
    });

    test('falls back to original message when --prompt not provided', async () => {
      platform.getStreamingMode.mockReturnValue('batch');

      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          content: 'On it.\n/invoke-workflow fix-bug --project test-project',
        };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix the login bug');

      expect(mockExecuteWorkflow).toHaveBeenCalledWith(
        expect.anything(), // deps
        expect.anything(), // platform
        expect.anything(), // conversationId
        expect.anything(), // cwd
        expect.anything(), // workflow
        'fix the login bug', // original message used as fallback
        expect.anything(), // conversation.id
        expect.objectContaining({
          parentConversationId: expect.anything() as unknown, // web approval auto-resume
        })
      );
    });

    test('sends error when workflow found in parsing but not in dispatch', async () => {
      platform.getStreamingMode.mockReturnValue('batch');

      let callCount = 0;
      mockFindWorkflow.mockImplementation(
        (name: string, workflows: readonly WorkflowDefinition[]) => {
          callCount++;
          // First call (parseOrchestratorCommands) finds the workflow
          // Second call (handleWorkflowInvocationResult) does not
          if (callCount === 1) return workflows.find(w => w.name === name);
          return undefined;
        }
      );

      mockClient.sendQuery.mockImplementation(async function* () {
        yield {
          type: 'assistant',
          content: '/invoke-workflow archon-assist --project test-project',
        };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help me');

      expect(mockValidateAndResolveIsolation).not.toHaveBeenCalled();
      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('archon-assist')
      );
    });
  });

  // ─── Workflow Discovery ────────────────────────────────────────────────

  describe('workflow discovery', () => {
    test('discovers global workflows from workspaces path', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help');

      // Discovery is called positionally with (cwd, loadConfig) — no options arg.
      // Home-scoped workflows (~/.archon/workflows/) are discovered internally.
      expect(mockDiscoverWorkflows).toHaveBeenCalledWith(
        '/home/test/.archon/workspaces',
        expect.any(Function)
      );
    });

    test('also discovers repo-specific workflows when conversation has project', async () => {
      mockGetOrCreateConversation.mockResolvedValue(mockConversationWithProject);
      mockGetCodebase.mockResolvedValue(mockCodebase);
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'help');

      // Should call discoverWorkflows twice: global + repo-specific
      expect(mockDiscoverWorkflows).toHaveBeenCalledTimes(2);
      expect(mockDiscoverWorkflows).toHaveBeenCalledWith(
        '/workspace/project',
        expect.any(Function),
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
        yield { type: 'assistant', content: 'Response' };
        yield { type: 'result', sessionId: 'session-id' };
      });
      mockResolveWorkflowSourceRoot.mockImplementation(() =>
        Promise.resolve('/workspace/canonical')
      );

      const seenRoots: (string | undefined)[] = [];
      mockDiscoverWorkflows.mockImplementation(async (cwd, _loadConfig, roots) => {
        if (cwd === '/workspace/project') seenRoots.push(roots?.project ?? undefined);
        return { workflows: [], errors: [] };
      });

      await handleMessage(platform, 'chat-456', 'help');

      expect(mockResolveWorkflowSourceRoot).toHaveBeenCalledWith('/workspace/project');
      // Discovery is pointed at the canonical repo's source, not the worktree's.
      expect(seenRoots).toEqual(['/workspace/canonical']);
    });

    test('handles workflow discovery failure gracefully', async () => {
      mockDiscoverWorkflows.mockRejectedValue(new Error('No .archon/workflows directory'));
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'I can still help!' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      // Should not throw
      await handleMessage(platform, 'chat-456', 'help me');

      // AI should still be called, just without workflows
      expect(mockClient.sendQuery).toHaveBeenCalled();
    });
  });

  // ─── Error Handling ────────────────────────────────────────────────────

  describe('error handling', () => {
    test('sends classified error message on failure', async () => {
      mockGetOrCreateConversation.mockRejectedValue(new Error('Database error'));

      await handleMessage(platform, 'chat-456', 'hello');

      expect(platform.sendMessage).toHaveBeenCalledWith('chat-456', '⚠️ Error: Database error');
    });

    test('handles error during error notification gracefully', async () => {
      mockGetOrCreateConversation.mockRejectedValue(new Error('DB error'));
      platform.sendMessage.mockRejectedValueOnce(new Error('Send failed'));

      // Should not throw
      await handleMessage(platform, 'chat-456', 'hello');

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
    test('/register-project on a real non-git dir creates a folder project (clean null path)', async () => {
      // Use a REAL non-git temp dir so findRepoRoot returns null via the
      // definitive "not a git repository" path (deterministic) — not the
      // exception-fallback branch a fake/nonexistent path would take.
      const projectPath = await mkdtemp(join(tmpdir(), 'archon-register-folder-'));
      const canonicalPath = await mockCanonicalizeProjectPath(projectPath);
      try {
        mockExistsSync.mockReturnValue(true);
        mockListCodebases.mockResolvedValue([]);
        mockCreateCodebase.mockResolvedValue({
          ...mockCodebase,
          id: 'new-id',
          name: 'my-app',
          default_cwd: canonicalPath,
        });

        await handleMessage(platform, 'chat-456', `/register-project my-app ${projectPath}`);

        expect(mockCreateCodebase).toHaveBeenCalledWith({
          name: 'my-app',
          default_cwd: canonicalPath,
          default_branch: null,
          ai_assistant_type: 'claude',
          kind: 'folder',
        });
        expect(platform.sendMessage).toHaveBeenCalledWith(
          'chat-456',
          expect.stringContaining('registered successfully')
        );
      } finally {
        await removeTempTree(projectPath);
      }
    });

    test('/register-project stores detected current branch', async () => {
      const projectPath = await mkdtemp(join(tmpdir(), 'archon-register-project-'));
      // handleRegisterProject canonicalizes before storing (macOS tmpdir lives
      // under /var → /private/var), so the stored default_cwd is canonical.
      const canonicalPath = await mockCanonicalizeProjectPath(projectPath);
      try {
        await Bun.spawn(['git', 'init', '-b', 'develop'], { cwd: projectPath }).exited;
        await Bun.spawn(['git', 'commit', '--allow-empty', '-m', 'init'], {
          cwd: projectPath,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Archon Test',
            GIT_AUTHOR_EMAIL: 'archon-test@example.com',
            GIT_COMMITTER_NAME: 'Archon Test',
            GIT_COMMITTER_EMAIL: 'archon-test@example.com',
          },
        }).exited;
        mockExistsSync.mockReturnValue(true);
        mockListCodebases.mockResolvedValue([]);
        mockCreateCodebase.mockResolvedValue({
          ...mockCodebase,
          id: 'new-id',
          name: 'my-app',
          default_cwd: projectPath,
        });

        await handleMessage(platform, 'chat-456', `/register-project my-app ${projectPath}`);

        expect(mockCreateCodebase).toHaveBeenCalledWith({
          name: 'my-app',
          default_cwd: canonicalPath,
          default_branch: 'develop',
          ai_assistant_type: 'claude',
          kind: 'repo',
        });
      } finally {
        await removeTempTree(projectPath);
      }
    });

    test('/register-project rejects non-existent path', async () => {
      mockExistsSync.mockReturnValue(false);

      await handleMessage(platform, 'chat-456', '/register-project my-app /nonexistent/path');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('Path does not exist')
      );
      expect(mockCreateCodebase).not.toHaveBeenCalled();
    });

    test('/register-project detects duplicate project name', async () => {
      mockExistsSync.mockReturnValue(true);
      mockListCodebases.mockResolvedValue([mockCodebase]);

      await handleMessage(platform, 'chat-456', '/register-project test-project /some/path');

      expect(platform.sendMessage).toHaveBeenCalledWith(
        'chat-456',
        expect.stringContaining('already registered')
      );
      expect(mockCreateCodebase).not.toHaveBeenCalled();
    });

    test('/register-project shows usage for missing args', async () => {
      await handleMessage(platform, 'chat-456', '/register-project');

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
        mockCreateCodebase.mockResolvedValue({
          ...mockCodebase,
          id: 'new-id',
          name: 'my-app',
          default_cwd: canonicalPath,
        });

        await handleMessage(platform, 'chat-456', `/register-project my-app ${suppliedPath}`);

        expect(mockCreateCodebase).toHaveBeenCalledWith(
          expect.objectContaining({ default_cwd: canonicalPath })
        );
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
        mockCreateCodebase.mockResolvedValue({
          ...mockCodebase,
          id: 'new-id',
          name: 'my-app',
          default_cwd: realPath,
        });

        await handleMessage(platform, 'chat-456', '/register-project my-app ~/some-project');

        expect(mockCreateCodebase).toHaveBeenCalledWith(
          expect.objectContaining({ default_cwd: realPath })
        );
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
          `/update-project ${mockCodebase.name} ${suppliedPath}`
        );

        expect(mockUpdateCodebase).toHaveBeenCalledWith(mockCodebase.id, {
          default_cwd: canonicalPath,
        });
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
        yield { type: 'assistant', content: 'On it' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'fix this', {
        issueContext: 'Issue #42: "Login bug"\nLabels: bug',
      });

      const prompt = mockClient.sendQuery.mock.calls[0][0] as string;
      expect(prompt).toContain('Issue #42');
      expect(prompt).toContain('Additional Context');
    });

    test('includes threadContext in prompt', async () => {
      mockClient.sendQuery.mockImplementation(async function* () {
        yield { type: 'assistant', content: 'On it' };
        yield { type: 'result', sessionId: 'session-id' };
      });

      await handleMessage(platform, 'chat-456', 'continue', {
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

      await handleMessage(platform, 'chat-456', 'Hello world');

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

      await handleMessage(platform, 'chat-456', '/status');

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

      await handleMessage(platform, 'chat-456', 'Hello world');

      expect(mockGenerateAndSetTitle).not.toHaveBeenCalled();
    });
  });
});

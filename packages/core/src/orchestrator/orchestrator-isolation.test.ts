import { mock, describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { MockPlatformAdapter } from '../test/mocks/platform';
import type { Conversation, Codebase } from '../types';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import * as paths from '@archon/paths';
import * as dbConversations from '../db/conversations';
import * as dbCodebases from '../db/codebases';
import * as dbIsolationEnvironments from '../db/isolation-environments';
import * as dbSessions from '../db/sessions';
import * as commandHandler from '../handlers/command-handler';
import * as storeAdapter from '../workflows/store-adapter';
import * as configLoader from '../config/config-loader';
import * as worktreeSync from '../utils/worktree-sync';
import * as cleanupService from '../services/cleanup-service';
import * as promptBuilder from './prompt-builder';
import * as errorFormatter from '../utils/error-formatter';
import * as workflowDiscovery from '@archon/workflows/workflow-discovery';
import * as workflowExecutor from '@archon/workflows/executor';
import * as workflowRouter from '@archon/workflows/router';
import * as toolFormatter from '@archon/workflows/utils/tool-formatter';
import * as titleGenerator from '../services/title-generator';

// ─── Mock setup (BEFORE importing module under test) ─────────────────────────

const mockLogger = createMockLogger();

// @archon/paths spy declarations
let spyPathsCreateLogger: ReturnType<typeof spyOn>;
let spyPathsGetArchonWorkspacesPath: ReturnType<typeof spyOn>;
let spyPathsGetArchonHome: ReturnType<typeof spyOn>;

// DB mocks
const mockUpdateConversation = mock(() => Promise.resolve());
const mockGetOrCreateConversation = mock(() => Promise.resolve(null));
const mockGetConversationByPlatformId = mock(() => Promise.resolve(null));
const mockTouchConversation = mock(() => Promise.resolve());

const mockGetCodebase = mock(() => Promise.resolve(null));
const mockListCodebases = mock(() => Promise.resolve([]));
const mockCreateCodebase = mock(() => Promise.resolve({ id: 'new-codebase-id' }));

const mockCreateIsolationStore = mock(() => ({
  updateStatus: mock(() => Promise.resolve()),
}));

const mockGetActiveSession = mock(() => Promise.resolve(null));
const mockCreateSession = mock(() => Promise.resolve(null));
const mockUpdateSession = mock(() => Promise.resolve());
const mockDeactivateSession = mock(() => Promise.resolve());
const mockTransitionSession = mock(() => Promise.resolve(null));

const mockHandleCommandFn = mock(() =>
  Promise.resolve({ message: '', modified: false, success: true })
);
const mockParseCommandFn = mock((msg: string) => ({
  command: msg.split(/\s+/)[0].substring(1),
  args: msg.split(/\s+/).slice(1),
}));

mock.module('@archon/providers', () => ({
  getAgentProvider: mock(() => null),
}));

const mockCreateWorkflowDeps = mock(() => ({
  store: {},
  getAgentProvider: () => ({}),
  loadConfig: async () => ({}),
}));

const mockLoadConfigFn = mock(() => Promise.resolve({}));
const mockLoadRepoConfig = mock(() => Promise.resolve(null));

const mockSyncArchonToWorktree = mock(() => Promise.resolve(false));

const mockCleanupToMakeRoom = mock(() => Promise.resolve({ removed: [] }));
const mockGetWorktreeStatusBreakdown = mock(() =>
  Promise.resolve({ active: 0, stale: 0, merged: 0 })
);

// Mock @archon/isolation — shared resolve mock so tests can control return values
const mockResolve = mock(() => Promise.resolve({ status: 'none' as const, cwd: '/workspace' }));

class MockIsolationResolver {
  resolve = mockResolve;
  constructor(_deps: unknown) {}
}

mock.module('@archon/isolation', () => ({
  IsolationResolver: MockIsolationResolver,
  IsolationBlockedError: class IsolationBlockedError extends Error {
    constructor(
      message: string,
      public reason?: string
    ) {
      super(message);
      this.name = 'IsolationBlockedError';
    }
  },
  configureIsolation: mock(() => undefined),
  getIsolationProvider: mock(() => ({})),
}));

const mockBuildOrchestratorPrompt = mock(() => 'prompt');
const mockBuildProjectScopedPrompt = mock(() => 'prompt');

const mockClassifyAndFormatError = mock((err: Error) => `⚠️ Error: ${err.message}`);

const mockDiscoverWorkflowsWithConfig = mock(() => Promise.resolve({ workflows: [], errors: [] }));
const mockExecuteWorkflow = mock(() => Promise.resolve());
const mockFindWorkflow = mock(() => undefined);
const mockFormatToolCall = mock(() => '');

mock.module('fs', () => ({
  existsSync: mock(() => true),
}));

const mockGenerateAndSetTitle = mock(() => Promise.resolve());

// Spy variable declarations
let spyDbConversationsGetOrCreate: ReturnType<typeof spyOn>;
let spyDbConversationsGetByPlatformId: ReturnType<typeof spyOn>;
let spyDbConversationsUpdate: ReturnType<typeof spyOn>;
let spyDbConversationsTouch: ReturnType<typeof spyOn>;
let spyDbCodebasesGet: ReturnType<typeof spyOn>;
let spyDbCodebasesList: ReturnType<typeof spyOn>;
let spyDbCodebasesCreate: ReturnType<typeof spyOn>;
let spyDbIsolationEnvCreateStore: ReturnType<typeof spyOn>;
let spyDbSessionsGetActive: ReturnType<typeof spyOn>;
let spyDbSessionsCreate: ReturnType<typeof spyOn>;
let spyDbSessionsUpdate: ReturnType<typeof spyOn>;
let spyDbSessionsDeactivate: ReturnType<typeof spyOn>;
let spyDbSessionsTransition: ReturnType<typeof spyOn>;
let spyCommandHandlerHandle: ReturnType<typeof spyOn>;
let spyCommandHandlerParse: ReturnType<typeof spyOn>;
let spyStoreAdapterCreate: ReturnType<typeof spyOn>;
let spyConfigLoaderLoad: ReturnType<typeof spyOn>;
let spyConfigLoaderLoadRepo: ReturnType<typeof spyOn>;
let spyWorktreeSyncSync: ReturnType<typeof spyOn>;
let spyCleanupToMakeRoom: ReturnType<typeof spyOn>;
let spyCleanupGetStatus: ReturnType<typeof spyOn>;
let spyPromptBuilderOrchestrator: ReturnType<typeof spyOn>;
let spyPromptBuilderProjectScoped: ReturnType<typeof spyOn>;
let spyErrorFormatterClassify: ReturnType<typeof spyOn>;
let spyWorkflowDiscovery: ReturnType<typeof spyOn>;
let spyWorkflowExecutor: ReturnType<typeof spyOn>;
let spyWorkflowRouter: ReturnType<typeof spyOn>;
let spyToolFormatter: ReturnType<typeof spyOn>;
let spyTitleGenerator: ReturnType<typeof spyOn>;

// ─── Import module under test AFTER all mocks ────────────────────────────────

const { validateAndResolveIsolation } = await import('./orchestrator');

// ─── Spy setup / teardown ─────────────────────────────────────────────────────

beforeEach(() => {
  spyPathsCreateLogger = spyOn(paths, 'createLogger').mockReturnValue(
    mockLogger as ReturnType<typeof paths.createLogger>
  );
  spyPathsGetArchonWorkspacesPath = spyOn(paths, 'getArchonWorkspacesPath').mockReturnValue(
    '/home/test/.archon/workspaces'
  );
  spyPathsGetArchonHome = spyOn(paths, 'getArchonHome').mockReturnValue('/home/test/.archon');
  spyDbConversationsGetOrCreate = spyOn(
    dbConversations,
    'getOrCreateConversation'
  ).mockImplementation(mockGetOrCreateConversation);
  spyDbConversationsGetByPlatformId = spyOn(
    dbConversations,
    'getConversationByPlatformId'
  ).mockImplementation(mockGetConversationByPlatformId);
  spyDbConversationsUpdate = spyOn(dbConversations, 'updateConversation').mockImplementation(
    mockUpdateConversation
  );
  spyDbConversationsTouch = spyOn(dbConversations, 'touchConversation').mockImplementation(
    mockTouchConversation
  );
  spyDbCodebasesGet = spyOn(dbCodebases, 'getCodebase').mockImplementation(mockGetCodebase);
  spyDbCodebasesList = spyOn(dbCodebases, 'listCodebases').mockImplementation(mockListCodebases);
  spyDbCodebasesCreate = spyOn(dbCodebases, 'createCodebase').mockImplementation(
    mockCreateCodebase
  );
  spyDbIsolationEnvCreateStore = spyOn(
    dbIsolationEnvironments,
    'createIsolationStore'
  ).mockImplementation(mockCreateIsolationStore);
  spyDbSessionsGetActive = spyOn(dbSessions, 'getActiveSession').mockImplementation(
    mockGetActiveSession
  );
  spyDbSessionsCreate = spyOn(dbSessions, 'createSession').mockImplementation(mockCreateSession);
  spyDbSessionsUpdate = spyOn(dbSessions, 'updateSession').mockImplementation(mockUpdateSession);
  spyDbSessionsDeactivate = spyOn(dbSessions, 'deactivateSession').mockImplementation(
    mockDeactivateSession
  );
  spyDbSessionsTransition = spyOn(dbSessions, 'transitionSession').mockImplementation(
    mockTransitionSession
  );
  spyCommandHandlerHandle = spyOn(commandHandler, 'handleCommand').mockImplementation(
    mockHandleCommandFn
  );
  spyCommandHandlerParse = spyOn(commandHandler, 'parseCommand').mockImplementation(
    mockParseCommandFn
  );
  spyStoreAdapterCreate = spyOn(storeAdapter, 'createWorkflowDeps').mockImplementation(
    mockCreateWorkflowDeps
  );
  spyConfigLoaderLoad = spyOn(configLoader, 'loadConfig').mockImplementation(mockLoadConfigFn);
  spyConfigLoaderLoadRepo = spyOn(configLoader, 'loadRepoConfig').mockImplementation(
    mockLoadRepoConfig
  );
  spyWorktreeSyncSync = spyOn(worktreeSync, 'syncArchonToWorktree').mockImplementation(
    mockSyncArchonToWorktree
  );
  spyCleanupToMakeRoom = spyOn(cleanupService, 'cleanupToMakeRoom').mockImplementation(
    mockCleanupToMakeRoom
  );
  spyCleanupGetStatus = spyOn(cleanupService, 'getWorktreeStatusBreakdown').mockImplementation(
    mockGetWorktreeStatusBreakdown
  );
  spyPromptBuilderOrchestrator = spyOn(promptBuilder, 'buildOrchestratorPrompt').mockImplementation(
    mockBuildOrchestratorPrompt
  );
  spyPromptBuilderProjectScoped = spyOn(
    promptBuilder,
    'buildProjectScopedPrompt'
  ).mockImplementation(mockBuildProjectScopedPrompt);
  spyErrorFormatterClassify = spyOn(errorFormatter, 'classifyAndFormatError').mockImplementation(
    mockClassifyAndFormatError
  );
  spyWorkflowDiscovery = spyOn(workflowDiscovery, 'discoverWorkflowsWithConfig').mockImplementation(
    mockDiscoverWorkflowsWithConfig
  );
  spyWorkflowExecutor = spyOn(workflowExecutor, 'executeWorkflow').mockImplementation(
    mockExecuteWorkflow
  );
  spyWorkflowRouter = spyOn(workflowRouter, 'findWorkflow').mockImplementation(mockFindWorkflow);
  spyToolFormatter = spyOn(toolFormatter, 'formatToolCall').mockImplementation(mockFormatToolCall);
  spyTitleGenerator = spyOn(titleGenerator, 'generateAndSetTitle').mockImplementation(
    mockGenerateAndSetTitle
  );
});

afterEach(() => {
  spyPathsCreateLogger.mockRestore();
  spyPathsGetArchonWorkspacesPath.mockRestore();
  spyPathsGetArchonHome.mockRestore();
  spyDbConversationsGetOrCreate.mockRestore();
  spyDbConversationsGetByPlatformId.mockRestore();
  spyDbConversationsUpdate.mockRestore();
  spyDbConversationsTouch.mockRestore();
  spyDbCodebasesGet.mockRestore();
  spyDbCodebasesList.mockRestore();
  spyDbCodebasesCreate.mockRestore();
  spyDbIsolationEnvCreateStore.mockRestore();
  spyDbSessionsGetActive.mockRestore();
  spyDbSessionsCreate.mockRestore();
  spyDbSessionsUpdate.mockRestore();
  spyDbSessionsDeactivate.mockRestore();
  spyDbSessionsTransition.mockRestore();
  spyCommandHandlerHandle.mockRestore();
  spyCommandHandlerParse.mockRestore();
  spyStoreAdapterCreate.mockRestore();
  spyConfigLoaderLoad.mockRestore();
  spyConfigLoaderLoadRepo.mockRestore();
  spyWorktreeSyncSync.mockRestore();
  spyCleanupToMakeRoom.mockRestore();
  spyCleanupGetStatus.mockRestore();
  spyPromptBuilderOrchestrator.mockRestore();
  spyPromptBuilderProjectScoped.mockRestore();
  spyErrorFormatterClassify.mockRestore();
  spyWorkflowDiscovery.mockRestore();
  spyWorkflowExecutor.mockRestore();
  spyWorkflowRouter.mockRestore();
  spyToolFormatter.mockRestore();
  spyTitleGenerator.mockRestore();
});

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeEnvRow(overrides?: Partial<IsolationEnvironmentRow>): IsolationEnvironmentRow {
  return {
    id: 'env-1',
    codebase_id: 'cb-1',
    workflow_type: 'issue',
    workflow_id: '42',
    provider: 'worktree',
    working_path: '/worktrees/issue-42',
    branch_name: 'issue-42',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'web',
    metadata: {},
    ...overrides,
  };
}

function makeConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    platform_type: 'web',
    platform_conversation_id: 'web-conv-1',
    codebase_id: 'cb-1',
    cwd: '/workspace',
    isolation_env_id: null,
    ai_assistant_type: 'claude',
    title: null,
    hidden: false,
    deleted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeCodebase(overrides?: Partial<Codebase>): Codebase {
  return {
    id: 'cb-1',
    name: 'test-repo',
    default_cwd: '/workspace/test-repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('validateAndResolveIsolation', () => {
  let platform: MockPlatformAdapter;

  beforeEach(() => {
    platform = new MockPlatformAdapter();
    mockUpdateConversation.mockClear();
    mockResolve.mockClear();
  });

  test('linked_issue_reuse triggers reuse message', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase();

    mockResolve.mockResolvedValueOnce({
      status: 'resolved',
      env: makeEnvRow(),
      cwd: '/worktrees/issue-42',
      method: { type: 'linked_issue_reuse', issueNumber: 99 },
    });

    const result = await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    expect(platform.sendMessage).toHaveBeenCalledWith('conv-1', 'Reusing worktree from issue #99');
    expect(result.status).toBe('new');
  });

  test('created with autoCleanedCount triggers cleanup message', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase();

    mockResolve.mockResolvedValueOnce({
      status: 'resolved',
      env: makeEnvRow(),
      cwd: '/worktrees/issue-42',
      method: { type: 'created', autoCleanedCount: 3 },
    });

    const result = await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    expect(platform.sendMessage).toHaveBeenCalledWith(
      'conv-1',
      'Cleaned up 3 merged worktree(s) to make room.'
    );
    expect(result.status).toBe('new');
  });
});

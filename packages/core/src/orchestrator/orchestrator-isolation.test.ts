import { mock, describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { MockPlatformAdapter } from '../test/mocks/platform';
import type { Conversation, Codebase } from '../types';
import type { IsolationEnvironmentRow } from '@archon/isolation';

// ─── Namespace imports for spyOn ─────────────────────────────────────────────

import * as archonPaths from '@archon/paths';
import * as dbConversations from '../db/conversations';
import * as dbCodebases from '../db/codebases';
import * as dbIsolationEnvironments from '../db/isolation-environments';
import * as dbSessions from '../db/sessions';
import * as commandHandlerModule from '../handlers/command-handler';
import * as providers from '@archon/providers';
import * as storeAdapter from '../workflows/store-adapter';
import * as configLoader from '../config/config-loader';
import * as worktreeSync from '../utils/worktree-sync';
import * as cleanupServiceModule from '../services/cleanup-service';
import * as promptBuilder from './prompt-builder';
import * as errorFormatter from '../utils/error-formatter';
import * as titleGenerator from '../services/title-generator';
import * as workflowDiscovery from '@archon/workflows/workflow-discovery';
import * as workflowExecutor from '@archon/workflows/executor';
import * as workflowRouter from '@archon/workflows/router';

// ─── Mock @archon/isolation (external — no spyOn available in this package) ─

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

// ─── Mock @archon/workflows/* (external packages) ────────────────────────────

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mock(() => Promise.resolve({ workflows: [], errors: [] })),
}));
mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mock(() => Promise.resolve()),
}));
mock.module('@archon/workflows/router', () => ({
  findWorkflow: mock(() => undefined),
}));
mock.module('@archon/workflows/utils/tool-formatter', () => ({
  formatToolCall: mock(() => ''),
}));

mock.module('fs', () => ({
  existsSync: mock(() => true),
}));

// ─── Import module under test ────────────────────────────────────────────────

import { validateAndResolveIsolation } from './orchestrator';

// ─── Mock logger ─────────────────────────────────────────────────────────────

const mockLogger = createMockLogger();

// ─── Spy variables ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateLogger: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetArchonWorkspacesPath: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetArchonHome: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetOrCreateConversation: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetConversationByPlatformId: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyUpdateConversation: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyTouchConversation: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetCodebase: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyListCodebases: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateCodebaseDb: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateIsolationStore: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetActiveSession: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateSession: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyUpdateSession: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyDeactivateSession: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyTransitionSession: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyHandleCommand: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyParseCommand: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetAgentProvider: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCreateWorkflowDeps: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyLoadConfig: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyLoadRepoConfig: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spySyncArchonToWorktree: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyCleanupToMakeRoom: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGetWorktreeStatusBreakdown: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyBuildOrchestratorPrompt: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyBuildProjectScopedPrompt: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyClassifyAndFormatError: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyGenerateAndSetTitle: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyDiscoverWorkflowsWithConfig: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyExecuteWorkflow: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spyFindWorkflow: any;

function setupSpies() {
  spyCreateLogger = spyOn(archonPaths, 'createLogger').mockReturnValue(mockLogger as never);
  spyGetArchonWorkspacesPath = spyOn(archonPaths, 'getArchonWorkspacesPath').mockReturnValue(
    '/home/test/.archon/workspaces' as never
  );
  spyGetArchonHome = spyOn(archonPaths, 'getArchonHome').mockReturnValue(
    '/home/test/.archon' as never
  );

  spyGetOrCreateConversation = spyOn(dbConversations, 'getOrCreateConversation').mockResolvedValue(
    null as never
  );
  spyGetConversationByPlatformId = spyOn(
    dbConversations,
    'getConversationByPlatformId'
  ).mockResolvedValue(null as never);
  spyUpdateConversation = spyOn(dbConversations, 'updateConversation').mockResolvedValue(
    undefined as never
  );
  spyTouchConversation = spyOn(dbConversations, 'touchConversation').mockResolvedValue(
    undefined as never
  );

  spyGetCodebase = spyOn(dbCodebases, 'getCodebase').mockResolvedValue(null as never);
  spyListCodebases = spyOn(dbCodebases, 'listCodebases').mockResolvedValue([] as never);
  spyCreateCodebaseDb = spyOn(dbCodebases, 'createCodebase').mockResolvedValue({
    id: 'new-codebase-id',
  } as never);

  spyCreateIsolationStore = spyOn(dbIsolationEnvironments, 'createIsolationStore').mockReturnValue({
    updateStatus: mock(() => Promise.resolve()),
  } as never);

  spyGetActiveSession = spyOn(dbSessions, 'getActiveSession').mockResolvedValue(null as never);
  spyCreateSession = spyOn(dbSessions, 'createSession').mockResolvedValue(null as never);
  spyUpdateSession = spyOn(dbSessions, 'updateSession').mockResolvedValue(undefined as never);
  spyDeactivateSession = spyOn(dbSessions, 'deactivateSession').mockResolvedValue(
    undefined as never
  );
  spyTransitionSession = spyOn(dbSessions, 'transitionSession').mockResolvedValue(null as never);

  spyHandleCommand = spyOn(commandHandlerModule, 'handleCommand').mockResolvedValue({
    message: '',
    modified: false,
    success: true,
  } as never);
  spyParseCommand = spyOn(commandHandlerModule, 'parseCommand').mockImplementation(
    (msg: string) =>
      ({
        command: msg.split(/\s+/)[0].substring(1),
        args: msg.split(/\s+/).slice(1),
      }) as never
  );

  spyGetAgentProvider = spyOn(providers, 'getAgentProvider').mockReturnValue(null as never);

  spyCreateWorkflowDeps = spyOn(storeAdapter, 'createWorkflowDeps').mockReturnValue({
    store: {},
    getAgentProvider: () => ({}),
    loadConfig: async () => ({}),
  } as never);

  spyLoadConfig = spyOn(configLoader, 'loadConfig').mockResolvedValue({} as never);
  spyLoadRepoConfig = spyOn(configLoader, 'loadRepoConfig').mockResolvedValue(null as never);

  spySyncArchonToWorktree = spyOn(worktreeSync, 'syncArchonToWorktree').mockResolvedValue(
    false as never
  );

  spyCleanupToMakeRoom = spyOn(cleanupServiceModule, 'cleanupToMakeRoom').mockResolvedValue({
    removed: [],
  } as never);
  spyGetWorktreeStatusBreakdown = spyOn(
    cleanupServiceModule,
    'getWorktreeStatusBreakdown'
  ).mockResolvedValue({ active: 0, stale: 0, merged: 0 } as never);

  spyBuildOrchestratorPrompt = spyOn(promptBuilder, 'buildOrchestratorPrompt').mockReturnValue(
    'prompt' as never
  );
  spyBuildProjectScopedPrompt = spyOn(promptBuilder, 'buildProjectScopedPrompt').mockReturnValue(
    'prompt' as never
  );

  spyClassifyAndFormatError = spyOn(errorFormatter, 'classifyAndFormatError').mockImplementation(
    (err: Error) => `⚠️ Error: ${err.message}` as never
  );

  spyGenerateAndSetTitle = spyOn(titleGenerator, 'generateAndSetTitle').mockResolvedValue(
    undefined as never
  );

  spyDiscoverWorkflowsWithConfig = spyOn(
    workflowDiscovery,
    'discoverWorkflowsWithConfig'
  ).mockResolvedValue({ workflows: [], errors: [] } as never);
  spyExecuteWorkflow = spyOn(workflowExecutor, 'executeWorkflow').mockResolvedValue(
    undefined as never
  );
  spyFindWorkflow = spyOn(workflowRouter, 'findWorkflow').mockReturnValue(undefined as never);
}

function restoreSpies() {
  spyCreateLogger?.mockRestore();
  spyGetArchonWorkspacesPath?.mockRestore();
  spyGetArchonHome?.mockRestore();
  spyGetOrCreateConversation?.mockRestore();
  spyGetConversationByPlatformId?.mockRestore();
  spyUpdateConversation?.mockRestore();
  spyTouchConversation?.mockRestore();
  spyGetCodebase?.mockRestore();
  spyListCodebases?.mockRestore();
  spyCreateCodebaseDb?.mockRestore();
  spyCreateIsolationStore?.mockRestore();
  spyGetActiveSession?.mockRestore();
  spyCreateSession?.mockRestore();
  spyUpdateSession?.mockRestore();
  spyDeactivateSession?.mockRestore();
  spyTransitionSession?.mockRestore();
  spyHandleCommand?.mockRestore();
  spyParseCommand?.mockRestore();
  spyGetAgentProvider?.mockRestore();
  spyCreateWorkflowDeps?.mockRestore();
  spyLoadConfig?.mockRestore();
  spyLoadRepoConfig?.mockRestore();
  spySyncArchonToWorktree?.mockRestore();
  spyCleanupToMakeRoom?.mockRestore();
  spyGetWorktreeStatusBreakdown?.mockRestore();
  spyBuildOrchestratorPrompt?.mockRestore();
  spyBuildProjectScopedPrompt?.mockRestore();
  spyClassifyAndFormatError?.mockRestore();
  spyGenerateAndSetTitle?.mockRestore();
  spyDiscoverWorkflowsWithConfig?.mockRestore();
  spyExecuteWorkflow?.mockRestore();
  spyFindWorkflow?.mockRestore();
}

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
    setupSpies();
    platform = new MockPlatformAdapter();
    mockResolve.mockClear();
  });

  afterEach(() => {
    restoreSpies();
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

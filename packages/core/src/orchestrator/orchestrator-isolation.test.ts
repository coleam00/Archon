import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { MockPlatformAdapter } from '../test/mocks/platform';
import type { Conversation, Codebase } from '../types';
import type { IsolationEnvironmentRow } from '@archon/isolation';
// Type-only imports are erased at runtime, so these do not load './orchestrator'
// (or the workflow engine) before the mock.module() calls below take effect.
import type { WorkflowRoutingContext } from './orchestrator';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';

// ─── Mock setup (BEFORE importing module under test) ─────────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  ensureArchonWorkspacesPath: mock(() => Promise.resolve('/home/test/.archon/workspaces')),
  getArchonHome: mock(() => '/home/test/.archon'),
  getCredentialKeyPath: mock(() => '/home/test/.archon/credential-key'),
  // Required by @archon/git (loaded via orchestrator.ts's toBranchName import).
  getProjectWorktreesPath: mock(
    (owner: string, repo: string) => `/home/test/.archon/workspaces/${owner}/${repo}/worktrees`
  ),
}));

// DB mocks
const mockUpdateConversation = mock(() => Promise.resolve());
const mockGetOrCreateConversation = mock((): Promise<Conversation | null> => Promise.resolve(null));
mock.module('../db/conversations', () => ({
  getOrCreateConversation: mockGetOrCreateConversation,
  getConversationByPlatformId: mock(() => Promise.resolve(null)),
  updateConversation: mockUpdateConversation,
  touchConversation: mock(() => Promise.resolve()),
}));

const mockGetCodebase = mock((): Promise<Codebase | null> => Promise.resolve(null));
mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  listCodebases: mock(() => Promise.resolve([])),
  createCodebase: mock(() => Promise.resolve({ id: 'new-codebase-id' })),
}));

mock.module('../db/isolation-environments', () => ({
  createIsolationStore: mock(() => ({
    updateStatus: mock(() => Promise.resolve()),
  })),
}));

// orchestrator.ts resolves the per-user no-reply email for worktree git identity;
// mock it (like the other db deps) so the real db/connection + adapters aren't
// dragged into this test's light module graph.
mock.module('../db/user-github-token-store', () => ({
  getUserGithubNoreplyEmail: mock(() => Promise.resolve(null)),
}));

mock.module('../db/sessions', () => ({
  getActiveSession: mock(() => Promise.resolve(null)),
  createSession: mock(() => Promise.resolve(null)),
  updateSession: mock(() => Promise.resolve()),
  deactivateSession: mock(() => Promise.resolve()),
  transitionSession: mock(() => Promise.resolve(null)),
}));

mock.module('../handlers/command-handler', () => ({
  handleCommand: mock(() => Promise.resolve({ message: '', modified: false, success: true })),
  parseCommand: mock((msg: string) => ({
    command: msg.split(/\s+/)[0].substring(1),
    args: msg.split(/\s+/).slice(1),
  })),
}));

mock.module('@archon/providers', () => ({
  getAgentProvider: mock(() => null),
  getRegisteredProviders: mock(() => []),
  // credentials/delivery (#1955) imports these from '@archon/providers'.
  PI_PROVIDER_ENV_VARS: { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' },
  PI_AMBIENT_VENDORS: ['amazon-bedrock', 'google-vertex'],
}));

const mockCreateWorkflowRun = mock(() => Promise.resolve({ id: 'run-1' }));
mock.module('../workflows/store-adapter', () => ({
  createWorkflowDeps: mock(() => ({
    store: { createWorkflowRun: mockCreateWorkflowRun },
    getAgentProvider: () => ({}),
    loadConfig: async () => ({}),
  })),
}));

mock.module('../config/config-loader', () => ({
  loadConfig: mock(() => Promise.resolve({})),
  loadRepoConfig: mock(() => Promise.resolve(null)),
}));

mock.module('../utils/worktree-sync', () => ({
  syncArchonToWorktree: mock(() => Promise.resolve(false)),
}));

mock.module('../services/cleanup-service', () => ({
  cleanupToMakeRoom: mock(() => Promise.resolve({ removed: [] })),
  getWorktreeStatusBreakdown: mock(() => Promise.resolve({ active: 0, stale: 0, merged: 0 })),
  STALE_THRESHOLD_DAYS: 7,
}));

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
  classifyIsolationError: (err: Error) => err.message,
}));

mock.module('./prompt-builder', () => ({
  buildOrchestratorPrompt: mock(() => 'prompt'),
  buildProjectScopedPrompt: mock(() => 'prompt'),
}));

mock.module('../utils/error-formatter', () => ({
  classifyAndFormatError: mock((err: Error) => `⚠️ Error: ${err.message}`),
}));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mock(() => Promise.resolve({ workflows: [], errors: [] })),
}));
// Resolves to a paused result so dispatchBackgroundWorkflow's fire-and-forget
// tail is a no-op (no result card is surfaced to the parent conversation).
const mockExecuteWorkflow = mock(() => Promise.resolve({ paused: true }));
mock.module('@archon/workflows/executor', () => ({
  executeWorkflow: mockExecuteWorkflow,
}));
mock.module('@archon/workflows/router', () => ({
  findWorkflow: mock(() => undefined),
}));
mock.module('@archon/workflows/utils/tool-formatter', () => ({
  formatToolCall: mock(() => ''),
}));

mock.module('fs', () => ({
  existsSync: mock(() => true),
  // token-crypto.ts imports these from node:fs for the auto-provisioned credential
  // key. readFileSync returns a valid 64-hex key so getEncryptionKey() resolves
  // without any real disk write when the per-user credential path is exercised.
  readFileSync: mock(() => 'a'.repeat(64)),
  writeFileSync: mock(() => undefined),
  mkdirSync: mock(() => undefined),
  chmodSync: mock(() => undefined),
}));

mock.module('../services/title-generator', () => ({
  generateAndSetTitle: mock(() => Promise.resolve()),
}));

// ─── Import module under test AFTER all mocks ────────────────────────────────

const { validateAndResolveIsolation, dispatchBackgroundWorkflow } = await import('./orchestrator');

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

  test('passes codebase default_branch to the resolver as defaultBranch', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase({ default_branch: 'develop' });

    mockResolve.mockResolvedValueOnce({
      status: 'resolved',
      env: makeEnvRow(),
      cwd: '/worktrees/issue-42',
      method: { type: 'created' },
    });

    await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    const request = mockResolve.mock.calls.at(-1)?.[0] as unknown as {
      codebase: { defaultBranch?: string | null };
    };
    expect(request.codebase.defaultBranch).toBe('develop');
  });

  test('passes null defaultBranch to the resolver when the codebase has none stored', async () => {
    const conversation = makeConversation();
    const codebase = makeCodebase({ default_branch: null });

    mockResolve.mockResolvedValueOnce({
      status: 'resolved',
      env: makeEnvRow(),
      cwd: '/worktrees/issue-42',
      method: { type: 'created' },
    });

    await validateAndResolveIsolation(conversation, codebase, platform, 'conv-1');

    const request = mockResolve.mock.calls.at(-1)?.[0] as unknown as {
      codebase: { defaultBranch?: string | null };
    };
    expect(request.codebase.defaultBranch).toBeNull();
  });
});

describe('dispatchBackgroundWorkflow', () => {
  let platform: MockPlatformAdapter;

  function makeWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
    return {
      name: 'bg-workflow',
      description: 'background dispatch test workflow',
      nodes: [],
      ...overrides,
    } as WorkflowDefinition;
  }

  function makeRoutingCtx(): WorkflowRoutingContext {
    return {
      platform,
      conversationId: 'parent-conv',
      cwd: '/parent/cwd',
      originalMessage: 'run it',
      conversationDbId: 'parent-db-id',
      codebaseId: 'cb-1',
      availableWorkflows: [],
    };
  }

  /** Let the fire-and-forget execution tail settle before the test ends. */
  async function flushBackgroundExecution(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    platform = new MockPlatformAdapter();
    mockResolve.mockClear();
    mockUpdateConversation.mockClear();
    mockCreateWorkflowRun.mockClear();
    mockLogger.info.mockClear();
    mockGetOrCreateConversation.mockResolvedValue(
      makeConversation({ id: 'worker-conv-1', platform_conversation_id: 'web-worker-1' })
    );
    mockGetCodebase.mockResolvedValue(makeCodebase());
  });

  test('worktree.enabled: false skips isolation and runs in the parent cwd', async () => {
    const workflow = makeWorkflow({ worktree: { enabled: false } });

    await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);

    // Policy opt-out: no isolation resolution attempted at all.
    expect(mockResolve).not.toHaveBeenCalled();
    // The run executes in the parent conversation's cwd (live checkout).
    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    const runRow = mockCreateWorkflowRun.mock.calls[0]?.[0] as unknown as {
      working_path: string;
    };
    expect(runRow.working_path).toBe('/parent/cwd');
    // Operators can distinguish live-checkout runs from worktree runs in logs.
    expect(mockLogger.info).toHaveBeenCalledWith(
      { workflowName: 'bg-workflow', conversationId: 'parent-conv', codebaseId: 'cb-1' },
      'workflow.worktree_disabled_by_policy'
    );

    await flushBackgroundExecution();
  });

  test('default policy still resolves isolation for the worker', async () => {
    const workflow = makeWorkflow();
    mockResolve.mockResolvedValueOnce({
      status: 'resolved',
      env: makeEnvRow({ working_path: '/worktrees/bg-1', branch_name: 'bg-1' }),
      cwd: '/worktrees/bg-1',
      method: { type: 'created' },
    });

    await dispatchBackgroundWorkflow(makeRoutingCtx(), workflow);

    // Without an explicit opt-out, the worker gets its own isolation environment.
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockCreateWorkflowRun).toHaveBeenCalledTimes(1);
    const runRow = mockCreateWorkflowRun.mock.calls[0]?.[0] as unknown as {
      working_path: string;
    };
    expect(runRow.working_path).toBe('/worktrees/bg-1');
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'workflow.worktree_disabled_by_policy'
    );

    await flushBackgroundExecution();
  });
});

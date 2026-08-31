/**
 * Unit tests for command handler
 *
 * Note: We avoid using mock.module() for internal modules (utils/git, utils/path-validation)
 * that have their own test files. Mocking internal modules causes test isolation issues
 * since Bun's mock.module() persists globally across test files.
 *
 * Instead, we use spyOn for internal modules, which allows spying on specific functions
 * without replacing the entire module in the global cache.
 */
import { describe, test, expect, mock, beforeEach, afterAll, spyOn } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { Codebase, Conversation, Session } from '../types';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import { join } from 'path';
import * as fsPromises from 'fs/promises';
import * as gitUtils from '@archon/git';
import * as pathValidation from '../utils/path-validation';
import * as workflowDiscovery from '@archon/workflows/workflow-discovery';
import type * as CodebaseDb from '../db/codebases';
import type * as ConversationDb from '../db/conversations';
import type * as IsolationEnvironmentDb from '../db/isolation-environments';
import type * as SessionDb from '../db/sessions';
import type * as WorkflowDb from '../db/workflows';
import type * as WorkflowEventDb from '../db/workflow-events';
import type * as WorkflowNodeSessionDb from '../db/workflow-node-sessions';

function makeCodebase(overrides: Partial<Codebase> = {}): Codebase {
  return {
    id: 'codebase-123',
    name: 'owner/repo',
    repository_url: 'https://github.com/owner/repo.git',
    default_cwd: '/workspace/owner/repo',
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-123',
    platform_type: 'telegram',
    platform_conversation_id: 'chat-123',
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
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-123',
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
    ...overrides,
  };
}

function makeWorkflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-123',
    parent_conversation_id: null,
    codebase_id: null,
    status: 'running',
    outcome: null,
    user_message: 'test request',
    metadata: {},
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    adopted_from_run_id: null,
    output_root: null,
    ...overrides,
  };
}

function makeIsolationEnvironment(
  overrides: Partial<IsolationEnvironmentRow> = {}
): IsolationEnvironmentRow {
  return {
    id: 'env-uuid-123',
    codebase_id: 'codebase-123',
    workflow_type: 'task',
    workflow_id: 'task-feat-auth',
    provider: 'worktree',
    working_path: '/workspace/my-repo/worktrees/task-feat-auth',
    branch_name: 'task-feat-auth',
    status: 'active',
    created_at: new Date(),
    created_by_platform: 'test',
    created_by_user_id: null,
    metadata: {},
    ...overrides,
  };
}

// Create mock functions for database modules (safe to mock - no standalone tests)
const mockUpdateConversation = mock<typeof ConversationDb.updateConversation>(() =>
  Promise.resolve()
);
const mockGetCodebase = mock<typeof CodebaseDb.getCodebase>(() => Promise.resolve(null));
const mockFindCodebaseByDefaultCwd = mock<typeof CodebaseDb.findCodebaseByDefaultCwd>(() =>
  Promise.resolve(null)
);
const mockCreateCodebase = mock<typeof CodebaseDb.createCodebase>(() =>
  Promise.resolve(makeCodebase())
);
const mockGetCodebaseCommands = mock<typeof CodebaseDb.getCodebaseCommands>(() =>
  Promise.resolve({})
);
const mockUpdateCodebaseCommands = mock<typeof CodebaseDb.updateCodebaseCommands>(() =>
  Promise.resolve()
);
const mockDeleteCodebase = mock<typeof CodebaseDb.deleteCodebase>(() => Promise.resolve());
const mockListCodebases = mock<typeof CodebaseDb.listCodebases>(() => Promise.resolve([]));
const mockGetActiveSession = mock<typeof SessionDb.getActiveSession>(() => Promise.resolve(null));
const mockDeactivateSession = mock<typeof SessionDb.deactivateSession>(() => Promise.resolve());

// Workflow database mocks
const mockGetActiveWorkflowRun = mock<typeof WorkflowDb.getActiveWorkflowRun>(() =>
  Promise.resolve(null)
);
const mockCancelWorkflowRun = mock<typeof WorkflowDb.cancelWorkflowRun>(() =>
  Promise.resolve({ cancelled: true })
);
const mockCancelResumableRunsForConversation = mock<
  typeof WorkflowDb.cancelResumableRunsForConversation
>(() => Promise.resolve([]));
const mockListWorkflowRuns = mock<typeof WorkflowDb.listWorkflowRuns>(() => Promise.resolve([]));
const mockGetWorkflowRun = mock<typeof WorkflowDb.getWorkflowRun>(() => Promise.resolve(null));
const mockResumeWorkflowRun = mock<typeof WorkflowDb.resumeWorkflowRun>(() =>
  Promise.resolve(makeWorkflowRun({ id: 'run-id' }))
);
const mockFailWorkflowRun = mock<typeof WorkflowDb.failWorkflowRun>(() => Promise.resolve());
const mockUpdateWorkflowRun = mock<typeof WorkflowDb.updateWorkflowRun>(() => Promise.resolve());
// /workflow abandon cascade-cancels the sub-run tree (#2121 Phase 2), walking it
// via findChildRuns. This entry is load-bearing: mock.module MERGES over the real
// module rather than replacing the namespace, so an omitted export keeps its REAL
// implementation. While this was missing, every abandon test ran the real
// findChildRuns → pool.query → created and schema-initialised a real SQLite
// database on disk, in a test that reads as fully mocked (#2240).
const mockFindChildRuns = mock<typeof WorkflowDb.findChildRuns>(() => Promise.resolve([]));
// CAS gate resolvers (#2113) — approve/reject stamp the resolution atomically here
// instead of via updateWorkflowRun. resolveAndCancelApprovalGate is the atomic
// resolve+cancel for terminal reject outcomes. Default to "won the race".
const mockResolveApprovalGate = mock<typeof WorkflowDb.resolveApprovalGate>(() =>
  Promise.resolve({ resolved: true })
);
const mockResolveAndCancelApprovalGate = mock<typeof WorkflowDb.resolveAndCancelApprovalGate>(() =>
  Promise.resolve({ resolved: true })
);

// Workflow events database mocks
const mockCreateWorkflowEvent = mock<typeof WorkflowEventDb.createWorkflowEvent>(() =>
  Promise.resolve()
);

// Spies for internal modules (use spyOn instead of mock.module to avoid global pollution)
let spyIsPathWithinWorkspace: ReturnType<typeof spyOn>;
let spyExecFileAsync: ReturnType<typeof spyOn>;
let spyWorktreeExists: ReturnType<typeof spyOn>;
let spyListWorktrees: ReturnType<typeof spyOn>;
let spyRemoveWorktree: ReturnType<typeof spyOn>;
let spyGetWorktreeBase: ReturnType<typeof spyOn>;
let spyGetCanonicalRepoPath: ReturnType<typeof spyOn>;
let spyIsWorktreePath: ReturnType<typeof spyOn>;
let spyFindWorktreeByBranch: ReturnType<typeof spyOn>;
let spyMkdirAsync: ReturnType<typeof spyOn>;

// Spies for fs/promises (avoid global mock.module pollution)
let spyFsAccess: ReturnType<typeof spyOn>;
let spyFsMkdir: ReturnType<typeof spyOn>;
let spyFsReaddir: ReturnType<typeof spyOn>;
let spyFsRm: ReturnType<typeof spyOn>;
let spyFsWriteFile: ReturnType<typeof spyOn>;

// Spies for workflows module
let spyDiscoverWorkflows: ReturnType<typeof spyOn>;

// Mock database modules (safe - these don't have standalone tests that would be affected)
mock.module('../db/conversations', () => ({
  updateConversation: mockUpdateConversation,
}));

mock.module('../db/codebases', () => ({
  getCodebase: mockGetCodebase,
  findCodebaseByDefaultCwd: mockFindCodebaseByDefaultCwd,
  createCodebase: mockCreateCodebase,
  getCodebaseCommands: mockGetCodebaseCommands,
  updateCodebaseCommands: mockUpdateCodebaseCommands,
  deleteCodebase: mockDeleteCodebase,
  listCodebases: mockListCodebases,
}));

mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
}));

mock.module('../db/workflows', () => ({
  getActiveWorkflowRun: mockGetActiveWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  cancelResumableRunsForConversation: mockCancelResumableRunsForConversation,
  listWorkflowRuns: mockListWorkflowRuns,
  getWorkflowRun: mockGetWorkflowRun,
  findChildRuns: mockFindChildRuns,
  resumeWorkflowRun: mockResumeWorkflowRun,
  failWorkflowRun: mockFailWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
  resolveApprovalGate: mockResolveApprovalGate,
  resolveAndCancelApprovalGate: mockResolveAndCancelApprovalGate,
}));

mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

// Mock the node-session DB layer so /workflow reset-sessions exercises the real
// operation (resetWorkflowNodeSessions) without touching a database. Safe from
// mock.module pollution because command-handler.test.ts runs as its own isolated
// `bun test` invocation (see packages/core/package.json).
const mockDeleteWorkflowNodeSessions = mock<
  typeof WorkflowNodeSessionDb.deleteWorkflowNodeSessions
>(() => Promise.resolve({ deleted: 0 }));
mock.module('../db/workflow-node-sessions', () => ({
  deleteWorkflowNodeSessions: mockDeleteWorkflowNodeSessions,
  getWorkflowNodeSession: mock(() => Promise.resolve(null)),
  upsertWorkflowNodeSession: mock(() => Promise.resolve()),
}));

// Mock isolation-environments database
const mockIsolationEnvDbCreate = mock<typeof IsolationEnvironmentDb.create>(() =>
  Promise.resolve(makeIsolationEnvironment())
);
const mockIsolationEnvDbGet = mock<typeof IsolationEnvironmentDb.getById>(() =>
  Promise.resolve(null)
);
const mockIsolationEnvDbUpdate = mock<typeof IsolationEnvironmentDb.updateStatus>(() =>
  Promise.resolve()
);
const mockGetLiveRunOwningEnv = mock<typeof IsolationEnvironmentDb.getLiveRunOwningEnv>(() =>
  Promise.resolve(null)
);

const mockCountActiveByCodebase = mock<typeof IsolationEnvironmentDb.countActiveByCodebase>(() =>
  Promise.resolve(0)
);
mock.module('../db/isolation-environments', () => ({
  create: mockIsolationEnvDbCreate,
  getById: mockIsolationEnvDbGet,
  getByWorkingPath: mock(() => Promise.resolve(null)),
  getLiveRunOwningEnv: mockGetLiveRunOwningEnv,
  updateStatus: mockIsolationEnvDbUpdate,
  markDestroyed: mock(() => Promise.resolve()),
  getActiveByCodebase: mock(() => Promise.resolve([])),
  getActiveEnvironments: mock(() => Promise.resolve([])),
  countActiveByCodebase: mockCountActiveByCodebase,
}));

// Mock isolation provider
const mockIsolationCreate = mock(() =>
  Promise.resolve({
    id: '/workspace/my-repo/worktrees/task-feat-auth',
    provider: 'worktree',
    workingPath: '/workspace/my-repo/worktrees/task-feat-auth',
    branchName: 'task-feat-auth',
    status: 'active',
    createdAt: new Date(),
    metadata: {},
  })
);
const mockIsolationDestroy = mock(() => Promise.resolve());

mock.module('../isolation', () => ({
  getIsolationProvider: () => ({
    providerType: 'worktree',
    create: mockIsolationCreate,
    destroy: mockIsolationDestroy,
    get: mock(() => Promise.resolve(null)),
    list: mock(() => Promise.resolve([])),
    adopt: mock(() => Promise.resolve(null)),
    healthCheck: mock(() => Promise.resolve(true)),
  }),
}));
mock.module('@archon/isolation', () => ({
  getIsolationProvider: () => ({
    providerType: 'worktree',
    create: mockIsolationCreate,
    destroy: mockIsolationDestroy,
    get: mock(() => Promise.resolve(null)),
    list: mock(() => Promise.resolve([])),
    adopt: mock(() => Promise.resolve(null)),
    healthCheck: mock(() => Promise.resolve(true)),
  }),
  // Loaded transitively via the orchestrator → child-isolation-resolver (PR-A).
  classifyIsolationError: (err: Error) => err.message,
}));

// Mock cleanup service
const mockCleanupMergedWorktrees = mock(() =>
  Promise.resolve({
    removed: [] as string[],
    skipped: [] as { branchName: string; reason: string }[],
  })
);
const mockCleanupStaleWorktrees = mock(() =>
  Promise.resolve({
    removed: [] as string[],
    skipped: [] as { branchName: string; reason: string }[],
  })
);
mock.module('../services/cleanup-service', () => ({
  cleanupMergedWorktrees: mockCleanupMergedWorktrees,
  cleanupStaleWorktrees: mockCleanupStaleWorktrees,
  getWorktreeStatusBreakdown: mock(() =>
    Promise.resolve({ total: 0, active: 0, merged: 0, stale: 0 })
  ),
}));

// Note: We removed mock.module('child_process') because:
// 1. We already spy on gitUtils.execFileAsync which covers git operations
// 2. mock.module('child_process') pollutes other test files that use child_process
//
// We also use spyOn for fs/promises and internal modules to avoid polluting
// other test files (like git.test.ts)

// Mock logger to suppress noisy output during tests
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  captureApprovalResolved: () => undefined,
  createLogger: mock(() => mockLogger),
  getArchonWorkspacesPath: mock(() => '/home/test/.archon/workspaces'),
  getCommandFolderSearchPaths: mock(() => ['.archon/commands']),
  expandTilde: mock((p: string) => p.replace(/^~/, '/home/test')),
  ensureProjectStructure: mock(() => Promise.resolve()),
  getProjectSourcePath: mock(
    (owner: string, repo: string) => `/home/test/.archon/workspaces/${owner}/${repo}/source`
  ),
  createProjectSourceSymlink: mock(() => Promise.resolve()),
  parseOwnerRepo: mock((name: string) => {
    const parts = name.split('/');
    return parts.length === 2 ? { owner: parts[0], repo: parts[1] } : null;
  }),
}));

import { parseCommand, handleCommand } from './command-handler';

// Helper to clear all mocks
function clearAllMocks(): void {
  mockUpdateConversation.mockClear();
  mockGetCodebase.mockClear();
  mockFindCodebaseByDefaultCwd.mockClear();
  mockCreateCodebase.mockClear();
  mockGetCodebaseCommands.mockClear();
  mockUpdateCodebaseCommands.mockClear();
  mockDeleteCodebase.mockClear();
  mockListCodebases.mockClear();
  mockGetActiveSession.mockClear();
  mockDeactivateSession.mockClear();
  // Workflow db mocks
  mockGetActiveWorkflowRun.mockClear();
  mockCancelWorkflowRun.mockClear();
  mockCancelResumableRunsForConversation.mockClear();
  mockListWorkflowRuns.mockClear();
  mockGetWorkflowRun.mockClear();
  mockResumeWorkflowRun.mockClear();
  mockFailWorkflowRun.mockClear();
  mockUpdateWorkflowRun.mockClear();
  mockResolveApprovalGate.mockClear();
  mockResolveAndCancelApprovalGate.mockClear();
  mockCreateWorkflowEvent.mockClear();
  mockDeleteWorkflowNodeSessions.mockClear();
  // Isolation mocks
  mockIsolationCreate.mockClear();
  mockIsolationDestroy.mockClear();
  // Isolation-environments db mocks
  mockIsolationEnvDbCreate.mockClear();
  mockIsolationEnvDbGet.mockClear();
  mockIsolationEnvDbUpdate.mockClear();
  mockGetLiveRunOwningEnv.mockClear();
  // Cleanup service mocks
  mockCleanupMergedWorktrees.mockClear();
  mockCleanupStaleWorktrees.mockClear();
  mockCountActiveByCodebase.mockClear();
}

// Setup spies for internal modules
function setupSpies(): void {
  // Path validation spy
  spyIsPathWithinWorkspace = spyOn(pathValidation, 'isPathWithinWorkspace').mockReturnValue(true);

  // Git utility spies
  spyExecFileAsync = spyOn(gitUtils, 'execFileAsync').mockResolvedValue({ stdout: '', stderr: '' });
  spyWorktreeExists = spyOn(gitUtils, 'worktreeExists').mockResolvedValue(false);
  spyListWorktrees = spyOn(gitUtils, 'listWorktrees').mockResolvedValue([]);
  spyRemoveWorktree = spyOn(gitUtils, 'removeWorktree').mockResolvedValue();
  spyGetWorktreeBase = spyOn(gitUtils, 'getWorktreeBase').mockImplementation(repoPath => ({
    base: join(repoPath, 'worktrees'),
    layout: 'workspace-scoped',
  }));
  spyGetCanonicalRepoPath = spyOn(gitUtils, 'getCanonicalRepoPath').mockImplementation(path =>
    Promise.resolve(gitUtils.toRepoPath(path))
  );
  spyIsWorktreePath = spyOn(gitUtils, 'isWorktreePath').mockResolvedValue(false);
  spyFindWorktreeByBranch = spyOn(gitUtils, 'findWorktreeByBranch').mockResolvedValue(null);
  spyMkdirAsync = spyOn(gitUtils, 'mkdirAsync').mockResolvedValue();

  // fs/promises spies (avoid global mock.module pollution)
  spyFsAccess = spyOn(fsPromises, 'access').mockImplementation(() =>
    Promise.reject(new Error('ENOENT'))
  );
  spyFsMkdir = spyOn(fsPromises, 'mkdir').mockImplementation(() => Promise.resolve(undefined));
  spyFsReaddir = spyOn(fsPromises, 'readdir').mockImplementation(() => Promise.resolve([]));
  spyFsRm = spyOn(fsPromises, 'rm').mockImplementation(() => Promise.resolve());
  spyFsWriteFile = spyOn(fsPromises, 'writeFile').mockImplementation(() =>
    Promise.resolve(undefined)
  );

  // Workflow spies
  spyDiscoverWorkflows = spyOn(workflowDiscovery, 'discoverWorkflowsWithConfig').mockResolvedValue({
    workflows: [],
    errors: [],
  });
}

// Restore all spies
function restoreSpies(): void {
  spyIsPathWithinWorkspace?.mockRestore();
  spyExecFileAsync?.mockRestore();
  spyWorktreeExists?.mockRestore();
  spyListWorktrees?.mockRestore();
  spyRemoveWorktree?.mockRestore();
  spyGetWorktreeBase?.mockRestore();
  spyGetCanonicalRepoPath?.mockRestore();
  spyIsWorktreePath?.mockRestore();
  spyFindWorktreeByBranch?.mockRestore();
  spyMkdirAsync?.mockRestore();
  spyFsAccess?.mockRestore();
  spyFsMkdir?.mockRestore();
  spyFsReaddir?.mockRestore();
  spyFsRm?.mockRestore();
  spyFsWriteFile?.mockRestore();
  spyDiscoverWorkflows?.mockRestore();
}

// The project the `/workflow …` describes attach to via `codebase_id: 'codebase-123'`.
function stubWorkflowCodebase(): void {
  mockGetCodebase.mockResolvedValue(
    makeCodebase({
      id: 'codebase-123',
      repository_url: 'https://github.com/test/repo',
      default_cwd: '/workspace/test-repo',
    })
  );
}

describe('CommandHandler', () => {
  beforeEach(() => {
    clearAllMocks();
    restoreSpies();
    setupSpies();
    delete process.env.WORKSPACE_PATH;
  });

  // Clean up spies after all tests in this file to prevent contamination
  afterAll(() => {
    restoreSpies();
  });

  describe('parseCommand', () => {
    test('should extract command and args from /clone command', () => {
      const result = parseCommand('/clone https://github.com/user/repo');
      expect(result.command).toBe('clone');
      expect(result.args).toEqual(['https://github.com/user/repo']);
    });

    test('should handle commands without args', () => {
      const result = parseCommand('/help');
      expect(result.command).toBe('help');
      expect(result.args).toEqual([]);
    });

    test('should handle /status command', () => {
      const result = parseCommand('/status');
      expect(result.command).toBe('status');
      expect(result.args).toEqual([]);
    });

    test('should handle /setcwd with path containing spaces', () => {
      const result = parseCommand('/setcwd /workspace/my repo');
      expect(result.command).toBe('setcwd');
      expect(result.args).toEqual(['/workspace/my', 'repo']);
    });

    test('should handle /reset command', () => {
      const result = parseCommand('/reset');
      expect(result.command).toBe('reset');
      expect(result.args).toEqual([]);
    });

    test('should handle command with multiple spaces', () => {
      const result = parseCommand('/clone   https://github.com/user/repo  ');
      expect(result.command).toBe('clone');
      expect(result.args).toEqual(['https://github.com/user/repo']);
    });

    test('should handle /getcwd command', () => {
      const result = parseCommand('/getcwd');
      expect(result.command).toBe('getcwd');
      expect(result.args).toEqual([]);
    });

    test('should parse quoted arguments', () => {
      const result = parseCommand('/command-invoke plan "Add dark mode"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add dark mode']);
    });

    test('should parse mixed quoted and unquoted args', () => {
      const result = parseCommand('/command-set test .test.md "Task: $1"');
      expect(result.command).toBe('command-set');
      expect(result.args).toEqual(['test', '.test.md', 'Task: $1']);
    });

    test('should parse /command-set', () => {
      const result = parseCommand('/command-set prime .claude/prime.md');
      expect(result.command).toBe('command-set');
      expect(result.args).toEqual(['prime', '.claude/prime.md']);
    });

    test('should parse /load-commands', () => {
      const result = parseCommand('/load-commands .claude/commands');
      expect(result.command).toBe('load-commands');
      expect(result.args).toEqual(['.claude/commands']);
    });

    test('should handle single quotes', () => {
      const result = parseCommand("/command-invoke plan 'Add dark mode'");
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add dark mode']);
    });

    test('should parse /repos', () => {
      const result = parseCommand('/repos');
      expect(result.command).toBe('repos');
      expect(result.args).toEqual([]);
    });

    test('should parse /repo with number', () => {
      const result = parseCommand('/repo 1');
      expect(result.command).toBe('repo');
      expect(result.args).toEqual(['1']);
    });

    test('should parse /repo with name', () => {
      const result = parseCommand('/repo dylan');
      expect(result.command).toBe('repo');
      expect(result.args).toEqual(['dylan']);
    });

    test('should parse /repo with pull', () => {
      const result = parseCommand('/repo 1 pull');
      expect(result.command).toBe('repo');
      expect(result.args).toEqual(['1', 'pull']);
    });

    test('should parse /repo-remove with number', () => {
      const result = parseCommand('/repo-remove 1');
      expect(result.command).toBe('repo-remove');
      expect(result.args).toEqual(['1']);
    });

    test('should parse /repo-remove with name', () => {
      const result = parseCommand('/repo-remove my-repo');
      expect(result.command).toBe('repo-remove');
      expect(result.args).toEqual(['my-repo']);
    });

    test('should preserve multi-word quoted string as single argument', () => {
      const result = parseCommand('/command-invoke plan "here is the request"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'here is the request']);
      expect(result.args[1]).toBe('here is the request');
    });

    test('should handle long quoted sentences', () => {
      const result = parseCommand(
        '/command-invoke execute "Implement the user authentication feature with JWT tokens"'
      );
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual([
        'execute',
        'Implement the user authentication feature with JWT tokens',
      ]);
    });

    test('should handle multiple quoted arguments', () => {
      const result = parseCommand('/command-invoke test "first arg" "second arg" "third arg"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['test', 'first arg', 'second arg', 'third arg']);
    });

    test('should handle mixed quoted and unquoted with spaces', () => {
      const result = parseCommand('/command-invoke plan "Add feature X" --flag value');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Add feature X', '--flag', 'value']);
    });

    test('should handle quoted arg with special characters', () => {
      const result = parseCommand('/command-invoke plan "Fix bug #123: handle edge case"');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', 'Fix bug #123: handle edge case']);
    });

    test('should handle empty quoted string', () => {
      const result = parseCommand('/command-invoke plan ""');
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', '']);
    });

    test('should unescape quoted workflow suggestions', () => {
      const result = parseCommand(
        '/workflow run test --force "fix \\\\ path \\"quoted\\" \\`tick\\`"'
      );
      expect(result.command).toBe('workflow');
      expect(result.args).toEqual(['run', 'test', '--force', 'fix \\ path "quoted" `tick`']);
    });

    test('should unescape single quoted strings', () => {
      const result = parseCommand("/command-invoke plan 'it\\'s \\\\ ready'");
      expect(result.command).toBe('command-invoke');
      expect(result.args).toEqual(['plan', "it's \\ ready"]);
    });

    test('should return empty command for non-slash-prefixed input (Windows Git Bash path expansion)', () => {
      const result = parseCommand('C:/Program Files/Git/status');
      expect(result.command).toBe('');
      expect(result.args).toEqual([]);
    });

    test('should return empty command for plain word without slash', () => {
      const result = parseCommand('status');
      expect(result.command).toBe('');
      expect(result.args).toEqual([]);
    });
  });

  describe('handleCommand', () => {
    const baseConversation = makeConversation({
      id: 'conv-123',
      platform_conversation_id: 'chat-456',
    });

    // The gate describes below (approve / reject / respond) all run against this one.
    const approveConversation = makeConversation({
      id: 'conv-approve',
      platform_conversation_id: 'chat-approve',
    });

    describe('/help', () => {
      test('should return help message', async () => {
        const result = await handleCommand(baseConversation, '/help');
        expect(result.success).toBe(true);
        expect(result.message).toContain('Archon Orchestrator');
        expect(result.message).toContain('/workflow list');
        expect(result.message).toContain('/status');
      });
    });

    describe('/status', () => {
      test('should show platform and assistant info', async () => {
        const result = await handleCommand(baseConversation, '/status');
        expect(result.success).toBe(true);
        expect(result.message).toContain('telegram');
        expect(result.message).toContain('claude');
      });

      test('should show codebase info when set', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status');
        expect(result.success).toBe(true);
        expect(result.message).toContain('my-repo');
        // cwd is null → the working directory falls back to the project root
        // (issue #1993: web-created project conversations have null cwd).
        expect(result.message).toContain('Working Directory: /workspace/my-repo');
      });

      test('explicit conversation.cwd wins over the codebase default in the working-directory line', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-123',
          cwd: '/explicit/worktree',
        };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status');
        expect(result.success).toBe(true);
        expect(result.message).toContain('Working Directory: /explicit/worktree');
        expect(result.message).not.toContain('Working Directory: /workspace/my-repo');
      });

      test('folder project: shows "(folder — no git)", lists child repos, skips worktrees', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-folder' };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-folder',
            name: 'platform',
            repository_url: null,
            default_cwd: '/tmp/platform',
            kind: 'folder',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);
        const childReposSpy = spyOn(gitUtils, 'listChildRepos').mockResolvedValue([
          'auth-service',
          'billing-service',
        ]);

        try {
          const result = await handleCommand(conversation, '/status');
          expect(result.success).toBe(true);
          expect(result.message).toContain('platform (folder — no git)');
          // Folder projects get the same cwd fallback as repos.
          expect(result.message).toContain('Working Directory: /tmp/platform');
          expect(result.message).toContain('Contains 2 git repos: auth-service, billing-service');
          // Worktree breakdown is skipped for folder projects.
          expect(result.message).not.toContain('Worktrees:');
        } finally {
          childReposSpy.mockRestore();
        }
      });

      test('should show project-less status when no codebase attached', async () => {
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(baseConversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Orchestrator Status');
        expect(result.message).toContain('None — orchestrator will route as needed');
      });

      test('should show no codebase when cwd does not match any codebase', async () => {
        const conversation = { ...baseConversation, cwd: '/workspace/unknown-repo' };

        mockFindCodebaseByDefaultCwd.mockResolvedValue(null);
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('None — orchestrator will route as needed');
      });

      test('should display worktree from isolation_env_id when set', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-worktree',
          isolation_env_id: 'env-123',
        };

        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-worktree',
            name: 'owner/repo',
            repository_url: 'https://github.com/owner/repo',
            default_cwd: '/workspace/repo',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);
        // Mock isolation environment lookup to return worktree branch
        mockIsolationEnvDbGet.mockResolvedValue(
          makeIsolationEnvironment({
            id: 'env-123',
            codebase_id: 'cb-worktree',
            workflow_type: 'issue',
            workflow_id: 'issue-42',
            working_path: '/workspace/repo/worktrees/issue-42',
            branch_name: 'issue-42',
          })
        );

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('owner/repo @ issue-42 (worktree)');
      });

      test('should warn and fallback when isolation_env_id record not found', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-orphaned',
          isolation_env_id: 'env-orphaned', // Points to deleted record
        };

        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-orphaned',
            name: 'owner/orphaned-repo',
            repository_url: 'https://github.com/owner/orphaned-repo',
            default_cwd: '/workspace/orphaned-repo',
          })
        );
        mockGetActiveSession.mockResolvedValue(null);
        // Mock isolation environment lookup returning null (orphaned reference)
        mockIsolationEnvDbGet.mockResolvedValue(null);
        // Mock git branch detection fallback
        spyExecFileAsync.mockResolvedValue({ stdout: 'main\n', stderr: '' });

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        // Should fallback to git branch detection (no worktree marker)
        expect(result.message).toContain('owner/orphaned-repo @ main');
        expect(result.message).not.toContain('(worktree)');
      });
    });

    describe('/reset', () => {
      beforeEach(() => {
        mockCancelResumableRunsForConversation.mockClear();
        mockCancelResumableRunsForConversation.mockImplementation(() => Promise.resolve([]));
        mockUpdateConversation.mockClear();
        mockUpdateConversation.mockImplementation(() => Promise.resolve());
        mockGetWorkflowRun.mockClear();
        mockFindChildRuns.mockClear();
        mockFindChildRuns.mockImplementation(() => Promise.resolve([]));
      });

      test('clears the execution binding but preserves the project attachment', async () => {
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(baseConversation, '/reset');

        expect(result.success).toBe(true);
        // cwd + isolation env go; codebase_id is deliberately absent from the
        // payload — detaching the project is /setproject none's job.
        expect(mockUpdateConversation).toHaveBeenCalledWith(baseConversation.id, {
          cwd: null,
          isolation_env_id: null,
        });
        const [, payload] = mockUpdateConversation.mock.calls[0] as [string, object];
        expect(payload).not.toHaveProperty('codebase_id');
        expect(result.message).toContain('Project attachment preserved');
      });

      test('abandons resumable runs and names the count', async () => {
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockImplementation(() =>
          Promise.resolve([
            makeWorkflowRun({ id: 'run-a', status: 'paused' }),
            makeWorkflowRun({ id: 'run-b', status: 'failed' }),
          ])
        );

        const result = await handleCommand(baseConversation, '/reset');

        expect(mockCancelResumableRunsForConversation).toHaveBeenCalledWith(baseConversation.id);
        // "resumable", not "pending": pending is itself a status name and reads
        // as "waiting" to a user.
        expect(result.message).toContain('Abandoned 2 resumable run(s).');
      });

      test('still reports the abandoned count when clearing the binding fails', async () => {
        // The two effects live in separate try blocks precisely so a failure in
        // the second cannot swallow what the first already did.
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockImplementation(() =>
          Promise.resolve([makeWorkflowRun({ id: 'run-a', status: 'paused' })])
        );
        mockUpdateConversation.mockImplementation(() =>
          Promise.reject(new Error('Conversation not found: conv-123'))
        );

        const result = await handleCommand(baseConversation, '/reset');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Abandoned 1 resumable run(s).');
        expect(result.message).toContain('Could not clear the workspace binding');
        // And it must NOT claim the binding was cleared.
        expect(result.message).not.toContain('Cleared workspace binding');
      });

      test('should deactivate active session', async () => {
        mockGetActiveSession.mockResolvedValue(
          makeSession({
            id: 'session-123',
            codebase_id: 'cb-123',
            assistant_session_id: 'sdk-123',
            active: true,
          })
        );
        mockDeactivateSession.mockResolvedValue(undefined);

        const result = await handleCommand(baseConversation, '/reset');
        expect(result.success).toBe(true);
        expect(result.message).toContain('cleared');
        expect(mockDeactivateSession).toHaveBeenCalledWith('session-123', 'reset-requested');
      });

      test('should handle no active session gracefully', async () => {
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(baseConversation, '/reset');
        expect(result.success).toBe(true);
        expect(result.message).toContain('No active session');
      });

      test('continues run and binding cleanup when the session lookup fails (#2731 R3)', async () => {
        mockGetActiveSession.mockRejectedValueOnce(new Error('session DB unavailable'));
        mockCancelResumableRunsForConversation.mockResolvedValueOnce([
          makeWorkflowRun({ id: 'run-a', status: 'paused' }),
        ]);

        const result = await handleCommand(baseConversation, '/reset');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Could not clear the AI session: session DB unavailable');
        expect(result.message).toContain('Reset is incomplete — retry /reset');
        expect(result.message).not.toContain('next message starts fresh');
        expect(mockCancelResumableRunsForConversation).toHaveBeenCalledWith(baseConversation.id);
        expect(mockUpdateConversation).toHaveBeenCalledWith(baseConversation.id, {
          cwd: null,
          isolation_env_id: null,
        });
      });

      test('continues run and binding cleanup when session deactivation fails (#2731 R3)', async () => {
        mockGetActiveSession.mockResolvedValueOnce(
          makeSession({
            id: 'session-123',
            codebase_id: 'cb-123',
            assistant_session_id: 'sdk-123',
            active: true,
          })
        );
        mockDeactivateSession.mockRejectedValueOnce(new Error('deactivation failed'));

        const result = await handleCommand(baseConversation, '/reset');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Could not clear the AI session: deactivation failed');
        expect(result.message).toContain('Reset is incomplete — retry /reset');
        expect(mockCancelResumableRunsForConversation).toHaveBeenCalledWith(baseConversation.id);
        expect(mockUpdateConversation).toHaveBeenCalledWith(baseConversation.id, {
          cwd: null,
          isolation_env_id: null,
        });
      });

      test('does not claim a fresh start when a selected run cannot be abandoned (#2731 R2)', async () => {
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockRejectedValueOnce(new Error('database busy'));

        const result = await handleCommand(baseConversation, '/reset');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Could not look up resumable runs: database busy');
        expect(result.message).toContain('Reset is incomplete — retry /reset');
        expect(result.message).not.toContain('next message starts fresh');
      });

      test('surfaces a blocked-parent warning when abandoning a child strands its parent (#2731 R1)', async () => {
        // The parent is paused blocked-on-child; abandoning the child leaves
        // the parent stuck. /reset must name the stranded parent so the user
        // knows to resume or abandon it.
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockImplementation(() =>
          Promise.resolve([
            makeWorkflowRun({ id: 'child', parent_run_id: 'parent-stuck', status: 'paused' }),
          ])
        );
        mockGetWorkflowRun.mockImplementation(id => {
          if (id === 'parent-stuck') {
            return Promise.resolve(
              makeWorkflowRun({
                id: 'parent-stuck',
                status: 'paused',
                metadata: {
                  approval: {
                    nodeId: 'workflow',
                    message: 'waiting on sub-run',
                    type: 'child_workflow',
                    childRunId: 'child',
                  },
                },
              })
            );
          }
          return Promise.resolve(null);
        });

        const result = await handleCommand(baseConversation, '/reset');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Parent run parent-stuck was blocked');
        expect(result.message).toContain('stays paused');
        expect(result.message).not.toContain('next message starts fresh');
      });

      test('reports only the final state across a running status gap (#2731 R4)', async () => {
        mockGetActiveSession.mockResolvedValue(null);
        mockCancelResumableRunsForConversation.mockImplementation(() =>
          Promise.resolve([
            makeWorkflowRun({ id: 'run-a', status: 'paused' }),
            makeWorkflowRun({ id: 'run-c', parent_run_id: 'run-b', status: 'paused' }),
          ])
        );
        mockGetWorkflowRun.mockResolvedValue(makeWorkflowRun({ id: 'run-b', status: 'running' }));

        const result = await handleCommand(baseConversation, '/reset');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Abandoned 2 resumable run(s).');
        expect(result.message).not.toContain('Parent run run-b was blocked');
        expect(result.message).not.toContain('sub-run(s) could not be cancelled');
        expect(result.message).toContain('next message starts fresh');
      });
    });

    describe('/init', () => {
      test('uses codebase default cwd when conversation cwd is unset', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-123',
          cwd: null,
        };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
            default_branch: 'main',
          })
        );

        const result = await handleCommand(conversation, '/init');

        expect(result.success).toBe(true);
        expect(spyFsMkdir).toHaveBeenCalledWith(join('/workspace/my-repo', '.archon', 'commands'), {
          recursive: true,
        });
        expect(spyFsWriteFile).toHaveBeenCalledWith(
          join('/workspace/my-repo', '.archon', 'config.yaml'),
          expect.any(String)
        );
      });

      test('returns clear error when no cwd or codebase context exists', async () => {
        const result = await handleCommand(baseConversation, '/init');

        expect(result.success).toBe(false);
        expect(result.message).toContain('No project selected');
        expect(result.message).toContain('/setproject');
      });

      test('explicit conversation.cwd wins over the codebase default', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: 'cb-123',
          cwd: '/explicit/worktree',
        };
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'cb-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
            default_branch: 'main',
          })
        );

        const result = await handleCommand(conversation, '/init');

        expect(result.success).toBe(true);
        expect(spyFsMkdir).toHaveBeenCalledWith(join('/explicit/worktree', '.archon', 'commands'), {
          recursive: true,
        });
      });
    });

    describe('/workflow reset-sessions', () => {
      test('auto-scopes the reset to the current conversation', async () => {
        mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 2 });

        const result = await handleCommand(
          baseConversation,
          '/workflow reset-sessions feature-dev'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Cleared 2');
        expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({
          workflow_name: 'feature-dev',
          scope_key: 'conv-123',
          node_id: undefined,
        });
      });

      test('narrows to a single node when a node id is given', async () => {
        mockDeleteWorkflowNodeSessions.mockResolvedValueOnce({ deleted: 1 });

        await handleCommand(baseConversation, '/workflow reset-sessions feature-dev planner');

        expect(mockDeleteWorkflowNodeSessions).toHaveBeenCalledWith({
          workflow_name: 'feature-dev',
          scope_key: 'conv-123',
          node_id: 'planner',
        });
      });

      test('returns a usage error when the workflow name is missing', async () => {
        const result = await handleCommand(baseConversation, '/workflow reset-sessions');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage');
        expect(mockDeleteWorkflowNodeSessions).not.toHaveBeenCalled();
      });

      test('returns a failure message (does not throw) on DB error', async () => {
        mockDeleteWorkflowNodeSessions.mockRejectedValueOnce(new Error('connection refused'));

        const result = await handleCommand(
          baseConversation,
          '/workflow reset-sessions feature-dev'
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to reset workflow sessions');
      });
    });

    describe('/commands', () => {
      test('should return error without codebase', async () => {
        const result = await handleCommand(baseConversation, '/commands');
        expect(result.success).toBe(false);
        expect(result.message).toContain('No codebase');
      });

      test('should list registered commands', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebaseCommands.mockResolvedValue({
          plan: { path: '.claude/commands/plan.md', description: 'Plan command' },
          execute: { path: '.claude/commands/execute.md', description: 'Execute command' },
        });

        const result = await handleCommand(conversation, '/commands');
        expect(result.success).toBe(true);
        expect(result.message).toContain('plan');
        expect(result.message).toContain('execute');
      });

      test('should show message when no commands registered', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebaseCommands.mockResolvedValue({});

        const result = await handleCommand(conversation, '/commands');
        expect(result.success).toBe(true);
        expect(result.message).toContain('No commands registered');
      });

      test('should handle commands as JSON string from SQLite', async () => {
        const conversation = { ...baseConversation, codebase_id: 'cb-123' };
        mockGetCodebaseCommands.mockResolvedValue({
          plan: { path: '.claude/commands/plan.md', description: 'Plan command' },
        });

        const result = await handleCommand(conversation, '/commands');
        expect(result.success).toBe(true);
        expect(result.message).toContain('plan');
        expect(result.message).not.toContain('undefined');
      });
    });

    describe('unknown command', () => {
      test('should return error for unknown command', async () => {
        const result = await handleCommand(baseConversation, '/unknown');
        expect(result.success).toBe(false);
        expect(result.message).toContain('Unknown command');
        expect(result.message).toContain('/help');
      });
    });

    describe('/worktree', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
        cwd: '/workspace/my-repo',
      });

      beforeEach(() => {
        mockGetCodebase.mockResolvedValue(
          makeCodebase({
            id: 'codebase-123',
            name: 'my-repo',
            repository_url: 'https://github.com/user/my-repo',
            default_cwd: '/workspace/my-repo',
            kind: 'repo',
          })
        );
      });

      test('rejects /worktree on a folder project as not applicable', async () => {
        mockGetCodebase.mockResolvedValueOnce(
          makeCodebase({
            id: 'codebase-123',
            name: 'platform',
            repository_url: null,
            default_cwd: '/tmp/platform',
            kind: 'folder',
          })
        );

        const result = await handleCommand(conversationWithCodebase, '/worktree create feat-x');

        expect(result.success).toBe(false);
        expect(result.message).toContain('not applicable to folder projects');
      });

      describe('create', () => {
        test('should require codebase', async () => {
          const result = await handleCommand(baseConversation, '/worktree create feat-x');
          expect(result.success).toBe(false);
          expect(result.message).toContain('No codebase');
        });

        test('should require branch name', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree create');
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
        });

        test('should validate branch name format', async () => {
          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create "bad name"'
          );
          expect(result.success).toBe(false);
          expect(result.message).toContain('letters, numbers');
        });

        test('should create worktree with valid name', async () => {
          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(null);

          const result = await handleCommand(
            conversationWithCodebase,
            '/worktree create feat-auth'
          );

          expect(result.success).toBe(true);
          expect(result.message).toContain('Worktree created');
          expect(result.message).toContain('task-feat-auth');
          expect(result.message).toMatch(/worktrees[\\\/]task-feat-auth/);
          expect(mockUpdateConversation).toHaveBeenCalled();
          expect(mockIsolationCreate).toHaveBeenCalled();
        });

        test('should reject if already using a worktree (shows working path, not UUID)', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-existing',
          });

          // Mock DB lookup to return the working path for this UUID
          mockIsolationEnvDbGet.mockResolvedValueOnce(
            makeIsolationEnvironment({
              id: 'env-uuid-existing',
              codebase_id: 'codebase-123',
              working_path: '/workspace/my-repo/worktrees/existing-branch',
              branch_name: 'existing-branch',
            })
          );

          const result = await handleCommand(convWithWorktree, '/worktree create new-branch');

          expect(result.success).toBe(false);
          expect(result.message).toContain('Already using worktree');
          expect(result.message).toMatch(/worktrees[\\\/]existing-branch/);
          expect(result.message).not.toContain('env-uuid-existing');
          expect(result.message).toContain('/worktree remove first');
        });

        test('should fallback to UUID when isolation env not found in DB', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-orphaned',
          });

          // DB lookup returns null (orphaned reference)
          mockIsolationEnvDbGet.mockResolvedValueOnce(null);

          const result = await handleCommand(convWithWorktree, '/worktree create new-branch');

          expect(result.success).toBe(false);
          expect(result.message).toContain('Already using worktree');
          expect(result.message).toContain('env-uuid-orphaned');
        });
      });

      describe('list', () => {
        test('should list worktrees', async () => {
          spyExecFileAsync.mockResolvedValue({
            stdout:
              '/workspace/my-repo  abc1234 [main]\n/workspace/my-repo/worktrees/feat-x  def5678 [feat-x]\n',
            stderr: '',
          });
          spyListWorktrees.mockResolvedValue([
            { path: '/workspace/my-repo', branch: 'main' },
            { path: '/workspace/my-repo/worktrees/feat-x', branch: 'feat-x' },
          ]);

          const result = await handleCommand(conversationWithCodebase, '/worktree list');

          expect(result.success).toBe(true);
          expect(result.message).toContain('Worktrees:');
          expect(result.message).toContain('main');
          expect(result.message).toContain('abc1234 [main]');
          expect(result.message).toMatch(/worktrees[\\\/]feat-x/);
        });
      });

      describe('remove', () => {
        const featXEnv = makeIsolationEnvironment({
          id: 'env-uuid-feat-x',
          codebase_id: 'codebase-123',
          workflow_id: 'task-feat-x',
          working_path: '/workspace/my-repo/worktrees/feat-x',
          branch_name: 'feat-x',
        });

        test('should require active worktree', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree remove');
          expect(result.success).toBe(false);
          expect(result.message).toContain('not using a worktree');
        });

        test('should remove worktree and switch to main', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x', // Use UUID-like ID
          });

          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);

          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(null);

          const result = await handleCommand(convWithWorktree, '/worktree remove');

          expect(result.success).toBe(true);
          expect(result.message).toContain('removed');
          expect(result.message).toMatch(/worktrees[\\\/]feat-x/);
          expect(mockUpdateConversation).toHaveBeenCalled();
        });

        test('should deactivate session with worktree-removed reason', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x',
          });

          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);

          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(makeSession({ id: 'session-789', active: true }));
          mockDeactivateSession.mockResolvedValue(undefined);

          const result = await handleCommand(convWithWorktree, '/worktree remove');

          expect(result.success).toBe(true);
          expect(mockDeactivateSession).toHaveBeenCalledWith('session-789', 'worktree-removed');
        });

        test('refuses to remove a worktree owned by a live workflow run', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x',
          });
          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);
          mockGetLiveRunOwningEnv.mockResolvedValue({ id: 'run-live-1234', status: 'paused' });

          const result = await handleCommand(convWithWorktree, '/worktree remove');

          expect(result.success).toBe(false);
          expect(result.message).toContain('run-live');
          expect(result.message).toContain('paused');
          expect(mockGetLiveRunOwningEnv).toHaveBeenCalledWith('env-uuid-feat-x');
          expect(mockIsolationDestroy).not.toHaveBeenCalled();
          expect(mockIsolationEnvDbUpdate).not.toHaveBeenCalled();
          expect(mockUpdateConversation).not.toHaveBeenCalled();
        });

        test('refuses forced removal of a worktree owned by a live workflow run', async () => {
          const convWithWorktree = makeConversation({
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x',
          });
          mockIsolationEnvDbGet.mockResolvedValue(featXEnv);
          mockGetLiveRunOwningEnv.mockResolvedValue({ id: 'run-live-1234', status: 'paused' });

          const result = await handleCommand(convWithWorktree, '/worktree remove --force');

          expect(result.success).toBe(false);
          expect(result.message).toContain('run-live');
          expect(result.message).toContain('paused');
          expect(mockGetLiveRunOwningEnv).toHaveBeenCalledWith('env-uuid-feat-x');
          expect(mockIsolationDestroy).not.toHaveBeenCalled();
          expect(mockIsolationEnvDbUpdate).not.toHaveBeenCalled();
          expect(mockUpdateConversation).not.toHaveBeenCalled();
        });
      });

      describe('default', () => {
        test('should show usage for unknown subcommand', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree foo');
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
        });
      });

      describe('cleanup', () => {
        test('should return usage for missing cleanup type', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree cleanup');
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
          expect(result.message).toContain('merged');
          expect(result.message).toContain('stale');
        });

        test('should return usage for invalid cleanup type', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree cleanup foo');
          expect(result.success).toBe(false);
          expect(result.message).toContain('Usage');
        });

        test('should report merged worktree cleanup results', async () => {
          mockCleanupMergedWorktrees.mockResolvedValueOnce({
            removed: ['feat-old', 'feat-done'],
            skipped: [{ branchName: 'feat-protected', reason: 'has uncommitted changes' }],
          });
          mockCountActiveByCodebase.mockResolvedValueOnce(3);

          const result = await handleCommand(conversationWithCodebase, '/worktree cleanup merged');

          expect(result.success).toBe(true);
          expect(result.message).toContain('Cleaned up 2 merged worktree(s)');
          expect(result.message).toContain('feat-old');
          expect(result.message).toContain('feat-done');
          expect(result.message).toContain('Skipped 1 (protected)');
          expect(result.message).toContain('feat-protected');
          expect(result.message).toContain('Active worktrees: 3');
        });

        test('should report when no stale worktrees to clean up', async () => {
          mockCleanupStaleWorktrees.mockResolvedValueOnce({
            removed: [],
            skipped: [],
          });
          mockCountActiveByCodebase.mockResolvedValueOnce(1);

          const result = await handleCommand(conversationWithCodebase, '/worktree cleanup stale');

          expect(result.success).toBe(true);
          expect(result.message).toContain('No stale worktrees to clean up');
        });
      });
    });

    describe('/workflow list', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should show load errors alongside workflows', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [makeTestWorkflowWithSource({ name: 'assist' })],
          errors: [
            {
              filename: 'broken.yaml',
              error: 'YAML parse error: unexpected token',
              errorType: 'parse_error' as const,
            },
          ],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow list');

        expect(result.success).toBe(true);
        expect(result.message).toContain('assist');
        expect(result.message).toContain('1 workflow(s) failed to load');
        expect(result.message).toContain('broken.yaml');
        expect(result.message).toContain('YAML parse error');
      });

      test('should show only errors when no workflows loaded', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [],
          errors: [
            {
              filename: 'bad.yaml',
              error: "Missing required field 'name'",
              errorType: 'validation_error' as const,
            },
          ],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow list');

        expect(result.success).toBe(true);
        expect(result.message).toContain('1 workflow(s) failed to load');
        expect(result.message).toContain('bad.yaml');
      });

      test('should truncate errors at 10 and show count', async () => {
        const errors = Array.from({ length: 15 }, (_, i) => ({
          filename: `broken-${String(i)}.yaml`,
          error: `Error in file ${String(i)}`,
          errorType: 'parse_error' as const,
        }));

        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [],
          errors,
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow list');

        expect(result.success).toBe(true);
        expect(result.message).toContain('15 workflow(s) failed to load');
        expect(result.message).toContain('broken-0.yaml');
        expect(result.message).toContain('broken-9.yaml');
        expect(result.message).not.toContain('broken-10.yaml');
        expect(result.message).toContain('and 5 more');
      });

      test('should pass loadConfig as second argument to discoverWorkflowsWithConfig', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [makeTestWorkflowWithSource({ name: 'test-wf', description: 'Test' })],
          errors: [],
        });

        await handleCommand(conversationWithCodebase, '/workflow list');

        // Verify loadConfig function is passed as the second argument
        expect(spyDiscoverWorkflows).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
      });

      // #2213 — chat is the surface most non-CLI authors use; a silently
      // dropped key (e.g. an `interactive:` they believe is a gate) has to
      // reach the conversation, not only `archon validate workflows`.
      test('should show parse warnings inline with the workflow that raised them', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'clean' }),
            makeTestWorkflowWithSource({ name: 'gated' }, 'project', [
              "Node 'plan': unknown key 'interactive' will be ignored.",
            ]),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow list');

        expect(result.success).toBe(true);
        expect(result.message).toContain("unknown key 'interactive' will be ignored");
        // Rendered under `gated`, not under `clean` — the author must be able to
        // tell which workflow is affected without cross-referencing.
        const gatedIdx = result.message.indexOf('`gated`');
        const warningIdx = result.message.indexOf("unknown key 'interactive'");
        expect(gatedIdx).toBeGreaterThan(-1);
        expect(warningIdx).toBeGreaterThan(gatedIdx);
      });
    });

    describe('/workflow reload', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should show error count on reload', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'assist', description: 'General assistant' }),
          ],
          errors: [
            {
              filename: 'broken.yaml',
              error: 'YAML parse error',
              errorType: 'parse_error' as const,
            },
            {
              filename: 'invalid.yml',
              error: "Missing 'nodes'",
              errorType: 'validation_error' as const,
            },
          ],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow reload');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Discovered 1 workflow(s)');
        expect(result.message).toContain('2 failed to load');
        expect(result.message).toContain('broken.yaml');
        expect(result.message).toContain('invalid.yml');
      });

      test('should show clean reload when no errors', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'assist', description: 'General assistant' }),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow reload');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Discovered 1 workflow(s)');
        expect(result.message).not.toContain('failed to load');
      });
    });

    describe('/workflow run with load errors', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should show load error when workflow failed to parse', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [],
          errors: [
            {
              filename: 'fix-issue.yaml',
              error: 'YAML parse error near line 5',
              errorType: 'parse_error' as const,
            },
          ],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow run fix-issue');

        expect(result.success).toBe(false);
        expect(result.message).toContain('failed to load');
        expect(result.message).toContain('YAML parse error near line 5');
      });

      test('should match workflow name case-insensitively', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'assist', description: 'General assistant' }),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow run Assist');

        expect(result.success).toBe(true);
        expect(result.workflow?.definition.name).toBe('assist');
      });

      // #2213 — the run path, not just `/workflow list`. Chat and the console
      // both start runs through here; discarding parseWarnings meant the author
      // saw a warning while browsing and silence at the moment of consequence.
      test('should carry parse warnings on the run result', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'clean' }),
            makeTestWorkflowWithSource({ name: 'gated' }, 'project', [
              "Node 'plan': unknown key 'interactive' will be ignored.",
            ]),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow run gated');

        expect(result.success).toBe(true);
        expect(result.workflow?.definition.name).toBe('gated');
        expect(result.workflow?.parseWarnings).toEqual([
          "Node 'plan': unknown key 'interactive' will be ignored.",
        ]);
      });

      test('should omit parse warnings for a clean workflow', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'clean' }),
            // A DIFFERENT workflow's warnings must not attach to this run.
            makeTestWorkflowWithSource({ name: 'gated' }, 'project', ["dropped 'interactive'"]),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow run clean');

        expect(result.success).toBe(true);
        expect(result.workflow?.parseWarnings).toBeUndefined();
      });

      test('should match workflow name via suffix match', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'archon-assist', description: 'General assistant' }),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow run assist');

        expect(result.success).toBe(true);
        expect(result.workflow?.definition.name).toBe('archon-assist');
      });

      test('should match workflow name via substring match', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({
              name: 'archon-smart-pr-review',
              description: 'Smart PR review',
            }),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow run smart');

        expect(result.success).toBe(true);
        expect(result.workflow?.definition.name).toBe('archon-smart-pr-review');
      });

      test('should return failure with candidates on ambiguous suffix match', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'archon-review', description: 'Review' }),
            makeTestWorkflowWithSource({ name: 'custom-review', description: 'Custom review' }),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow run review');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Ambiguous workflow');
        expect(result.message).toContain('archon-review');
        expect(result.message).toContain('custom-review');
      });
    });

    describe('/workflow cancel', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should cancel active workflow and return success message', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'wf-123',
            workflow_name: 'test-workflow',
            user_message: 'test',
            last_activity_at: new Date(),
          })
        );

        const result = await handleCommand(conversationWithCodebase, '/workflow cancel');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Cancelled workflow');
        expect(result.message).toContain('test-workflow');
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith('wf-123');
      });

      test('should return message when no active workflow exists', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(conversationWithCodebase, '/workflow cancel');

        expect(result.success).toBe(true);
        expect(result.message).toBe('No active workflow to cancel.');
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      });

      test('should return no-active-workflow when no codebase is configured', async () => {
        const result = await handleCommand(baseConversation, '/workflow cancel');

        expect(result.success).toBe(true);
        expect(result.message).toBe('No active workflow to cancel.');
      });
    });

    describe('/workflow status', () => {
      test('should show all running workflows', async () => {
        const startedAt = new Date(Date.now() - 2 * 60 * 1000);
        mockListWorkflowRuns.mockResolvedValueOnce([
          makeWorkflowRun({
            id: 'run-abc123',
            workflow_name: 'implement',
            conversation_id: 'conv-1',
            user_message: 'add feature',
            started_at: startedAt,
            last_activity_at: startedAt,
            working_path: '/workspace/worktrees/feat-auth',
          }),
        ]);

        const result = await handleCommand(baseConversation, '/workflow status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('implement');
        expect(result.message).toContain('run-abc123');
        expect(result.message).toContain('/workspace/worktrees/feat-auth');
      });

      test('should show no-active message when no workflows running', async () => {
        mockListWorkflowRuns.mockResolvedValueOnce([]);

        const result = await handleCommand(baseConversation, '/workflow status');

        expect(result.success).toBe(true);
        expect(result.message).toBe('No active workflows.');
      });

      test('should handle database errors gracefully', async () => {
        mockListWorkflowRuns.mockRejectedValueOnce(new Error('Database connection error'));

        const result = await handleCommand(baseConversation, '/workflow status');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to retrieve workflow status');
      });

      test('should show working_path as (unknown) when null', async () => {
        const startedAt = new Date();
        mockListWorkflowRuns.mockResolvedValueOnce([
          makeWorkflowRun({
            id: 'run-xyz',
            workflow_name: 'assist',
            conversation_id: 'conv-1',
            user_message: 'help',
            started_at: startedAt,
            working_path: null,
          }),
        ]);

        const result = await handleCommand(baseConversation, '/workflow status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('(unknown)');
      });
    });

    describe('/workflow resume', () => {
      test('should return workflow dispatch data for failed run resume', async () => {
        const run = makeWorkflowRun({
          id: 'run-123',
          workflow_name: 'implement',
          conversation_id: 'conv-1',
          status: 'failed' as const,
          user_message: 'test',
          working_path: '/workspace/wt',
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'implement', description: 'Implement changes' }),
          ],
          errors: [],
        });

        const result = await handleCommand(baseConversation, '/workflow resume run-123');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Resuming workflow: `implement`');
        expect(result.workflow?.definition.name).toBe('implement');
        expect(result.workflow?.args).toBe('test');
        expect(result.workflow?.resumeRunId).toBe('run-123');
      });

      test('should accept already-failed run without status change', async () => {
        const run = makeWorkflowRun({
          id: 'run-456',
          workflow_name: 'plan',
          conversation_id: 'conv-1',
          status: 'failed' as const,
          user_message: 'test',
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run);
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [makeTestWorkflowWithSource({ name: 'plan', description: 'Plan changes' })],
          errors: [],
        });

        const result = await handleCommand(baseConversation, '/workflow resume run-456');

        expect(result.success).toBe(true);
        expect(result.workflow?.resumeRunId).toBe('run-456');
        // Already failed — no status change needed
        expect(mockFailWorkflowRun).not.toHaveBeenCalled();
      });

      test('should return error when workflow definition is unavailable', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-missing-workflow',
            workflow_name: 'missing-workflow',
            conversation_id: 'conv-1',
            status: 'failed' as const,
            user_message: 'test',
          })
        );
        spyDiscoverWorkflows.mockResolvedValueOnce({ workflows: [], errors: [] });

        const result = await handleCommand(
          baseConversation,
          '/workflow resume run-missing-workflow'
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('was not found');
        expect(result.workflow).toBeUndefined();
      });

      test('should surface workflow load errors before not found during resume', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-bad-workflow',
            workflow_name: 'bad-workflow',
            conversation_id: 'conv-1',
            status: 'failed' as const,
            user_message: 'test',
            working_path: '/workspace/wt',
          })
        );
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [],
          errors: [
            {
              filename: 'bad-workflow.yaml',
              error: 'Invalid workflow YAML',
              errorType: 'parse_error',
            },
          ],
        });

        const result = await handleCommand(baseConversation, '/workflow resume run-bad-workflow');

        expect(result.success).toBe(false);
        expect(result.message).toContain(
          'Workflow `bad-workflow` failed to load: Invalid workflow YAML'
        );
        expect(result.message).toContain('Fix the YAML file and try again');
        expect(result.workflow).toBeUndefined();
      });

      test('should reject resume of non-resumable run', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-789',
            workflow_name: 'assist',
            conversation_id: 'conv-1',
            status: 'running' as const,
            user_message: 'test',
          })
        );

        const result = await handleCommand(baseConversation, '/workflow resume run-789');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Cannot resume');
        expect(mockResumeWorkflowRun).not.toHaveBeenCalled();
      });

      test('should return error when run not found', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(baseConversation, '/workflow resume nonexistent');

        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
      });

      test('should return usage when no id provided', async () => {
        const result = await handleCommand(baseConversation, '/workflow resume');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage: /workflow resume <id>');
      });

      test('should handle DB error on resume gracefully', async () => {
        mockGetWorkflowRun.mockRejectedValueOnce(new Error('DB down'));

        const result = await handleCommand(baseConversation, '/workflow resume run-err');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to resume');
      });
    });

    describe('/workflow abandon', () => {
      test('should abandon a running run', async () => {
        const run = makeWorkflowRun({
          id: 'run-123',
          workflow_name: 'implement',
          conversation_id: 'conv-1',
          status: 'running' as const,
          user_message: 'test',
        });
        mockGetWorkflowRun.mockResolvedValueOnce(run);

        const result = await handleCommand(baseConversation, '/workflow abandon run-123');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Abandoned');
        expect(result.message).toContain('implement');
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-123');
        // The cascade walk must actually run against the mock, not merely be
        // survived. cascadeCancelChildren swallows its own errors into a failure
        // count, so a cascade that is broken — or one silently talking to a real
        // database — still reports "Abandoned"; the only visible tell is this
        // warning suffix. Assert both halves so the stub cannot regress unnoticed.
        expect(result.message).not.toContain('could not be cancelled');
        expect(mockFindChildRuns).toHaveBeenCalledWith('run-123');
      });

      test('should reject abandon of already-terminal run', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-done',
            workflow_name: 'assist',
            conversation_id: 'conv-1',
            status: 'completed' as const,
            user_message: 'test',
            completed_at: new Date(),
          })
        );

        const result = await handleCommand(baseConversation, '/workflow abandon run-done');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Cannot abandon');
        expect(mockFailWorkflowRun).not.toHaveBeenCalled();
      });

      test('should return error when run not found', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(baseConversation, '/workflow abandon nonexistent');

        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
      });

      test('should return usage when no id provided', async () => {
        const result = await handleCommand(baseConversation, '/workflow abandon');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage: /workflow abandon <id>');
      });

      test('should handle DB error on abandon gracefully', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-err',
            workflow_name: 'implement',
            conversation_id: 'conv-1',
            status: 'running' as const,
            user_message: 'test',
          })
        );
        mockCancelWorkflowRun.mockRejectedValueOnce(new Error('DB down'));

        const result = await handleCommand(baseConversation, '/workflow abandon run-err');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to abandon');
      });
    });

    describe('/workflow run', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should return error when no workflow name is provided', async () => {
        const result = await handleCommand(conversationWithCodebase, '/workflow run');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Usage: /workflow run <name>');
        expect(result.message).toContain('/workflow list');
      });

      test('should return error when workflow is not found', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({
              name: 'existing-workflow',
              description: 'An existing workflow',
            }),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow run nonexistent');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Workflow `nonexistent` not found');
        expect(result.message).toContain('/workflow list');
      });

      test('should return success with workflow info when workflow is found', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'test-workflow', description: 'A test workflow' }),
          ],
          errors: [],
        });

        const result = await handleCommand(conversationWithCodebase, '/workflow run test-workflow');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Starting workflow: `test-workflow`');
        expect(result.workflow).toBeDefined();
        expect(result.workflow?.definition.name).toBe('test-workflow');
        expect(result.workflow?.args).toBe('');
      });

      test('should pass arguments to workflow', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'fix-issue', description: 'Fix a GitHub issue' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run fix-issue #42 add dark mode'
        );

        expect(result.success).toBe(true);
        expect(result.workflow).toBeDefined();
        expect(result.workflow?.definition.name).toBe('fix-issue');
        expect(result.workflow?.args).toBe('#42 add dark mode');
      });

      test('should parse --force after workflow name and strip it from args', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'test-workflow', description: 'A test workflow' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run test-workflow --force do it'
        );

        expect(result.success).toBe(true);
        expect(result.workflow?.force).toBe(true);
        expect(result.workflow?.args).toBe('do it');
      });

      test('should parse --force anywhere in workflow args and strip it', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'test-workflow', description: 'A test workflow' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run test-workflow do --force it'
        );

        expect(result.success).toBe(true);
        expect(result.workflow?.force).toBe(true);
        expect(result.workflow?.args).toBe('do it');
      });

      test('should leave force unset when --force is absent', async () => {
        spyDiscoverWorkflows.mockResolvedValueOnce({
          workflows: [
            makeTestWorkflowWithSource({ name: 'test-workflow', description: 'A test workflow' }),
          ],
          errors: [],
        });

        const result = await handleCommand(
          conversationWithCodebase,
          '/workflow run test-workflow do it'
        );

        expect(result.success).toBe(true);
        expect(result.workflow?.force).toBeUndefined();
        expect(result.workflow?.args).toBe('do it');
      });

      test('should return not-found when no codebase is configured', async () => {
        const result = await handleCommand(baseConversation, '/workflow run test-workflow');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Workflow `test-workflow` not found');
      });
    });

    describe('/workflow help text', () => {
      const conversationWithCodebase = makeConversation({
        ...baseConversation,
        codebase_id: 'codebase-123',
      });

      beforeEach(() => {
        stubWorkflowCodebase();
      });

      test('should show run command in workflow usage help', async () => {
        const result = await handleCommand(conversationWithCodebase, '/workflow invalid');

        expect(result.success).toBe(false);
        expect(result.message).toContain('/workflow run');
      });

      test('should show status in workflow usage help', async () => {
        const result = await handleCommand(conversationWithCodebase, '/workflow invalid');

        expect(result.success).toBe(false);
        expect(result.message).toContain('/workflow status');
      });
    });

    describe('/status with active workflow', () => {
      test('should show active workflow info in status', async () => {
        const startedAt = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes ago
        const lastActivity = new Date(Date.now() - 10 * 1000); // 10 seconds ago
        mockGetActiveWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'wf-active-123',
            workflow_name: 'investigate-issue',
            started_at: startedAt,
            user_message: 'test',
            last_activity_at: lastActivity,
          })
        );

        const result = await handleCommand(baseConversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Active Workflow: `investigate-issue`');
        expect(result.message).toContain('Cancel: `/workflow cancel`');
      });

      test('should not show workflow section when no workflow running', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(baseConversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).not.toContain('Active Workflow');
      });

      test('should show active workflow info in status without stale warnings', async () => {
        const startedAt = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
        const lastActivity = new Date(Date.now() - 7 * 60 * 1000); // 7 minutes ago
        mockGetActiveWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'wf-active',
            workflow_name: 'long-workflow',
            started_at: startedAt,
            user_message: 'test',
            last_activity_at: lastActivity,
          })
        );

        const result = await handleCommand(baseConversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Active Workflow');
        expect(result.message).toContain('long-workflow');
        expect(result.message).not.toContain('possibly stale');
      });

      test('should gracefully handle workflow database errors in status', async () => {
        mockGetActiveWorkflowRun.mockRejectedValueOnce(new Error('Database connection error'));

        const result = await handleCommand(baseConversation, '/status');

        // Status should still succeed, just without workflow info
        expect(result.success).toBe(true);
        expect(result.message).toContain('telegram'); // Basic info still present
        expect(result.message).not.toContain('Active Workflow');
      });

      test('should handle invalid workflow date data gracefully in status', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'wf-invalid-dates',
            workflow_name: 'corrupted-workflow',
            started_at: new Date(Number.NaN),
            user_message: 'test',
          })
        );

        const result = await handleCommand(baseConversation, '/status');

        expect(result.success).toBe(true);
        // Should still show workflow name
        expect(result.message).toContain('corrupted-workflow');
      });
    });

    describe('/workflow approve — interactive_loop branch', () => {
      test('routes to interactive_loop branch and stores loop_user_input', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-123',
            workflow_name: 'my-loop-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'build it',
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'refine',
                iteration: 2,
                message: 'Review the output',
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow approve run-123 Add error handling'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('loop input received');
        expect(result.message).toContain('my-loop-wf');
        // Stays 'paused' (no status write) — resolution rides the approval context,
        // stamped atomically via the CAS (#2075/#2113), with the audit event in the
        // same transaction (#2146)
        expect(mockResolveApprovalGate).toHaveBeenCalledWith(
          'run-123',
          {
            approval: {
              type: 'interactive_loop',
              nodeId: 'refine',
              iteration: 2,
              message: 'Review the output',
              resolved: 'approved',
            },
            loop_user_input: 'Add error handling',
            // A real comment counts as feedback ⇒ the resumed loop iterates (#2074)
            loop_feedback_given: true,
          },
          [
            {
              event_type: 'approval_received',
              step_name: 'refine',
              data: { decision: 'approved', comment: 'Add error handling', iteration: 2 },
            },
          ]
        );
      });

      test('creates approval_received event (not node_completed) for interactive_loop', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-456',
            workflow_name: 'loop-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'implement',
                iteration: 1,
                message: 'Review iteration output',
              },
            },
            last_activity_at: new Date(),
          })
        );

        await handleCommand(approveConversation, '/workflow approve run-456 LGTM');

        // The audit events ride the CAS transaction now (#2146), not a separate
        // createWorkflowEvent write. node_completed should NOT be written by the
        // approve command — only the executor writes it when the AI emits the
        // completion signal (actual loop exit).
        expect(mockCreateWorkflowEvent).not.toHaveBeenCalled();
        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        expect(casEvents.filter(e => e.event_type === 'node_completed')).toHaveLength(0);
        expect(casEvents).toContainEqual(
          expect.objectContaining({ event_type: 'approval_received' })
        );
      });

      test('bare approve (no comment) passes undefined through — finalize-eligible (#2074)', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-bare',
            workflow_name: 'loop-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'interactive_loop',
                nodeId: 'validate',
                iteration: 1,
                message: 'gate',
                completionSignaled: true,
                signaledOutput: 'REPORT',
              },
            },
            last_activity_at: new Date(),
          })
        );

        const result = await handleCommand(approveConversation, '/workflow approve run-bare');

        expect(result.success).toBe(true);
        // The chat handler must NOT pre-default the comment to 'Approved' —
        // loop_feedback_given derives from the raw comment, and a masked
        // no-feedback would make every chat approve iterate instead of finalize.
        expect(mockResolveApprovalGate).toHaveBeenCalledWith(
          'run-bare',
          expect.objectContaining({
            loop_feedback_given: false,
            loop_user_input: 'Approved',
          }),
          // Audit events ride the CAS transaction (#2146); metadata is the focus here.
          expect.any(Array)
        );
      });

      test('returns error when run is not paused', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-789',
            workflow_name: 'loop-wf',
            conversation_id: 'conv-approve',
            status: 'running',
            user_message: 'start',
            last_activity_at: new Date(),
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow approve run-789 feedback'
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('paused');
      });

      test('returns error when run not found', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(
          approveConversation,
          '/workflow approve missing-run feedback'
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
      });
    });

    // A gate decision that does not continue the run leaves it stranded (#2565).
    // Before #2565 these commands told the user to "type your response to
    // resume", which relied on a natural-language branch that no longer exists.
    describe('/workflow approve|reject — run continuation', () => {
      function pausedRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
        return makeWorkflowRun({
          id: 'run-gate',
          workflow_name: 'gated-wf',
          conversation_id: 'conv-approve',
          status: 'paused' as const,
          user_message: 'original prompt',
          metadata: { approval: { type: 'approval', nodeId: 'review', message: 'Approve?' } },
          last_activity_at: new Date(),
          working_path: '/repo',
          ...overrides,
        });
      }

      /** The gate op reads the run, then the continuation reads it again. */
      function stubRunReads(run: ReturnType<typeof pausedRun>): void {
        mockGetWorkflowRun.mockResolvedValueOnce(run).mockResolvedValueOnce(run);
      }

      function stubWorkflowDiscovery(): void {
        spyDiscoverWorkflows?.mockResolvedValue({
          workflows: [makeTestWorkflowWithSource({ name: 'gated-wf' })],
          errors: [],
        });
      }

      test('approve hands the orchestrator the resume payload for the same run', async () => {
        const run = pausedRun();
        stubRunReads(run);
        stubWorkflowDiscovery();

        const result = await handleCommand(approveConversation, '/workflow approve run-gate LGTM');

        expect(result.success).toBe(true);
        expect(result.message).toContain('approved');
        expect(result.message).toContain('Resuming');
        expect(result.workflow?.resumeRunId).toBe('run-gate');
        expect(result.workflow?.resumeRun).toBe(run);
        expect(result.workflow?.definition.name).toBe('gated-wf');
        // The run's own prompt drives the resume, not the approve comment.
        expect(result.workflow?.args).toBe('original prompt');
      });

      test('reject with an on_reject rework hands back the resume payload', async () => {
        const run = pausedRun({
          metadata: {
            approval: {
              type: 'approval',
              nodeId: 'review',
              message: 'Approve?',
              onRejectPrompt: 'Address $REJECTION_REASON',
            },
          },
        });
        stubRunReads(run);
        stubWorkflowDiscovery();

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-gate schema is wrong'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Reworking');
        expect(result.workflow?.resumeRunId).toBe('run-gate');
      });

      test('reject that cancels the run hands back nothing to resume', async () => {
        // No on_reject prompt ⇒ the run is cancelled, which IS its terminal
        // state — a resume payload here would try to restart a dead run.
        mockGetWorkflowRun.mockResolvedValueOnce(pausedRun());

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-gate no thanks'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('rejected and cancelled');
        expect(result.workflow).toBeUndefined();
      });

      test('a container run is resolved but points at the CLI instead of resuming', async () => {
        // Chat cannot rewire the container, so dispatching a resume would fail
        // the run to say what this message says for free.
        const run = pausedRun({ metadata: { ...pausedRun().metadata, isolation: 'container' } });
        stubRunReads(run);
        stubWorkflowDiscovery();

        const result = await handleCommand(approveConversation, '/workflow approve run-gate');

        expect(result.success).toBe(true);
        expect(result.message).toContain('approved');
        expect(result.message).toContain('isolation container');
        expect(result.message).toContain('archon workflow resume run-gate');
        expect(result.message).not.toContain('/workflow resume run-gate');
        expect(result.workflow).toBeUndefined();
      });

      test('an unresolvable continuation still reports the decision as recorded', async () => {
        const run = pausedRun();
        stubRunReads(run);
        // The workflow YAML is gone, so the run cannot be continued.
        spyDiscoverWorkflows?.mockResolvedValue({ workflows: [], errors: [] });

        const result = await handleCommand(approveConversation, '/workflow approve run-gate');

        // success:false would send the user to re-approve a gate that is already
        // resolved — and the second approve throws.
        expect(result.success).toBe(true);
        expect(result.message).toContain('approved');
        expect(result.message).toContain('could not be continued automatically');
        expect(result.message).toContain('/workflow resume run-gate');
        expect(result.workflow).toBeUndefined();
      });
    });

    describe('/workflow approve — standard approval node with captureResponse', () => {
      test('bare gate with captureResponse but no decisionsAuthored keeps plain-text output (R2 fix — #2707)', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-cap',
            workflow_name: 'capture-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                captureResponse: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(approveConversation, '/workflow approve run-cap LGTM looks good');

        // node_completed rides the CAS transaction now (#2146), not a direct write.
        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: { node_output: 'LGTM looks good', approval_decision: 'approved' },
        });
        expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
      });

      test('bare gate with no captureResponse set — empty output, unaffected by #2707', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-nocap',
            workflow_name: 'nocapture-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(approveConversation, '/workflow approve run-nocap a comment');

        // node_completed rides the CAS transaction now (#2146), not a direct write.
        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: { node_output: '', approval_decision: 'approved' },
        });
        expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
      });

      test('new-mode gate (decisionsAuthored) produces structured output (#2707)', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-new-mode',
            workflow_name: 'new-mode-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                decisions: [{ id: 'approve' }, { id: 'reject' }],
                decisionsAuthored: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(approveConversation, '/workflow approve run-new-mode a comment');

        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: {
            node_output: JSON.stringify({ decision: 'approve', text: 'a comment' }),
            approval_decision: 'approved',
            structured_output: { decision: 'approve', text: 'a comment' },
          },
        });
      });

      test('/workflow respond resolves a declared non-default decision (#2707 step 2)', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-respond',
            workflow_name: 'respond-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                decisions: [{ id: 'approve' }, { id: 'revise' }, { id: 'escalate' }],
                decisionsAuthored: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(approveConversation, '/workflow respond run-respond revise needs work');

        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: {
            node_output: JSON.stringify({ decision: 'revise', text: 'needs work' }),
            approval_decision: 'revise',
            structured_output: { decision: 'revise', text: 'needs work' },
          },
        });
      });

      test('/workflow respond approve delegates to the exact approve resolution', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-respond-approve',
            workflow_name: 'respond-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                decisions: [{ id: 'approve' }, { id: 'revise' }],
                decisionsAuthored: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(
          approveConversation,
          '/workflow respond run-respond-approve approve lgtm'
        );

        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: { structured_output: { decision: 'approve', text: 'lgtm' } },
        });
      });

      test('/workflow respond rejects a decision the gate does not declare', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-respond-invalid',
            workflow_name: 'respond-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                decisions: [{ id: 'approve' }, { id: 'revise' }],
                decisionsAuthored: true,
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );
        mockResolveApprovalGate.mockClear();

        const result = await handleCommand(
          approveConversation,
          '/workflow respond run-respond-invalid nonexistent'
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain("does not declare decision 'nonexistent'");
        expect(mockResolveApprovalGate).not.toHaveBeenCalled();
      });

      test('legacy on_reject-configured gate keeps plain text output, unaffected by #2707', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-legacy-cap',
            workflow_name: 'legacy-capture-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                captureResponse: true,
                onRejectPrompt: 'Fix: $REJECTION_REASON',
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        await handleCommand(
          approveConversation,
          '/workflow approve run-legacy-cap LGTM looks good'
        );

        const casEvents = mockResolveApprovalGate.mock.calls[0]?.[2] ?? [];
        const nodeCompleted = casEvents.find(e => e.event_type === 'node_completed');
        expect(nodeCompleted).toMatchObject({
          data: { node_output: 'LGTM looks good', approval_decision: 'approved' },
        });
        expect((nodeCompleted?.data as Record<string, unknown>).structured_output).toBeUndefined();
      });
    });

    describe('/workflow reject — on_reject branch', () => {
      test('records rejection and increments count when on_reject configured', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-reject-1',
            workflow_name: 'review-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'review this',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve the plan?',
                onRejectPrompt: 'Fix: $REJECTION_REASON',
                onRejectMaxAttempts: 3,
              },
              rejection_count: 0,
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-reject-1 needs work'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Reworking');
        // Stays 'paused' (no status write) — rework staged on the approval context,
        // stamped atomically via the CAS (#2075/#2113), with the audit event in the
        // same transaction (#2146)
        expect(mockResolveApprovalGate).toHaveBeenCalledWith(
          'run-reject-1',
          {
            approval: {
              type: 'approval',
              nodeId: 'review',
              message: 'Approve the plan?',
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
              step_name: 'review',
              data: { decision: 'rejected', reason: 'needs work' },
            },
          ]
        );
      });

      test('cancels when max attempts reached', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-reject-max',
            workflow_name: 'review-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'review this',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'review',
                message: 'Approve?',
                onRejectPrompt: 'Fix: $REJECTION_REASON',
                onRejectMaxAttempts: 3,
              },
              rejection_count: 2,
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-reject-max bad'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('max attempts reached');
        // Terminal reject resolves + cancels atomically (#2113); the audit event
        // rides the same transaction (#2146).
        expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
          'run-reject-max',
          [
            {
              event_type: 'approval_received',
              step_name: 'review',
              data: { decision: 'rejected', reason: 'bad' },
            },
          ],
          { step_name: 'review', reason: 'approval_rejected' }
        );
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      });

      test('cancels immediately without on_reject', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(
          makeWorkflowRun({
            id: 'run-reject-plain',
            workflow_name: 'plain-wf',
            conversation_id: 'conv-approve',
            status: 'paused',
            user_message: 'start',
            metadata: {
              approval: {
                type: 'approval',
                nodeId: 'gate',
                message: 'Approve?',
              },
            },
            last_activity_at: new Date(),
            working_path: '/repo',
          })
        );

        const result = await handleCommand(
          approveConversation,
          '/workflow reject run-reject-plain reason'
        );

        expect(result.success).toBe(true);
        // Terminal reject resolves + cancels atomically (#2113); the audit event
        // rides the same transaction (#2146).
        expect(mockResolveAndCancelApprovalGate).toHaveBeenCalledWith(
          'run-reject-plain',
          [
            {
              event_type: 'approval_received',
              step_name: 'gate',
              data: { decision: 'rejected', reason: 'reason' },
            },
          ],
          { step_name: 'gate', reason: 'approval_rejected' }
        );
        expect(mockCancelWorkflowRun).not.toHaveBeenCalled();
      });
    });
  });
});

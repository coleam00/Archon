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
import { describe, test, expect, mock, beforeEach, afterAll, spyOn, type Mock } from 'bun:test';
import { createMockLogger } from '../test/mocks/logger';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { Conversation } from '../types';
import { resolve, join } from 'path';
import * as fsPromises from 'fs/promises';
import * as gitUtils from '@archon/git';
import * as pathValidation from '../utils/path-validation';
import * as workflowDiscovery from '@archon/workflows/workflow-discovery';

// Create mock functions for database modules (safe to mock - no standalone tests)
const mockUpdateConversation = mock(() => Promise.resolve());
const mockGetCodebase = mock(() => Promise.resolve(null));
const mockFindCodebaseByDefaultCwd = mock(() => Promise.resolve(null));
const mockCreateCodebase = mock(() => Promise.resolve(null));
const mockGetCodebaseCommands = mock(() => Promise.resolve({}));
const mockUpdateCodebaseCommands = mock(() => Promise.resolve());
const mockDeleteCodebase = mock(() => Promise.resolve());
const mockGetActiveSession = mock(() => Promise.resolve(null));
const mockDeactivateSession = mock(() => Promise.resolve());

// Workflow database mocks
const mockGetActiveWorkflowRun = mock(() => Promise.resolve(null));
const mockCancelWorkflowRun = mock(() => Promise.resolve());
const mockListWorkflowRuns = mock(() => Promise.resolve([]));
const mockGetWorkflowRun = mock(() => Promise.resolve(null));
const mockResumeWorkflowRun = mock(() => Promise.resolve({ id: 'run-id', status: 'running' }));
const mockFailWorkflowRun = mock(() => Promise.resolve());
const mockUpdateWorkflowRun = mock(() => Promise.resolve());

// Workflow events database mocks
const mockCreateWorkflowEvent = mock(() => Promise.resolve());

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
let spyFsReaddir: ReturnType<typeof spyOn>;
let spyFsRm: ReturnType<typeof spyOn>;

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
}));

mock.module('../db/sessions', () => ({
  getActiveSession: mockGetActiveSession,
  deactivateSession: mockDeactivateSession,
}));

mock.module('../db/workflows', () => ({
  getActiveWorkflowRun: mockGetActiveWorkflowRun,
  cancelWorkflowRun: mockCancelWorkflowRun,
  listWorkflowRuns: mockListWorkflowRuns,
  getWorkflowRun: mockGetWorkflowRun,
  resumeWorkflowRun: mockResumeWorkflowRun,
  failWorkflowRun: mockFailWorkflowRun,
  updateWorkflowRun: mockUpdateWorkflowRun,
}));

mock.module('../db/workflow-events', () => ({
  createWorkflowEvent: mockCreateWorkflowEvent,
}));

// Mock isolation-environments database
const mockIsolationEnvDbCreate = mock(() =>
  Promise.resolve({
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
  })
);
const mockIsolationEnvDbGet = mock(() => Promise.resolve(null));
const mockIsolationEnvDbUpdate = mock(() => Promise.resolve());

const mockCountActiveByCodebase = mock(() => Promise.resolve(0));
mock.module('../db/isolation-environments', () => ({
  create: mockIsolationEnvDbCreate,
  getById: mockIsolationEnvDbGet,
  getByWorkingPath: mock(() => Promise.resolve(null)),
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
  mockGetActiveSession.mockClear();
  mockDeactivateSession.mockClear();
  // Workflow db mocks
  mockGetActiveWorkflowRun.mockClear();
  mockCancelWorkflowRun.mockClear();
  mockListWorkflowRuns.mockClear();
  mockGetWorkflowRun.mockClear();
  mockResumeWorkflowRun.mockClear();
  mockFailWorkflowRun.mockClear();
  mockUpdateWorkflowRun.mockClear();
  mockCreateWorkflowEvent.mockClear();
  // Isolation mocks
  mockIsolationCreate.mockClear();
  mockIsolationDestroy.mockClear();
  // Isolation-environments db mocks
  mockIsolationEnvDbCreate.mockClear();
  mockIsolationEnvDbGet.mockClear();
  mockIsolationEnvDbUpdate.mockClear();
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
  spyGetWorktreeBase = spyOn(gitUtils, 'getWorktreeBase').mockImplementation((repoPath: string) =>
    join(repoPath, 'worktrees')
  );
  spyGetCanonicalRepoPath = spyOn(gitUtils, 'getCanonicalRepoPath').mockImplementation(
    (path: string) => Promise.resolve(path)
  );
  spyIsWorktreePath = spyOn(gitUtils, 'isWorktreePath').mockResolvedValue(false);
  spyFindWorktreeByBranch = spyOn(gitUtils, 'findWorktreeByBranch').mockResolvedValue(null);
  spyMkdirAsync = spyOn(gitUtils, 'mkdirAsync').mockResolvedValue();

  // fs/promises spies (avoid global mock.module pollution)
  spyFsAccess = spyOn(fsPromises, 'access').mockImplementation(() =>
    Promise.reject(new Error('ENOENT'))
  );
  spyFsReaddir = spyOn(fsPromises, 'readdir').mockImplementation(() => Promise.resolve([]));
  spyFsRm = spyOn(fsPromises, 'rm').mockImplementation(() => Promise.resolve());

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
  spyFsReaddir?.mockRestore();
  spyFsRm?.mockRestore();
  spyDiscoverWorkflows?.mockRestore();
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
    const baseConversation: Conversation = {
      id: 'conv-123',
      platform_type: 'telegram',
      platform_conversation_id: 'chat-456',
      ai_assistant_type: 'claude',
      codebase_id: null,
      cwd: null,
      isolation_env_id: null,
      last_activity_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

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
        mockGetCodebase.mockResolvedValue({
          id: 'cb-123',
          name: 'my-repo',
          repository_url: 'https://github.com/user/my-repo',
          default_cwd: '/workspace/my-repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status');
        expect(result.success).toBe(true);
        expect(result.message).toContain('my-repo');
      });

      test('should show project-less status when no codebase attached', async () => {
        const conversation = {
          ...baseConversation,
          codebase_id: null,
        };

        mockGetActiveSession.mockResolvedValue(null);

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Orchestrator Status');
        expect(result.message).toContain('None — orchestrator will route as needed');
      });

      test('should show no codebase when cwd does not match any codebase', async () => {
        const conversation = {
          ...baseConversation,
          cwd: '/workspace/unknown-repo',
          codebase_id: null,
        };

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

        mockGetCodebase.mockResolvedValue({
          id: 'cb-worktree',
          name: 'owner/repo',
          repository_url: 'https://github.com/owner/repo',
          default_cwd: '/workspace/repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
        mockGetActiveSession.mockResolvedValue(null);
        // Mock isolation environment lookup to return worktree branch
        mockIsolationEnvDbGet.mockResolvedValue({
          id: 'env-123',
          codebase_id: 'cb-worktree',
          workflow_type: 'issue',
          workflow_id: 'issue-42',
          provider: 'worktree',
          working_path: '/workspace/repo/worktrees/issue-42',
          branch_name: 'issue-42',
          status: 'active',
          created_at: new Date(),
          created_by_platform: 'test',
        });

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

        mockGetCodebase.mockResolvedValue({
          id: 'cb-orphaned',
          name: 'owner/orphaned-repo',
          repository_url: 'https://github.com/owner/orphaned-repo',
          default_cwd: '/workspace/orphaned-repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
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
      test('should deactivate active session', async () => {
        mockGetActiveSession.mockResolvedValue({
          id: 'session-123',
          conversation_id: 'conv-123',
          codebase_id: 'cb-123',
          ai_assistant_type: 'claude',
          assistant_session_id: 'sdk-123',
          active: true,
          metadata: {},
          started_at: new Date(),
          ended_at: null,
        });
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
      const conversationWithCodebase: Conversation = {
        ...baseConversation,
        codebase_id: 'codebase-123',
        cwd: '/workspace/my-repo',
      };

      beforeEach(() => {
        mockGetCodebase.mockResolvedValue({
          id: 'codebase-123',
          name: 'my-repo',
          repository_url: 'https://github.com/user/my-repo',
          default_cwd: '/workspace/my-repo',
          ai_assistant_type: 'claude',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
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
          const convWithWorktree: Conversation = {
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-existing',
          };

          // Mock DB lookup to return the working path for this UUID
          mockIsolationEnvDbGet.mockResolvedValueOnce({
            id: 'env-uuid-existing',
            codebase_id: 'codebase-123',
            working_path: '/workspace/my-repo/worktrees/existing-branch',
            branch_name: 'existing-branch',
          });

          const result = await handleCommand(convWithWorktree, '/worktree create new-branch');

          expect(result.success).toBe(false);
          expect(result.message).toContain('Already using worktree');
          expect(result.message).toMatch(/worktrees[\\\/]existing-branch/);
          expect(result.message).not.toContain('env-uuid-existing');
          expect(result.message).toContain('/worktree remove first');
        });

        test('should fallback to UUID when isolation env not found in DB', async () => {
          const convWithWorktree: Conversation = {
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-orphaned',
          };

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
        test('should require active worktree', async () => {
          const result = await handleCommand(conversationWithCodebase, '/worktree remove');
          expect(result.success).toBe(false);
          expect(result.message).toContain('not using a worktree');
        });

        test('should remove worktree and switch to main', async () => {
          const convWithWorktree: Conversation = {
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x', // Use UUID-like ID
          };

          // Mock the isolation environment lookup to return the environment
          mockIsolationEnvDbGet.mockResolvedValue({
            id: 'env-uuid-feat-x',
            codebase_id: 'codebase-123',
            workflow_type: 'task',
            workflow_id: 'task-feat-x',
            provider: 'worktree',
            working_path: '/workspace/my-repo/worktrees/feat-x',
            branch_name: 'feat-x',
            status: 'active',
            created_at: new Date(),
            created_by_platform: 'test',
          });

          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue(null);

          const result = await handleCommand(convWithWorktree, '/worktree remove');

          expect(result.success).toBe(true);
          expect(result.message).toContain('removed');
          expect(result.message).toMatch(/worktrees[\\\/]feat-x/);
          expect(mockUpdateConversation).toHaveBeenCalled();
        });

        test('should deactivate session with worktree-removed reason', async () => {
          const convWithWorktree: Conversation = {
            ...conversationWithCodebase,
            isolation_env_id: 'env-uuid-feat-x',
          };

          mockIsolationEnvDbGet.mockResolvedValue({
            id: 'env-uuid-feat-x',
            codebase_id: 'codebase-123',
            workflow_type: 'task',
            workflow_id: 'task-feat-x',
            provider: 'worktree',
            working_path: '/workspace/my-repo/worktrees/feat-x',
            branch_name: 'feat-x',
            status: 'active',
            created_at: new Date(),
            created_by_platform: 'test',
          });

          spyExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
          mockGetActiveSession.mockResolvedValue({
            id: 'session-789',
            conversation_id: 'conv-123',
            active: true,
          });
          mockDeactivateSession.mockResolvedValue(undefined);

          const result = await handleCommand(convWithWorktree, '/worktree remove');

          expect(result.success).toBe(true);
          expect(mockDeactivateSession).toHaveBeenCalledWith('session-789', 'worktree-removed');
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
      const conversationWithCodebase: Conversation = {
        ...baseConversation,
        codebase_id: 'codebase-123',
      };

      beforeEach(() => {
        mockGetCodebase.mockResolvedValue({
          id: 'codebase-123',
          repository_url: 'https://github.com/test/repo',
          default_cwd: '/workspace/test-repo',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
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
    });

    describe('/workflow reload', () => {
      const conversationWithCodebase: Conversation = {
        ...baseConversation,
        codebase_id: 'codebase-123',
      };

      beforeEach(() => {
        mockGetCodebase.mockResolvedValue({
          id: 'codebase-123',
          repository_url: 'https://github.com/test/repo',
          default_cwd: '/workspace/test-repo',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
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
      const conversationWithCodebase: Conversation = {
        ...baseConversation,
        codebase_id: 'codebase-123',
      };

      beforeEach(() => {
        mockGetCodebase.mockResolvedValue({
          id: 'codebase-123',
          repository_url: 'https://github.com/test/repo',
          default_cwd: '/workspace/test-repo',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
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
      const conversationWithCodebase: Conversation = {
        ...baseConversation,
        codebase_id: 'codebase-123',
      };

      beforeEach(() => {
        // Mock getCodebase to return a valid codebase
        mockGetCodebase.mockResolvedValue({
          id: 'codebase-123',
          repository_url: 'https://github.com/test/repo',
          default_cwd: '/workspace/test-repo',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
      });

      test('should cancel active workflow and return success message', async () => {
        mockGetActiveWorkflowRun.mockResolvedValueOnce({
          id: 'wf-123',
          workflow_name: 'test-workflow',
          conversation_id: 'conv-123',
          status: 'running',
          started_at: new Date(),
          completed_at: null,
          user_message: 'test',
          metadata: {},
          last_activity_at: new Date(),
        });

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
          {
            id: 'run-abc123',
            workflow_name: 'implement',
            conversation_id: 'conv-1',
            parent_conversation_id: null,
            codebase_id: null,
            status: 'running',
            user_message: 'add feature',
            metadata: {},
            started_at: startedAt,
            completed_at: null,
            last_activity_at: startedAt,
            working_path: '/workspace/worktrees/feat-auth',
          },
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
          {
            id: 'run-xyz',
            workflow_name: 'assist',
            conversation_id: 'conv-1',
            parent_conversation_id: null,
            codebase_id: null,
            status: 'running',
            user_message: 'help',
            metadata: {},
            started_at: startedAt,
            completed_at: null,
            last_activity_at: null,
            working_path: null,
          },
        ]);

        const result = await handleCommand(baseConversation, '/workflow status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('(unknown)');
      });
    });

    describe('/workflow resume', () => {
      test('should indicate failed run is ready to resume', async () => {
        const run = {
          id: 'run-123',
          workflow_name: 'implement',
          conversation_id: 'conv-1',
          parent_conversation_id: null,
          codebase_id: null,
          status: 'failed' as const,
          user_message: 'test',
          metadata: {},
          started_at: new Date(),
          completed_at: null,
          last_activity_at: null,
          working_path: '/workspace/wt',
        };
        mockGetWorkflowRun.mockResolvedValueOnce(run);

        const result = await handleCommand(baseConversation, '/workflow resume run-123');

        expect(result.success).toBe(true);
        expect(result.message).toContain('ready to resume');
        expect(result.message).toContain('implement');
      });

      test('should accept already-failed run without status change', async () => {
        const run = {
          id: 'run-456',
          workflow_name: 'plan',
          conversation_id: 'conv-1',
          parent_conversation_id: null,
          codebase_id: null,
          status: 'failed' as const,
          user_message: 'test',
          metadata: {},
          started_at: new Date(),
          completed_at: null,
          last_activity_at: null,
          working_path: null,
        };
        mockGetWorkflowRun.mockResolvedValueOnce(run);

        const result = await handleCommand(baseConversation, '/workflow resume run-456');

        expect(result.success).toBe(true);
        // Already failed — no status change needed
        expect(mockFailWorkflowRun).not.toHaveBeenCalled();
      });

      test('should reject resume of non-resumable run', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-789',
          workflow_name: 'assist',
          conversation_id: 'conv-1',
          parent_conversation_id: null,
          codebase_id: null,
          status: 'running' as const,
          user_message: 'test',
          metadata: {},
          started_at: new Date(),
          completed_at: null,
          last_activity_at: null,
          working_path: null,
        });

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
        const run = {
          id: 'run-123',
          workflow_name: 'implement',
          conversation_id: 'conv-1',
          parent_conversation_id: null,
          codebase_id: null,
          status: 'running' as const,
          user_message: 'test',
          metadata: {},
          started_at: new Date(),
          completed_at: null,
          last_activity_at: null,
          working_path: null,
        };
        mockGetWorkflowRun.mockResolvedValueOnce(run);

        const result = await handleCommand(baseConversation, '/workflow abandon run-123');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Abandoned');
        expect(result.message).toContain('implement');
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-123');
      });

      test('should reject abandon of already-terminal run', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-done',
          workflow_name: 'assist',
          conversation_id: 'conv-1',
          parent_conversation_id: null,
          codebase_id: null,
          status: 'completed' as const,
          user_message: 'test',
          metadata: {},
          started_at: new Date(),
          completed_at: new Date(),
          last_activity_at: null,
          working_path: null,
        });

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
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-err',
          workflow_name: 'implement',
          conversation_id: 'conv-1',
          parent_conversation_id: null,
          codebase_id: null,
          status: 'running' as const,
          user_message: 'test',
          metadata: {},
          started_at: new Date(),
          completed_at: null,
          last_activity_at: null,
          working_path: null,
        });
        mockCancelWorkflowRun.mockRejectedValueOnce(new Error('DB down'));

        const result = await handleCommand(baseConversation, '/workflow abandon run-err');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to abandon');
      });
    });

    describe('/workflow run', () => {
      const conversationWithCodebase: Conversation = {
        ...baseConversation,
        codebase_id: 'codebase-123',
      };

      beforeEach(() => {
        mockGetCodebase.mockResolvedValue({
          id: 'codebase-123',
          repository_url: 'https://github.com/test/repo',
          default_cwd: '/workspace/test-repo',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
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

      test('should return not-found when no codebase is configured', async () => {
        const result = await handleCommand(baseConversation, '/workflow run test-workflow');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Workflow `test-workflow` not found');
      });
    });

    describe('/workflow help text', () => {
      const conversationWithCodebase: Conversation = {
        ...baseConversation,
        codebase_id: 'codebase-123',
      };

      beforeEach(() => {
        mockGetCodebase.mockResolvedValue({
          id: 'codebase-123',
          repository_url: 'https://github.com/test/repo',
          default_cwd: '/workspace/test-repo',
          commands: {},
          created_at: new Date(),
          updated_at: new Date(),
        });
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
        const conversation: Conversation = {
          ...baseConversation,
          codebase_id: null,
          cwd: null,
        };

        const startedAt = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes ago
        const lastActivity = new Date(Date.now() - 10 * 1000); // 10 seconds ago
        mockGetActiveWorkflowRun.mockResolvedValueOnce({
          id: 'wf-active-123',
          workflow_name: 'investigate-issue',
          conversation_id: 'conv-123',
          status: 'running',
          started_at: startedAt,
          completed_at: null,
          user_message: 'test',
          metadata: {},
          last_activity_at: lastActivity,
        });

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Active Workflow: `investigate-issue`');
        expect(result.message).toContain('Cancel: `/workflow cancel`');
      });

      test('should not show workflow section when no workflow running', async () => {
        const conversation: Conversation = {
          ...baseConversation,
          codebase_id: null,
          cwd: null,
        };

        mockGetActiveWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).not.toContain('Active Workflow');
      });

      test('should show active workflow info in status without stale warnings', async () => {
        const conversation: Conversation = {
          ...baseConversation,
          codebase_id: null,
          cwd: null,
        };

        const startedAt = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
        const lastActivity = new Date(Date.now() - 7 * 60 * 1000); // 7 minutes ago
        mockGetActiveWorkflowRun.mockResolvedValueOnce({
          id: 'wf-active',
          workflow_name: 'long-workflow',
          conversation_id: 'conv-123',
          status: 'running',
          started_at: startedAt,
          completed_at: null,
          user_message: 'test',
          metadata: {},
          last_activity_at: lastActivity,
        });

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Active Workflow');
        expect(result.message).toContain('long-workflow');
        expect(result.message).not.toContain('possibly stale');
      });

      test('should gracefully handle workflow database errors in status', async () => {
        const conversation: Conversation = {
          ...baseConversation,
          codebase_id: null,
          cwd: null,
        };

        mockGetActiveWorkflowRun.mockRejectedValueOnce(new Error('Database connection error'));

        const result = await handleCommand(conversation, '/status');

        // Status should still succeed, just without workflow info
        expect(result.success).toBe(true);
        expect(result.message).toContain('telegram'); // Basic info still present
        expect(result.message).not.toContain('Active Workflow');
      });

      test('should handle invalid workflow date data gracefully in status', async () => {
        const conversation: Conversation = {
          ...baseConversation,
          codebase_id: null,
          cwd: null,
        };

        mockGetActiveWorkflowRun.mockResolvedValueOnce({
          id: 'wf-invalid-dates',
          workflow_name: 'corrupted-workflow',
          conversation_id: 'conv-123',
          status: 'running',
          started_at: 'not-a-valid-date', // Invalid date
          completed_at: null,
          user_message: 'test',
          metadata: {},
          last_activity_at: null,
        });

        const result = await handleCommand(conversation, '/status');

        expect(result.success).toBe(true);
        // Should still show workflow name
        expect(result.message).toContain('corrupted-workflow');
      });
    });

    describe('/workflow approve — interactive_loop branch', () => {
      const baseConversation: Conversation = {
        id: 'conv-approve',
        platform_type: 'telegram',
        platform_conversation_id: 'chat-approve',
        ai_assistant_type: 'claude',
        codebase_id: null,
        cwd: null,
        isolation_env_id: null,
        last_activity_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      test('routes to interactive_loop branch and stores loop_user_input', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-123',
          workflow_name: 'my-loop-wf',
          conversation_id: 'conv-approve',
          parent_conversation_id: null,
          codebase_id: null,
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
          started_at: new Date(),
          completed_at: null,
          last_activity_at: new Date(),
          working_path: '/repo',
        });

        const result = await handleCommand(
          baseConversation,
          '/workflow approve run-123 Add error handling'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('loop input received');
        expect(result.message).toContain('my-loop-wf');
        expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-123', {
          status: 'failed',
          metadata: { loop_user_input: 'Add error handling' },
        });
      });

      test('creates approval_received event (not node_completed) for interactive_loop', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-456',
          workflow_name: 'loop-wf',
          conversation_id: 'conv-approve',
          parent_conversation_id: null,
          codebase_id: null,
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
          started_at: new Date(),
          completed_at: null,
          last_activity_at: new Date(),
          working_path: null,
        });

        await handleCommand(baseConversation, '/workflow approve run-456 LGTM');

        // node_completed should NOT be written by the approve command — only the executor
        // writes it when the AI emits the completion signal (actual loop exit).
        const nodeCompletedCalls = mockCreateWorkflowEvent.mock.calls.filter(
          (call: unknown[]) => (call[0] as Record<string, unknown>).event_type === 'node_completed'
        );
        expect(nodeCompletedCalls.length).toBe(0);
        expect(mockCreateWorkflowEvent).toHaveBeenCalledWith(
          expect.objectContaining({ event_type: 'approval_received' })
        );
      });

      test('returns error when run is not paused', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-789',
          workflow_name: 'loop-wf',
          conversation_id: 'conv-approve',
          parent_conversation_id: null,
          codebase_id: null,
          status: 'running',
          user_message: 'start',
          metadata: {},
          started_at: new Date(),
          completed_at: null,
          last_activity_at: new Date(),
          working_path: null,
        });

        const result = await handleCommand(baseConversation, '/workflow approve run-789 feedback');

        expect(result.success).toBe(false);
        expect(result.message).toContain('paused');
      });

      test('returns error when run not found', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce(null);

        const result = await handleCommand(
          baseConversation,
          '/workflow approve missing-run feedback'
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
      });
    });

    describe('/workflow approve — standard approval node with captureResponse', () => {
      const baseConversation: Conversation = {
        id: 'conv-approve',
        platform_type: 'telegram',
        platform_conversation_id: 'chat-approve',
        ai_assistant_type: 'claude',
        codebase_id: null,
        cwd: null,
        isolation_env_id: null,
        last_activity_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      test('stores user comment as node_output when captureResponse is true', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-cap',
          workflow_name: 'capture-wf',
          conversation_id: 'conv-approve',
          parent_conversation_id: null,
          codebase_id: null,
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
          started_at: new Date(),
          completed_at: null,
          last_activity_at: new Date(),
          working_path: '/repo',
        });

        await handleCommand(baseConversation, '/workflow approve run-cap LGTM looks good');

        const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls.find(
          (c: unknown[]) => (c[0] as Record<string, unknown>).event_type === 'node_completed'
        );
        expect(nodeCompletedCall?.[0]).toMatchObject({
          data: { node_output: 'LGTM looks good', approval_decision: 'approved' },
        });
      });

      test('stores empty node_output when captureResponse is not set', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-nocap',
          workflow_name: 'nocapture-wf',
          conversation_id: 'conv-approve',
          parent_conversation_id: null,
          codebase_id: null,
          status: 'paused',
          user_message: 'start',
          metadata: {
            approval: {
              type: 'approval',
              nodeId: 'review',
              message: 'Approve?',
            },
          },
          started_at: new Date(),
          completed_at: null,
          last_activity_at: new Date(),
          working_path: '/repo',
        });

        await handleCommand(baseConversation, '/workflow approve run-nocap a comment');

        const nodeCompletedCall = mockCreateWorkflowEvent.mock.calls.find(
          (c: unknown[]) => (c[0] as Record<string, unknown>).event_type === 'node_completed'
        );
        expect(nodeCompletedCall?.[0]).toMatchObject({
          data: { node_output: '', approval_decision: 'approved' },
        });
      });
    });

    describe('/workflow reject — on_reject branch', () => {
      const baseConversation: Conversation = {
        id: 'conv-approve',
        platform_type: 'telegram',
        platform_conversation_id: 'chat-approve',
        ai_assistant_type: 'claude',
        codebase_id: null,
        cwd: null,
        isolation_env_id: null,
        last_activity_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      };

      test('records rejection and increments count when on_reject configured', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-reject-1',
          workflow_name: 'review-wf',
          conversation_id: 'conv-approve',
          parent_conversation_id: null,
          codebase_id: null,
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
          started_at: new Date(),
          completed_at: null,
          last_activity_at: new Date(),
          working_path: '/repo',
        });

        const result = await handleCommand(
          baseConversation,
          '/workflow reject run-reject-1 needs work'
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Reworking');
        expect(mockUpdateWorkflowRun).toHaveBeenCalledWith('run-reject-1', {
          status: 'failed',
          metadata: { rejection_reason: 'needs work', rejection_count: 1 },
        });
      });

      test('cancels when max attempts reached', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-reject-max',
          workflow_name: 'review-wf',
          conversation_id: 'conv-approve',
          parent_conversation_id: null,
          codebase_id: null,
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
          started_at: new Date(),
          completed_at: null,
          last_activity_at: new Date(),
          working_path: '/repo',
        });

        const result = await handleCommand(baseConversation, '/workflow reject run-reject-max bad');

        expect(result.success).toBe(true);
        expect(result.message).toContain('max attempts reached');
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-reject-max');
      });

      test('cancels immediately without on_reject', async () => {
        mockGetWorkflowRun.mockResolvedValueOnce({
          id: 'run-reject-plain',
          workflow_name: 'plain-wf',
          conversation_id: 'conv-approve',
          parent_conversation_id: null,
          codebase_id: null,
          status: 'paused',
          user_message: 'start',
          metadata: {
            approval: {
              type: 'approval',
              nodeId: 'gate',
              message: 'Approve?',
            },
          },
          started_at: new Date(),
          completed_at: null,
          last_activity_at: new Date(),
          working_path: '/repo',
        });

        const result = await handleCommand(
          baseConversation,
          '/workflow reject run-reject-plain reason'
        );

        expect(result.success).toBe(true);
        expect(mockCancelWorkflowRun).toHaveBeenCalledWith('run-reject-plain');
      });
    });
  });
});

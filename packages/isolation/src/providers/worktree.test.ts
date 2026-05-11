import { describe, test, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';
import { join } from 'node:path';

// Fixed test home — path assertions use this constant; no duplication of production isDocker() logic.
const TEST_ARCHON_HOME = '/test/.archon';

// Mock @archon/paths: provide getArchonHome + workspaces path helpers so @archon/git (getWorktreeBase,
// isProjectScopedWorktreeBase) and worktree.ts resolve paths against TEST_ARCHON_HOME consistently.
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => undefined,
  }),
  getArchonHome: () => TEST_ARCHON_HOME,
  getArchonWorkspacesPath: () => join(TEST_ARCHON_HOME, 'workspaces'),
  getArchonWorktreesPath: () => join(TEST_ARCHON_HOME, 'worktrees'),
  getProjectWorktreesPath: (owner: string, repo: string) =>
    join(TEST_ARCHON_HOME, 'workspaces', owner, repo, 'worktrees'),
  isDocker: () => false,
}));

import * as git from '@archon/git';
import * as worktreeCopy from '../worktree-copy';
import type { IsolationRequest, PRIsolationRequest, RepoConfigLoader } from '../types';

// Track sync function calls for testing
let getDefaultBranchSpy: Mock<typeof git.getDefaultBranch>;
let syncWorkspaceSpy: Mock<typeof git.syncWorkspace>;

// Mock fs.promises.access for destroy() existence check
const mockAccess = mock(() => Promise.resolve());
const mockReadFile = mock(() => Promise.reject(new Error('ENOENT')));
const mockRm = mock(() => Promise.resolve());
mock.module('node:fs/promises', () => ({
  access: mockAccess,
  readFile: mockReadFile,
  rm: mockRm,
}));

import { WorktreeProvider } from './worktree';

describe('WorktreeProvider', () => {
  let provider: WorktreeProvider;
  let mockConfigLoader: RepoConfigLoader;
  let execSpy: Mock<typeof git.execFileAsync>;
  let mkdirSpy: Mock<typeof git.mkdirAsync>;
  let worktreeExistsSpy: Mock<typeof git.worktreeExists>;
  let listWorktreesSpy: Mock<typeof git.listWorktrees>;
  let findWorktreeByBranchSpy: Mock<typeof git.findWorktreeByBranch>;
  let getCanonicalRepoPathSpy: Mock<typeof git.getCanonicalRepoPath>;

  beforeEach(() => {
    mockConfigLoader = async () => ({ baseBranch: 'main' });
    provider = new WorktreeProvider(mockConfigLoader);
    execSpy = spyOn(git, 'execFileAsync');
    mkdirSpy = spyOn(git, 'mkdirAsync');
    worktreeExistsSpy = spyOn(git, 'worktreeExists');
    listWorktreesSpy = spyOn(git, 'listWorktrees');
    findWorktreeByBranchSpy = spyOn(git, 'findWorktreeByBranch');
    getCanonicalRepoPathSpy = spyOn(git, 'getCanonicalRepoPath');
    getDefaultBranchSpy = spyOn(git, 'getDefaultBranch');
    syncWorkspaceSpy = spyOn(git, 'syncWorkspace');

    // Default mocks
    execSpy.mockResolvedValue({ stdout: '', stderr: '' });
    mkdirSpy.mockResolvedValue(undefined);
    worktreeExistsSpy.mockResolvedValue(false);
    listWorktreesSpy.mockResolvedValue([]);
    findWorktreeByBranchSpy.mockResolvedValue(null);
    getCanonicalRepoPathSpy.mockImplementation(async path => path);
    // Most paths exist by default (directoryExists checks for destroy etc.),
    // but .gitmodules is absent by default — most repos don't use submodules,
    // and default-on submodule init must skip cleanly in that case.
    mockAccess.mockImplementation(async (path: unknown) => {
      if (typeof path === 'string' && path.endsWith('.gitmodules')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return undefined;
    });
    mockReadFile.mockRejectedValue(new Error('ENOENT')); // .git file not readable by default
    mockRm.mockResolvedValue(undefined);

    // Default mocks for workspace sync
    getDefaultBranchSpy.mockResolvedValue('main');
    syncWorkspaceSpy.mockResolvedValue({
      branch: 'main',
      synced: true,
      previousHead: '',
      newHead: '',
      updated: false,
    });
  });

  afterEach(() => {
    execSpy.mockRestore();
    mkdirSpy.mockRestore();
    worktreeExistsSpy.mockRestore();
    listWorktreesSpy.mockRestore();
    findWorktreeByBranchSpy.mockRestore();
    getCanonicalRepoPathSpy.mockRestore();
    getDefaultBranchSpy.mockRestore();
    syncWorkspaceSpy.mockRestore();
    mockAccess.mockClear();
    mockReadFile.mockClear();
    mockRm.mockClear();
  });

  describe('generateBranchName', () => {
    test('generates issue-N for issue workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '42',
      };
      expect(provider.generateBranchName(request)).toBe('archon/issue-42');
    });

    test('generates actual branch name for same-repo PR workflows', () => {
      const request: PRIsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '123',
        prBranch: 'feature/auth',
        isForkPR: false,
      };
      expect(provider.generateBranchName(request)).toBe('feature/auth');
    });

    test('generates pr-N-review for fork PR workflows', () => {
      const request: PRIsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '123',
        prBranch: 'feature/auth',
        isForkPR: true,
      };
      expect(provider.generateBranchName(request)).toBe('archon/pr-123-review');
    });

    test('generates review-N for review workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'review',
        identifier: '456',
      };
      expect(provider.generateBranchName(request)).toBe('archon/review-456');
    });

    test('generates thread-{hash} for thread workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'thread',
        identifier: 'C123:1234567890.123456',
      };
      const name = provider.generateBranchName(request);
      expect(name).toMatch(/^archon\/thread-[a-f0-9]{8}$/);
    });

    test('generates consistent hash for same identifier', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'thread',
        identifier: 'same-thread-id',
      };
      const name1 = provider.generateBranchName(request);
      const name2 = provider.generateBranchName(request);
      expect(name1).toBe(name2);
    });

    test('generates different hashes for different identifiers', () => {
      const request1: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'thread',
        identifier: 'thread-1',
      };
      const request2: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'thread',
        identifier: 'thread-2',
      };
      expect(provider.generateBranchName(request1)).not.toBe(provider.generateBranchName(request2));
    });

    test('generates task-{slug} for task workflows', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'task',
        identifier: 'add-dark-mode',
      };
      expect(provider.generateBranchName(request)).toBe('archon/task-add-dark-mode');
    });

    test('slugifies task identifiers properly', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'task',
        identifier: 'Add Dark Mode!!!',
      };
      expect(provider.generateBranchName(request)).toBe('archon/task-add-dark-mode');
    });
  });

  describe('create', () => {
    const baseRequest: IsolationRequest = {
      codebaseId: 'cb-123',
      canonicalRepoPath: '/workspace/repo',
      workflowType: 'issue',
      identifier: '42',
    };

    test('creates worktree for issue workflow', async () => {
      const env = await provider.create(baseRequest);

      expect(env.provider).toBe('worktree');
      expect(env.branchName).toBe('archon/issue-42');
      expect(env.workingPath).toContain('issue-42');
      expect(env.status).toBe('active');

      // Verify git worktree add was called with -b flag and origin/main as start-point
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'archon/issue-42',
          'origin/main',
        ]),
        expect.any(Object)
      );
    });

    test('does not run git checkout or reset --hard on canonical repo', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      await provider.create(baseRequest);

      const checkoutCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('checkout') && !args.includes('-b');
      });
      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset') && args.includes('--hard');
      });

      expect(checkoutCalls).toHaveLength(0);
      expect(resetCalls).toHaveLength(0);
    });

    test('creates task worktree from specified fromBranch', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'task',
        identifier: 'test-adapters',
        fromBranch: 'feature/extract-adapters',
      };

      await provider.create(request);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'archon/task-test-adapters',
          'feature/extract-adapters',
        ]),
        expect.any(Object)
      );
    });

    test('throws when branch already exists and fromBranch is specified', async () => {
      const alreadyExistsError = new Error('fatal: branch already exists') as Error & {
        stderr: string;
      };
      alreadyExistsError.stderr =
        "fatal: a branch named 'archon/task-test-adapters' already exists";

      // First call (worktree add -b) fails with "already exists"
      execSpy.mockRejectedValueOnce(alreadyExistsError);

      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'task',
        identifier: 'test-adapters',
        fromBranch: 'feature/extract-adapters',
      };

      await expect(provider.create(request)).rejects.toThrow(
        'Branch "archon/task-test-adapters" already exists. Cannot create it from "feature/extract-adapters".'
      );
    });

    test('resets and reuses existing branch when it already exists and no fromBranch', async () => {
      const alreadyExistsError = new Error('fatal: branch already exists') as Error & {
        stderr: string;
      };
      alreadyExistsError.stderr =
        "fatal: a branch named 'archon/task-test-adapters' already exists";

      // First call fails (worktree add -b), second succeeds (branch -f), third succeeds (worktree add)
      execSpy.mockRejectedValueOnce(alreadyExistsError);
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });

      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'task',
        identifier: 'test-adapters',
      };

      await provider.create(request);

      // Verify branch was reset to start-point
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-f', 'archon/task-test-adapters', 'origin/main'],
        expect.any(Object)
      );

      // Fallback call should not include a start-point
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        [
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          'archon/task-test-adapters',
        ],
        expect.any(Object)
      );
    });

    test('creates worktree for same-repo PR (uses actual branch)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false,
      };

      await provider.create(request);

      // Verify fetch with actual branch name
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'fetch', 'origin', 'feature/auth']),
        expect.any(Object)
      );

      // Verify worktree add with actual branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'feature/auth',
          'origin/feature/auth',
        ]),
        expect.any(Object)
      );

      // Verify upstream tracking is set
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          expect.any(String),
          'branch',
          '--set-upstream-to',
          'origin/feature/auth',
        ]),
        expect.any(Object)
      );
    });

    test('creates worktree for fork PR with SHA (reproducible reviews)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        prSha: 'abc123def456',
        isForkPR: true,
      };

      await provider.create(request);

      // Verify fetch with PR ref (fork PRs use pull/N/head)
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'fetch', 'origin', 'pull/42/head']),
        expect.any(Object)
      );

      // Verify worktree add with SHA
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          'abc123def456',
        ]),
        expect.any(Object)
      );

      // Verify checkout -b for tracking branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          expect.any(String),
          'checkout',
          '-b',
          'pr-42-review',
          'abc123def456',
        ]),
        expect.any(Object)
      );
    });

    test('creates worktree for fork PR without SHA (uses PR ref)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
      };

      await provider.create(request);

      // Verify fetch with PR ref and local branch creation
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'fetch',
          'origin',
          'pull/42/head:pr-42-review',
        ]),
        expect.any(Object)
      );

      // Verify worktree add with the local branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          'pr-42-review',
        ]),
        expect.any(Object)
      );
    });

    test('creates worktree for fork PR (uses synthetic review branch)', async () => {
      const request: PRIsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/external',
        isForkPR: true,
      };

      await provider.create(request);

      // Verify fetch with PR ref (fork behavior uses synthetic branch)
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'fetch',
          'origin',
          'pull/42/head:pr-42-review',
        ]),
        expect.any(Object)
      );
    });

    test('adopts existing worktree when repo ownership matches', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      // .git file points to the same repo root as the request
      mockReadFile.mockResolvedValue('gitdir: /workspace/repo/.git/worktrees/archon/issue-42\n');

      const env = await provider.create(baseRequest);

      expect(env.metadata).toHaveProperty('adopted', true);
      expect(env.workingPath).toContain('issue-42');

      // Verify no git worktree add was called
      const addCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('add');
      });
      expect(addCalls).toHaveLength(0);
    });

    test('throws when worktree belongs to different repo root (cross-checkout)', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      mockReadFile.mockResolvedValue('gitdir: /different/repo/.git/worktrees/archon/issue-42\n');

      await expect(provider.create(baseRequest)).rejects.toThrow(/belongs to a different clone/);
    });

    test('throws when .git is a directory (full checkout, not a worktree)', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      const eisdirError = new Error('EISDIR') as NodeJS.ErrnoException;
      eisdirError.code = 'EISDIR';
      mockReadFile.mockRejectedValue(eisdirError);

      await expect(provider.create(baseRequest)).rejects.toThrow(
        /path contains a full git checkout/
      );
    });

    test('throws when .git file cannot be read (permission denied)', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      const eaccesError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      eaccesError.code = 'EACCES';
      mockReadFile.mockRejectedValue(eaccesError);

      await expect(provider.create(baseRequest)).rejects.toThrow(
        /Cannot verify worktree ownership/
      );
    });

    test('throws when .git pointer is not a git-worktree reference (e.g., submodule)', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      mockReadFile.mockResolvedValue('gitdir: /workspace/repo/.git/modules/submodule-name\n');

      await expect(provider.create(baseRequest)).rejects.toThrow(/not a git-worktree reference/);
    });

    test('adopts across path normalization differences (trailing slash)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        canonicalRepoPath: '/workspace/repo/' as IsolationRequest['canonicalRepoPath'],
      };
      worktreeExistsSpy.mockResolvedValue(true);
      // .git file has no trailing slash — resolve() should normalize
      mockReadFile.mockResolvedValue('gitdir: /workspace/repo/.git/worktrees/archon/issue-42\n');

      const env = await provider.create(request);

      expect(env.metadata).toHaveProperty('adopted', true);
    });

    test('adopts worktree by PR branch name (skill symbiosis)', async () => {
      const request: PRIsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false,
      };

      // First check (expected path) returns false
      worktreeExistsSpy.mockResolvedValueOnce(false);
      // findWorktreeByBranch finds existing worktree
      findWorktreeByBranchSpy.mockResolvedValue('/workspace/worktrees/repo/feature-auth');
      // Same-clone ownership match so adoption proceeds
      mockReadFile.mockResolvedValue('gitdir: /workspace/repo/.git/worktrees/feature-auth\n');

      const env = await provider.create(request);

      expect(env.workingPath).toBe('/workspace/worktrees/repo/feature-auth');
      expect(env.metadata).toHaveProperty('adopted', true);
      expect(env.metadata).toHaveProperty('adoptedFrom', 'branch');

      // Verify no git commands for worktree creation
      const addCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('add');
      });
      expect(addCalls).toHaveLength(0);
    });

    test('throws when PR-branch-adopted worktree belongs to a different clone', async () => {
      const request: PRIsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false,
      };

      // Primary path misses, secondary findWorktreeByBranch hits
      worktreeExistsSpy.mockResolvedValueOnce(false);
      findWorktreeByBranchSpy.mockResolvedValue('/workspace/worktrees/repo/feature-auth');
      // .git points to a different clone
      mockReadFile.mockResolvedValue('gitdir: /other/clone/.git/worktrees/feature-auth\n');

      await expect(provider.create(request)).rejects.toThrow(/belongs to a different clone/);
    });

    test('resets stale branch to start-point when it already exists', async () => {
      let callCount = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        callCount++;
        // First worktree add call fails (branch exists)
        if (callCount === 1 && args.includes('-b')) {
          const error = new Error(
            'fatal: A branch named archon/issue-42 already exists.'
          ) as Error & {
            stderr?: string;
          };
          error.stderr = 'fatal: A branch named archon/issue-42 already exists.';
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      await provider.create(baseRequest);

      // Verify first call attempted new branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'archon/issue-42',
        ]),
        expect.any(Object)
      );

      // Verify branch was reset to start-point before checkout
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-f', 'archon/issue-42', 'origin/main'],
        expect.any(Object)
      );

      // Verify final call used existing (reset) branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          'archon/issue-42',
        ]),
        expect.any(Object)
      );
    });

    test('propagates error if branch -f reset fails (protected branch, etc.)', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        // First worktree add call fails (branch exists)
        if (args.includes('worktree') && args.includes('add') && args.includes('-b')) {
          const error = new Error(
            'fatal: A branch named archon/issue-42 already exists.'
          ) as Error & { stderr?: string };
          error.stderr = 'fatal: A branch named archon/issue-42 already exists.';
          throw error;
        }
        // Reset call fails (e.g., branch checked out elsewhere, update hook refused)
        if (args.includes('branch') && args.includes('-f')) {
          const error = new Error('fatal: cannot force update the branch') as Error & {
            stderr?: string;
          };
          error.stderr = "fatal: cannot force update the current branch 'archon/issue-42'";
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      await expect(provider.create(baseRequest)).rejects.toThrow(/cannot force update/);

      // Verify we did NOT retry the worktree add after reset failure
      const secondWorktreeAdd = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return (
          args.includes('worktree') &&
          args.includes('add') &&
          !args.includes('-b') &&
          args.includes('archon/issue-42')
        );
      });
      expect(secondWorktreeAdd).toHaveLength(0);
    });

    test('throws error if PR fetch fails (same-repo PR)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false,
      };

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('fatal: unable to access repository');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(provider.create(request)).rejects.toThrow(
        'Failed to create worktree for PR #42'
      );
    });

    test('throws error if PR fetch fails (fork PR)', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
      };

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('fatal: unable to access repository');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(provider.create(request)).rejects.toThrow(
        'Failed to create worktree for PR #42'
      );
    });

    test('handles existing branch for same-repo PR', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false,
      };

      let callCount = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        callCount++;
        // First worktree add fails (branch already exists)
        if (callCount === 2 && args.includes('-b') && args.includes('feature/auth')) {
          const error = new Error('fatal: A branch named feature/auth already exists.') as Error & {
            stderr?: string;
          };
          error.stderr = 'fatal: A branch named feature/auth already exists.';
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      await provider.create(request);

      // Should have called worktree add without -b flag after failure
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'add',
          expect.any(String),
          'feature/auth',
        ]),
        expect.any(Object)
      );
    });

    test('handles stale branch when creating fork PR with SHA', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        prSha: 'abc123',
        isForkPR: true,
      };

      let checkoutAttempts = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        // First checkout -b attempt fails with "already exists"
        if (args.includes('checkout') && args.includes('-b')) {
          checkoutAttempts++;
          if (checkoutAttempts === 1) {
            const error = new Error(
              'fatal: A branch named pr-42-review already exists.'
            ) as Error & { stderr?: string };
            error.stderr = 'fatal: A branch named pr-42-review already exists.';
            throw error;
          }
        }
        return { stdout: '', stderr: '' };
      });

      await provider.create(request);

      // Verify branch deletion was called to clean up stale branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', 'pr-42-review'],
        expect.any(Object)
      );

      // Verify checkout was retried
      expect(checkoutAttempts).toBe(2);
    });

    test('handles stale branch when creating fork PR without SHA', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
      };

      let fetchAttempts = 0;
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        // First fetch with branch creation fails
        if (args.includes('fetch') && args.some(a => a.includes('pull/42/head:pr-42-review'))) {
          fetchAttempts++;
          if (fetchAttempts === 1) {
            const error = new Error('fatal: already exists') as Error & { stderr?: string };
            error.stderr =
              "fatal: cannot lock ref 'refs/heads/pr-42-review': reference already exists";
            throw error;
          }
        }
        return { stdout: '', stderr: '' };
      });

      await provider.create(request);

      // Verify branch deletion was called to clean up stale branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', 'pr-42-review'],
        expect.any(Object)
      );

      // Verify fetch was retried
      expect(fetchAttempts).toBe(2);
    });

    test('throws error when stale branch deletion fails during fork PR creation', async () => {
      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
      };

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch') && args.some(a => a.includes('pull/42/head:pr-42-review'))) {
          const error = new Error('already exists') as Error & { stderr?: string };
          error.stderr = 'reference already exists';
          throw error;
        }
        if (args.includes('branch') && args.includes('-D')) {
          throw new Error('error: permission denied');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(provider.create(request)).rejects.toThrow(
        'Failed to create worktree for PR #42'
      );
    });

    test('propagates permission error when workspace sync fails during creation', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '99',
      };

      worktreeExistsSpy.mockResolvedValue(false);
      syncWorkspaceSpy.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      );

      await expect(provider.create(request)).rejects.toThrow('Permission denied');
    });

    test('creates worktree under project-scoped path for locally-registered repo', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-local',
        codebaseName: 'Widinglabs/sasha-demo',
        canonicalRepoPath: '/Users/rasmus/Projects/sasha-demo', // not under workspaces
        workflowType: 'task',
        identifier: 'fix-issue-42',
      };

      worktreeExistsSpy.mockResolvedValue(false);
      const env = await provider.create(request);

      // workingPath should use project-scoped path, not legacy global worktrees
      expect(env.workingPath).toBe(
        join(
          TEST_ARCHON_HOME,
          'workspaces',
          'Widinglabs',
          'sasha-demo',
          'worktrees',
          env.branchName
        )
      );

      // mkdir should be called with the project-scoped base (no owner/repo appended)
      expect(mkdirSpy).toHaveBeenCalledWith(
        join(TEST_ARCHON_HOME, 'workspaces', 'Widinglabs', 'sasha-demo', 'worktrees'),
        { recursive: true }
      );
    });

    // Helper: make .gitmodules "exist" (access resolves) while other paths
    // retain the default behavior set in beforeEach.
    const makeGitmodulesPresent = (): void => {
      mockAccess.mockImplementation(async () => undefined);
    };

    const countSubmoduleExecCalls = (): number =>
      execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('submodule') && args.includes('update');
      }).length;

    const getSubmoduleCallArgs = (): string[] | undefined =>
      execSpy.mock.calls.find((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('submodule') && args.includes('update');
      })?.[1] as string[] | undefined;

    test('initializes submodules by default when .gitmodules exists', async () => {
      // Default provider has no initSubmodules in config — should run.
      makeGitmodulesPresent();

      await provider.create(baseRequest);

      expect(countSubmoduleExecCalls()).toBe(1);
      expect(getSubmoduleCallArgs()).toEqual(
        expect.arrayContaining([
          '-C',
          expect.any(String),
          'submodule',
          'update',
          '--init',
          '--recursive',
        ])
      );
    });

    test('initializes submodules when explicitly opted in and .gitmodules exists', async () => {
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        initSubmodules: true,
      });
      const submoduleProvider = new WorktreeProvider(configLoader);
      makeGitmodulesPresent();

      await submoduleProvider.create(baseRequest);

      expect(countSubmoduleExecCalls()).toBe(1);
      expect(getSubmoduleCallArgs()).toEqual(
        expect.arrayContaining(['submodule', 'update', '--init', '--recursive'])
      );
    });

    test('skips submodule init when initSubmodules is false', async () => {
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        initSubmodules: false,
      });
      const noSubmoduleProvider = new WorktreeProvider(configLoader);
      // Even when .gitmodules exists, explicit opt-out must win.
      makeGitmodulesPresent();

      await noSubmoduleProvider.create(baseRequest);

      expect(countSubmoduleExecCalls()).toBe(0);
    });

    test('skips submodule init when .gitmodules does not exist', async () => {
      // Default mock from beforeEach already returns ENOENT for .gitmodules.
      await provider.create(baseRequest);

      expect(countSubmoduleExecCalls()).toBe(0);
    });

    test('throws classifiable error when submodule init fails (fail-fast)', async () => {
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        initSubmodules: true,
      });
      const submoduleProvider = new WorktreeProvider(configLoader);
      makeGitmodulesPresent();

      const gitError = Object.assign(new Error('git submodule update failed'), {
        stderr: 'fatal: could not read from remote repository',
      });
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('submodule')) {
          throw gitError;
        }
        return { stdout: '', stderr: '' };
      });

      // A worktree with uninitialized submodules is a silent broken state;
      // the error must surface rather than be swallowed.
      await expect(submoduleProvider.create(baseRequest)).rejects.toThrow(
        /Submodule initialization failed/
      );
    });

    test('throws when .gitmodules read fails with EACCES (fail-fast, no silent skip)', async () => {
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        initSubmodules: true,
      });
      const submoduleProvider = new WorktreeProvider(configLoader);

      // .gitmodules read fails with a non-ENOENT error. Silently skipping
      // would produce a worktree with empty submodule dirs — the exact
      // silent-broken-state this feature exists to prevent.
      mockAccess.mockImplementation(async (path: unknown) => {
        if (typeof path === 'string' && path.endsWith('.gitmodules')) {
          const err = new Error('EACCES') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
        return undefined;
      });

      await expect(submoduleProvider.create(baseRequest)).rejects.toThrow(
        /Submodule initialization failed: cannot read \.gitmodules \(EACCES\)/
      );
      // Skipped the git op since we couldn't even read .gitmodules.
      expect(countSubmoduleExecCalls()).toBe(0);
    });

    test('throws classifiable error when submodule init times out', async () => {
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        initSubmodules: true,
      });
      const submoduleProvider = new WorktreeProvider(configLoader);
      makeGitmodulesPresent();

      // Simulate execFileAsync timeout: the error surface matches what node's
      // child_process produces when a command exceeds its timeout.
      const timeoutError = Object.assign(new Error('Command failed: git submodule update'), {
        killed: true,
        signal: 'SIGTERM',
        stderr: '',
      });
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('submodule')) {
          throw timeoutError;
        }
        return { stdout: '', stderr: '' };
      });

      await expect(submoduleProvider.create(baseRequest)).rejects.toThrow(
        /Submodule initialization failed/
      );
    });
  });

  describe('destroy', () => {
    test('removes worktree', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      // Mock getCanonicalRepoPath to return the repo path
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      await provider.destroy(worktreePath);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', worktreePath]),
        expect.any(Object)
      );
    });

    test('uses force flag when specified', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      // Mock getCanonicalRepoPath to return the repo path
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      await provider.destroy(worktreePath, { force: true });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'remove',
          '--force',
          worktreePath,
        ]),
        expect.any(Object)
      );
    });

    test('returns gracefully when path does not exist (ENOENT) without canonicalRepoPath', async () => {
      const worktreePath = '/workspace/worktrees/repo/nonexistent';

      // access() throws ENOENT
      const enoentError = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      mockAccess.mockRejectedValueOnce(enoentError);

      // Should not throw - but can't clean up branch without canonicalRepoPath
      await provider.destroy(worktreePath, { branchName: 'test-branch' });

      // Should NOT call git commands (no canonicalRepoPath to run them in)
      expect(execSpy).not.toHaveBeenCalled();
    });

    test('cleans up branch when path does not exist but canonicalRepoPath provided', async () => {
      const worktreePath = '/workspace/worktrees/repo/nonexistent';
      const branchName = 'pr-42-review';

      // access() throws ENOENT
      const enoentError = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      mockAccess.mockRejectedValueOnce(enoentError);

      // Should not throw - and should still clean up branch
      await provider.destroy(worktreePath, {
        branchName,
        canonicalRepoPath: '/workspace/repo',
      });

      // Should NOT call git worktree remove (path doesn't exist)
      expect(execSpy).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object)
      );

      // SHOULD call git branch -D to clean up the branch
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', branchName],
        expect.any(Object)
      );
    });

    test('re-throws non-ENOENT errors from access check', async () => {
      const worktreePath = '/workspace/worktrees/repo/nopermission';

      // access() throws EACCES (permission denied)
      const eaccesError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      eaccesError.code = 'EACCES';
      mockAccess.mockRejectedValueOnce(eaccesError);

      // Should throw the error
      await expect(provider.destroy(worktreePath)).rejects.toThrow('EACCES: permission denied');

      // Should NOT call git worktree remove
      expect(execSpy).not.toHaveBeenCalled();
    });

    test('returns gracefully when git worktree remove fails with "No such file or directory"', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // git worktree remove fails
      execSpy.mockRejectedValueOnce(
        new Error(
          "fatal: cannot change to '/workspace/worktrees/repo/issue-42': No such file or directory"
        )
      );

      // Should not throw
      await provider.destroy(worktreePath);
    });

    test('returns gracefully when git worktree remove fails with "is not a working tree"', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // git worktree remove fails because it's not a working tree
      const error = new Error('fatal: some error') as Error & { stderr?: string };
      error.stderr = "fatal: '/workspace/worktrees/repo/issue-42' is not a working tree";
      execSpy.mockRejectedValueOnce(error);

      // Should not throw
      await provider.destroy(worktreePath);
    });

    test('re-throws non-directory errors from git worktree remove', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // git worktree remove fails with uncommitted changes error
      execSpy.mockRejectedValueOnce(
        new Error('fatal: cannot remove: You have local modifications')
      );

      // Should throw the error
      await expect(provider.destroy(worktreePath)).rejects.toThrow('local modifications');
    });

    test('deletes branch when branchName provided', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-42-review';
      const branchName = 'pr-42-review';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      await provider.destroy(worktreePath, { branchName });

      // Verify worktree removal
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', worktreePath]),
        expect.any(Object)
      );

      // Verify branch deletion
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', branchName],
        expect.any(Object)
      );
    });

    test('continues if branch deletion fails', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-42-review';
      const branchName = 'pr-42-review';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        // Branch deletion fails
        if (args.includes('branch')) {
          throw new Error('error: branch not found');
        }
        return { stdout: '', stderr: '' };
      });

      // Should not throw - branch deletion is best-effort
      await provider.destroy(worktreePath, { branchName });

      // Worktree removal should still be called
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object)
      );
    });

    test('does not attempt branch deletion when branchName not provided', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-42-review';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      await provider.destroy(worktreePath);

      // Verify worktree removal called
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object)
      );

      // Verify branch deletion NOT called
      expect(execSpy).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['branch', '-D']),
        expect.any(Object)
      );
    });

    test('still deletes branch even when worktree path does not exist', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-42-review';
      const branchName = 'pr-42-review';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // git worktree remove fails because path doesn't exist
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('worktree')) {
          throw new Error(
            "fatal: cannot change to '/workspace/worktrees/repo/pr-42-review': No such file or directory"
          );
        }
        return { stdout: '', stderr: '' };
      });

      // Should not throw
      await provider.destroy(worktreePath, { branchName });

      // Verify branch deletion was still called after graceful worktree removal failure
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', branchName],
        expect.any(Object)
      );
    });

    test('returns DestroyResult with all fields true on full success', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      const result = await provider.destroy(worktreePath, { branchName: 'issue-42' });

      expect(result.worktreeRemoved).toBe(true);
      expect(result.directoryClean).toBe(true);
      expect(result.branchDeleted).toBe(true);
      expect(result.remoteBranchDeleted).toBeNull(); // Not requested
      expect(result.warnings).toHaveLength(0);
    });

    test('returns warning when branch cleanup skipped (no canonicalRepoPath)', async () => {
      const worktreePath = '/workspace/worktrees/repo/nonexistent';
      const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      mockAccess.mockRejectedValueOnce(enoentError);

      const result = await provider.destroy(worktreePath, { branchName: 'test-branch' });

      expect(result.worktreeRemoved).toBe(true);
      expect(result.branchDeleted).toBeNull(); // Could not attempt (no repo path)
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Cannot delete branch');
    });

    test('returns branchDeleted=null when no branch requested', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      const result = await provider.destroy(worktreePath);

      expect(result.worktreeRemoved).toBe(true);
      expect(result.branchDeleted).toBeNull(); // No branch specified
      expect(result.remoteBranchDeleted).toBeNull(); // Not requested
      expect(result.warnings).toHaveLength(0);
    });

    test('returns branchDeleted=false with warning when branch is checked out elsewhere', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('branch') && args.includes('-D')) {
          const error = new Error('error: checked out at') as Error & { stderr?: string };
          error.stderr = "error: Cannot delete branch 'issue-42' checked out at '/workspace/repo'";
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      const result = await provider.destroy(worktreePath, { branchName: 'issue-42' });

      expect(result.worktreeRemoved).toBe(true);
      expect(result.branchDeleted).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('checked out elsewhere');
    });

    test('deletes remote branch when deleteRemoteBranch is true', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-99';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      const result = await provider.destroy(worktreePath, {
        branchName: 'feature-branch',
        deleteRemoteBranch: true,
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'push', 'origin', '--delete', 'feature-branch'],
        expect.any(Object)
      );
      expect(result.remoteBranchDeleted).toBe(true);
    });

    test('returns remoteBranchDeleted=true when remote ref does not exist', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-99';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('push') && args.includes('--delete')) {
          const error = new Error('error') as Error & { stderr?: string };
          error.stderr = "error: unable to delete 'feature-branch': remote ref does not exist";
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      const result = await provider.destroy(worktreePath, {
        branchName: 'feature-branch',
        deleteRemoteBranch: true,
      });

      expect(result.remoteBranchDeleted).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('returns remoteBranchDeleted=false with warning on network error', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-99';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('push') && args.includes('--delete')) {
          throw new Error('fatal: Could not read from remote repository');
        }
        return { stdout: '', stderr: '' };
      });

      const result = await provider.destroy(worktreePath, {
        branchName: 'feature-branch',
        deleteRemoteBranch: true,
      });

      expect(result.remoteBranchDeleted).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Failed to delete remote branch');
    });

    test('does not attempt remote branch deletion when deleteRemoteBranch is not set', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-99';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      const result = await provider.destroy(worktreePath, {
        branchName: 'feature-branch',
      });

      expect(execSpy).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['push', 'origin', '--delete']),
        expect.any(Object)
      );
      expect(result.remoteBranchDeleted).toBeNull(); // Not requested
    });

    test('partial cleanup: worktree removed but branch deletion fails with unexpected error', async () => {
      const worktreePath = '/workspace/worktrees/repo/pr-42-review';
      const branchName = 'pr-42-review';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('branch') && args.includes('-D')) {
          throw new Error('unexpected git internal error');
        }
        return { stdout: '', stderr: '' };
      });

      const result = await provider.destroy(worktreePath, { branchName });

      expect(result.worktreeRemoved).toBe(true);
      expect(result.branchDeleted).toBe(false);
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
      expect(result.warnings.some(w => w.includes('Unexpected error deleting branch'))).toBe(true);
    });
  });

  describe('get', () => {
    test('returns null for non-existent environment', async () => {
      worktreeExistsSpy.mockResolvedValue(false);

      const result = await provider.get('/workspace/worktrees/repo/nonexistent');
      expect(result).toBeNull();
    });

    test('returns environment for existing worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: '/workspace/worktrees/repo/issue-42', branch: 'issue-42' },
      ]);

      const result = await provider.get('/workspace/worktrees/repo/issue-42');

      expect(result).not.toBeNull();
      expect(result?.provider).toBe('worktree');
      expect(result?.branchName).toBe('issue-42');
    });

    test('re-throws errors from getCanonicalRepoPath with logging', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockRejectedValue(new Error('Permission denied'));

      await expect(provider.get('/workspace/worktrees/repo/issue-42')).rejects.toThrow(
        'Permission denied'
      );
    });

    test('re-throws errors from listWorktrees with logging', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockRejectedValue(new Error('git timeout'));

      await expect(provider.get('/workspace/worktrees/repo/issue-42')).rejects.toThrow(
        'git timeout'
      );
    });

    test('returns null when worktree exists on disk but not in git list (corrupted state)', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // Worktree list does NOT include the queried path
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: '/workspace/worktrees/repo/other-branch', branch: 'other-branch' },
      ]);

      const result = await provider.get('/workspace/worktrees/repo/issue-42');
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    test('returns all worktrees for codebase (excluding main)', async () => {
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: '/workspace/worktrees/repo/issue-42', branch: 'issue-42' },
        { path: '/workspace/worktrees/repo/pr-123', branch: 'pr-123' },
      ]);

      const result = await provider.list('/workspace/repo');

      expect(result).toHaveLength(2);
      expect(result[0].branchName).toBe('issue-42');
      expect(result[1].branchName).toBe('pr-123');
    });

    test('returns empty array when no worktrees', async () => {
      listWorktreesSpy.mockResolvedValue([{ path: '/workspace/repo', branch: 'main' }]);

      const result = await provider.list('/workspace/repo');
      expect(result).toHaveLength(0);
    });
  });

  describe('healthCheck', () => {
    test('returns true for existing worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      const result = await provider.healthCheck('/workspace/worktrees/repo/issue-42');
      expect(result).toBe(true);
    });

    test('returns false for non-existent worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      const result = await provider.healthCheck('/workspace/worktrees/repo/nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('adopt', () => {
    test('adopts existing worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: '/workspace/worktrees/repo/feature-auth', branch: 'feature/auth' },
      ]);

      const result = await provider.adopt('/workspace/worktrees/repo/feature-auth');

      expect(result).not.toBeNull();
      expect(result?.provider).toBe('worktree');
      expect(result?.branchName).toBe('feature/auth');
      expect(result?.metadata).toHaveProperty('adopted', true);
    });

    test('returns null for non-existent path', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      const result = await provider.adopt('/workspace/worktrees/repo/nonexistent');
      expect(result).toBeNull();
    });

    test('returns null when path is not a git repository', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await provider.adopt('/workspace/worktrees/repo/feature-auth');
      expect(result).toBeNull();
    });

    test('throws when git query fails with unexpected error', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockRejectedValue(new Error('permission denied'));

      await expect(provider.adopt('/workspace/worktrees/repo/feature-auth')).rejects.toThrow(
        'permission denied'
      );
    });

    test('throws when listWorktrees fails with unexpected error', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockRejectedValue(new Error('git timeout'));

      await expect(provider.adopt('/workspace/worktrees/repo/feature-auth')).rejects.toThrow(
        'git timeout'
      );
    });

    test('returns null when worktree exists on disk but not in git list (corrupted state)', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // Worktree list does NOT include the queried path
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: '/workspace/worktrees/repo/other-branch', branch: 'other-branch' },
      ]);

      const result = await provider.adopt('/workspace/worktrees/repo/feature-auth');
      expect(result).toBeNull();
    });
  });

  describe('file copying', () => {
    let copyWorktreeFilesSpy: Mock<typeof worktreeCopy.copyWorktreeFiles>;

    const baseRequest: IsolationRequest = {
      codebaseId: 'cb-123',
      canonicalRepoPath: '/.archon/workspaces/owner/repo',
      workflowType: 'issue',
      identifier: '42',
    };

    beforeEach(() => {
      copyWorktreeFilesSpy = spyOn(worktreeCopy, 'copyWorktreeFiles');

      // Default: no config, no copies
      copyWorktreeFilesSpy.mockResolvedValue([]);
    });

    afterEach(() => {
      copyWorktreeFilesSpy.mockRestore();
    });

    test('copies configured files after worktree creation', async () => {
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        copyFiles: ['.env.example -> .env', '.vscode/settings.json'],
      });
      provider = new WorktreeProvider(configLoader);

      copyWorktreeFilesSpy.mockResolvedValue([
        { source: '.archon', destination: '.archon' },
        { source: '.env.example', destination: '.env' },
        { source: '.vscode/settings.json', destination: '.vscode/settings.json' },
      ]);

      await provider.create(baseRequest);

      // Should include default .archon plus user config
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        expect.arrayContaining(['.archon', '.env.example -> .env', '.vscode/settings.json'])
      );
    });

    test('calls copyWorktreeFiles with default .archon when no copyFiles configured', async () => {
      copyWorktreeFilesSpy.mockResolvedValue([]);

      await provider.create(baseRequest);

      // Should still be called with default .archon
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        ['.archon']
      );
    });

    test('calls copyWorktreeFiles with default .archon when copyFiles is empty', async () => {
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        copyFiles: [],
      });
      provider = new WorktreeProvider(configLoader);

      copyWorktreeFilesSpy.mockResolvedValue([]);

      await provider.create(baseRequest);

      // Should still be called with default .archon
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        ['.archon']
      );
    });

    test('throws with config error details when config load fails and no fromBranch', async () => {
      const configLoader: RepoConfigLoader = async () => {
        throw new Error('Config load failed');
      };
      provider = new WorktreeProvider(configLoader);

      copyWorktreeFilesSpy.mockResolvedValue([]);

      // Should throw with the actual config error, not generic "no base branch"
      await expect(provider.create(baseRequest)).rejects.toThrow(
        'Failed to load config: Config load failed'
      );
    });

    test('does not fail worktree creation if file copying fails', async () => {
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        copyFiles: ['.env'],
      });
      provider = new WorktreeProvider(configLoader);

      copyWorktreeFilesSpy.mockRejectedValue(new Error('Copy failed'));

      // Should not throw
      const env = await provider.create(baseRequest);
      expect(env.workingPath).toContain('issue-42');
    });

    test('does not copy files when adopting existing worktree', async () => {
      worktreeExistsSpy.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        'gitdir: /.archon/workspaces/owner/repo/.git/worktrees/archon/issue-42\n'
      );
      const configLoader: RepoConfigLoader = async () => ({
        copyFiles: ['.env.example -> .env'],
      });
      provider = new WorktreeProvider(configLoader);

      await provider.create(baseRequest);

      // File copying should NOT be called for adopted worktrees
      expect(copyWorktreeFilesSpy).not.toHaveBeenCalled();
    });

    test('should copy .archon directory by default (without config)', async () => {
      // Mock: copyWorktreeFiles succeeds
      copyWorktreeFilesSpy.mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

      // Create worktree
      const result = await provider.create(baseRequest);

      // Verify .archon was copied even without config
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        ['.archon'] // Default only
      );

      expect(result.workingPath).toContain('issue-42');
    });

    test('should merge .archon default with user copyFiles config', async () => {
      // Mock: User config with additional files
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        copyFiles: ['.env', '.vscode'],
      });
      provider = new WorktreeProvider(configLoader);

      // Mock: copyWorktreeFiles succeeds
      copyWorktreeFilesSpy.mockResolvedValue([
        { source: '.archon', destination: '.archon' },
        { source: '.env', destination: '.env' },
        { source: '.vscode', destination: '.vscode' },
      ]);

      // Create worktree
      await provider.create(baseRequest);

      // Verify .archon + user files were copied
      expect(copyWorktreeFilesSpy).toHaveBeenCalledWith(
        '/.archon/workspaces/owner/repo',
        expect.stringContaining('issue-42'),
        expect.arrayContaining(['.archon', '.env', '.vscode'])
      );
    });

    test('should deduplicate .archon if user explicitly includes it', async () => {
      // Mock: User config explicitly includes .archon
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'main',
        copyFiles: ['.archon', '.env'],
      });
      provider = new WorktreeProvider(configLoader);

      copyWorktreeFilesSpy.mockResolvedValue([
        { source: '.archon', destination: '.archon' },
        { source: '.env', destination: '.env' },
      ]);

      await provider.create(baseRequest);

      // Verify .archon appears only once (deduplicated by Set)
      const copyFilesArg = copyWorktreeFilesSpy.mock.calls[0][2];
      const archonCount = copyFilesArg.filter((f: string) => f === '.archon').length;
      expect(archonCount).toBe(1);
    });

    test('throws with config error details when config loading fails and no fromBranch', async () => {
      // Mock: Config loading throws error
      const configLoader: RepoConfigLoader = async () => {
        throw new Error('Config parse error');
      };
      provider = new WorktreeProvider(configLoader);

      copyWorktreeFilesSpy.mockResolvedValue([{ source: '.archon', destination: '.archon' }]);

      // Should throw with the actual config error, not generic "no base branch"
      await expect(provider.create(baseRequest)).rejects.toThrow(
        'Failed to load config: Config parse error'
      );
    });
  });

  describe('orphan directory handling', () => {
    let accessSpy: Mock<typeof import('fs/promises').access>;
    let rmSpy: Mock<typeof import('fs/promises').rm>;

    beforeEach(async () => {
      // Dynamic import to mock fs/promises
      const fs = await import('fs/promises');
      accessSpy = spyOn(fs, 'access');
      rmSpy = spyOn(fs, 'rm');

      // Default: directory doesn't exist (use proper NodeJS.ErrnoException)
      const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      });
      accessSpy.mockRejectedValue(enoentError);
      rmSpy.mockResolvedValue(undefined);
    });

    afterEach(() => {
      accessSpy.mockRestore();
      rmSpy.mockRestore();
    });

    test('cleans orphan directory before creating worktree', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '999',
      };

      // Simulate orphan directory: directory exists but not a valid worktree
      accessSpy.mockResolvedValue(undefined); // Directory exists
      worktreeExistsSpy.mockResolvedValue(false); // But not a valid worktree

      const env = await provider.create(request);

      // Verify orphan directory was removed
      expect(rmSpy).toHaveBeenCalledWith(expect.stringContaining('issue-999'), {
        recursive: true,
        force: true,
      });

      // Verify worktree was created
      expect(env.workingPath).toContain('issue-999');
    });

    test('does not remove directory if it is a valid worktree', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '999',
      };

      // Simulate valid worktree: directory exists and IS a valid worktree
      accessSpy.mockResolvedValue(undefined); // Directory exists
      worktreeExistsSpy.mockResolvedValue(true); // And IS a valid worktree (will be adopted)
      mockReadFile.mockResolvedValue('gitdir: /workspace/repo/.git/worktrees/archon/issue-999\n');

      await provider.create(request);

      // Verify directory was NOT removed (should be adopted instead)
      expect(rmSpy).not.toHaveBeenCalled();
    });

    test('cleans orphan directory before creating PR worktree', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true, // Fork PR uses pr-N-review naming
      };

      // Simulate orphan directory: directory exists but not a valid worktree
      accessSpy.mockResolvedValue(undefined); // Directory exists
      worktreeExistsSpy.mockResolvedValue(false); // But not a valid worktree

      const env = await provider.create(request);

      // Verify orphan directory was removed
      expect(rmSpy).toHaveBeenCalledWith(expect.stringContaining('pr-42'), {
        recursive: true,
        force: true,
      });

      // Verify worktree was created
      expect(env.workingPath).toContain('pr-42');
    });

    test('removes remaining directory after git worktree remove', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-999';

      // Mock getCanonicalRepoPath
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      // Simulate directory still exists after git worktree remove
      accessSpy.mockResolvedValue(undefined);

      await provider.destroy(worktreePath);

      // Verify git worktree remove was called
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['-C', '/workspace/repo', 'worktree', 'remove', worktreePath]),
        expect.any(Object)
      );

      // Verify remaining directory was cleaned up
      expect(rmSpy).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
    });

    test('does not try to remove directory if already gone after git worktree remove', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-999';

      // Mock getCanonicalRepoPath
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      // Simulate directory does not exist after git worktree remove
      // Need to create NodeJS.ErrnoException with proper code property
      const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      });
      accessSpy.mockRejectedValue(enoentError);

      await provider.destroy(worktreePath);

      // Verify git worktree remove was NOT called (path doesn't exist)
      // The access check happens first and sets pathExists = false
      expect(execSpy).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object)
      );

      // Verify rm was NOT called (directory already gone)
      expect(rmSpy).not.toHaveBeenCalled();
    });

    test('propagates rm errors during orphan cleanup in create()', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '999',
      };

      // Simulate orphan directory exists
      accessSpy.mockResolvedValue(undefined);
      worktreeExistsSpy.mockResolvedValue(false);
      // rm fails with permission denied
      rmSpy.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      );

      await expect(provider.create(request)).rejects.toThrow('Failed to clean orphan directory');
    });

    test('logs but does not throw when rm fails during post-removal cleanup in destroy()', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-999';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // First access check: path exists
      accessSpy.mockResolvedValueOnce(undefined);
      // git worktree remove succeeds
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });
      // Directory still exists after git remove (directoryExists check)
      accessSpy.mockResolvedValueOnce(undefined);
      // rm fails with permission denied
      rmSpy.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      );

      // Should NOT throw - post-removal cleanup is best-effort
      const result = await provider.destroy(worktreePath);
      expect(result.worktreeRemoved).toBe(true);
      expect(result.directoryClean).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Failed to clean remaining directory');
    });

    test('cleans orphan directory before creating same-repo PR worktree', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: false, // Same-repo PR uses actual branch name
      };

      // Simulate orphan directory: directory exists but not a valid worktree
      accessSpy.mockResolvedValue(undefined);
      worktreeExistsSpy.mockResolvedValue(false);

      const env = await provider.create(request);

      // Verify orphan directory was removed (path uses actual branch name for same-repo PRs)
      // On Windows, path separators are backslashes, so normalize before checking
      const rmPath = (rmSpy.mock.calls[0]?.[0] as string) ?? '';
      expect(rmPath.replace(/\\/g, '/')).toContain('feature/auth');
      expect(rmSpy).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
        force: true,
      });

      // Verify worktree was created with actual branch name
      expect(env.workingPath.replace(/\\/g, '/')).toContain('feature/auth');
    });

    test('cleans directory when git worktree remove fails with "not a working tree"', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-999';

      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      // First access check: path exists
      accessSpy.mockResolvedValueOnce(undefined);
      // git worktree remove fails with "is not a working tree" (matches isWorktreeMissingError)
      execSpy.mockRejectedValueOnce(
        Object.assign(new Error('fatal: /path is not a working tree'), {
          stderr: 'is not a working tree',
        })
      );
      // Directory still exists (directoryExists check after git failure)
      accessSpy.mockResolvedValueOnce(undefined);

      await provider.destroy(worktreePath);

      // Should still clean up the orphan directory
      expect(rmSpy).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true });
    });

    test('throws when directoryExists encounters non-ENOENT error', async () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'issue',
        identifier: '999',
      };

      // Simulate permission error when checking directory
      accessSpy.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      );

      await expect(provider.create(request)).rejects.toThrow('Failed to check directory');
    });

    test('cleans orphaned git-registered worktree when createFromForkPR fails after worktree add', async () => {
      const removeWorktreeSpy = spyOn(git, 'removeWorktree');
      removeWorktreeSpy.mockResolvedValue(undefined);

      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
        prSha: 'abc123',
      };

      // Directory doesn't exist initially (no orphan directory to clean)
      accessSpy.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      // First call: worktreeExists returns false (not adopted)
      // Second call (in cleanup): worktreeExists returns true (orphan exists)
      worktreeExistsSpy
        .mockResolvedValueOnce(false) // findExisting check
        .mockResolvedValueOnce(true); // cleanOrphanWorktreeIfExists check

      // Simulate: fetch succeeds, worktree add succeeds, then checkout -b fails with non-retryable error
      // Note: syncWorkspace and mkdirAsync are separately mocked, so execSpy only sees
      // the git calls inside createFromForkPR
      const checkoutError = new Error('fatal: unable to create branch') as Error & {
        stderr?: string;
      };
      checkoutError.stderr = 'fatal: unable to create branch';
      execSpy
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // fetch origin pull/42/head
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add (succeeds)
        .mockRejectedValueOnce(checkoutError); // checkout -b (fails, non-retryable)

      await expect(provider.create(request)).rejects.toThrow(
        'Failed to create worktree for PR #42'
      );

      // Verify orphan worktree cleanup was attempted
      expect(removeWorktreeSpy).toHaveBeenCalledWith(
        '/workspace/repo',
        expect.stringContaining('pr-42')
      );

      removeWorktreeSpy.mockRestore();
    });

    test('propagates original error when orphan worktree cleanup itself fails', async () => {
      const removeWorktreeSpy = spyOn(git, 'removeWorktree');
      // Cleanup will fail — but original error should still propagate
      removeWorktreeSpy.mockRejectedValue(new Error('worktree is locked'));

      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/workspace/repo',
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'feature/auth',
        isForkPR: true,
        prSha: 'abc123',
      };

      // Directory doesn't exist initially (no orphan directory to clean)
      accessSpy.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      // First call: worktreeExists returns false (not adopted)
      // Second call (in cleanup): worktreeExists returns true (orphan exists)
      worktreeExistsSpy
        .mockResolvedValueOnce(false) // findExisting check
        .mockResolvedValueOnce(true); // cleanOrphanWorktreeIfExists check

      const checkoutError = new Error('fatal: unable to create branch') as Error & {
        stderr?: string;
      };
      checkoutError.stderr = 'fatal: unable to create branch';
      execSpy
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // fetch origin pull/42/head
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree add (succeeds)
        .mockRejectedValueOnce(checkoutError); // checkout -b (fails, non-retryable)

      // Original error still propagates despite cleanup failure
      await expect(provider.create(request)).rejects.toThrow(
        'Failed to create worktree for PR #42'
      );

      // Cleanup was attempted (and failed)
      expect(removeWorktreeSpy).toHaveBeenCalled();

      removeWorktreeSpy.mockRestore();
    });
  });

  describe('workspace sync before worktree creation', () => {
    const baseRequest: IsolationRequest = {
      codebaseId: 'cb-123',
      // Uses full owner/repo path format to test path parsing in createWorktree
      canonicalRepoPath: '/workspace/owner/repo',
      workflowType: 'issue',
      identifier: '42',
    };

    test('does not sync workspace when adopting existing worktree', async () => {
      // Worktree exists - triggers adoption path (skips createWorktree)
      worktreeExistsSpy.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        'gitdir: /workspace/owner/repo/.git/worktrees/archon/issue-42\n'
      );

      await provider.create(baseRequest);

      // Verify sync was NOT called (adoption skips createWorktree entirely)
      expect(syncWorkspaceSpy).not.toHaveBeenCalled();
      expect(getDefaultBranchSpy).not.toHaveBeenCalled();
    });

    test('uses resolved base branch as worktree start-point', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      syncWorkspaceSpy.mockResolvedValue({ branch: 'develop', synced: true });

      const configLoader: RepoConfigLoader = async () => ({ baseBranch: 'develop' });
      provider = new WorktreeProvider(configLoader);

      await provider.create(baseRequest);

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          'worktree',
          'add',
          expect.any(String),
          '-b',
          'archon/issue-42',
          'origin/develop',
        ]),
        expect.any(Object)
      );
    });

    test('auto-detects base branch when no baseBranch configured and no fromBranch', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      const configLoader: RepoConfigLoader = async () => ({});
      provider = new WorktreeProvider(configLoader);

      await provider.create(baseRequest);

      // syncWorkspace called with undefined → triggers auto-detect via getDefaultBranch
      // resetAfterFetch: false because test path is not a managed clone under ~/.archon/workspaces
      expect(syncWorkspaceSpy).toHaveBeenCalledWith('/workspace/owner/repo', undefined, {
        resetAfterFetch: false,
      });
    });

    test('auto-detects base branch when fromBranch is set but no baseBranch configured', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      const configLoader: RepoConfigLoader = async () => ({});
      provider = new WorktreeProvider(configLoader);

      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'task',
        identifier: 'test-feature',
        fromBranch: 'dev',
      };

      await provider.create(request);

      // fromBranch is the start-point for the branch, not for sync — sync auto-detects
      expect(syncWorkspaceSpy).toHaveBeenCalledWith('/workspace/owner/repo', undefined, {
        resetAfterFetch: false,
      });
    });

    test('uses configuredBaseBranch over fromBranch when both are set', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      const configLoader: RepoConfigLoader = async () => ({ baseBranch: 'main' });
      provider = new WorktreeProvider(configLoader);

      const request: IsolationRequest = {
        ...baseRequest,
        workflowType: 'task',
        identifier: 'test-feature',
        fromBranch: 'dev',
      };

      await provider.create(request);

      expect(syncWorkspaceSpy).toHaveBeenCalledWith('/workspace/owner/repo', 'main', {
        resetAfterFetch: false,
      });
    });

    test('auto-detects when fromBranch is set but workflowType is not task and no baseBranch', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      const configLoader: RepoConfigLoader = async () => ({});
      provider = new WorktreeProvider(configLoader);

      // baseRequest has workflowType 'issue', not 'task' — fromBranch is ignored, auto-detects
      const request: IsolationRequest = {
        ...baseRequest,
        fromBranch: 'dev',
      };

      await provider.create(request);

      // fromBranch is ignored for non-task types, so syncWorkspace gets undefined → auto-detect
      expect(syncWorkspaceSpy).toHaveBeenCalledWith('/workspace/owner/repo', undefined, {
        resetAfterFetch: false,
      });
    });

    test('passes configured base branch to workspace sync when provided', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'develop',
      });
      provider = new WorktreeProvider(configLoader);

      await provider.create(baseRequest);

      expect(syncWorkspaceSpy).toHaveBeenCalledWith('/workspace/owner/repo', 'develop', {
        resetAfterFetch: false,
      });
      expect(getDefaultBranchSpy).not.toHaveBeenCalled();
    });

    test('throws when sync fails with network error', async () => {
      syncWorkspaceSpy.mockRejectedValue(new Error('Network error'));
      worktreeExistsSpy.mockResolvedValue(false);

      await expect(provider.create(baseRequest)).rejects.toThrow(
        'Failed to fetch base branch from origin'
      );
    });

    test('throws with config error details when repo config fails to load and no fromBranch', async () => {
      const configLoader: RepoConfigLoader = async () => {
        throw new Error('Config error');
      };
      provider = new WorktreeProvider(configLoader);

      worktreeExistsSpy.mockResolvedValue(false);

      await expect(provider.create(baseRequest)).rejects.toThrow(
        'Failed to load config: Config error'
      );
    });

    test('throws error when configured base branch does not exist', async () => {
      const configLoader: RepoConfigLoader = async () => ({
        baseBranch: 'does-not-exist',
      });
      provider = new WorktreeProvider(configLoader);

      worktreeExistsSpy.mockResolvedValue(false);
      syncWorkspaceSpy.mockRejectedValue(
        new Error(
          "Configured base branch 'does-not-exist' not found on remote. " +
            'Either create the branch, update worktree.baseBranch in .archon/config.yaml, ' +
            'or remove the setting to use the auto-detected default branch.'
        )
      );

      // Configured branch errors should be fatal, not swallowed
      await expect(provider.create(baseRequest)).rejects.toThrow(
        "Configured base branch 'does-not-exist' not found"
      );
    });

    test('throws when network timeout occurs during sync', async () => {
      worktreeExistsSpy.mockResolvedValue(false);
      syncWorkspaceSpy.mockRejectedValue(new Error('Network timeout'));

      await expect(provider.create(baseRequest)).rejects.toThrow(
        'Failed to fetch base branch from origin'
      );
    });
  });

  describe('cross-platform path handling', () => {
    test('getWorktreePath handles Unix-style paths', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/home/dev/.archon/workspaces/owner/repo',
        workflowType: 'issue',
        identifier: '42',
      };
      const branchName = provider.generateBranchName(request);
      const path = provider.getWorktreePath(request, branchName);
      expect(path).toContain('owner');
      expect(path).toContain('repo');
      expect(path).toContain('issue-42');
    });

    test('getWorktreePath handles Windows-style paths', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: 'C:\\Users\\dev\\.archon\\workspaces\\owner\\repo',
        workflowType: 'issue',
        identifier: '42',
      };
      const branchName = provider.generateBranchName(request);
      const path = provider.getWorktreePath(request, branchName);
      expect(path).toContain('owner');
      expect(path).toContain('repo');
      expect(path).toContain('issue-42');
    });

    test('getWorktreePath handles mixed separator paths', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: 'C:/Users/dev\\.archon/workspaces\\owner/repo',
        workflowType: 'issue',
        identifier: '42',
      };
      const branchName = provider.generateBranchName(request);
      const path = provider.getWorktreePath(request, branchName);
      expect(path).toContain('owner');
      expect(path).toContain('repo');
      expect(path).toContain('issue-42');
    });

    test('getWorktreePath throws when repoPath has fewer than 2 segments', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        canonicalRepoPath: '/repo', // only one segment
        workflowType: 'issue',
        identifier: '42',
      };
      const branchName = provider.generateBranchName(request);
      expect(() => provider.getWorktreePath(request, branchName)).toThrow(
        'Cannot extract owner/repo from path "/repo"'
      );
    });

    test('getWorktreePath uses codebaseName for locally-registered repo', () => {
      const request: IsolationRequest = {
        codebaseId: 'cb-123',
        codebaseName: 'Widinglabs/sasha-demo',
        canonicalRepoPath: '/Users/rasmus/Projects/sasha-demo', // not under workspaces
        workflowType: 'task',
        identifier: 'fix-issue-42',
      };
      const branchName = provider.generateBranchName(request);
      const path = provider.getWorktreePath(request, branchName);
      expect(path).toBe(
        join(TEST_ARCHON_HOME, 'workspaces', 'Widinglabs', 'sasha-demo', 'worktrees', branchName)
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Per-repo `worktree.path` override (co-located worktrees opt-in) — #1117 successor
  // ---------------------------------------------------------------------------
  describe('worktree.path repo-local override', () => {
    const baseRequest: IsolationRequest = {
      codebaseId: 'cb-local-1',
      codebaseName: 'owner/myapp',
      canonicalRepoPath: '/Users/dev/Projects/myapp',
      workflowType: 'task',
      identifier: 'add-feature',
    };

    test('uses <repoRoot>/<path>/<branch> when worktree.path is set', () => {
      const branch = provider.generateBranchName(baseRequest);
      const result = provider.getWorktreePath(baseRequest, branch, { path: '.worktrees' });
      expect(result).toBe(join('/Users/dev/Projects/myapp', '.worktrees', branch));
    });

    test('empty / whitespace-only path is ignored and default layout applies', () => {
      const branch = provider.generateBranchName(baseRequest);
      const expectedDefault = join(
        TEST_ARCHON_HOME,
        'workspaces',
        'owner',
        'myapp',
        'worktrees',
        branch
      );
      expect(provider.getWorktreePath(baseRequest, branch, { path: '' })).toBe(expectedDefault);
      expect(provider.getWorktreePath(baseRequest, branch, { path: '   ' })).toBe(expectedDefault);
    });

    test('null / undefined config falls back to workspace-scoped default', () => {
      const branch = provider.generateBranchName(baseRequest);
      const expected = join(TEST_ARCHON_HOME, 'workspaces', 'owner', 'myapp', 'worktrees', branch);
      expect(provider.getWorktreePath(baseRequest, branch, null)).toBe(expected);
      expect(provider.getWorktreePath(baseRequest, branch, undefined)).toBe(expected);
      expect(provider.getWorktreePath(baseRequest, branch)).toBe(expected);
    });

    test('override wins even when repo lives under ~/.archon/workspaces/', () => {
      // Precedence contract: per-repo `worktree.path` is the highest layer.
      // A repo that would normally land in workspaces/owner/repo/worktrees/
      // still gets a repo-local worktree when the config opts in.
      const request: IsolationRequest = {
        codebaseId: 'cb-local-2',
        codebaseName: 'owner/repo',
        canonicalRepoPath: join(TEST_ARCHON_HOME, 'workspaces', 'owner', 'repo'),
        workflowType: 'task',
        identifier: 'my-task',
      };
      const branch = provider.generateBranchName(request);
      const result = provider.getWorktreePath(request, branch, { path: 'worktrees-local' });
      expect(result).toBe(
        join(TEST_ARCHON_HOME, 'workspaces', 'owner', 'repo', 'worktrees-local', branch)
      );
    });

    test('rejects an absolute worktree.path with a clear error', () => {
      const branch = provider.generateBranchName(baseRequest);
      expect(() =>
        provider.getWorktreePath(baseRequest, branch, { path: '/tmp/worktrees' })
      ).toThrow(/must be relative to the repo root/);
    });

    test('rejects a worktree.path that escapes the repo root via `..`', () => {
      const branch = provider.generateBranchName(baseRequest);
      expect(() => provider.getWorktreePath(baseRequest, branch, { path: '../worktrees' })).toThrow(
        /must stay within the repo/
      );
      expect(() => provider.getWorktreePath(baseRequest, branch, { path: '..' })).toThrow(
        /must stay within the repo/
      );
      expect(() =>
        provider.getWorktreePath(baseRequest, branch, { path: 'nested/../../escape' })
      ).toThrow(/must stay within the repo/);
    });

    test('accepts a nested relative path without `..`', () => {
      const branch = provider.generateBranchName(baseRequest);
      const result = provider.getWorktreePath(baseRequest, branch, {
        path: '.archon/worktrees',
      });
      expect(result).toBe(join('/Users/dev/Projects/myapp', '.archon/worktrees', branch));
    });
  });

  // ---------------------------------------------------------------------------
  // Additional lifecycle method tests
  // ---------------------------------------------------------------------------

  describe('destroy() — additional scenarios', () => {
    test('branchDeleted is true when branch already gone ("not found" error)', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('branch') && args.includes('-D')) {
          const error = new Error('error: branch not found') as Error & { stderr?: string };
          error.stderr = "error: branch 'issue-42' not found";
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      const result = await provider.destroy(worktreePath, { branchName: 'issue-42' });

      expect(result.worktreeRemoved).toBe(true);
      // "not found" counts as already deleted — should be true, not false
      expect(result.branchDeleted).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('branchDeleted is true when branch already gone ("did not match any" error)', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-42';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('branch') && args.includes('-D')) {
          const error = new Error('error: did not match any branch') as Error & {
            stderr?: string;
          };
          error.stderr = "error: branch 'issue-42' did not match any branch known to git";
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      const result = await provider.destroy(worktreePath, { branchName: 'issue-42' });

      expect(result.branchDeleted).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('remoteBranchDeleted is true when remote ref not found via "couldn\'t find remote ref"', async () => {
      const worktreePath = '/workspace/worktrees/repo/feature-x';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('push') && args.includes('--delete')) {
          const error = new Error('error: remote operation failed') as Error & { stderr?: string };
          error.stderr = "error: unable to delete 'feature-x': couldn't find remote ref feature-x";
          throw error;
        }
        return { stdout: '', stderr: '' };
      });

      const result = await provider.destroy(worktreePath, {
        branchName: 'feature-x',
        deleteRemoteBranch: true,
      });

      // "couldn't find remote ref" means already gone — treated as success
      expect(result.remoteBranchDeleted).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('all options together: force + branchName + deleteRemoteBranch', async () => {
      const worktreePath = '/workspace/worktrees/repo/feature-y';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      const result = await provider.destroy(worktreePath, {
        force: true,
        branchName: 'feature-y',
        deleteRemoteBranch: true,
      });

      // Verify --force flag included in worktree remove
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          '-C',
          '/workspace/repo',
          'worktree',
          'remove',
          '--force',
          worktreePath,
        ]),
        expect.any(Object)
      );

      // Verify local branch deletion
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', 'feature-y'],
        expect.any(Object)
      );

      // Verify remote branch deletion
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'push', 'origin', '--delete', 'feature-y'],
        expect.any(Object)
      );

      expect(result.worktreeRemoved).toBe(true);
      expect(result.branchDeleted).toBe(true);
      expect(result.remoteBranchDeleted).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    test('deletes remote branch via canonicalRepoPath when worktree path is already gone', async () => {
      const worktreePath = '/workspace/worktrees/repo/feature-z';
      const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      });
      mockAccess.mockRejectedValueOnce(enoentError);

      const result = await provider.destroy(worktreePath, {
        branchName: 'feature-z',
        deleteRemoteBranch: true,
        canonicalRepoPath: '/workspace/repo',
      });

      // No worktree remove (path gone)
      expect(execSpy).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object)
      );

      // Local branch deleted using provided canonicalRepoPath
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'branch', '-D', 'feature-z'],
        expect.any(Object)
      );

      // Remote branch deleted using provided canonicalRepoPath
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'push', 'origin', '--delete', 'feature-z'],
        expect.any(Object)
      );

      expect(result.worktreeRemoved).toBe(true); // Already gone counts as removed
      expect(result.branchDeleted).toBe(true);
      expect(result.remoteBranchDeleted).toBe(true);
    });

    test('result has correct shape on minimal destroy (no options)', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-1';
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');

      const result = await provider.destroy(worktreePath);

      expect(result).toMatchObject({
        worktreeRemoved: true,
        branchDeleted: null,
        remoteBranchDeleted: null,
        directoryClean: true,
        warnings: [],
      });
    });
  });

  describe('get() — environment shape', () => {
    test('returned environment has correct id, workingPath, provider, status, and metadata', async () => {
      const worktreePath = '/workspace/worktrees/repo/issue-55';
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: worktreePath, branch: 'issue-55' },
      ]);

      const result = await provider.get(worktreePath);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(worktreePath);
      expect(result!.workingPath).toBe(worktreePath);
      expect(result!.provider).toBe('worktree');
      expect(result!.status).toBe('active');
      expect(result!.branchName).toBe('issue-55');
      expect(result!.metadata).toEqual({ adopted: false });
      expect(result!.createdAt).toBeInstanceOf(Date);
    });

    test('returned environment branchName matches worktree branch with slashes', async () => {
      const worktreePath = '/workspace/worktrees/repo/feature-auth';
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: worktreePath, branch: 'feature/auth' },
      ]);

      const result = await provider.get(worktreePath);

      expect(result).not.toBeNull();
      expect(result!.branchName).toBe('feature/auth');
    });
  });

  describe('list() — environment shape', () => {
    test('each listed environment has correct provider, status, and metadata shape', async () => {
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: '/workspace/worktrees/repo/issue-10', branch: 'issue-10' },
        { path: '/workspace/worktrees/repo/issue-20', branch: 'issue-20' },
      ]);

      const results = await provider.list('/workspace/repo');

      expect(results).toHaveLength(2);
      for (const env of results) {
        expect(env.provider).toBe('worktree');
        expect(env.status).toBe('active');
        expect(env.metadata).toEqual({ adopted: false });
        expect(env.createdAt).toBeInstanceOf(Date);
      }
    });

    test('id and workingPath equal the worktree path for each entry', async () => {
      const path1 = '/workspace/worktrees/repo/issue-10';
      const path2 = '/workspace/worktrees/repo/pr-99';
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: path1, branch: 'issue-10' },
        { path: path2, branch: 'pr-99' },
      ]);

      const results = await provider.list('/workspace/repo');

      expect(results[0].id).toBe(path1);
      expect(results[0].workingPath).toBe(path1);
      expect(results[1].id).toBe(path2);
      expect(results[1].workingPath).toBe(path2);
    });

    test('returns empty array when listWorktrees returns only main repo entry', async () => {
      listWorktreesSpy.mockResolvedValue([{ path: '/workspace/repo', branch: 'main' }]);

      const results = await provider.list('/workspace/repo');

      expect(results).toEqual([]);
    });

    test('returns empty array when listWorktrees returns empty list', async () => {
      // Edge case: git returns nothing at all (unusual but handled)
      listWorktreesSpy.mockResolvedValue([]);

      const results = await provider.list('/workspace/repo');

      expect(results).toEqual([]);
    });
  });

  describe('adopt() — environment shape', () => {
    test('returned environment has id equal to the provided path', async () => {
      const adoptPath = '/workspace/worktrees/repo/feature-auth';
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: adoptPath, branch: 'feature/auth' },
      ]);

      const result = await provider.adopt(adoptPath);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(adoptPath);
      expect(result!.workingPath).toBe(adoptPath);
    });

    test('returned environment has correct status, provider, and createdAt', async () => {
      const adoptPath = '/workspace/worktrees/repo/task-my-task';
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: adoptPath, branch: 'task-my-task' },
      ]);

      const result = await provider.adopt(adoptPath);

      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
      expect(result!.provider).toBe('worktree');
      expect(result!.metadata).toEqual({ adopted: true });
      expect(result!.createdAt).toBeInstanceOf(Date);
    });

    test('adopt sets metadata.adopted to true (not false)', async () => {
      const adoptPath = '/workspace/worktrees/repo/review-7';
      worktreeExistsSpy.mockResolvedValue(true);
      getCanonicalRepoPathSpy.mockResolvedValue('/workspace/repo');
      listWorktreesSpy.mockResolvedValue([
        { path: '/workspace/repo', branch: 'main' },
        { path: adoptPath, branch: 'review-7' },
      ]);

      const result = await provider.adopt(adoptPath);

      // Distinguishes adopted environments from created ones
      expect(result!.metadata.adopted).toBe(true);
    });
  });

  describe('healthCheck() — error propagation', () => {
    test('propagates I/O errors from worktreeExists (permission denied)', async () => {
      // worktreeExists throws for permission errors (only returns false for ENOENT)
      worktreeExistsSpy.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied, access'), { code: 'EACCES' })
      );

      await expect(provider.healthCheck('/workspace/worktrees/repo/issue-42')).rejects.toThrow(
        'EACCES'
      );
    });

    test('delegates directly to worktreeExists with the provided path', async () => {
      const envId = '/workspace/worktrees/repo/pr-99';
      worktreeExistsSpy.mockResolvedValue(true);

      await provider.healthCheck(envId);

      // healthCheck wraps the path in toWorktreePath before calling worktreeExists
      expect(worktreeExistsSpy).toHaveBeenCalledTimes(1);
    });
  });
});

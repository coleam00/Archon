import { describe, test, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import { writeFile, mkdir as realMkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// ---------------------------------------------------------------------------
// Mock @archon/paths: suppress logger, pass-through path functions
// ---------------------------------------------------------------------------
// Re-implement the path helpers inline so the mock doesn't depend on the real
// module (mock.module replaces the *entire* module).  The path functions are
// trivial join() wrappers driven by env-vars, so duplication is acceptable.
// ---------------------------------------------------------------------------
interface MockLogger {
  fatal: ReturnType<typeof mock>;
  error: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  info: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  trace: ReturnType<typeof mock>;
  child: ReturnType<typeof mock>;
}

function createMockLogger(): MockLogger {
  const logger: MockLogger = {
    fatal: mock(() => undefined),
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
    debug: mock(() => undefined),
    trace: mock(() => undefined),
    child: mock(() => logger),
  };
  return logger;
}

const mockLogger = createMockLogger();

/** Mirror of @archon/paths getArchonHome (reads env at call-time) */
function getArchonHome(): string {
  if (
    process.env.WORKSPACE_PATH === '/workspace' ||
    (process.env.HOME === '/root' && Boolean(process.env.WORKSPACE_PATH)) ||
    process.env.ARCHON_DOCKER === 'true'
  ) {
    return '/.archon';
  }
  return process.env.ARCHON_HOME ?? join(homedir(), '.archon');
}

mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonWorktreesPath: () => join(getArchonHome(), 'worktrees'),
  getArchonWorkspacesPath: () => join(getArchonHome(), 'workspaces'),
  getProjectWorktreesPath: (owner: string, repo: string) =>
    join(getArchonHome(), 'workspaces', owner, repo, 'worktrees'),
}));

// ---------------------------------------------------------------------------
// Import modules AFTER mocking
// ---------------------------------------------------------------------------
import * as git from './index';

// ============================================================================
// Tests
// ============================================================================

describe('git utilities', () => {
  const testDir = join(tmpdir(), 'git-utils-test-' + Date.now());

  beforeEach(async () => {
    await realMkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // worktree.ts
  // ==========================================================================

  describe('isWorktreePath', () => {
    test('returns false for directory without .git', async () => {
      const result = await git.isWorktreePath(testDir);
      expect(result).toBe(false);
    });

    test('returns false for main repo (.git directory)', async () => {
      await realMkdir(join(testDir, '.git'));
      const result = await git.isWorktreePath(testDir);
      expect(result).toBe(false);
    });

    test('returns true for worktree (.git file with gitdir)', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: /some/repo/.git/worktrees/branch-name');
      const result = await git.isWorktreePath(testDir);
      expect(result).toBe(true);
    });

    test('returns false for .git file without gitdir prefix', async () => {
      await writeFile(join(testDir, '.git'), 'some other content');
      const result = await git.isWorktreePath(testDir);
      expect(result).toBe(false);
    });

    test('throws and logs for permission errors (EACCES)', async () => {
      const testPath = join(testDir, 'permission-test');
      await realMkdir(testPath, { recursive: true });

      const fsPromises = await import('fs/promises');
      const readFileSpy = spyOn(fsPromises, 'readFile');
      mockLogger.error.mockClear();
      const eaccesError = new Error('Permission denied') as NodeJS.ErrnoException;
      eaccesError.code = 'EACCES';
      readFileSpy.mockRejectedValue(eaccesError);

      try {
        await expect(git.isWorktreePath(testPath)).rejects.toThrow(
          `Cannot determine if ${testPath} is a worktree: Permission denied`
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            path: testPath,
            code: 'EACCES',
          }),
          'worktree_status_check_failed'
        );
      } finally {
        readFileSpy.mockRestore();
      }
    });
  });

  describe('getCanonicalRepoPath', () => {
    test('returns same path for non-worktree', async () => {
      const result = await git.getCanonicalRepoPath(testDir);
      expect(result).toBe(testDir);
    });

    test('returns same path for main repo with .git directory', async () => {
      await realMkdir(join(testDir, '.git'));
      const result = await git.getCanonicalRepoPath(testDir);
      expect(result).toBe(testDir);
    });

    test('extracts main repo path from worktree', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: /workspace/my-repo/.git/worktrees/issue-42');
      const result = await git.getCanonicalRepoPath(testDir);
      expect(result).toBe('/workspace/my-repo');
    });

    test('handles worktree path with nested directories', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /home/user/projects/my-app/.git/worktrees/feature-branch'
      );
      const result = await git.getCanonicalRepoPath(testDir);
      expect(result).toBe('/home/user/projects/my-app');
    });
  });

  describe('getWorktreeBase', () => {
    const originalEnv = process.env.WORKTREE_BASE;
    const originalWorkspacePath = process.env.WORKSPACE_PATH;
    const originalHome = process.env.HOME;
    const originalArchonHome = process.env.ARCHON_HOME;
    const originalArchonDocker = process.env.ARCHON_DOCKER;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.WORKTREE_BASE;
      } else {
        process.env.WORKTREE_BASE = originalEnv;
      }
      if (originalWorkspacePath === undefined) {
        delete process.env.WORKSPACE_PATH;
      } else {
        process.env.WORKSPACE_PATH = originalWorkspacePath;
      }
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalArchonHome;
      }
      if (originalArchonDocker === undefined) {
        delete process.env.ARCHON_DOCKER;
      } else {
        process.env.ARCHON_DOCKER = originalArchonDocker;
      }
    });

    test('returns workspace-scoped base for a local non-workspace repo (via path fallback)', () => {
      // New-model invariant: every repo resolves to workspace-scoped. For a repo
      // living outside ~/.archon/workspaces/, owner/repo is derived from the last
      // two path segments (extractOwnerRepo) so the worktree base is still stable.
      delete process.env.WORKTREE_BASE;
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      const result = git.getWorktreeBase('/workspace/my-repo');
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', 'workspace', 'my-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('uses ARCHON_HOME for the workspace-scoped base (local non-Docker)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      const result = git.getWorktreeBase('/workspace/my-repo');
      expect(result).toEqual({
        base: join('/custom/archon', 'workspaces', 'workspace', 'my-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('uses the Docker archon home for the workspace-scoped base', () => {
      delete process.env.ARCHON_HOME;
      process.env.ARCHON_DOCKER = 'true';
      const result = git.getWorktreeBase('/workspace/my-repo');
      expect(result).toEqual({
        base: join('/', '.archon', 'workspaces', 'workspace', 'my-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('returns workspace-scoped path when repo is already under workspaces/', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      const repoPath = join(workspacesPath, 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repoPath);
      expect(result).toEqual({
        base: join(workspacesPath, 'acme', 'widget', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('workspace-scoped path honors ARCHON_HOME override', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = join('/', 'custom', 'archon');
      const repoPath = join('/', 'custom', 'archon', 'workspaces', 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repoPath);
      expect(result).toEqual({
        base: join('/', 'custom', 'archon', 'workspaces', 'acme', 'widget', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('uses codebaseName to resolve workspace-scoped path for a local repo', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const localRepoPath = '/Users/rasmus/Projects/sasha-demo';
      const result = git.getWorktreeBase(localRepoPath, 'Widinglabs/sasha-demo');
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', 'Widinglabs', 'sasha-demo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('codebaseName takes priority over workspaces path detection', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      const repoPath = join(workspacesPath, 'old-owner', 'old-repo', 'source');
      const result = git.getWorktreeBase(repoPath, 'new-owner/new-repo');
      expect(result).toEqual({
        base: join(workspacesPath, 'new-owner', 'new-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('ignores invalid codebaseName and falls back to path-derived owner/repo', () => {
      // "invalid-no-slash" doesn't parse as owner/repo; the layout still resolves
      // to workspace-scoped using the last two segments of the repoPath.
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const result = git.getWorktreeBase('/local/repo', 'invalid-no-slash');
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', 'local', 'repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('repoLocal override wins over workspace-scoped default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const repoPath = '/Users/rasmus/Projects/myapp';
      const result = git.getWorktreeBase(repoPath, undefined, { repoLocal: '.worktrees' });
      expect(result).toEqual({
        base: join(repoPath, '.worktrees'),
        layout: 'repo-local',
      });
    });

    test('repoLocal override wins even for repos under workspaces/', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      const repoPath = join(workspacesPath, 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repoPath, 'acme/widget', { repoLocal: '.wt' });
      expect(result).toEqual({
        base: join(repoPath, '.wt'),
        layout: 'repo-local',
      });
    });
  });

  describe('isProjectScopedWorktreeBase (deprecated)', () => {
    const originalArchonHome = process.env.ARCHON_HOME;
    const originalWorkspacePath = process.env.WORKSPACE_PATH;
    const originalArchonDocker = process.env.ARCHON_DOCKER;

    afterEach(() => {
      if (originalArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalArchonHome;
      }
      if (originalWorkspacePath === undefined) {
        delete process.env.WORKSPACE_PATH;
      } else {
        process.env.WORKSPACE_PATH = originalWorkspacePath;
      }
      if (originalArchonDocker === undefined) {
        delete process.env.ARCHON_DOCKER;
      } else {
        process.env.ARCHON_DOCKER = originalArchonDocker;
      }
    });

    test('returns true for path under workspaces with owner/repo', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      expect(
        git.isProjectScopedWorktreeBase(join(workspacesPath, 'acme', 'widget', 'source'))
      ).toBe(true);
    });

    test('returns true for a local non-workspace path (new two-layout model)', () => {
      // In the pre-refactor three-layout model, this returned false (legacy global).
      // Under the two-layout model every repo is workspace-scoped unless a
      // `repoLocal` override is supplied, which this helper does not accept.
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      expect(git.isProjectScopedWorktreeBase('/workspace/my-repo')).toBe(true);
    });

    test('returns true when codebaseName is provided (local repo)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      expect(git.isProjectScopedWorktreeBase('/Users/rasmus/Projects/repo', 'owner/repo')).toBe(
        true
      );
    });

    test('returns true when codebaseName is invalid (falls back to path-derived)', () => {
      // Under the two-layout model the helper always returns true for any resolvable
      // owner/repo. Invalid codebaseName + valid repo path → still workspace-scoped.
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      expect(git.isProjectScopedWorktreeBase('/local/repo', 'invalid')).toBe(true);
    });
  });

  describe('extractOwnerRepo', () => {
    test('extracts owner and repo from a multi-segment path', () => {
      const result = git.extractOwnerRepo(git.toRepoPath('/home/user/owner/repo'));
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    test('extracts owner and repo from exactly 2-segment path', () => {
      const result = git.extractOwnerRepo(git.toRepoPath('/owner/repo'));
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    test('extracts owner and repo from Windows-style path', () => {
      const result = git.extractOwnerRepo(
        'C:\\Users\\dev\\owner\\repo' as ReturnType<typeof git.toRepoPath>
      );
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    test('throws when repoPath has fewer than 2 segments', () => {
      expect(() => git.extractOwnerRepo(git.toRepoPath('/repo'))).toThrow(
        'Cannot extract owner/repo from path "/repo"'
      );
    });

    test('throws when repoPath is empty', () => {
      expect(() => git.extractOwnerRepo('' as ReturnType<typeof git.toRepoPath>)).toThrow(
        'Cannot extract owner/repo from path ""'
      );
    });
  });

  describe('worktreeExists', () => {
    test('returns true when path and .git exist', async () => {
      await realMkdir(join(testDir, 'worktree-test'), { recursive: true });
      await writeFile(join(testDir, 'worktree-test', '.git'), 'gitdir: /some/path');

      const result = await git.worktreeExists(join(testDir, 'worktree-test'));
      expect(result).toBe(true);
    });

    test('returns false when path does not exist', async () => {
      const result = await git.worktreeExists(join(testDir, 'nonexistent'));
      expect(result).toBe(false);
    });

    test('returns false and logs warning when directory exists but .git is missing (corruption)', async () => {
      await realMkdir(join(testDir, 'no-git'), { recursive: true });
      mockLogger.warn.mockClear();

      const result = await git.worktreeExists(join(testDir, 'no-git'));
      expect(result).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: join(testDir, 'no-git'),
        }),
        'worktree.corruption_detected'
      );
    });

    test('throws and logs for permission errors (EACCES)', async () => {
      const testPath = join(testDir, 'permission-denied');
      await realMkdir(testPath, { recursive: true });

      const fsPromises = await import('fs/promises');
      const accessSpy = spyOn(fsPromises, 'access');
      mockLogger.error.mockClear();
      const eaccesError = new Error('Permission denied') as NodeJS.ErrnoException;
      eaccesError.code = 'EACCES';
      accessSpy.mockRejectedValue(eaccesError);

      try {
        await expect(git.worktreeExists(testPath)).rejects.toThrow(
          `Failed to check worktree at ${testPath}: Permission denied`
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            worktreePath: testPath,
            code: 'EACCES',
          }),
          'worktree.existence_check_failed'
        );
      } finally {
        accessSpy.mockRestore();
      }
    });
  });

  describe('listWorktrees', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('parses git worktree list --porcelain output', async () => {
      const mockOutput = `worktree /path/to/main
HEAD abc123
branch refs/heads/main

worktree /path/to/feature
HEAD def456
branch refs/heads/feature/auth

`;
      execSpy.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await git.listWorktrees('/path/to/main');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ path: '/path/to/main', branch: 'main' });
      expect(result[1]).toEqual({ path: '/path/to/feature', branch: 'feature/auth' });
    });

    test('returns empty array for "not a git repository" error', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
    });

    test('returns empty array and logs warning for "No such file or directory" error', async () => {
      execSpy.mockRejectedValue(new Error('No such file or directory'));
      mockLogger.warn.mockClear();

      const result = await git.listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ repoPath: '/path/to/repo' }),
        'worktree.list_repo_missing'
      );
    });

    test('throws for unexpected errors', async () => {
      execSpy.mockRejectedValue(new Error('git not found'));

      await expect(git.listWorktrees('/path/to/repo')).rejects.toThrow(
        'Failed to list worktrees for /path/to/repo: git not found'
      );
    });

    test('returns empty array when expected error pattern is in stderr', async () => {
      const error = new Error('Command failed') as Error & { stderr?: string };
      error.stderr = 'fatal: not a git repository (or any parent up to mount point /)';
      execSpy.mockRejectedValue(error);

      const result = await git.listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
    });

    test('returns empty array and logs warning when "No such file or directory" is in stderr', async () => {
      const error = new Error('Command failed') as Error & { stderr?: string };
      error.stderr = 'No such file or directory';
      execSpy.mockRejectedValue(error);
      mockLogger.warn.mockClear();

      const result = await git.listWorktrees('/path/to/repo');
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ repoPath: '/path/to/repo' }),
        'worktree.list_repo_missing'
      );
    });

    test('throws and logs for unexpected git errors', async () => {
      const mockError = new Error('permission denied') as Error & { stderr?: string };
      mockError.stderr = 'fatal: permission denied';
      execSpy.mockRejectedValue(mockError);
      mockLogger.error.mockClear();

      await expect(git.listWorktrees('/path/to/repo')).rejects.toThrow('Failed to list worktrees');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/path/to/repo',
          stderr: 'fatal: permission denied',
        }),
        'worktree.list_failed'
      );
    });
  });

  describe('findWorktreeByBranch', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
      const mockOutput = `worktree /workspace/main
HEAD abc123
branch refs/heads/main

worktree /workspace/worktrees/feature-auth
HEAD def456
branch refs/heads/feature/auth

`;
      execSpy.mockResolvedValue({ stdout: mockOutput, stderr: '' });
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('finds exact branch match', async () => {
      const result = await git.findWorktreeByBranch('/workspace/main', 'feature/auth');
      expect(result).toBe('/workspace/worktrees/feature-auth');
    });

    test('finds slugified branch match', async () => {
      const result = await git.findWorktreeByBranch('/workspace/main', 'feature-auth');
      expect(result).toBe('/workspace/worktrees/feature-auth');
    });

    test('returns null when no match', async () => {
      const result = await git.findWorktreeByBranch('/workspace/main', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // branch.ts
  // ==========================================================================

  describe('checkout', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('checks out existing branch successfully', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.checkout('/workspace/repo', 'feature-branch');

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'checkout', 'feature-branch'],
        {
          timeout: 30000,
        }
      );
    });

    test('creates branch on "pathspec" error', async () => {
      execSpy.mockRejectedValueOnce(
        Object.assign(new Error('pathspec did not match'), {
          stderr: "error: pathspec 'new-branch' did not match any file(s) known to git",
        })
      );
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await git.checkout('/workspace/repo', 'new-branch');

      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(execSpy).toHaveBeenLastCalledWith(
        'git',
        ['-C', '/workspace/repo', 'checkout', '-b', 'new-branch'],
        {
          timeout: 30000,
        }
      );
    });

    test('creates branch on "doesn\'t exist" error', async () => {
      execSpy.mockRejectedValueOnce(
        Object.assign(new Error("branch doesn't exist"), {
          stderr: "error: branch 'new-branch' doesn't exist",
        })
      );
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await git.checkout('/workspace/repo', 'new-branch');

      expect(execSpy).toHaveBeenCalledTimes(2);
      expect(execSpy).toHaveBeenLastCalledWith(
        'git',
        ['-C', '/workspace/repo', 'checkout', '-b', 'new-branch'],
        {
          timeout: 30000,
        }
      );
    });

    test('throws and logs on unexpected error', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(
        Object.assign(new Error('Permission denied'), { stderr: 'fatal: Permission denied' })
      );

      await expect(git.checkout('/workspace/repo', 'some-branch')).rejects.toThrow(
        'Failed to checkout branch some-branch: Permission denied'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/workspace/repo',
          branchName: 'some-branch',
        }),
        'checkout_failed'
      );
    });
  });

  describe('hasUncommittedChanges', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns true when there are uncommitted changes', async () => {
      execSpy.mockResolvedValue({ stdout: ' M file.ts\n?? newfile.ts\n', stderr: '' });

      const result = await git.hasUncommittedChanges('/workspace/repo');

      expect(result).toBe(true);
      expect(execSpy).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/repo',
        'status',
        '--porcelain',
      ]);
    });

    test('returns false when working tree is clean', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.hasUncommittedChanges('/workspace/repo');

      expect(result).toBe(false);
    });

    test('returns false when output is only whitespace', async () => {
      execSpy.mockResolvedValue({ stdout: '   \n\n', stderr: '' });

      const result = await git.hasUncommittedChanges('/workspace/repo');

      expect(result).toBe(false);
    });

    test('returns false when path does not exist (ENOENT)', async () => {
      const error = new Error('No such file or directory') as Error & { code: string };
      error.code = 'ENOENT';
      execSpy.mockRejectedValue(error);

      const result = await git.hasUncommittedChanges('/nonexistent');

      expect(result).toBe(false);
    });

    test('returns true (fail-safe) when git fails with unexpected error', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.hasUncommittedChanges('/workspace/corrupted');

      expect(result).toBe(true);
    });

    test('returns true (fail-safe) when git lock file exists', async () => {
      execSpy.mockRejectedValue(new Error('Another git process seems to be running'));

      const result = await git.hasUncommittedChanges('/workspace/locked');

      expect(result).toBe(true);
    });
  });

  describe('getDefaultBranch', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns branch from symbolic-ref (origin/main)', async () => {
      execSpy.mockResolvedValue({ stdout: 'origin/main\n', stderr: '' });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('main');
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
        expect.any(Object)
      );
    });

    test('returns branch from symbolic-ref (origin/master)', async () => {
      execSpy.mockResolvedValue({ stdout: 'origin/master\n', stderr: '' });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('master');
    });

    test('returns non-standard branch from symbolic-ref (origin/develop)', async () => {
      execSpy.mockResolvedValue({ stdout: 'origin/develop\n', stderr: '' });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('develop');
    });

    test('returns non-standard branch from symbolic-ref (origin/trunk)', async () => {
      execSpy.mockResolvedValue({ stdout: 'origin/trunk\n', stderr: '' });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('trunk');
    });

    test('falls back to main if symbolic-ref fails and origin/main exists', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'abc123\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.getDefaultBranch('/workspace/repo');

      expect(result).toBe('main');
    });

    test('throws when symbolic-ref fails and origin/main does not exist', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          throw new Error('fatal: Not a valid object name');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.getDefaultBranch('/workspace/repo')).rejects.toThrow(
        'Cannot detect default branch for /workspace/repo'
      );
      // Verify the error includes actionable config hint
      await expect(git.getDefaultBranch('/workspace/repo')).rejects.toThrow('config.yaml');
    });

    test('throws for unexpected symbolic-ref errors (permission denied)', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.getDefaultBranch('/workspace/repo')).rejects.toThrow(
        'Failed to get default branch for /workspace/repo: fatal: permission denied'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/workspace/repo',
        }),
        'default_branch_symbolic_ref_failed'
      );
    });

    test('throws for unexpected rev-parse errors (permission denied)', async () => {
      mockLogger.error.mockClear();
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
        }
        if (args.includes('rev-parse')) {
          throw new Error('fatal: permission denied');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.getDefaultBranch('/workspace/repo')).rejects.toThrow(
        'Failed to get default branch for /workspace/repo: fatal: permission denied'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/workspace/repo',
        }),
        'verify_origin_main_failed'
      );
    });

    test('throws for "unknown revision" error when origin/main missing', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref');
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          throw new Error("fatal: unknown revision or path 'origin/main'");
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.getDefaultBranch('/workspace/repo')).rejects.toThrow(
        'Cannot detect default branch for /workspace/repo'
      );
      // Verify the error includes actionable config hint
      await expect(git.getDefaultBranch('/workspace/repo')).rejects.toThrow('config.yaml');
    });
  });

  describe('commitAllChanges', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('commits when there are uncommitted changes', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.commitAllChanges('/workspace/repo', 'test commit');

      expect(result).toBe(true);
      expect(execSpy).toHaveBeenCalledWith('git', ['-C', '/workspace/repo', 'add', '-A'], {
        timeout: 10000,
      });
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'commit', '-m', 'test commit'],
        { timeout: 10000 }
      );
    });

    test('returns false when no changes to commit', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.commitAllChanges('/workspace/repo', 'test commit');

      expect(result).toBe(false);
      expect(execSpy).toHaveBeenCalledTimes(1); // only hasUncommittedChanges
    });

    test('returns false when git commit finds nothing to commit after add (CRLF normalization)', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          // git status shows modified files (e.g. CRLF vs LF on Windows)
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        if (args.includes('add')) {
          return { stdout: '', stderr: '' };
        }
        if (args.includes('commit')) {
          // git commit exits 1 with "nothing to commit" on stdout (not stderr)
          const err = Object.assign(new Error('Command failed: git commit'), {
            stdout: 'On branch main\nnothing to commit, working tree clean\n',
            stderr: '',
          });
          throw err;
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.commitAllChanges('/workspace/repo', 'test commit');

      expect(result).toBe(false);
      expect(execSpy).toHaveBeenCalledTimes(3); // status + add + commit
    });

    test('throws error when git add fails', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        if (args.includes('add')) {
          throw new Error('git add failed');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.commitAllChanges('/workspace/repo', 'test commit')).rejects.toThrow(
        'git add failed'
      );
    });

    test('throws error when git commit fails', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        if (args.includes('add')) {
          return { stdout: '', stderr: '' };
        }
        if (args.includes('commit')) {
          throw new Error('pre-commit hook failed');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.commitAllChanges('/workspace/repo', 'test commit')).rejects.toThrow(
        'pre-commit hook failed'
      );
    });
  });

  describe('isBranchMerged', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns true when branch is merged', async () => {
      execSpy.mockResolvedValue({
        stdout: '  feature-branch\n* main\n  other-branch\n',
        stderr: '',
      });

      const result = await git.isBranchMerged('/workspace/repo', 'feature-branch', 'main');
      expect(result).toBe(true);
    });

    test('returns false when branch is not merged', async () => {
      execSpy.mockResolvedValue({
        stdout: '* main\n  other-branch\n',
        stderr: '',
      });

      const result = await git.isBranchMerged('/workspace/repo', 'feature-branch', 'main');
      expect(result).toBe(false);
    });

    test('handles branches with / characters', async () => {
      execSpy.mockResolvedValue({
        stdout: '  feature/auth\n* main\n',
        stderr: '',
      });

      const result = await git.isBranchMerged('/workspace/repo', 'feature/auth', 'main');
      expect(result).toBe(true);
    });

    test('returns false on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.isBranchMerged('/workspace/repo', 'feature', 'main');
      expect(result).toBe(false);
    });

    test('throws and logs on unexpected errors', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.isBranchMerged('/workspace/repo', 'feature', 'main')).rejects.toThrow(
        'Failed to check if feature is merged into main'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          repoPath: '/workspace/repo',
          branchName: 'feature',
          mainBranch: 'main',
        }),
        'branch_merge_check_failed'
      );
    });

    test('uses provided mainBranch parameter', async () => {
      execSpy.mockResolvedValue({ stdout: '* develop\n  feature\n', stderr: '' });

      const result = await git.isBranchMerged('/workspace/repo', 'feature', 'develop');

      expect(execSpy).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/repo',
        'branch',
        '--merged',
        'develop',
      ]);
      expect(result).toBe(true);
    });

    test('strips current-branch marker (*) from output', async () => {
      execSpy.mockResolvedValue({
        stdout: '* main\n  feature\n',
        stderr: '',
      });

      const result = await git.isBranchMerged('/workspace/repo', 'main', 'main');
      expect(result).toBe(true);
    });
  });

  describe('isPatchEquivalent', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns true when all cherry lines start with -', async () => {
      execSpy.mockResolvedValue({ stdout: '- abc123\n- def456\n', stderr: '' });
      const result = await git.isPatchEquivalent('/workspace/repo', 'feature', 'main');
      expect(result).toBe(true);
    });

    test('returns false when any cherry line starts with +', async () => {
      execSpy.mockResolvedValue({ stdout: '- abc123\n+ def456\n', stderr: '' });
      const result = await git.isPatchEquivalent('/workspace/repo', 'feature', 'main');
      expect(result).toBe(false);
    });

    test('returns true for empty cherry output', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });
      const result = await git.isPatchEquivalent('/workspace/repo', 'feature', 'main');
      expect(result).toBe(true);
    });

    test('returns false on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));
      const result = await git.isPatchEquivalent('/workspace/repo', 'feature', 'main');
      expect(result).toBe(false);
    });

    test('throws on unexpected errors', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));
      await expect(git.isPatchEquivalent('/workspace/repo', 'feature', 'main')).rejects.toThrow(
        'Failed to check if feature is patch-equivalent to main'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ branchName: 'feature', baseBranch: 'main' }),
        'branch.patch_equivalent_check_failed'
      );
    });
  });

  describe('getLastCommitDate', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns valid date from git log output', async () => {
      execSpy.mockResolvedValue({ stdout: '2024-01-15 10:30:00 +0000\n', stderr: '' });

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getFullYear()).toBe(2024);
    });

    test('returns null on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeNull();
    });

    test('returns null on expected errors (no commits)', async () => {
      execSpy.mockRejectedValue(new Error('fatal: does not have any commits yet'));

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeNull();
    });

    test('returns null on expected errors (ENOENT)', async () => {
      const error = new Error('No such file') as Error & { code: string };
      error.code = 'ENOENT';
      execSpy.mockRejectedValue(error);

      const result = await git.getLastCommitDate('/nonexistent');
      expect(result).toBeNull();
    });

    test('throws and logs on unexpected errors', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.getLastCommitDate('/workspace/repo')).rejects.toThrow(
        'Failed to get last commit date for /workspace/repo'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ workingPath: '/workspace/repo' }),
        'last_commit_date_check_failed'
      );
    });

    test('returns null for empty git log output', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeNull();
    });

    test('returns null and warns for invalid date format', async () => {
      mockLogger.warn.mockClear();
      execSpy.mockResolvedValue({ stdout: 'not-a-date\n', stderr: '' });

      const result = await git.getLastCommitDate('/workspace/repo');
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workingPath: '/workspace/repo', rawDate: 'not-a-date' }),
        'invalid_commit_date_format'
      );
    });
  });

  describe('isAncestorOf', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns true when ref is ancestor of HEAD (exit 0)', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.isAncestorOf('/worktrees/feature' as git.WorktreePath, 'origin/dev');
      expect(result).toBe(true);
      expect(execSpy).toHaveBeenCalledWith('git', [
        '-C',
        '/worktrees/feature',
        'merge-base',
        '--is-ancestor',
        'origin/dev',
        'HEAD',
      ]);
    });

    test('returns false when ref is not ancestor of HEAD (exit code 1)', async () => {
      const err = Object.assign(new Error(''), { code: 1, stderr: '' });
      execSpy.mockRejectedValue(err);

      const result = await git.isAncestorOf(
        '/worktrees/feature' as git.WorktreePath,
        'origin/main'
      );
      expect(result).toBe(false);
    });

    test('returns false on expected errors (not a git repository)', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.isAncestorOf(
        '/worktrees/feature' as git.WorktreePath,
        'origin/main'
      );
      expect(result).toBe(false);
    });

    test('returns false on expected errors (unknown revision)', async () => {
      execSpy.mockRejectedValue(
        Object.assign(new Error('unknown revision'), { stderr: 'unknown revision' })
      );

      const result = await git.isAncestorOf(
        '/worktrees/feature' as git.WorktreePath,
        'origin/missing'
      );
      expect(result).toBe(false);
    });

    test('returns false on expected errors (not a valid object name)', async () => {
      execSpy.mockRejectedValue(
        Object.assign(new Error('not a valid object name'), { stderr: 'not a valid object name' })
      );

      const result = await git.isAncestorOf(
        '/worktrees/feature' as git.WorktreePath,
        'origin/missing'
      );
      expect(result).toBe(false);
    });

    test('returns false on expected errors (no such file)', async () => {
      execSpy.mockRejectedValue(new Error('no such file or directory'));

      const result = await git.isAncestorOf('/nonexistent' as git.WorktreePath, 'origin/dev');
      expect(result).toBe(false);
    });

    test('returns false when git binary not found (ENOENT)', async () => {
      execSpy.mockRejectedValue(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));

      const result = await git.isAncestorOf('/worktrees/feature' as git.WorktreePath, 'origin/dev');
      expect(result).toBe(false);
    });

    test('throws and logs on unexpected errors', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(
        git.isAncestorOf('/worktrees/feature' as git.WorktreePath, 'origin/dev')
      ).rejects.toThrow('Failed to check if origin/dev is ancestor of HEAD');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ ancestorRef: 'origin/dev' }),
        'branch.ancestor_check_failed'
      );
    });
  });

  // ==========================================================================
  // repo.ts
  // ==========================================================================

  describe('syncWorkspace', () => {
    let execSpy: Mock<typeof git.execFileAsync>;
    let getDefaultBranchSpy: Mock<typeof git.getDefaultBranch>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
      getDefaultBranchSpy = spyOn(git, 'getDefaultBranch');
      getDefaultBranchSpy.mockResolvedValue('main');
    });

    afterEach(() => {
      execSpy.mockRestore();
      getDefaultBranchSpy.mockRestore();
    });

    test('fetches origin branch and returns synced result', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.syncWorkspace('/workspace/repo', 'main');

      // Default mode is 'fast-forward'. With empty SHAs the function falls
      // through ancestor checks (mock always succeeds) → state='diverged' → noop.
      expect(result).toEqual({
        branch: 'main',
        synced: true,
        state: 'diverged',
        previousHead: '',
        newHead: '',
        updated: false,
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'fetch', 'origin', 'main'],
        expect.any(Object)
      );
    });

    test("hard-resets working tree to origin after fetch (mode: 'reset')", async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.syncWorkspace('/workspace/repo', 'main', { mode: 'reset' });

      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset');
      });

      expect(resetCalls).toHaveLength(1);
      expect(resetCalls[0][1]).toEqual(['-C', '/workspace/repo', 'reset', '--hard', 'origin/main']);
    });

    test("throws if reset fails after successful fetch (mode: 'reset')", async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('reset')) {
          throw new Error('fatal: Could not reset index file');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace('/workspace/repo', 'main', { mode: 'reset' })).rejects.toThrow(
        'Reset to origin/main failed'
      );
    });

    test('throws error if fetch fails', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('fatal: unable to access repository');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace('/workspace/repo', 'main')).rejects.toThrow(
        'unable to access repository'
      );
    });

    test('passes correct timeout value to fetch command', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.syncWorkspace('/workspace/repo', 'main');

      const fetchCall = execSpy.mock.calls.find((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch');
      });
      expect(fetchCall?.[2]).toEqual({ timeout: 60000 });
    });

    test('includes operation context in fetch error message', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error('fatal: network unreachable');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace('/workspace/repo', 'main')).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );
    });

    test('derives branch from getDefaultBranch when override not provided', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });
      getDefaultBranchSpy.mockResolvedValue('develop');

      const result = await git.syncWorkspace('/workspace/repo');

      expect(result).toEqual({
        branch: 'develop',
        synced: true,
        state: 'diverged',
        previousHead: '',
        newHead: '',
        updated: false,
      });
      expect(getDefaultBranchSpy).toHaveBeenCalledWith('/workspace/repo');
    });

    test('throws actionable error when configured branch not found on remote', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error("fatal: couldn't find remote ref does-not-exist");
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace('/workspace/repo', 'does-not-exist')).rejects.toThrow(
        "Configured base branch 'does-not-exist' not found on remote"
      );
      await expect(git.syncWorkspace('/workspace/repo', 'does-not-exist')).rejects.toThrow(
        'update worktree.baseBranch'
      );
    });

    test('throws generic error when auto-detected branch not found (not actionable)', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error("fatal: couldn't find remote ref main");
        }
        return { stdout: '', stderr: '' };
      });
      getDefaultBranchSpy.mockResolvedValue('main');

      await expect(git.syncWorkspace('/workspace/repo')).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );
      await expect(git.syncWorkspace('/workspace/repo')).rejects.not.toThrow('worktree.baseBranch');
    });

    test("default mode 'fast-forward' never runs reset", async () => {
      // All git invocations return empty stdout (success). With empty SHAs the
      // function falls through to the ancestor check; mocked execFile always
      // succeeds, so both ancestor probes report true → state = 'diverged' →
      // no-op (neither reset nor merge). The fetch must still happen.
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.syncWorkspace('/workspace/repo', 'main');

      expect(result).toEqual({
        branch: 'main',
        synced: true,
        state: 'diverged',
        previousHead: '',
        newHead: '',
        updated: false,
      });

      // Fetch should still have been called
      const fetchCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch');
      });
      expect(fetchCalls).toHaveLength(1);

      // Reset must NOT have been called — fast-forward is non-destructive
      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset');
      });
      expect(resetCalls).toHaveLength(0);
    });

    test("explicit mode: 'reset' runs git reset --hard", async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.syncWorkspace('/workspace/repo', 'main', { mode: 'reset' });

      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset') && args.includes('--hard');
      });
      expect(resetCalls).toHaveLength(1);
    });
  });

  describe('cloneRepository', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('clones successfully without token', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.cloneRepository('https://github.com/owner/repo.git', '/tmp/target');

      expect(result).toEqual({ ok: true, value: undefined });
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['clone', 'https://github.com/owner/repo.git', '/tmp/target'],
        { timeout: 120000 }
      );
    });

    test('constructs authenticated URL with token', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.cloneRepository('https://github.com/owner/repo.git', '/tmp/target', {
        token: 'ghp_abc123',
      });

      expect(result).toEqual({ ok: true, value: undefined });
      // Verify the token is in the URL
      const cloneUrl = execSpy.mock.calls[0]![1][1] as string;
      expect(cloneUrl).toContain('ghp_abc123');
      expect(cloneUrl).toContain('github.com');
    });

    test('returns not_a_repo error for 404', async () => {
      execSpy.mockRejectedValue(new Error('fatal: repository not found'));

      const result = await git.cloneRepository(
        'https://github.com/owner/missing.git',
        '/tmp/target'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('not_a_repo');
      }
    });

    test('returns permission_denied error for auth failure', async () => {
      execSpy.mockRejectedValue(new Error('fatal: Authentication failed'));

      const result = await git.cloneRepository(
        'https://github.com/owner/private.git',
        '/tmp/target'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('permission_denied');
      }
    });

    test('returns no_space error when disk full', async () => {
      execSpy.mockRejectedValue(new Error('error: no space left on device'));

      const result = await git.cloneRepository('https://github.com/owner/repo.git', '/tmp/target');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('no_space');
      }
    });

    test('returns unknown error for unexpected failures', async () => {
      execSpy.mockRejectedValue(new Error('segfault'));

      const result = await git.cloneRepository('https://github.com/owner/repo.git', '/tmp/target');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });
  });

  describe('syncRepository', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('fetches and resets successfully', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.syncRepository('/workspace/repo', 'main');

      expect(result).toEqual({ ok: true, value: undefined });
      expect(execSpy).toHaveBeenCalledWith('git', ['fetch', 'origin'], {
        cwd: '/workspace/repo',
        timeout: 60000,
      });
      expect(execSpy).toHaveBeenCalledWith('git', ['reset', '--hard', 'origin/main'], {
        cwd: '/workspace/repo',
        timeout: 30000,
      });
    });

    test('skips reset if fetch fails', async () => {
      execSpy.mockRejectedValue(new Error('fatal: unable to access'));

      const result = await git.syncRepository('/workspace/repo', 'main');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
      // reset should NOT have been called
      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset');
      });
      expect(resetCalls).toHaveLength(0);
    });

    test('returns not_a_repo error when fetch fails with "not a git repository"', async () => {
      const error = new Error('Command failed') as Error & { stderr?: string };
      error.stderr = 'fatal: not a git repository (or any parent up to mount point /)';
      execSpy.mockRejectedValue(error);

      const result = await git.syncRepository('/workspace/repo', 'main');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('not_a_repo');
        if (result.error.code === 'not_a_repo') {
          expect(result.error.path).toBe('/workspace/repo');
        }
      }
    });

    test('returns permission_denied error when fetch fails with "authentication failed"', async () => {
      execSpy.mockRejectedValue(new Error('fatal: Authentication failed for repository'));

      const result = await git.syncRepository('/workspace/repo', 'main');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('permission_denied');
      }
    });

    test('returns no_space error when fetch fails with "no space"', async () => {
      execSpy.mockRejectedValue(new Error('error: no space left on device'));

      const result = await git.syncRepository('/workspace/repo', 'main');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('no_space');
      }
    });

    test('returns branch_not_found for invalid branch in reset', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          return { stdout: '', stderr: '' };
        }
        if (args.includes('reset')) {
          throw new Error("fatal: ambiguous argument 'origin/nonexistent': unknown revision");
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncRepository('/workspace/repo', 'nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('branch_not_found');
      }
    });

    test('returns unknown error for unexpected reset failure', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          return { stdout: '', stderr: '' };
        }
        if (args.includes('reset')) {
          throw new Error('segfault');
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncRepository('/workspace/repo', 'main');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });
  });

  describe('addSafeDirectory', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('calls git config with correct arguments', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.addSafeDirectory('/workspace/repo');

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['config', '--global', '--add', 'safe.directory', '/workspace/repo'],
        { timeout: 10000 }
      );
    });

    test('uses execFileAsync (not shell exec)', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.addSafeDirectory('/workspace/path with spaces');

      // If this were shell exec, spaces in the path would cause issues.
      // execFileAsync passes args as array, so path with spaces is safe.
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['config', '--global', '--add', 'safe.directory', '/workspace/path with spaces'],
        { timeout: 10000 }
      );
    });
  });

  describe('findRepoRoot', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns repo root path', async () => {
      execSpy.mockResolvedValue({ stdout: '/workspace/repo\n', stderr: '' });

      const result = await git.findRepoRoot('/workspace/repo/src');
      expect(result).toBe('/workspace/repo');
    });

    test('returns null for non-git directory', async () => {
      execSpy.mockRejectedValue(new Error('fatal: not a git repository'));

      const result = await git.findRepoRoot('/tmp/not-a-repo');
      expect(result).toBeNull();
    });

    test('throws for unexpected errors', async () => {
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.findRepoRoot('/workspace/repo')).rejects.toThrow('Failed to find repo root');
    });
  });

  describe('getRemoteUrl', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns remote URL', async () => {
      execSpy.mockResolvedValue({
        stdout: 'https://github.com/owner/repo.git\n',
        stderr: '',
      });

      const result = await git.getRemoteUrl('/workspace/repo');
      expect(result).toBe('https://github.com/owner/repo.git');
    });

    test('returns null when no remote configured', async () => {
      execSpy.mockRejectedValue(new Error('fatal: No such remote'));

      const result = await git.getRemoteUrl('/workspace/repo');
      expect(result).toBeNull();
    });

    test('throws for unexpected errors', async () => {
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.getRemoteUrl('/workspace/repo')).rejects.toThrow('Failed to get remote URL');
    });
  });

  // ==========================================================================
  // types.ts
  // ==========================================================================

  describe('branded types', () => {
    test('toRepoPath returns the same string value', () => {
      const path = git.toRepoPath('/workspace/repo');
      expect(path).toBe('/workspace/repo');
    });

    test('toBranchName returns the same string value', () => {
      const name = git.toBranchName('feature/auth');
      expect(name).toBe('feature/auth');
    });

    test('toWorktreePath returns the same string value', () => {
      const path = git.toWorktreePath('/workspace/worktrees/feature');
      expect(path).toBe('/workspace/worktrees/feature');
    });

    test('toRepoPath rejects empty string', () => {
      expect(() => git.toRepoPath('')).toThrow('RepoPath cannot be empty');
    });

    test('toBranchName rejects empty string', () => {
      expect(() => git.toBranchName('')).toThrow('BranchName cannot be empty');
    });

    test('toWorktreePath rejects empty string', () => {
      expect(() => git.toWorktreePath('')).toThrow('WorktreePath cannot be empty');
    });
  });

  // ==========================================================================
  // Additional coverage for review findings
  // ==========================================================================

  describe('removeWorktree', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('calls git worktree remove with correct arguments', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.removeWorktree('/workspace/repo', '/workspace/worktrees/issue-42');

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'worktree', 'remove', '/workspace/worktrees/issue-42'],
        { timeout: 30000 }
      );
    });

    test('propagates error when worktree has uncommitted changes', async () => {
      execSpy.mockRejectedValue(new Error('fatal: cannot remove: has changes'));

      await expect(
        git.removeWorktree('/workspace/repo', '/workspace/worktrees/dirty')
      ).rejects.toThrow('has changes');
    });
  });

  describe('addSafeDirectory error handling', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('throws and logs when git config fails', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: could not lock config file'));

      await expect(git.addSafeDirectory('/workspace/repo')).rejects.toThrow(
        "Failed to add safe directory '/workspace/repo': fatal: could not lock config file"
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/workspace/repo' }),
        'add_safe_directory_failed'
      );
    });
  });

  describe('getCanonicalRepoPath error handling', () => {
    test('throws on non-standard gitdir format', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /some/unusual/path/without/expected/structure'
      );
      mockLogger.error.mockClear();

      await expect(git.getCanonicalRepoPath(testDir)).rejects.toThrow(
        'Cannot determine canonical repo path from worktree'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ path: testDir }),
        'canonical_path_regex_failed'
      );
    });
  });

  describe('verifyWorktreeOwnership', () => {
    test('resolves for matching worktree pointer', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /workspace/my-repo/.git/worktrees/issue-42\n'
      );

      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        )
      ).resolves.toBeUndefined();
    });

    test('throws with "belongs to a different clone" when gitdir points elsewhere', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: /other/clone/.git/worktrees/issue-42\n');

      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        )
      ).rejects.toThrow(/belongs to a different clone \(\/other\/clone\)/);
    });

    test('normalizes trailing slashes in both paths', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /workspace/my-repo/.git/worktrees/issue-42\n'
      );

      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo/')
        )
      ).resolves.toBeUndefined();
    });

    test('throws EISDIR when .git is a directory (full checkout at path)', async () => {
      await realMkdir(join(testDir, '.git'));

      const promise = git.verifyWorktreeOwnership(
        git.toWorktreePath(testDir),
        git.toRepoPath('/workspace/my-repo')
      );
      await expect(promise).rejects.toThrow(/path contains a full git checkout/);
      // Original errno is preserved on the wrapped error for robust
      // classification downstream (not just a fragile substring match).
      try {
        await git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        );
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
      }
    });

    test('throws ENOENT when .git file is missing', async () => {
      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        )
      ).rejects.toThrow(/Cannot verify worktree ownership/);
      try {
        await git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        );
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });

    test('throws on submodule pointer (gitdir into .git/modules/...)', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /workspace/my-repo/.git/modules/vendor/submodule\n'
      );

      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        )
      ).rejects.toThrow(/not a git-worktree reference/);
    });

    test('throws on corrupted .git content (no gitdir prefix)', async () => {
      await writeFile(join(testDir, '.git'), 'this is not a git pointer at all');

      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        )
      ).rejects.toThrow(/not a git-worktree reference/);
    });

    test('preserves original error via `cause` chain on fs errors', async () => {
      try {
        await git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        );
      } catch (err) {
        expect((err as Error).cause).toBeDefined();
        expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
      }
    });
  });
});

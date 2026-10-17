import { describe, test, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import {
  writeFile,
  mkdir as realMkdir,
  mkdtemp,
  readFile,
  rm,
  chmod,
  stat,
  realpath,
  symlink,
} from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir, homedir } from 'os';
import { createHash } from 'crypto';
import { deflateSync } from 'zlib';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createRecordingGitFixture } from './test-utils';
// Loaded BEFORE mock.module replaces the module in the registry, so these are
// the REAL pure helpers (identity validators, isPathInside) — the mock
// re-exports them (no drift possible).
import { isPathInside, parseOwnerRepo, resolveRepoProjectIdentity } from '@archon/paths';

// ---------------------------------------------------------------------------
// Mock @archon/paths: suppress logger, pass-through path functions
// ---------------------------------------------------------------------------
// Re-implement the *path* helpers inline so the mock doesn't depend on the
// real module's env handling (mock.module replaces the *entire* module).  The
// path functions are trivial join() wrappers driven by env-vars, so
// duplication is acceptable.  The identity validators (parseOwnerRepo,
// resolveRepoProjectIdentity) are pure, so the mock passes the real ones
// through instead of mirroring them.
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
  isInsideArchonWorkspaces: (p: string) => isPathInside(join(getArchonHome(), 'workspaces'), p),
  getProjectWorktreesPath: (owner: string, repo: string) =>
    join(getArchonHome(), 'workspaces', owner, repo, 'worktrees'),
  parseOwnerRepo,
  resolveRepoProjectIdentity,
}));

// ---------------------------------------------------------------------------
// Import modules AFTER mocking
// ---------------------------------------------------------------------------
import * as git from './index';

const repo = git.toRepoPath;
const branch = git.toBranchName;
const worktree = git.toWorktreePath;
/** A path as listWorktrees returns it: git's output in this platform's native form. */
const listed = (path: string): git.WorktreePath => worktree(git.toNativeWorktreePath(path));
const trackTempRoot = trackTempRoots();

/**
 * Writes a one-commit bare repository that Git's dumb HTTP transport can clone:
 * loose objects, a branch ref, HEAD and `info/refs`. Built in-process because the
 * clone is the subprocess under test; building the same fixture with `git` took
 * seven more children, the bulk of the test's Windows time (#2924).
 */
async function writeDumbHttpRepo(barePath: string): Promise<void> {
  const writeObject = async (type: string, body: Buffer): Promise<Buffer> => {
    const raw = Buffer.concat([Buffer.from(`${type} ${String(body.length)}\0`), body]);
    const id = createHash('sha1').update(raw).digest();
    const hex = id.toString('hex');
    await realMkdir(join(barePath, 'objects', hex.slice(0, 2)), { recursive: true });
    await writeFile(join(barePath, 'objects', hex.slice(0, 2), hex.slice(2)), deflateSync(raw));
    return id;
  };
  const blob = await writeObject('blob', Buffer.from('fixture\n'));
  const tree = await writeObject('tree', Buffer.concat([Buffer.from('100644 README.md\0'), blob]));
  const signature = 'Archon Test <archon@example.test> 0 +0000';
  const commit = await writeObject(
    'commit',
    Buffer.from(
      `tree ${tree.toString('hex')}\nauthor ${signature}\ncommitter ${signature}\n\nfixture\n`
    )
  );
  const head = commit.toString('hex');
  await realMkdir(join(barePath, 'refs', 'heads'), { recursive: true });
  await realMkdir(join(barePath, 'info'), { recursive: true });
  await writeFile(join(barePath, 'refs', 'heads', 'main'), `${head}\n`);
  await writeFile(join(barePath, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(barePath, 'info', 'refs'), `${head}\trefs/heads/main\n`);
}

// ============================================================================
// Tests
// ============================================================================

describe('git utilities', () => {
  const testDir = repo(join(tmpdir(), 'git-utils-test-' + Date.now()));

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
        await expect(git.isWorktreePath(testPath)).rejects.toHaveProperty('cause', eaccesError);
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

  describe('readWorktreeRegistration', () => {
    test('propagates permission errors resolving a path listed by Git', async () => {
      const targetPath = join(testDir, 'checkout');
      await realMkdir(targetPath);
      const resolvedTarget = await realpath(targetPath);
      const error = Object.assign(new Error('cannot resolve listed path'), { code: 'EACCES' });
      const fsPromises = await import('fs/promises');
      const realpathSpy = spyOn(fsPromises, 'realpath')
        .mockResolvedValueOnce(resolvedTarget)
        .mockRejectedValueOnce(error);
      const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({
        stdout: `worktree ${targetPath}\0HEAD abc123\0branch refs/heads/main\0\0`,
        stderr: '',
      });
      try {
        await expect(git.readWorktreeRegistration(testDir, targetPath)).rejects.toBe(error);
        expect(realpathSpy).toHaveBeenCalledTimes(2);
        expect(realpathSpy).toHaveBeenNthCalledWith(1, targetPath);
        expect(realpathSpy).toHaveBeenNthCalledWith(2, targetPath);
      } finally {
        realpathSpy.mockRestore();
        execSpy.mockRestore();
      }
    });

    for (const code of ['EACCES', 'EIO', 'ELOOP']) {
      test(`propagates ancestor resolution errors: ${code}`, async () => {
        const error = Object.assign(new Error('cannot resolve path'), { code });
        const fsPromises = await import('fs/promises');
        const realpathSpy = spyOn(fsPromises, 'realpath').mockRejectedValueOnce(error);
        const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({ stdout: '', stderr: '' });
        try {
          await expect(
            git.readWorktreeRegistration(testDir, join(testDir, 'checkout'))
          ).rejects.toBe(error);
          expect(realpathSpy).toHaveBeenCalledTimes(1);
        } finally {
          realpathSpy.mockRestore();
          execSpy.mockRestore();
        }
      });
    }
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
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({
          stdout: '/workspace/my-repo/.git/worktrees/issue-42\n/workspace/my-repo/.git\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: 'worktree /workspace/my-repo\nHEAD abc123\nbranch refs/heads/main\n',
          stderr: '',
        });
      try {
        const result = await git.getCanonicalRepoPath(testDir);
        expect(result).toBe(repo('/workspace/my-repo'));
      } finally {
        execSpy.mockRestore();
      }
    });

    test('handles worktree path with nested directories', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /home/user/projects/my-app/.git/worktrees/feature-branch'
      );
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({
          stdout:
            '/home/user/projects/my-app/.git/worktrees/feature-branch\n/home/user/projects/my-app/.git\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: 'worktree /home/user/projects/my-app\nHEAD abc123\n',
          stderr: '',
        });
      try {
        const result = await git.getCanonicalRepoPath(testDir);
        expect(result).toBe(repo('/home/user/projects/my-app'));
      } finally {
        execSpy.mockRestore();
      }
    });

    test('resolves a relative worktree pointer from the worktree root', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: ../primary/.git/worktrees/linked');
      const primary = resolve(testDir, '../primary');
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({
          stdout: `${primary}/.git/worktrees/linked\n${primary}/.git\n`,
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: `worktree ${primary}\nHEAD abc123\n`, stderr: '' });
      try {
        const result = await git.getCanonicalRepoPath(testDir);
        expect(result).toBe(repo(primary));
      } finally {
        execSpy.mockRestore();
      }
    });

    test('keeps a submodule checkout as its own canonical repository', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: ../primary/.git/modules/vendor/module');
      const gitDir = resolve(testDir, '../primary/.git/modules/vendor/module');
      const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({
        stdout: `${gitDir}\n${gitDir}\n`,
        stderr: '',
      });
      try {
        const result = await git.getCanonicalRepoPath(testDir);
        expect(result).toBe(testDir);
      } finally {
        execSpy.mockRestore();
      }
    });

    test('keeps a submodule named under worktrees as its own canonical repository', async () => {
      const gitDir = join(testDir, 'primary', '.git', 'modules', 'vendor', 'worktrees', 'module');
      await realMkdir(gitDir, { recursive: true });
      await writeFile(join(testDir, '.git'), `gitdir: ${gitDir}`);

      const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({
        stdout: `${gitDir}\n${gitDir}\n`,
        stderr: '',
      });
      try {
        const result = await git.getCanonicalRepoPath(testDir);
        expect(result).toBe(testDir);
      } finally {
        execSpy.mockRestore();
      }
    });

    test('keeps a submodule inside a linked superproject as its own repository', async () => {
      const commonGitDir = join(
        testDir,
        'super',
        '.git',
        'worktrees',
        'linked-super',
        'modules',
        'vendor',
        'module'
      );
      await writeFile(join(testDir, '.git'), `gitdir: ${commonGitDir}`);
      const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({
        stdout: `${commonGitDir}\n${commonGitDir}\n`,
        stderr: '',
      });
      try {
        await expect(git.getCanonicalRepoPath(testDir)).resolves.toBe(testDir);
      } finally {
        execSpy.mockRestore();
      }
    });

    test('resolves a linked submodule worktree to the primary submodule checkout', async () => {
      const commonGitDir = join(testDir, 'super', '.git', 'modules', 'vendor', 'module');
      const linkedGitDir = join(commonGitDir, 'worktrees', 'linked');
      await realMkdir(linkedGitDir, { recursive: true });
      await writeFile(join(linkedGitDir, 'commondir'), '../..\n');
      await writeFile(join(testDir, '.git'), `gitdir: ${linkedGitDir}`);
      const primaryCheckout = resolve(commonGitDir, '../../../../vendor/module');
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({
          stdout: `${linkedGitDir}\n${commonGitDir}\n`,
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: `worktree ${commonGitDir}\nHEAD abc123\n`, stderr: '' })
        .mockResolvedValueOnce({ stdout: '../../../../vendor/module\n', stderr: '' });

      try {
        const result = await git.getCanonicalRepoPath(testDir);

        expect(execSpy).toHaveBeenCalledWith('git', [
          '--git-dir',
          commonGitDir,
          'config',
          '--get',
          'core.worktree',
        ]);
        expect(result).toBe(repo(primaryCheckout));
      } finally {
        execSpy.mockRestore();
      }
    });

    test('resolves a linked submodule worktree inside a linked superproject', async () => {
      const commonGitDir = join(
        testDir,
        'super',
        '.git',
        'worktrees',
        'linked-super',
        'modules',
        'vendor',
        'module'
      );
      const linkedGitDir = join(commonGitDir, 'worktrees', 'linked-module');
      const primaryCheckout = join(testDir, 'linked-super', 'vendor', 'module');
      await writeFile(join(testDir, '.git'), `gitdir: ${linkedGitDir}`);
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({ stdout: `${linkedGitDir}\n${commonGitDir}\n`, stderr: '' })
        .mockResolvedValueOnce({ stdout: `worktree ${commonGitDir}\nHEAD abc123\n`, stderr: '' })
        .mockResolvedValueOnce({ stdout: `${primaryCheckout}\n`, stderr: '' });
      try {
        await expect(git.getCanonicalRepoPath(testDir)).resolves.toBe(repo(primaryCheckout));
      } finally {
        execSpy.mockRestore();
      }
    });

    test('keeps a primary checkout with an external Git directory', async () => {
      const externalGitDir = join(testDir, 'metadata');
      await writeFile(join(testDir, '.git'), `gitdir: ${externalGitDir}`);
      const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue({
        stdout: `${externalGitDir}\n${externalGitDir}\n`,
        stderr: '',
      });
      try {
        await expect(git.getCanonicalRepoPath(testDir)).resolves.toBe(testDir);
      } finally {
        execSpy.mockRestore();
      }
    });

    test('reports when an external Git directory cannot reveal the primary checkout', async () => {
      const commonGitDir = join(testDir, 'metadata');
      const linkedGitDir = join(commonGitDir, 'worktrees', 'linked');
      await writeFile(join(testDir, '.git'), `gitdir: ${linkedGitDir}`);
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({ stdout: `${linkedGitDir}\n${commonGitDir}\n`, stderr: '' })
        .mockResolvedValueOnce({ stdout: `worktree ${commonGitDir}\nHEAD abc123\n`, stderr: '' })
        .mockRejectedValueOnce(new Error('core.worktree is unset'));
      try {
        await expect(git.getCanonicalRepoPath(testDir)).rejects.toBeInstanceOf(
          git.CanonicalRepoPathUnavailableError
        );
      } finally {
        execSpy.mockRestore();
      }
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
      // living outside ~/.archon/workspaces/, the identity is the shared
      // _local/<basename> fallback (resolveRepoProjectIdentity) — the same
      // identity registration and log/artifact resolution use (#2227).
      delete process.env.WORKTREE_BASE;
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_HOME;
      delete process.env.ARCHON_DOCKER;
      const result = git.getWorktreeBase(repo('/workspace/my-repo'));
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'my-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('uses ARCHON_HOME for the workspace-scoped base (local non-Docker)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.WORKTREE_BASE;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = '/custom/archon';
      const result = git.getWorktreeBase(repo('/workspace/my-repo'));
      expect(result).toEqual({
        base: join('/custom/archon', 'workspaces', '_local', 'my-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('uses the Docker archon home for the workspace-scoped base', () => {
      delete process.env.ARCHON_HOME;
      process.env.ARCHON_DOCKER = 'true';
      const result = git.getWorktreeBase(repo('/workspace/my-repo'));
      expect(result).toEqual({
        base: join('/', '.archon', 'workspaces', '_local', 'my-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('returns workspace-scoped path when repo is already under workspaces/', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const workspacesPath = join(homedir(), '.archon', 'workspaces');
      const repoPath = join(workspacesPath, 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repo(repoPath));
      expect(result).toEqual({
        base: join(workspacesPath, 'acme', 'widget', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('does not read owner/repo from a sibling that only shares the workspaces prefix', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const lookalike = join(homedir(), '.archon', 'workspaces-old', 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repo(lookalike));
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'source', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('workspace-scoped path honors ARCHON_HOME override', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = join('/', 'custom', 'archon');
      const repoPath = join('/', 'custom', 'archon', 'workspaces', 'acme', 'widget', 'source');
      const result = git.getWorktreeBase(repo(repoPath));
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
      const result = git.getWorktreeBase(repo(localRepoPath), 'Widinglabs/sasha-demo');
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
      const result = git.getWorktreeBase(repo(repoPath), 'new-owner/new-repo');
      expect(result).toEqual({
        base: join(workspacesPath, 'new-owner', 'new-repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('ignores invalid codebaseName and falls back to _local/<basename>', () => {
      // "invalid-no-slash" doesn't parse as owner/repo; the layout still resolves
      // to workspace-scoped using the shared _local/<basename> identity.
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const result = git.getWorktreeBase(repo('/local/repo'), 'invalid-no-slash');
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'repo', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('ignores SSH-URL-shaped codebaseName (contains ":" / "@") and falls back to _local', () => {
      // Regression guard (PR #1583): a name like "git@host.example:org/repo"
      // used to be split naively at the last slash — the colon smuggled into
      // the owner path segment broke docker-compose short-form volume specs
      // (`HOST:CONTAINER:OPT`) inside devcontainers.
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      mockLogger.warn.mockClear();
      const result = git.getWorktreeBase(
        repo('/srv/projects/widget-app'),
        'git@git.example.net:acme/widget-app'
      );
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'widget-app', 'worktrees'),
        layout: 'workspace-scoped',
      });
      // Rejection must stay observable — operators spot misconfigured
      // codebases through this warn.
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { codebaseName: 'git@git.example.net:acme/widget-app' },
        'worktree.invalid_codebase_name_format'
      );
      // Check only the path below homedir — on Windows the home directory
      // itself contains ":" in the drive letter (e.g. C:\Users\...).
      const relativeToHome = result.base.slice(homedir().length);
      expect(relativeToHome).not.toContain(':');
      expect(relativeToHome).not.toContain('@');
    });

    test('resolves single-segment checkout paths via _local fallback (no throw)', () => {
      // The historical last-two-segments heuristic threw for paths like
      // /workspace (#2022); the shared fallback handles them.
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const result = git.getWorktreeBase(repo('/workspace'));
      expect(result).toEqual({
        base: join(homedir(), '.archon', 'workspaces', '_local', 'workspace', 'worktrees'),
        layout: 'workspace-scoped',
      });
    });

    test('throws for a degenerate repo path with no usable basename', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      expect(() => git.getWorktreeBase(repo('/'))).toThrow('Cannot derive a project identity');
    });

    test('repoLocal override wins over workspace-scoped default', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      const repoPath = '/Users/rasmus/Projects/myapp';
      const result = git.getWorktreeBase(repo(repoPath), undefined, { repoLocal: '.worktrees' });
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
      const result = git.getWorktreeBase(repo(repoPath), 'acme/widget', { repoLocal: '.wt' });
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
        git.isProjectScopedWorktreeBase(repo(join(workspacesPath, 'acme', 'widget', 'source')))
      ).toBe(true);
    });

    test('returns true for a local non-workspace path (new two-layout model)', () => {
      // In the pre-refactor three-layout model, this returned false (legacy global).
      // Under the two-layout model every repo is workspace-scoped unless a
      // `repoLocal` override is supplied, which this helper does not accept.
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      expect(git.isProjectScopedWorktreeBase(repo('/workspace/my-repo'))).toBe(true);
    });

    test('returns true when codebaseName is provided (local repo)', () => {
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      expect(
        git.isProjectScopedWorktreeBase(repo('/Users/rasmus/Projects/repo'), 'owner/repo')
      ).toBe(true);
    });

    test('returns true when codebaseName is invalid (falls back to path-derived)', () => {
      // Under the two-layout model the helper always returns true for any resolvable
      // owner/repo. Invalid codebaseName + valid repo path → still workspace-scoped.
      delete process.env.WORKSPACE_PATH;
      delete process.env.ARCHON_DOCKER;
      delete process.env.ARCHON_HOME;
      expect(git.isProjectScopedWorktreeBase(repo('/local/repo'), 'invalid')).toBe(true);
    });
  });

  describe('worktreeExists', () => {
    test('returns true when path and .git exist', async () => {
      await realMkdir(join(testDir, 'worktree-test'), { recursive: true });
      await writeFile(join(testDir, 'worktree-test', '.git'), 'gitdir: /some/path');

      const result = await git.worktreeExists(worktree(join(testDir, 'worktree-test')));
      expect(result).toBe(true);
    });

    test('returns false when path does not exist', async () => {
      const result = await git.worktreeExists(worktree(join(testDir, 'nonexistent')));
      expect(result).toBe(false);
    });

    test('returns false and logs warning when directory exists but .git is missing (corruption)', async () => {
      await realMkdir(join(testDir, 'no-git'), { recursive: true });
      mockLogger.warn.mockClear();

      const result = await git.worktreeExists(worktree(join(testDir, 'no-git')));
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
        await expect(git.worktreeExists(worktree(testPath))).rejects.toThrow(
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

  describe('Git failure evidence at the process boundary', () => {
    test('a directory without repository markers has a typed cause regardless of its name', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-timeout-not-repository-')));
      const failure = await git
        .execFileAsync('git', ['-C', root, 'status'])
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(git.GitFailure);
      if (!(failure instanceof git.GitFailure)) throw new Error('expected GitFailure');
      expect(failure.kind).toBe('not_repository');
      expect(failure.code).toBe(128);
      expect(failure.stderr).toContain('not a git repository');
    });

    test('a path that no longer exists reads as absent to repository consumers', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-vanished-')));
      const missing = join(root, 'vanished-worktree');
      for (const args of [['-C', missing, 'status'], ['status']]) {
        const failure = await git
          .execFileAsync('git', args, args[0] === '-C' ? {} : { cwd: missing })
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(git.GitFailure);
        if (!(failure instanceof git.GitFailure)) throw new Error('expected GitFailure');
        expect(failure.kind).toBe('not_repository');
      }
      expect(await git.getLastCommitDate(worktree(missing))).toBeNull();
      expect(await git.isBranchMerged(repo(missing), branch('topic'), branch('main'))).toBe(false);
      expect(await git.isAncestorOf(worktree(missing), 'main')).toBe(false);
      expect(await git.isPatchEquivalent(worktree(missing), branch('topic'), 'main')).toBe(false);
      expect(await git.listWorktrees(repo(missing))).toEqual([]);
      expect(await git.hasUncommittedChanges(worktree(missing))).toBe(false);
    });

    test('a bare repository is not reported as absent', async () => {
      const bare = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-bare-')));
      await git.execFileAsync('git', ['init', '-q', '--bare', bare]);
      const failure = await git
        .execFileAsync('git', ['-C', bare, 'status'])
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(git.GitFailure);
      if (!(failure instanceof git.GitFailure)) throw new Error('expected GitFailure');
      expect(failure.kind).toBe('unclassified');
      expect(failure.code).toBe(128);
    });

    test('an explicit GIT_DIR that Git cannot open is not reported as absent', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-git-dir-')));
      const failure = await git
        .execFileAsync('git', ['-C', root, 'status'], {
          env: { ...process.env, GIT_DIR: join(root, 'missing-git-dir') },
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(git.GitFailure);
      if (!(failure instanceof git.GitFailure)) throw new Error('expected GitFailure');
      expect(failure.kind).toBe('unclassified');
      expect(failure.code).toBe(128);
    });

    test('a repository above GIT_CEILING_DIRECTORIES does not hide absence', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-git-ceiling-')));
      const ceiling = join(root, 'inner');
      const start = join(ceiling, 'sub');
      await git.execFileAsync('git', ['init', '-q', root]);
      await realMkdir(start, { recursive: true });
      const previous = process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_CEILING_DIRECTORIES = ceiling;
      try {
        expect(await git.findRepoRoot(start)).toBeNull();
      } finally {
        if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
        else process.env.GIT_CEILING_DIRECTORIES = previous;
      }
    });

    test('findRepoRoot refuses a path that does not exist instead of reporting no repository', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-missing-root-')));
      await expect(git.findRepoRoot(join(root, 'missing'))).rejects.toThrow(
        'Failed to find repo root'
      );
    });

    test('invalid global config stays unclassified across repository absence consumers', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-git-config-')));
      const config = join(root, 'global-config');
      await writeFile(config, '[invalid');
      const previous = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = config;
      try {
        const failure = await git
          .execFileAsync('git', ['-C', root, 'status'])
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(git.GitFailure);
        if (!(failure instanceof git.GitFailure)) throw new Error('expected GitFailure');
        expect(failure.kind).toBe('unclassified');
        expect(failure.code).toBe(128);
        expect(failure.stderr).toContain(config);
        if (failure.stderr === undefined) throw new Error('expected Git stderr');
        for (const inspect of [
          () => git.findRepoRoot(root),
          () => git.listWorktrees(repo(root)),
          () => git.isBranchMerged(repo(root), branch('topic'), branch('main')),
          () => git.isPatchEquivalent(repo(root), branch('topic'), 'main'),
          () =>
            git.isPatchEquivalent(repo(root), branch('topic'), 'main', {
              throwOnExpectedError: true,
            }),
          () => git.isAncestorOf(repo(root), 'main'),
          () => git.getLastCommitDate(repo(root)),
        ]) {
          await expect(inspect()).rejects.toThrow(failure.stderr);
        }
        expect(await git.hasUncommittedChanges(repo(root))).toBe(true);
        const sync = await git.syncRepository(repo(root), branch('main'));
        expect(sync.ok).toBe(false);
        if (sync.ok || sync.error.code !== 'unknown')
          throw new Error('expected unknown sync failure');
        expect(sync.error.message).toContain(failure.stderr);
      } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previous;
      }
    });

    test('symlinked subdirectories preserve repository failures across absence consumers', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-git-symlink-')));
      const source = join(root, 'source');
      const subdir = join(source, 'nested');
      const link = join(root, 'linked');
      await git.execFileAsync('git', ['init', '-q', source]);
      await realMkdir(subdir);
      await symlink(subdir, link, process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(source, '.git', 'config'), '[invalid');
      const failure = await git
        .execFileAsync('git', ['-C', link, 'status'])
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(git.GitFailure);
      if (!(failure instanceof git.GitFailure)) throw new Error('expected GitFailure');
      expect(failure.kind).toBe('unclassified');
      expect(failure.code).toBe(128);
      expect(failure.stderr).toContain('config');
      if (failure.stderr === undefined) throw new Error('expected Git stderr');
      for (const inspect of [
        () => git.findRepoRoot(link),
        () => git.listWorktrees(repo(link)),
        () => git.isBranchMerged(repo(link), branch('topic'), branch('main')),
        () => git.isPatchEquivalent(repo(link), branch('topic'), 'main'),
        () => git.isAncestorOf(repo(link), 'main'),
        () => git.getLastCommitDate(repo(link)),
      ]) {
        await expect(inspect()).rejects.toThrow(failure.stderr);
      }
      expect(await git.hasUncommittedChanges(repo(link))).toBe(true);
      const sync = await git.syncRepository(repo(link), branch('main'));
      expect(sync.ok).toBe(false);
      if (sync.ok) throw new Error('expected sync failure');
      expect(sync.error.code).toBe('unknown');
      if (sync.error.code !== 'unknown') throw new Error('expected unclassified sync failure');
      expect(sync.error.message).toContain(failure.stderr);
    });

    test('remote inspection confirms genuine absence in a repository', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-git-no-remote-')));
      await git.execFileAsync('git', ['init', '-q', root]);
      const original = await git
        .execFileAsync('git', ['-C', root, 'remote', 'get-url', 'origin'])
        .catch((error: unknown) => error);
      expect(original).toMatchObject({ kind: 'unclassified', code: 2 });
      const inspection = await git
        .execFileAsync('git', ['-C', root, 'config', '--local', '--get', 'remote.origin.url'])
        .catch((error: unknown) => error);
      expect(inspection).toMatchObject({ kind: 'unclassified', code: 1 });
      expect(await git.getRemoteUrl(repo(root))).toBeNull();
      expect(await git.detectForge(repo(root))).toEqual({
        type: 'github',
        apiBase: 'https://api.github.com',
      });
    });

    test.each(['plain directory', 'damaged repository'])(
      'remote inspection preserves failure for a %s',
      async shape => {
        const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-git-remote-')));
        if (shape === 'damaged repository') {
          await git.execFileAsync('git', ['init', '-q', root]);
          await git.execFileAsync('git', [
            '-C',
            root,
            'remote',
            'add',
            'origin',
            'https://gitlab.com/acme/widgets.git',
          ]);
          await writeFile(join(root, '.git', 'HEAD'), 'invalid HEAD');
        }
        const original = await git
          .execFileAsync('git', ['-C', root, 'remote', 'get-url', 'origin'])
          .catch((error: unknown) => error);
        expect(original).toBeInstanceOf(git.GitFailure);
        if (!(original instanceof git.GitFailure)) throw new Error('expected GitFailure');
        for (const inspect of [
          () => git.getRemoteUrl(repo(root)),
          () => git.detectForge(repo(root)),
        ]) {
          const failure = await inspect().catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          if (!(failure instanceof Error)) throw new Error('expected remote failure');
          expect(failure.cause).toMatchObject({ code: original.code, stderr: original.stderr });
        }
      }
    );

    test('a vendor failure retains stderr and exit code without interpreting colliding text', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-git-failure-')));
      await git.execFileAsync('git', ['init', '-q', root]);
      const failure = await git
        .execFileAsync('git', [
          '-C',
          root,
          '-c',
          'alias.failure=!printf "permission denied\\nsecond line: timeout\\n" >&2; exit 7',
          'failure',
        ])
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(git.GitFailure);
      if (!(failure instanceof git.GitFailure)) throw new Error('expected GitFailure');
      expect(failure.kind).toBe('unclassified');
      expect(failure.code).toBe(7);
      expect(failure.stderr).toBe('permission denied\nsecond line: timeout\n');
      expect(failure.message).toContain('exit code 7');
      expect(failure.cause).toBeInstanceOf(Error);
    });

    test('a timed out git invocation uses the process termination signal', async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-git-timeout-')));
      await git.execFileAsync('git', ['init', '-q', root]);
      const failure = await git
        .execFileAsync('git', ['-C', root, '-c', 'alias.wait=!sleep 1', 'wait'], { timeout: 30 })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(git.GitFailure);
      if (!(failure instanceof git.GitFailure)) throw new Error('expected GitFailure');
      expect(failure.kind).toBe('timeout');
      expect(failure.killed).toBe(true);
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

      const result = await git.listWorktrees(repo('/path/to/main'));

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ path: listed('/path/to/main'), branch: branch('main') });
      expect(result[1]).toEqual({
        path: listed('/path/to/feature'),
        branch: branch('feature/auth'),
      });
    });

    test('returns empty array only for a typed non-repository failure', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary vendor wording'));
      expect(await git.listWorktrees(repo('/path/to/repo'))).toEqual([]);
    });

    test.each([
      'not a git repository',
      'No such file or directory',
      'permission denied',
      'timeout',
    ])('does not suppress unclassified failure containing %s', async text => {
      const error = new git.GitFailure(
        'unclassified',
        text,
        Object.assign(new Error(text), { code: 128, stderr: text })
      );
      execSpy.mockRejectedValue(error);
      await expect(git.listWorktrees(repo('/path/to/repo'))).rejects.toBe(error);
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
      const result = await git.findWorktreeByBranch(
        repo('/workspace/main'),
        branch('feature/auth')
      );
      expect(result).toBe(listed('/workspace/worktrees/feature-auth'));
    });

    test('finds slugified branch match', async () => {
      const result = await git.findWorktreeByBranch(
        repo('/workspace/main'),
        branch('feature-auth')
      );
      expect(result).toBe(listed('/workspace/worktrees/feature-auth'));
    });

    test('returns null when no match', async () => {
      const result = await git.findWorktreeByBranch(repo('/workspace/main'), branch('nonexistent'));
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // branch.ts
  // ==========================================================================

  describe('unclassified Git failures', () => {
    test('clone and sync preserve unclassified evidence when paths resemble error labels', async () => {
      const failure = new git.GitFailure(
        'unclassified',
        'git -C /no space/404-target failed',
        Object.assign(new Error('config failure'), {
          code: 128,
          stderr: 'fatal: bad config line 1\noriginal stderr',
        })
      );
      const exec = spyOn(git, 'execFileAsync').mockRejectedValue(failure);
      try {
        const results = [
          await git.cloneRepository('https://example.com/repo.git', repo('/404-target')),
          await git.syncRepository(repo('/no space'), branch('main')),
        ];
        for (const result of results) {
          expect(result.ok).toBe(false);
          if (result.ok || result.error.code !== 'unknown')
            throw new Error('expected unclassified GitResult');
          expect(result.error.message).toContain('bad config line 1\noriginal stderr');
          expect(result.error.message).toContain('exit code 128');
        }
      } finally {
        exec.mockRestore();
      }
    });

    test('vendor prose cannot suppress failed operations', async () => {
      const failure = new git.GitFailure(
        'unclassified',
        'not a git repository; unknown revision; no such file; nothing to commit; No such remote; pathspec',
        Object.assign(new Error('hook failed'), { code: 128, stderr: 'original evidence' })
      );
      const exec = spyOn(git, 'execFileAsync').mockRejectedValue(failure);
      try {
        const calls = [
          () => git.findRepoRoot('/repo'),
          () => git.getRemoteUrl(repo('/repo')),
          () => git.checkout(repo('/repo'), branch('feature')),
          () => git.commitAllChanges(repo('/repo'), 'message'),
          () => git.isBranchMerged(repo('/repo'), branch('feature'), branch('main')),
          () => git.isPatchEquivalent(repo('/repo'), branch('feature'), 'main'),
          () => git.isAncestorOf(repo('/repo'), 'main'),
          () => git.getLastCommitDate(repo('/repo')),
        ];
        for (const call of calls) {
          const error = await call().catch((error: unknown) => error);
          expect(error).toBeInstanceOf(Error);
          expect(error).toHaveProperty('cause', failure);
        }
      } finally {
        exec.mockRestore();
      }
    });
  });

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

      await git.checkout(repo('/workspace/repo'), branch('feature-branch'));

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'checkout', 'feature-branch'],
        {
          timeout: 30000,
        }
      );
    });

    test('creates branch when exact ref is absent despite pathspec wording', async () => {
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'pathspec did not match',
          Object.assign(new Error('checkout'), {
            code: 1,
            stderr: "error: pathspec 'new-branch' did not match any file(s) known to git",
          })
        )
      );
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'absent exact ref',
          Object.assign(new Error('ref lookup'), { code: 1 })
        )
      );
      execSpy.mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' });
      execSpy.mockResolvedValueOnce({
        stdout: '+refs/heads/*:refs/remotes/origin/*\n',
        stderr: '',
      });
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'absent remote ref',
          Object.assign(new Error('ref lookup'), { code: 1 })
        )
      );
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await git.checkout(repo('/workspace/repo'), branch('new-branch'));

      expect(execSpy).toHaveBeenCalledTimes(6);
      expect(execSpy).toHaveBeenLastCalledWith(
        'git',
        ['-C', '/workspace/repo', 'checkout', '-b', 'new-branch'],
        {
          timeout: 30000,
        }
      );
    });

    test('creates branch when exact ref is absent despite missing-branch wording', async () => {
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          "branch doesn't exist",
          Object.assign(new Error('checkout'), {
            code: 1,
            stderr: "error: branch 'new-branch' doesn't exist",
          })
        )
      );
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'absent exact ref',
          Object.assign(new Error('ref lookup'), { code: 1 })
        )
      );
      execSpy.mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' });
      execSpy.mockResolvedValueOnce({
        stdout: '+refs/heads/*:refs/remotes/origin/*\n',
        stderr: '',
      });
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'absent remote ref',
          Object.assign(new Error('ref lookup'), { code: 1 })
        )
      );
      execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await git.checkout(repo('/workspace/repo'), branch('new-branch'));

      expect(execSpy).toHaveBeenCalledTimes(6);
      expect(execSpy).toHaveBeenLastCalledWith(
        'git',
        ['-C', '/workspace/repo', 'checkout', '-b', 'new-branch'],
        {
          timeout: 30000,
        }
      );
    });

    test('preserves a typed checkout timeout without attempting branch creation', async () => {
      const failure = new git.GitFailure('timeout', 'checkout timed out');
      execSpy.mockRejectedValueOnce(failure);
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const error = await git
        .checkout(repo('/workspace/repo'), branch('feature'))
        .catch((error: unknown) => error);
      expect(error).toHaveProperty('cause', failure);
      expect(execSpy).toHaveBeenCalledTimes(1);
    });

    test('preserves the checkout failure when remote inspection fails', async () => {
      const failure = new git.GitFailure(
        'unclassified',
        'original checkout failure',
        Object.assign(new Error('checkout'), { code: 1 })
      );
      execSpy.mockRejectedValueOnce(failure);
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'absent ref',
          Object.assign(new Error('rev lookup'), { code: 1 })
        )
      );
      execSpy.mockRejectedValueOnce(new Error('remote inspection failed'));
      const error = await git
        .checkout(repo('/workspace/repo'), branch('feature'))
        .catch((error: unknown) => error);
      expect(error).toHaveProperty('cause', failure);
      expect(execSpy).toHaveBeenCalledTimes(3);
    });

    test('preserves the checkout failure when a candidate ref cannot be inspected', async () => {
      const failure = new git.GitFailure(
        'unclassified',
        'checkout failed',
        Object.assign(new Error('checkout'), { code: 1 })
      );
      execSpy.mockRejectedValueOnce(failure);
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'absent ref',
          Object.assign(new Error('rev lookup'), { code: 1 })
        )
      );
      execSpy.mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' });
      execSpy.mockResolvedValueOnce({ stdout: '+refs/heads/*:refs/vendor/*\n', stderr: '' });
      execSpy.mockRejectedValueOnce(new git.GitFailure('timeout', 'ref inspection timed out'));

      const error = await git
        .checkout(repo('/workspace/repo'), branch('feature'))
        .catch((error: unknown) => error);
      expect(error).toHaveProperty('cause', failure);
      expect(execSpy).toHaveBeenCalledTimes(5);
      expect(execSpy).toHaveBeenLastCalledWith(
        'git',
        ['-C', '/workspace/repo', 'show-ref', '--verify', '--quiet', 'refs/vendor/feature'],
        { timeout: 10000 }
      );
    });

    test('throws and logs on unexpected error', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(
        Object.assign(new Error('Permission denied'), { stderr: 'fatal: Permission denied' })
      );

      await expect(git.checkout(repo('/workspace/repo'), branch('some-branch'))).rejects.toThrow(
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

  describe('checkout with real Git refs', () => {
    let root: git.RepoPath;
    let base: string;
    let remoteCommit: string;
    const run = async (...args: string[]): Promise<string> => {
      const result = await git.execFileAsync('git', ['-C', root, ...args]);
      return result.stdout.trim();
    };

    beforeEach(async () => {
      root = repo(trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-checkout-'))));
      await run('init', '-q', '-b', 'main');
      await run('config', 'user.email', 'test@example.com');
      await run('config', 'user.name', 'Archon Test');
      await run('config', 'commit.gpgsign', 'false');
      await run('config', 'checkout.guess', 'true');
      await run('commit', '--allow-empty', '-qm', 'base');
      base = await run('rev-parse', 'HEAD');
      await writeFile(join(root, 'conflict.txt'), 'remote content');
      await run('add', 'conflict.txt');
      await run('commit', '-qm', 'remote change');
      remoteCommit = await run('rev-parse', 'HEAD');
      await run('remote', 'add', 'origin', root);
      await run('update-ref', 'refs/remotes/origin/feature', remoteCommit);
      await run('reset', '--hard', base);
    });

    test.each(['refs/heads/feature', 'origin/feature', 'release', 'commit SHA'])(
      'preserves a conflicting checkout of directly resolvable %s',
      async name => {
        await run('update-ref', 'refs/heads/feature', remoteCommit);
        await run('tag', 'release', remoteCommit);
        const revision = name === 'commit SHA' ? remoteCommit : name;
        await writeFile(join(root, 'conflict.txt'), 'local untracked content');
        const original = await run('checkout', revision).catch((error: unknown) => error);
        expect(original).toBeInstanceOf(git.GitFailure);
        if (!(original instanceof git.GitFailure)) throw new Error('expected checkout failure');
        const error = await git.checkout(root, branch(revision)).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(error).toHaveProperty('cause.code', 1);
        expect(error).toHaveProperty('cause.stderr', original.stderr);
        expect(await run('rev-parse', 'HEAD')).toBe(base);
        expect(await run('symbolic-ref', '--short', 'HEAD')).toBe('main');
        expect(await readFile(join(root, 'conflict.txt'), 'utf8')).toBe('local untracked content');
      }
    );

    test('preserves a remote checkout conflict without creating a branch at HEAD', async () => {
      await writeFile(join(root, 'conflict.txt'), 'local untracked content');
      const error = await git.checkout(root, branch('feature')).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('expected checkout failure');
      expect(error.cause).toBeInstanceOf(git.GitFailure);
      expect(error.cause).toHaveProperty('code', 1);
      expect(error.cause).toHaveProperty('stderr', expect.stringContaining('conflict.txt'));
      expect(await run('rev-parse', 'HEAD')).toBe(base);
      expect(await git.localBranchExists(root, branch('feature'))).toBe(false);
      expect(await readFile(join(root, 'conflict.txt'), 'utf8')).toBe('local untracked content');
    });

    test.each([
      ['+refs/heads/*:refs/vendor/*', 'refs/vendor/feature'],
      ['+refs/heads/feature:refs/vendor/feature', 'refs/vendor/feature'],
      ['+refs/heads/*:refs/remotes/alias/*', 'refs/remotes/alias/feature'],
      ['+refs/heads/feature:refs/remotes/alias/feature', 'refs/remotes/alias/feature'],
    ])('preserves a checkout conflict with fetch mapping %s', async (mapping, destination) => {
      await run('config', '--replace-all', 'remote.origin.fetch', mapping);
      await run('update-ref', destination, remoteCommit);
      await run('update-ref', '-d', 'refs/remotes/origin/feature');
      await writeFile(join(root, 'conflict.txt'), 'local untracked content');
      const error = await git.checkout(root, branch('feature')).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('expected checkout failure');
      expect(error.cause).toBeInstanceOf(git.GitFailure);
      expect(error.cause).toHaveProperty('code', 1);
      expect(error.cause).toHaveProperty('stderr', expect.stringContaining('conflict.txt'));
      expect(await run('rev-parse', 'HEAD')).toBe(base);
      expect(await git.localBranchExists(root, branch('feature'))).toBe(false);
      expect(await readFile(join(root, 'conflict.txt'), 'utf8')).toBe('local untracked content');
    });

    test('preserves a checkout conflict from a later fetch mapping', async () => {
      await run(
        'config',
        '--replace-all',
        'remote.origin.fetch',
        '+refs/heads/unrelated:refs/vendor/unrelated'
      );
      await run('config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/vendor/*');
      await run('update-ref', 'refs/vendor/feature', remoteCommit);
      await run('update-ref', '-d', 'refs/remotes/origin/feature');
      await writeFile(join(root, 'conflict.txt'), 'local untracked content');
      const original = await run('checkout', 'feature').catch((error: unknown) => error);
      expect(original).toBeInstanceOf(git.GitFailure);
      if (!(original instanceof git.GitFailure)) throw new Error('expected checkout failure');

      const error = await git.checkout(root, branch('feature')).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('expected checkout failure');
      expect(error.cause).toBeInstanceOf(git.GitFailure);
      expect(error.cause).toHaveProperty('code', 1);
      expect(error.cause).toHaveProperty('stderr', original.stderr);
      expect(original.stderr).toContain('conflict.txt');
      expect(await run('rev-parse', 'HEAD')).toBe(base);
      expect(await git.localBranchExists(root, branch('feature'))).toBe(false);
      expect(await readFile(join(root, 'conflict.txt'), 'utf8')).toBe('local untracked content');
    });

    test.each([false, true])(
      'creates an absent branch amid many unrelated refs (remote: %s)',
      async withRemote => {
        if (!withRemote) await run('remote', 'remove', 'origin');
        const tags = Array.from(
          { length: 25_000 },
          (_, index) =>
            `${base} refs/tags/unrelated-long-tag-to-exceed-the-output-buffer-${String(index).padStart(5, '0')}\n`
        ).join('');
        await writeFile(join(root, '.git', 'packed-refs'), `# pack-refs with: sorted\n${tags}`);

        await git.checkout(root, branch('new-branch'));
        expect(await run('rev-parse', 'HEAD')).toBe(base);
        expect(await run('symbolic-ref', '--short', 'HEAD')).toBe('new-branch');
      }
    );

    test('preserves ambiguous remote checkout failure without creating a branch', async () => {
      await run('remote', 'add', 'other', root);
      await run('config', 'checkout.defaultRemote', 'nonexistent');
      await run('update-ref', 'refs/remotes/other/feature', remoteCommit);
      await expect(git.checkout(root, branch('feature'))).rejects.toThrow('Failed to checkout');
      expect(await run('rev-parse', 'HEAD')).toBe(base);
      expect(await git.localBranchExists(root, branch('feature'))).toBe(false);
    });

    test('checks out an unambiguous remote branch at its commit', async () => {
      await git.checkout(root, branch('feature'));
      expect(await run('rev-parse', 'HEAD')).toBe(remoteCommit);
      expect(await run('symbolic-ref', '--short', 'HEAD')).toBe('feature');
    });

    test.each(['+refs/heads/*:refs/vendor/*', '+refs/heads/feature:refs/vendor/feature'])(
      'creates an absent branch with fetch mapping %s',
      async mapping => {
        await run('config', '--replace-all', 'remote.origin.fetch', mapping);
        await run('update-ref', 'refs/vendor/feature', remoteCommit);
        await run('update-ref', '-d', 'refs/remotes/origin/feature');
        await git.checkout(root, branch('new-branch'));
        expect(await run('rev-parse', 'HEAD')).toBe(base);
        expect(await run('symbolic-ref', '--short', 'HEAD')).toBe('new-branch');
      }
    );

    test('creates a genuinely new branch at HEAD', async () => {
      await git.checkout(root, branch('new-branch'));
      expect(await run('rev-parse', 'HEAD')).toBe(base);
      expect(await run('symbolic-ref', '--short', 'HEAD')).toBe('new-branch');
    });
  });

  describe('hasUncommittedChangesStrict', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test.each(['', '?? new-file\0', ' M tracked\0'])(
      'uses explicit removal status flags and record presence: %j',
      async stdout => {
        execSpy.mockResolvedValue({ stdout, stderr: '' });
        expect(await git.hasUncommittedChangesStrict(worktree('/workspace/wt'))).toBe(
          stdout.length > 0
        );
        expect(execSpy).toHaveBeenCalledWith(
          'git',
          [
            '-C',
            '/workspace/wt',
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--ignore-submodules=none',
          ],
          { timeout: 5 * 60 * 1000 }
        );
      }
    );

    test('propagates status failures rather than reporting dirty state', async () => {
      const failure = new Error('status unavailable');
      execSpy.mockRejectedValue(failure);
      await expect(git.hasUncommittedChangesStrict(worktree('/workspace/wt'))).rejects.toBe(
        failure
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

      const result = await git.hasUncommittedChanges(repo('/workspace/repo'));

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

      const result = await git.hasUncommittedChanges(repo('/workspace/repo'));

      expect(result).toBe(false);
    });

    test('returns false when output is only whitespace', async () => {
      execSpy.mockResolvedValue({ stdout: '   \n\n', stderr: '' });

      const result = await git.hasUncommittedChanges(repo('/workspace/repo'));

      expect(result).toBe(false);
    });

    test('returns false for structured repository absence', async () => {
      const error = new git.GitFailure('not_repository', 'absent checkout');
      execSpy.mockRejectedValue(error);

      const result = await git.hasUncommittedChanges(repo('/nonexistent'));

      expect(result).toBe(false);
    });

    test('returns true (fail-safe) when git fails with unexpected error', async () => {
      execSpy.mockRejectedValue(
        new git.GitFailure('unclassified', 'No such file or directory; not a git repository')
      );

      const result = await git.hasUncommittedChanges(repo('/workspace/corrupted'));

      expect(result).toBe(true);
    });

    test('returns true (fail-safe) when git lock file exists', async () => {
      execSpy.mockRejectedValue(new Error('Another git process seems to be running'));

      const result = await git.hasUncommittedChanges(repo('/workspace/locked'));

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
    for (const name of ['main', 'master', 'dev', 'team/trunk']) {
      test(`reads advertised ${name} instead of cached HEAD`, async () => {
        execSpy.mockImplementation(async (_cmd, args) => ({
          stdout: args.includes('ls-remote')
            ? `ref: refs/heads/${name}\tHEAD\nabc123\tHEAD\nabc123\trefs/heads/${name}\n`
            : '.git',
          stderr: '',
        }));
        expect(await git.getDefaultBranch(repo('/workspace/repo'), 'upstream')).toBe(branch(name));
        expect(execSpy).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['ls-remote', 'upstream']),
          expect.any(Object)
        );
      });
    }
    test('unknown HEAD does not guess from advertised main', async () => {
      execSpy.mockResolvedValue({ stdout: 'abc123\trefs/heads/main\n', stderr: '' });
      await expect(git.getDefaultBranch(repo('/workspace/repo'))).rejects.toThrow(
        'origin/HEAD is not known'
      );
      for (const setting of ['--base', 'worktree.baseBranch', 'default_branch'])
        await expect(git.getDefaultBranch(repo('/workspace/repo'))).rejects.toThrow(setting);
    });
    test('a failed remote query retains evidence', async () => {
      execSpy.mockImplementation(async (_cmd, args) => {
        if (args.includes('ls-remote'))
          throw Object.assign(new Error('connection refused'), { code: 128 });
        return { stdout: '.git', stderr: '' };
      });
      await expect(git.getDefaultBranch(repo('/workspace/repo'))).rejects.toThrow(
        'connection refused'
      );
    });
    test('remote inspection scopes credentials, sanitizes failures, and leaves native helpers available without credentials', async () => {
      execSpy.mockImplementation(async (_cmd, args, options) => {
        expect(args.join(' ')).not.toContain('private-token');
        expect(options?.env?.GIT_TERMINAL_PROMPT).toBe('0');
        if (options?.env?.ARCHON_GIT_PASSWORD) {
          expect(args).toContain('credential.helper=');
          throw Object.assign(new Error('private-token denied'), { code: 128 });
        }
        expect(args).not.toContain('credential.helper=');
        return { stdout: '', stderr: '' };
      });
      const result = await git.inspectRemoteBranches({
        kind: 'url',
        url: 'https://git.example.com/repo',
        credentials: { username: 'oauth2', password: 'private-token' },
      });
      expect(result).toEqual({ status: 'unavailable', evidence: '*** denied' });
      expect(process.env.ARCHON_GIT_PASSWORD).toBeUndefined();
      expect(
        await git.inspectRemoteBranches({ kind: 'url', url: 'https://git.example.com/repo' })
      ).toEqual({ status: 'available', defaultBranch: null, branches: [] });
    });
    test('rejects credential-bearing URLs before git is called', async () => {
      await expect(
        git.inspectRemoteBranches({ kind: 'url', url: 'https://user:secret@git.example.com/repo' })
      ).rejects.toThrow('must not include credentials');
      expect(execSpy).not.toHaveBeenCalled();
    });
    test('local failures propagate before querying a remote', async () => {
      execSpy.mockRejectedValue(new Error('permission denied'));
      await expect(git.getDefaultBranch(repo('/workspace/repo'))).rejects.toThrow(
        'permission denied'
      );
      expect(execSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getUniqueCommitCount', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns zero when all tip commits are reachable from surviving refs', async () => {
      execSpy
        .mockResolvedValueOnce({
          stdout:
            'refs/heads/feature/auth\nrefs/heads/dev\nrefs/remotes/origin/feature/auth\nrefs/remotes/origin/dev\nrefs/tags/v1.0.0\n',
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      const result = await git.getUniqueCommitCount(
        repo('/workspace/repo'),
        branch('feature/auth')
      );

      expect(result).toBe(0);
      expect(execSpy).toHaveBeenNthCalledWith(
        1,
        'git',
        [
          '-C',
          '/workspace/repo',
          'for-each-ref',
          '--format=%(refname)',
          'refs/heads',
          'refs/remotes',
          'refs/tags',
        ],
        expect.any(Object)
      );
      expect(execSpy).toHaveBeenNthCalledWith(
        2,
        'git',
        [
          '-C',
          '/workspace/repo',
          'rev-list',
          'feature/auth',
          '--not',
          'refs/heads/dev',
          'refs/remotes/origin/dev',
          'refs/tags/v1.0.0',
        ],
        expect.any(Object)
      );
    });

    test('counts commits reachable only from the candidate branch', async () => {
      execSpy
        .mockResolvedValueOnce({ stdout: 'refs/heads/feature/auth\nrefs/heads/dev\n', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'abc123\ndef456\n\n', stderr: '' });

      const result = await git.getUniqueCommitCount(
        repo('/workspace/repo'),
        branch('feature/auth')
      );

      expect(result).toBe(2);
    });

    test('excludes the configured remote counterpart but retains other remotes and tags', async () => {
      execSpy
        .mockResolvedValueOnce({
          stdout:
            'refs/heads/feature/auth\nrefs/remotes/upstream/feature/auth\nrefs/remotes/origin/feature/auth\nrefs/tags/reviewed\n',
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' });

      await git.getUniqueCommitCount(repo('/workspace/repo'), branch('feature/auth'), 'upstream');

      expect(execSpy).toHaveBeenNthCalledWith(
        2,
        'git',
        [
          '-C',
          '/workspace/repo',
          'rev-list',
          'feature/auth',
          '--not',
          'refs/remotes/origin/feature/auth',
          'refs/tags/reviewed',
        ],
        expect.any(Object)
      );
    });

    test('checks the full candidate history when no refs survive deletion', async () => {
      execSpy
        .mockResolvedValueOnce({
          stdout: 'refs/heads/feature/auth\nrefs/remotes/origin/feature/auth\n',
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: 'abc123\ndef456\n', stderr: '' });

      const result = await git.getUniqueCommitCount(
        repo('/workspace/repo'),
        branch('feature/auth')
      );

      expect(result).toBe(2);
      expect(execSpy).toHaveBeenNthCalledWith(
        2,
        'git',
        ['-C', '/workspace/repo', 'rev-list', 'feature/auth', '--not'],
        expect.any(Object)
      );
    });

    test('rejects when Git cannot enumerate refs', async () => {
      execSpy.mockRejectedValueOnce(new Error('fatal: not a git repository'));

      await expect(
        git.getUniqueCommitCount(repo('/workspace/repo'), branch('feature/auth'))
      ).rejects.toThrow(
        'Failed to count unique commits for feature/auth: fatal: not a git repository'
      );
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
        if (args.includes('diff')) return { stdout: 'file.ts\0', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const result = await git.commitAllChanges(repo('/workspace/repo'), 'test commit');

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

      const result = await git.commitAllChanges(repo('/workspace/repo'), 'test commit');

      expect(result).toBe(false);
      expect(execSpy).toHaveBeenCalledTimes(1); // only hasUncommittedChanges
    });

    test('returns false when staging normalizes all changes away', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => ({
        stdout: args.includes('status') ? ' M file.ts\n' : '',
        stderr: '',
      }));
      expect(await git.commitAllChanges(repo('/workspace/repo'), 'test commit')).toBe(false);
      expect(execSpy.mock.calls.some(([, args]) => args.includes('commit'))).toBe(false);
    });

    test('a hook printing nothing to commit remains a failure', async () => {
      const failure = new git.GitFailure(
        'unclassified',
        'hook failed',
        Object.assign(new Error('commit'), {
          code: 1,
          stdout: 'nothing to commit',
          stderr: 'hook rejected',
        })
      );
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status') || args.includes('diff'))
          return { stdout: 'file.ts\0', stderr: '' };
        if (args.includes('commit')) throw failure;
        return { stdout: '', stderr: '' };
      });
      const error = await git
        .commitAllChanges(repo('/workspace/repo'), 'message')
        .catch((error: unknown) => error);
      expect(error).toHaveProperty('cause', failure);
    });

    test('throws error when git add fails', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        if (args.includes('diff')) return { stdout: 'file.ts\0', stderr: '' };
        if (args.includes('add')) {
          throw new Error('git add failed');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.commitAllChanges(repo('/workspace/repo'), 'test commit')).rejects.toThrow(
        'git add failed'
      );
    });

    test('throws error when git commit fails', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          return { stdout: ' M file.ts\n', stderr: '' };
        }
        if (args.includes('diff')) return { stdout: 'file.ts\0', stderr: '' };
        if (args.includes('add')) {
          return { stdout: '', stderr: '' };
        }
        if (args.includes('commit')) {
          throw new Error('pre-commit hook failed');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.commitAllChanges(repo('/workspace/repo'), 'test commit')).rejects.toThrow(
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

      const result = await git.isBranchMerged(
        repo('/workspace/repo'),
        branch('feature-branch'),
        branch('main')
      );
      expect(result).toBe(true);
    });

    test('returns false when branch is not merged', async () => {
      execSpy.mockResolvedValue({
        stdout: '* main\n  other-branch\n',
        stderr: '',
      });

      const result = await git.isBranchMerged(
        repo('/workspace/repo'),
        branch('feature-branch'),
        branch('main')
      );
      expect(result).toBe(false);
    });

    test('handles branches with / characters', async () => {
      execSpy.mockResolvedValue({
        stdout: '  feature/auth\n* main\n',
        stderr: '',
      });

      const result = await git.isBranchMerged(
        repo('/workspace/repo'),
        branch('feature/auth'),
        branch('main')
      );
      expect(result).toBe(true);
    });

    test('returns false on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));

      const result = await git.isBranchMerged(
        repo('/workspace/repo'),
        branch('feature'),
        branch('main')
      );
      expect(result).toBe(false);
    });

    test('throws and logs on unexpected errors', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(
        git.isBranchMerged(repo('/workspace/repo'), branch('feature'), branch('main'))
      ).rejects.toThrow('Failed to check if feature is merged into main');
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

      const result = await git.isBranchMerged(
        repo('/workspace/repo'),
        branch('feature'),
        branch('develop')
      );

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

      const result = await git.isBranchMerged(
        repo('/workspace/repo'),
        branch('main'),
        branch('main')
      );
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
      const result = await git.isPatchEquivalent(
        repo('/workspace/repo'),
        branch('feature'),
        branch('main')
      );
      expect(result).toBe(true);
    });

    test('returns false when any cherry line starts with +', async () => {
      execSpy.mockResolvedValue({ stdout: '- abc123\n+ def456\n', stderr: '' });
      const result = await git.isPatchEquivalent(
        repo('/workspace/repo'),
        branch('feature'),
        branch('main')
      );
      expect(result).toBe(false);
    });

    test('returns true for empty cherry output', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });
      const result = await git.isPatchEquivalent(
        repo('/workspace/repo'),
        branch('feature'),
        branch('main')
      );
      expect(result).toBe(true);
    });

    test('returns false on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));
      const result = await git.isPatchEquivalent(
        repo('/workspace/repo'),
        branch('feature'),
        branch('main')
      );
      expect(result).toBe(false);
    });

    test('throws expected errors when the caller needs proof of the comparison', async () => {
      execSpy.mockRejectedValue(new Error('fatal: unknown revision origin/main'));

      await expect(
        git.isPatchEquivalent(repo('/workspace/repo'), branch('feature'), 'origin/main', {
          throwOnExpectedError: true,
        })
      ).rejects.toThrow('Failed to check if feature is patch-equivalent to origin/main');
    });

    test('throws on unexpected errors', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));
      await expect(
        git.isPatchEquivalent(repo('/workspace/repo'), branch('feature'), branch('main'))
      ).rejects.toThrow('Failed to check if feature is patch-equivalent to main');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ branchName: 'feature', baseRef: 'main' }),
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

      const result = await git.getLastCommitDate(repo('/workspace/repo'));
      expect(result).toBeInstanceOf(Date);
      expect(result!.getFullYear()).toBe(2024);
    });

    test('returns null on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));

      const result = await git.getLastCommitDate(repo('/workspace/repo'));
      expect(result).toBeNull();
    });

    test('returns null on expected errors (no commits)', async () => {
      execSpy.mockRejectedValueOnce(new git.GitFailure('unclassified', 'log failed'));
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'unborn HEAD',
          Object.assign(new Error('no HEAD'), { code: 1 })
        )
      );

      const result = await git.getLastCommitDate(repo('/workspace/repo'));
      expect(result).toBeNull();
    });

    test('returns null for structured repository absence', async () => {
      const error = new git.GitFailure('not_repository', 'absent checkout');
      execSpy.mockRejectedValue(error);

      const result = await git.getLastCommitDate(repo('/nonexistent'));
      expect(result).toBeNull();
    });

    test('throws and logs on unexpected errors', async () => {
      mockLogger.error.mockClear();
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.getLastCommitDate(repo('/workspace/repo'))).rejects.toThrow(
        'Failed to get last commit date for /workspace/repo'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ workingPath: '/workspace/repo' }),
        'last_commit_date_check_failed'
      );
    });

    test('returns null for empty git log output', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.getLastCommitDate(repo('/workspace/repo'));
      expect(result).toBeNull();
    });

    test('returns null and warns for invalid date format', async () => {
      mockLogger.warn.mockClear();
      execSpy.mockResolvedValue({ stdout: 'not-a-date\n', stderr: '' });

      const result = await git.getLastCommitDate(repo('/workspace/repo'));
      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workingPath: '/workspace/repo', rawDate: 'not-a-date' }),
        'invalid_commit_date_format'
      );
    });
  });

  describe('getCurrentBranch', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns branch name when on a named branch', async () => {
      execSpy.mockResolvedValue({ stdout: 'main\n', stderr: '' });

      const result = await git.getCurrentBranch('/workspace/repo' as git.RepoPath);

      expect(result).toBe(branch('main'));
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'symbolic-ref', '--short', 'HEAD'],
        { timeout: 10000 }
      );
    });

    test('returns null for empty stdout (detached HEAD)', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      expect(await git.getCurrentBranch('/workspace/repo' as git.RepoPath)).toBeNull();
    });

    test('returns null for whitespace-only stdout', async () => {
      execSpy.mockResolvedValue({ stdout: '   \n', stderr: '' });

      expect(await git.getCurrentBranch('/workspace/repo' as git.RepoPath)).toBeNull();
    });

    test('returns null on any git error (detached HEAD, ENOENT, not a git repo)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));

      expect(await git.getCurrentBranch('/workspace/repo' as git.RepoPath)).toBeNull();
    });

    test('returns null on ENOENT (path not found)', async () => {
      const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      execSpy.mockRejectedValue(error);

      expect(await git.getCurrentBranch('/nonexistent' as git.RepoPath)).toBeNull();
    });
  });

  describe('ownership-critical branch probes', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('getCurrentBranchStrict returns a named branch', async () => {
      execSpy.mockResolvedValue({ stdout: 'feature/live-pr\n', stderr: '' });

      await expect(git.getCurrentBranchStrict('/workspace/repo' as git.RepoPath)).resolves.toBe(
        branch('feature/live-pr')
      );
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'symbolic-ref', '--quiet', '--short', 'HEAD'],
        { timeout: 10000 }
      );
    });

    test('getCurrentBranchStrict returns null only for detached HEAD', async () => {
      execSpy.mockRejectedValue(Object.assign(new Error('not a symbolic ref'), { code: 1 }));

      await expect(
        git.getCurrentBranchStrict('/workspace/repo' as git.RepoPath)
      ).resolves.toBeNull();
    });

    test('getCurrentBranchStrict preserves infrastructure failures', async () => {
      execSpy.mockRejectedValue(
        Object.assign(new Error('operation timed out'), { code: 'ETIMEDOUT' })
      );

      let error: Error | undefined;
      try {
        await git.getCurrentBranchStrict('/workspace/repo' as git.RepoPath);
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toMatch(/operation timed out/);
      expect((error?.cause as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    });

    test('localBranchExists distinguishes a missing ref from an unreadable repository', async () => {
      execSpy.mockRejectedValueOnce(Object.assign(new Error('missing ref'), { code: 1 }));
      await expect(
        git.localBranchExists('/workspace/repo' as git.RepoPath, branch('feature/missing'))
      ).resolves.toBe(false);

      execSpy.mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' })
      );
      let error: Error | undefined;
      try {
        await git.localBranchExists('/workspace/repo' as git.RepoPath, branch('feature/live'));
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toMatch(/permission denied/);
      expect((error?.cause as NodeJS.ErrnoException).code).toBe('EACCES');
    });
  });

  describe('countCommitsAhead', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns commit count when ahead of origin', async () => {
      execSpy.mockResolvedValue({ stdout: '3\n', stderr: '' });

      const result = await git.countCommitsAhead(
        '/workspace/repo' as git.RepoPath,
        'main' as git.BranchName
      );

      expect(result).toBe(3);
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'rev-list', '--count', 'origin/main..HEAD'],
        { timeout: 10000 }
      );
    });

    test('returns 0 when in sync', async () => {
      execSpy.mockResolvedValue({ stdout: '0\n', stderr: '' });

      expect(
        await git.countCommitsAhead('/workspace/repo' as git.RepoPath, 'main' as git.BranchName)
      ).toBe(0);
    });

    test('returns 0 for NaN stdout (malformed git output)', async () => {
      execSpy.mockResolvedValue({ stdout: 'not-a-number\n', stderr: '' });

      expect(
        await git.countCommitsAhead('/workspace/repo' as git.RepoPath, 'main' as git.BranchName)
      ).toBe(0);
    });

    test('returns 0 on any error (origin branch missing, ENOENT, etc.)', async () => {
      execSpy.mockRejectedValue(new Error("fatal: unknown revision 'origin/main..HEAD'"));

      expect(
        await git.countCommitsAhead('/workspace/repo' as git.RepoPath, 'main' as git.BranchName)
      ).toBe(0);
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
      const err = new git.GitFailure(
        'unclassified',
        'not ancestor',
        Object.assign(new Error(''), { code: 1, stderr: '' })
      );
      execSpy.mockRejectedValue(err);

      const result = await git.isAncestorOf(
        '/worktrees/feature' as git.WorktreePath,
        'origin/main'
      );
      expect(result).toBe(false);
    });

    test('returns false on expected errors (not a git repository)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));

      const result = await git.isAncestorOf(
        '/worktrees/feature' as git.WorktreePath,
        'origin/main'
      );
      expect(result).toBe(false);
    });

    for (const message of [
      'unknown revision',
      'not a valid object name',
      'no such file or directory',
      'spawn git ENOENT',
    ]) {
      test(`unclassified ancestry error propagates: ${message}`, async () => {
        const failure = new git.GitFailure(
          'unclassified',
          message,
          Object.assign(new Error(message), { code: 128 })
        );
        execSpy.mockRejectedValue(failure);
        const error = await git
          .isAncestorOf(repo('/repo'), 'origin/missing')
          .catch((error: unknown) => error);
        expect(error).toHaveProperty('cause', failure);
      });
    }

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
      getDefaultBranchSpy.mockResolvedValue(branch('main'));
    });

    afterEach(() => {
      execSpy.mockRestore();
      getDefaultBranchSpy.mockRestore();
    });

    test('fetches origin branch and returns synced result', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return { stdout: 'abc12345\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result).toEqual({
        branch: branch('main'),
        synced: true,
        mode: 'fast-forward',
        state: 'in_sync',
        previousHead: 'abc12345',
        newHead: 'abc12345',
        updated: false,
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'fetch', 'origin', 'main'],
        expect.any(Object)
      );
    });

    test('does not reset by default', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset');
      });

      expect(resetCalls).toHaveLength(0);
    });

    test('hard-resets working tree to origin in reset mode', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.syncWorkspace(repo('/workspace/repo'), branch('main'), { mode: 'reset' });

      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset');
      });

      expect(resetCalls).toHaveLength(1);
      expect(resetCalls[0][1]).toEqual(['-C', '/workspace/repo', 'reset', '--hard', 'origin/main']);
    });

    test('throws if reset mode fails after successful fetch', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('reset')) {
          throw new Error('fatal: Could not reset index file');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('main'), { mode: 'reset' })
      ).rejects.toThrow('Reset to origin/main failed');
    });

    test('throws error if fetch fails', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('ls-remote'))
          return { stdout: 'abc123\trefs/heads/main\nabc123\trefs/heads/dev\n', stderr: '' };
        if (args.includes('fetch')) {
          throw new Error('fatal: unable to access repository');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace(repo('/workspace/repo'), branch('main'))).rejects.toThrow(
        'unable to access repository'
      );
    });

    test('logs short SHA read failures without failing sync', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          throw new Error('fatal: bad revision HEAD');
        }
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.previousHead).toBe('');
      expect(result.newHead).toBe('');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/workspace/repo', ref: 'HEAD' }),
        'workspace.short_sha_read_failed'
      );
    });

    test('passes correct timeout value to fetch command', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      const fetchCall = execSpy.mock.calls.find((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch');
      });
      expect(fetchCall?.[2]).toEqual({ timeout: 60000 });
    });

    test('includes operation context in fetch error message', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('ls-remote'))
          return { stdout: 'abc123\trefs/heads/main\nabc123\trefs/heads/dev\n', stderr: '' };
        if (args.includes('fetch')) {
          throw new Error('fatal: network unreachable');
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace(repo('/workspace/repo'), branch('main'))).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );
    });

    test('derives branch from getDefaultBranch when override not provided', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return { stdout: 'abc12345\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('origin/develop')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      getDefaultBranchSpy.mockResolvedValue(branch('develop'));

      const result = await git.syncWorkspace(repo('/workspace/repo'));

      expect(result).toEqual({
        branch: branch('develop'),
        synced: true,
        mode: 'fast-forward',
        state: 'in_sync',
        previousHead: 'abc12345',
        newHead: 'abc12345',
        updated: false,
      });
      expect(getDefaultBranchSpy).toHaveBeenCalledWith('/workspace/repo', 'origin');
    });

    test('throws actionable error when configured branch not found on remote', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error("fatal: couldn't find remote ref does-not-exist");
        }
        return { stdout: '', stderr: '' };
      });

      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('does-not-exist'))
      ).rejects.toThrow("Configured base branch 'does-not-exist' not found on remote");
      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('does-not-exist'))
      ).rejects.toThrow('update worktree.baseBranch');
    });

    test('throws generic error when auto-detected branch not found (not actionable)', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error("fatal: couldn't find remote ref main");
        }
        return { stdout: '', stderr: '' };
      });
      getDefaultBranchSpy.mockResolvedValue(branch('main'));

      await expect(git.syncWorkspace(repo('/workspace/repo'))).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );
      await expect(git.syncWorkspace(repo('/workspace/repo'))).rejects.not.toThrow(
        'worktree.baseBranch'
      );
    });

    test('fetch-only mode fetches and does not reset or merge', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return { stdout: 'abc12345\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'def67890abcdef\n', stderr: '' };
        }
        if (args.includes('merge-base')) {
          throw Object.assign(new Error('not ancestor'), { code: 1 });
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'), {
        mode: 'fetch-only',
      });

      expect(result.mode).toBe('fetch-only');
      expect(result.state).toBe('diverged');
      expect(result.updated).toBe(false);

      // Fetch should still have been called
      const fetchCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('fetch');
      });
      expect(fetchCalls).toHaveLength(1);

      // Reset should NOT have been called
      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset');
      });
      expect(resetCalls).toHaveLength(0);
      const mergeCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('merge');
      });
      expect(mergeCalls).toHaveLength(0);
    });

    test('dirty tracked files return dirty and do not merge or reset', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: ' M src/index.ts\n', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return { stdout: 'abc12345\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.state).toBe('dirty');
      expect(
        execSpy.mock.calls.some((call: unknown[]) => (call[1] as string[]).includes('merge'))
      ).toBe(false);
      expect(
        execSpy.mock.calls.some((call: unknown[]) => (call[1] as string[]).includes('reset'))
      ).toBe(false);
    });

    test('untracked files do not mark the checkout dirty', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          expect(args).toContain('--untracked-files=no');
          return { stdout: '', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return { stdout: 'abc12345\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.state).toBe('in_sync');
    });

    test('behind on current target branch fast-forwards', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          const shortCalls = execSpy.mock.calls.filter((call: unknown[]) =>
            (call[1] as string[]).includes('--short=8')
          );
          return { stdout: shortCalls.length > 1 ? 'def67890\n' : 'abc12345\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
          return { stdout: 'main\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'def67890abcdef\n', stderr: '' };
        }
        if (args.includes('merge-base')) {
          if (args[4] === 'abc12345abcdef' && args[5] === 'def67890abcdef') {
            return { stdout: '', stderr: '' };
          }
          throw Object.assign(new Error('not ancestor'), { code: 1 });
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.state).toBe('in_sync');
      expect(result.updated).toBe(true);
      expect(
        execSpy.mock.calls.some((call: unknown[]) => (call[1] as string[]).includes('merge'))
      ).toBe(true);
    });

    test('behind on non-target current branch does not fast-forward', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return { stdout: 'abc12345\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('--abbrev-ref')) {
          return { stdout: 'feature\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'def67890abcdef\n', stderr: '' };
        }
        if (args.includes('merge-base')) {
          if (args[4] === 'abc12345abcdef' && args[5] === 'def67890abcdef') {
            return { stdout: '', stderr: '' };
          }
          throw Object.assign(new Error('not ancestor'), { code: 1 });
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.state).toBe('behind');
      expect(result.updated).toBe(false);
      expect(
        execSpy.mock.calls.some((call: unknown[]) => (call[1] as string[]).includes('merge'))
      ).toBe(false);
    });

    test('ahead and diverged preserve local state', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return { stdout: 'def67890\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'def67890abcdef\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        if (args.includes('merge-base')) {
          if (args[4] === 'abc12345abcdef' && args[5] === 'def67890abcdef') {
            return { stdout: '', stderr: '' };
          }
          throw Object.assign(new Error('not ancestor'), { code: 1 });
        }
        return { stdout: '', stderr: '' };
      });

      const aheadResult = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));
      expect(aheadResult.state).toBe('ahead');
      expect(
        execSpy.mock.calls.some((call: unknown[]) => (call[1] as string[]).includes('merge'))
      ).toBe(false);

      execSpy.mockClear();
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: `${args.at(-1)}-sha\n`, stderr: '' };
        if (args.includes('merge-base'))
          throw Object.assign(new Error('not ancestor'), { code: 1 });
        return { stdout: '', stderr: '' };
      });

      const divergedResult = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));
      expect(divergedResult.state).toBe('diverged');
      expect(
        execSpy.mock.calls.some((call: unknown[]) => (call[1] as string[]).includes('merge'))
      ).toBe(false);
    });

    test('throws unexpected merge-base failures instead of treating them as diverged', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return { stdout: 'abc12345\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'local-sha\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return { stdout: 'remote-sha\n', stderr: '' };
        }
        if (args.includes('merge-base')) {
          throw new git.GitFailure(
            'unclassified',
            'ancestry command failed',
            Object.assign(new Error('fatal: bad object'), { code: 128, stderr: 'bad object' })
          );
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace(repo('/workspace/repo'), branch('main'))).rejects.toThrow(
        'Failed to compare git ancestry'
      );
      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('main'))
      ).rejects.toHaveProperty('cause.kind', 'unclassified');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/workspace/repo' }),
        'workspace.merge_base_check_failed'
      );
    });

    test('fetches and resets from custom remote when provided in options', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.syncWorkspace(repo('/workspace/repo'), branch('main'), {
        mode: 'reset',
        remote: 'mar',
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'fetch', 'mar', 'main'],
        expect.any(Object)
      );

      const resetCalls = execSpy.mock.calls.filter((call: unknown[]) => {
        const args = call[1] as string[];
        return args.includes('reset');
      });
      expect(resetCalls).toHaveLength(1);
      expect(resetCalls[0][1]).toEqual(['-C', '/workspace/repo', 'reset', '--hard', 'mar/main']);
    });

    test('classifies state against the custom remote ref in fast-forward mode', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) return { stdout: '', stderr: '' };
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return { stdout: 'abc12345\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        if (args.includes('rev-parse') && args.includes('upstream/main')) {
          return { stdout: 'abc12345abcdef\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'), {
        remote: 'upstream',
      });

      expect(result.state).toBe('in_sync');
      // The state classification must rev-parse upstream/main, not origin/main
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'rev-parse', 'upstream/main'],
        expect.any(Object)
      );
    });

    test('passes custom remote to getDefaultBranch when baseBranch not provided', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });
      getDefaultBranchSpy.mockResolvedValue(branch('develop'));

      await git.syncWorkspace(repo('/workspace/repo'), undefined, { remote: 'upstream' });

      expect(getDefaultBranchSpy).toHaveBeenCalledWith('/workspace/repo', 'upstream');
    });

    test('includes custom remote name in fetch error message', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('ls-remote'))
          return { stdout: 'abc123\trefs/heads/main\nabc123\trefs/heads/dev\n', stderr: '' };
        if (args.includes('fetch')) {
          throw new Error("fatal: 'mar' does not appear to be a git repository");
        }
        return { stdout: '', stderr: '' };
      });

      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('main'), { remote: 'mar' })
      ).rejects.toThrow('Sync fetch from mar/main failed');
    });

    test.each([1, 128])(
      'bounds fetch retries for exit %s and preserves the final failure',
      async code => {
        const failures: git.GitFailure[] = [];
        execSpy.mockImplementation(async (_cmd, args) => {
          if (args.includes('ls-remote'))
            return { stdout: 'abc123\trefs/heads/main\n', stderr: '' };
          if (!args.includes('fetch')) return { stdout: '', stderr: '' };
          const failure = new git.GitFailure(
            'unclassified',
            'fetch failed',
            Object.assign(new Error('arbitrary vendor wording'), {
              code,
              stderr: `evidence ${failures.length}`,
            })
          );
          failures.push(failure);
          throw failure;
        });
        const error = await git
          .syncWorkspace(repo('/workspace/repo'), branch('main'))
          .catch((error: unknown) => error);
        expect(failures).toHaveLength(3);
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw error;
        expect(error.cause).toBe(failures[2]);
        expect(error.message).toContain('evidence 2');
        expect(error.message).not.toContain('evidence 0');
        expect(error.message).toContain(`exit code ${code}`);
      }
    );

    test('does not retry a classified timeout even with a numeric exit status', async () => {
      const failure = new git.GitFailure(
        'timeout',
        'fetch timed out',
        Object.assign(new Error('exit'), { code: 128 })
      );
      let fetches = 0;
      execSpy.mockImplementation(async (_cmd, args) => {
        if (args.includes('ls-remote')) return { stdout: 'abc123\trefs/heads/main\n', stderr: '' };
        if (!args.includes('fetch')) return { stdout: '', stderr: '' };
        fetches++;
        throw failure;
      });
      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('main'))
      ).rejects.toMatchObject({ cause: failure });
      expect(fetches).toBe(1);
    });

    test('preserves an unclassified fetch failure without retrying', async () => {
      const raceError = new Error(
        "error: cannot lock ref 'refs/remotes/origin/dev': is at de581e24 but expected 8eaa8d42\n" +
          '! 8eaa8d420..de581e24b dev -> origin/dev (unable to update local ref)'
      );
      let fetchCalls = 0;

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('ls-remote'))
          return { stdout: 'abc123\trefs/heads/main\nabc123\trefs/heads/dev\n', stderr: '' };
        if (args.includes('fetch')) {
          fetchCalls++;
          throw raceError;
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace(repo('/workspace/repo'), branch('dev'))).rejects.toThrow(
        'Sync fetch from origin/dev failed'
      );

      expect(fetchCalls).toBe(1);
    });

    test('does not retry fetch failures without a numeric exit status', async () => {
      let fetchCalls = 0;

      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('ls-remote'))
          return { stdout: 'abc123\trefs/heads/main\nabc123\trefs/heads/dev\n', stderr: '' };
        if (args.includes('fetch')) {
          fetchCalls++;
          throw new Error("fatal: 'origin' does not appear to be a git repository");
        }
        return { stdout: '', stderr: '' };
      });

      await expect(git.syncWorkspace(repo('/workspace/repo'), branch('main'))).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );

      expect(fetchCalls).toBe(1);
    });

    test('names the custom remote in the configured-branch-missing error', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          throw new Error("fatal: couldn't find remote ref does-not-exist");
        }
        return { stdout: '', stderr: '' };
      });

      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('does-not-exist'), { remote: 'mar' })
      ).rejects.toThrow("Configured base branch 'does-not-exist' not found on remote 'mar'");
    });
  });

  describe('getDefaultRemote', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('returns origin when it exists among multiple remotes', async () => {
      execSpy.mockResolvedValue({ stdout: 'upstream\norigin\n', stderr: '' });

      const result = await git.getDefaultRemote(repo('/workspace/repo'));
      expect(result).toBe('origin');
    });

    test('returns sole remote when only one is configured', async () => {
      execSpy.mockResolvedValue({ stdout: 'mar\n', stderr: '' });

      const result = await git.getDefaultRemote(repo('/workspace/repo'));
      expect(result).toBe('mar');
    });

    test('returns null when multiple non-origin remotes exist', async () => {
      execSpy.mockResolvedValue({ stdout: 'jan\nfeb\nmar\n', stderr: '' });

      const result = await git.getDefaultRemote(repo('/workspace/repo'));
      expect(result).toBeNull();
    });

    test('returns null when no remotes are configured', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.getDefaultRemote(repo('/workspace/repo'));
      expect(result).toBeNull();
    });

    test('propagates git errors instead of swallowing them', async () => {
      execSpy.mockRejectedValue(new Error('not a git repository'));

      await expect(git.getDefaultRemote(repo('/workspace/repo'))).rejects.toThrow(
        'not a git repository'
      );
    });

    test('handles CRLF line endings from git output', async () => {
      execSpy.mockResolvedValue({ stdout: 'origin\r\nupstream\r\n', stderr: '' });

      const result = await git.getDefaultRemote(repo('/workspace/repo'));
      expect(result).toBe('origin');
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

      const result = await git.cloneRepository(
        'https://github.com/owner/repo.git',
        repo('/tmp/target')
      );

      expect(result).toEqual({ ok: true, value: undefined });
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['clone', 'https://github.com/owner/repo.git', '/tmp/target'],
        {
          timeout: 120000,
          env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }) as NodeJS.ProcessEnv,
        }
      );
    });

    test.each([
      ['bare host', 'github.com/owner/repo.git'],
      ['SCP style', 'git@github.com:owner/repo.git'],
    ])('normalizes a supported %s source before spawning Git', async (_name, source) => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.cloneRepository(source, repo('/tmp/target'));

      expect(result).toEqual({ ok: true, value: undefined });
      expect(execSpy.mock.calls[0]?.[1]).toContain('https://github.com/owner/repo.git');
    });

    test('passes GIT_TERMINAL_PROMPT=0 to the git clone subprocess', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.cloneRepository('https://github.com/owner/repo.git', repo('/tmp/target'));

      const env = execSpy.mock.calls[0]![2]?.env ?? {};
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      // The rest of the environment must be inherited, not stripped. On
      // Windows the key can be 'Path' — spreading process.env keeps the
      // original casing — so locate the path key case-insensitively.
      const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path');
      expect(pathKey).toBeDefined();
      expect(env[pathKey!]).toBe(process.env[pathKey!]);
    });

    test('passes authenticated clone credentials through a scoped helper environment', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });
      const token = 'ghp_abc123';

      const result = await git.cloneRepository(
        'https://github.com/owner/repo.git',
        repo('/tmp/target'),
        {
          credentials: { username: token, password: '' },
        }
      );

      expect(result).toEqual({ ok: true, value: undefined });
      const [, args, options] = execSpy.mock.calls[0]!;
      expect(args).toContain('https://github.com/owner/repo.git');
      expect(args.join('\0')).not.toContain(token);
      expect(args).toContain('credential.helper=');
      expect(args.some(arg => arg.startsWith('credential.https://github.com.helper='))).toBe(true);
      expect(options?.env?.ARCHON_GIT_USERNAME).toBe(token);
      expect(options?.env?.ARCHON_GIT_PASSWORD).toBe('');
    });

    test.skipIf(process.platform === 'win32')(
      'keeps authenticated clone credentials out of real child argv and origin config',
      async () => {
        execSpy.mockRestore();
        const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-clone-security-')));
        const targetPath = repo(join(root, 'clone'));
        const fixture = await createRecordingGitFixture(root);
        const token = 'real-child-token-123';

        const result = await fixture.run(() =>
          git.cloneRepository('https://github.com/owner/repo.git', targetPath, {
            credentials: { username: token, password: '' },
          })
        );

        expect(result).toEqual({ ok: true, value: undefined });
        const [clone] = await fixture.readInvocations();
        expect(clone).toBeDefined();
        expect(clone.argv.join('\0')).not.toContain(token);
        expect(clone.env.ARCHON_GIT_USERNAME).toBe(token);
        expect(clone.env.ARCHON_GIT_PASSWORD).toBe('');
        expect(clone.env.GIT_TERMINAL_PROMPT).toBe('0');
        const originConfig = await readFile(join(targetPath, '.git', 'config'), 'utf8');
        expect(originConfig).toContain('url = https://github.com/owner/repo.git');
        expect(originConfig).not.toContain(token);
      }
    );

    test('authenticates a real Git clone against an explicit HTTP port', async () => {
      execSpy.mockRestore();
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-clone-http-auth-')));
      const servedPath = join(root, 'served');
      const barePath = join(servedPath, 'repo.git');
      const targetPath = repo(join(root, 'clone'));
      const token = 'explicit-port-token-456';
      const expectedAuthorization = `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
      const authorizations: Array<string | null> = [];

      await writeDumbHttpRepo(barePath);

      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const authorization = request.headers.get('authorization');
          authorizations.push(authorization);
          if (authorization !== expectedAuthorization) {
            return new Response('authentication required', {
              status: 401,
              headers: { 'WWW-Authenticate': 'Basic realm="archon-test"' },
            });
          }

          const relativePath = decodeURIComponent(new URL(request.url).pathname).replace(
            /^\/+/,
            ''
          );
          if (!relativePath.startsWith('repo.git/'))
            return new Response('not found', { status: 404 });
          const file = Bun.file(join(servedPath, relativePath));
          if (!(await file.exists())) return new Response('not found', { status: 404 });
          return new Response(file);
        },
      });

      try {
        const url = `http://127.0.0.1:${String(server.port)}/repo.git`;
        const result = await git.cloneRepository(url, targetPath, {
          credentials: { username: 'oauth2', password: token },
        });

        expect(result).toEqual({ ok: true, value: undefined });
        expect(authorizations).toContain(expectedAuthorization);
        const originConfig = await readFile(join(targetPath, '.git', 'config'), 'utf8');
        expect(originConfig).toContain(`url = ${url}\n`);
        expect(originConfig).not.toContain(token);
      } finally {
        server.stop(true);
      }
    });

    test('rejects a malformed credential-bearing HTTP URL before spawning Git', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });
      const credential = 'malformed-secret-123';

      const result = await git.cloneRepository(
        `https://${credential}@example.test:bad/owner/repo.git`,
        repo('/tmp/target')
      );

      expect(result).toEqual({
        ok: false,
        error: { code: 'unknown', message: 'Invalid HTTP(S) repository URL' },
      });
      expect(execSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(credential);
    });

    test('rejects a valid HTTP URL that already contains credentials', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });
      const credential = 'embedded-secret-456';

      const result = await git.cloneRepository(
        `  https://${credential}@example.test/owner/repo.git`,
        repo('/tmp/target')
      );

      expect(result).toEqual({
        ok: false,
        error: { code: 'unknown', message: 'Repository URL must not include credentials' },
      });
      expect(execSpy).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(credential);
    });

    for (const { name, url, credential } of [
      {
        name: 'backslash userinfo',
        url: 'https://backslash-secret-789\\@127.0.0.1:9/owner/repo.git',
        credential: 'backslash-secret-789',
      },
      {
        name: 'query credentials',
        url: 'https://example.test/owner/repo.git?access_token=query-secret-789',
        credential: 'query-secret-789',
      },
      {
        name: 'fragment credentials',
        url: 'https://example.test/owner/repo.git#access_token=fragment-secret-789',
        credential: 'fragment-secret-789',
      },
      {
        name: 'bare-host query credentials',
        url: 'example.test/owner/repo.git?access_token=bare-query-secret-789',
        credential: 'bare-query-secret-789',
      },
      {
        name: 'bare-host fragment credentials',
        url: 'example.test/owner/repo.git#access_token=bare-fragment-secret-789',
        credential: 'bare-fragment-secret-789',
      },
      {
        name: 'bare-host backslash userinfo',
        url: 'bare-backslash-secret-789\\@example.test/owner/repo.git',
        credential: 'bare-backslash-secret-789',
      },
      {
        name: 'SCP-style query credentials',
        url: 'git@example.test:owner/repo.git?access_token=scp-query-secret-789',
        credential: 'scp-query-secret-789',
      },
      {
        name: 'SCP-style fragment credentials',
        url: 'git@example.test:owner/repo.git#access_token=scp-fragment-secret-789',
        credential: 'scp-fragment-secret-789',
      },
      {
        name: 'SCP-style backslash userinfo',
        url: 'git@scp-backslash-secret-789\\@example.test:owner/repo.git',
        credential: 'scp-backslash-secret-789',
      },
    ]) {
      test.skipIf(process.platform === 'win32')(
        `rejects ${name} before spawning a real child`,
        async () => {
          execSpy.mockRestore();
          const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-clone-url-reject-')));
          const fixture = await createRecordingGitFixture(root);
          mockLogger.error.mockClear();

          const result = await fixture.run(() =>
            git.cloneRepository(url, repo(join(root, 'clone')))
          );

          expect(result).toEqual({
            ok: false,
            error: { code: 'unknown', message: 'Invalid HTTP(S) repository URL' },
          });
          expect(await fixture.readInvocations()).toEqual([]);
          expect(JSON.stringify(result)).not.toContain(credential);
          expect(mockLogger.error).not.toHaveBeenCalled();
        }
      );
    }

    test('sanitizes authenticated clone failures before returning or logging them', async () => {
      const token = 'unexpected-error-token-654';
      execSpy.mockRejectedValue(
        Object.assign(new Error(`helper failed with ${token}`), {
          stderr: `credential rejected: ${token}`,
        })
      );
      mockLogger.error.mockClear();

      const result = await git.cloneRepository(
        'https://github.com/owner/repo.git',
        repo('/tmp/target'),
        { credentials: { username: 'x-access-token', password: token } }
      );

      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(token);
      expect(result).toEqual({
        ok: false,
        error: { code: 'unknown', message: 'helper failed with ***\ncredential rejected: ***' },
      });
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockLogger.error.mock.calls)).toContain('***');
    });

    test.each(['', '\n', '\r\n'])(
      'classifies HTTP 403 clone stderr as permission denied (ending %j)',
      async ending => {
        const token = 'rejected-clone-token';
        const failure = new git.GitFailure(
          'unclassified',
          'git clone failed',
          Object.assign(new Error('git exited'), {
            code: 128,
            stderr: `remote: credential ${token} rejected\nfatal: unable to access 'https://gitlab.example.test/group/project.git/': The requested URL returned error: 403${ending}`,
          })
        );
        execSpy.mockRejectedValue(failure);
        mockLogger.error.mockClear();

        const result = await git.cloneRepository(
          'https://gitlab.example.test/group/project.git',
          repo('/tmp/target'),
          { credentials: { username: 'oauth2', password: token } }
        );

        expect(result).toEqual({
          ok: false,
          error: {
            code: 'permission_denied',
            path: 'https://gitlab.example.test/group/project.git',
          },
        });
        expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(token);
        expect(JSON.stringify(mockLogger.error.mock.calls)).toContain(
          'The requested URL returned error: 403'
        );
        expect(failure.kind).toBe('unclassified');
      }
    );

    // stderr captured from git 2.49.0 against a local HTTP server, GitHub over SSH, and a full volume.
    test.each([
      [
        'HTTP 404',
        "Cloning into '/tmp/target'...\nremote: nope\nfatal: repository 'https://gitlab.example.test/group/project.git/' not found\n",
        { code: 'not_a_repo', path: 'https://gitlab.example.test/group/project.git' },
      ],
      [
        'HTTP 401 without credentials',
        "Cloning into '/tmp/target'...\nfatal: could not read Username for 'https://gitlab.example.test': terminal prompts disabled\n",
        { code: 'permission_denied', path: 'https://gitlab.example.test/group/project.git' },
      ],
      [
        'HTTP 401 with rejected credentials',
        "Cloning into '/tmp/target'...\nremote: auth\nfatal: Authentication failed for 'https://gitlab.example.test/group/project.git/'\n",
        { code: 'permission_denied', path: 'https://gitlab.example.test/group/project.git' },
      ],
      [
        'a missing GitHub repository over SSH',
        "Cloning into '/tmp/target'...\nERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
        { code: 'not_a_repo', path: 'https://gitlab.example.test/group/project.git' },
      ],
      [
        'a full disk',
        'fatal: write error: No space left on device\nfatal: fetch-pack: invalid index-pack output\n',
        { code: 'no_space', path: '/tmp/target' },
      ],
    ] as const)('maps clone stderr for %s to its guidance', async (_cause, stderr, error) => {
      execSpy.mockRejectedValue(
        new git.GitFailure(
          'unclassified',
          'git clone failed',
          Object.assign(new Error('git exited'), { code: 128, stderr })
        )
      );

      const result = await git.cloneRepository(
        'https://gitlab.example.test/group/project.git',
        repo('/tmp/target')
      );

      expect(result).toEqual({ ok: false, error });
    });

    test.each([
      ['fatal: Authentication failed', 'The requested URL returned error: 403'],
      ['fatal: Authentication failed: HTTP 403', 'git clone failed'],
      ['fatal: The requested URL returned error: 4030\n', 'git clone failed'],
      ['fatal: The requested URL returned error: 500\n', 'git clone failed'],
      [
        "fatal: unable to access 'https://example.test/no space/not found/': Could not resolve host: example.test\n",
        'git clone failed',
      ],
    ])('keeps other clone failures unclassified: %s', async (stderr, message) => {
      execSpy.mockRejectedValue(Object.assign(new Error(message), { code: 128, stderr }));

      const result = await git.cloneRepository(
        'https://gitlab.example.test/group/project.git',
        repo('/tmp/target')
      );

      expect(result).toEqual({
        ok: false,
        error: { code: 'unknown', message: `${message}\n${stderr}` },
      });
    });

    test('keeps text-only repository-not-found failures unclassified', async () => {
      execSpy.mockRejectedValue(new Error('fatal: repository not found'));

      const result = await git.cloneRepository(
        'https://github.com/owner/missing.git',
        repo('/tmp/target')
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });

    test('keeps text-only auth failures unclassified', async () => {
      execSpy.mockRejectedValue(new Error('fatal: Authentication failed'));

      const result = await git.cloneRepository(
        'https://github.com/owner/private.git',
        repo('/tmp/target')
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });

    test('keeps text-only disk failures unclassified', async () => {
      execSpy.mockRejectedValue(new Error('error: no space left on device'));

      const result = await git.cloneRepository(
        'https://github.com/owner/repo.git',
        repo('/tmp/target')
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });

    test('returns unknown error for unexpected failures', async () => {
      execSpy.mockRejectedValue(new Error('segfault'));

      const result = await git.cloneRepository(
        'https://github.com/owner/repo.git',
        repo('/tmp/target')
      );

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

      const result = await git.syncRepository(repo('/workspace/repo'), branch('main'));

      expect(result).toEqual({ ok: true, value: undefined });
      expect(execSpy).toHaveBeenCalledWith('git', ['-C', '/workspace/repo', 'fetch', 'origin'], {
        timeout: 60000,
      });
      expect(execSpy).toHaveBeenCalledWith('git', ['reset', '--hard', 'origin/main'], {
        cwd: '/workspace/repo',
        timeout: 30000,
      });
    });

    test('reports contention without retrying or resetting', async () => {
      const raceError = Object.assign(
        new Error(
          "error: cannot lock ref 'refs/remotes/origin/main'\n (unable to update local ref)"
        ),
        { stderr: 'unable to update local ref' }
      );
      execSpy.mockRejectedValue(raceError);

      const result = await git.syncRepository(repo('/workspace/repo'), branch('main'));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
        // The original git text survives the GitResult wrap.
        expect(JSON.stringify(result.error)).toContain('cannot lock ref');
      }
      const fetches = execSpy.mock.calls.filter(([, args]) => (args as string[])[2] === 'fetch');
      expect(fetches).toHaveLength(1);
      const resets = execSpy.mock.calls.filter(([, args]) => (args as string[])[0] === 'reset');
      expect(resets).toHaveLength(0);
    });

    test('attempts an unclassified fetch failure once', async () => {
      const authError = Object.assign(new Error('fatal: Authentication failed for repo'), {
        stderr: 'authentication failed',
      });
      execSpy.mockRejectedValue(authError);

      const result = await git.syncRepository(repo('/workspace/repo'), branch('main'));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
      const fetches = execSpy.mock.calls.filter(([, args]) => (args as string[])[2] === 'fetch');
      expect(fetches).toHaveLength(1);
    });

    test('fetches and resets using a custom remote', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await git.syncRepository(repo('/workspace/repo'), branch('main'), 'upstream');

      expect(result).toEqual({ ok: true, value: undefined });
      expect(execSpy).toHaveBeenCalledWith('git', ['-C', '/workspace/repo', 'fetch', 'upstream'], {
        timeout: 60000,
      });
      expect(execSpy).toHaveBeenCalledWith('git', ['reset', '--hard', 'upstream/main'], {
        cwd: '/workspace/repo',
        timeout: 30000,
      });
    });

    test('skips reset if fetch fails', async () => {
      execSpy.mockRejectedValue(new Error('fatal: unable to access'));

      const result = await git.syncRepository(repo('/workspace/repo'), branch('main'));

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

    test('returns not_a_repo for a structured non-repository failure', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));
      expect(await git.syncRepository(repo('/workspace/repo'), branch('main'))).toEqual({
        ok: false,
        error: { code: 'not_a_repo', path: '/workspace/repo' },
      });
    });

    test.each([
      [
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
        { code: 'permission_denied', path: '/workspace/repo' },
      ],
      [
        'ERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n',
        { code: 'permission_denied', path: '/workspace/repo' },
      ],
      [
        'fatal: write error: No space left on device\n',
        { code: 'no_space', path: '/workspace/repo' },
      ],
    ] as const)('maps fetch stderr %j to its guidance', async (stderr, error) => {
      execSpy.mockRejectedValue(
        Object.assign(new Error('git fetch failed'), { code: 128, stderr })
      );

      expect(await git.syncRepository(repo('/workspace/repo'), branch('main'))).toEqual({
        ok: false,
        error,
      });
    });

    test('returns branch_not_found when the remote branch is missing at reset', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('reset')) {
          throw Object.assign(new Error('git reset failed'), {
            code: 128,
            stderr:
              "fatal: ambiguous argument 'origin/nonexistent': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n",
          });
        }
        return { stdout: '', stderr: '' };
      });

      expect(await git.syncRepository(repo('/workspace/repo'), branch('nonexistent'))).toEqual({
        ok: false,
        error: { code: 'branch_not_found', branch: 'nonexistent' },
      });
    });

    test('keeps text-only fetch auth failures unclassified', async () => {
      execSpy.mockRejectedValue(new Error('fatal: Authentication failed for repository'));

      const result = await git.syncRepository(repo('/workspace/repo'), branch('main'));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });

    test('keeps text-only fetch disk failures unclassified', async () => {
      execSpy.mockRejectedValue(new Error('error: no space left on device'));

      const result = await git.syncRepository(repo('/workspace/repo'), branch('main'));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });

    test('keeps text-only reset failures unclassified', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('fetch')) {
          return { stdout: '', stderr: '' };
        }
        if (args.includes('reset')) {
          throw new Error("fatal: ambiguous argument 'origin/nonexistent': unknown revision");
        }
        return { stdout: '', stderr: '' };
      });

      const result = await git.syncRepository(repo('/workspace/repo'), branch('nonexistent'));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
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

      const result = await git.syncRepository(repo('/workspace/repo'), branch('main'));

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

      await git.addSafeDirectory(repo('/workspace/repo'));

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        [
          'config',
          '--global',
          '--fixed-value',
          '--replace-all',
          'safe.directory',
          '/workspace/repo',
          '/workspace/repo',
        ],
        { timeout: 10000 }
      );
    });

    test('uses execFileAsync (not shell exec)', async () => {
      execSpy.mockResolvedValue({ stdout: '', stderr: '' });

      await git.addSafeDirectory(repo('/workspace/path with spaces'));

      // If this were shell exec, spaces in the path would cause issues.
      // execFileAsync passes args as array, so path with spaces is safe.
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        [
          'config',
          '--global',
          '--fixed-value',
          '--replace-all',
          'safe.directory',
          '/workspace/path with spaces',
          '/workspace/path with spaces',
        ],
        { timeout: 10000 }
      );
    });
    test('times out a hung initial config read before any write', async () => {
      execSpy.mockRestore();
      const realExec = git.execFileAsync;
      let killed = false;
      execSpy = spyOn(git, 'execFileAsync').mockImplementation(async (_file, args, options) => {
        expect(args).toContain('--get-all');
        try {
          return await realExec(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], options);
        } catch (error) {
          killed = error instanceof Error && 'killed' in error && error.killed === true;
          throw error;
        }
      });
      await expect(git.addSafeDirectory(repo('/workspace/repo'))).rejects.toThrow(
        'Failed to add safe directory'
      );
      expect(killed).toBe(true);
      expect(execSpy).toHaveBeenCalledTimes(1);
    }, 15000);

    test.each([false, true])(
      'reset repair preserves accepted trust (write fails: %s)',
      async fail => {
        execSpy.mockRestore();
        const realExec = git.execFileAsync;
        const root = trackTempRoot(
          (await mkdtemp(join(tmpdir(), 'git-safe-atomic-'))).replaceAll('\\', '/')
        );
        const config = join(root, 'gitconfig');
        const previousConfig = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = config;
        process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
        try {
          await realExec('git', ['init', root]);
          await writeFile(config, `[safe]\n directory = ${JSON.stringify(root)}\n directory = \n`);
          if (process.platform !== 'win32') await chmod(config, 0o660);
          const configMode = (await stat(config)).mode;
          const checkTrust = async (): Promise<void> => {
            await realExec('git', ['-C', root, 'status', '--porcelain']);
          };
          let checkedIntermediate = false;
          execSpy = spyOn(git, 'execFileAsync').mockImplementation(async (file, args, options) => {
            if (args?.includes('--get-all')) {
              const snapshot = await realExec(file, args, options);
              // Another setup completes after this reader took its snapshot.
              await realExec('git', [
                'config',
                '--global',
                '--fixed-value',
                '--unset-all',
                'safe.directory',
                root,
              ]);
              await realExec('git', [
                'config',
                '--global',
                '--fixed-value',
                '--replace-all',
                'safe.directory',
                root,
                root,
              ]);
              await realExec('git', ['config', '--global', 'test.concurrent', 'retained']);
              await checkTrust();
              return snapshot;
            }
            if (args?.includes('--unset-all')) {
              const result = await realExec(file, args, options);
              await checkTrust();
              checkedIntermediate = true;
              return result;
            }
            if (fail && args?.includes('--replace-all'))
              throw new Error('injected replacement failure');
            return realExec(file, args, options);
          });
          if (fail)
            await expect(git.addSafeDirectory(repo(root))).rejects.toThrow(
              'injected replacement failure'
            );
          else await git.addSafeDirectory(repo(root));
          expect(checkedIntermediate).toBe(true);
          await checkTrust();
          expect(
            (await realExec('git', ['config', '--global', '--null', '--get-all', 'safe.directory']))
              .stdout
          ).toBe(`\0${root}\0`);
          expect(
            (await realExec('git', ['config', '--global', 'test.concurrent'])).stdout.trim()
          ).toBe('retained');
          expect(await Bun.file(`${config}.lock`).exists()).toBe(false);
          expect((await stat(config)).mode).toBe(configMode);
        } finally {
          execSpy.mockRestore();
          delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
          if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
          else process.env.GIT_CONFIG_GLOBAL = previousConfig;
        }
      }
    );

    test('preserves the config failure when lock cleanup also fails', async () => {
      execSpy.mockRestore();
      const realExec = git.execFileAsync;
      const root = trackTempRoot(
        await realpath(await mkdtemp(join(tmpdir(), 'git-safe-cleanup-')))
      );
      const config = join(root, 'gitconfig');
      const previousConfig = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = config;
      try {
        await writeFile(config, '[safe]\n\tdirectory = /workspace/repo\n\tdirectory = \n');
        execSpy = spyOn(git, 'execFileAsync').mockImplementation(async (file, args, options) => {
          if (args?.includes('--unset-all')) {
            await rm(`${config}.lock`);
            throw new Error('injected configuration failure');
          }
          return realExec(file, args, options);
        });
        mockLogger.error.mockClear();

        await expect(git.addSafeDirectory(repo('/workspace/repo'))).rejects.toThrow(
          'injected configuration failure'
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          { err: expect.objectContaining({ code: 'ENOENT' }), lockPath: `${config}.lock` },
          'safe_directory_lock_cleanup_failed'
        );
        expect(await readFile(config, 'utf8')).toBe(
          '[safe]\n\tdirectory = /workspace/repo\n\tdirectory = \n'
        );
      } finally {
        execSpy.mockRestore();
        if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousConfig;
      }
    });

    test.each(['include-reset', 'two-globals'])(
      'repairs effective global trust across %s',
      async layout => {
        execSpy.mockRestore();
        const root = trackTempRoot(
          (await realpath(await mkdtemp(join(tmpdir(), 'git-safe-sources-')))).replaceAll('\\', '/')
        );
        const saved = {
          HOME: process.env.HOME,
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
          GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
          GIT_TEST_ASSUME_DIFFERENT_OWNER: process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER,
        };
        Object.assign(process.env, {
          HOME: root,
          XDG_CONFIG_HOME: join(root, 'xdg'),
          GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
        });
        delete process.env.GIT_CONFIG_GLOBAL;
        try {
          await realMkdir(join(root, 'xdg/git'), { recursive: true });
          await git.execFileAsync('git', ['init', root]);
          const grant = `[safe]\n directory = "${root}"\n`;
          await writeFile(
            join(root, 'xdg/git/config'),
            `${grant}[safe]\n directory = /workspace/other\n`
          );
          await writeFile(
            join(root, '.gitconfig'),
            layout === 'two-globals' ? grant : `${grant}[include]\n path = reset\n`
          );
          await writeFile(join(root, 'reset'), `${grant}[safe]\n directory = \n`);
          for (let attempt = 0; attempt < 2; attempt++) {
            await git.addSafeDirectory(repo(root));
            const { stdout } = await git.execFileAsync('git', [
              'config',
              '--includes',
              '--null',
              '--get-all',
              'safe.directory',
            ]);
            expect(stdout.split('\0').filter(value => value === root)).toHaveLength(1);
            expect(stdout.split('\0').filter(value => value === '/workspace/other')).toEqual([
              '/workspace/other',
            ]);
            await git.execFileAsync('git', ['-C', root, 'status', '--porcelain']);
          }
        } finally {
          for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      }
    );

    test('repeated setup keeps one exact safe-directory entry and preserves other paths', async () => {
      execSpy.mockRestore();
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'git-safe-directory-')));
      const configPath = join(root, 'gitconfig');
      const previousConfig = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = configPath;
      try {
        await writeFile(configPath, '[safe]\n\tdirectory = /workspace/other\n');
        const repoPath = repo('/workspace/repo.[1] with spaces');
        await git.addSafeDirectory(repoPath);
        await git.addSafeDirectory(repoPath);
        const { stdout } = await git.execFileAsync('git', [
          'config',
          '--global',
          '--get-all',
          'safe.directory',
        ]);
        expect(stdout.trim().split('\n')).toEqual(['/workspace/other', repoPath]);
      } finally {
        if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previousConfig;
      }
    });

    // Windows keeps the write: git compares owner SIDs there, which we do not read.
    test.skipIf(process.platform === 'win32')(
      'concurrent worktree setups under a directory this user owns all succeed',
      async () => {
        execSpy.mockRestore();
        const root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'git-safe-race-'))));
        const configPath = join(root, 'gitconfig');
        const previousConfig = process.env.GIT_CONFIG_GLOBAL;
        process.env.GIT_CONFIG_GLOBAL = configPath;
        try {
          await writeFile(configPath, '[user]\n\tname = other-process\n');
          const worktrees = Array.from({ length: 8 }, (_, i) => repo(join(root, `worktree-${i}`)));
          await Promise.all(worktrees.map(path => git.addSafeDirectory(path)));
          expect(await readFile(configPath, 'utf8')).toBe('[user]\n\tname = other-process\n');
          // Git trusts a repository its own user created without any grant.
          await git.execFileAsync('git', ['init', '--quiet', worktrees[0]]);
          await git.execFileAsync('git', ['-C', worktrees[0], 'status', '--porcelain']);
        } finally {
          if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
          else process.env.GIT_CONFIG_GLOBAL = previousConfig;
        }
      }
    );
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
      expect(result).toBe(repo('/workspace/repo'));
    });

    test('returns null for a structured non-repository failure', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));
      expect(await git.findRepoRoot(tmpdir())).toBeNull();
    });

    for (const stderr of [
      'fatal: bad config line 1',
      'fatal: not a git repository: /missing/gitdir',
    ]) {
      test(`preserves ${stderr} even when the path mentions non-repository detection`, async () => {
        const failure = Object.assign(new Error('git -C /not a git repository rev-parse failed'), {
          stderr,
        });
        execSpy.mockRejectedValue(failure);
        const error = await git.findRepoRoot('/not a git repository').catch(error => error);
        expect(error).toBeInstanceOf(Error);
        expect(error.cause).toBe(failure);
      });
    }

    test('throws for unexpected errors', async () => {
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.findRepoRoot('/workspace/repo')).rejects.toThrow('Failed to find repo root');
    });
  });

  describe('listChildRepos', () => {
    const root = join(tmpdir(), 'archon-childrepos-test-' + Date.now());

    beforeEach(async () => {
      await realMkdir(root, { recursive: true });
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    test('lists immediate child directories that contain .git, sorted', async () => {
      // Two git repos (svc-b, svc-a), one plain dir, one .git as a file (worktree)
      await realMkdir(join(root, 'svc-a', '.git'), { recursive: true });
      await realMkdir(join(root, 'svc-b', '.git'), { recursive: true });
      await realMkdir(join(root, 'docs'), { recursive: true });
      await realMkdir(join(root, 'svc-c'), { recursive: true });
      await writeFile(join(root, 'svc-c', '.git'), 'gitdir: /elsewhere\n');

      const result = await git.listChildRepos(root);
      expect(result).toEqual(['svc-a', 'svc-b', 'svc-c']);
    });

    test('returns empty array when no child repos exist', async () => {
      await realMkdir(join(root, 'plain-a'), { recursive: true });
      await realMkdir(join(root, 'plain-b'), { recursive: true });

      const result = await git.listChildRepos(root);
      expect(result).toEqual([]);
    });

    test('does not recurse into nested repos', async () => {
      await realMkdir(join(root, 'svc-a', '.git'), { recursive: true });
      // Nested repo one level deeper — must NOT be reported
      await realMkdir(join(root, 'svc-a', 'inner', '.git'), { recursive: true });

      const result = await git.listChildRepos(root);
      expect(result).toEqual(['svc-a']);
    });

    test('returns empty array for an unreadable/nonexistent root (never throws)', async () => {
      const result = await git.listChildRepos(join(root, 'does-not-exist'));
      expect(result).toEqual([]);
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

      const result = await git.getRemoteUrl(repo('/workspace/repo'));
      expect(result).toBe('https://github.com/owner/repo.git');
    });

    test('queries a custom remote when provided', async () => {
      execSpy.mockResolvedValue({
        stdout: 'https://github.com/owner/repo.git\n',
        stderr: '',
      });

      await git.getRemoteUrl(repo('/workspace/repo'), 'upstream');

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'remote', 'get-url', 'upstream'],
        expect.any(Object)
      );
    });

    test('returns null when no remote configured', async () => {
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'remote lookup failed',
          Object.assign(new Error('absent'), { code: 2 })
        )
      );
      execSpy.mockRejectedValueOnce(
        new git.GitFailure(
          'unclassified',
          'missing config key',
          Object.assign(new Error('absent'), { code: 1 })
        )
      );

      const result = await git.getRemoteUrl(repo('/workspace/repo'));
      expect(result).toBeNull();
    });

    test.each([
      new git.GitFailure(
        'timeout',
        'remote lookup timed out',
        Object.assign(new Error('terminated'), { killed: true, signal: 'SIGTERM' })
      ),
      new git.GitFailure(
        'unclassified',
        'remote lookup failed',
        Object.assign(new Error('failed'), { code: 128, stderr: 'original Git evidence' })
      ),
      new Error('unexpected remote lookup failure'),
    ])('preserves non-absence remote failures through both consumers: %s', async original => {
      for (const inspect of [
        () => git.getRemoteUrl(repo('/workspace/repo')),
        () => git.detectForge(repo('/workspace/repo')),
      ]) {
        execSpy.mockReset();
        execSpy.mockRejectedValueOnce(original);
        execSpy.mockRejectedValueOnce(
          new git.GitFailure(
            'unclassified',
            'missing config key',
            Object.assign(new Error('absent'), { code: 1 })
          )
        );
        const failure = await inspect().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toHaveProperty('cause', original);
      }
    });

    test('preserves the original remote failure when absence confirmation fails', async () => {
      const original = new git.GitFailure(
        'unclassified',
        'remote lookup failed',
        Object.assign(new Error('lookup failed'), { code: 2, stderr: 'original Git evidence' })
      );
      const confirmationFailure = new git.GitFailure(
        'unclassified',
        'local config lookup failed',
        Object.assign(new Error('inspection failed'), { code: 128, stderr: 'config unreadable' })
      );

      for (const inspect of [
        () => git.getRemoteUrl(repo('/workspace/repo')),
        () => git.detectForge(repo('/workspace/repo')),
      ]) {
        execSpy.mockReset();
        execSpy.mockRejectedValueOnce(original);
        execSpy.mockRejectedValueOnce(confirmationFailure);

        const failure = await inspect().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toHaveProperty('cause', original);
        expect(execSpy).toHaveBeenCalledTimes(2);
      }
    });

    test.each(['getRemoteUrl', 'detectForge'] as const)(
      '%s preserves the original remote failure when local config confirms the remote exists',
      async consumer => {
        const original = new git.GitFailure(
          'unclassified',
          'remote lookup failed',
          Object.assign(new Error('lookup failed'), { code: 2, stderr: 'original Git evidence' })
        );
        execSpy.mockRejectedValueOnce(original);
        execSpy.mockResolvedValueOnce({
          stdout: 'https://github.com/owner/repo.git\n',
          stderr: '',
        });

        const failure = await git[consumer](repo('/workspace/repo')).catch(
          (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toHaveProperty('cause', original);
        expect(execSpy).toHaveBeenCalledTimes(2);
        expect(execSpy).toHaveBeenNthCalledWith(
          2,
          'git',
          ['-C', '/workspace/repo', 'config', '--local', '--get', 'remote.origin.url'],
          expect.any(Object)
        );
      }
    );

    test('throws for unexpected errors', async () => {
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(git.getRemoteUrl(repo('/workspace/repo'))).rejects.toThrow(
        'Failed to get remote URL'
      );
    });
  });

  // ==========================================================================
  // types.ts
  // ==========================================================================

  describe('branded types', () => {
    test('toRepoPath returns the same string value', () => {
      const path = git.toRepoPath('/workspace/repo');
      expect(path).toBe(repo('/workspace/repo'));
    });

    test('toBranchName returns the same string value', () => {
      const name = git.toBranchName('feature/auth');
      expect(name).toBe(branch('feature/auth'));
    });

    test('toWorktreePath returns the same string value', () => {
      const path = git.toWorktreePath('/workspace/worktrees/feature');
      expect(path).toBe(worktree('/workspace/worktrees/feature'));
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

      await git.removeWorktree(repo('/workspace/repo'), worktree('/workspace/worktrees/issue-42'));

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'worktree', 'remove', '/workspace/worktrees/issue-42'],
        { timeout: 30000 }
      );
    });

    test('propagates error when worktree has uncommitted changes', async () => {
      execSpy.mockRejectedValue(new Error('fatal: cannot remove: has changes'));

      await expect(
        git.removeWorktree(repo('/workspace/repo'), worktree('/workspace/worktrees/dirty'))
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

      await expect(git.addSafeDirectory(repo('/workspace/repo'))).rejects.toThrow(
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
      const execSpy = spyOn(git, 'execFileAsync').mockRejectedValue(new Error('invalid gitdir'));

      try {
        await expect(git.getCanonicalRepoPath(testDir)).rejects.toThrow(
          'Cannot determine canonical repo path from worktree'
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ path: testDir }),
          'canonical_path_resolution_failed'
        );
      } finally {
        execSpy.mockRestore();
      }
    });
  });

  describe('verifyWorktreeOwnership', () => {
    test('resolves for matching worktree pointer', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /workspace/my-repo/.git/worktrees/issue-42\n'
      );
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({
          stdout: '/workspace/my-repo/.git/worktrees/issue-42\n/workspace/my-repo/.git\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: '/workspace/my-repo/.git\n/workspace/my-repo/.git\n',
          stderr: '',
        });

      try {
        await expect(
          git.verifyWorktreeOwnership(
            git.toWorktreePath(testDir),
            git.toRepoPath('/workspace/my-repo')
          )
        ).resolves.toBeUndefined();
      } finally {
        execSpy.mockRestore();
      }
    });

    test('throws with "belongs to a different clone" when gitdir points elsewhere', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: /other/clone/.git/worktrees/issue-42\n');
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({
          stdout: '/other/clone/.git/worktrees/issue-42\n/other/clone/.git\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: '/workspace/my-repo/.git\n/workspace/my-repo/.git\n',
          stderr: '',
        });

      try {
        await expect(
          git.verifyWorktreeOwnership(
            git.toWorktreePath(testDir),
            git.toRepoPath('/workspace/my-repo')
          )
        ).rejects.toThrow(/belongs to a different clone \(\/other\/clone\/\.git\)/);
      } finally {
        execSpy.mockRestore();
      }
    });

    test('normalizes trailing slashes in both paths', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /workspace/my-repo/.git/worktrees/issue-42\n'
      );
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({
          stdout: '/workspace/my-repo/.git/worktrees/issue-42/\n/workspace/my-repo/.git/\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: '/workspace/my-repo/.git\n/workspace/my-repo/.git\n',
          stderr: '',
        });

      try {
        await expect(
          git.verifyWorktreeOwnership(
            git.toWorktreePath(testDir),
            git.toRepoPath('/workspace/my-repo/')
          )
        ).resolves.toBeUndefined();
      } finally {
        execSpy.mockRestore();
      }
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
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({
          stdout:
            '/workspace/my-repo/.git/modules/vendor/submodule\n/workspace/my-repo/.git/modules/vendor/submodule\n',
          stderr: '',
        })
        .mockResolvedValueOnce({
          stdout: '/workspace/my-repo/.git\n/workspace/my-repo/.git\n',
          stderr: '',
        });

      try {
        await expect(
          git.verifyWorktreeOwnership(
            git.toWorktreePath(testDir),
            git.toRepoPath('/workspace/my-repo')
          )
        ).rejects.toThrow(/not a git-worktree reference/);
      } finally {
        execSpy.mockRestore();
      }
    });

    test('resolves for a matching linked submodule worktree pointer', async () => {
      const commonGitDir = join(testDir, 'super', '.git', 'modules', 'vendor', 'module');
      const linkedGitDir = join(commonGitDir, 'worktrees', 'linked');
      const primaryCheckout = resolve(commonGitDir, '../../../../vendor/module');
      await realMkdir(linkedGitDir, { recursive: true });
      await writeFile(join(linkedGitDir, 'commondir'), '../..\n');
      await writeFile(join(testDir, '.git'), `gitdir: ${linkedGitDir}\n`);
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({ stdout: `${linkedGitDir}\n${commonGitDir}\n`, stderr: '' })
        .mockResolvedValueOnce({ stdout: `${commonGitDir}\n${commonGitDir}\n`, stderr: '' });

      try {
        await expect(
          git.verifyWorktreeOwnership(git.toWorktreePath(testDir), git.toRepoPath(primaryCheckout))
        ).resolves.toBeUndefined();
      } finally {
        execSpy.mockRestore();
      }
    });

    test('resolves for a linked worktree backed by an external Git directory', async () => {
      const commonGitDir = join(testDir, 'metadata');
      const linkedGitDir = join(commonGitDir, 'worktrees', 'linked');
      await writeFile(join(testDir, '.git'), `gitdir: ${linkedGitDir}\n`);
      const execSpy = spyOn(git, 'execFileAsync')
        .mockResolvedValueOnce({ stdout: `${linkedGitDir}\n${commonGitDir}\n`, stderr: '' })
        .mockResolvedValueOnce({ stdout: `${commonGitDir}\n${commonGitDir}\n`, stderr: '' });
      try {
        await expect(
          git.verifyWorktreeOwnership(
            git.toWorktreePath(testDir),
            git.toRepoPath(join(testDir, 'primary'))
          )
        ).resolves.toBeUndefined();
      } finally {
        execSpy.mockRestore();
      }
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

  describe('worktree locks', () => {
    let root: string;
    let repoPath: git.RepoPath;
    let worktreePath: git.WorktreePath;

    const run = async (...args: string[]): Promise<void> => {
      await git.execFileAsync('git', ['-C', root, ...args]);
    };

    /** Take the lock through git directly: the package only reads and releases one. */
    const lock = async (reason: string): Promise<void> => {
      await git.execFileAsync('git', [
        '-C',
        repoPath,
        'worktree',
        'lock',
        '--reason',
        reason,
        worktreePath,
      ]);
    };

    beforeEach(async () => {
      root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-worktree-lock-')));
      repoPath = repo(join(root, 'repo'));
      worktreePath = worktree(join(root, 'wt'));
      await realMkdir(repoPath, { recursive: true });
      await run('init', '-q', '-b', 'main', repoPath);
      await git.execFileAsync('git', ['-C', repoPath, 'config', 'user.email', 'test@example.com']);
      await git.execFileAsync('git', ['-C', repoPath, 'config', 'user.name', 'Archon Test']);
      await writeFile(join(repoPath, 'README.md'), '# fixture\n');
      await git.execFileAsync('git', ['-C', repoPath, 'add', 'README.md']);
      await git.execFileAsync('git', ['-C', repoPath, 'commit', '-qm', 'initial commit']);
      await git.execFileAsync('git', [
        '-C',
        repoPath,
        'worktree',
        'add',
        '-q',
        worktreePath,
        '-b',
        'feature',
      ]);
    });

    test('an unlocked worktree reads as no lock at all', async () => {
      expect(await git.readWorktreeLock(worktreePath)).toBeNull();
    });

    test('round-trips the reason a lock was taken with', async () => {
      await lock('archon: worktree setup in progress');

      expect(await git.readWorktreeLock(worktreePath)).toEqual({
        reason: 'archon: worktree setup in progress',
      });

      await git.unlockWorktree(repoPath, worktreePath);

      expect(await git.readWorktreeLock(worktreePath)).toBeNull();
    });

    test('a lock taken without a reason is still a lock', async () => {
      // `null` means unlocked and nothing else, so a caller can tell the two
      // apart without inspecting the reason text.
      await git.execFileAsync('git', ['-C', repoPath, 'worktree', 'lock', worktreePath]);

      expect(await git.readWorktreeLock(worktreePath)).toEqual({ reason: '' });
    });

    test('git refuses to remove a locked worktree unless forced twice', async () => {
      await lock('archon: worktree setup in progress');

      // The lock is only a usable marker because git itself enforces it.
      await expect(git.removeWorktree(repoPath, worktreePath)).rejects.toThrow(/locked/);
      await expect(
        git.execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', '--force', worktreePath])
      ).rejects.toThrow(/locked/);
      await expect(
        git.execFileAsync('git', [
          '-C',
          repoPath,
          'worktree',
          'remove',
          '--force',
          '--force',
          worktreePath,
        ])
      ).resolves.toBeDefined();
    });
  });
});

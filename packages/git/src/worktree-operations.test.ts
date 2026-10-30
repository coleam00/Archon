import { trackTempRoots } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdtemp, mkdir as realMkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as Git from './index';
import {
  clearLogger,
  output,
  branch,
  git,
  listed,
  mockLogger,
  repo,
  worktree,
} from './test-fixtures/git-harness';

const trackTempRoot = trackTempRoots();

describe('git utilities', () => {
  beforeEach(clearLogger);
  describe('worktreeExists', () => {
    let testDir: Git.RepoPath;
    beforeEach(async () => {
      testDir = repo(trackTempRoot(await mkdtemp(join(tmpdir(), 'git-utils-test-'))));
    });

    test('returns true when path and .git exist', async () => {
      await realMkdir(join(testDir, 'worktree-test'), { recursive: true });
      await writeFile(join(testDir, 'worktree-test', '.git'), 'gitdir: /some/path');

      expect(await git.worktreeExists(worktree(join(testDir, 'worktree-test')))).toBe(true);
    });

    test('returns false when path does not exist', async () => {
      expect(await git.worktreeExists(worktree(join(testDir, 'nonexistent')))).toBe(false);
    });

    test('returns false and logs warning when directory exists but .git is missing (corruption)', async () => {
      await realMkdir(join(testDir, 'no-git'), { recursive: true });

      expect(await git.worktreeExists(worktree(join(testDir, 'no-git')))).toBe(false);
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

  describe('readGitWorktreeInventory', () => {
    test('preserves complete records and lock reasons while normalizing paths', async () => {
      const execSpy = spyOn(git, 'execFileAsync').mockResolvedValue(
        output(
          'worktree /path/to/new\nline\0HEAD abc123\0branch refs/heads/feature\0locked setup\nreason\0\0' +
            'worktree /path/to/detached\0HEAD def456\0detached\0locked\0prunable missing checkout\0\0' +
            'worktree /path/to/bare\0bare\0\0'
        )
      );
      try {
        expect(await git.readGitWorktreeInventory(repo('/path/to/main'))).toEqual([
          {
            path: listed('/path/to/new\nline'),
            head: 'abc123',
            ref: 'refs/heads/feature',
            bare: false,
            lockReason: 'setup\nreason',
            prunable: false,
          },
          {
            path: listed('/path/to/detached'),
            head: 'def456',
            ref: undefined,
            bare: false,
            lockReason: '',
            prunable: true,
          },
          {
            path: listed('/path/to/bare'),
            head: '',
            ref: undefined,
            bare: true,
            lockReason: null,
            prunable: false,
          },
        ]);
      } finally {
        execSpy.mockRestore();
      }
    });

    test('propagates even a typed non-repository failure', async () => {
      const error = new git.GitFailure('not_repository', 'missing repository');
      const execSpy = spyOn(git, 'execFileAsync').mockRejectedValue(error);
      try {
        await expect(git.readGitWorktreeInventory(repo('/missing'))).rejects.toBe(error);
      } finally {
        execSpy.mockRestore();
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

    test('parses NUL-delimited worktree paths and includes only local branches', async () => {
      const mockOutput = [
        'worktree /path/to/main',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /path/to/new\nline',
        'HEAD def456',
        'branch refs/heads/feature/auth',
        '',
        'worktree /path/to/detached',
        'HEAD abc123',
        'detached',
        '',
        'worktree /path/to/local-ref-name',
        'HEAD abc123',
        'branch refs/heads/refs/custom/foo',
        '',
        '',
      ].join('\0');
      execSpy.mockResolvedValue(output(mockOutput));

      const result = await git.listWorktrees(repo('/path/to/main'));

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', repo('/path/to/main'), 'worktree', 'list', '--porcelain', '-z'],
        { timeout: 10000 }
      );
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ path: listed('/path/to/main'), branch: branch('main') });
      expect(result[1]).toEqual({
        path: listed('/path/to/new\nline'),
        branch: branch('feature/auth'),
      });
      expect(result[2]).toEqual({
        path: listed('/path/to/local-ref-name'),
        branch: branch('refs/custom/foo'),
      });
    });

    test.each(['refs/custom/foo', 'refs/custom/refs/heads/foo'])(
      'excludes non-local symbolic ref %s without losing local branches',
      async ref => {
        execSpy.mockResolvedValue(
          output(
            `worktree /path/to/custom\0HEAD abc123\0branch ${ref}\0\0` +
              'worktree /path/to/valid\0HEAD abc123\0branch refs/heads/valid\0\0'
          )
        );
        expect(await git.listWorktrees(repo('/path/to/main'))).toEqual([
          { path: listed('/path/to/valid'), branch: branch('valid') },
        ]);
      }
    );

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
      const mockOutput = `worktree /workspace/main\0HEAD abc123\0branch refs/heads/main\0\0worktree /workspace/worktrees/feature-auth\0HEAD def456\0branch refs/heads/feature/auth\0\0`;
      execSpy.mockResolvedValue(output(mockOutput));
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('finds exact branch match', async () => {
      expect(await git.findWorktreeByBranch(repo('/workspace/main'), branch('feature/auth'))).toBe(
        listed('/workspace/worktrees/feature-auth')
      );
    });

    test('finds slugified branch match', async () => {
      expect(await git.findWorktreeByBranch(repo('/workspace/main'), branch('feature-auth'))).toBe(
        listed('/workspace/worktrees/feature-auth')
      );
    });

    test('returns null when no match', async () => {
      expect(
        await git.findWorktreeByBranch(repo('/workspace/main'), branch('nonexistent'))
      ).toBeNull();
    });
  });

  describe('removeWorktree', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('calls git worktree remove with correct arguments', async () => {
      execSpy.mockResolvedValue(output());

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

  describe('worktree locks', () => {
    let repoPath: Git.RepoPath;
    let worktreePath: Git.WorktreePath;

    const run = async (...args: string[]): Promise<void> => {
      await git.execFileAsync('git', ['-C', repoPath, ...args]);
    };

    /** Take the lock through git directly: the package only reads and releases one. */
    const lock = (reason: string): Promise<void> =>
      run('worktree', 'lock', '--reason', reason, worktreePath);

    beforeEach(async () => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-worktree-lock-')));
      repoPath = repo(join(root, 'repo'));
      worktreePath = worktree(join(root, 'wt'));
      await realMkdir(repoPath, { recursive: true });
      await run('init', '-q', '-b', 'main');
      await run('config', 'user.email', 'test@example.com');
      await run('config', 'user.name', 'Archon Test');
      await writeFile(join(repoPath, 'README.md'), '# fixture\n');
      await run('add', 'README.md');
      await run('commit', '-qm', 'initial commit');
      await run('worktree', 'add', '-q', worktreePath, '-b', 'feature');
    });

    test('an unlocked worktree reads as no lock at all', async () => {
      expect(await git.readWorktreeLock(worktreePath)).toBeNull();
      expect(await git.readWorktreeRegistration(repoPath, worktreePath)).toEqual({
        lockReason: null,
      });
    });

    test('round-trips the reason a lock was taken with', async () => {
      await lock('archon: worktree setup in progress');
      expect(await git.readWorktreeRegistration(repoPath, worktreePath)).toEqual({
        lockReason: 'archon: worktree setup in progress',
      });

      expect(await git.readWorktreeLock(worktreePath)).toEqual({
        reason: 'archon: worktree setup in progress',
      });

      await git.unlockWorktree(repoPath, worktreePath);

      expect(await git.readWorktreeLock(worktreePath)).toBeNull();
      expect(await git.readWorktreeRegistration(repoPath, worktreePath)).toEqual({
        lockReason: null,
      });
    });

    test('a lock taken without a reason is still a lock', async () => {
      // `null` means unlocked and nothing else, so a caller can tell the two
      // apart without inspecting the reason text.
      await run('worktree', 'lock', worktreePath);
      expect(await git.readWorktreeRegistration(repoPath, worktreePath)).toEqual({
        lockReason: '',
      });

      expect(await git.readWorktreeLock(worktreePath)).toEqual({ reason: '' });
    });

    test('git refuses to remove a locked worktree unless forced twice', async () => {
      await lock('archon: worktree setup in progress');
      expect(await git.readWorktreeRegistration(repoPath, worktreePath)).toEqual({
        lockReason: 'archon: worktree setup in progress',
      });

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

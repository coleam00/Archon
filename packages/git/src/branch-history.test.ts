import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import type * as Git from './index';
import { clearLogger, output, branch, git, mockLogger, repo } from './test-fixtures/git-harness';

describe('git utilities', () => {
  beforeEach(clearLogger);
  let execSpy: Mock<typeof git.execFileAsync>;
  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });
  afterEach(() => {
    execSpy.mockRestore();
  });

  describe('getUniqueCommitCount', () => {
    test('returns zero when all tip commits are reachable from surviving refs', async () => {
      execSpy
        .mockResolvedValueOnce(
          output(
            'refs/heads/feature/auth\nrefs/heads/dev\nrefs/remotes/origin/feature/auth\nrefs/remotes/origin/dev\nrefs/tags/v1.0.0\n'
          )
        )
        .mockResolvedValueOnce(output());

      expect(await git.getUniqueCommitCount(repo('/workspace/repo'), branch('feature/auth'))).toBe(
        0
      );
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
        .mockResolvedValueOnce(output('refs/heads/feature/auth\nrefs/heads/dev\n'))
        .mockResolvedValueOnce(output('abc123\ndef456\n\n'));

      expect(await git.getUniqueCommitCount(repo('/workspace/repo'), branch('feature/auth'))).toBe(
        2
      );
    });

    test('excludes the configured remote counterpart but retains other remotes and tags', async () => {
      execSpy
        .mockResolvedValueOnce(
          output(
            'refs/heads/feature/auth\nrefs/remotes/upstream/feature/auth\nrefs/remotes/origin/feature/auth\nrefs/tags/reviewed\n'
          )
        )
        .mockResolvedValueOnce(output('abc123\n'));

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
        .mockResolvedValueOnce(
          output('refs/heads/feature/auth\nrefs/remotes/origin/feature/auth\n')
        )
        .mockResolvedValueOnce(output('abc123\ndef456\n'));

      expect(await git.getUniqueCommitCount(repo('/workspace/repo'), branch('feature/auth'))).toBe(
        2
      );
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

  describe('isBranchMerged', () => {
    test('returns true when branch is merged', async () => {
      execSpy.mockResolvedValue(output('  feature-branch\n* main\n  other-branch\n'));

      expect(
        await git.isBranchMerged(repo('/workspace/repo'), branch('feature-branch'), branch('main'))
      ).toBe(true);
    });

    test('returns false when branch is not merged', async () => {
      execSpy.mockResolvedValue(output('* main\n  other-branch\n'));

      expect(
        await git.isBranchMerged(repo('/workspace/repo'), branch('feature-branch'), branch('main'))
      ).toBe(false);
    });

    test('handles branches with / characters', async () => {
      execSpy.mockResolvedValue(output('  feature/auth\n* main\n'));

      expect(
        await git.isBranchMerged(repo('/workspace/repo'), branch('feature/auth'), branch('main'))
      ).toBe(true);
    });

    test('returns false on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));

      expect(
        await git.isBranchMerged(repo('/workspace/repo'), branch('feature'), branch('main'))
      ).toBe(false);
    });

    test('throws and logs on unexpected errors', async () => {
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
      execSpy.mockResolvedValue(output('* develop\n  feature\n'));

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
      execSpy.mockResolvedValue(output('* main\n  feature\n'));

      expect(
        await git.isBranchMerged(repo('/workspace/repo'), branch('main'), branch('main'))
      ).toBe(true);
    });
  });

  describe('isPatchEquivalent', () => {
    test.each([
      ['returns true when all cherry lines start with -', '- abc123\n- def456\n', true],
      ['returns false when any cherry line starts with +', '- abc123\n+ def456\n', false],
      ['returns true for empty cherry output', '', true],
    ] as const)('%s', async (_name, stdout, expected) => {
      execSpy.mockResolvedValue(output(stdout));
      expect(
        await git.isPatchEquivalent(repo('/workspace/repo'), branch('feature'), branch('main'))
      ).toBe(expected);
    });

    test('returns false on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));
      expect(
        await git.isPatchEquivalent(repo('/workspace/repo'), branch('feature'), branch('main'))
      ).toBe(false);
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
    test('returns valid date from git log output', async () => {
      execSpy.mockResolvedValue(output('2024-01-15 10:30:00 +0000\n'));

      const result = await git.getLastCommitDate(repo('/workspace/repo'));
      expect(result).toBeInstanceOf(Date);
      expect(result!.getFullYear()).toBe(2024);
    });

    test('returns null on expected errors (not a git repo)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));

      expect(await git.getLastCommitDate(repo('/workspace/repo'))).toBeNull();
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

      expect(await git.getLastCommitDate(repo('/workspace/repo'))).toBeNull();
    });

    test('throws and logs on unexpected errors', async () => {
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
      execSpy.mockResolvedValue(output());

      expect(await git.getLastCommitDate(repo('/workspace/repo'))).toBeNull();
    });

    test('returns null and warns for invalid date format', async () => {
      execSpy.mockResolvedValue(output('not-a-date\n'));

      expect(await git.getLastCommitDate(repo('/workspace/repo'))).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workingPath: '/workspace/repo', rawDate: 'not-a-date' }),
        'invalid_commit_date_format'
      );
    });
  });

  describe('countCommitsAhead', () => {
    test('returns commit count when ahead of origin', async () => {
      execSpy.mockResolvedValue(output('3\n'));

      expect(
        await git.countCommitsAhead('/workspace/repo' as Git.RepoPath, 'main' as Git.BranchName)
      ).toBe(3);
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'rev-list', '--count', 'origin/main..HEAD'],
        { timeout: 10000 }
      );
    });

    test('returns 0 when in sync', async () => {
      execSpy.mockResolvedValue(output('0\n'));

      expect(
        await git.countCommitsAhead('/workspace/repo' as Git.RepoPath, 'main' as Git.BranchName)
      ).toBe(0);
    });

    test('returns 0 for NaN stdout (malformed git output)', async () => {
      execSpy.mockResolvedValue(output('not-a-number\n'));

      expect(
        await git.countCommitsAhead('/workspace/repo' as Git.RepoPath, 'main' as Git.BranchName)
      ).toBe(0);
    });

    test('returns 0 on any error (origin branch missing, ENOENT, etc.)', async () => {
      execSpy.mockRejectedValue(new Error("fatal: unknown revision 'origin/main..HEAD'"));

      expect(
        await git.countCommitsAhead('/workspace/repo' as Git.RepoPath, 'main' as Git.BranchName)
      ).toBe(0);
    });
  });

  describe('isAncestorOf', () => {
    test('returns true when ref is ancestor of HEAD (exit 0)', async () => {
      execSpy.mockResolvedValue(output());

      expect(await git.isAncestorOf('/worktrees/feature' as Git.WorktreePath, 'origin/dev')).toBe(
        true
      );
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

      expect(await git.isAncestorOf('/worktrees/feature' as Git.WorktreePath, 'origin/main')).toBe(
        false
      );
    });

    test('returns false on expected errors (not a git repository)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));

      expect(await git.isAncestorOf('/worktrees/feature' as Git.WorktreePath, 'origin/main')).toBe(
        false
      );
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
      execSpy.mockRejectedValue(new Error('fatal: permission denied'));

      await expect(
        git.isAncestorOf('/worktrees/feature' as Git.WorktreePath, 'origin/dev')
      ).rejects.toThrow('Failed to check if origin/dev is ancestor of HEAD');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ ancestorRef: 'origin/dev' }),
        'branch.ancestor_check_failed'
      );
    });
  });
});

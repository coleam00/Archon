import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import type * as Git from './index';
import { clearLogger, output, branch, git, repo, worktree } from './test-fixtures/git-harness';

describe('git utilities', () => {
  beforeEach(clearLogger);
  let execSpy: Mock<typeof git.execFileAsync>;
  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });
  afterEach(() => {
    execSpy.mockRestore();
  });

  describe('hasUncommittedChangesStrict', () => {
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
    test.each([
      ['returns true when there are uncommitted changes', ' M file.ts\n?? newfile.ts\n', true],
      ['returns false when working tree is clean', '', false],
      ['returns false when output is only whitespace', '   \n\n', false],
    ] as const)('%s', async (_name, stdout, expected) => {
      execSpy.mockResolvedValue(output(stdout));
      expect(await git.hasUncommittedChanges(repo('/workspace/repo'))).toBe(expected);
      expect(execSpy).toHaveBeenCalledWith('git', [
        '-C',
        '/workspace/repo',
        'status',
        '--porcelain',
      ]);
    });

    test('returns false for structured repository absence', async () => {
      const error = new git.GitFailure('not_repository', 'absent checkout');
      execSpy.mockRejectedValue(error);

      expect(await git.hasUncommittedChanges(repo('/nonexistent'))).toBe(false);
    });

    test('returns true (fail-safe) when git fails with unexpected error', async () => {
      execSpy.mockRejectedValue(
        new git.GitFailure('unclassified', 'No such file or directory; not a git repository')
      );

      expect(await git.hasUncommittedChanges(repo('/workspace/corrupted'))).toBe(true);
    });
  });

  describe('getDefaultBranch', () => {
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
      execSpy.mockResolvedValue(output('abc123\trefs/heads/main\n'));
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
        return output('.git');
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
        return output();
      });
      expect(
        await git.inspectRemoteBranches({
          kind: 'url',
          url: 'https://git.example.com/repo',
          credentials: { username: 'oauth2', password: 'private-token' },
        })
      ).toEqual({ status: 'unavailable', evidence: '*** denied' });
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

  describe('getCurrentBranch', () => {
    test('returns branch name when on a named branch', async () => {
      execSpy.mockResolvedValue(output('main\n'));

      expect(await git.getCurrentBranch('/workspace/repo' as Git.RepoPath)).toBe(branch('main'));
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'symbolic-ref', '--short', 'HEAD'],
        { timeout: 10000 }
      );
    });

    test('returns null for whitespace-only stdout', async () => {
      execSpy.mockResolvedValue(output('   \n'));

      expect(await git.getCurrentBranch('/workspace/repo' as Git.RepoPath)).toBeNull();
    });

    test('returns null on any git error (detached HEAD, ENOENT, not a git repo)', async () => {
      execSpy.mockRejectedValue(new git.GitFailure('not_repository', 'arbitrary wording'));

      expect(await git.getCurrentBranch('/workspace/repo' as Git.RepoPath)).toBeNull();
    });
  });

  describe('ownership-critical branch probes', () => {
    test('getCurrentBranchStrict returns a named branch', async () => {
      execSpy.mockResolvedValue(output('refs/heads/feature/live-pr\n'));

      await expect(git.getCurrentBranchStrict('/workspace/repo' as Git.RepoPath)).resolves.toBe(
        branch('feature/live-pr')
      );
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'symbolic-ref', '--quiet', 'HEAD'],
        { timeout: 10000 }
      );
    });

    test('getCurrentBranchStrict refuses a symbolic HEAD outside local branches', async () => {
      execSpy.mockResolvedValue(output('refs/custom/foo\n'));

      await expect(git.getCurrentBranchStrict('/workspace/repo' as Git.RepoPath)).rejects.toThrow(
        "HEAD refers to 'refs/custom/foo', not a local branch"
      );
    });

    test('getCurrentBranchStrict returns null only for detached HEAD', async () => {
      execSpy.mockRejectedValue(Object.assign(new Error('not a symbolic ref'), { code: 1 }));

      await expect(
        git.getCurrentBranchStrict('/workspace/repo' as Git.RepoPath)
      ).resolves.toBeNull();
    });

    test('getCurrentBranchStrict preserves infrastructure failures', async () => {
      execSpy.mockRejectedValue(
        Object.assign(new Error('operation timed out'), { code: 'ETIMEDOUT' })
      );

      let error: Error | undefined;
      try {
        await git.getCurrentBranchStrict('/workspace/repo' as Git.RepoPath);
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toMatch(/operation timed out/);
      expect((error?.cause as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    });

    test('localBranchExists distinguishes a missing ref from an unreadable repository', async () => {
      execSpy.mockRejectedValueOnce(Object.assign(new Error('missing ref'), { code: 1 }));
      await expect(
        git.localBranchExists('/workspace/repo' as Git.RepoPath, branch('feature/missing'))
      ).resolves.toBe(false);

      execSpy.mockRejectedValueOnce(
        Object.assign(new Error('permission denied'), { code: 'EACCES' })
      );
      let error: Error | undefined;
      try {
        await git.localBranchExists('/workspace/repo' as Git.RepoPath, branch('feature/live'));
      } catch (caught) {
        error = caught as Error;
      }
      expect(error?.message).toMatch(/permission denied/);
      expect((error?.cause as NodeJS.ErrnoException).code).toBe('EACCES');
    });
  });
});

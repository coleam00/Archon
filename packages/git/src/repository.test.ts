import { trackTempRoots } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdtemp, mkdir as realMkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { output, branch, git, repo } from './test-fixtures/git-harness';

const trackTempRoot = trackTempRoots();

describe('git utilities', () => {
  let execSpy: Mock<typeof git.execFileAsync>;
  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });
  afterEach(() => {
    execSpy.mockRestore();
  });

  describe('getDefaultRemote', () => {
    test('returns origin when it exists among multiple remotes', async () => {
      execSpy.mockResolvedValue(output('upstream\norigin\n'));

      expect(await git.getDefaultRemote(repo('/workspace/repo'))).toBe('origin');
    });

    test('returns sole remote when only one is configured', async () => {
      execSpy.mockResolvedValue(output('mar\n'));

      expect(await git.getDefaultRemote(repo('/workspace/repo'))).toBe('mar');
    });

    test('returns null when multiple non-origin remotes exist', async () => {
      execSpy.mockResolvedValue(output('jan\nfeb\nmar\n'));

      expect(await git.getDefaultRemote(repo('/workspace/repo'))).toBeNull();
    });

    test('returns null when no remotes are configured', async () => {
      execSpy.mockResolvedValue(output());

      expect(await git.getDefaultRemote(repo('/workspace/repo'))).toBeNull();
    });

    test('propagates git errors instead of swallowing them', async () => {
      execSpy.mockRejectedValue(new Error('not a git repository'));

      await expect(git.getDefaultRemote(repo('/workspace/repo'))).rejects.toThrow(
        'not a git repository'
      );
    });

    test('handles CRLF line endings from git output', async () => {
      execSpy.mockResolvedValue(output('origin\r\nupstream\r\n'));

      expect(await git.getDefaultRemote(repo('/workspace/repo'))).toBe('origin');
    });
  });

  describe('syncRepository', () => {
    test('fetches and resets successfully', async () => {
      execSpy.mockResolvedValue(output());

      expect(await git.syncRepository(repo('/workspace/repo'), branch('main'))).toEqual({
        ok: true,
        value: undefined,
      });
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
        expect(JSON.stringify(result.error)).toContain('cannot lock ref');
      }
      const fetches = execSpy.mock.calls.filter(([, args]) => args[2] === 'fetch');
      expect(fetches).toHaveLength(1);
      const resets = execSpy.mock.calls.filter(([, args]) => args[0] === 'reset');
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
      const fetches = execSpy.mock.calls.filter(([, args]) => args[2] === 'fetch');
      expect(fetches).toHaveLength(1);
    });

    test('fetches and resets using a custom remote', async () => {
      execSpy.mockResolvedValue(output());

      expect(await git.syncRepository(repo('/workspace/repo'), branch('main'), 'upstream')).toEqual(
        { ok: true, value: undefined }
      );
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
      const resetCalls = execSpy.mock.calls.filter(([, args]) => args.includes('reset'));
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
        return output();
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
          return output();
        }
        if (args.includes('reset')) {
          throw new Error("fatal: ambiguous argument 'origin/nonexistent': unknown revision");
        }
        return output();
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
          return output();
        }
        if (args.includes('reset')) {
          throw new Error('segfault');
        }
        return output();
      });

      const result = await git.syncRepository(repo('/workspace/repo'), branch('main'));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('unknown');
      }
    });
  });

  describe('findRepoRoot', () => {
    test('returns repo root path', async () => {
      execSpy.mockResolvedValue(output('/workspace/repo\n'));

      expect(await git.findRepoRoot('/workspace/repo/src')).toBe(repo('/workspace/repo'));
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
    let root: string;
    beforeEach(async () => {
      root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-childrepos-test-')));
    });

    test('lists immediate child directories that contain .git, sorted', async () => {
      await realMkdir(join(root, 'svc-a', '.git'), { recursive: true });
      await realMkdir(join(root, 'svc-b', '.git'), { recursive: true });
      await realMkdir(join(root, 'docs'), { recursive: true });
      await realMkdir(join(root, 'svc-c'), { recursive: true });
      await writeFile(join(root, 'svc-c', '.git'), 'gitdir: /elsewhere\n');

      expect(await git.listChildRepos(root)).toEqual(['svc-a', 'svc-b', 'svc-c']);
    });

    test('returns empty array when no child repos exist', async () => {
      await realMkdir(join(root, 'plain-a'), { recursive: true });
      await realMkdir(join(root, 'plain-b'), { recursive: true });

      expect(await git.listChildRepos(root)).toEqual([]);
    });

    test('does not recurse into nested repos', async () => {
      await realMkdir(join(root, 'svc-a', '.git'), { recursive: true });
      await realMkdir(join(root, 'svc-a', 'inner', '.git'), { recursive: true });

      expect(await git.listChildRepos(root)).toEqual(['svc-a']);
    });

    test('returns empty array for an unreadable/nonexistent root (never throws)', async () => {
      expect(await git.listChildRepos(join(root, 'does-not-exist'))).toEqual([]);
    });
  });

  describe('getRemoteUrl', () => {
    test('returns remote URL', async () => {
      execSpy.mockResolvedValue(output('https://github.com/owner/repo.git\n'));

      expect(await git.getRemoteUrl(repo('/workspace/repo'))).toBe(
        'https://github.com/owner/repo.git'
      );
    });

    test('queries a custom remote when provided', async () => {
      execSpy.mockResolvedValue(output('https://github.com/owner/repo.git\n'));

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

      expect(await git.getRemoteUrl(repo('/workspace/repo'))).toBeNull();
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
        execSpy.mockResolvedValueOnce(output('https://github.com/owner/repo.git\n'));

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
});

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { trackTempRoots } from '@archon/paths/test-utils';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Git from './index';
import { clearLogger, output, branch, git, mockLogger, repo } from './test-fixtures/git-harness';

const trackTempRoot = trackTempRoots();

test('fetch-only classifies newly fetched remote commits without updating HEAD', async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-workspace-sync-')));
  const remote = join(root, 'remote.git');
  const writer = join(root, 'writer');
  const checkout = repo(join(root, 'checkout'));
  const run = async (cwd: string, ...args: string[]): Promise<string> => {
    const result = await git.execFileAsync('git', ['-C', cwd, ...args]);
    return result.stdout.trim();
  };

  await run(root, 'init', '--bare', '-q', '-b', 'main', remote);
  await run(root, 'clone', '-q', remote, writer);
  await run(writer, 'config', 'user.name', 'Archon Test');
  await run(writer, 'config', 'user.email', 'test@example.com');
  await run(writer, 'config', 'commit.gpgsign', 'false');
  await run(writer, 'commit', '--allow-empty', '-qm', 'base');
  await run(writer, 'push', '-q', 'origin', 'main');
  await run(root, 'clone', '-q', remote, checkout);
  const initialHead = await run(checkout, 'rev-parse', 'HEAD');
  const initialShortHead = await run(checkout, 'rev-parse', '--short=8', 'HEAD');

  await run(writer, 'commit', '--allow-empty', '-qm', 'remote advance');
  await run(writer, 'push', '-q', 'origin', 'main');
  const remoteHead = await run(writer, 'rev-parse', 'HEAD');
  expect(remoteHead).not.toBe(initialHead);
  expect(await run(checkout, 'rev-parse', 'origin/main')).toBe(initialHead);

  const result = await git.syncWorkspace(checkout, branch('main'), { mode: 'fetch-only' });

  expect(result).toEqual({
    branch: branch('main'),
    synced: true,
    mode: 'fetch-only',
    state: 'behind',
    previousHead: initialShortHead,
    newHead: initialShortHead,
    updated: false,
  });
  expect(await run(checkout, 'rev-parse', 'origin/main')).toBe(remoteHead);
  expect(await run(checkout, 'rev-parse', 'HEAD')).toBe(initialHead);
});

function failingWorkspaceCommand(
  operation: 'fetch' | 'reset',
  failure: Error,
  heads = ''
): typeof git.execFileAsync {
  return async (_cmd, args) => {
    if (args.includes(operation)) throw failure;
    return output(args.includes('ls-remote') ? heads : '');
  };
}

interface WorkspaceFixture {
  status?: string;
  localSha?: string;
  remoteSha?: string;
  remoteRef?: string;
  shortBefore?: string;
  shortAfter?: string;
  shortFailure?: Error;
  currentBranch?: string;
  localAncestor?: boolean;
  remoteAncestor?: boolean;
  ancestryFailure?: Error;
}

function workspaceCommands({
  status = '',
  localSha = 'abc12345abcdef',
  remoteSha = localSha,
  remoteRef = 'origin/main',
  shortBefore = 'abc12345',
  shortAfter = shortBefore,
  shortFailure,
  currentBranch = 'main',
  localAncestor = true,
  remoteAncestor = false,
  ancestryFailure,
}: WorkspaceFixture = {}): typeof git.execFileAsync {
  let shortReads = 0;
  const readShortSha = (): string => {
    if (shortFailure) throw shortFailure;
    return shortReads++ === 0 ? shortBefore : shortAfter;
  };
  return async (_cmd, args) => {
    if (args.includes('status')) return output(status);
    // Real git ends every line with a newline; the sync must trim it before comparing SHAs.
    if (args.includes('--short=8')) return output(`${readShortSha()}\n`);
    if (args.includes('--abbrev-ref')) return output(`${currentBranch}\n`);
    if (args.includes('rev-parse'))
      return output(`${args.includes(remoteRef) ? remoteSha : localSha}\n`);
    if (args.includes('merge-base')) {
      expect([localSha, remoteSha]).toContain(args[4]);
      expect(args[5]).toBe(args[4] === localSha ? remoteSha : localSha);
      if (ancestryFailure) throw ancestryFailure;
      const isAncestor = args[4] === localSha ? localAncestor : remoteAncestor;
      if (!isAncestor) throw Object.assign(new Error('not ancestor'), { code: 1 });
    }
    return output();
  };
}

describe('git utilities', () => {
  describe('syncWorkspace', () => {
    let execSpy: Mock<typeof git.execFileAsync>;
    let getDefaultBranchSpy: Mock<typeof git.getDefaultBranch>;

    beforeEach(() => {
      clearLogger();
      execSpy = spyOn(git, 'execFileAsync');
      getDefaultBranchSpy = spyOn(git, 'getDefaultBranch');
      getDefaultBranchSpy.mockResolvedValue(branch('main'));
    });

    afterEach(() => {
      execSpy.mockRestore();
      getDefaultBranchSpy.mockRestore();
    });

    test('fetches origin branch and returns synced result', async () => {
      execSpy.mockImplementation(workspaceCommands());

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
      execSpy.mockResolvedValue(output());

      await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(execSpy.mock.calls.some(([, args]) => args.includes('reset'))).toBe(false);
    });

    test('hard-resets working tree to origin in reset mode', async () => {
      execSpy.mockResolvedValue(output());

      await git.syncWorkspace(repo('/workspace/repo'), branch('main'), { mode: 'reset' });

      const resetCalls = execSpy.mock.calls.filter(([, args]) => args.includes('reset'));

      expect(resetCalls).toHaveLength(1);
      expect(resetCalls[0][1]).toEqual(['-C', '/workspace/repo', 'reset', '--hard', 'origin/main']);
    });

    test('throws if reset mode fails after successful fetch', async () => {
      execSpy.mockImplementation(
        failingWorkspaceCommand('reset', new Error('fatal: Could not reset index file'))
      );

      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('main'), { mode: 'reset' })
      ).rejects.toThrow('Reset to origin/main failed');
    });

    test('throws error if fetch fails', async () => {
      execSpy.mockImplementation(
        failingWorkspaceCommand(
          'fetch',
          new Error('fatal: unable to access repository'),
          'abc123\trefs/heads/main\nabc123\trefs/heads/dev\n'
        )
      );

      await expect(git.syncWorkspace(repo('/workspace/repo'), branch('main'))).rejects.toThrow(
        'unable to access repository'
      );
    });

    test('logs short SHA read failures without failing sync', async () => {
      execSpy.mockImplementation(
        workspaceCommands({ shortFailure: new Error('fatal: bad revision HEAD') })
      );

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.previousHead).toBe('');
      expect(result.newHead).toBe('');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: '/workspace/repo', ref: 'HEAD' }),
        'workspace.short_sha_read_failed'
      );
    });

    test('passes correct timeout value to fetch command', async () => {
      execSpy.mockResolvedValue(output());

      await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      const fetchCall = execSpy.mock.calls.find(([, args]) => args.includes('fetch'));
      expect(fetchCall?.[2]).toEqual({ timeout: 60000 });
    });

    test('includes operation context in fetch error message', async () => {
      execSpy.mockImplementation(
        failingWorkspaceCommand(
          'fetch',
          new Error('fatal: network unreachable'),
          'abc123\trefs/heads/main\nabc123\trefs/heads/dev\n'
        )
      );

      await expect(git.syncWorkspace(repo('/workspace/repo'), branch('main'))).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );
    });

    test('derives branch from getDefaultBranch when override not provided', async () => {
      execSpy.mockImplementation(workspaceCommands({ remoteRef: 'origin/develop' }));
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
      execSpy.mockImplementation(
        failingWorkspaceCommand(
          'fetch',
          new Error("fatal: couldn't find remote ref does-not-exist")
        )
      );

      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('does-not-exist'))
      ).rejects.toThrow("Configured base branch 'does-not-exist' not found on remote");
      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('does-not-exist'))
      ).rejects.toThrow('update worktree.baseBranch');
    });

    test('throws generic error when auto-detected branch not found (not actionable)', async () => {
      execSpy.mockImplementation(
        failingWorkspaceCommand('fetch', new Error("fatal: couldn't find remote ref main"))
      );
      getDefaultBranchSpy.mockResolvedValue(branch('main'));

      await expect(git.syncWorkspace(repo('/workspace/repo'))).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );
      await expect(git.syncWorkspace(repo('/workspace/repo'))).rejects.not.toThrow(
        'worktree.baseBranch'
      );
    });

    test('fetch-only mode fetches and does not reset or merge', async () => {
      execSpy.mockImplementation(
        workspaceCommands({
          remoteSha: 'def67890abcdef',
          localAncestor: false,
          remoteAncestor: false,
        })
      );

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'), {
        mode: 'fetch-only',
      });

      expect(result.mode).toBe('fetch-only');
      expect(result.state).toBe('diverged');
      expect(result.updated).toBe(false);

      const fetchCalls = execSpy.mock.calls.filter(([, args]) => args.includes('fetch'));
      expect(fetchCalls).toHaveLength(1);

      const resetCalls = execSpy.mock.calls.filter(([, args]) => args.includes('reset'));
      expect(resetCalls).toHaveLength(0);
      const mergeCalls = execSpy.mock.calls.filter(([, args]) => args.includes('merge'));
      expect(mergeCalls).toHaveLength(0);
    });

    test('dirty tracked files return dirty and do not merge or reset', async () => {
      execSpy.mockImplementation(workspaceCommands({ status: ' M src/index.ts\n' }));

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.state).toBe('dirty');
      expect(execSpy.mock.calls.some(([, args]) => args.includes('merge'))).toBe(false);
      expect(execSpy.mock.calls.some(([, args]) => args.includes('reset'))).toBe(false);
    });

    test('untracked files do not mark the checkout dirty', async () => {
      execSpy.mockImplementation(async (_cmd: string, args: string[]) => {
        if (args.includes('status')) {
          expect(args).toContain('--untracked-files=no');
          return output();
        }
        if (args.includes('rev-parse') && args.includes('--short=8')) {
          return output('abc12345\n');
        }
        if (args.includes('rev-parse') && args.includes('HEAD')) {
          return output('abc12345abcdef\n');
        }
        if (args.includes('rev-parse') && args.includes('origin/main')) {
          return output('abc12345abcdef\n');
        }
        return output();
      });

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.state).toBe('in_sync');
    });

    test('behind on current target branch fast-forwards', async () => {
      execSpy.mockImplementation(
        workspaceCommands({
          remoteSha: 'def67890abcdef',
          currentBranch: 'main',
          shortAfter: 'def67890',
        })
      );

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.state).toBe('in_sync');
      expect(result.updated).toBe(true);
      expect(execSpy.mock.calls.some(([, args]) => args.includes('merge'))).toBe(true);
    });

    test('behind on non-target current branch does not fast-forward', async () => {
      execSpy.mockImplementation(
        workspaceCommands({ remoteSha: 'def67890abcdef', currentBranch: 'feature' })
      );

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));

      expect(result.state).toBe('behind');
      expect(result.updated).toBe(false);
      expect(execSpy.mock.calls.some(([, args]) => args.includes('merge'))).toBe(false);
    });

    test('ahead and diverged preserve local state', async () => {
      execSpy.mockImplementation(
        workspaceCommands({
          localSha: 'def67890abcdef',
          remoteSha: 'abc12345abcdef',
          shortBefore: 'def67890',
          localAncestor: false,
          remoteAncestor: true,
        })
      );

      const aheadResult = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));
      expect(aheadResult.state).toBe('ahead');
      expect(execSpy.mock.calls.some(([, args]) => args.includes('merge'))).toBe(false);

      execSpy.mockClear();
      execSpy.mockImplementation(
        workspaceCommands({
          localSha: 'HEAD-sha',
          remoteSha: 'origin/main-sha',
          shortBefore: 'HEAD-sha',
          localAncestor: false,
          remoteAncestor: false,
        })
      );

      const divergedResult = await git.syncWorkspace(repo('/workspace/repo'), branch('main'));
      expect(divergedResult.state).toBe('diverged');
      expect(execSpy.mock.calls.some(([, args]) => args.includes('merge'))).toBe(false);
    });

    test('throws unexpected merge-base failures instead of treating them as diverged', async () => {
      execSpy.mockImplementation(
        workspaceCommands({
          localSha: 'local-sha',
          remoteSha: 'remote-sha',
          ancestryFailure: new git.GitFailure(
            'unclassified',
            'ancestry command failed',
            Object.assign(new Error('fatal: bad object'), { code: 128, stderr: 'bad object' })
          ),
        })
      );

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
      execSpy.mockResolvedValue(output());

      await git.syncWorkspace(repo('/workspace/repo'), branch('main'), {
        mode: 'reset',
        remote: 'mar',
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'fetch', 'mar', 'main'],
        expect.any(Object)
      );

      const resetCalls = execSpy.mock.calls.filter(([, args]) => args.includes('reset'));
      expect(resetCalls).toHaveLength(1);
      expect(resetCalls[0][1]).toEqual(['-C', '/workspace/repo', 'reset', '--hard', 'mar/main']);
    });

    test('classifies state against the custom remote ref in fast-forward mode', async () => {
      execSpy.mockImplementation(workspaceCommands({ remoteRef: 'upstream/main' }));

      const result = await git.syncWorkspace(repo('/workspace/repo'), branch('main'), {
        remote: 'upstream',
      });

      expect(result.state).toBe('in_sync');
      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/workspace/repo', 'rev-parse', 'upstream/main'],
        expect.any(Object)
      );
    });

    test('passes custom remote to getDefaultBranch when baseBranch not provided', async () => {
      execSpy.mockResolvedValue(output());
      getDefaultBranchSpy.mockResolvedValue(branch('develop'));

      await git.syncWorkspace(repo('/workspace/repo'), undefined, { remote: 'upstream' });

      expect(getDefaultBranchSpy).toHaveBeenCalledWith('/workspace/repo', 'upstream');
    });

    test('includes custom remote name in fetch error message', async () => {
      execSpy.mockImplementation(
        failingWorkspaceCommand(
          'fetch',
          new Error("fatal: 'mar' does not appear to be a git repository"),
          'abc123\trefs/heads/main\nabc123\trefs/heads/dev\n'
        )
      );

      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('main'), { remote: 'mar' })
      ).rejects.toThrow('Sync fetch from mar/main failed');
    });

    test.each([1, 128])(
      'bounds fetch retries for exit %s and preserves the final failure',
      async code => {
        const failures: Git.GitFailure[] = [];
        execSpy.mockImplementation(async (_cmd, args) => {
          if (args.includes('ls-remote')) return output('abc123\trefs/heads/main\n');
          if (!args.includes('fetch')) return output();
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
        if (args.includes('ls-remote')) return output('abc123\trefs/heads/main\n');
        if (!args.includes('fetch')) return output();
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
          return output('abc123\trefs/heads/main\nabc123\trefs/heads/dev\n');
        if (args.includes('fetch')) {
          fetchCalls++;
          throw raceError;
        }
        return output();
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
          return output('abc123\trefs/heads/main\nabc123\trefs/heads/dev\n');
        if (args.includes('fetch')) {
          fetchCalls++;
          throw new Error("fatal: 'origin' does not appear to be a git repository");
        }
        return output();
      });

      await expect(git.syncWorkspace(repo('/workspace/repo'), branch('main'))).rejects.toThrow(
        'Sync fetch from origin/main failed'
      );

      expect(fetchCalls).toBe(1);
    });

    test('names the custom remote in the configured-branch-missing error', async () => {
      execSpy.mockImplementation(
        failingWorkspaceCommand(
          'fetch',
          new Error("fatal: couldn't find remote ref does-not-exist")
        )
      );

      await expect(
        git.syncWorkspace(repo('/workspace/repo'), branch('does-not-exist'), { remote: 'mar' })
      ).rejects.toThrow("Configured base branch 'does-not-exist' not found on remote 'mar'");
    });
  });
});

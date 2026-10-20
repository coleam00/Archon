import { trackTempRoots } from '@archon/paths/test-utils';
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import {
  chmod,
  mkdtemp,
  readFile,
  mkdir as realMkdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveEnvironment } from './test-fixtures/environment';
import { clearLogger, output, git, mockLogger, repo } from './test-fixtures/git-harness';

const trackTempRoot = trackTempRoots();

describe('git utilities', () => {
  beforeEach(clearLogger);
  describe('addSafeDirectory', () => {
    let execSpy: Mock<typeof git.execFileAsync>;

    beforeEach(() => {
      execSpy = spyOn(git, 'execFileAsync');
    });

    afterEach(() => {
      execSpy.mockRestore();
    });

    test('calls git config with correct arguments', async () => {
      execSpy.mockResolvedValue(output());

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
      execSpy.mockResolvedValue(output());

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
        const restoreEnvironment = saveEnvironment('GIT_CONFIG_GLOBAL');
        process.env.GIT_CONFIG_GLOBAL = config;
        try {
          await realExec('git', ['init', root]);
          await writeFile(config, `[safe]\n directory = ${JSON.stringify(root)}\n directory = \n`);
          if (process.platform !== 'win32') await chmod(config, 0o660);
          const configMode = (await stat(config)).mode;
          const checkTrust = async (): Promise<void> => {
            await realExec('git', ['-C', root, 'status', '--porcelain'], {
              env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
            });
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
          restoreEnvironment();
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
      const restoreEnvironment = saveEnvironment('GIT_CONFIG_GLOBAL');
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
        restoreEnvironment();
      }
    });

    test.each(['include-reset', 'two-globals'])(
      'repairs effective global trust across %s',
      async layout => {
        execSpy.mockRestore();
        const root = trackTempRoot(
          (await realpath(await mkdtemp(join(tmpdir(), 'git-safe-sources-')))).replaceAll('\\', '/')
        );
        const restoreEnvironment = saveEnvironment('HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL');
        Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: join(root, 'xdg') });
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
            await git.execFileAsync('git', ['-C', root, 'status', '--porcelain'], {
              env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' },
            });
          }
        } finally {
          restoreEnvironment();
        }
      }
    );

    test('repeated setup keeps one exact safe-directory entry and preserves other paths', async () => {
      execSpy.mockRestore();
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'git-safe-directory-')));
      const configPath = join(root, 'gitconfig');
      const restoreEnvironment = saveEnvironment('GIT_CONFIG_GLOBAL');
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
        restoreEnvironment();
      }
    });

    // Windows and root keep the write: git compares owner SIDs on Windows, which
    // we do not read, and judges root callers by SUDO_UID.
    test.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
      'concurrent worktree setups under a directory this user owns all succeed',
      async () => {
        execSpy.mockRestore();
        const root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'git-safe-race-'))));
        const configPath = join(root, 'gitconfig');
        const restoreEnvironment = saveEnvironment('GIT_CONFIG_GLOBAL');
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
          restoreEnvironment();
        }
      }
    );

    test.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
      'a new path under a symlink into a root-owned directory keeps its grant',
      async () => {
        execSpy.mockRestore();
        const root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'git-safe-link-'))));
        const configPath = join(root, 'gitconfig');
        const restoreEnvironment = saveEnvironment('GIT_CONFIG_GLOBAL');
        process.env.GIT_CONFIG_GLOBAL = configPath;
        try {
          await writeFile(configPath, '');
          // The link is this user's; the directory the checkout would land in is root's.
          await symlink('/usr', join(root, 'link'));
          const checkout = repo(join(root, 'link', 'checkout'));
          await git.addSafeDirectory(checkout);
          const { stdout } = await git.execFileAsync('git', [
            'config',
            '--global',
            '--get-all',
            'safe.directory',
          ]);
          expect(stdout.trim()).toBe(checkout);
        } finally {
          restoreEnvironment();
        }
      }
    );
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

  describe('trustRegisteredPath', () => {
    const grants = async (): Promise<string[]> => {
      try {
        const { stdout } = await git.execFileAsync('git', [
          'config',
          '--global',
          '--get-all',
          'safe.directory',
        ]);
        return stdout.trim().split('\n');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 1) return [];
        throw error;
      }
    };

    const withScratchConfig = async (
      body: (root: string) => Promise<void>,
      differentOwner: boolean
    ): Promise<void> => {
      const root = trackTempRoot(await realpath(await mkdtemp(join(tmpdir(), 'archon-trust-'))));
      const restoreEnvironment = saveEnvironment(
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_TEST_ASSUME_DIFFERENT_OWNER'
      );
      process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
      // CI runner images trust every path in the system config (safe.directory = *).
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      try {
        await git.execFileAsync('git', ['init', '-q', join(root, 'repo')]);
        await realMkdir(join(root, 'plain'));
        if (differentOwner) process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
        await body(root);
      } finally {
        restoreEnvironment();
      }
    };

    test('grants exactly a repo git refuses only for its owner', async () => {
      await withScratchConfig(async root => {
        const repoPath = join(root, 'repo');
        const probe = (): Promise<unknown> =>
          git.execFileAsync('git', ['-C', repoPath, 'rev-parse', '--git-dir']);
        await expect(probe()).rejects.toThrow();
        await git.trustRegisteredPath(repoPath);
        await probe();
        expect(await grants()).toEqual([repoPath]);
      }, true);
    });

    test('never grants a path that is not a repository', async () => {
      await withScratchConfig(async root => {
        await git.trustRegisteredPath(join(root, 'plain'));
        await git.trustRegisteredPath(join(root, 'missing'));
        expect(await grants()).toEqual([]);
      }, true);
    });

    test('writes nothing for a repo git already accepts', async () => {
      await withScratchConfig(async root => {
        await git.trustRegisteredPath(join(root, 'repo'));
        expect(await grants()).toEqual([]);
      }, false);
    });
  });
});

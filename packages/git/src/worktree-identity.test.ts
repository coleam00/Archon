import { trackTempRoots } from '@archon/paths/test-utils';
import { afterEach, beforeEach, type Mock, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir as realMkdir, realpath, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type * as Git from './index';
import { clearLogger, output, git, mockLogger, repo } from './test-fixtures/git-harness';

const trackTempRoot = trackTempRoots();

describe('git utilities', () => {
  beforeEach(clearLogger);
  let execSpy: Mock<typeof git.execFileAsync>;
  beforeEach(() => {
    execSpy = spyOn(git, 'execFileAsync');
  });
  afterEach(() => {
    execSpy.mockRestore();
  });
  let testDir: Git.RepoPath;
  beforeEach(async () => {
    testDir = repo(trackTempRoot(await mkdtemp(join(tmpdir(), 'git-utils-test-'))));
  });

  describe('isWorktreePath', () => {
    test('returns false for directory without .git', async () => {
      expect(await git.isWorktreePath(testDir)).toBe(false);
    });

    test('returns false for main repo (.git directory)', async () => {
      await realMkdir(join(testDir, '.git'));
      expect(await git.isWorktreePath(testDir)).toBe(false);
    });

    test('returns true for worktree (.git file with gitdir)', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: /some/repo/.git/worktrees/branch-name');
      expect(await git.isWorktreePath(testDir)).toBe(true);
    });

    test('returns false for .git file without gitdir prefix', async () => {
      await writeFile(join(testDir, '.git'), 'some other content');
      expect(await git.isWorktreePath(testDir)).toBe(false);
    });

    test('throws and logs for permission errors (EACCES)', async () => {
      const testPath = join(testDir, 'permission-test');
      await realMkdir(testPath, { recursive: true });

      const fsPromises = await import('fs/promises');
      const readFileSpy = spyOn(fsPromises, 'readFile');
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
      execSpy.mockResolvedValue(
        output(`worktree ${targetPath}\0HEAD abc123\0branch refs/heads/main\0\0`)
      );
      try {
        await expect(git.readWorktreeRegistration(testDir, targetPath)).rejects.toBe(error);
        expect(realpathSpy).toHaveBeenCalledTimes(2);
        expect(realpathSpy).toHaveBeenNthCalledWith(1, targetPath);
        expect(realpathSpy).toHaveBeenNthCalledWith(2, targetPath);
      } finally {
        realpathSpy.mockRestore();
      }
    });

    for (const code of ['EACCES', 'EIO', 'ELOOP']) {
      test(`propagates ancestor resolution errors: ${code}`, async () => {
        const error = Object.assign(new Error('cannot resolve path'), { code });
        const fsPromises = await import('fs/promises');
        const realpathSpy = spyOn(fsPromises, 'realpath').mockRejectedValueOnce(error);
        execSpy.mockResolvedValue(output());
        try {
          await expect(
            git.readWorktreeRegistration(testDir, join(testDir, 'checkout'))
          ).rejects.toBe(error);
          expect(realpathSpy).toHaveBeenCalledTimes(1);
        } finally {
          realpathSpy.mockRestore();
        }
      });
    }
  });

  describe('getCanonicalRepoPath', () => {
    test('returns same path for non-worktree', async () => {
      expect(await git.getCanonicalRepoPath(testDir)).toBe(testDir);
    });

    test('returns same path for main repo with .git directory', async () => {
      await realMkdir(join(testDir, '.git'));
      expect(await git.getCanonicalRepoPath(testDir)).toBe(testDir);
    });

    test('extracts main repo path from worktree', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: /workspace/my-repo/.git/worktrees/issue-42');
      execSpy
        .mockResolvedValueOnce(
          output('/workspace/my-repo/.git/worktrees/issue-42\n/workspace/my-repo/.git\n')
        )
        .mockResolvedValueOnce(
          output('worktree /workspace/my-repo\nHEAD abc123\nbranch refs/heads/main\n')
        );
      expect(await git.getCanonicalRepoPath(testDir)).toBe(repo('/workspace/my-repo'));
    });

    test('handles worktree path with nested directories', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /home/user/projects/my-app/.git/worktrees/feature-branch'
      );
      execSpy
        .mockResolvedValueOnce(
          output(
            '/home/user/projects/my-app/.git/worktrees/feature-branch\n/home/user/projects/my-app/.git\n'
          )
        )
        .mockResolvedValueOnce(output('worktree /home/user/projects/my-app\nHEAD abc123\n'));
      expect(await git.getCanonicalRepoPath(testDir)).toBe(repo('/home/user/projects/my-app'));
    });

    test('resolves a relative worktree pointer from the worktree root', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: ../primary/.git/worktrees/linked');
      const primary = resolve(testDir, '../primary');
      execSpy
        .mockResolvedValueOnce(output(`${primary}/.git/worktrees/linked\n${primary}/.git\n`))
        .mockResolvedValueOnce(output(`worktree ${primary}\nHEAD abc123\n`));
      expect(await git.getCanonicalRepoPath(testDir)).toBe(repo(primary));
    });

    test('keeps a submodule checkout as its own canonical repository', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: ../primary/.git/modules/vendor/module');
      const gitDir = resolve(testDir, '../primary/.git/modules/vendor/module');
      execSpy.mockResolvedValue(output(`${gitDir}\n${gitDir}\n`));
      expect(await git.getCanonicalRepoPath(testDir)).toBe(testDir);
    });

    test('keeps a submodule named under worktrees as its own canonical repository', async () => {
      const gitDir = join(testDir, 'primary', '.git', 'modules', 'vendor', 'worktrees', 'module');
      await realMkdir(gitDir, { recursive: true });
      await writeFile(join(testDir, '.git'), `gitdir: ${gitDir}`);

      execSpy.mockResolvedValue(output(`${gitDir}\n${gitDir}\n`));
      expect(await git.getCanonicalRepoPath(testDir)).toBe(testDir);
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
      execSpy.mockResolvedValue(output(`${commonGitDir}\n${commonGitDir}\n`));
      await expect(git.getCanonicalRepoPath(testDir)).resolves.toBe(testDir);
    });

    test('resolves a linked submodule worktree to the primary submodule checkout', async () => {
      const commonGitDir = join(testDir, 'super', '.git', 'modules', 'vendor', 'module');
      const linkedGitDir = join(commonGitDir, 'worktrees', 'linked');
      await realMkdir(linkedGitDir, { recursive: true });
      await writeFile(join(linkedGitDir, 'commondir'), '../..\n');
      await writeFile(join(testDir, '.git'), `gitdir: ${linkedGitDir}`);
      const primaryCheckout = resolve(commonGitDir, '../../../../vendor/module');
      execSpy
        .mockResolvedValueOnce(output(`${linkedGitDir}\n${commonGitDir}\n`))
        .mockResolvedValueOnce(output(`worktree ${commonGitDir}\nHEAD abc123\n`))
        .mockResolvedValueOnce(output('../../../../vendor/module\n'));

      const result = await git.getCanonicalRepoPath(testDir);

      expect(execSpy).toHaveBeenCalledWith('git', [
        '--git-dir',
        commonGitDir,
        'config',
        '--get',
        'core.worktree',
      ]);
      expect(result).toBe(repo(primaryCheckout));
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
      execSpy
        .mockResolvedValueOnce(output(`${linkedGitDir}\n${commonGitDir}\n`))
        .mockResolvedValueOnce(output(`worktree ${commonGitDir}\nHEAD abc123\n`))
        .mockResolvedValueOnce(output(`${primaryCheckout}\n`));
      await expect(git.getCanonicalRepoPath(testDir)).resolves.toBe(repo(primaryCheckout));
    });

    test('keeps a primary checkout with an external Git directory', async () => {
      const externalGitDir = join(testDir, 'metadata');
      await writeFile(join(testDir, '.git'), `gitdir: ${externalGitDir}`);
      execSpy.mockResolvedValue(output(`${externalGitDir}\n${externalGitDir}\n`));
      await expect(git.getCanonicalRepoPath(testDir)).resolves.toBe(testDir);
    });

    test('reports when an external Git directory cannot reveal the primary checkout', async () => {
      const commonGitDir = join(testDir, 'metadata');
      const linkedGitDir = join(commonGitDir, 'worktrees', 'linked');
      await writeFile(join(testDir, '.git'), `gitdir: ${linkedGitDir}`);
      execSpy
        .mockResolvedValueOnce(output(`${linkedGitDir}\n${commonGitDir}\n`))
        .mockResolvedValueOnce(output(`worktree ${commonGitDir}\nHEAD abc123\n`))
        .mockRejectedValueOnce(new Error('core.worktree is unset'));
      await expect(git.getCanonicalRepoPath(testDir)).rejects.toBeInstanceOf(
        git.CanonicalRepoPathUnavailableError
      );
    });
  });

  describe('getCanonicalRepoPath error handling', () => {
    test('throws on non-standard gitdir format', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /some/unusual/path/without/expected/structure'
      );
      execSpy.mockRejectedValue(new Error('invalid gitdir'));

      await expect(git.getCanonicalRepoPath(testDir)).rejects.toThrow(
        'Cannot determine canonical repo path from worktree'
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ path: testDir }),
        'canonical_path_resolution_failed'
      );
    });
  });

  describe('verifyWorktreeOwnership', () => {
    test('resolves for matching worktree pointer', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /workspace/my-repo/.git/worktrees/issue-42\n'
      );
      execSpy
        .mockResolvedValueOnce(
          output('/workspace/my-repo/.git/worktrees/issue-42\n/workspace/my-repo/.git\n')
        )
        .mockResolvedValueOnce(output('/workspace/my-repo/.git\n/workspace/my-repo/.git\n'));

      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        )
      ).resolves.toBeUndefined();
    });

    test('throws with "belongs to a different clone" when gitdir points elsewhere', async () => {
      await writeFile(join(testDir, '.git'), 'gitdir: /other/clone/.git/worktrees/issue-42\n');
      execSpy
        .mockResolvedValueOnce(output('/other/clone/.git/worktrees/issue-42\n/other/clone/.git\n'))
        .mockResolvedValueOnce(output('/workspace/my-repo/.git\n/workspace/my-repo/.git\n'));

      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        )
      ).rejects.toThrow(/belongs to a different clone \(\/other\/clone\/\.git\)/);
    });

    test('normalizes trailing slashes in both paths', async () => {
      await writeFile(
        join(testDir, '.git'),
        'gitdir: /workspace/my-repo/.git/worktrees/issue-42\n'
      );
      execSpy
        .mockResolvedValueOnce(
          output('/workspace/my-repo/.git/worktrees/issue-42/\n/workspace/my-repo/.git/\n')
        )
        .mockResolvedValueOnce(output('/workspace/my-repo/.git\n/workspace/my-repo/.git\n'));

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
      execSpy
        .mockResolvedValueOnce(
          output(
            '/workspace/my-repo/.git/modules/vendor/submodule\n/workspace/my-repo/.git/modules/vendor/submodule\n'
          )
        )
        .mockResolvedValueOnce(output('/workspace/my-repo/.git\n/workspace/my-repo/.git\n'));

      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        )
      ).rejects.toThrow(/not a git-worktree reference/);
    });

    test('resolves for a matching linked submodule worktree pointer', async () => {
      const commonGitDir = join(testDir, 'super', '.git', 'modules', 'vendor', 'module');
      const linkedGitDir = join(commonGitDir, 'worktrees', 'linked');
      const primaryCheckout = resolve(commonGitDir, '../../../../vendor/module');
      await realMkdir(linkedGitDir, { recursive: true });
      await writeFile(join(linkedGitDir, 'commondir'), '../..\n');
      await writeFile(join(testDir, '.git'), `gitdir: ${linkedGitDir}\n`);
      execSpy
        .mockResolvedValueOnce(output(`${linkedGitDir}\n${commonGitDir}\n`))
        .mockResolvedValueOnce(output(`${commonGitDir}\n${commonGitDir}\n`));

      await expect(
        git.verifyWorktreeOwnership(git.toWorktreePath(testDir), git.toRepoPath(primaryCheckout))
      ).resolves.toBeUndefined();
    });

    test('resolves for a linked worktree backed by an external Git directory', async () => {
      const commonGitDir = join(testDir, 'metadata');
      const linkedGitDir = join(commonGitDir, 'worktrees', 'linked');
      await writeFile(join(testDir, '.git'), `gitdir: ${linkedGitDir}\n`);
      execSpy
        .mockResolvedValueOnce(output(`${linkedGitDir}\n${commonGitDir}\n`))
        .mockResolvedValueOnce(output(`${commonGitDir}\n${commonGitDir}\n`));
      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath(join(testDir, 'primary'))
        )
      ).resolves.toBeUndefined();
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
      await expect(
        git.verifyWorktreeOwnership(
          git.toWorktreePath(testDir),
          git.toRepoPath('/workspace/my-repo')
        )
      ).rejects.toMatchObject({ cause: { code: 'ENOENT' } });
    });
  });
});

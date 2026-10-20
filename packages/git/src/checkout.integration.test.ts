import { trackTempRoots } from '@archon/paths/test-utils';
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type * as Git from './index';
import { branch, git, repo } from './test-fixtures/git-harness';

const trackTempRoot = trackTempRoots();

describe('git utilities', () => {
  describe('checkout with real Git refs', () => {
    let root: Git.RepoPath;
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
});

import { trackTempRoots } from '@archon/paths/test-utils';
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir as realMkdir, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { saveEnvironment } from './test-fixtures/environment';
import { branch, git, repo, worktree } from './test-fixtures/git-harness';

const trackTempRoot = trackTempRoots();

describe('git utilities', () => {
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
      const restoreEnvironment = saveEnvironment('GIT_CEILING_DIRECTORIES');
      process.env.GIT_CEILING_DIRECTORIES = ceiling;
      try {
        expect(await git.findRepoRoot(start)).toBeNull();
      } finally {
        restoreEnvironment();
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
      const restoreEnvironment = saveEnvironment('GIT_CONFIG_GLOBAL');
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
        restoreEnvironment();
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
});

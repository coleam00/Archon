import { describe, test, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';

// Mock @archon/paths so nothing in this file touches the real filesystem/home dir.
mock.module('@archon/paths', () => ({
  createLogger: () => ({
    fatal: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => undefined,
  }),
}));

import * as git from '@archon/git';
import { toRepoPath, toBranchName, toWorktreePath } from '@archon/git';
import { GitWorktreeEngine } from './git-engine';

describe('GitWorktreeEngine', () => {
  let engine: GitWorktreeEngine;
  let execSpy: Mock<typeof git.execFileAsync>;
  let listWorktreesSpy: Mock<typeof git.listWorktrees>;

  beforeEach(() => {
    engine = new GitWorktreeEngine();
    execSpy = spyOn(git, 'execFileAsync');
    listWorktreesSpy = spyOn(git, 'listWorktrees');
    execSpy.mockResolvedValue({ stdout: '', stderr: '' });
    listWorktreesSpy.mockResolvedValue([]);
  });

  afterEach(() => {
    execSpy.mockRestore();
    listWorktreesSpy.mockRestore();
  });

  test('id is git', () => {
    expect(engine.id).toBe('git');
  });

  describe('add', () => {
    test('new branch without tracking issues --no-track add -b', async () => {
      await engine.add({
        repoPath: toRepoPath('/repo'),
        worktreePath: toWorktreePath('/repo/wt'),
        branch: toBranchName('archon/task-x'),
        startPoint: 'origin/main',
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        [
          '-C',
          '/repo',
          'worktree',
          'add',
          '--no-track',
          '/repo/wt',
          '-b',
          'archon/task-x',
          'origin/main',
        ],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    test('new branch with tracking (same-repo PR) issues add -b without --no-track', async () => {
      await engine.add({
        repoPath: toRepoPath('/repo'),
        worktreePath: toWorktreePath('/repo/wt'),
        branch: toBranchName('feature/pr-branch'),
        startPoint: 'origin/feature/pr-branch',
        track: true,
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        [
          '-C',
          '/repo',
          'worktree',
          'add',
          '/repo/wt',
          '-b',
          'feature/pr-branch',
          'origin/feature/pr-branch',
        ],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    test('no start point checks out an existing local branch', async () => {
      await engine.add({
        repoPath: toRepoPath('/repo'),
        worktreePath: toWorktreePath('/repo/wt'),
        branch: toBranchName('existing-branch'),
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/repo', 'worktree', 'add', '/repo/wt', 'existing-branch'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    test('propagates subprocess errors unchanged', async () => {
      const err = Object.assign(new Error('already exists'), { stderr: 'fatal: already exists' });
      execSpy.mockRejectedValueOnce(err);

      await expect(
        engine.add({
          repoPath: toRepoPath('/repo'),
          worktreePath: toWorktreePath('/repo/wt'),
          branch: toBranchName('archon/task-x'),
          startPoint: 'origin/main',
        })
      ).rejects.toBe(err);
    });
  });

  describe('remove', () => {
    test('issues worktree remove without --force by default', async () => {
      await engine.remove({
        repoPath: toRepoPath('/repo'),
        worktreePath: toWorktreePath('/repo/wt'),
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/repo', 'worktree', 'remove', '/repo/wt'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });

    test('force: true adds --force', async () => {
      await engine.remove({
        repoPath: toRepoPath('/repo'),
        worktreePath: toWorktreePath('/repo/wt'),
        force: true,
      });

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/repo', 'worktree', 'remove', '--force', '/repo/wt'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });
  });

  describe('list', () => {
    test('delegates to the shared listWorktrees helper', async () => {
      const expected = [{ path: toWorktreePath('/repo/wt'), branch: toBranchName('main') }];
      listWorktreesSpy.mockResolvedValueOnce(expected);

      const result = await engine.list(toRepoPath('/repo'));

      expect(listWorktreesSpy).toHaveBeenCalledWith('/repo');
      expect(result).toBe(expected);
    });
  });

  describe('prune', () => {
    test('issues git worktree prune', async () => {
      await engine.prune(toRepoPath('/repo'));

      expect(execSpy).toHaveBeenCalledWith(
        'git',
        ['-C', '/repo', 'worktree', 'prune'],
        expect.objectContaining({ timeout: expect.any(Number) })
      );
    });
  });
});

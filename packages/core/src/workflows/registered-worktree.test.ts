// @archon-test-isolated
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toBranchName, toRepoPath } from '@archon/git';
import {
  configureIsolation,
  getIsolationProvider,
  type TaskIsolationRequest,
} from '@archon/isolation';
import { trackTempRoots } from '@archon/paths/test-utils';
import { createRegisteredWorktree } from './registered-worktree';

const track = trackTempRoots();

for (const provenance of ['new-branch', 'existing-branch', 'adopted'] as const) {
  test(`registration failure preserves the real ${provenance} checkout and recovery evidence`, async () => {
    const root = await realpath(track(await mkdtemp(join(tmpdir(), 'registration-failure-'))));
    const repo = join(root, 'repo');
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '--bare', '-b', 'dev', join(root, 'remote.git'));
    git('init', '-q', '-b', 'dev', repo);
    const inRepo = (...args: string[]) => git('-C', repo, ...args);
    inRepo('config', 'user.email', 'test@example.com');
    inRepo('config', 'user.name', 'Test');
    await writeFile(join(repo, 'tracked.txt'), 'base');
    inRepo('add', 'tracked.txt');
    inRepo('commit', '-q', '-m', 'base');
    inRepo('remote', 'add', 'origin', join(root, 'remote.git'));
    inRepo('push', '-q', 'origin', 'dev');
    configureIsolation(async () => ({ path: '.worktrees', baseBranch: 'dev' }));
    const request: TaskIsolationRequest = {
      workflowType: 'task',
      identifier: 'task',
      codebaseId: 'codebase-1',
      canonicalRepoPath: toRepoPath(repo),
      taskBranch:
        provenance === 'existing-branch'
          ? { kind: 'existing', branch: toBranchName('task') }
          : { kind: 'new', branch: toBranchName('task') },
    };
    if (provenance === 'existing-branch') inRepo('branch', 'task');
    const checkout = join(repo, '.worktrees', 'task');
    const sentinel = join(checkout, 'user-work.txt');
    if (provenance === 'adopted') {
      await getIsolationProvider().create(request);
      await writeFile(sentinel, 'uncommitted user work');
    }
    const original = new Error('store unavailable');
    const error = await createRegisteredWorktree(
      {
        create: async () => {
          if (provenance !== 'adopted') await writeFile(sentinel, 'uncommitted user work');
          throw original;
        },
      },
      { request, createdByPlatform: 'cli' }
    ).then(
      () => {
        throw new Error('registration must fail');
      },
      (error: unknown) => error
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw error;
    expect(error.cause).toBe(original);
    expect(error.message).toContain('store unavailable');
    expect(error.message).toContain(checkout);
    expect(error.message).toContain(repo);
    expect(error.message).toContain('branch: task');
    expect(error.message).toContain('unregistered');
    if (provenance !== 'new-branch') {
      expect(error.message).toContain('adopted');
      expect(error.message).not.toContain('creation ID');
    } else {
      expect(error.message).toContain('created');
      expect(error.message).toContain('creation ID:');
      expect(error.message).toContain('branch created: true');
    }
    expect(inRepo('worktree', 'list', '--porcelain')).toContain(`worktree ${checkout}`);
    expect(git('-C', checkout, 'rev-parse', '--show-toplevel')).toBe(checkout);
    expect(await readFile(sentinel, 'utf8')).toBe('uncommitted user work');
  });
}

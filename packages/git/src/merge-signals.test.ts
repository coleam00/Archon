/**
 * The merge signals against real git.
 *
 * `isBranchMerged` and `isPatchEquivalent` are what cleanup asks before reclaiming a
 * worktree, and both answers depend on git behavior no mock can assert: a squash merge
 * of more than one commit looks unmerged to both, and `git cherry` refuses a branch ref
 * that no longer exists. Cleanup's decision order is built on those two facts (#3471).
 */
import { describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';

// Silence the expected-failure log line; this file runs git for real, in its own
// process group (see `testGroups`), so nothing else observes this mock.
const silentLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(() => silentLogger),
};
mock.module('@archon/paths', () => ({ createLogger: mock(() => silentLogger) }));

import { isBranchMerged, isCommitAncestor, isPatchEquivalent, localBranchExists } from './branch';
import { toBranchName, toRepoPath } from './types';

const trackTempRoot = trackTempRoots();

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.email=t@e.com', '-c', 'user.name=T', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function commit(repo: string, name: string, body: string): void {
  writeFileSync(join(repo, name), body);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', `add ${name}`);
}

/** A fresh repo on `main` with one commit. */
function repoOnMain(): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'merge-signals-')));
  const repo = join(root, 'repo');
  git(root, 'init', '-q', '-b', 'main', repo);
  commit(repo, 'base.txt', 'base\n');
  return repo;
}

/** `repoOnMain` plus a two-commit `feature` branch squash-merged into `main`. */
function repoWithSquashMergedFeature(): string {
  const repo = repoOnMain();
  git(repo, 'checkout', '-q', '-b', 'feature');
  commit(repo, 'one.txt', 'one\n');
  commit(repo, 'two.txt', 'two\n');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--squash', 'feature');
  git(repo, 'commit', '-q', '-m', 'squash feature (#1)');
  return repo;
}

describe('merge signals against real git', () => {
  test('a multi-commit squash merge is invisible to both git signals', async () => {
    const repo = toRepoPath(repoWithSquashMergedFeature());
    const feature = toBranchName('feature');
    const main = toBranchName('main');

    expect(await isBranchMerged(repo, feature, main)).toBe(false);
    expect(await isPatchEquivalent(repo, feature, main)).toBe(false);
  });

  test('isPatchEquivalent fails outright once the local branch ref is gone', async () => {
    const repoPath = repoWithSquashMergedFeature();
    git(repoPath, 'branch', '-D', 'feature');
    const repo = toRepoPath(repoPath);
    const feature = toBranchName('feature');
    const main = toBranchName('main');

    expect(await localBranchExists(repo, feature)).toBe(false);
    // The failure cleanup used to report as an unresolvable "merge check failed".
    await expect(isPatchEquivalent(repo, feature, main)).rejects.toThrow('unknown commit');
    // `git branch --merged` lists refs rather than resolving one, so it stays silent.
    expect(await isBranchMerged(repo, feature, main)).toBe(false);
  });

  test('a fast-forward merge is visible to git ancestry', async () => {
    const repo = toRepoPath(repoOnMain());
    git(repo, 'checkout', '-q', '-b', 'ff-feature');
    commit(repo, 'three.txt', 'three\n');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--ff-only', 'ff-feature');

    expect(await isBranchMerged(repo, toBranchName('ff-feature'), toBranchName('main'))).toBe(true);
  });

  // Cleanup trusts a merged PR only for the commits it carried: the local branch tip
  // must be the PR head or behind it.
  test('isCommitAncestor tells a branch at its merged PR head from one past it', async () => {
    const repoPath = repoWithSquashMergedFeature();
    const repo = toRepoPath(repoPath);
    const prHead = git(repoPath, 'rev-parse', 'feature');

    expect(await isCommitAncestor(repo, 'refs/heads/feature', prHead)).toBe(true);

    // The branch name is reused and gains work the merged PR never saw.
    git(repoPath, 'checkout', '-q', 'feature');
    commit(repoPath, 'later.txt', 'later\n');
    expect(await isCommitAncestor(repo, 'refs/heads/feature', prHead)).toBe(false);
  });

  test('isCommitAncestor throws when the PR head commit is not in the repository', async () => {
    const repo = toRepoPath(repoWithSquashMergedFeature());
    const unfetched = '0123456789abcdef0123456789abcdef01234567';

    await expect(isCommitAncestor(repo, 'refs/heads/feature', unfetched)).rejects.toThrow(
      'Failed to check whether'
    );
  });
});

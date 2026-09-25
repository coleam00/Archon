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

import { isBranchMerged, isRevCoveredBy, isPatchEquivalent, localBranchExists } from './branch';
import { toBranchName, toRepoPath, toWorktreePath } from './types';

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

  // Once git proves the branch merged, cleanup asks `git cherry <base> HEAD` in the
  // worktree: HEAD at the merged tip passes, and a detached commit past it does not.
  test('isPatchEquivalent judges a worktree HEAD the same way as the merged branch', async () => {
    const repoPath = repoWithSquashMergedFeature();
    const worktree = join(repoPath, '..', 'wt-head');
    git(repoPath, 'worktree', 'add', '-q', '--detach', worktree, 'main');
    const wt = toWorktreePath(worktree);
    const main = toBranchName('main');

    expect(await isPatchEquivalent(wt, 'HEAD', main, { throwOnExpectedError: true })).toBe(true);

    commit(worktree, 'detached.txt', 'detached\n');
    expect(await isPatchEquivalent(wt, 'HEAD', main, { throwOnExpectedError: true })).toBe(false);
  });

  // Cleanup trusts a merged PR only for the commits it carried: the local branch tip
  // must be the PR head or behind it.
  test('isRevCoveredBy tells a branch at its merged PR head from one past it', async () => {
    const repoPath = repoWithSquashMergedFeature();
    const repo = toRepoPath(repoPath);
    const prHead = git(repoPath, 'rev-parse', 'feature');

    expect(await isRevCoveredBy(repo, 'refs/heads/feature', prHead, 'origin')).toBe(true);

    // The branch name is reused and gains work the merged PR never saw.
    git(repoPath, 'checkout', '-q', 'feature');
    commit(repoPath, 'later.txt', 'later\n');
    expect(await isRevCoveredBy(repo, 'refs/heads/feature', prHead, 'origin')).toBe(false);
  });

  // With the branch ref gone, a worktree's HEAD is the only local tip left, and a
  // detached HEAD can hold committed work no ref points at.
  test('isRevCoveredBy reads a worktree HEAD past the PR head after the branch ref is gone', async () => {
    const repoPath = repoWithSquashMergedFeature();
    const prHead = git(repoPath, 'rev-parse', 'feature');
    const worktree = join(repoPath, '..', 'wt');
    git(repoPath, 'worktree', 'add', '-q', '--detach', worktree, 'feature');
    commit(worktree, 'detached.txt', 'detached\n');
    git(repoPath, 'branch', '-D', 'feature');

    expect(await isRevCoveredBy(toWorktreePath(worktree), 'HEAD', prHead, 'origin')).toBe(false);
  });

  // A bot or a maintainer pushed the last PR commit from another checkout, so the
  // PR head exists only on the remote until it is fetched.
  test('isRevCoveredBy fetches a PR head that exists only on the remote', async () => {
    const { local, elsewhere } = cloneWithRemoteFeature();
    commit(elsewhere, 'bot-fix.txt', 'fix\n');
    git(elsewhere, 'push', '-q', 'origin', 'feature');
    const prHead = git(elsewhere, 'rev-parse', 'HEAD');
    expect(() => git(local, 'cat-file', '-e', `${prHead}^{commit}`)).toThrow();

    const covered = await isRevCoveredBy(toRepoPath(local), 'refs/heads/feature', prHead, 'origin');

    expect(covered).toBe(true);
  });

  test('isRevCoveredBy throws with the fetch failure when the remote lacks the PR head', async () => {
    const { local } = cloneWithRemoteFeature();
    const unknown = '0123456789abcdef0123456789abcdef01234567';

    await expect(
      isRevCoveredBy(toRepoPath(local), 'refs/heads/feature', unknown, 'origin')
    ).rejects.toThrow(`Failed to fetch PR head ${unknown} from origin`);
  });
});

/**
 * A bare remote with a pushed `feature` branch, a `local` clone that has it checked
 * out, and a second clone (`elsewhere`) on the same branch that can push past it.
 */
function cloneWithRemoteFeature(): { local: string; elsewhere: string } {
  const seed = repoOnMain();
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'merge-signals-remote-')));
  const remote = join(root, 'remote.git');
  git(root, 'clone', '-q', '--bare', seed, remote);
  const local = join(root, 'local');
  git(root, 'clone', '-q', remote, local);
  git(local, 'checkout', '-q', '-b', 'feature');
  commit(local, 'one.txt', 'one\n');
  git(local, 'push', '-q', 'origin', 'feature');
  const elsewhere = join(root, 'elsewhere');
  git(root, 'clone', '-q', '-b', 'feature', remote, elsewhere);
  return { local, elsewhere };
}

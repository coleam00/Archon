/**
 * PR state lookup via the `gh` CLI.
 *
 * Used by cleanup to detect squash-merged or closed PRs that git ancestry
 * checks miss. The `gh` CLI is a soft dependency — if it's missing or fails,
 * we return 'NONE' and let callers fall back to git-only signals.
 */
import { execFileAsync } from '@archon/git';
import type { BranchName, RepoPath } from '@archon/git';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('isolation');
  return cachedLog;
}

export type PrState = 'MERGED' | 'CLOSED' | 'OPEN' | 'NONE';

/**
 * A PR found for a branch carries the commit it was opened (and, if merged,
 * merged) at. The branch name alone is not an identity: run branch names are
 * derived from the run identifier and get reused, so a caller deciding anything
 * destructive must check the local branch against `headSha`.
 */
export type PrLookup = { state: 'NONE' } | { state: Exclude<PrState, 'NONE'>; headSha: string };

const NO_PR: PrLookup = { state: 'NONE' };

/**
 * Look up the most recent PR for a branch in the GitHub remote.
 *
 * Returns:
 *   - MERGED / CLOSED / OPEN with the PR's head commit if a PR exists with that head branch
 *   - NONE if no PR exists, gh is unavailable, or the remote is not GitHub
 *
 * The optional `cache` map dedupes lookups within a single cleanup invocation.
 * The optional `remote` selects which git remote to inspect (default: 'origin').
 */
export async function getPrState(
  branch: BranchName,
  repoPath: RepoPath,
  cache?: Map<string, PrLookup>,
  remote = 'origin'
): Promise<PrLookup> {
  // Keyed by repository as well as branch: the same branch name in two repositories
  // is two different PRs, and the scheduled cleanup sweep spans every registered repo.
  const cacheKey = `${repoPath}\u0000${branch}`;
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Check whether the remote is on GitHub. Non-GitHub remotes are out of scope.
  let remoteUrl = '';
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', remote], {
      timeout: 10000,
    });
    remoteUrl = stdout.trim();
  } catch (error) {
    getLog().debug(
      { err: error as Error, repoPath, branch },
      'isolation.pr_state_remote_lookup_failed'
    );
    cache?.set(cacheKey, NO_PR);
    return NO_PR;
  }

  if (!remoteUrl.toLowerCase().includes('github.com')) {
    getLog().debug({ repoPath, branch, remoteUrl }, 'isolation.pr_state_github_only');
    cache?.set(cacheKey, NO_PR);
    return NO_PR;
  }

  let result: PrLookup = NO_PR;
  let ghStdout = '';
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'state,headRefOid',
        '--limit',
        '1',
      ],
      { timeout: 15000, cwd: repoPath }
    );
    ghStdout = stdout;
    const parsed = JSON.parse(stdout) as { state?: string; headRefOid?: string }[];
    const state = parsed[0]?.state;
    const headSha = parsed[0]?.headRefOid;
    if ((state === 'MERGED' || state === 'CLOSED' || state === 'OPEN') && headSha) {
      result = { state, headSha };
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const isNotInstalled = err.code === 'ENOENT' || err.message.includes('command not found');
    if (isNotInstalled) {
      getLog().debug({ branch, repoPath }, 'isolation.pr_state_gh_not_installed');
    } else {
      getLog().warn(
        { err, branch, repoPath, ghStdout: ghStdout || undefined },
        'isolation.pr_state_lookup_failed'
      );
    }
  }

  cache?.set(cacheKey, result);
  return result;
}

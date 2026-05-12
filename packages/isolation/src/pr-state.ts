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
 * Look up the PR state for a branch in the GitHub remote.
 *
 * Returns:
 *   - 'MERGED' / 'CLOSED' / 'OPEN' if a PR exists with that head branch
 *   - 'NONE' if no PR exists, gh is unavailable, or the remote is not GitHub
 *
 * The optional `cache` map dedupes lookups within a single cleanup invocation.
 */
export async function getPrState(
  branch: BranchName,
  repoPath: RepoPath,
  cache?: Map<string, PrState>
): Promise<PrState> {
  const cached = cache?.get(branch);
  if (cached !== undefined) {
    return cached;
  }

  // Check whether the remote is on GitHub. Non-GitHub remotes are out of scope.
  let remoteUrl = '';
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      timeout: 10000,
    });
    remoteUrl = stdout.trim();
  } catch (error) {
    getLog().debug(
      { err: error as Error, repoPath, branch },
      'isolation.pr_state_remote_lookup_failed'
    );
    cache?.set(branch, 'NONE');
    return 'NONE';
  }

  if (!remoteUrl.toLowerCase().includes('github.com')) {
    getLog().debug({ repoPath, branch, remoteUrl }, 'isolation.pr_state_github_only');
    cache?.set(branch, 'NONE');
    return 'NONE';
  }

  let result: PrState = 'NONE';
  let ghStdout = '';
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state', '--limit', '1'],
      { timeout: 15000, cwd: repoPath }
    );
    ghStdout = stdout;
    const parsed = JSON.parse(stdout) as { state?: string }[];
    const state = parsed[0]?.state;
    if (state === 'MERGED' || state === 'CLOSED' || state === 'OPEN') {
      result = state;
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

  cache?.set(branch, result);
  return result;
}

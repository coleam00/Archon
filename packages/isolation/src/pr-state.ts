/**
 * PR / MR state lookup via forge CLI (`gh` for GitHub, `glab` for GitLab).
 *
 * Used by cleanup to detect squash-merged or closed PRs/MRs that git ancestry
 * checks miss. Both CLIs are soft dependencies — if missing or failing, we
 * return 'NONE' and let callers fall back to git-only signals.
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
 * Look up the PR/MR state for a branch in the remote forge.
 *
 * Detects GitHub vs GitLab from the remote URL and dispatches to the
 * appropriate CLI (gh / glab). Returns 'NONE' for unrecognized remotes,
 * missing CLI tools, or network/auth failures.
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

  let remoteUrl = '';
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      timeout: 10000,
    });
    remoteUrl = stdout.trim().toLowerCase();
  } catch (error) {
    getLog().debug(
      { err: error as Error, repoPath, branch },
      'isolation.pr_state_remote_lookup_failed'
    );
    cache?.set(branch, 'NONE');
    return 'NONE';
  }

  const isGitHub = remoteUrl.includes('github.com');
  const isGitLab = remoteUrl.includes('gitlab');

  if (!isGitHub && !isGitLab) {
    getLog().debug({ repoPath, branch, remoteUrl }, 'isolation.pr_state_forge_not_supported');
    cache?.set(branch, 'NONE');
    return 'NONE';
  }

  const result = isGitHub
    ? await queryGhPrState(branch, repoPath)
    : await queryGlabMrState(branch, repoPath);

  cache?.set(branch, result);
  return result;
}

async function queryGhPrState(branch: BranchName, repoPath: RepoPath): Promise<PrState> {
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
      return state;
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
  return 'NONE';
}

async function queryGlabMrState(branch: BranchName, repoPath: RepoPath): Promise<PrState> {
  let glabStdout = '';
  try {
    const { stdout } = await execFileAsync(
      'glab',
      [
        'mr',
        'list',
        '--source-branch',
        branch,
        '--state',
        'all',
        '--output',
        'json',
        '--limit',
        '1',
      ],
      { timeout: 15000, cwd: repoPath }
    );
    glabStdout = stdout;
    const parsed = JSON.parse(stdout) as { state?: string }[];
    const state = parsed[0]?.state;
    // glab uses lowercase state names: opened, merged, closed
    if (state === 'merged') return 'MERGED';
    if (state === 'closed') return 'CLOSED';
    if (state === 'opened') return 'OPEN';
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const isNotInstalled = err.code === 'ENOENT' || err.message.includes('command not found');
    if (isNotInstalled) {
      getLog().debug({ branch, repoPath }, 'isolation.pr_state_glab_not_installed');
    } else {
      getLog().warn(
        { err, branch, repoPath, glabStdout: glabStdout || undefined },
        'isolation.mr_state_lookup_failed'
      );
    }
  }
  return 'NONE';
}

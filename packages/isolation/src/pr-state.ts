/**
 * PR state lookup via forge CLI (currently GitHub `gh` only).
 *
 * Used by cleanup to detect squash-merged or closed PRs that git ancestry
 * checks miss. CLI dependency is soft — if unavailable or failing, we return
 * 'NONE' and let callers fall back to git-only signals.
 */
import { execFileAsync, resolveForgeContext, getRemoteUrl } from '@archon/git';
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
 * Look up PR state for a branch when the forge supports it.
 *
 * Returns:
 *   - 'MERGED' / 'CLOSED' / 'OPEN' if a PR exists with that head branch
 *   - 'NONE' if no PR exists, CLI is unavailable, or forge is unsupported
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
    remoteUrl = (await getRemoteUrl(repoPath)) ?? '';
  } catch (error) {
    getLog().debug(
      { err: error as Error, repoPath, branch },
      'isolation.pr_state_remote_lookup_failed'
    );
    cache?.set(branch, 'NONE');
    return 'NONE';
  }

  const forge = resolveForgeContext({ remoteUrl });
  if (forge.type !== 'github') {
    getLog().debug(
      { repoPath, branch, remoteUrl, forgeType: forge.type },
      'isolation.pr_state_forge_unsupported'
    );
    cache?.set(branch, 'NONE');
    return 'NONE';
  }

  const gh = forge.cli ?? 'gh';

  let result: PrState = 'NONE';
  let ghStdout = '';
  try {
    const { stdout } = await execFileAsync(
      gh,
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

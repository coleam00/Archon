import { createLogger } from '@archon/paths';
import { execFileAsync } from './exec';
import { getDefaultBranch } from './branch';
import type { RepoPath, BranchName, GitResult, WorkspaceSyncResult } from './types';
import { toRepoPath } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('git');
  return cachedLog;
}

/**
 * Find the root of the git repository containing the given path
 * Returns null if not in a git repository
 */
export async function findRepoRoot(startPath: string): Promise<RepoPath | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', startPath, 'rev-parse', '--show-toplevel'],
      { timeout: 10000 }
    );
    return toRepoPath(stdout.trim());
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: not a git repository
    if (errorText.includes('not a git repository') || errorText.includes('Not a git repository')) {
      return null;
    }

    // Unexpected error - surface it
    getLog().error({ startPath, err, stderr: err.stderr }, 'find_repo_root_failed');
    throw new Error(`Failed to find repo root for ${startPath}: ${err.message}`);
  }
}

/**
 * Get the remote URL for origin (if it exists)
 * Returns null if no remote is configured
 */
export async function getRemoteUrl(repoPath: RepoPath): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      timeout: 10000,
    });
    return stdout.trim() || null;
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: no remote named origin
    if (
      errorText.includes('No such remote') ||
      errorText.includes('does not have a url configured')
    ) {
      return null;
    }

    // Unexpected error - surface it
    getLog().error({ repoPath, err, stderr: err.stderr }, 'get_remote_url_failed');
    throw new Error(`Failed to get remote URL for ${repoPath}: ${err.message}`);
  }
}

/**
 * Sync workspace with remote origin.
 * Fetches the base branch from origin, then optionally hard-resets the working tree
 * to match `origin/<baseBranch>`.
 *
 * When `resetAfterFetch` is true (default), the working tree is hard-reset to match
 * the remote. This is safe for Archon-managed clones in `~/.archon/workspaces/` but
 * **destructive for user's local working directories** — callers must check the path
 * before enabling reset.
 *
 * When `resetAfterFetch` is false, only `git fetch` runs — the local working tree is
 * untouched. This is safe for locally-registered repos where the user may have
 * uncommitted changes.
 *
 * Branch resolution:
 * - If baseBranch is provided: Uses that branch (from config). Fails with actionable
 *   error if the branch doesn't exist - no silent fallback.
 * - If baseBranch is omitted: Auto-detects the default branch via git.
 *
 * @param workspacePath - Path to the workspace (canonical repo, not worktree)
 * @param baseBranch - Optional base branch name (e.g., 'main', 'develop'). If omitted, auto-detects default branch
 * @param options - Optional settings. `resetAfterFetch` (default true) controls whether `git reset --hard` runs after fetch.
 * @returns Branch used plus whether sync was performed
 * @throws Error with actionable message if configured branch doesn't exist
 */
export async function syncWorkspace(
  workspacePath: RepoPath,
  baseBranch?: BranchName,
  options?: { resetAfterFetch?: boolean }
): Promise<WorkspaceSyncResult> {
  const shouldReset = options?.resetAfterFetch ?? true;
  const branchToSync = baseBranch ?? (await getDefaultBranch(workspacePath));

  // Fetch from origin to ensure origin/<branchToSync> is up-to-date
  try {
    await execFileAsync('git', ['-C', workspacePath, 'fetch', 'origin', branchToSync], {
      timeout: 60000,
    });
  } catch (error) {
    const err = error as Error;
    const errorMessage = err.message.toLowerCase();

    // If configured branch doesn't exist on remote, provide actionable error
    if (
      baseBranch &&
      (errorMessage.includes("couldn't find remote ref") || errorMessage.includes('not found'))
    ) {
      throw new Error(
        `Configured base branch '${baseBranch}' not found on remote. ` +
          'Either create the branch, update worktree.baseBranch in .archon/config.yaml, ' +
          'or remove the setting to use the auto-detected default branch.'
      );
    }
    throw new Error(`Sync fetch from origin/${branchToSync} failed: ${err.message}`);
  }

  if (!shouldReset) {
    // Fetch-only mode: safe for locally-registered repos with uncommitted changes
    return { branch: branchToSync, synced: true, previousHead: '', newHead: '', updated: false };
  }

  // Capture HEAD before reset so we can report whether anything changed
  let previousHead = '';
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspacePath, 'rev-parse', '--short=8', 'HEAD'],
      { timeout: 10000 }
    );
    previousHead = stdout.trim();
  } catch {
    // Non-fatal — fresh clone or detached HEAD edge case
  }

  // Hard-reset local working tree to match origin — only safe for Archon-managed
  // clones, never for a user's local working directory.
  try {
    await execFileAsync('git', ['-C', workspacePath, 'reset', '--hard', `origin/${branchToSync}`], {
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Reset to origin/${branchToSync} failed: ${err.message}`);
  }

  let newHead = '';
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspacePath, 'rev-parse', '--short=8', 'HEAD'],
      { timeout: 10000 }
    );
    newHead = stdout.trim();
  } catch {
    // Non-fatal
  }

  return {
    branch: branchToSync,
    synced: true,
    previousHead,
    newHead,
    updated: previousHead !== newHead && previousHead !== '',
  };
}

/**
 * Clone a repository to a target path.
 * Uses execFileAsync (no shell interpolation) for safety.
 *
 * @param url - Repository URL (e.g., https://github.com/owner/repo.git)
 * @param targetPath - Local path to clone into
 * @param options - Optional: { token } for authenticated clones
 * @returns GitResult<void>
 */
export async function cloneRepository(
  url: string,
  targetPath: RepoPath,
  options?: { token?: string }
): Promise<GitResult<void>> {
  try {
    let cloneUrl = url;
    if (options?.token) {
      // Construct authenticated URL: https://<token>@github.com/owner/repo.git
      const parsed = new URL(url);
      parsed.username = options.token;
      cloneUrl = parsed.toString();
    }

    await execFileAsync('git', ['clone', cloneUrl, targetPath], { timeout: 120000 });
    return { ok: true, value: undefined };
  } catch (error) {
    const err = error as Error;
    // Sanitize any token from error messages to prevent credential leakage
    const sanitizedMessage = options?.token
      ? err.message.replaceAll(options.token, '***')
      : err.message;
    const message = sanitizedMessage.toLowerCase();

    if (message.includes('not found') || message.includes('404')) {
      return { ok: false, error: { code: 'not_a_repo', path: url } };
    }
    if (message.includes('authentication failed') || message.includes('could not read')) {
      return { ok: false, error: { code: 'permission_denied', path: url } };
    }
    if (message.includes('no space')) {
      return { ok: false, error: { code: 'no_space', path: targetPath } };
    }

    getLog().error({ url, targetPath, errorMessage: sanitizedMessage }, 'clone_repository_failed');
    return { ok: false, error: { code: 'unknown', message: sanitizedMessage } };
  }
}

/**
 * Sync a repository to match a remote branch.
 * Runs sequential fetch + reset --hard. If fetch fails, reset is skipped.
 * Uses execFileAsync (no shell interpolation) for safety.
 *
 * Note: Uses `cwd` option instead of `-C` flag. Both are functionally
 * equivalent; this style was chosen for readability with multi-arg commands.
 *
 * @param repoPath - Path to the local repository
 * @param branch - Branch to sync to (e.g., 'main')
 * @returns GitResult<void>
 */
export async function syncRepository(
  repoPath: RepoPath,
  branch: BranchName
): Promise<GitResult<void>> {
  try {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: repoPath, timeout: 60000 });
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`.toLowerCase();
    getLog().error({ err, repoPath, branch }, 'sync_repository_fetch_failed');

    if (errorText.includes('not a git repository')) {
      return { ok: false, error: { code: 'not_a_repo', path: repoPath } };
    }
    if (errorText.includes('authentication failed') || errorText.includes('could not read')) {
      return { ok: false, error: { code: 'permission_denied', path: repoPath } };
    }
    if (errorText.includes('no space')) {
      return { ok: false, error: { code: 'no_space', path: repoPath } };
    }
    return { ok: false, error: { code: 'unknown', message: `Fetch failed: ${err.message}` } };
  }

  try {
    await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], {
      cwd: repoPath,
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error;
    const message = err.message.toLowerCase();

    if (message.includes('unknown revision') || message.includes('not a valid object')) {
      return { ok: false, error: { code: 'branch_not_found', branch } };
    }

    getLog().error({ err, repoPath, branch }, 'sync_repository_reset_failed');
    return { ok: false, error: { code: 'unknown', message: `Reset failed: ${err.message}` } };
  }

  return { ok: true, value: undefined };
}

/**
 * Add a directory to git's global safe.directory config.
 * Uses execFileAsync (no shell interpolation) for safety.
 */
export async function addSafeDirectory(path: RepoPath): Promise<void> {
  try {
    await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', path], {
      timeout: 10000,
    });
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, path }, 'add_safe_directory_failed');
    throw new Error(`Failed to add safe directory '${path}': ${err.message}`);
  }
}

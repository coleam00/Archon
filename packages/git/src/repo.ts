import { createLogger } from '@archon/paths';
import { execFileAsync } from './exec';
import { getCurrentBranch, getDefaultBranch } from './branch';
import type { RepoPath, BranchName, GitResult, SyncMode, WorkspaceSyncResult } from './types';
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
 *
 * Always fetches `origin/<baseBranch>` (a non-destructive ref update). What
 * happens next depends on `mode`:
 *
 * - `mode: 'fast-forward'` (default): if HEAD is strictly behind origin and the
 *   working tree is clean, `git merge --ff-only` is applied. In every other
 *   case (in_sync / ahead / diverged / dirty) HEAD and working tree are left
 *   alone. **Cannot destroy local commits or uncommitted changes.** Suitable
 *   for any path where local work must be preserved (e.g. chat-tick refresh).
 *
 * - `mode: 'reset'`: `git reset --hard origin/<baseBranch>` runs after fetch.
 *   **Destructive** — discards uncommitted changes and pulls HEAD to origin
 *   even if local commits exist. Suitable only where a known-clean base state
 *   is required (e.g. immediately before creating a new worktree).
 *
 * Both modes return a `state` field describing the observed relationship of
 * HEAD to origin **before** the operation, plus `updated` indicating whether
 * HEAD moved as a result.
 *
 * Branch resolution:
 * - If baseBranch is provided: uses that branch. Fails with actionable error
 *   if the branch doesn't exist on origin — no silent fallback.
 * - If baseBranch is omitted: auto-detects the default branch via git.
 *
 * @param workspacePath - Path to the workspace (canonical repo, not worktree)
 * @param baseBranch - Optional base branch name. If omitted, auto-detects.
 * @param options - Optional. `mode` defaults to `'fast-forward'`.
 * @returns Branch, observed state, head SHAs before/after, and whether HEAD moved.
 * @throws Error if fetch fails, configured branch doesn't exist on remote, or
 *         a `'reset'`/ff-merge fails unexpectedly.
 */
export async function syncWorkspace(
  workspacePath: RepoPath,
  baseBranch?: BranchName,
  options?: { mode?: SyncMode }
): Promise<WorkspaceSyncResult> {
  const mode: SyncMode = options?.mode ?? 'fast-forward';
  const branchToSync = baseBranch ?? (await getDefaultBranch(workspacePath));

  // Fetch from origin to ensure origin/<branchToSync> is up-to-date.
  // This only updates refs/remotes/origin — never HEAD or working tree.
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
          'Either create the branch, update default_branch on the codebase, ' +
          'or remove the setting to use the auto-detected default branch.'
      );
    }
    throw new Error(`Sync fetch from origin/${branchToSync} failed: ${err.message}`);
  }

  // Observe HEAD vs origin/<branchToSync>
  const previousHead = await readShortSha(workspacePath, 'HEAD');
  const originSha = await readShortSha(workspacePath, `origin/${branchToSync}`);
  const dirty = await isDirty(workspacePath);

  // Compute state. `dirty` is reported as the dominant mode when present —
  // callers that need both ancestor info and dirty info can re-query the repo.
  let state: WorkspaceSyncResult['state'];
  if (dirty) {
    state = 'dirty';
  } else if (previousHead && originSha && previousHead === originSha) {
    state = 'in_sync';
  } else {
    const headAncestorOfOrigin = await isAncestor(workspacePath, 'HEAD', `origin/${branchToSync}`);
    const originAncestorOfHead = await isAncestor(workspacePath, `origin/${branchToSync}`, 'HEAD');
    if (headAncestorOfOrigin && !originAncestorOfHead) state = 'behind';
    else if (originAncestorOfHead && !headAncestorOfOrigin) state = 'ahead';
    else state = 'diverged';
  }

  if (mode === 'reset') {
    // Hard-reset working tree and HEAD to origin/<branch>. Destructive —
    // legitimate only for known-clean-base contexts (worktree creation).
    try {
      await execFileAsync(
        'git',
        ['-C', workspacePath, 'reset', '--hard', `origin/${branchToSync}`],
        { timeout: 30000 }
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Reset to origin/${branchToSync} failed: ${err.message}`);
    }
    const newHead = await readShortSha(workspacePath, 'HEAD');
    return {
      branch: branchToSync,
      synced: true,
      state,
      previousHead,
      newHead,
      updated: previousHead !== newHead && previousHead !== '',
    };
  }

  // mode === 'fast-forward': only safe if behind, tree clean, AND HEAD is on
  // the target branch. Without the branch check, a topic branch that happens
  // to be an ancestor of `origin/<branchToSync>` would silently advance to
  // origin's tip — violating the "non-default branches are preserved" guarantee.
  if (state === 'behind') {
    let currentBranch: string | undefined;
    try {
      currentBranch = await getCurrentBranch(workspacePath);
    } catch {
      // Detached HEAD or unreadable — treat as "not on target branch", noop.
    }

    if (currentBranch !== branchToSync) {
      // HEAD is on a different branch (or detached). Skip the merge to
      // preserve user state; the agent still sees fresh remote refs via fetch.
      return {
        branch: branchToSync,
        synced: true,
        state,
        previousHead,
        newHead: previousHead,
        updated: false,
      };
    }

    try {
      await execFileAsync(
        'git',
        ['-C', workspacePath, 'merge', '--ff-only', `origin/${branchToSync}`],
        { timeout: 30000 }
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Fast-forward merge to origin/${branchToSync} failed: ${err.message}`);
    }
    const newHead = await readShortSha(workspacePath, 'HEAD');
    return {
      branch: branchToSync,
      synced: true,
      state,
      previousHead,
      newHead,
      updated: previousHead !== newHead && previousHead !== '',
    };
  }

  // No-op for in_sync, ahead, diverged, dirty — local state preserved.
  return {
    branch: branchToSync,
    synced: true,
    state,
    previousHead,
    newHead: previousHead,
    updated: false,
  };
}

/** Read short HEAD SHA, return '' on failure (fresh-clone / detached-HEAD edge cases) */
async function readShortSha(workspacePath: RepoPath, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspacePath, 'rev-parse', '--short=8', ref],
      { timeout: 10000 }
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Working tree has uncommitted modifications */
async function isDirty(workspacePath: RepoPath): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'status', '--porcelain'], {
      timeout: 10000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Ancestor check via `git merge-base --is-ancestor` (true if `ancestor` is reachable from `descendant`) */
async function isAncestor(
  workspacePath: RepoPath,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      ['-C', workspacePath, 'merge-base', '--is-ancestor', ancestor, descendant],
      { timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
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

import { createLogger } from '@archon/paths';
import { execFileAsync } from './exec';
import { getCurrentBranch, getDefaultBranch, hasUncommittedChanges } from './branch';
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
 * Sync a workspace with `origin/<baseBranch>`.
 *
 * Two modes:
 *
 * - `'fast-forward'` (default, **non-destructive**) — `git fetch`, inspect state,
 *   and only advance HEAD when it is strictly behind on the target branch with a
 *   clean working tree. Local commits (`ahead`), divergent histories (`diverged`),
 *   and uncommitted edits (`dirty`) are preserved untouched. Safe to call on every
 *   chat tick while the AI may be actively writing to the workspace.
 *
 * - `'reset'` (**destructive**) — `git fetch` followed by `git reset --hard
 *   origin/<baseBranch>`. Overwrites the working tree to mirror the remote. Only
 *   appropriate when the caller guarantees the workspace is a passive mirror —
 *   today this is the preparatory step before creating a new worktree.
 *
 * Branch resolution:
 * - If `baseBranch` is provided: Uses that branch (from config). Fails with an
 *   actionable error if the branch doesn't exist on the remote — no silent fallback.
 * - If `baseBranch` is omitted: Auto-detects the default branch via git.
 *
 * @param workspacePath - Path to the workspace (canonical repo, not worktree)
 * @param baseBranch    - Optional base branch (e.g., 'main'). Auto-detected when omitted.
 * @param options.mode  - `'fast-forward'` (default) | `'reset'`.
 * @returns Branch used plus the observed state and HEAD movement.
 * @throws Error with actionable message if the configured branch doesn't exist.
 */
export async function syncWorkspace(
  workspacePath: RepoPath,
  baseBranch?: BranchName,
  options?: { mode?: 'fast-forward' | 'reset' }
): Promise<WorkspaceSyncResult> {
  const mode = options?.mode ?? 'fast-forward';
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

  if (mode === 'reset') {
    return syncWorkspaceReset(workspacePath, branchToSync);
  }

  return syncWorkspaceFastForward(workspacePath, branchToSync);
}

/**
 * Hard-reset path (legacy `resetAfterFetch: true` behavior).
 * Only called from `mode: 'reset'`. Overwrites any local state.
 */
async function syncWorkspaceReset(
  workspacePath: RepoPath,
  branchToSync: BranchName
): Promise<WorkspaceSyncResult> {
  const previousHead = await readShortHead(workspacePath);

  try {
    await execFileAsync('git', ['-C', workspacePath, 'reset', '--hard', `origin/${branchToSync}`], {
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Reset to origin/${branchToSync} failed: ${err.message}`);
  }

  const newHead = await readShortHead(workspacePath);

  return {
    branch: branchToSync,
    synced: true,
    previousHead,
    newHead,
    updated: previousHead !== newHead && previousHead !== '',
  };
}

/**
 * Non-destructive path. Inspect state, only advance HEAD via `git merge --ff-only`
 * when strictly behind on the target branch and the working tree is clean.
 */
async function syncWorkspaceFastForward(
  workspacePath: RepoPath,
  branchToSync: BranchName
): Promise<WorkspaceSyncResult> {
  const previousHead = await readShortHead(workspacePath);

  // Any uncommitted edit — including untracked files — blocks ff-merge. Conservative
  // but safe: better to leave the tree alone than to surprise the user.
  if (await hasUncommittedChanges(workspacePath)) {
    return {
      branch: branchToSync,
      synced: true,
      previousHead,
      newHead: previousHead,
      updated: false,
      state: 'dirty',
    };
  }

  const local = await revParse(workspacePath, 'HEAD');
  const remote = await revParse(workspacePath, `origin/${branchToSync}`);
  if (!local || !remote) {
    // Either HEAD or origin/<branch> couldn't be resolved (fresh clone, detached
    // HEAD, etc.). Don't move anything — preserve current state.
    getLog().debug(
      { workspacePath, local, remote, branchToSync },
      'sync_workspace_rev_parse_inconclusive_skipping_merge'
    );
    return {
      branch: branchToSync,
      synced: true,
      previousHead,
      newHead: previousHead,
      updated: false,
      state: 'in_sync',
    };
  }

  if (local === remote) {
    return {
      branch: branchToSync,
      synced: true,
      previousHead,
      newHead: previousHead,
      updated: false,
      state: 'in_sync',
    };
  }

  const mergeBase = await mergeBaseOrNull(workspacePath, local, remote);
  if (mergeBase === null) {
    // No common ancestor → treat as diverged (shouldn't normally happen).
    return {
      branch: branchToSync,
      synced: true,
      previousHead,
      newHead: previousHead,
      updated: false,
      state: 'diverged',
    };
  }

  if (mergeBase === remote) {
    // Local has commits not on remote — preserve them.
    return {
      branch: branchToSync,
      synced: true,
      previousHead,
      newHead: previousHead,
      updated: false,
      state: 'ahead',
    };
  }

  if (mergeBase === local) {
    // Strictly behind. Only advance HEAD if we're on the target branch — moving
    // HEAD from some other branch to origin/<branchToSync> would silently switch
    // branches.
    const currentBranch = await getCurrentBranch(workspacePath);
    if (currentBranch !== branchToSync) {
      return {
        branch: branchToSync,
        synced: true,
        previousHead,
        newHead: previousHead,
        updated: false,
        state: 'behind',
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
      // ff-only failed unexpectedly — report state but don't throw; we've already
      // proven we're not destructive and the caller can retry later.
      getLog().warn(
        { workspacePath, branchToSync, err },
        'sync_workspace_fast_forward_merge_failed'
      );
      return {
        branch: branchToSync,
        synced: true,
        previousHead,
        newHead: previousHead,
        updated: false,
        state: 'behind',
      };
    }
    const newHead = await readShortHead(workspacePath);
    const advanced = previousHead !== newHead && previousHead !== '';
    return {
      branch: branchToSync,
      synced: true,
      previousHead,
      newHead,
      updated: advanced,
      // After a successful ff-merge HEAD advanced → we are now in_sync.
      // If merge was a no-op (shouldn't happen here), remain 'behind'.
      state: advanced ? 'in_sync' : 'behind',
    };
  }

  // Local and remote each have commits the other doesn't.
  return {
    branch: branchToSync,
    synced: true,
    previousHead,
    newHead: previousHead,
    updated: false,
    state: 'diverged',
  };
}

/** Read short HEAD; returns empty string on error (fresh clone, detached HEAD). */
async function readShortHead(workspacePath: RepoPath): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspacePath, 'rev-parse', '--short=8', 'HEAD'],
      { timeout: 10000 }
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Resolve a ref to its full SHA; returns null on error. */
async function revParse(workspacePath: RepoPath, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'rev-parse', ref], {
      timeout: 10000,
    });
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/** Resolve the merge-base of two commits; returns null on error. */
async function mergeBaseOrNull(
  workspacePath: RepoPath,
  a: string,
  b: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'merge-base', a, b], {
      timeout: 10000,
    });
    const sha = stdout.trim();
    return sha || null;
  } catch {
    return null;
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

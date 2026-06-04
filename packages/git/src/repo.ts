import { createLogger } from '@archon/paths';
import { execFileAsync } from './exec';
import { getDefaultBranch } from './branch';
import type {
  RepoPath,
  BranchName,
  GitResult,
  WorkspaceSyncResult,
  WorkspaceSyncMode,
  WorkspaceSyncState,
} from './types';
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
 * Fetches the base branch from origin, then updates local state according to mode.
 *
 * Modes:
 * - fast-forward (default): fetch, classify state, and fast-forward only when safe.
 * - fetch-only: fetch and classify without touching the working tree.
 * - reset: fetch and hard-reset to origin/<branch>. This is destructive and must be
 *   requested explicitly by callers that own the checkout.
 *
 * Branch resolution:
 * - If baseBranch is provided: Uses that branch (from config). Fails with actionable
 *   error if the branch doesn't exist - no silent fallback.
 * - If baseBranch is omitted: Auto-detects the default branch via git.
 *
 * @param workspacePath - Path to the workspace (canonical repo, not worktree)
 * @param baseBranch - Optional base branch name (e.g., 'main', 'develop'). If omitted, auto-detects default branch
 * @param options - Optional sync mode. Defaults to non-destructive fast-forward.
 * @returns Branch used plus whether sync was performed
 * @throws Error with actionable message if configured branch doesn't exist
 */
export async function syncWorkspace(
  workspacePath: RepoPath,
  baseBranch?: BranchName,
  options?: { mode?: WorkspaceSyncMode }
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

  const previousHead = await readShortSha(workspacePath, 'HEAD');

  if (mode !== 'reset') {
    const state = await classifyWorkspaceState(workspacePath, branchToSync);

    if (mode === 'fetch-only' || state !== 'behind') {
      return unchangedSyncResult(branchToSync, mode, state, previousHead);
    }

    const currentBranch = await getCurrentBranch(workspacePath);
    if (currentBranch !== branchToSync) {
      return unchangedSyncResult(branchToSync, mode, state, previousHead);
    }

    try {
      await execFileAsync(
        'git',
        ['-C', workspacePath, 'merge', '--ff-only', `origin/${branchToSync}`],
        {
          timeout: 30000,
        }
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Fast-forward to origin/${branchToSync} failed: ${err.message}`);
    }

    const newHead = await readShortSha(workspacePath, 'HEAD');
    return {
      branch: branchToSync,
      synced: true,
      mode,
      state: 'in_sync',
      previousHead,
      newHead,
      updated: previousHead !== newHead && previousHead !== '',
    };
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

  const newHead = await readShortSha(workspacePath, 'HEAD');

  return {
    branch: branchToSync,
    synced: true,
    mode,
    state: 'in_sync',
    previousHead,
    newHead,
    updated: previousHead !== newHead && previousHead !== '',
  };
}

function unchangedSyncResult(
  branch: BranchName,
  mode: WorkspaceSyncMode,
  state: WorkspaceSyncState,
  head: string
): WorkspaceSyncResult {
  return {
    branch,
    synced: true,
    mode,
    state,
    previousHead: head,
    newHead: head,
    updated: false,
  };
}

async function readShortSha(workspacePath: RepoPath, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspacePath, 'rev-parse', '--short=8', ref],
      { timeout: 10000 }
    );
    return stdout.trim();
  } catch (error) {
    getLog().warn({ err: error as Error, workspacePath, ref }, 'workspace.short_sha_read_failed');
    return '';
  }
}

async function readSha(workspacePath: RepoPath, ref: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', workspacePath, 'rev-parse', ref], {
    timeout: 10000,
  });
  return stdout.trim();
}

async function getCurrentBranch(workspacePath: RepoPath): Promise<BranchName | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 10000 }
    );
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? (branch as BranchName) : null;
  } catch {
    return null;
  }
}

async function hasTrackedModifications(workspacePath: RepoPath): Promise<boolean> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', workspacePath, 'status', '--porcelain', '--untracked-files=no'],
    { timeout: 10000 }
  );
  return stdout.trim().length > 0;
}

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
  } catch (error) {
    const err = error as Error & { code?: number | string; exitCode?: number; stderr?: string };
    const exitCode = err.exitCode ?? err.code;
    if (exitCode === 1 || exitCode === '1') {
      return false;
    }
    getLog().error(
      { err, workspacePath, ancestor, descendant, stderr: err.stderr },
      'workspace.merge_base_check_failed'
    );
    throw new Error(`Failed to compare git ancestry in ${workspacePath}: ${err.message}`);
  }
}

async function classifyWorkspaceState(
  workspacePath: RepoPath,
  branchToSync: BranchName
): Promise<WorkspaceSyncState> {
  if (await hasTrackedModifications(workspacePath)) {
    return 'dirty';
  }

  const localSha = await readSha(workspacePath, 'HEAD');
  const remoteRef = `origin/${branchToSync}`;
  const remoteSha = await readSha(workspacePath, remoteRef);

  if (localSha === remoteSha) {
    return 'in_sync';
  }
  if (await isAncestor(workspacePath, localSha, remoteSha)) {
    return 'behind';
  }
  if (await isAncestor(workspacePath, remoteSha, localSha)) {
    return 'ahead';
  }
  return 'diverged';
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

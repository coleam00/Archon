import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
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
 * List the immediate child directories of `rootPath` that are themselves git
 * repositories (contain a `.git` directory or file). One level only — no
 * recursion. Used to surface the contained repos of a folder project (a
 * multi-repo root). Returns the child names (basenames), sorted.
 *
 * Never throws: returns [] if `rootPath` can't be read (missing, not a
 * directory, permission denied) — the caller treats "no child repos" and
 * "unreadable root" identically.
 */
export async function listChildRepos(rootPath: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(rootPath);
  } catch (error) {
    // An unreadable/missing root is an anomaly for a registered folder project —
    // log at warn (not debug) so it's visible, then return [] (callers treat
    // "no child repos" and "unreadable root" the same, but the log distinguishes).
    getLog().warn({ rootPath, err: error as Error }, 'git.child_repos_read_failed');
    return [];
  }
  // existsSync follows symlinks and matches both a `.git` directory (normal
  // clone) and a `.git` file (worktree/submodule pointer).
  return names.filter(name => existsSync(join(rootPath, name, '.git'))).sort();
}

/**
 * Detect the default remote name for a repository.
 *
 * Resolution order:
 *   1. 'origin' — if it exists (standard Git convention)
 *   2. The sole remote — if only one is configured
 *   3. null — ambiguous (multiple non-origin remotes) or no remotes at all
 *
 * Callers can override via `worktree.remote` in `.archon/config.yaml`.
 * Git errors (not a repo, permission denied) propagate — a null return
 * always means "no unambiguous remote", never a swallowed failure.
 */
export async function getDefaultRemote(repoPath: RepoPath): Promise<string | null> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote'], { timeout: 10000 });
  // Split on LF or CRLF (Windows git) and trim each entry defensively
  const remotes = stdout
    .split(/\r?\n/)
    .map(r => r.trim())
    .filter(r => r.length > 0);
  if (remotes.length === 0) return null;
  if (remotes.includes('origin')) return 'origin';
  if (remotes.length === 1) return remotes[0];
  return null;
}

/**
 * Get the URL configured for a git remote (default: 'origin').
 * Returns null if the remote does not exist.
 */
export async function getRemoteUrl(repoPath: RepoPath, remote = 'origin'): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', remote], {
      timeout: 10000,
    });
    return stdout.trim() || null;
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Expected: no remote with that name
    if (
      errorText.includes('No such remote') ||
      errorText.includes('does not have a url configured')
    ) {
      return null;
    }

    // Unexpected error - surface it
    getLog().error({ repoPath, remote, err, stderr: err.stderr }, 'get_remote_url_failed');
    throw new Error(`Failed to get remote URL for ${repoPath} (remote: ${remote}): ${err.message}`);
  }
}

/**
 * Sync workspace with its remote.
 * Fetches the base branch from the remote, then updates local state according to mode.
 *
 * Modes:
 * - fast-forward (default): fetch, classify state, and fast-forward only when safe.
 * - fetch-only: fetch and classify without touching the working tree.
 * - reset: fetch and hard-reset to <remote>/<branch>. This is destructive and must be
 *   requested explicitly by callers that own the checkout.
 *
 * Branch resolution:
 * - If baseBranch is provided: Uses that branch (from config). Fails with actionable
 *   error if the branch doesn't exist - no silent fallback.
 * - If baseBranch is omitted: Auto-detects the default branch via git.
 *
 * @param workspacePath - Path to the workspace (canonical repo, not worktree)
 * @param baseBranch - Optional base branch name (e.g., 'main', 'develop'). If omitted, auto-detects default branch
 * @param options - Optional settings:
 *   - `mode`: sync mode. Defaults to non-destructive fast-forward.
 *   - `remote` (default 'origin'): git remote name to fetch from.
 * @returns Branch used plus whether sync was performed
 * @throws Error with actionable message if configured branch doesn't exist
 */
export async function syncWorkspace(
  workspacePath: RepoPath,
  baseBranch?: BranchName,
  options?: { mode?: WorkspaceSyncMode; remote?: string }
): Promise<WorkspaceSyncResult> {
  const mode = options?.mode ?? 'fast-forward';
  const remote = options?.remote ?? 'origin';
  const branchToSync = baseBranch ?? (await getDefaultBranch(workspacePath, remote));

  // Fetch from the remote to ensure <remote>/<branchToSync> is up-to-date.
  // Retry on transient ref-lock races — two concurrent fetches of the same
  // remote-tracking ref collide on Git's shared lock file.
  const MAX_FETCH_RETRIES = 3;

  for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
    try {
      await execFileAsync('git', ['-C', workspacePath, 'fetch', remote, branchToSync], {
        timeout: 60000,
      });
      break;
    } catch (error) {
      const err = error as Error;
      const errorMessage = err.message.toLowerCase();

      // If configured branch doesn't exist on remote, provide actionable error
      if (
        baseBranch &&
        (errorMessage.includes("couldn't find remote ref") || errorMessage.includes('not found'))
      ) {
        throw new Error(
          `Configured base branch '${baseBranch}' not found on remote '${remote}'. ` +
            'Either create the branch, update worktree.baseBranch in .archon/config.yaml, ' +
            'or remove the setting to use the auto-detected default branch.'
        );
      }

      // Retry transient ref-lock races from concurrent fetch calls
      if (
        attempt < MAX_FETCH_RETRIES &&
        errorMessage.includes('cannot lock ref') &&
        errorMessage.includes('unable to update local ref')
      ) {
        const backoffMs = 50 * Math.pow(2, attempt);
        getLog().debug(
          { err, attempt: attempt + 1, backoffMs, remote, branch: branchToSync },
          'workspace.fetch_ref_lock_retry'
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      throw new Error(`Sync fetch from ${remote}/${branchToSync} failed: ${err.message}`);
    }
  }

  const previousHead = await readShortSha(workspacePath, 'HEAD');

  if (mode !== 'reset') {
    const state = await classifyWorkspaceState(workspacePath, branchToSync, remote);

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
        ['-C', workspacePath, 'merge', '--ff-only', `${remote}/${branchToSync}`],
        {
          timeout: 30000,
        }
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Fast-forward to ${remote}/${branchToSync} failed: ${err.message}`);
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

  // Hard-reset local working tree to match the remote — only safe for Archon-managed
  // clones, never for a user's local working directory.
  try {
    await execFileAsync(
      'git',
      ['-C', workspacePath, 'reset', '--hard', `${remote}/${branchToSync}`],
      {
        timeout: 30000,
      }
    );
  } catch (error) {
    const err = error as Error;
    throw new Error(`Reset to ${remote}/${branchToSync} failed: ${err.message}`);
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
  branchToSync: BranchName,
  remote = 'origin'
): Promise<WorkspaceSyncState> {
  if (await hasTrackedModifications(workspacePath)) {
    return 'dirty';
  }

  const localSha = await readSha(workspacePath, 'HEAD');
  const remoteRef = `${remote}/${branchToSync}`;
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
 * @param options - Optional request-scoped HTTP credentials
 * @returns GitResult<void>
 */
export interface CloneCredentials {
  username: string;
  password: string;
}

export interface CloneRepositoryOptions {
  credentials?: CloneCredentials;
}

const ENV_CREDENTIAL_HELPER =
  '!f() { test "$1" = get || exit 0; printf \'%s\\n\' "username=$ARCHON_GIT_USERNAME" "password=$ARCHON_GIT_PASSWORD"; }; f';

function normalizeCloneSource(url: string): string {
  if (url.startsWith('/') || url.startsWith('~') || url.startsWith('.')) return url;

  const scpStyle = /^git@([^:]+):(.+)$/.exec(url);
  if (scpStyle) return `https://${scpStyle[1]}/${scpStyle[2]}`;

  const firstSlash = url.indexOf('/');
  if (firstSlash <= 0 || url.includes('://')) return url;

  const authority = url.slice(0, firstSlash);
  const isBareHost =
    authority === 'localhost' ||
    authority.includes('.') ||
    /^[^:]+:\d+$/.test(authority) ||
    /^\[[^\]]+\](?::\d+)?$/.test(authority);
  return isBareHost ? `https://${url}` : url;
}

export function validateCloneUrl(
  url: string
): { ok: true; url: string; httpUrl: URL | null } | { ok: false; error: string } {
  const cloneSource = normalizeCloneSource(url);
  if (!/^\s*https?:/i.test(cloneSource)) {
    return { ok: true, url: cloneSource, httpUrl: null };
  }
  if (cloneSource.includes('\\')) {
    return { ok: false, error: 'Invalid HTTP(S) repository URL' };
  }

  let parsed: URL;
  try {
    parsed = new URL(cloneSource);
  } catch {
    return { ok: false, error: 'Invalid HTTP(S) repository URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Invalid HTTP(S) repository URL' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Repository URL must not include credentials' };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'Invalid HTTP(S) repository URL' };
  }
  return { ok: true, url: parsed.href, httpUrl: parsed };
}

function sanitizeCloneError(error: unknown, credentials?: CloneCredentials): string {
  const err = error as Error & { stdout?: string; stderr?: string };
  let message = [err.message, err.stderr, err.stdout].filter(Boolean).join('\n');
  const credentialValues = credentials
    ? [credentials.username, credentials.password]
        .filter(value => value.length > 0)
        .sort((left, right) => right.length - left.length)
    : [];
  for (const value of credentialValues) message = message.replaceAll(value, '***');
  return message;
}

export async function cloneRepository(
  url: string,
  targetPath: RepoPath,
  options?: CloneRepositoryOptions
): Promise<GitResult<void>> {
  const validatedUrl = validateCloneUrl(url);
  if (!validatedUrl.ok) {
    return { ok: false, error: { code: 'unknown', message: validatedUrl.error } };
  }
  const parsedUrl = validatedUrl.httpUrl;
  if (options?.credentials && !parsedUrl) {
    return {
      ok: false,
      error: { code: 'unknown', message: 'Authenticated clones require an HTTP(S) repository URL' },
    };
  }
  const cloneUrl = validatedUrl.url;

  try {
    const args = ['clone', cloneUrl, targetPath];
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    delete env.ARCHON_GIT_USERNAME;
    delete env.ARCHON_GIT_PASSWORD;
    if (options?.credentials && parsedUrl) {
      args.unshift(
        '-c',
        'credential.helper=',
        '-c',
        `credential.${parsedUrl.origin}.helper=${ENV_CREDENTIAL_HELPER}`
      );
      env.ARCHON_GIT_USERNAME = options.credentials.username;
      env.ARCHON_GIT_PASSWORD = options.credentials.password;
    }

    // GIT_TERMINAL_PROMPT=0 turns any missing-creds scenario into an
    // immediate, readable error instead of a hung stdin credential prompt.
    await execFileAsync('git', args, {
      timeout: 120000,
      env,
    });
    return { ok: true, value: undefined };
  } catch (error) {
    const sanitizedMessage = sanitizeCloneError(error, options?.credentials);
    const message = sanitizedMessage.toLowerCase();

    if (message.includes('not found') || message.includes('404')) {
      return { ok: false, error: { code: 'not_a_repo', path: cloneUrl } };
    }
    if (
      message.includes('authentication failed') ||
      message.includes('could not read') ||
      message.includes('access denied') ||
      message.includes('403')
    ) {
      return { ok: false, error: { code: 'permission_denied', path: cloneUrl } };
    }
    if (message.includes('no space')) {
      return { ok: false, error: { code: 'no_space', path: targetPath } };
    }

    getLog().error(
      { url: cloneUrl, targetPath, errorMessage: sanitizedMessage },
      'clone_repository_failed'
    );
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
 * @param remote - Remote name to fetch from (default: 'origin')
 * @returns GitResult<void>
 */
export async function syncRepository(
  repoPath: RepoPath,
  branch: BranchName,
  remote = 'origin'
): Promise<GitResult<void>> {
  try {
    await execFileAsync('git', ['fetch', remote], { cwd: repoPath, timeout: 60000 });
  } catch (error) {
    const err = error as Error & { stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`.toLowerCase();
    getLog().error({ err, repoPath, branch, remote }, 'sync_repository_fetch_failed');

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
    await execFileAsync('git', ['reset', '--hard', `${remote}/${branch}`], {
      cwd: repoPath,
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error;
    const message = err.message.toLowerCase();

    if (message.includes('unknown revision') || message.includes('not a valid object')) {
      return { ok: false, error: { code: 'branch_not_found', branch } };
    }

    getLog().error({ err, repoPath, branch, remote }, 'sync_repository_reset_failed');
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

import { GitFailure } from './errors';
import { gitCredentialOptions, sanitizeGitError } from './credentials';
import { inspectRemoteBranches, ConfiguredBaseBranchNotFoundError } from './remote-branches';
import { existsSync, statSync } from 'fs';
import {
  appendFile,
  chmod,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'fs/promises';
import type { FileHandle } from 'fs/promises';
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
 * Fetch is repeatable, but Git has no distinct ref-contention exit status.
 * Bound recovery for exited subprocess failures without guessing their cause
 * from stderr. Known failures and spawn/termination errors propagate immediately.
 */
export async function fetchWithRetry(
  repoPath: RepoPath,
  fetchArgs: string[],
  options: { timeout: number }
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await execFileAsync('git', ['-C', repoPath, 'fetch', ...fetchArgs], options);
      return;
    } catch (error) {
      if (
        !(error instanceof GitFailure) ||
        error.kind !== 'unclassified' ||
        typeof error.code !== 'number' ||
        error.code <= 0
      )
        throw error;
      if (attempt === 2) throw error;
      getLog().warn({ err: error, repoPath, attempt: attempt + 1 }, 'git.fetch_retry');
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
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
      {
        timeout: 10000,
      }
    );
    return toRepoPath(stdout.trim());
  } catch (error) {
    const err = error as Error & { stderr?: string };
    // A missing start path also reads as no repository; callers rely on this
    // function to refuse it rather than treat it as a folder.
    if (error instanceof GitFailure && error.kind === 'not_repository' && existsSync(startPath))
      return null;

    // Unexpected error - surface it
    getLog().error({ startPath, err, stderr: err.stderr }, 'find_repo_root_failed');
    throw new Error(`Failed to find repo root for ${startPath}: ${err.message}`, { cause: error });
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
    if (error instanceof GitFailure && error.kind === 'unclassified' && error.code === 2) {
      try {
        await execFileAsync(
          'git',
          ['-C', repoPath, 'config', '--local', '--get', `remote.${remote}.url`],
          {
            timeout: 10000,
          }
        );
      } catch (inspectionError) {
        if (
          inspectionError instanceof GitFailure &&
          inspectionError.kind === 'unclassified' &&
          inspectionError.code === 1
        )
          return null;
      }
    }

    // Unexpected error - surface it
    getLog().error({ repoPath, remote, err, stderr: err.stderr }, 'get_remote_url_failed');
    throw new Error(
      `Failed to get remote URL for ${repoPath} (remote: ${remote}): ${err.message}`,
      { cause: error }
    );
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
  try {
    await fetchWithRetry(workspacePath, [remote, branchToSync], {
      timeout: 60000,
    });
  } catch (error) {
    const err = error as Error;
    if (baseBranch) {
      const inspection = await inspectRemoteBranches({
        kind: 'local',
        repoPath: workspacePath,
        remote,
      }).catch((inspectionError: unknown) => {
        getLog().warn(
          { err: inspectionError, workspacePath, remote },
          'workspace.fetch_failure_inspection_failed'
        );
        return null;
      });
      if (inspection?.status === 'available' && !inspection.branches.includes(baseBranch)) {
        throw new ConfiguredBaseBranchNotFoundError(baseBranch, remote);
      }
    }

    throw new Error(`Sync fetch from ${remote}/${branchToSync} failed: ${err.message}`, {
      cause: error,
    });
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
      throw new Error(`Fast-forward to ${remote}/${branchToSync} failed: ${err.message}`, {
        cause: err,
      });
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
    throw new Error(`Reset to ${remote}/${branchToSync} failed: ${err.message}`, { cause: err });
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
    throw new Error(`Failed to compare git ancestry in ${workspacePath}: ${err.message}`, {
      cause: error,
    });
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

function stderrOf(error: unknown): string {
  return error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
    ? error.stderr
    : '';
}

/**
 * Git reports these causes only as stderr lines, not exit codes. Matching whole
 * fatal lines keeps a URL, path, or branch name from changing the result. An
 * HTTP 403 matches on curl's status text ending a fatal line, whatever prefix
 * precedes it. The cause only chooses the guidance a GitResult reports; it
 * never decides retry.
 */
function reportedCause(error: unknown): 'missing' | 'denied' | 'no_space' | undefined {
  const stderr = stderrOf(error);
  if (/^fatal: repository '.*' not found\r?$/m.test(stderr)) return 'missing';
  if (
    /^fatal: (?:Authentication failed for|could not read (?:Username|Password) for) '/m.test(
      stderr
    ) ||
    /^fatal: Could not read from remote repository\.\r?$/m.test(stderr) ||
    /^fatal: .*The requested URL returned error: 403\r?$/m.test(stderr)
  )
    return 'denied';
  if (/: No space left on device\r?$/m.test(stderr)) return 'no_space';
  return undefined;
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
    const { args: authArgs, env } = gitCredentialOptions(parsedUrl, options?.credentials);
    args.unshift(...authArgs);

    // GIT_TERMINAL_PROMPT=0 turns any missing-creds scenario into an
    // immediate, readable error instead of a hung stdin credential prompt.
    await execFileAsync('git', args, {
      timeout: 120000,
      env,
    });
    return { ok: true, value: undefined };
  } catch (error) {
    const sanitizedMessage = sanitizeGitError(error, options?.credentials);
    getLog().error(
      { url: cloneUrl, targetPath, errorMessage: sanitizedMessage },
      'clone_repository_failed'
    );
    // GitHub over SSH prints this before the generic "Could not read from remote
    // repository" line. Dev reported it as not found on clone but as denied on
    // fetch, so only clone reads it.
    const cause = /^ERROR: Repository not found\.\r?$/m.test(stderrOf(error))
      ? 'missing'
      : reportedCause(error);
    if (cause === 'missing') return { ok: false, error: { code: 'not_a_repo', path: cloneUrl } };
    if (cause === 'denied')
      return { ok: false, error: { code: 'permission_denied', path: cloneUrl } };
    if (cause === 'no_space') return { ok: false, error: { code: 'no_space', path: targetPath } };
    return { ok: false, error: { code: 'unknown', message: sanitizedMessage } };
  }
}

/**
 * Sync a repository to match a remote branch.
 * Runs sequential fetch + reset --hard. If fetch fails, reset is skipped.
 * Uses execFileAsync (no shell interpolation) for safety.
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
    await fetchWithRetry(repoPath, [remote], { timeout: 60000 });
  } catch (error) {
    const err = error as Error & { stderr?: string };
    getLog().error({ err, repoPath, branch, remote }, 'sync_repository_fetch_failed');
    if (error instanceof GitFailure && error.kind === 'not_repository') {
      return { ok: false, error: { code: 'not_a_repo', path: repoPath } };
    }
    const cause = reportedCause(error);
    if (cause === 'denied')
      return { ok: false, error: { code: 'permission_denied', path: repoPath } };
    if (cause === 'no_space') return { ok: false, error: { code: 'no_space', path: repoPath } };
    return { ok: false, error: { code: 'unknown', message: `Fetch failed: ${err.message}` } };
  }

  try {
    await execFileAsync('git', ['reset', '--hard', `${remote}/${branch}`], {
      cwd: repoPath,
      timeout: 30000,
    });
  } catch (error) {
    const err = error as Error;
    if (
      stderrOf(err).startsWith(`fatal: ambiguous argument '${remote}/${branch}': unknown revision`)
    ) {
      return { ok: false, error: { code: 'branch_not_found', branch } };
    }
    getLog().error({ err, repoPath, branch, remote }, 'sync_repository_reset_failed');
    return { ok: false, error: { code: 'unknown', message: `Reset failed: ${err.message}` } };
  }

  return { ok: true, value: undefined };
}

const CONFIG_LOCK_WAIT_MS = 10000;

/**
 * Take Git's writer lock for a config file. Another writer holding it (EEXIST),
 * whether Archon or git itself, is waited out; any other failure, or a lock
 * still held at the deadline, throws with its original error.
 */
async function acquireConfigLock(lockPath: string): Promise<FileHandle> {
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    try {
      return await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function editConfigFile(
  configPath: string,
  edit: (lockPath: string) => Promise<void>
): Promise<void> {
  const config = await realpath(configPath);
  const lockPath = `${config}.lock`;
  // Use Git's writer lock and publish only the finished edit. Readers retain
  // their accepted trust even if a repair fails after removing the old entry.
  const lock = await acquireConfigLock(lockPath);
  let published = false;
  let closed = false;
  try {
    const { mode } = await stat(config);
    await lock.writeFile(await readFile(config));
    await lock.close();
    closed = true;
    await edit(lockPath);
    // Like git, apply the config's mode only after editing, so a read-only config stays editable.
    await chmod(lockPath, mode);
    await rename(lockPath, config);
    published = true;
  } finally {
    if (!closed) {
      try {
        await lock.close();
      } catch (err) {
        getLog().error({ err, lockPath }, 'safe_directory_lock_close_failed');
      }
    }
    if (!published) {
      try {
        await unlink(lockPath);
      } catch (err) {
        getLog().error({ err, lockPath }, 'safe_directory_lock_cleanup_failed');
      }
    }
  }
}

async function replaceSafeDirectory(lockPath: string, path: RepoPath): Promise<void> {
  await execFileAsync(
    'git',
    ['config', '--file', lockPath, '--fixed-value', '--replace-all', 'safe.directory', path, path],
    { timeout: 10000 }
  );
}

async function editSafeDirectory(
  configPath: string,
  path: RepoPath,
  grant: boolean
): Promise<void> {
  await editConfigFile(configPath, async lockPath => {
    try {
      await execFileAsync(
        'git',
        ['config', '--file', lockPath, '--fixed-value', '--unset-all', 'safe.directory', path],
        { timeout: 10000 }
      );
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 5)) throw error;
    }
    if (grant) {
      // Git writes into the last matching section, after any included resets.
      await appendFile(lockPath, '\n[safe]\n');
      await replaceSafeDirectory(lockPath, path);
    }
  });
}

/** The HOME git uses: POSIX git has none when it is unset; Git for Windows derives one. */
function gitHome(): string | undefined {
  const { HOME, HOMEDRIVE, HOMEPATH, USERPROFILE } = process.env;
  if (HOME || process.platform !== 'win32') return HOME;
  // Git for Windows skips a disconnected %HOMEDRIVE%%HOMEPATH% home share.
  const homeShare = HOMEDRIVE && HOMEPATH ? `${HOMEDRIVE}${HOMEPATH}` : undefined;
  return homeShare && statSync(homeShare, { throwIfNoEntry: false })?.isDirectory()
    ? homeShare
    : USERPROFILE;
}

/** Git's --global write target: ~/.gitconfig unless only the XDG file exists. */
function defaultGlobalConfigPath(): string {
  const home = gitHome();
  if (!home) throw new Error('HOME is not set, so git has no global config');
  const homeConfig = join(home, '.gitconfig');
  const xdgConfig = join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'git/config');
  return existsSync(homeConfig) || !existsSync(xdgConfig) ? homeConfig : xdgConfig;
}

/**
 * Add a directory to git's global safe.directory config.
 * Grants persist after setup failure: revocation could remove trust that a
 * concurrent setup accepted for the same path.
 * Writes take Git's config lock and wait for another writer instead of failing.
 * Uses execFileAsync (no shell interpolation) for safety.
 */
export async function addSafeDirectory(path: RepoPath): Promise<void> {
  try {
    let fields: string[];
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          'config',
          '--includes',
          '--show-scope',
          '--show-origin',
          '--null',
          '--get-all',
          'safe.directory',
        ],
        { timeout: 10000 }
      );
      fields = stdout.split('\0').slice(0, -1);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 1)) throw error;
      fields = [];
    }
    const entries: { source: string; value: string }[] = [];
    for (let i = 0; i < fields.length; i += 3) {
      if (fields[i] === 'global') {
        entries.push({ source: fields[i + 1].slice('file:'.length), value: fields[i + 2] });
      }
    }
    const values = entries.map(entry => entry.value);
    const grants = entries.filter(entry => entry.value === path);
    if (grants.length === 1 && values.indexOf(path) > values.lastIndexOf('')) return;
    const targetPath = process.env.GIT_CONFIG_GLOBAL ?? defaultGlobalConfigPath();
    // git config --global creates a missing file; the lock-and-rename edit needs one.
    // Append mode creates through a dangling symlink and never truncates a racing writer's file.
    if (!existsSync(targetPath)) await (await open(targetPath, 'a', 0o666)).close();
    if (grants.length === 0 && !values.includes('')) {
      await editConfigFile(targetPath, lockPath => replaceSafeDirectory(lockPath, path));
      return;
    }
    const target = await realpath(targetPath);
    // Publish effective trust before removing duplicate grants in earlier sources.
    await editSafeDirectory(target, path, true);
    for (const source of new Set(grants.map(entry => entry.source))) {
      if ((await realpath(source)) !== target) await editSafeDirectory(source, path, false);
    }
  } catch (error) {
    const err = error as Error;
    getLog().error({ err, path }, 'add_safe_directory_failed');
    throw new Error(`Failed to add safe directory '${path}': ${err.message}`, { cause: err });
  }
}

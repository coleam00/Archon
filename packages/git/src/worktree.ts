import { readFile, access } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import {
  createLogger,
  getArchonWorkspacesPath,
  getProjectWorktreesPath,
  isInsideArchonWorkspaces,
  parseOwnerRepo,
  resolveRepoProjectIdentity,
} from '@archon/paths';
import { execFileAsync } from './exec';
import type { RepoPath, BranchName, WorktreePath, WorktreeInfo } from './types';
import { toRepoPath, toBranchName, toWorktreePath } from './types';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('git');
  return cachedLog;
}

/**
 * Layout of a worktree base relative to the repository.
 *
 * Two layouts only — worktrees live either co-located with the repo (opt-in)
 * or inside the user's archon workspace area (default for every repo):
 *
 * - `repo-local`       — `<repoRoot>/<override.repoLocal>/`  (opt-in per repo config)
 * - `workspace-scoped` — `~/.archon/workspaces/<owner>/<repo>/worktrees/`  (default)
 *
 * In both layouts the base already includes all repo context, so callers append
 * only the branch name to compose the final worktree path — there is no layout
 * where owner/repo gets tacked on as a separate path segment.
 */
export type WorktreeLayout = 'repo-local' | 'workspace-scoped';

/**
 * Override inputs for `getWorktreeBase()`. All fields are optional.
 */
export interface WorktreeBaseOverride {
  /**
   * Repo-relative path where worktrees should live (e.g. `.worktrees`).
   * Only supported override today. Must be validated as a safe relative path
   * by the caller before reaching this layer.
   */
  repoLocal?: string;
}

/**
 * Resolve the `{ owner, repo }` identity used to scope archon-managed worktrees.
 *
 * Precedence:
 *   1. Explicit `codebaseName` in strict `owner/repo` format (from the database /
 *      web UI), validated by the shared `parseOwnerRepo()`
 *   2. Path segments when `repoPath` is already under `~/.archon/workspaces/owner/repo/`
 *   3. The shared project-identity fallback: `_local/<basename(repoPath)>`
 *      (`resolveRepoProjectIdentity()` in `@archon/paths`)
 *
 * Identity decisions are delegated to `@archon/paths` so the worktree base
 * always agrees with the storage identity that registration writes to disk and
 * that log/artifact path resolution uses (#2227). Historically the fallback
 * derived owner/repo from the last two path segments, inventing a junk "owner"
 * from the checkout's parent directory and disagreeing with the `_local/`
 * storage tree (#2132).
 */
function resolveOwnerRepo(
  repoPath: RepoPath,
  codebaseName?: string
): { owner: string; repo: string } {
  if (codebaseName) {
    // Reject names containing ':' or '@' — they would become path segments and
    // break docker-compose short-form volume specs (HOST:CONTAINER:OPT) (#1583).
    const parsed = parseOwnerRepo(codebaseName);
    if (parsed) return parsed;
    getLog().warn({ codebaseName }, 'worktree.invalid_codebase_name_format');
  }
  if (isInsideArchonWorkspaces(repoPath)) {
    const parts = relative(resolve(getArchonWorkspacesPath()), resolve(repoPath)).split(/[/\\]/);
    if (parts.length >= 2) {
      return { owner: parts[0], repo: parts[1] };
    }
  }
  // Fallback: the shared storage-identity resolver — the same
  // `_local/<basename>` identity that registration creates on disk and that
  // the workflow executor uses for logs/artifacts, so all project paths agree.
  // The name (if any) was already rejected above, so this resolves purely from
  // the path.
  const identity = resolveRepoProjectIdentity(codebaseName ?? '', repoPath);
  if (!identity) {
    throw new Error(
      `Cannot derive a project identity from path "${repoPath}": basename is empty or a dot segment`
    );
  }
  return identity;
}

/**
 * Get the base directory for worktrees and the resolved layout.
 *
 * Resolution (highest to lowest priority):
 *   1. `override.repoLocal` → `<repoRoot>/<repoLocal>/` (layout: `repo-local`)
 *   2. Otherwise             → `~/.archon/workspaces/<owner>/<repo>/worktrees/`
 *                              (layout: `workspace-scoped`)
 *
 * The `<owner>/<repo>` identity is resolved via `resolveOwnerRepo()` — see its
 * docstring for the precedence. Every repo ends up with a stable workspace-scoped
 * base; there is no `~/.archon/worktrees/owner/repo/` fallback layout.
 */
export function getWorktreeBase(
  repoPath: RepoPath,
  codebaseName?: string,
  override?: WorktreeBaseOverride
): { base: string; layout: WorktreeLayout } {
  if (override?.repoLocal) {
    return { base: join(repoPath, override.repoLocal), layout: 'repo-local' };
  }
  const { owner, repo } = resolveOwnerRepo(repoPath, codebaseName);
  return {
    base: getProjectWorktreesPath(owner, repo),
    layout: 'workspace-scoped',
  };
}

/**
 * Check if the worktree base for a given repo path is workspace-scoped.
 *
 * Kept for backward compatibility with callers outside this package; prefer
 * reading `layout` from `getWorktreeBase()` in new code. This helper is unaware
 * of `override.repoLocal`, so it does not reflect per-repo overrides — use
 * `getWorktreeBase(...).layout === 'workspace-scoped'` in override-aware code.
 *
 * @deprecated Use `getWorktreeBase(...).layout === 'workspace-scoped'` instead.
 *   This helper returned `false` for pre-workspace registered repos in the old
 *   two-layout model; in the current model every repo resolves to workspace-scoped
 *   when no override is set, so this always returns `true`.
 */
export function isProjectScopedWorktreeBase(repoPath: RepoPath, codebaseName?: string): boolean {
  return getWorktreeBase(repoPath, codebaseName).layout === 'workspace-scoped';
}

/**
 * Check if a worktree already exists at the given path.
 * A worktree is considered to exist if the directory and a .git entry
 * (file or directory) are both present. Does not validate .git contents.
 *
 * Only returns false for ENOENT (path doesn't exist).
 * Throws for unexpected errors (permission denied, I/O errors, etc.)
 */
export async function worktreeExists(worktreePath: WorktreePath): Promise<boolean> {
  // Step 1: Check if directory exists
  try {
    await access(worktreePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    getLog().error({ worktreePath, err, code: err.code }, 'worktree.existence_check_failed');
    throw new Error(`Failed to check worktree at ${worktreePath}: ${err.message}`);
  }

  // Step 2: Check if .git entry exists (directory exists at this point)
  try {
    const gitPath = join(worktreePath, '.git');
    await access(gitPath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      // Directory exists but .git is missing — corruption signal
      getLog().warn({ worktreePath }, 'worktree.corruption_detected');
      return false;
    }
    getLog().error({ worktreePath, err, code: err.code }, 'worktree.existence_check_failed');
    throw new Error(`Failed to check worktree at ${worktreePath}: ${err.message}`);
  }
}

/**
 * List all worktrees for a repository
 * Returns array of {path, branch} objects parsed from git worktree list --porcelain
 *
 * Only returns [] for expected "not a git repository" errors.
 * Throws for unexpected errors (permission denied, git not found, etc.)
 */
export async function listWorktrees(repoPath: RepoPath): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'list', '--porcelain'],
      { timeout: 10000 }
    );

    const worktrees: WorktreeInfo[] = [];
    let currentPath = '';

    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.substring(9);
      } else if (line.startsWith('branch ')) {
        const branch = line.substring(7).replace('refs/heads/', '');
        if (currentPath) {
          worktrees.push({ path: toWorktreePath(currentPath), branch: toBranchName(branch) });
        }
      }
    }

    return worktrees;
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // ENOENT on repo path itself — distinct from "not a git repository"
    if (errorText.includes('No such file or directory')) {
      getLog().warn({ repoPath }, 'worktree.list_repo_missing');
      return [];
    }

    // Expected: not a git repository - return empty list
    if (errorText.includes('not a git repository')) {
      return [];
    }

    // Unexpected error - log and throw
    getLog().error({ repoPath, err, code: err.code, stderr: err.stderr }, 'worktree.list_failed');
    throw new Error(`Failed to list worktrees for ${repoPath}: ${err.message}`);
  }
}

/**
 * Find an existing worktree by branch name pattern.
 * Useful for discovering skill-created worktrees when app receives GitHub event.
 *
 * Matches by exact name first, then by slash-to-dash slugification
 * (e.g., "feature/auth" matches a worktree on branch "feature-auth")
 * since some tools slugify branch names when creating worktree directories.
 */
export async function findWorktreeByBranch(
  repoPath: RepoPath,
  branchPattern: BranchName
): Promise<WorktreePath | null> {
  const worktrees = await listWorktrees(repoPath);

  // Exact match first
  const exact = worktrees.find(wt => wt.branch === branchPattern);
  if (exact) return exact.path;

  // Partial match (e.g., "feature-auth" matches "feature/auth" after slugification)
  const slugified = branchPattern.replace(/\//g, '-');
  const partial = worktrees.find(
    wt => wt.branch.replace(/\//g, '-') === slugified || wt.branch === slugified
  );
  if (partial) return partial.path;

  return null;
}

/**
 * Check if a path is inside a git worktree (vs main repo)
 * Worktrees have a .git FILE, main repos have a .git DIRECTORY
 *
 * Returns false for expected cases (ENOENT, EISDIR - main repo).
 * Throws for unexpected errors since this function is used for critical path decisions.
 */
export async function isWorktreePath(path: string): Promise<boolean> {
  try {
    const gitPath = join(path, '.git');
    const content = await readFile(gitPath, 'utf-8');
    // Worktree .git file contains "gitdir: /path/to/main/.git/worktrees/..."
    return content.startsWith('gitdir:');
  } catch (error) {
    // Expected errors: file doesn't exist (ENOENT) or .git is a directory (EISDIR)
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      return false;
    }
    // Unexpected error - throw since this affects critical path decisions
    getLog().error({ path, err, code: err.code }, 'worktree_status_check_failed');
    throw new Error(`Cannot determine if ${path} is a worktree: ${err.message}`);
  }
}

/** A git worktree lock, with the reason recorded when it was taken (`''` when none was given). */
export interface WorktreeLock {
  reason: string;
}

/**
 * Release a worktree lock. Throws if the worktree is not locked.
 *
 * There is no counterpart that takes a lock: a worktree Archon creates is locked
 * by `git worktree add --lock`, because taking the lock as a separate step
 * leaves the new checkout adoptable for the length of that gap (#3448).
 */
export async function unlockWorktree(
  repoPath: RepoPath,
  worktreePath: WorktreePath
): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'worktree', 'unlock', worktreePath], {
    timeout: 15000,
  });
}

/**
 * Read a worktree's lock, or `null` when it is not locked.
 *
 * Reads the `locked` file in the worktree's administrative directory, which
 * git-worktree(1) documents, instead of matching a path against
 * `worktree list --porcelain`: git prints paths in its own spelling (forward
 * slashes on Windows, symlinks resolved on macOS), so the comparison is the
 * unreliable half of that route.
 */
export async function readWorktreeLock(worktreePath: WorktreePath): Promise<WorktreeLock | null> {
  const { gitDir } = await getGitCheckoutIdentity(worktreePath);
  try {
    const reason = await readFile(join(gitDir, 'locked'), 'utf-8');
    return { reason: reason.trim() };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    getLog().error({ worktreePath, gitDir, err, code: err.code }, 'worktree.lock_read_failed');
    throw new Error(
      `Cannot read the lock state of the worktree at ${worktreePath}: ${err.message}`,
      {
        cause: err,
      }
    );
  }
}

/**
 * Remove a git worktree
 * Throws if uncommitted changes exist (git's natural guardrail)
 */
export async function removeWorktree(
  repoPath: RepoPath,
  worktreePath: WorktreePath
): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, 'worktree', 'remove', worktreePath], {
    timeout: 30000,
  });
}

/**
 * Refresh the stat data in the index of a worktree the caller just created. `git worktree
 * add` writes files and index within the same second, and Git's racy-clean check compares
 * whole seconds, so it re-hashes every such entry on each later `git status`. Read-only
 * callers (`--no-optional-locks`) never write the result back, so the cost repeats. The
 * refresh waits for the clock to leave the second the checkout finished in, so the index it
 * writes is newer than every file. It re-hashes before it marks an entry clean, so it never
 * hides a change. Call it only on a worktree nobody else is using yet.
 */
export async function refreshWorktreeIndex(worktreePath: WorktreePath): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1000 - (Date.now() % 1000)));
  await execFileAsync('git', ['-C', worktreePath, 'update-index', '-q', '--refresh'], {
    timeout: 120000,
  });
}

export interface GitCheckoutIdentity {
  gitDir: string;
  commonGitDir: string;
  linkedWorktree: boolean;
}

export class CanonicalRepoPathUnavailableError extends Error {
  constructor(
    readonly checkoutPath: string,
    readonly commonGitDir: string
  ) {
    super(
      `Cannot determine the primary checkout for linked worktree at ${checkoutPath}. ` +
        `Git uses external directory ${commonGitDir}, which does not record the primary checkout path.`
    );
    this.name = 'CanonicalRepoPathUnavailableError';
  }
}

/**
 * Return Git's physical repository identity for a checkout.
 *
 * `--git-dir` and `--git-common-dir` are equal for independent checkouts and
 * differ for linked worktrees. This avoids rebuilding valid Git layouts from
 * pathname conventions (`.git/modules`, linked-superproject modules, or an
 * external `--separate-git-dir`).
 */
export async function getGitCheckoutIdentity(path: string): Promise<GitCheckoutIdentity> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    path,
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
  ]);
  const [gitDir, commonGitDir] = stdout.split(/\r?\n/).filter(line => line.length > 0);
  if (!gitDir || !commonGitDir) {
    throw new Error(`Git returned incomplete repository identity for ${path}`);
  }
  return {
    gitDir,
    commonGitDir,
    linkedWorktree: resolve(gitDir) !== resolve(commonGitDir),
  };
}

async function resolvePrimaryCheckout(
  path: string,
  identity: GitCheckoutIdentity
): Promise<RepoPath> {
  const { stdout: worktreeList } = await execFileAsync('git', [
    '--git-dir',
    identity.commonGitDir,
    'worktree',
    'list',
    '--porcelain',
  ]);
  const firstWorktree = /^worktree (.+)$/m.exec(worktreeList)?.[1];
  if (firstWorktree && resolve(firstWorktree) !== resolve(identity.commonGitDir)) {
    return toRepoPath(firstWorktree);
  }

  try {
    const { stdout } = await execFileAsync('git', [
      '--git-dir',
      identity.commonGitDir,
      'config',
      '--get',
      'core.worktree',
    ]);
    const primaryCheckout = stdout.trim();
    if (primaryCheckout) {
      return toRepoPath(
        isAbsolute(primaryCheckout)
          ? primaryCheckout
          : resolve(identity.commonGitDir, primaryCheckout)
      );
    }
  } catch {
    // External Git directories do not record a reverse pointer to their primary
    // checkout. Registered-codebase lookup can still match their common Git dir.
  }
  throw new CanonicalRepoPathUnavailableError(path, identity.commonGitDir);
}

/**
 * Get canonical repo path from a worktree path
 * If already canonical, returns the same path
 */
export async function getCanonicalRepoPath(path: string): Promise<RepoPath> {
  if (await isWorktreePath(path)) {
    try {
      const identity = await getGitCheckoutIdentity(path);
      if (!identity.linkedWorktree) return toRepoPath(path);
      return await resolvePrimaryCheckout(path, identity);
    } catch (error) {
      if (error instanceof CanonicalRepoPathUnavailableError) throw error;
      getLog().error({ path, err: error as Error }, 'canonical_path_resolution_failed');
      throw new Error(
        `Cannot determine canonical repo path from worktree at ${path}: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }
  return toRepoPath(path);
}

/**
 * Verify that the worktree at the given path belongs to the expected repo.
 *
 * Throws if the worktree's parent repo doesn't match the request, or if
 * ownership cannot be determined. The caller relies on the throw-or-return
 * contract: a successful return means the caller may safely adopt the
 * worktree. This is intentionally strict — a permissive fallback here
 * would re-introduce the cross-checkout bug this guard exists to prevent.
 *
 * Git's common-directory paths are normalized with `resolve()` before
 * comparison to handle trailing slashes and relative components.
 *
 * Error classification (surfaced via `classifyIsolationError` in
 * `@archon/isolation/errors.ts`):
 *   - "path contains a full git checkout" → EISDIR
 *   - "Cannot verify worktree ownership" → ENOENT / EACCES / EIO
 *   - "not a git-worktree reference" → submodule pointer or malformed
 *   - "belongs to a different clone" → cross-checkout
 */
export async function verifyWorktreeOwnership(
  worktreePath: WorktreePath,
  expectedRepo: RepoPath
): Promise<void> {
  let gitContent: string;
  try {
    gitContent = await readFile(join(worktreePath, '.git'), 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Preserve the original errno on the wrapped error so downstream
    // classifiers can match by `.code` instead of substring — resilient to
    // Node.js message format changes. The original error is also kept via
    // `cause` for debugging.
    const wrap = (message: string): Error => {
      const wrapped = new Error(message, { cause: err });
      if (err.code) (wrapped as NodeJS.ErrnoException).code = err.code;
      return wrapped;
    };
    // EISDIR: .git is a directory — path holds a full checkout, not a
    // worktree. Refusing adoption prevents accidentally treating an
    // unrelated repo at this path as ours.
    if (err.code === 'EISDIR') {
      throw wrap(
        `Cannot adopt ${worktreePath}: path contains a full git checkout, not a worktree.`
      );
    }
    // ENOENT: .git file missing despite worktreeExists() reporting true —
    // a TOCTOU race or filesystem corruption. Fail fast.
    // EACCES/EIO/etc.: cannot verify ownership — fail fast rather than
    // defaulting to permissive adoption.
    throw wrap(`Cannot verify worktree ownership at ${worktreePath}: ${err.message}`);
  }

  if (!gitContent.startsWith('gitdir:')) {
    throw new Error(`Cannot adopt ${worktreePath}: .git pointer is not a git-worktree reference.`);
  }

  let worktreeIdentity: GitCheckoutIdentity;
  let expectedIdentity: GitCheckoutIdentity;
  try {
    [worktreeIdentity, expectedIdentity] = await Promise.all([
      getGitCheckoutIdentity(worktreePath),
      getGitCheckoutIdentity(expectedRepo),
    ]);
  } catch (error) {
    throw new Error(
      `Cannot verify worktree ownership at ${worktreePath}: ${(error as Error).message}`,
      {
        cause: error,
      }
    );
  }
  if (!worktreeIdentity.linkedWorktree) {
    // Not a git-worktree pointer (e.g., submodule pointer, or malformed).
    // We cannot confirm this is our worktree, so refuse adoption.
    throw new Error(`Cannot adopt ${worktreePath}: .git pointer is not a git-worktree reference.`);
  }

  // Compare resolved common-directory paths: the primary checkout and every
  // linked worktree share this Git identity, while separate clones differ.
  if (resolve(worktreeIdentity.commonGitDir) !== resolve(expectedIdentity.commonGitDir)) {
    throw new Error(
      `Worktree at ${worktreePath} belongs to a different clone (${worktreeIdentity.commonGitDir}). ` +
        'Remove it from that clone or use a different codebase registration.'
    );
  }
}

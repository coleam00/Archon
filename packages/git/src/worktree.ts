import { readFile, access } from 'fs/promises';
import { join, resolve } from 'path';
import {
  createLogger,
  getArchonWorktreesPath,
  getArchonWorkspacesPath,
  getProjectWorktreesPath,
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
 * Get the base directory for worktrees.
 *
 * Resolution order:
 * 1. If `codebaseName` is provided in "owner/repo" format, returns the project-scoped
 *    path directly: ~/.archon/workspaces/owner/repo/worktrees/
 * 2. For paths under ~/.archon/workspaces/owner/repo/..., extracts owner/repo from path
 *    and returns the project-scoped path.
 * 3. Otherwise, returns the legacy global path: ~/.archon/worktrees/
 */
export function getWorktreeBase(repoPath: RepoPath, codebaseName?: string): string {
  // If codebase name is known, use project-scoped path directly
  if (codebaseName) {
    const parts = codebaseName.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return getProjectWorktreesPath(parts[0], parts[1]);
    }
    // codebaseName present but not "owner/repo" format — fall through to path detection.
    // This is intentional: safe degradation to legacy global path.
    getLog().warn({ codebaseName }, 'worktree.invalid_codebase_name_format');
  }
  // Existing path-prefix detection (cloned repos under workspaces/)
  const workspacesPath = getArchonWorkspacesPath();
  if (repoPath.startsWith(workspacesPath)) {
    const relative = repoPath.substring(workspacesPath.length + 1);
    const parts = relative.split(/[/\\]/).filter(p => p.length > 0);
    if (parts.length >= 2) {
      return getProjectWorktreesPath(parts[0], parts[1]);
    }
  }
  // Legacy global fallback (no codebase name, no workspace path match)
  return getArchonWorktreesPath();
}

/**
 * Check if the worktree base for a given repo path is project-scoped
 * (under ~/.archon/workspaces/owner/repo/worktrees/) vs legacy global.
 *
 * When project-scoped, the worktree base already includes the owner/repo context,
 * so callers should NOT append owner/repo again.
 *
 * Resolution order mirrors `getWorktreeBase`: codebaseName → path detection → legacy.
 */
export function isProjectScopedWorktreeBase(repoPath: RepoPath, codebaseName?: string): boolean {
  // If codebase name is known, it's always project-scoped
  if (codebaseName) {
    const parts = codebaseName.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) return true;
    // Invalid format — fall through to path detection (same safe degradation as getWorktreeBase).
  }
  const workspacesPath = getArchonWorkspacesPath();
  if (!repoPath.startsWith(workspacesPath)) return false;
  const relative = repoPath.substring(workspacesPath.length + 1);
  const parts = relative.split(/[/\\]/).filter(p => p.length > 0);
  return parts.length >= 2;
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
 * Get canonical repo path from a worktree path
 * If already canonical, returns the same path
 */
export async function getCanonicalRepoPath(path: string): Promise<RepoPath> {
  if (await isWorktreePath(path)) {
    // Read .git file to find main repo
    const gitPath = join(path, '.git');
    const content = await readFile(gitPath, 'utf-8');
    // gitdir: /path/to/repo/.git/worktrees/branch-name
    const match = /gitdir: (.+)\/\.git\/worktrees\//.exec(content);
    if (match) {
      return toRepoPath(match[1]);
    }
    // Worktree detected but regex didn't match - this is a real problem
    getLog().error(
      { path, gitContentPrefix: content.substring(0, 120) },
      'canonical_path_regex_failed'
    );
    throw new Error(
      `Cannot determine canonical repo path from worktree at ${path}. ` +
        `Unexpected .git file format: ${content.substring(0, 80)}`
    );
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
 * Paths are normalized with `resolve()` before comparison to handle trailing
 * slashes and relative components. Symlinked paths (where canonical vs
 * registered paths differ by symlink resolution) are not equated — callers
 * should register codebases with consistent path forms.
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

  // gitdir: /path/to/repo/.git/worktrees/branch-name
  const match = /gitdir: (.+)\/\.git\/worktrees\//.exec(gitContent);
  if (!match) {
    // Not a git-worktree pointer (e.g., submodule pointer, or malformed).
    // We cannot confirm this is our worktree, so refuse adoption.
    throw new Error(`Cannot adopt ${worktreePath}: .git pointer is not a git-worktree reference.`);
  }

  // Compare on resolved paths (normalizes trailing slashes and relative
  // components) but display the raw path from the .git pointer so the user
  // sees the value they'd recognize. On Windows, `resolve()` would prepend
  // a drive letter to the POSIX-style gitdir, making the error message
  // misleading and causing platform-specific test breakage.
  const existingRepoRaw = match[1];
  if (resolve(existingRepoRaw) !== resolve(expectedRepo)) {
    throw new Error(
      `Worktree at ${worktreePath} belongs to a different clone (${existingRepoRaw}). ` +
        'Remove it from that clone or use a different codebase registration.'
    );
  }
}

/**
 * Extract owner and repo name from the last two segments of a repository path.
 * Throws if the path has fewer than 2 non-empty segments.
 */
export function extractOwnerRepo(repoPath: RepoPath): { owner: string; repo: string } {
  const parts = repoPath.split(/[/\\]/).filter(p => p.length > 0);
  if (parts.length < 2) {
    throw new Error(
      `Cannot extract owner/repo from path "${repoPath}": expected at least 2 path segments`
    );
  }
  return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
}

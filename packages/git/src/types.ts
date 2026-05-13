// Branded types for type-level safety of commonly confused string primitives
declare const REPO_PATH_BRAND: unique symbol;
declare const BRANCH_NAME_BRAND: unique symbol;
declare const WORKTREE_PATH_BRAND: unique symbol;

export type RepoPath = string & { readonly [REPO_PATH_BRAND]: true };
export type BranchName = string & { readonly [BRANCH_NAME_BRAND]: true };
export type WorktreePath = string & { readonly [WORKTREE_PATH_BRAND]: true };

/** Cast a plain string to RepoPath. Rejects empty strings. */
export function toRepoPath(path: string): RepoPath {
  if (!path) throw new Error('RepoPath cannot be empty');
  return path as RepoPath;
}

/** Cast a plain string to BranchName. Rejects empty strings. */
export function toBranchName(name: string): BranchName {
  if (!name) throw new Error('BranchName cannot be empty');
  return name as BranchName;
}

/** Cast a plain string to WorktreePath. Rejects empty strings. */
export function toWorktreePath(path: string): WorktreePath {
  if (!path) throw new Error('WorktreePath cannot be empty');
  return path as WorktreePath;
}

/** Discriminated union for git operation results at package boundaries */
export type GitResult<T> = { ok: true; value: T } | { ok: false; error: GitError };

/** Discriminated union of git error codes used by cloneRepository, syncRepository */
export type GitError =
  | { code: 'not_a_repo'; path: string }
  | { code: 'permission_denied'; path: string }
  | { code: 'branch_not_found'; branch: string }
  | { code: 'no_space'; path: string }
  | { code: 'unknown'; message: string };

/**
 * Mode for `syncWorkspace`.
 *
 * - `fast-forward` (default): fetch + ff-only-merge if `HEAD` is strictly
 *   behind `origin/<branch>`. Never destructive — leaves HEAD unchanged when
 *   ahead, diverged, or working tree dirty. Suitable for any path where local
 *   work must be preserved (e.g. chat-tick refresh on the canonical clone).
 *
 * - `reset`: fetch + `git reset --hard origin/<branch>`. Destructive — discards
 *   uncommitted changes and pulls `HEAD` to `origin/<branch>` even if local
 *   commits exist. Suitable only where a known-clean base state is required
 *   (e.g. immediately before creating a new worktree).
 */
export type SyncMode = 'fast-forward' | 'reset';

/** Result of a workspace sync operation */
export interface WorkspaceSyncResult {
  branch: BranchName;
  synced: boolean;
  /**
   * Observed relationship between HEAD and origin/<branch> before the
   * operation. `dirty` means working tree had uncommitted changes (orthogonal
   * to ancestor state but reported as dominant mode for simplicity).
   */
  state: 'in_sync' | 'behind' | 'ahead' | 'diverged' | 'dirty';
  /** HEAD SHA before the operation (short, 8 chars) */
  previousHead: string;
  /** HEAD SHA after the operation (short, 8 chars) */
  newHead: string;
  /** True if the working tree was updated (HEAD changed) */
  updated: boolean;
}

/** Info about a single worktree entry */
export interface WorktreeInfo {
  path: WorktreePath;
  branch: BranchName;
}

/**
 * Worktree Engine Abstraction
 *
 * Narrow seam over the raw worktree plumbing used by `WorktreeProvider`, so the
 * low-level tool that creates/removes worktrees is pluggable (#2260):
 *
 * - `git` (default)  — raw `git worktree` commands, exactly the historical behavior
 * - `worktrunk`      — shells out to the `wt` CLI (https://worktrunk.dev), so
 *   worktrees Archon creates participate in the user's worktrunk setup (per-repo
 *   hooks, `wt list`, consistent tooling)
 *
 * This is deliberately NOT a new `IIsolationProvider`: all Archon-specific logic
 * (branch naming, fork-PR fetching, adoption, DB registry, copyFiles, submodules)
 * stays in `WorktreeProvider` and behaves identically regardless of engine. Only
 * the four operations below vary.
 *
 * Deliberately NOT part of the engine surface:
 * - `exists` — a worktree created by either engine is an ordinary git worktree
 *   (directory + `.git` pointer file), so the shared fs-based `worktreeExists()`
 *   helper is engine-independent.
 * - Fork-PR checkout (`refs/pull/N/head`) — stays on raw git unconditionally;
 *   there is no worktrunk contract for synthetic review branches (#2260 non-goal).
 */

import type { RepoPath, BranchName, WorktreePath, WorktreeInfo } from '@archon/git';

/** Valid `worktree.engine` values in `.archon/config.yaml`. */
export const WORKTREE_ENGINE_IDS = ['git', 'worktrunk'] as const;

export type WorktreeEngineId = (typeof WORKTREE_ENGINE_IDS)[number];

export interface AddWorktreeOptions {
  /** Canonical main-checkout path — worktree commands run `-C` here. */
  repoPath: RepoPath;
  /** Absolute destination path for the new worktree. */
  worktreePath: WorktreePath;
  /** Branch to create (when `startPoint` is set) or check out (when omitted). */
  branch: BranchName;
  /**
   * Start point for a NEW branch (e.g. `origin/main`, an existing local branch,
   * or a commit-ish). Omit to check out an already-existing local branch instead
   * of creating one.
   */
  startPoint?: string;
  /**
   * Set upstream tracking for the new branch (git: omit `--no-track`).
   * Default false — Archon-generated branches keep `branch.<name>.merge` unset
   * so `gh pr view` doesn't resolve to the base branch's PR. Same-repo PR
   * checkouts pass true (start point is the remote-tracking ref).
   * Only meaningful together with `startPoint`.
   */
  track?: boolean;
}

export interface RemoveWorktreeOptions {
  /** Canonical main-checkout path — worktree commands run `-C` here. */
  repoPath: RepoPath;
  /** Absolute path of the worktree to remove. */
  worktreePath: WorktreePath;
  /** Remove even with uncommitted changes (git/wt `--force`). */
  force?: boolean;
}

/**
 * Pluggable low-level worktree plumbing.
 *
 * Error contract: all methods throw the raw subprocess error (message + `stderr`
 * attached by `execFileAsync`) so `WorktreeProvider`'s existing error
 * classification (`already exists` retry, `isWorktreeMissingError`,
 * `classifyIsolationError`) keeps working unchanged. Engines never delete
 * branches — branch lifecycle stays with the provider.
 */
export interface WorktreeEngine {
  readonly id: WorktreeEngineId;

  /** Create a worktree (and optionally a new branch at `startPoint`). */
  add(options: AddWorktreeOptions): Promise<void>;

  /** Remove a worktree. Never deletes the branch. */
  remove(options: RemoveWorktreeOptions): Promise<void>;

  /** List worktrees as `{ path, branch }` (branchless/detached entries omitted). */
  list(repoPath: RepoPath): Promise<WorktreeInfo[]>;

  /** Prune stale worktree bookkeeping (`git worktree prune` on both engines). */
  prune(repoPath: RepoPath): Promise<void>;
}

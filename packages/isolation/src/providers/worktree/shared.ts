import { access, lstat } from 'fs/promises';

import { createLogger } from '@archon/paths';
import {
  getCanonicalRepoPath,
  toBranchName,
  toRepoPath,
  CanonicalRepoPathUnavailableError,
} from '@archon/git';
import type { BranchName, RepoPath } from '@archon/git';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
export function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('isolation.worktree');
  return cachedLog;
}

/**
 * Prefix of the lock reason Archon writes while it is still setting up a
 * worktree it created.
 *
 * The lock is what separates a usable checkout from a half-built one: git keeps
 * it out of `prune`, refuses a plain `remove`, and reports the reason, so a
 * concurrent run sees the marker instead of a directory that merely looks ready.
 * `git worktree add --lock` writes it before populating the checkout or running
 * hooks, so there is no instant in which the directory exists unmarked.
 *
 * Each attempt appends its creation ID. Matched exactly, the full reason is the
 * attempt's proof on rollback that the checkout is still its own to delete, even
 * when `add` itself failed after creating it (#3448, #3477). The bare prefix is
 * what older Archon versions wrote.
 */
export const SETUP_LOCK_PREFIX = 'archon: worktree setup in progress';

/** Lock reason held while an abandoned run's checkout is being removed. */
export const RELEASE_LOCK_REASON = 'archon: worktree release in progress';

/** File in a created worktree's Git directory holding its creation ID. */
export const CREATION_MARKER = 'archon-creation-id';

/**
 * Ceiling for a single git subprocess in worktree operations (create/fetch/checkout/remove/branch-delete).
 * Generous enough for repos with heavy post-checkout hooks (lint/install) while still catching genuine
 * hangs (e.g. credential prompts in non-TTY, stalled network fetches). See #1119, #1029.
 */
export const GIT_OPERATION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Resolve the anchors from which Git worktree commands should run.
 *
 * External `--separate-git-dir` repositories do not record a reverse path to
 * their primary checkout. The exact linked checkout is valid while it exists;
 * its common Git directory remains usable after that checkout is removed.
 */
interface GitCommandAnchors {
  active: RepoPath;
  durable: RepoPath;
}

export async function getGitCommandAnchors(path: string): Promise<GitCommandAnchors> {
  try {
    const canonicalPath = await getCanonicalRepoPath(path);
    return { active: canonicalPath, durable: canonicalPath };
  } catch (error) {
    if (error instanceof CanonicalRepoPathUnavailableError) {
      return {
        active: toRepoPath(path),
        // The exact checkout may be removed by destroy(), while Git's common
        // directory remains a valid anchor for prune and branch cleanup.
        durable: toRepoPath(error.commonGitDir),
      };
    }
    throw error;
  }
}

export function getForkReviewBranch(prNumber: string): BranchName {
  return toBranchName(`pr-${prNumber}-review`);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Check if a directory exists.
 * Returns true if directory exists, false if it doesn't exist (ENOENT).
 * Throws for other errors (permission denied, I/O errors, etc.)
 */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    throw new Error(
      `Failed to check directory at ${path}: ${err.message} (code: ${err.code ?? 'unknown'})`,
      { cause: err }
    );
  }
}

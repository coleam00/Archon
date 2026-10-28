/**
 * Destroying a worktree: prove the checkout is the one Archon created, remove
 * it, confirm Git no longer tracks it, then delete its branches best-effort.
 */

import { chmod, readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';

import {
  execFileAsync,
  getGitCheckoutIdentity,
  hasUncommittedChangesStrict,
  isWorktreeRegistered,
  toRepoPath,
  toWorktreePath,
  unlockWorktree,
  verifyWorktreeOwnership,
} from '@archon/git';
import type { RepoPath, WorktreePath } from '@archon/git';
import {
  IsolationFailure,
  WorktreeLeftoverError,
  WorktreeUncommittedChangesError,
} from '../../errors';
import type { DestroyResult, WorktreeDestroyOptions } from '../../types';
import { deleteBranchTracked, deleteRemoteBranchTracked } from './branches';
import {
  CREATION_MARKER,
  GIT_OPERATION_TIMEOUT_MS,
  RELEASE_LOCK_REASON,
  directoryExists,
  getGitCommandAnchors,
  getLog,
  pathExists,
} from './shared';

type GuardedRemoval = NonNullable<WorktreeDestroyOptions['guardedRemoval']>;

/**
 * `WorktreeProvider.destroy()`. `envId` is the worktree path.
 *
 * Cleanup behavior:
 * - Present checkout: requires repository registration and matching creation proof
 * - Git removal failures propagate; surviving directories are retained and reported
 * - Branch deletion: Best-effort, logs but doesn't fail
 *
 * Throws on unproven ownership, permissions, and Git removal failures.
 */
export async function destroyWorktree(
  envId: string,
  options?: WorktreeDestroyOptions
): Promise<DestroyResult> {
  const worktreePath = envId;
  if (options?.guardedRemoval) {
    return releaseGuarded(worktreePath, options, options.guardedRemoval);
  }
  const result: DestroyResult = {
    worktreeRemoved: false,
    branchDeleted: null,
    remoteBranchDeleted: null,
    directoryClean: false,
    warnings: [],
  };

  // Filesystem presence is distinct from a valid Git checkout: replacements must be retained.
  const present = await pathExists(worktreePath);
  if (present) {
    await verifyOwnedCheckout(worktreePath, options);
  } else {
    getLog().debug({ worktreePath }, 'worktree_path_already_removed');
    result.worktreeRemoved = true; // Already gone counts as removed
    result.directoryClean = true;
  }

  // A present checkout has already required an independently supplied repository.
  if (!options?.canonicalRepoPath) {
    // Path doesn't exist and no canonicalRepoPath provided - can't clean up branch
    // This is expected when worktree was already fully cleaned up externally
    if (options?.branchName) {
      const warning = `Cannot delete branch '${options.branchName}': worktree path gone and no canonicalRepoPath provided`;
      getLog().warn({ worktreePath, branchName: options.branchName }, 'branch_cleanup_skipped');
      result.warnings.push(warning);
    }
    return result;
  }
  const repoPath = (await getGitCommandAnchors(options.canonicalRepoPath)).durable;

  if (present) await removeCheckout(repoPath, worktreePath, options, result);
  await pruneWorktrees(repoPath);
  if (result.worktreeRemoved) await confirmUnregistered(repoPath, worktreePath, result);
  if (!result.worktreeRemoved || !result.directoryClean) return result;

  // Delete associated branch if provided (best-effort cleanup)
  if (options.branchName) {
    result.branchDeleted = await deleteBranchTracked(repoPath, options.branchName, result);

    // Delete remote branch if requested (e.g., after PR merge)
    if (options.deleteRemoteBranch) {
      result.remoteBranchDeleted = await deleteRemoteBranchTracked(
        repoPath,
        options.branchName,
        result,
        options.remote
      );
    }
  }

  return result;
}

/** Remove an abandoned run's checkout under Archon's release lock. */
async function releaseGuarded(
  worktreePath: string,
  options: WorktreeDestroyOptions,
  guardedRemoval: GuardedRemoval
): Promise<DestroyResult> {
  if (!options.canonicalRepoPath || options.branchName || options.deleteRemoteBranch) {
    throw new Error(
      'Guarded worktree release requires the canonical repository and checkout-only removal'
    );
  }
  const repoPath = options.canonicalRepoPath;
  const path = toWorktreePath(worktreePath);
  await verifyCreation(path, repoPath, guardedRemoval.creationId);
  // `lock` fails on an already locked worktree, so an operator's lock or an
  // unfinished setup refuses release. Adoption refuses this lock, so no new
  // run can pick the checkout up while beforeRemove checks for claimants.
  await execFileAsync(
    'git',
    ['-C', repoPath, 'worktree', 'lock', '--reason', RELEASE_LOCK_REASON, path],
    { timeout: GIT_OPERATION_TIMEOUT_MS }
  );
  try {
    await guardedRemoval.beforeRemove();
  } catch (error) {
    const refusal = error instanceof Error ? error : new Error(String(error));
    await unlockWorktree(repoPath, path).catch((unlockError: unknown) => {
      throw new Error(
        `${refusal.message}; the release lock on ${path} could not be removed: ${(unlockError as Error).message}`,
        { cause: refusal }
      );
    });
    throw refusal;
  }
  // Abandon discards the checkout: force removes uncommitted work and
  // initialized submodules, and the second force passes our own lock.
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'worktree', 'remove', '--force', '--force', '--', path],
      { timeout: GIT_OPERATION_TIMEOUT_MS }
    );
  } catch (error) {
    await finishFailedRelease(repoPath, path, error);
  }
  return {
    worktreeRemoved: true,
    directoryClean: !(await directoryExists(worktreePath)),
    branchDeleted: null,
    remoteBranchDeleted: null,
    warnings: [],
  };
}

/** A present checkout is removed only with its repository and creation proof. */
async function verifyOwnedCheckout(
  worktreePath: string,
  options: WorktreeDestroyOptions | undefined
): Promise<void> {
  if (!options?.canonicalRepoPath || !options.creationId) {
    throw new Error(
      `Cannot verify worktree ownership at ${worktreePath}: canonical repository and creation proof are required; retained for operator inspection`
    );
  }
  await verifyCreation(toWorktreePath(worktreePath), options.canonicalRepoPath, options.creationId);
  if (!(await isWorktreeRegistered(options.canonicalRepoPath, worktreePath))) {
    throw new Error(
      `Cannot verify worktree ownership at ${worktreePath}: not registered with the expected repository`
    );
  }
}

async function verifyCreation(
  path: WorktreePath,
  repo: RepoPath,
  creationId: string
): Promise<void> {
  try {
    await verifyWorktreeOwnership(path, repo);
    const identity = await getGitCheckoutIdentity(path);
    const marker = await readFile(join(identity.gitDir, CREATION_MARKER), 'utf8');
    if (marker !== creationId) throw new Error('Worktree creation identity changed');
  } catch (error) {
    throw new IsolationFailure(
      'ownership_unverified',
      `Cannot verify worktree ownership at ${path}: ${(error as Error).message}`,
      error
    );
  }
}

async function removeCheckout(
  repoPath: string,
  worktreePath: string,
  options: WorktreeDestroyOptions,
  result: DestroyResult
): Promise<void> {
  if (
    !options.force &&
    !options.removeLocked &&
    (await hasUncommittedChangesStrict(toWorktreePath(worktreePath)))
  ) {
    throw new WorktreeUncommittedChangesError(worktreePath);
  }
  const gitArgs = ['-C', repoPath, 'worktree', 'remove'];
  // Git refuses a locked worktree even with one `--force`; the second one is
  // its own opt-in for that, so a lock still protects every other caller.
  if (options.removeLocked) {
    gitArgs.push('--force', '--force');
  } else if (options.force) {
    gitArgs.push('--force');
  }
  gitArgs.push(worktreePath);

  await execFileAsync('git', gitArgs, { timeout: GIT_OPERATION_TIMEOUT_MS });
  result.worktreeRemoved = true;
  result.directoryClean = !(await pathExists(worktreePath));
  if (!result.directoryClean) {
    result.warnings.push(
      `Retained directory at ${worktreePath}: Git removal left a path on disk; inspect it before removing it manually`
    );
  }
}

/**
 * Prune stale worktree references — runs even when path is already gone,
 * because git may still have a stale ref for a manually-deleted worktree.
 */
async function pruneWorktrees(repoPath: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: 15000 });
  } catch (_error) {
    // Best-effort — pruning failure is not critical
    getLog().debug({ repoPath }, 'worktree_prune_failed');
  }
}

/**
 * Confirm the worktree is actually gone from git. A list that fails is no
 * evidence of removal, so it is not reported as removed.
 */
async function confirmUnregistered(
  repoPath: string,
  worktreePath: string,
  result: DestroyResult
): Promise<void> {
  let warning: string | undefined;
  try {
    if (await isWorktreeRegistered(toRepoPath(repoPath), worktreePath))
      warning = `Worktree at ${worktreePath} was reported removed but is still registered in git`;
  } catch (error) {
    warning = `Could not confirm the worktree at ${worktreePath} was removed: ${(error as Error).message}`;
  }
  if (warning) {
    result.worktreeRemoved = false;
    getLog().warn({ worktreePath, repoPath }, 'worktree_removal_verification_failed');
    result.warnings.push(warning);
  }
}

/**
 * Recover from a guarded `worktree remove` that failed.
 *
 * Still registered: drop the release lock so a retry can take it again, and
 * rethrow the removal error. Unregistered: Git dropped its admin entry before
 * failing to delete every file (a read-only subdirectory does this). No retry
 * can prove that directory ours again, but it was proven ours under our lock
 * just before the removal, and Git refuses to add a worktree over a non-empty
 * directory, so finish deleting it here.
 */
async function finishFailedRelease(
  repoPath: RepoPath,
  path: WorktreePath,
  removeError: unknown
): Promise<void> {
  let registered: boolean;
  try {
    registered = await isWorktreeRegistered(repoPath, path);
  } catch (checkError) {
    // Unknown registration: delete nothing, and drop the lock so a retry can take it.
    const lockNote = await unlockWorktree(repoPath, path).then(
      () => '',
      (unlockError: unknown) => {
        getLog().error(
          { err: unlockError, worktreePath: path },
          'isolation.release_lock_drop_failed'
        );
        return `; the release lock could not be removed: ${(unlockError as Error).message}`;
      }
    );
    throw new Error(
      `Could not check whether Git still tracks ${path} after its removal failed: ${(checkError as Error).message}${lockNote}`,
      { cause: removeError }
    );
  }
  if (registered) {
    try {
      await unlockWorktree(repoPath, path);
    } catch (unlockError) {
      getLog().error(
        { err: unlockError, worktreePath: path },
        'isolation.release_lock_drop_failed'
      );
      if (removeError instanceof Error)
        removeError.message += `; the release lock on ${path} could not be removed: ${(unlockError as Error).message}`;
    }
    throw removeError;
  }
  try {
    await makeTreeWritable(path);
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    throw new WorktreeLeftoverError(path, removeError, (error as Error).message);
  }
}

/** Give the owner write access to every directory below `path`, without following symlinks. */
async function makeTreeWritable(path: string): Promise<void> {
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeTreeWritable(join(path, entry.name));
  }
}

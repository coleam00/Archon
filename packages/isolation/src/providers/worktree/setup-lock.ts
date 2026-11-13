/**
 * The setup lock: how a worktree this provider is creating stays marked as
 * unfinished, and how an attempt that fails removes only the checkout it holds.
 */

import {
  execFileAsync,
  addSafeDirectory,
  readWorktreeLock,
  readWorktreeRegistration,
  toRepoPath,
  toWorktreePath,
  unlockWorktree,
} from '@archon/git';
import type { RepoPath } from '@archon/git';
import { IsolationFailure, recordCleanupFailure } from '../../errors';
import {
  GIT_OPERATION_TIMEOUT_MS,
  RELEASE_LOCK_REASON,
  SETUP_LOCK_PREFIX,
  directoryExists,
  getLog,
} from './shared';

export class WorktreeAddError extends Error {
  constructor(
    cause: Error,
    readonly canAdoptConcurrentCheckout: boolean
  ) {
    super(cause.message, { cause });
  }
}

/**
 * Add a worktree that is already marked as unfinished.
 *
 * `--lock` is what makes the marker atomic: git writes the reason before it
 * populates the checkout, so the directory never exists unlocked. Taking the
 * lock as a separate `git worktree lock` afterwards leaves a window in which
 * another `create()` finds a checkout that looks ready and adopts it — the
 * race git documents `--lock` as closing, and the one #3448 is about. Every
 * `git worktree add` this provider issues goes through here so no creation
 * path can reopen it.
 */
export async function addLockedWorktree(
  repoPath: string,
  worktreePath: string,
  setupLockReason: string,
  args: string[]
): Promise<void> {
  if (await readWorktreeRegistration(toRepoPath(repoPath), worktreePath)) {
    throw new IsolationFailure(
      'worktree_registered',
      `Worktree at ${worktreePath} is already registered. Inspect its registration before retrying.`
    );
  }
  await rollBackOnFailure(toRepoPath(repoPath), worktreePath, setupLockReason, async () => {
    await addSafeDirectory(toRepoPath(worktreePath));
    try {
      await execFileAsync(
        'git',
        ['-C', repoPath, 'worktree', 'add', '--lock', '--reason', setupLockReason, ...args],
        { timeout: GIT_OPERATION_TIMEOUT_MS }
      );
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      let canAdoptConcurrentCheckout = false;
      try {
        const registration = await readWorktreeRegistration(toRepoPath(repoPath), worktreePath);
        canAdoptConcurrentCheckout =
          registration === null && !(await directoryExists(worktreePath));
      } catch (ownershipError) {
        getLog().warn(
          { repoPath, worktreePath, err: ownershipError },
          'worktree.failed_add_ownership_unknown'
        );
      }
      throw new WorktreeAddError(cause, canAdoptConcurrentCheckout);
    }
  });
}

/**
 * Drop the setup lock now that the checkout is usable.
 *
 * A worktree that stays locked serves this run fine, but a later run refuses
 * to adopt it and ordinary cleanup cannot remove it, so the failure is
 * reported with the command that clears it instead of left to surprise the
 * next run.
 */
export async function releaseSetupLock(
  repoPath: RepoPath,
  worktreePath: string
): Promise<string | null> {
  try {
    await unlockWorktree(repoPath, toWorktreePath(worktreePath));
    return null;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    getLog().error({ repoPath, worktreePath, err }, 'isolation.setup_lock_release_failed');
    return (
      `The worktree at ${worktreePath} is set up but is still marked as unfinished ` +
      `(${err.message}); run \`git worktree unlock ${worktreePath}\` or a later run will ` +
      'refuse to reuse it.'
    );
  }
}

/**
 * Refuse a worktree that still carries Archon's setup or release lock.
 *
 * A release lock means an abandoned run's checkout is being removed.
 *
 * The setup marker means one of two things, and neither is adoptable: another
 * process is setting this checkout up right now and may yet roll it back, or a
 * setup died before finishing and left a checkout with no submodules, no git
 * identity, and none of the configured files. Ownership here is ambiguous, so
 * the operator gets an explicit action instead of a silent handover.
 */
export async function refuseUnfinishedWorktree(worktreePath: string): Promise<void> {
  const lock = await readWorktreeLock(toWorktreePath(worktreePath));
  if (lock?.reason === RELEASE_LOCK_REASON) {
    throw new IsolationFailure(
      'adoption_refused',
      `Cannot adopt the worktree at ${worktreePath}: an abandoned run is removing it. Retry once the removal finishes.`
    );
  }
  if (lock?.reason !== SETUP_LOCK_PREFIX && !lock?.reason.startsWith(`${SETUP_LOCK_PREFIX}: `)) {
    return;
  }
  getLog().warn({ worktreePath }, 'worktree.adoption_refused_setup_unfinished');
  throw new IsolationFailure(
    'setup_unfinished',
    `Cannot adopt the worktree at ${worktreePath}: its setup did not finish. ` +
      'Another run may be creating it right now — retry once that run ends. ' +
      `Otherwise remove it with \`git worktree remove --force --force ${worktreePath}\`.`
  );
}

/**
 * Preserve a creation error while rolling back only the checkout identified
 * by this attempt's lock. Git can create it even when add reports failure.
 */
export async function rollBackOnFailure<T>(
  repoPath: RepoPath,
  worktreePath: string,
  setupLockReason: string,
  step: () => Promise<T>
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const setupError = error instanceof Error ? error : new Error(String(error));
    await rollBackIncompleteWorktree(repoPath, worktreePath, setupLockReason, setupError);
    throw setupError;
  }
}

/**
 * Remove a worktree this call created but could not finish setting up.
 *
 * A cleanup that does not finish is recorded on the setup error rather than
 * replacing it: the operator needs the original cause and needs to know a
 * checkout was left behind.
 */
async function rollBackIncompleteWorktree(
  repoPath: RepoPath,
  worktreePath: string,
  setupLockReason: string,
  setupError: Error
): Promise<void> {
  getLog().warn(
    { repoPath, worktreePath, err: setupError },
    'isolation.incomplete_worktree_rollback_started'
  );

  const kept = await removeIncompleteWorktree(repoPath, worktreePath, setupLockReason);
  if (!kept) {
    getLog().info({ repoPath, worktreePath }, 'isolation.incomplete_worktree_rolled_back');
    return;
  }

  getLog().error({ repoPath, worktreePath, kept }, 'isolation.incomplete_worktree_rollback_failed');
  recordCleanupFailure(setupError, keptCheckoutNotice(worktreePath, kept));
}

/**
 * Why a rollback left the path in place, by who the path belongs to. Only `this_attempt`
 * is proven to be this call's own remains; telling an operator to remove anything else
 * would point them at a checkout another run may be using.
 */
type KeptCheckout =
  | { owner: 'this_attempt'; reason: string }
  /** The path carries another start's setup lock: that start is creating it, or died doing so. */
  | { owner: 'other_setup'; attemptId: string }
  | { owner: 'unproven'; reason: string };

function keptCheckoutNotice(worktreePath: string, kept: KeptCheckout): string {
  switch (kept.owner) {
    case 'this_attempt':
      return (
        `The incomplete workspace at ${worktreePath} was left behind (${kept.reason}); remove it ` +
        'after inspecting it and preserving any changes before retrying.'
      );
    case 'other_setup':
      return (
        `The workspace at ${worktreePath} carries the setup lock of another start (setup ` +
        `attempt ${kept.attemptId}, the id in that worktree's Git lock), which is either still ` +
        "creating it or stopped partway. It is not this start's, and this start left it " +
        'untouched. Start this run again.'
      );
    case 'unproven':
      return (
        `The workspace at ${worktreePath} was left in place (${kept.reason}). This start can no ` +
        'longer prove the workspace is its own, so another run may be using it: find the run ' +
        'that owns it before changing it.'
      );
  }
}

/** Whose a path is when its lock is not this attempt's: another start's setup, or unknown. */
function lockedByAnother(lockReason: string | null | undefined, otherwise: string): KeptCheckout {
  const prefix = `${SETUP_LOCK_PREFIX}: `;
  return lockReason?.startsWith(prefix)
    ? { owner: 'other_setup', attemptId: lockReason.slice(prefix.length) }
    : { owner: 'unproven', reason: otherwise };
}

/**
 * Remove the checkout this attempt's lock still proves it owns. Returns why it
 * was kept and whose it is, or null once it is gone. Double force is required to remove a
 * locked worktree, and ownership alone does not authorize discarding changes
 * made by hooks or another writer.
 */
async function removeIncompleteWorktree(
  repoPath: RepoPath,
  worktreePath: string,
  setupLockReason: string
): Promise<KeptCheckout | null> {
  try {
    if (!(await directoryExists(worktreePath))) {
      return await removeMissingCheckout(repoPath, worktreePath, setupLockReason);
    }
    return await removeLockedCheckout(repoPath, worktreePath, setupLockReason);
  } catch (error) {
    // Ownership could not be read, so nothing here proves whose checkout remains.
    return { owner: 'unproven', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function removeMissingCheckout(
  repoPath: RepoPath,
  worktreePath: string,
  setupLockReason: string
): Promise<KeptCheckout | null> {
  const registration = await readWorktreeRegistration(repoPath, worktreePath);
  if (registration === null) return null;
  // Git refuses to add over a locked registration, so its lock still proves ownership.
  if (registration.lockReason !== setupLockReason) {
    return lockedByAnother(
      registration.lockReason,
      'the checkout directory is missing and its registration is not owned by this attempt'
    );
  }
  return ownRemains(async () => {
    await forceRemoveWorktree(repoPath, worktreePath);
    return (await readWorktreeRegistration(repoPath, worktreePath)) === null
      ? null
      : 'Git left the missing checkout registered';
  });
}

/** Run a removal step on a checkout this attempt's lock has proven its own. */
async function ownRemains(step: () => Promise<string | null>): Promise<KeptCheckout | null> {
  let reason: string | null;
  try {
    reason = await step();
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  return reason === null ? null : { owner: 'this_attempt', reason };
}

async function removeLockedCheckout(
  repoPath: RepoPath,
  worktreePath: string,
  setupLockReason: string
): Promise<KeptCheckout | null> {
  const lock = await readWorktreeLock(toWorktreePath(worktreePath));
  if (lock?.reason !== setupLockReason) {
    return lock === null
      ? { owner: 'unproven', reason: 'the setup lock this start took is gone' }
      : lockedByAnother(lock.reason, `the checkout is locked by something else: ${lock.reason}`);
  }
  let changes: string | null;
  try {
    changes = await findUnsafeContent(worktreePath);
  } catch (error) {
    changes = error instanceof Error ? error.message : String(error);
  }
  if (changes) return { owner: 'this_attempt', reason: changes };
  const currentLock = await readWorktreeLock(toWorktreePath(worktreePath));
  if (currentLock?.reason !== setupLockReason) {
    return lockedByAnother(currentLock?.reason, 'the setup lock changed during cleanup');
  }
  return ownRemains(async () => {
    await forceRemoveWorktree(repoPath, worktreePath);
    if (await directoryExists(worktreePath)) {
      return 'Git removed the worktree registration but the directory remains';
    }
    return (await readWorktreeRegistration(repoPath, worktreePath)) === null
      ? null
      : 'Git left the checkout registered';
  });
}

/** Why the checkout may hold work that a forced removal would discard, or null. */
async function findUnsafeContent(worktreePath: string): Promise<string | null> {
  const { stdout } = await execFileAsync(
    'git',
    [
      '-C',
      worktreePath,
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignored',
      '--ignore-submodules=none',
    ],
    { timeout: GIT_OPERATION_TIMEOUT_MS }
  );
  if (stdout.length > 0) {
    return 'the checkout contains changes; inspect and preserve them before removing it';
  }
  // Parent status omits ignored/uninitialized submodule contents and index-hidden edits.
  // Preserve these checkouts rather than double-force past Git's remaining safeguards.
  const { stdout: index } = await execFileAsync(
    'git',
    ['-C', worktreePath, 'ls-files', '-v', '--stage', '-z'],
    { timeout: GIT_OPERATION_TIMEOUT_MS }
  );
  if (
    index
      .split('\0')
      .some(
        entry => entry.startsWith('160000 ', 2) || entry.startsWith('S ') || /^[a-z] /.test(entry)
      )
  ) {
    return 'the checkout has submodules or index flags that can hide changes; inspect and preserve them before removing it';
  }
  return null;
}

async function forceRemoveWorktree(repoPath: RepoPath, worktreePath: string): Promise<void> {
  await execFileAsync(
    'git',
    ['-C', repoPath, 'worktree', 'remove', '--force', '--force', worktreePath],
    { timeout: GIT_OPERATION_TIMEOUT_MS }
  );
}

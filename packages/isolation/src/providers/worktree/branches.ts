/**
 * Branch handling: naming a request's branch, checking out the branch a
 * request needs into a new locked worktree, and deleting branches on destroy.
 */

import { createHash } from 'crypto';

import {
  execFileAsync,
  fetchWithRetry,
  listWorktrees,
  syncWorkspace,
  toBranchName,
  toRepoPath,
} from '@archon/git';
import { ExistingBranchDivergedError, IsolationFailure, recordCleanupFailure } from '../../errors';
import type {
  DestroyResult,
  IsolationRequest,
  PRIsolationRequest,
  WorktreeCreationEnvironment,
} from '../../types';
import { findRegisteredWorktree } from './adopt';
import { WorktreeAddError, addLockedWorktree, rollBackOnFailure } from './setup-lock';
import { GIT_OPERATION_TIMEOUT_MS, getForkReviewBranch, getLog } from './shared';

/**
 * Generate semantic branch name based on workflow type
 *
 * For same-repo PRs: Use the actual PR branch name
 * For fork PRs: Use synthetic pr-N-review branch
 *
 * Thread identifiers are hashed via shortHash() (8 hex chars).
 * Task identifiers are slugified via slugify() (lowercase, max 50 chars).
 */
export function generateBranchName(request: IsolationRequest): string {
  switch (request.workflowType) {
    case 'issue':
      return `archon/issue-${request.identifier}`;
    case 'pr':
      // Same-repo PRs use actual branch (already exists on remote), fork PRs use synthetic
      if (!request.isForkPR) {
        return request.prBranch;
      }
      return `archon/pr-${request.identifier}-review`;
    case 'review':
      return `archon/review-${request.identifier}`;
    case 'thread':
      // Use short hash for arbitrary thread IDs (Slack, Discord)
      return `archon/thread-${shortHash(request.identifier)}`;
    case 'task':
      if (request.taskBranch?.kind === 'existing') {
        return request.taskBranch.branch;
      }
      if (request.taskBranch?.branch) {
        return request.taskBranch.branch;
      }
      return `archon/task-${slugify(request.identifier)}`;
  }
}

/**
 * Generate short hash for thread identifiers
 */
function shortHash(input: string): string {
  const hash = createHash('sha256').update(input).digest('hex');
  return hash.substring(0, 8);
}

/**
 * Slugify string for branch names
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
}

async function localBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
      { timeout: GIT_OPERATION_TIMEOUT_MS }
    );
    return stdout.trim().length > 0;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return false;
    throw error;
  }
}

async function remoteBranchExists(
  repoPath: string,
  remote: string,
  branchName: string
): Promise<boolean> {
  const ref = `refs/heads/${branchName}`;
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'ls-remote', remote, ref], {
      timeout: GIT_OPERATION_TIMEOUT_MS,
    });
    return stdout.trim() !== '';
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Cannot check whether branch '${branchName}' exists on '${remote}': ${err.message}. ` +
        'Check your network connection and remote configuration, then retry.',
      { cause: err }
    );
  }
}

/**
 * Create worktree from PR
 *
 * For same-repo PRs: Use the actual branch name so changes push directly to PR
 * For fork PRs: Use synthetic branch (pr-N-review) since we can't push to forks
 *
 * When prSha is provided, the worktree is initially created at the specific
 * commit (detached HEAD), then a local tracking branch is created.
 */
export async function createFromPR(
  request: PRIsolationRequest,
  worktreePath: string,
  setupLockReason: string,
  remote = 'origin'
): Promise<{ adopted: WorktreeCreationEnvironment } | { branchCreated: boolean }> {
  const repoPath = request.canonicalRepoPath;
  const prNumber = request.identifier;

  try {
    if (!request.isForkPR) {
      // Same-repo PR: Use the actual branch so changes push directly to PR
      const branchCreated = await createFromSameRepoPR(
        repoPath,
        worktreePath,
        request.prBranch,
        setupLockReason,
        remote
      );
      return { branchCreated };
    }
    // Fork PR: Use synthetic review branch, which is always (re)created here
    const adopted = await createFromForkPR(request, worktreePath, setupLockReason, remote);
    return adopted ? { adopted } : { branchCreated: true };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const wrapped = new Error(`Failed to create worktree for PR #${prNumber}: ${err.message}`, {
      cause: err,
    });
    const { cleanupFailure } = err as Error & { cleanupFailure?: string };
    if (cleanupFailure) recordCleanupFailure(wrapped, cleanupFailure);
    throw wrapped;
  }
}

/**
 * Create worktree for same-repo PR using the actual branch.
 * Returns whether the local branch was created here (false when it already existed).
 */
async function createFromSameRepoPR(
  repoPath: string,
  worktreePath: string,
  prBranch: string,
  setupLockReason: string,
  remote = 'origin'
): Promise<boolean> {
  try {
    await syncWorkspace(toRepoPath(repoPath), toBranchName(prBranch), {
      mode: 'fetch-only',
      remote,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Fetch ${remote}/${prBranch} failed: ${err.message}`, { cause: err });
  }

  const branchExisted = await localBranchExists(repoPath, prBranch);
  const args = branchExisted
    ? [worktreePath, prBranch]
    : [worktreePath, '-b', prBranch, `${remote}/${prBranch}`];
  await addLockedWorktree(repoPath, worktreePath, setupLockReason, args);

  // Set up tracking for push/pull (non-fatal - worktree is usable without it)
  try {
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'branch', '--set-upstream-to', `${remote}/${prBranch}`],
      { timeout: GIT_OPERATION_TIMEOUT_MS }
    );
  } catch (trackingError) {
    getLog().warn({ err: trackingError, worktreePath, prBranch }, 'upstream_tracking_failed');
    // Continue - the worktree was created successfully, tracking is just convenience
  }
  return !branchExisted;
}

/**
 * Create worktree for fork PR using synthetic review branch
 */
async function createFromForkPR(
  request: PRIsolationRequest,
  worktreePath: string,
  setupLockReason: string,
  remote = 'origin'
): Promise<WorktreeCreationEnvironment | null> {
  const repoPath = request.canonicalRepoPath;
  const prNumber = request.identifier;
  const reviewBranch = getForkReviewBranch(prNumber);
  const prSha = request.prSha;

  if (prSha) {
    // SHA provided: create at specific commit for reproducible reviews.
    await execFileAsync('git', ['-C', repoPath, 'fetch', remote, `pull/${prNumber}/head`], {
      timeout: GIT_OPERATION_TIMEOUT_MS,
    });

    await addLockedWorktree(repoPath, worktreePath, setupLockReason, [worktreePath, prSha]);

    await rollBackOnFailure(toRepoPath(repoPath), worktreePath, setupLockReason, async () => {
      if (await localBranchExists(repoPath, reviewBranch)) {
        await execFileAsync('git', ['-C', repoPath, 'branch', '-D', reviewBranch], {
          timeout: GIT_OPERATION_TIMEOUT_MS,
        });
      }
      await execFileAsync('git', ['-C', worktreePath, 'checkout', '-b', reviewBranch, prSha], {
        timeout: GIT_OPERATION_TIMEOUT_MS,
      });
    });
  } else {
    await fetchWithRetry(toRepoPath(repoPath), [remote, `pull/${prNumber}/head:${reviewBranch}`], {
      timeout: GIT_OPERATION_TIMEOUT_MS,
    });

    try {
      await addLockedWorktree(repoPath, worktreePath, setupLockReason, [
        worktreePath,
        reviewBranch,
      ]);
    } catch (error) {
      if (!(error instanceof WorktreeAddError) || !error.canAdoptConcurrentCheckout) throw error;
      try {
        const adopted = await findRegisteredWorktree(request, reviewBranch, true);
        if (adopted) return adopted;
      } catch (adoptionError) {
        getLog().warn(
          { repoPath, worktreePath, err: adoptionError },
          'worktree.concurrent_adoption_failed'
        );
      }
      throw error;
    }
  }

  return null;
}

/** Materialize an existing local branch without changing its history. */
export async function createFromExistingBranch(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  setupLockReason: string
): Promise<void> {
  try {
    await addLockedWorktree(repoPath, worktreePath, setupLockReason, [worktreePath, branchName]);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const wrapped = new Error(
      `Failed to check out existing branch '${branchName}': ${err.message}`,
      { cause: err }
    );
    const { cleanupFailure } = err as Error & { cleanupFailure?: string };
    if (cleanupFailure) recordCleanupFailure(wrapped, cleanupFailure);
    throw wrapped;
  }
}

/**
 * Create a worktree for a named branch. A branch that exists nowhere yet is cut from
 * the start point. A branch that already exists, locally or on the remote, is checked
 * out at its current head and never moved backwards: its commits may exist nowhere
 * else. Returns the cut-from commit (only for a branch cut here) and whether the local
 * branch was created here.
 */
export async function createNewBranch(
  request: IsolationRequest,
  repoPath: string,
  worktreePath: string,
  branchName: string,
  baseBranch: string,
  setupLockReason: string,
  remote = 'origin'
): Promise<{ cutFromCommit?: string; branchCreated: boolean }> {
  const fromBranch =
    request.workflowType === 'task' && request.taskBranch?.kind === 'new'
      ? request.taskBranch.fromBranch
      : undefined;
  const startPoint = fromBranch ?? `${remote}/${baseBranch}`;

  const localExists = await localBranchExists(repoPath, branchName);
  const remoteExists = await remoteBranchExists(repoPath, remote, branchName);
  if (!localExists && !remoteExists) {
    return cutBranch(repoPath, worktreePath, branchName, startPoint, setupLockReason);
  }

  if (fromBranch) {
    throw new IsolationFailure(
      'branch_exists',
      `Branch "${branchName}" already exists. Cannot create it from "${fromBranch}". ` +
        'Either choose a different --branch name or omit --from.'
    );
  }

  const remoteRef = `${remote}/${branchName}`;
  const source = remoteExists
    ? await catchUpWithRemote(repoPath, remote, branchName, localExists)
    : 'local';

  getLog().info({ branchName, source, repoPath }, 'worktree.existing_branch_checked_out');
  await addLockedWorktree(
    repoPath,
    worktreePath,
    setupLockReason,
    source === 'remote'
      ? ['--track', worktreePath, '-b', branchName, remoteRef]
      : [worktreePath, branchName]
  );
  return { branchCreated: source === 'remote' };
}

async function cutBranch(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  startPoint: string,
  setupLockReason: string
): Promise<{ cutFromCommit: string; branchCreated: true }> {
  // --no-track prevents gh from resolving this branch to the base branch's PR.
  await addLockedWorktree(repoPath, worktreePath, setupLockReason, [
    '--no-track',
    worktreePath,
    '-b',
    branchName,
    startPoint,
  ]);
  // The branch was created at its start point a moment ago and nothing has written to
  // it since, so its commit IS the cut-from commit -- read from the branch itself rather
  // than re-resolving a start ref that may have moved in between.
  const { stdout: cutFrom } = await rollBackOnFailure(
    toRepoPath(repoPath),
    worktreePath,
    setupLockReason,
    () =>
      execFileAsync('git', ['-C', worktreePath, 'rev-parse', '--verify', 'HEAD^{commit}'], {
        timeout: GIT_OPERATION_TIMEOUT_MS,
      })
  );
  return { cutFromCommit: cutFrom.trim(), branchCreated: true };
}

/**
 * Bring the local branch level with a branch that exists on the remote, and
 * say where the checkout comes from. A diverged pair is refused.
 */
async function catchUpWithRemote(
  repoPath: string,
  remote: string,
  branchName: string,
  localExists: boolean
): Promise<'local' | 'remote' | 'fast_forwarded'> {
  const localRefName = `refs/heads/${branchName}`;
  const remoteRefName = `refs/remotes/${remote}/${branchName}`;
  await fetchWithRetry(toRepoPath(repoPath), [remote, `+${localRefName}:${remoteRefName}`], {
    timeout: GIT_OPERATION_TIMEOUT_MS,
  });
  if (!localExists) return 'remote';

  const { stdout: counts } = await execFileAsync(
    'git',
    ['-C', repoPath, 'rev-list', '--left-right', '--count', `${localRefName}...${remoteRefName}`],
    { timeout: GIT_OPERATION_TIMEOUT_MS }
  );
  const [localOnly, remoteOnly] = counts.trim().split(/\s+/).map(Number);
  if (localOnly > 0 && remoteOnly > 0) {
    throw new ExistingBranchDivergedError(
      branchName,
      `${remote}/${branchName}`,
      localOnly,
      remoteOnly
    );
  }
  if (remoteOnly === 0) return 'local';
  // A local-repo fetch without `+` only fast-forwards, and git refuses it for a
  // branch checked out in another worktree, so it cannot discard or move work
  // that changed after the commit count.
  await fetchWithRetry(toRepoPath(repoPath), ['.', `${remoteRefName}:${localRefName}`], {
    timeout: GIT_OPERATION_TIMEOUT_MS,
  });
  return 'fast_forwarded';
}

/**
 * Delete a branch and track the result. Never throws - branch deletion is best-effort.
 * Returns true if branch was deleted or already gone, false if deletion failed.
 */
export async function deleteBranchTracked(
  repoPath: string,
  branchName: string,
  result: DestroyResult
): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'branch', '-D', branchName], {
      timeout: GIT_OPERATION_TIMEOUT_MS,
    });
    getLog().debug({ repoPath, branchName }, 'branch_deleted');
    return true;
  } catch (error) {
    const err = error as Error;
    try {
      if (!(await localBranchExists(repoPath, branchName))) return true;
      const checkedOut = (await listWorktrees(toRepoPath(repoPath))).some(
        w => w.branch === branchName
      );
      if (checkedOut) {
        result.warnings.push(
          `Cannot delete branch '${branchName}': branch is checked out elsewhere`
        );
        return false;
      }
    } catch (inspectionError) {
      getLog().warn(
        { err: inspectionError, repoPath, branchName },
        'branch_delete_inspection_failed'
      );
    }
    result.warnings.push(`Unexpected error deleting branch '${branchName}': ${err.message}`);
    getLog().error({ err, repoPath, branchName }, 'branch_delete_failed');
    return false;
  }
}

/**
 * Delete a remote branch and track the result. Never throws - remote branch deletion is best-effort.
 * Returns true if branch was deleted or already gone, false if deletion failed.
 */
export async function deleteRemoteBranchTracked(
  repoPath: string,
  branchName: string,
  result: DestroyResult,
  remote = 'origin'
): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'push', remote, '--delete', branchName], {
      timeout: GIT_OPERATION_TIMEOUT_MS,
    });
    getLog().debug({ repoPath, branchName }, 'remote_branch_deleted');
    return true;
  } catch (error) {
    const err = error as Error;
    try {
      if (!(await remoteBranchExists(repoPath, remote, branchName))) return true;
    } catch (inspectionError) {
      getLog().warn(
        { err: inspectionError, repoPath, branchName },
        'remote_branch_delete_inspection_failed'
      );
    }
    result.warnings.push(`Failed to delete remote branch '${branchName}': ${err.message}`);
    getLog().error({ err, repoPath, branchName }, 'remote_branch_delete_failed');
    return false;
  }
}

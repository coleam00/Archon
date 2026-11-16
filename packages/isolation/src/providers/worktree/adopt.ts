/**
 * Finding an existing checkout for a request and handing it to a run, once it
 * is proven to belong to the same repository and to be finished.
 */

import {
  addSafeDirectory,
  execFileAsync,
  findWorktreeByBranch,
  getCurrentBranchStrict,
  isAncestorOf,
  listWorktrees,
  toBranchName,
  toRepoPath,
  toWorktreePath,
  verifyWorktreeOwnership,
  worktreeExists,
} from '@archon/git';
import type { BranchName, RepoPath, WorktreePath } from '@archon/git';
import { IsolationFailure } from '../../errors';
import type { IsolationRequest, WorktreeCreationEnvironment } from '../../types';
import { isPRIsolationRequest } from '../../types';
import { refuseUnfinishedWorktree } from './setup-lock';
import { getForkReviewBranch, getLog } from './shared';

/**
 * Find existing worktree for adoption
 */
export async function findExisting(
  request: IsolationRequest,
  branchName: string,
  worktreePath: string
): Promise<WorktreeCreationEnvironment | null> {
  const exactTaskBranch =
    request.workflowType === 'task' && request.taskBranch?.kind === 'existing'
      ? request.taskBranch.branch
      : undefined;
  const exactBranch = isPRIsolationRequest(request)
    ? request.isForkPR
      ? getForkReviewBranch(request.identifier)
      : request.prBranch
    : exactTaskBranch;
  // Check if worktree already exists at expected path
  if (await worktreeExists(toWorktreePath(worktreePath))) {
    return adoptAtPath(request, branchName, toWorktreePath(worktreePath), exactBranch);
  }

  // Exact-branch requests also search Git's registered worktrees because an
  // external tool may have created the checkout at a non-Archon path.
  if (exactBranch) {
    const requireExactBranch =
      exactTaskBranch !== undefined || (isPRIsolationRequest(request) && request.isForkPR);
    return findRegisteredWorktree(request, exactBranch, requireExactBranch);
  }

  return null;
}

async function adoptAtPath(
  request: IsolationRequest,
  branchName: string,
  worktreePath: WorktreePath,
  exactBranch: BranchName | undefined
): Promise<WorktreeCreationEnvironment> {
  await addSafeDirectory(toRepoPath(worktreePath));
  // Two clones of the same remote resolve to the same worktree base dir, so a
  // worktree created from clone A is visible from clone B. Refusing it is safer
  // than falling through to createNewBranch (which would report a confusing
  // "branch already exists" cascade) or silently adopting.
  await verifySameRepository(request, branchName, worktreePath);

  const expectedBranch =
    exactBranch ?? (request.workflowType === 'task' ? request.taskBranch?.branch : undefined);
  if (expectedBranch) {
    const actualBranch = await getCurrentBranchStrict(worktreePath);
    if (actualBranch !== expectedBranch) {
      throw new IsolationFailure(
        'adoption_refused',
        `Cannot adopt worktree at '${worktreePath}': expected branch ` +
          `'${expectedBranch}', found '${actualBranch ?? 'detached HEAD'}'.`
      );
    }
  }
  if (request.workflowType === 'task' && request.taskBranch?.kind === 'new') {
    const { fromBranch } = request.taskBranch;
    if (fromBranch) {
      await refuseUnappliedStartPoint(
        request.canonicalRepoPath,
        worktreePath,
        expectedBranch ?? branchName,
        fromBranch
      );
    }
  }

  return adoptWorktree(worktreePath, exactBranch ?? toBranchName(branchName), request);
}

/**
 * Refuse to hand an existing checkout to a request that named a start point the
 * checkout's history does not contain: the run would start from a different base
 * than asked. A start point at or behind HEAD is accepted, so later stages that
 * pass the same start point keep working once the branch has its own commits.
 * The start point resolves in the canonical repository, where creation resolves
 * it; resolved inside the worktree, `HEAD` or `HEAD~1` would name the worktree's
 * own commits and always pass. Only reads; the operator owns the worktree and branch.
 */
export async function refuseUnappliedStartPoint(
  repoPath: RepoPath,
  worktreePath: WorktreePath,
  branch: string,
  fromBranch: string
): Promise<void> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', repoPath, 'rev-parse', '--verify', '--end-of-options', `${fromBranch}^{commit}`],
    { timeout: 10000 }
  );
  const fromCommit = stdout.trim();
  if (await isAncestorOf(worktreePath, fromCommit)) return;

  const base = await execFileAsync('git', ['-C', worktreePath, 'merge-base', 'HEAD', fromCommit], {
    timeout: 10000,
  });
  throw new IsolationFailure(
    'branch_exists',
    `Branch "${branch}" already has a worktree at ${worktreePath}, ` +
      `based on ${base.stdout.trim().slice(0, 12)}. ` +
      `--from ${fromBranch} (${fromCommit.slice(0, 12)}) is not in its history, ` +
      'so the run would start from a different base. Choose a different --branch, ' +
      'omit --from to continue in this worktree, or remove the worktree and delete the ' +
      `branch to start fresh from ${fromBranch}.`
  );
}

export async function findRegisteredWorktree(
  request: IsolationRequest,
  branchName: BranchName,
  requireExactBranch = false
): Promise<WorktreeCreationEnvironment | null> {
  const worktreePath = requireExactBranch
    ? ((await listWorktrees(request.canonicalRepoPath)).find(
        worktree => worktree.branch === branchName
      )?.path ?? null)
    : await findWorktreeByBranch(request.canonicalRepoPath, branchName);
  if (!worktreePath) {
    return null;
  }

  await addSafeDirectory(toRepoPath(worktreePath));
  await verifySameRepository(request, branchName, worktreePath);
  return adoptWorktree(worktreePath, branchName, request, 'branch');
}

/**
 * Throws on a checkout of another repository root, or one whose ownership
 * cannot be verified.
 */
async function verifySameRepository(
  request: IsolationRequest,
  branchName: string,
  worktreePath: WorktreePath
): Promise<void> {
  try {
    await verifyWorktreeOwnership(worktreePath, request.canonicalRepoPath);
  } catch (err) {
    getLog().warn(
      {
        worktreePath,
        branchName,
        codebaseId: request.codebaseId,
        canonicalRepoPath: request.canonicalRepoPath,
        err: (err as Error).message,
      },
      'worktree.adoption_refused_cross_checkout'
    );
    throw err;
  }
}

/**
 * Hand an existing checkout to a run, once it is proven usable.
 *
 * An existing checkout may still belong to a setup in progress or a failed
 * setup attempt, so it must pass the setup completeness check first.
 */
async function adoptWorktree(
  path: string,
  branchName: string,
  request: IsolationRequest,
  adoptedFrom?: 'branch'
): Promise<WorktreeCreationEnvironment> {
  await refuseUnfinishedWorktree(path);
  getLog().warn(
    {
      worktreePath: path,
      branchName,
      codebaseId: request.codebaseId,
      workflowType: request.workflowType,
      identifier: request.identifier,
    },
    'worktree_adopted'
  );
  return {
    id: path,
    provider: 'worktree',
    workingPath: path,
    branchName: toBranchName(branchName),
    status: 'active',
    createdAt: new Date(),
    metadata: {
      provenance: 'adopted',
      adopted: true,
      ...(adoptedFrom ? { adoptedFrom } : {}),
      request,
    },
  };
}

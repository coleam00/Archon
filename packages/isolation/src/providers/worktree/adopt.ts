/**
 * Finding an existing checkout for a request and handing it to a run, once it
 * is proven to belong to the same repository and to be finished.
 */

import {
  GitFailure,
  addSafeDirectory,
  findWorktreeByBranch,
  getCurrentBranchStrict,
  isSameWorktreePath,
  listWorktrees,
  toBranchName,
  toRepoPath,
  toWorktreePath,
  verifyWorktreeOwnership,
  worktreeExists,
} from '@archon/git';
import type { BranchName, RepoPath, WorktreeInfo, WorktreePath } from '@archon/git';
import { IsolationFailure } from '../../errors';
import type {
  IsolatedEnvironment,
  IsolationRequest,
  WorktreeCreationEnvironment,
} from '../../types';
import { isPRIsolationRequest } from '../../types';
import { refuseUnfinishedWorktree } from './setup-lock';
import { getForkReviewBranch, getGitCommandAnchors, getLog } from './shared';

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

  if (exactBranch) {
    const actualBranch = await getCurrentBranchStrict(worktreePath);
    if (actualBranch !== exactBranch) {
      throw new IsolationFailure(
        'adoption_refused',
        `Cannot adopt worktree at '${worktreePath}': expected branch ` +
          `'${exactBranch}', found '${actualBranch ?? 'detached HEAD'}'.`
      );
    }
  }

  return adoptWorktree(worktreePath, exactBranch ?? toBranchName(branchName), request);
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
 * setup attempt. It must pass the same completeness check as public `adopt()`.
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

/** `WorktreeProvider.adopt()`: adopt a checkout by path, outside any request. */
export async function adoptPath(path: string): Promise<IsolatedEnvironment | null> {
  if (!(await worktreeExists(toWorktreePath(path)))) {
    return null;
  }

  await addSafeDirectory(toRepoPath(path));
  let repoPath: RepoPath;
  let worktrees: WorktreeInfo[];
  try {
    repoPath = (await getGitCommandAnchors(path)).active;
    worktrees = await listWorktrees(repoPath);
  } catch (error) {
    if (error instanceof GitFailure && error.kind === 'not_repository') return null;
    throw error;
  }

  const wt = worktrees.find(w => isSameWorktreePath(w.path, path));

  if (!wt) {
    // Worktree directory exists but isn't registered with git - possible corruption
    getLog().warn(
      { path, repoPath, registeredWorktreeCount: worktrees.length },
      'worktree_adopt_not_registered'
    );
    return null;
  }

  await refuseUnfinishedWorktree(path);
  getLog().warn({ worktreePath: path, branchName: wt.branch }, 'worktree_adopted');
  return {
    id: path,
    provider: 'worktree',
    workingPath: path,
    branchName: toBranchName(wt.branch),
    status: 'active',
    createdAt: new Date(),
    metadata: { provenance: 'adopted', adopted: true },
  };
}

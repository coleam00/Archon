import { getIsolationProvider, refuseUnappliedStartPoint } from '@archon/isolation';
import type { IsolationEnvironmentRow } from '@archon/isolation';
import * as git from '@archon/git';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import type { Codebase } from '@archon/core/schemas/codebase';
import type { AdoptionLane } from '@archon/core/operations/workflow-adoption';
import type { WorkflowRunOptions } from './workflow-shared';

/**
 * The healthy registered worktree a `--branch` run reuses, or undefined when there is none
 * and the run cuts one. Refuses one on another branch, or one whose history lacks
 * `--from`. Only reads: a detached launcher calls it before the fork, and the child calls
 * it again against the live checkout.
 */
export async function reusedBranchWorktree(
  existingEnv: IsolationEnvironmentRow | null | undefined,
  codebase: Codebase,
  branch: string,
  fromBranch: string | undefined
): Promise<IsolationEnvironmentRow | undefined> {
  if (!existingEnv || !(await getIsolationProvider().healthCheck(existingEnv.working_path))) {
    return undefined;
  }
  const worktreePath = git.toWorktreePath(existingEnv.working_path);
  const actualBranch = await git.getCurrentBranchStrict(worktreePath);
  if (actualBranch !== branch) {
    throw new Error(
      `Cannot reuse worktree at '${existingEnv.working_path}': expected branch ` +
        `'${branch}', found '${actualBranch ?? 'detached HEAD'}'.`
    );
  }
  const startPoint = fromBranch?.trim();
  if (startPoint) {
    await refuseUnappliedStartPoint(
      git.toRepoPath(codebase.default_cwd),
      worktreePath,
      branch,
      startPoint
    );
  }
  return existingEnv;
}

/**
 * The worktree-reuse refusals a detached child makes, read before the fork so a --json
 * caller gets them as the result (#5783). Looks up the branch's worktree exactly when a
 * foreground run does: after adoption has set or cleared isolation.
 */
export async function refuseUnreusableBranchWorktree(
  host: WorkflowHost,
  codebase: Codebase | null,
  options: Pick<WorkflowRunOptions, 'branchName' | 'fromBranch'>,
  lane: { isFolder: boolean; wantsIsolation: boolean; adoption: AdoptionLane | undefined }
): Promise<void> {
  const isolates =
    lane.adoption?.kind === 'checkout-branch' ||
    (lane.wantsIsolation && lane.adoption?.kind !== 'reuse-worktree');
  if (!isolates || lane.isFolder || !codebase || !options.branchName) return;
  await reusedBranchWorktree(
    await host.records.isolation.findActiveByWorkflow(codebase.id, 'task', options.branchName),
    codebase,
    options.branchName,
    options.fromBranch
  );
}

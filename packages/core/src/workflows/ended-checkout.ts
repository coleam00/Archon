/**
 * The checkout a run left when it ended, for a run-ended binding with
 * `checkout: "ended-run"` or an asks-settled binding with `checkout: "asking-run"`: its
 * worktree's branch and the commit it ended on. Resolved in the completion, before the
 * write that ends the run, so the start records the commit the run actually ended on.
 */
import { existsSync } from 'node:fs';
import { execFileAsync, getCurrentBranchStrict, toRepoPath } from '@archon/git';
import type { IsolationEnvironmentRow } from '@archon/isolation/types';
import { readCheckoutHandoff, type EndedCheckout } from '@archon/workflows/schemas/resource-start';
import type { WorkflowRun } from '@archon/workflows/schemas/workflow-run';

export interface EndedCheckoutDependencies {
  findEnvironmentByPath: (
    codebaseId: string,
    workingPath: string,
    createdBefore: Date
  ) => Promise<IsolationEnvironmentRow | null>;
}

export function createEndedCheckout(
  deps: EndedCheckoutDependencies
): (run: WorkflowRun) => Promise<EndedCheckout> {
  return async run => {
    // A run that worked on a copy hands on what it was given: the branch it read is the
    // source's, and the copy's own branch is a throwaway nobody continues.
    const given = readCheckoutHandoff(run);
    if (given?.lane === 'copy')
      return { handoff: { runId: given.runId, branch: given.branch, commit: given.commit } };

    const path = run.working_path;
    if (!path || !run.codebase_id)
      return { refused: `run '${run.id}' has no recorded checkout, so it left no branch` };
    const env = await deps.findEnvironmentByPath(run.codebase_id, path, new Date());
    if (!env) return { refused: `run '${run.id}' ran in place at '${path}', so it left no branch` };
    if (env.provider !== 'worktree')
      return { refused: `run '${run.id}' ran in a ${env.provider} environment, not a worktree` };
    if (env.status !== 'active' || !existsSync(path))
      return { refused: `the worktree run '${run.id}' worked in at '${path}' is gone` };
    if (!env.branch_name)
      return { refused: `the worktree of run '${run.id}' at '${path}' has no recorded branch` };
    let current: string | null;
    let commit: string;
    try {
      current = await getCurrentBranchStrict(toRepoPath(path));
      commit = (
        await execFileAsync('git', ['-C', path, 'rev-parse', '--verify', 'HEAD^{commit}'], {
          timeout: 10000,
        })
      ).stdout.trim();
    } catch (error) {
      return {
        refused: `the checkout of run '${run.id}' at '${path}' could not be read: ${(error as Error).message}`,
      };
    }
    if (current !== env.branch_name)
      return {
        refused: `the worktree of run '${run.id}' at '${path}' is on ${current ? `'${current}'` : 'a detached HEAD'}, not its branch '${env.branch_name}'`,
      };
    return { handoff: { runId: run.id, branch: env.branch_name, commit } };
  };
}

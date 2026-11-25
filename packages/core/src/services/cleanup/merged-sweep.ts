import type { IsolationEnvironmentRow, PrLookup } from '@archon/isolation';
import { toBranchName, toRepoPath, toWorktreePath } from '@archon/git';
import type { RepoPath } from '@archon/git';
import { loadRepoConfig } from '../../config/config-loader';
import { getRegisteredPlatformPolicies, unknownPlatformReason } from '../../platforms/registry';
import * as isolationEnvDb from '../../db/isolation-environments';
import {
  judgeBranchForRemoval,
  NO_MERGE_REMOTE_REASON,
  resolveMergeRemote,
  skipReasonFor,
  type MergeVerdict,
} from './merge-verdict';
import { checkRemoval, type ReleasedFailedRun } from './run-lock';
import {
  incompleteRemovalReason,
  removeEnvironment,
  type RemoveEnvironmentResult,
} from './remove-environment';
import { checkoutExists } from './checkout-presence';
import { getLog } from './log';

/**
 * Result from cleanup operations with detailed information
 */
export interface CleanupOperationResult {
  errors: { branchName: string; error: string }[];
  removed: string[];
  warnings: { branchName: string; message: string }[];
  skipped: { branchName: string; reason: string }[];
  /** Removed environments that a failed run no longer locked. */
  releasedFailedRuns: ({ branchName: string } & ReleasedFailedRun)[];
}

export function recordCleanupRemoval(
  result: CleanupOperationResult,
  branchName: string,
  removal: RemoveEnvironmentResult,
  released: ReleasedFailedRun | null
): void {
  result.warnings.push(...removal.warnings.map(message => ({ branchName, message })));
  const error = incompleteRemovalReason(removal);
  if (error) {
    result.errors.push({ branchName, error });
  } else if (removal.skippedReason) {
    result.skipped.push({ branchName, reason: removal.skippedReason });
  } else {
    result.removed.push(branchName);
    if (released) result.releasedFailedRuns.push({ branchName, ...released });
  }
}

/** One codebase's merged cleanup: swept, or not checked because its checkout is gone. */
export type MergedCleanupOutcome =
  | { kind: 'swept'; result: CleanupOperationResult }
  | {
      kind: 'repository-gone';
      environments: { branchName: string; workingPath: string }[];
    };

/** What every environment in one merged sweep is judged against. */
interface MergedSweep {
  repoPath: RepoPath;
  mainRepoPath: string;
  remote: string;
  includeClosed: boolean;
  prStateCache: Map<string, PrLookup>;
  result: CleanupOperationResult;
}

/**
 * Remove a codebase's worktree environments whose branches are merged, keeping any with
 * uncommitted changes or a live workflow run. Every route into the merged sweep calls this.
 *
 * A checkout directory that does not exist is reported, not swept: every Git check
 * would fail, and whether the project was deleted or its disk is unmounted is the
 * operator's call. A checkout that exists but cannot be read still fails the sweep.
 * A repository with no merge remote (see resolveMergeRemote) keeps every environment.
 */
export async function cleanupMergedWorktrees(
  codebaseId: string,
  mainRepoPath: string,
  options: { includeClosed?: boolean } = {}
): Promise<MergedCleanupOutcome> {
  getRegisteredPlatformPolicies();
  const environments = (await isolationEnvDb.listByCodebase(codebaseId)).filter(
    env => env.provider === 'worktree'
  );
  if (!(await checkoutExists(mainRepoPath))) {
    getLog().warn(
      { codebaseId, repoPath: mainRepoPath, environments: environments.length },
      'isolation.merged_cleanup_repository_gone'
    );
    return {
      kind: 'repository-gone',
      environments: environments.map(env => ({
        branchName: env.branch_name,
        workingPath: env.working_path,
      })),
    };
  }
  const result: CleanupOperationResult = {
    errors: [],
    removed: [],
    warnings: [],
    skipped: [],
    releasedFailedRuns: [],
  };
  // No worktree to judge: a folder project with only containers has no Git to ask.
  if (environments.length === 0) return { kind: 'swept', result };
  const repoPath = toRepoPath(mainRepoPath);
  const remote = await resolveMergeRemote(repoPath, await loadRepoConfig(mainRepoPath));
  if (!remote) {
    getLog().info(
      { codebaseId, repoPath: mainRepoPath, environments: environments.length },
      'isolation.merged_cleanup_no_remote'
    );
  }
  const sweep: MergedSweep | null = remote
    ? {
        repoPath,
        mainRepoPath,
        remote,
        includeClosed: options.includeClosed ?? false,
        prStateCache: new Map<string, PrLookup>(),
        result,
      }
    : null;

  for (const env of environments) {
    const reason = unknownPlatformReason(env.created_by_platform);
    if (reason || !sweep) {
      result.skipped.push({
        branchName: env.branch_name,
        reason: reason ?? NO_MERGE_REMOTE_REASON,
      });
      continue;
    }
    const verdict = await judgeMergedEnvironment(env, sweep);
    if (verdict === 'merged' || verdict === 'pr-closed') {
      await removeMergedEnvironment(env, verdict, sweep);
    } else if (verdict) {
      const skipReason =
        verdict === 'unmerged'
          ? 'no cleanup evidence covers all local tips'
          : skipReasonFor(verdict);
      if (skipReason) result.skipped.push({ branchName: env.branch_name, reason: skipReason });
    }
  }

  return { kind: 'swept', result };
}

/** The environment's merge verdict, or null when the check failed and is recorded as an error. */
async function judgeMergedEnvironment(
  env: IsolationEnvironmentRow,
  sweep: MergedSweep
): Promise<MergeVerdict | null> {
  try {
    return await judgeBranchForRemoval({
      repoPath: sweep.repoPath,
      branchName: toBranchName(env.branch_name),
      prStateCache: sweep.prStateCache,
      remote: sweep.remote,
      includeClosed: sweep.includeClosed,
      worktreePath: toWorktreePath(env.working_path),
    });
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      { err, branchName: env.branch_name, repoPath: sweep.mainRepoPath },
      'cleanup.merge_check_failed'
    );
    sweep.result.errors.push({
      branchName: env.branch_name,
      error: `merge check failed: ${err.message}`,
    });
    return null;
  }
}

async function removeMergedEnvironment(
  env: IsolationEnvironmentRow,
  verdict: 'merged' | 'pr-closed',
  sweep: MergedSweep
): Promise<void> {
  try {
    const check = await checkRemoval(env, sweep.repoPath, { kind: verdict });
    if (check.blocker) {
      sweep.result.skipped.push({ branchName: env.branch_name, reason: check.blocker.display });
      return;
    }
    const removeResult = await removeEnvironment(env, {
      deleteRemoteBranch: true,
    });
    recordCleanupRemoval(sweep.result, env.branch_name, removeResult, check.released);
  } catch (error) {
    const err = error as Error;
    sweep.result.errors.push({ branchName: env.branch_name, error: err.message });
  }
}

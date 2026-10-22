import type { IsolationEnvironmentRow, PrLookup } from '@archon/isolation';
import { toBranchName, toRepoPath, toWorktreePath } from '@archon/git';
import type { BranchName, RepoPath } from '@archon/git';
import { getRegisteredPlatformPolicies, unknownPlatformReason } from '../../platforms/registry';
import * as isolationEnvDb from '../../db/isolation-environments';
import {
  judgeBranchForRemoval,
  resolveRepoGitContext,
  skipReasonFor,
  type MergeVerdict,
} from './merge-verdict';
import { checkRemoval, type ReleasedFailedRun } from './run-lock';
import {
  incompleteRemovalReason,
  removeEnvironment,
  type RemoveEnvironmentResult,
} from './remove-environment';
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

/**
 * A merged-cleanup result. Carries the base ref the merge decision actually
 * compared against so callers report the repo's configured base branch instead
 * of guessing at one.
 */
export interface MergedCleanupResult extends CleanupOperationResult {
  baseRef: BranchName;
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

/** What every environment in one merged sweep is judged against. */
interface MergedSweep {
  repoPath: RepoPath;
  mainRepoPath: string;
  remote: string;
  includeClosed: boolean;
  prStateCache: Map<string, PrLookup>;
  result: MergedCleanupResult;
}

/**
 * Clean up merged worktrees for a codebase
 * Respects uncommitted changes and live workflow runs
 */
export async function cleanupMergedWorktrees(
  codebaseId: string,
  mainRepoPath: string,
  options: { includeClosed?: boolean } = {}
): Promise<MergedCleanupResult> {
  getRegisteredPlatformPolicies();
  const environments = (await isolationEnvDb.listByCodebase(codebaseId)).filter(
    env => env.provider === 'worktree'
  );
  const repoPath = toRepoPath(mainRepoPath);
  const { remoteMainRef, remote } = await resolveRepoGitContext(repoPath, mainRepoPath);
  const sweep: MergedSweep = {
    repoPath,
    mainRepoPath,
    remote,
    includeClosed: options.includeClosed ?? false,
    prStateCache: new Map<string, PrLookup>(),
    result: {
      errors: [],
      removed: [],
      warnings: [],
      skipped: [],
      releasedFailedRuns: [],
      baseRef: remoteMainRef,
    },
  };

  for (const env of environments) {
    const reason = unknownPlatformReason(env.created_by_platform);
    if (reason) {
      sweep.result.skipped.push({ branchName: env.branch_name, reason });
      continue;
    }
    const verdict = await judgeMergedEnvironment(env, sweep);
    if (verdict === 'merged' || verdict === 'pr-closed') {
      await removeMergedEnvironment(env, verdict, sweep);
    } else if (verdict) {
      const skipReason = skipReasonFor(verdict);
      if (skipReason)
        sweep.result.skipped.push({ branchName: env.branch_name, reason: skipReason });
    }
  }

  return sweep.result;
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
      baseRef: sweep.result.baseRef,
      prStateCache: sweep.prStateCache,
      includeClosed: sweep.includeClosed,
      remote: sweep.remote,
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

/**
 * Clean up to make room when limit reached (Phase 3D)
 * Attempts to remove merged branches first
 * Returns detailed results for user feedback
 */
export async function cleanupToMakeRoom(
  codebaseId: string,
  mainRepoPath: string
): Promise<CleanupOperationResult> {
  // Reuse the merged cleanup logic
  return cleanupMergedWorktrees(codebaseId, mainRepoPath);
}

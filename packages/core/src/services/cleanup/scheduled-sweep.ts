// One environment's pass through the scheduled cleanup cycle: a missing checkout,
// then a merged branch, then a stale one.
import { readWorktreeBranchCreated } from '@archon/isolation';
import type { PrLookup } from '@archon/isolation';
import {
  getLastCommitDate,
  toBranchName,
  toRepoPath,
  toWorktreePath,
  worktreeExists,
} from '@archon/git';
import type { RepoPath } from '@archon/git';
import { retainsWorkspace, unknownPlatformReason } from '../../platforms/registry';
import * as isolationEnvDb from '../../db/isolation-environments';
import { judgeBranchForRemoval, resolveRepoGitContext, skipReasonFor } from './merge-verdict';
import {
  checkRemoval,
  countUnpushedCommits,
  getLiveRunBlocker,
  toUnpushedLock,
  type ReleasedFailedRun,
  type RemovalBlocker,
} from './run-lock';
import {
  incompleteRemovalReason,
  removeEnvironment,
  type RemoveEnvironmentResult,
} from './remove-environment';
import { getLog } from './log';

export interface CleanupReport {
  removed: string[];
  skipped: { id: string; reason: string }[];
  errors: { id: string; error: string }[];
  sessionsDeleted: number;
  /** Removed environments that a failed run no longer locked, keyed by env id. */
  releasedFailedRuns: ({ id: string } & ReleasedFailedRun)[];
}

/** State one scheduled cycle shares across every environment it sweeps. */
export interface ScheduledSweep {
  staleDays: number;
  /** Keyed by repo + branch (see getPrState); the cycle spans every registered repo. */
  prStateCache: Map<string, PrLookup>;
  report: CleanupReport;
}

type SweptEnvironment = Awaited<
  ReturnType<typeof isolationEnvDb.listAllActiveWithCodebase>
>[number];

type RemovalTrigger = 'path missing' | 'merged' | 'stale';

function recordRemoval(
  report: CleanupReport,
  envId: string,
  removal: RemoveEnvironmentResult,
  reason: RemovalTrigger,
  released: ReleasedFailedRun | null = null
): void {
  const error = incompleteRemovalReason(removal);
  if (error) {
    report.errors.push({ id: envId, error });
  } else if (removal.skippedReason) {
    report.skipped.push({ id: envId, reason: removal.skippedReason });
  } else {
    report.removed.push(`${envId} (${reason})`);
    if (released) {
      report.releasedFailedRuns.push({ id: envId, ...released });
      getLog().info({ envId, ...released }, 'failed_run_lock_released');
    }
  }
}

/** Sweep one environment. A throw is the caller's to record; it leaves the env for the next cycle. */
export async function sweepScheduledEnvironment(
  env: SweptEnvironment,
  sweep: ScheduledSweep
): Promise<void> {
  // Skip if already processing or destroyed
  if (env.status !== 'active' || env.provider !== 'worktree') return;
  const reason = unknownPlatformReason(env.created_by_platform);
  if (reason) {
    sweep.report.skipped.push({ id: env.id, reason });
    return;
  }

  const pathExists = await worktreeExists(toWorktreePath(env.working_path));
  if (!pathExists && (await sweepMissingPath(env, sweep))) return;

  // Same merged decision the `--merged` sweep uses, PR state included: this
  // repository squash-merges every PR, and git alone cannot see that.
  const mainRepoPath = toRepoPath(env.codebase_default_cwd);
  const { remoteMainRef, remote } = await resolveRepoGitContext(
    mainRepoPath,
    env.codebase_default_cwd
  );
  // A throw here reaches the caller, which records the failure and leaves the
  // environment for the next cycle. It must not fall through to the staleness
  // sweep: an unresolved merge check would then be indistinguishable from
  // confirmed-unmerged work and lose its branch to age.
  const verdict = await judgeBranchForRemoval({
    repoPath: mainRepoPath,
    branchName: toBranchName(env.branch_name),
    baseRef: remoteMainRef,
    prStateCache: sweep.prStateCache,
    includeClosed: false,
    remote,
    worktreePath: toWorktreePath(env.working_path),
  });

  if (verdict === 'merged' || verdict === 'pr-closed') {
    await sweepMerged(env, mainRepoPath, verdict, sweep);
    return;
  }

  // The staleness sweep below deletes the branch on age alone, so only work
  // git or the PR settled as unmerged may reach it. An open PR or an
  // unverifiable merge state is reported and kept. The exception is a failed
  // run's environment with both worktree and branch gone: nothing local is
  // left to lose, so only the stale window settles its lock.
  const nothingLocalLeft = !pathExists && verdict === 'unjudgeable';
  const skipReason = nothingLocalLeft ? null : skipReasonFor(verdict);
  if (skipReason) {
    sweep.report.skipped.push({ id: env.id, reason: skipReason });
    return;
  }

  if (retainsWorkspace(env.created_by_platform)) return;
  await sweepStale(env, mainRepoPath, sweep);
}

/**
 * The checkout is gone from disk. True when this step settled the environment; false
 * hands a failed run's environment on to the merged and stale checks, which settle its
 * lock and handle a missing worktree.
 */
async function sweepMissingPath(env: SweptEnvironment, sweep: ScheduledSweep): Promise<boolean> {
  // Even with the directory gone, marking the env destroyed invalidates
  // the live run's resume handle.
  const liveRun = await getLiveRunBlocker(env.id);
  if (liveRun && !isolationEnvDb.isSettleableRunStatus(liveRun.runStatus)) {
    sweep.report.skipped.push({ id: env.id, reason: `path missing but ${liveRun.display}` });
    getLog().info(
      { envId: env.id, runId: liveRun.runId, runStatus: liveRun.runStatus },
      'skip_path_missing_live_run'
    );
    return true;
  }
  if (liveRun) return false;
  // Removal deletes a branch this environment created, so a branch holding
  // commits on no remote stays, as it does in the stale sweep.
  const commits = readWorktreeBranchCreated(env.metadata)
    ? await countUnpushedCommits(env, toRepoPath(env.codebase_default_cwd))
    : 0;
  if (commits > 0) {
    sweep.report.skipped.push({
      id: env.id,
      reason: `path missing but ${toUnpushedLock(env, null, commits).display}`,
    });
    return true;
  }
  const removeResult = await removeEnvironment(env, { force: false });
  recordRemoval(sweep.report, env.id, removeResult, 'path missing');
  return true;
}

async function sweepMerged(
  env: SweptEnvironment,
  mainRepoPath: RepoPath,
  verdict: 'merged' | 'pr-closed',
  sweep: ScheduledSweep
): Promise<void> {
  const check = await checkRemoval(env, mainRepoPath, { kind: verdict });
  if (check.blocker) {
    const { blocker } = check;
    sweep.report.skipped.push({ id: env.id, reason: `merged but ${blocker.display}` });
    if (blocker.reason === 'live_run') {
      getLog().info(
        { envId: env.id, runId: blocker.runId, runStatus: blocker.runStatus },
        'skip_merged_live_run'
      );
    } else {
      getLog().warn({ envId: env.id }, 'skip_merged_uncommitted_changes');
    }
    return;
  }

  const mergedResult = await removeEnvironment(env, {
    force: false,
    deleteRemoteBranch: true,
  });
  recordRemoval(sweep.report, env.id, mergedResult, 'merged', check.released);
}

async function sweepStale(
  env: SweptEnvironment,
  mainRepoPath: RepoPath,
  sweep: ScheduledSweep
): Promise<void> {
  if (!(await isEnvironmentStale(env, sweep.staleDays))) return;
  const check = await checkRemoval(env, mainRepoPath, {
    kind: 'stale',
    staleDays: sweep.staleDays,
  });
  if (check.blocker) {
    sweep.report.skipped.push({ id: env.id, reason: `stale but ${check.blocker.display}` });
    logStaleBlocker(env.id, check.blocker);
    return;
  }

  const staleResult = await removeEnvironment(env, {
    force: false,
  });
  recordRemoval(sweep.report, env.id, staleResult, 'stale', check.released);
}

function logStaleBlocker(envId: string, blocker: RemovalBlocker): void {
  switch (blocker.reason) {
    case 'live_run':
      getLog().info(
        { envId, runId: blocker.runId, runStatus: blocker.runStatus },
        'skip_stale_live_run'
      );
      break;
    case 'unpushed_commits':
      getLog().warn({ envId, runId: blocker.runId }, 'skip_stale_unpushed_commits');
      break;
    case 'uncommitted_changes':
      getLog().warn({ envId }, 'skip_stale_uncommitted_changes');
      break;
  }
}

/**
 * Check if an environment is stale based on activity
 */
async function isEnvironmentStale(env: SweptEnvironment, staleDays: number): Promise<boolean> {
  // Check last commit date in the worktree
  const lastCommit = await getLastCommitDate(toWorktreePath(env.working_path));
  if (lastCommit) {
    const daysSinceCommit = (Date.now() - lastCommit.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCommit < staleDays) {
      return false; // Recent commit activity
    }
  }

  // Check environment creation date as fallback
  const daysSinceCreation =
    (Date.now() - new Date(env.created_at).getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceCreation >= staleDays;
}

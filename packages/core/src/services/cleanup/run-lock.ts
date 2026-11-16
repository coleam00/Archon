import type { IsolationEnvironmentRow } from '@archon/isolation';
import {
  countCommitsMissingFromRemotes,
  execFileAsync,
  hasUncommittedChangesStrict,
  localBranchExists,
  toBranchName,
  toWorktreePath,
  worktreeExists,
} from '@archon/git';
import type { RepoPath } from '@archon/git';
import * as isolationEnvDb from '../../db/isolation-environments';
import { getWaitingHandoffOfEnv, type WaitingHandoff } from '../../db/isolation-env-users';
import { loadRepoConfig } from '../../config/config-loader';
import { configuredRemote } from './merge-verdict';

export interface LiveRunBlocker {
  reason: 'live_run';
  display: string;
  runId: string;
  runStatus: string;
}

/** A start handed the environment's checkout that has not been admitted yet. Never settleable. */
export type HandoffBlocker = { reason: 'pending_handoff'; display: string } & WaitingHandoff;

/** Something that will still use the environment's checkout. */
export type UseBlocker = LiveRunBlocker | HandoffBlocker;

/**
 * The use lock removers report, with the refusal text chat, the CLI, and the sweeps
 * share: a workflow run that can still claim the environment — running, pending,
 * paused, or failed-but-resumable (see getLiveRunOwningEnv) — or else a start handed
 * its checkout that still waits (see getWaitingHandoffOfEnv). Historical conversation
 * references are data, not locks. A lookup failure throws; callers must refuse
 * removal rather than read it as "no use".
 */
export async function getUseBlocker(envId: string): Promise<UseBlocker | null> {
  const liveRun = await isolationEnvDb.getLiveRunOwningEnv(envId);
  return liveRun ? toLiveRunBlocker(liveRun) : getHandoffBlocker(envId);
}

/** The identifiers a log line records for a use lock. */
export function useBlockerLogFields(blocker: UseBlocker): Record<string, string> {
  if (blocker.reason === 'live_run') return { runId: blocker.runId, runStatus: blocker.runStatus };
  const { reason: _reason, display: _display, ...handoff } = blocker;
  return handoff;
}

async function getHandoffBlocker(envId: string): Promise<HandoffBlocker | null> {
  const handoff = await getWaitingHandoffOfEnv(envId);
  if (!handoff) return null;
  const from = `run ${handoff.fromRunId.slice(0, 8)}`;
  return {
    reason: 'pending_handoff',
    display:
      handoff.waitingFor === 'capacity'
        ? `start request ${handoff.requestId} handed this checkout by ${from} is queued (archon trigger withdraw ${handoff.requestId} releases it)`
        : `a start handed this checkout by ${from} is being prepared (receipt ${handoff.receiptId}, binding ${handoff.bindingId})`,
    ...handoff,
  };
}

function toLiveRunBlocker(run: { id: string; status: string }): LiveRunBlocker {
  return {
    reason: 'live_run',
    display: `run ${run.id.slice(0, 8)} is ${run.status}`,
    runId: run.id,
    runStatus: run.status,
  };
}

/**
 * What a cleanup sweep has established about an environment's outcome. A failed
 * run's lock lasts only until one of these holds.
 */
export type CleanupSettlement =
  | { kind: 'merged' }
  | { kind: 'pr-closed' }
  | { kind: 'stale'; staleDays: number };

export type FailedRunReleaseReason = 'merged' | 'PR closed' | 'stale';

export interface ReleasedFailedRun {
  runId: string;
  reason: FailedRunReleaseReason;
}

export type CleanupRunLock =
  | { kind: 'free' }
  | { kind: 'locked'; blocker: UseBlocker }
  | ({ kind: 'released' } & ReleasedFailedRun)
  | { kind: 'unpushed'; runId: string | null; commits: number; display: string };

const RELEASE_REASONS: Record<CleanupSettlement['kind'], FailedRunReleaseReason> = {
  merged: 'merged',
  'pr-closed': 'PR closed',
  stale: 'stale',
};

/**
 * The run lock a cleanup sweep must respect. Running, pending, and paused runs
 * always lock. A failed run locks until the sweep's settlement releases it (#4090):
 * Git integration, a merged or explicitly included closed PR, or inactivity past
 * the stale window. The run row is left as it is.
 *
 * Removal force-deletes a branch Archon created, so age alone never removes an
 * environment whose worktree HEAD or branch holds a commit on no remote, whether
 * or not a run owns it: that work stays until an operator removes it explicitly.
 * Merged or closed-PR settlement already proved coverage of both local tips.
 *
 * A start handed the checkout that still waits locks whatever the settlement: no
 * outcome of the run that handed it releases the stage it started.
 */
export async function getCleanupRunLock(
  env: { id: string; working_path: string; branch_name: string | null },
  repoPath: RepoPath,
  settlement: CleanupSettlement
): Promise<CleanupRunLock> {
  const owner = await isolationEnvDb.getLiveRunOwningEnv(env.id);
  if (owner) {
    if (!isolationEnvDb.isSettleableRunStatus(owner.status)) {
      return { kind: 'locked', blocker: toLiveRunBlocker(owner) };
    }
    const lock = await isolationEnvDb.getLiveRunOwningEnv(
      env.id,
      settlement.kind === 'stale' ? settlement : { kind: 'settled' }
    );
    if (lock) return { kind: 'locked', blocker: toLiveRunBlocker(lock) };
  }
  const handoff = await getHandoffBlocker(env.id);
  if (handoff) return { kind: 'locked', blocker: handoff };
  if (settlement.kind === 'stale') {
    const commits = await countUnpushedCommits(env, repoPath);
    if (commits > 0) return toUnpushedLock(env, owner?.id ?? null, commits);
  }
  return owner
    ? { kind: 'released', runId: owner.id, reason: RELEASE_REASONS[settlement.kind] }
    : { kind: 'free' };
}

export function toUnpushedLock(
  env: { branch_name: string | null },
  runId: string | null,
  commits: number
): Extract<CleanupRunLock, { kind: 'unpushed' }> {
  const count = `${String(commits)} unpushed commit(s)`;
  return {
    kind: 'unpushed',
    runId,
    commits,
    display: runId
      ? `failed run ${runId.slice(0, 8)} has ${count}`
      : `${count}; remove it explicitly with archon complete ${env.branch_name ?? '<branch>'} --force`,
  };
}

/** `liveTips` cover pushes no tracking ref records; a tip this clone lacks covers nothing. */
export async function countUnpushedCommits(
  env: { working_path: string; branch_name: string | null },
  repoPath: RepoPath,
  liveTips: readonly string[] = []
): Promise<number> {
  const branchRevs =
    env.branch_name && (await localBranchExists(repoPath, toBranchName(env.branch_name)))
      ? [`refs/heads/${env.branch_name}`]
      : [];
  const worktreePath = toWorktreePath(env.working_path);
  const [path, revs] = (await worktreeExists(worktreePath))
    ? [worktreePath, ['HEAD', ...branchRevs]]
    : [repoPath, branchRevs];
  const tracked = await countCommitsMissingFromRemotes(path, revs);
  if (tracked === 0 || liveTips.length === 0) return tracked;
  const { stdout } = await execFileAsync(
    'git',
    ['-C', path, 'rev-list', '--count', '--ignore-missing', '--stdin'],
    { timeout: 10000, input: [...revs, '--not', '--remotes', ...liveTips].join('\n') }
  );
  return parseInt(stdout.trim(), 10);
}

/** Remote branch tips, read only when tracking refs miss commits. Network: never call in a claim. */
export async function readLiveRemoteTips(
  env: IsolationEnvironmentRow,
  repo: RepoPath
): Promise<string[]> {
  if ((await countUnpushedCommits(env, repo)) === 0) return [];
  const remote = configuredRemote(await loadRepoConfig(repo));
  const live = ['-C', repo, 'ls-remote', '--quiet', '--', remote, 'refs/heads/*'];
  return (await execFileAsync('git', live, { timeout: 10000 })).stdout
    .split('\n')
    .map(line => line.split('\t')[0])
    .filter(Boolean);
}

/** Why an environment cannot be removed. */
export type RemovalBlocker =
  | { reason: 'uncommitted_changes'; display: string }
  | UseBlocker
  | { reason: 'unpushed_commits'; display: string; runId: string | null };

export type RemovalCheck =
  | { blocker: RemovalBlocker }
  | { blocker: null; released: ReleasedFailedRun | null };

/**
 * Whether a sweep may remove the environment. Checks uncommitted changes first
 * (avoids a DB query when changes are present), then the run lock. Historical
 * conversation references are data, not locks; see getLiveRunOwningEnv.
 */
export async function checkRemoval(
  env: { id: string; working_path: string; branch_name: string },
  repoPath: RepoPath,
  settlement: CleanupSettlement
): Promise<RemovalCheck> {
  const workingPath = toWorktreePath(env.working_path);
  if ((await worktreeExists(workingPath)) && (await hasUncommittedChangesStrict(workingPath))) {
    return { blocker: { reason: 'uncommitted_changes', display: 'has uncommitted changes' } };
  }
  const lock = await getCleanupRunLock(env, repoPath, settlement);
  switch (lock.kind) {
    case 'free':
      return { blocker: null, released: null };
    case 'released':
      return { blocker: null, released: { runId: lock.runId, reason: lock.reason } };
    case 'locked':
      return { blocker: lock.blocker };
    case 'unpushed':
      return {
        blocker: {
          reason: 'unpushed_commits',
          display: lock.display,
          runId: lock.runId,
        },
      };
  }
}

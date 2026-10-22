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
import { loadRepoConfig } from '../../config/config-loader';
import { configuredRemote } from './merge-verdict';

export interface LiveRunBlocker {
  reason: 'live_run';
  display: string;
  runId: string;
  runStatus: string;
}

/**
 * The live-run lock removers report: a workflow run that can still claim the
 * environment — running, pending, paused, or failed-but-resumable (see
 * getLiveRunOwningEnv) — with the refusal text chat, the CLI, and the sweeps share.
 * Historical conversation references are data, not locks. A lookup failure throws;
 * callers must refuse removal rather than read it as "no run".
 */
export async function getLiveRunBlocker(envId: string): Promise<LiveRunBlocker | null> {
  const liveRun = await isolationEnvDb.getLiveRunOwningEnv(envId);
  return liveRun ? toLiveRunBlocker(liveRun) : null;
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
  | { kind: 'locked'; blocker: LiveRunBlocker }
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
 * a merged or closed PR, or inactivity past the stale window. The run row is left
 * as it is.
 *
 * Removal force-deletes a branch Archon created, so age alone never removes an
 * environment whose worktree HEAD or branch holds a commit on no remote, whether
 * or not a run owns it: that work stays until an operator removes it explicitly.
 * The merged verdict already proved the PR head or the base covers both.
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
  | LiveRunBlocker
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

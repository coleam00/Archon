import { getPrState, getPrsForCommit } from '@archon/isolation';
import type { PrLookup } from '@archon/isolation';
import {
  execFileAsync,
  getDefaultBranch,
  isBranchMerged,
  isPatchEquivalent,
  isRevCoveredBy,
  localBranchExists,
  toBranchName,
  worktreeExists,
} from '@archon/git';
import type { BranchName, RepoPath, WorktreePath } from '@archon/git';
import { loadRepoConfig } from '../../config/config-loader';

/** Git context for a repo's cleanup operations, resolved from repo config. */
export interface RepoGitContext {
  /** Remote-qualified base ref (e.g. "origin/main"), kept current via `git fetch`. */
  remoteMainRef: BranchName;
  /** Configured remote name (worktree.remote). Always resolved to a string (defaults to 'origin'). */
  remote: string;
}

// Resolve the base branch and remote for a repo, preferring worktree.baseBranch /
// worktree.remote from .archon/config.yaml before falling back to runtime git
// detection. A reachable remote with a known symbolic HEAD is required unless
// worktree.baseBranch is configured.
// A missing config falls back to git detection; a config that fails to load
// throws, and cleanup surfaces that rather than working around it.
export async function resolveRepoGitContext(
  repoPath: RepoPath,
  cwd: string
): Promise<RepoGitContext> {
  const repoConfig = await loadRepoConfig(cwd);
  const remote = configuredRemote(repoConfig);
  const configured = repoConfig.worktree?.baseBranch?.trim();
  if (configured) {
    return { remoteMainRef: toBranchName(`${remote}/${configured}`), remote };
  }
  const branch = await getDefaultBranch(repoPath, remote);
  return { remoteMainRef: toBranchName(`${remote}/${branch}`), remote };
}

export function configuredRemote(repoConfig: Awaited<ReturnType<typeof loadRepoConfig>>): string {
  return repoConfig.worktree?.remote?.trim() || 'origin';
}

/**
 * How a branch's merge state came out, from the union of signals both cleanup
 * sweeps share:
 *   (a) git ancestry  — `git branch --merged` (fast-forward / merge commit)
 *   (b) git cherry    — patch-equivalent commits (single-commit squash merge)
 *   (c) the PR's state — the only signal that sees a multi-commit squash merge,
 *       and the only one left once the local branch ref is gone
 *
 * A MERGED or CLOSED PR only speaks for the commits it carried. Run branch names
 * are derived from the run identifier and get reused, and removal deletes both the
 * worktree and the branch, so every local tip that still exists (the worktree's
 * HEAD, and the branch ref) must be the PR's head commit or an ancestor of it.
 * Anything past the PR head is unmerged work. With neither left, the PR's state
 * stands alone.
 *
 * 'unjudgeable' is the dead end the git signals hit when the branch ref has been
 * deleted and no PR answers for the branch; 'pr-unavailable' is a PR lookup that
 * failed. Either way the worktree stays, and the caller reports it rather than
 * letting it read as ordinary unmerged work. 'merged' and 'pr-closed' are the two
 * reclaimable verdicts; a closed PR is reclaimable only with `includeClosed`.
 */
export type MergeVerdict =
  | 'merged'
  | 'pr-closed'
  | 'open-pr'
  | 'unmerged'
  | 'unjudgeable'
  | 'pr-unavailable';

export interface MergeJudgmentInput {
  repoPath: RepoPath;
  branchName: BranchName;
  baseRef: BranchName;
  prStateCache: Map<string, PrLookup>;
  includeClosed: boolean;
  remote: string;
  worktreePath: WorktreePath;
}

/** Which local tips of the branch still exist; removal deletes every one of them. */
interface LocalTips {
  refExists: boolean;
  hasWorktree: boolean;
}

export async function judgeBranchForRemoval(input: MergeJudgmentInput): Promise<MergeVerdict> {
  // Both git signals resolve the local branch ref, and `git cherry` fails outright
  // once it is gone, so ask git only while the ref is there. The PR lookup keys off
  // the branch name on the remote and needs no local ref at all.
  const refExists = await localBranchExists(input.repoPath, input.branchName);
  // Removal deletes the worktree too, so its HEAD must be covered by whatever proved
  // the merge. It can differ from the branch tip (a detached HEAD, a branch renamed
  // inside the worktree).
  const hasWorktree = await worktreeExists(input.worktreePath);
  const tips = { refExists, hasWorktree };
  if (await gitProvesMerged(input, tips)) return 'merged';
  return judgeByPr(input, tips);
}

async function gitProvesMerged(input: MergeJudgmentInput, tips: LocalTips): Promise<boolean> {
  const { repoPath, branchName, baseRef, worktreePath } = input;
  if (!tips.refExists) return false;
  const branchMerged =
    (await isBranchMerged(repoPath, branchName, baseRef)) ||
    (await isPatchEquivalent(repoPath, branchName, baseRef));
  if (!branchMerged) return false;
  if (!tips.hasWorktree) return true;
  // `git cherry <base> HEAD` answers for both git signals: an ancestor of the base
  // lists no commits, and a squash-merged commit lists as '-'. A HEAD it cannot
  // settle falls through to the PR, and an unanswerable one throws.
  return isPatchEquivalent(worktreePath, 'HEAD', baseRef, { throwOnExpectedError: true });
}

async function judgeByPr(input: MergeJudgmentInput, tips: LocalTips): Promise<MergeVerdict> {
  const { repoPath, branchName, prStateCache, includeClosed, remote } = input;
  const pr = await getPrState(branchName, repoPath, prStateCache, remote);
  if (pr.state === 'UNAVAILABLE') return 'pr-unavailable';
  if (pr.state === 'OPEN') return 'open-pr';
  if (
    (pr.state === 'MERGED' || (pr.state === 'CLOSED' && includeClosed)) &&
    (await prCoversTips(input, tips, pr.headSha))
  ) {
    return pr.state === 'CLOSED' ? 'pr-closed' : 'merged';
  }
  const commitVerdict = await judgeByCommit(input, tips);
  return commitVerdict ?? (pr.state !== 'NONE' || tips.refExists ? 'unmerged' : 'unjudgeable');
}

async function judgeByCommit(
  input: MergeJudgmentInput,
  tips: LocalTips
): Promise<MergeVerdict | null> {
  if (!tips.hasWorktree && !tips.refExists) return null;
  const { repoPath, branchName, remote, worktreePath } = input;
  const path = tips.hasWorktree ? worktreePath : repoPath;
  const rev = tips.hasWorktree ? 'HEAD' : `refs/heads/${branchName}`;
  const { stdout } = await execFileAsync(
    'git',
    ['-C', path, 'rev-parse', '--verify', `${rev}^{commit}`],
    { timeout: 10000 }
  );
  const candidates = await getPrsForCommit(stdout.trim(), repoPath, remote);
  if (candidates.state === 'UNAVAILABLE') return 'pr-unavailable';
  if (candidates.state === 'NONE') return null;
  for (const candidate of candidates.prs) {
    if (candidate.state === 'MERGED' && (await prCoversTips(input, tips, candidate.headSha)))
      return 'merged';
  }
  return candidates.prs.some(candidate => candidate.state === 'OPEN') ? 'open-pr' : null;
}

async function prCoversTips(
  input: MergeJudgmentInput,
  tips: LocalTips,
  headSha: string
): Promise<boolean> {
  const { repoPath, branchName, remote, worktreePath } = input;
  // Fetch/comparison failures throw: an unanswered inspection must keep the environment.
  if (tips.hasWorktree && !(await isRevCoveredBy(worktreePath, 'HEAD', headSha, remote)))
    return false;
  return (
    !tips.refExists || (await isRevCoveredBy(repoPath, `refs/heads/${branchName}`, headSha, remote))
  );
}

/** The operator-facing reason a kept environment is worth reporting, or null when it is ordinary unmerged work. */
export function skipReasonFor(
  verdict: Exclude<MergeVerdict, 'merged' | 'pr-closed'>
): string | null {
  switch (verdict) {
    case 'open-pr':
      return 'PR is open (active review)';
    case 'unjudgeable':
      return 'branch ref is gone and no PR was found — merge state unverifiable';
    case 'pr-unavailable':
      return 'PR state lookup failed — merge state unverifiable';
    case 'unmerged':
      return null;
  }
}

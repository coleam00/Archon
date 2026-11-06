import { getPrState, getPrsForCommit } from '@archon/isolation';
import type { PrLookup } from '@archon/isolation';
import {
  execFileAsync,
  getDefaultBranch,
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

/** Removal requires one merged PR head covering every existing local tip. */
export type MergeVerdict = 'merged' | 'open-pr' | 'unmerged' | 'unjudgeable' | 'pr-unavailable';

export interface MergeJudgmentInput {
  repoPath: RepoPath;
  branchName: BranchName;
  prStateCache: Map<string, PrLookup>;
  remote: string;
  worktreePath: WorktreePath;
}

/** Which local tips of the branch still exist; removal deletes every one of them. */
interface LocalTips {
  refExists: boolean;
  hasWorktree: boolean;
}

export async function judgeBranchForRemoval(input: MergeJudgmentInput): Promise<MergeVerdict> {
  const tips = {
    refExists: await localBranchExists(input.repoPath, input.branchName),
    hasWorktree: await worktreeExists(input.worktreePath),
  };
  const { repoPath, branchName, prStateCache, remote } = input;
  const pr = await getPrState(branchName, repoPath, prStateCache, remote);
  if (pr.state === 'UNAVAILABLE') return 'pr-unavailable';
  const errors: unknown[] = [];
  if (await mergedCandidateCovers(input, tips, pr, errors)) return 'merged';
  const commitVerdict = await judgeByCommit(input, tips, errors);
  if (commitVerdict === 'merged') return commitVerdict;
  if (errors.length) throw errors[0];
  if (commitVerdict === 'pr-unavailable') return commitVerdict;
  if (pr.state === 'OPEN' || commitVerdict === 'open-pr') return 'open-pr';
  return pr.state !== 'NONE' || tips.refExists ? 'unmerged' : 'unjudgeable';
}

async function resolveTip(path: string, rev: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', path, 'rev-parse', '--verify', `${rev}^{commit}`],
    { timeout: 10000 }
  );
  return stdout.trim();
}

async function judgeByCommit(
  input: MergeJudgmentInput,
  tips: LocalTips,
  errors: unknown[]
): Promise<MergeVerdict | null> {
  const { repoPath, branchName, remote, worktreePath } = input;
  const revisions: { path: string; rev: string }[] = [];
  if (tips.hasWorktree) revisions.push({ path: worktreePath, rev: 'HEAD' });
  if (tips.refExists) revisions.push({ path: repoPath, rev: `refs/heads/${branchName}` });
  const queried = new Set<string>();
  let hasOpenPr = false;
  for (const { path, rev } of revisions) {
    const sha = await resolveTip(path, rev);
    if (queried.has(sha)) continue;
    queried.add(sha);
    const candidates = await getPrsForCommit(sha, repoPath, remote);
    if (candidates.state === 'UNAVAILABLE') return 'pr-unavailable';
    if (candidates.state === 'NONE') continue;
    for (const candidate of candidates.prs) {
      if (await mergedCandidateCovers(input, tips, candidate, errors)) return 'merged';
      hasOpenPr ||= candidate.state === 'OPEN';
    }
  }
  return hasOpenPr ? 'open-pr' : null;
}

async function mergedCandidateCovers(
  input: MergeJudgmentInput,
  tips: LocalTips,
  candidate: PrLookup,
  errors: unknown[]
): Promise<boolean> {
  if (candidate.state !== 'MERGED') return false;
  try {
    return await prCoversTips(input, tips, candidate.headSha);
  } catch (error) {
    // A later PR may prove coverage independently; an unresolved failure must not
    // fall through to the scheduled age sweep as ordinary unmerged work.
    errors.push(error);
    return false;
  }
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
export function skipReasonFor(verdict: Exclude<MergeVerdict, 'merged'>): string | null {
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

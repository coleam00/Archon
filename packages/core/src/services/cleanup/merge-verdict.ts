import { getPrState, getPrsForCommit } from '@archon/isolation';
import type { PrLookup } from '@archon/isolation';
import {
  execFileAsync,
  GitFailure,
  getDefaultBranch,
  isRevCoveredBy,
  isBranchMerged,
  isPatchEquivalent,
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

/** Git integration or one eligible PR head must cover every existing local tip. */
export type MergeVerdict =
  | 'merged'
  | 'pr-closed'
  | 'open-pr'
  | 'unmerged'
  | 'unjudgeable'
  | 'pr-unavailable'
  | 'unknown-commit';

export interface MergeJudgmentInput {
  repoPath: RepoPath;
  branchName: BranchName;
  prStateCache: Map<string, PrLookup>;
  remote: string;
  includeClosed?: boolean;
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
  try {
    if (await gitProvesMerged(input, tips)) return 'merged';
  } catch {
    throw new Error('Git integration check failed');
  }
  const { repoPath, branchName, prStateCache, remote, worktreePath } = input;
  async function candidateVerdict(candidate: PrLookup): Promise<'merged' | 'pr-closed' | null> {
    if (candidate.state !== 'MERGED' && !(candidate.state === 'CLOSED' && input.includeClosed))
      return null;
    try {
      if (
        tips.hasWorktree &&
        !(await isRevCoveredBy(worktreePath, 'HEAD', candidate.headSha, remote))
      )
        return null;
      if (
        tips.refExists &&
        !(await isRevCoveredBy(repoPath, `refs/heads/${branchName}`, candidate.headSha, remote))
      )
        return null;
      return candidate.state === 'CLOSED' ? 'pr-closed' : 'merged';
    } catch (error) {
      throw coverageError(error);
    }
  }
  const pr = await getPrState(branchName, repoPath, prStateCache, remote);
  if (pr.state === 'UNAVAILABLE') return 'pr-unavailable';
  const branchVerdict = await candidateVerdict(pr);
  if (branchVerdict) return branchVerdict;
  let hasOpenPr = pr.state === 'OPEN';
  let hasClosedPr = pr.state === 'CLOSED';
  async function judgeCandidates(
    candidates: readonly PrLookup[]
  ): Promise<'merged' | 'pr-closed' | null> {
    for (const candidate of candidates) {
      const verdict = await candidateVerdict(candidate);
      if (verdict) return verdict;
      hasOpenPr ||= candidate.state === 'OPEN';
      hasClosedPr ||= candidate.state === 'CLOSED';
    }
    return null;
  }
  let hasUnknownCommit = false;
  for (const sha of await resolveTips(input, tips)) {
    const candidates = await getPrsForCommit(sha, repoPath, remote);
    switch (candidates.state) {
      case 'UNAVAILABLE':
        return 'pr-unavailable';
      case 'UNKNOWN_COMMIT':
        hasUnknownCommit = true;
        break;
      case 'NONE':
        break;
      case 'FOUND': {
        const verdict = await judgeCandidates(candidates.prs);
        if (verdict) return verdict;
        break;
      }
    }
  }
  if (hasUnknownCommit) return 'unknown-commit';
  if (hasOpenPr) return 'open-pr';
  return hasClosedPr || pr.state !== 'NONE' || tips.refExists ? 'unmerged' : 'unjudgeable';
}

async function gitProvesMerged(input: MergeJudgmentInput, tips: LocalTips): Promise<boolean> {
  if (!tips.refExists) return false;
  const { repoPath, branchName, worktreePath } = input;
  const { remoteMainRef } = await resolveRepoGitContext(repoPath, repoPath);
  const branchMerged =
    (await isBranchMerged(repoPath, branchName, remoteMainRef)) ||
    (await isPatchEquivalent(repoPath, branchName, remoteMainRef));
  if (!branchMerged) return false;
  return (
    !tips.hasWorktree ||
    (await isPatchEquivalent(worktreePath, 'HEAD', remoteMainRef, { throwOnExpectedError: true }))
  );
}

async function resolveTips(input: MergeJudgmentInput, tips: LocalTips): Promise<Set<string>> {
  const revisions: { path: string; rev: string }[] = [];
  if (tips.hasWorktree) revisions.push({ path: input.worktreePath, rev: 'HEAD' });
  if (tips.refExists)
    revisions.push({ path: input.repoPath, rev: `refs/heads/${input.branchName}` });
  const shas = await Promise.all(
    revisions.map(async ({ path, rev }) => {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', path, 'rev-parse', '--verify', `${rev}^{commit}`],
        { timeout: 10000 }
      );
      return stdout.trim();
    })
  );
  return new Set(shas);
}

function coverageError(error: unknown): Error {
  let diagnostic = 'PR coverage check failed';
  if (error instanceof GitFailure) {
    if (error.kind === 'coverage_fetch') diagnostic += ' during fetch';
    else if (error.kind === 'coverage_ancestry') diagnostic += ' during ancestry inspection';
    if (typeof error.code === 'number' && Number.isSafeInteger(error.code))
      diagnostic += ` (exit code ${error.code})`;
  }
  return new Error(diagnostic);
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
    case 'unknown-commit':
      return 'no pull request covers all local work — a local commit is unknown to the forge';
    case 'pr-unavailable':
      return 'PR state lookup failed — merge state unverifiable';
    case 'unmerged':
      return null;
  }
}

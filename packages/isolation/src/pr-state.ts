/**
 * PR state lookup via the `gh` CLI.
 *
 * The `gh` CLI is a soft dependency: when it is not installed or the remote is
 * not GitHub, lookups return 'NONE'. A failed query returns 'UNAVAILABLE', which
 * callers must not read as "no PR". Merged cleanup requires a merged PR head
 * covering every existing local tip before removal. Scheduled stale cleanup
 * follows its separate age and unpushed-commit policy.
 */
import { execFileAsync } from '@archon/git';
import type { BranchName, RepoPath } from '@archon/git';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('isolation');
  return cachedLog;
}

export type PrState = 'MERGED' | 'CLOSED' | 'OPEN' | 'NONE';

/**
 * A PR found for a branch carries the commit it was opened (and, if merged,
 * merged) at. The branch name alone is not an identity: run branch names are
 * derived from the run identifier and get reused, so a caller deciding anything
 * destructive must check the local branch against `headSha`.
 */
export type PrLookup =
  | { state: 'NONE' }
  | { state: 'UNAVAILABLE' }
  | { state: Exclude<PrState, 'NONE'>; headSha: string };

const NO_PR: PrLookup = { state: 'NONE' };
const UNAVAILABLE: PrLookup = { state: 'UNAVAILABLE' };

/**
 * Look up the most recent PR for a branch in the GitHub remote.
 *
 * Returns:
 *   - MERGED / CLOSED / OPEN with the PR's head commit if a PR exists with that head branch
 *   - NONE if no PR exists, gh is not installed, or the remote is not GitHub
 *   - UNAVAILABLE if gh failed or its output could not be read
 *
 * The optional `cache` map dedupes lookups within a single cleanup invocation.
 * The optional `remote` selects which git remote to inspect (default: 'origin').
 */
export async function getPrState(
  branch: BranchName,
  repoPath: RepoPath,
  cache?: Map<string, PrLookup>,
  remote = 'origin'
): Promise<PrLookup> {
  // Keyed by repository as well as branch: the same branch name in two repositories
  // is two different PRs, and the scheduled cleanup sweep spans every registered repo.
  const cacheKey = `${repoPath}\u0000${branch}`;
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Check whether the remote is on GitHub. Non-GitHub remotes are out of scope.
  let remoteUrl = '';
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', remote], {
      timeout: 10000,
    });
    remoteUrl = stdout.trim();
  } catch (error) {
    getLog().debug(
      { repoPath, branch, stage: 'remote', code: errorCode(error) },
      'isolation.pr_state_remote_lookup_failed'
    );
    cache?.set(cacheKey, NO_PR);
    return NO_PR;
  }

  const selector = githubRemoteSelector(remoteUrl);
  if (!selector) {
    getLog().debug({ repoPath, branch }, 'isolation.pr_state_github_only');
    cache?.set(cacheKey, NO_PR);
    return NO_PR;
  }

  let result: PrLookup = NO_PR;
  try {
    const { stdout } = await execFileAsync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        selector,
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'state,headRefOid',
        '--limit',
        '1',
      ],
      { timeout: 15000, cwd: repoPath }
    );
    const parsed = JSON.parse(stdout) as { state?: string; headRefOid?: string }[];
    const first = parsed[0];
    const state = first?.state;
    const headSha = first?.headRefOid;
    if (!first) {
      result = NO_PR;
    } else if ((state === 'MERGED' || state === 'CLOSED' || state === 'OPEN') && headSha) {
      result = { state, headSha };
    } else {
      getLog().warn({ branch, repoPath }, 'isolation.pr_state_unreadable');
      result = UNAVAILABLE;
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') {
      getLog().debug({ branch, repoPath }, 'isolation.pr_state_gh_not_installed');
    } else {
      getLog().warn({ branch, repoPath, stage: 'query', code }, 'isolation.pr_state_lookup_failed');
      result = UNAVAILABLE;
    }
  }

  cache?.set(cacheKey, result);
  return result;
}

export type CommitPrLookup =
  | Extract<PrLookup, { state: 'NONE' | 'UNAVAILABLE' }>
  | { state: 'FOUND'; prs: readonly Extract<PrLookup, { headSha: string }>[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | number | undefined {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

function githubRemoteSelector(remoteUrl: string): string | undefined {
  if (/^(?:[^@/]+@)?github\.com:/i.test(remoteUrl)) {
    return remoteUrl.replace(/^[^@/]+@/, 'git@');
  }
  try {
    const url = new URL(remoteUrl);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return undefined;
  }
}

function parseCommitPr(pr: unknown, repository: string): Extract<PrLookup, { headSha: string }> {
  if (
    !isRecord(pr) ||
    (pr.state !== 'open' && pr.state !== 'closed') ||
    !(
      pr.merged_at === null ||
      (typeof pr.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at)))
    ) ||
    (pr.state === 'open' && pr.merged_at !== null) ||
    !isRecord(pr.head) ||
    typeof pr.head.sha !== 'string' ||
    !/^[a-f0-9]{40}$/i.test(pr.head.sha) ||
    !isRecord(pr.base) ||
    !isRecord(pr.base.repo) ||
    typeof pr.base.repo.full_name !== 'string' ||
    pr.base.repo.full_name.toLowerCase() !== repository.toLowerCase()
  ) {
    throw new Error('Invalid commit-associated PR');
  }
  return {
    state: pr.merged_at !== null ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN',
    headSha: pr.head.sha,
  };
}

function parseCommitPrs(stdout: string, repository: string): CommitPrLookup {
  const pages: unknown = JSON.parse(stdout);
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('Missing PR pages');
  const prs = pages.flatMap((page: unknown) => {
    if (!Array.isArray(page)) throw new Error('Invalid PR page');
    return page.map((pr: unknown) => parseCommitPr(pr, repository));
  });
  return prs.length ? { state: 'FOUND', prs } : { state: 'NONE' };
}

/** Associations are candidates only; callers must prove local tips against a candidate head. */
export async function getPrsForCommit(
  sha: string,
  repoPath: RepoPath,
  remote = 'origin'
): Promise<CommitPrLookup> {
  let stage: 'remote' | 'repository' | 'pulls' = 'remote';
  try {
    const { stdout: remoteOutput } = await execFileAsync(
      'git',
      ['-C', repoPath, 'remote', 'get-url', remote],
      { timeout: 10000 }
    );
    const remoteUrl = remoteOutput.trim();
    const selector = githubRemoteSelector(remoteUrl);
    if (!selector) return { state: 'NONE' };
    stage = 'repository';
    const { stdout: repositoryOutput } = await execFileAsync(
      'gh',
      ['repo', 'view', selector, '--json', 'nameWithOwner'],
      { timeout: 15000, cwd: repoPath }
    );
    const repository: unknown = JSON.parse(repositoryOutput);
    if (
      !isRecord(repository) ||
      typeof repository.nameWithOwner !== 'string' ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository.nameWithOwner)
    ) {
      throw new Error('Invalid repository identity');
    }
    stage = 'pulls';
    const { stdout } = await execFileAsync(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        `repos/${repository.nameWithOwner}/commits/${sha}/pulls?per_page=100`,
        '--paginate',
        '--slurp',
      ],
      { timeout: 15000, cwd: repoPath }
    );
    return parseCommitPrs(stdout, repository.nameWithOwner);
  } catch (error) {
    const code = errorCode(error);
    if (stage !== 'remote' && code === 'ENOENT') return { state: 'NONE' };
    // Exec errors can embed remote credentials and response bodies; log only the stage and code.
    getLog().warn(
      {
        repoPath,
        stage,
        code,
      },
      'isolation.commit_pr_lookup_failed'
    );
    return { state: 'UNAVAILABLE' };
  }
}
